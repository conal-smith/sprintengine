import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { isAbsolute, join, relative, resolve } from 'path'

import type { LoadedPlugin, PluginSkillInstallTarget, PluginSkillSupport } from '../shared/plugin-manifest'
import type {
  BuiltinSkill,
  BuiltinSkillInstallResult,
  BuiltinSkillStatus,
  BuiltinSkillTargetState,
  SkillHarness,
} from '../shared/electron-api'
import { SKILL_HARNESS_DIR } from '../shared/skill-harnesses'
import type {
  EnsureSkillInstalledResult,
  ModuleSkillRegistration,
  ModuleSkillStatusResult,
} from '../shared/modules/skills'
import type { HostAgentIntegration } from './hosts/execution-host'
import { isPathInsideOrEqual } from './path-containment'
import { integrationLedger } from './integrations/ledger'
import { gitTracksPath } from './skills/studio-plugin'
import { studioPlatform } from '../server/platform/platform'

// The marker a managed copy carries. Exported because the attach path
// (src/main/agent-skill-installer.ts) reads and writes the same file, and two
// spellings of this name would be two conventions.
export const MANAGED_SKILL_MANIFEST_FILE = '.sprintengine-skill.json'

const DEFAULT_HARNESSES: readonly SkillHarness[] = ['agents']
const ALL_NATIVE_TARGET_POLICY = 'all-native'

export type ManagedSkillManifest = {
  id: string
  source: 'sprintengine-builtin'
  version: string
  sourceHash: string
  installedSkillHash: string
  installedAt: string
  updatedAt: string
}

/**
 * The skill the app ships, and the only one: `backlog`, which backs the
 * Backlog handoff (`/backlog <item>` from "Hand to agent", `backlog.work`, a
 * drop onto an agent terminal, or an automation's `spawnSkillId`) — a prompt
 * the app itself composes. It is not installed anywhere ahead of time, and
 * reaches only the launch that composes that prompt. A Claude-family launch
 * that carries the app's plugin directories is handed a plugin holding just
 * the skill (see `launchSkillPluginDir` in agent-integration-home.ts), so
 * nothing lands in the repository; any other launch gets the per-harness copy
 * `ensureSkillInstalled` writes.
 *
 * Kept a list: a module-registered skill resolves beside it, and the launch
 * path takes skill ids rather than knowing this one by name.
 *
 * Everything else that shipped here is retired (`RETIRED_BUILTIN_SKILL_IDS`):
 * an agent follows a skill it can see, and those were instructions nobody had
 * asked for, or backed a feature agents do for themselves (Debug Mode).
 */
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    id: 'backlog',
    name: 'Backlog',
    version: '1.3.0',
    description: 'Take, work, survey, or triage Backlog items with truthful lifecycle status.',
    targetPolicy: ALL_NATIVE_TARGET_POLICY,
  },
]

/** Skills earlier builds shipped and wrote into workspaces; see `pruneRetiredBuiltinSkillCopies`. */
export const RETIRED_BUILTIN_SKILL_IDS: readonly string[] = [
  'frontend-design',
  'prototype',
  'handoff',
  'architecture-deepening',
  'behavior-first-testing',
  'workspace-knowledge',
  'knowledge-grill',
  // With Debug Mode, 2026-09-28: the feature that invoked it is gone too.
  'debug',
]

type BuiltinSkillManagerOptions = {
  sourceRoot?: string
  listPlugins?: () => LoadedPlugin[]
}

type SkillTargetOptions = {
  /**
   * Leave out, for a bundled skill, every native target whose CLIs all receive
   * the bundled skills with their launch (see `launchDeliveredHarness`). Only
   * the launch-time installer asks for this; an explicit install (importing an
   * existing agent configuration) still lands in every native directory.
   */
  skipLaunchDeliveredHarnesses?: boolean
  /** The machine those launches run on (see `SkillLaunchHost`); absent is this one. */
  launch?: SkillLaunchHost
}

type SkillTargetDescriptor = {
  harness: string
  destinationPath?: string
  status?: 'prompt-shim' | 'unsupported'
  pluginId?: string
  displayName?: string
  support?: PluginSkillSupport
  installScope?: 'workspace' | 'user'
  format?: string
  restartRequired?: boolean
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}

/**
 * Content identity of a skill directory: every file's path and bytes, in a
 * stable order. Exported because the attach path compares a source against an
 * installed copy with it, and two different hashes of "the same" directory
 * would make an unchanged copy look modified. Pass `MANAGED_SKILL_MANIFEST_FILE`
 * to ignore the marker, which is written after the hash is taken.
 */
export async function hashSkillDirectory(root: string, ignoredNames = new Set<string>()): Promise<string> {
  const hash = createHash('sha256')

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue
      const fullPath = join(dir, entry.name)
      const rel = relative(root, fullPath).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        hash.update(`dir:${rel}\n`)
        await visit(fullPath)
      } else if (entry.isFile()) {
        hash.update(`file:${rel}\n`)
        hash.update(await readFile(fullPath))
        hash.update('\n')
      }
    }
  }

  await visit(root)
  return hash.digest('hex')
}

/**
 * Replace `destinationDir` with a copy of `sourceDir`, parents included. The
 * two skill install paths — this manager's policy fan-out and the pane's attach
 * (src/main/agent-skill-installer.ts) — share it so a skill copy is made one
 * way. Whether the destination may be replaced at all is the caller's decision:
 * both refuse to overwrite a directory the studio did not write.
 */
export async function copySkillDirectory(sourceDir: string, destinationDir: string): Promise<void> {
  await rm(destinationDir, { recursive: true, force: true })
  await mkdir(join(destinationDir, '..'), { recursive: true })
  await cp(sourceDir, destinationDir, { recursive: true, force: false, errorOnExist: true })
}

/**
 * Stamp a freshly written copy of a bundled skill with the manifest
 * `getTargetState` reads back. Without it the copy is indistinguishable from a
 * hand-made directory, and every later install would refuse to touch it.
 */
export async function writeManagedSkillManifest(input: {
  destinationDir: string
  skill: Pick<BuiltinSkill, 'id' | 'version'>
  sourceHash: string
  now?: string
}): Promise<void> {
  const timestamp = input.now ?? new Date().toISOString()
  const manifest: ManagedSkillManifest = {
    id: input.skill.id,
    source: 'sprintengine-builtin',
    version: input.skill.version,
    sourceHash: input.sourceHash,
    // Taken before the manifest exists, which is also how it is re-checked.
    installedSkillHash: await hashSkillDirectory(input.destinationDir),
    installedAt: timestamp,
    updatedAt: timestamp,
  }
  await writeFile(
    join(input.destinationDir, MANAGED_SKILL_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf-8',
  )
}

/** The managed manifest a copy this installer wrote carries, or null for any other directory. */
export async function readManagedSkillManifest(directory: string): Promise<ManagedSkillManifest | null> {
  const manifest = await readJson<ManagedSkillManifest>(join(directory, MANAGED_SKILL_MANIFEST_FILE))
  return manifest?.source === 'sprintengine-builtin' && typeof manifest.id === 'string' ? manifest : null
}

export function findBuiltinSkill(skillId: string): BuiltinSkill | null {
  return BUILTIN_SKILLS.find((skill) => skill.id === skillId) ?? null
}

// ── Module-owned skills ──────────────────────────────────────────────────────
//
// A capability module hands the host its own skills through
// `MainHost.registerSkills` (src/shared/modules/skills.ts). They live in this
// process-wide registry rather than in `BUILTIN_SKILLS` because their source
// bytes come from the module's own tree and their lifetime is the module's:
// unloading a module takes its skills with it. Everything downstream — status,
// install fan-out, the managed manifest, `spawnSkillId` at the launch boundary
// — treats a registered module skill exactly as it treats a bundled one, which
// is the whole point: a skill a module ships must not be a second-class skill.

export type RegisteredModuleSkill = {
  moduleId: string
  /** Absolute, already containment-checked by the host that accepted it. */
  sourceDir: string
  skill: BuiltinSkill
}

const moduleSkills = new Map<string, RegisteredModuleSkill>()

// Module skills carry no version of their own: the module's own release is the
// version, and the installer already detects a changed skill by hashing its
// source. A constant keeps the managed manifest well-formed without inventing
// a number nobody maintains.
const MODULE_SKILL_VERSION = '1.0.0'

function moduleSkillDisplayName(skillId: string): string {
  return skillId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Take ownership of a module's skills. `sourceDir` must already be absolute:
 * resolving it against the module root, and refusing anything that escapes it,
 * is the host's job (it is the only party that knows the root).
 *
 * The whole batch is validated before any of it lands, so a module whose
 * `registerMain` throws on the third skill leaves none of the first two
 * behind. An id a built-in skill or another module already owns is a
 * registration error — two skills answering one invocation name is not a state
 * the launch boundary could resolve.
 */
export function registerModuleSkills(moduleId: string, registrations: readonly ModuleSkillRegistration[]): void {
  const batch = new Map<string, RegisteredModuleSkill>()
  for (const registration of registrations) {
    const id = registration.id?.trim() ?? ''
    if (!id) throw new Error(`Module "${moduleId}" registered a skill with no id.`)
    if (findBuiltinSkill(id)) {
      throw new Error(`Skill "${id}" is a built-in skill and cannot be registered by module "${moduleId}".`)
    }
    const owner = moduleSkills.get(id)
    if (owner && owner.moduleId !== moduleId) {
      throw new Error(`Skill "${id}" is already registered by module "${owner.moduleId}".`)
    }
    if (batch.has(id)) {
      throw new Error(`Skill "${id}" is registered twice by module "${moduleId}".`)
    }
    if (!registration.sourceDir || !isAbsolute(registration.sourceDir)) {
      throw new Error(`Skill "${id}" from module "${moduleId}" needs a resolved absolute source directory.`)
    }
    batch.set(id, {
      moduleId,
      sourceDir: resolve(registration.sourceDir),
      skill: {
        id,
        name: moduleSkillDisplayName(id),
        version: MODULE_SKILL_VERSION,
        description: registration.description,
        targetPolicy: registration.targetPolicy,
      },
    })
  }
  for (const [id, entry] of batch) moduleSkills.set(id, entry)
}

/** Drop every skill a module owns. Called when the host unloads the module. */
export function unregisterModuleSkills(moduleId: string): void {
  for (const [id, entry] of [...moduleSkills]) {
    if (entry.moduleId === moduleId) moduleSkills.delete(id)
  }
}

export function findModuleSkill(skillId: string): RegisteredModuleSkill | null {
  return moduleSkills.get(skillId) ?? null
}

/** Every registered module skill, in registration order. */
export function listModuleSkills(): RegisteredModuleSkill[] {
  return [...moduleSkills.values()]
}

/**
 * The one lookup every skill consumer should use: a built-in skill, or a skill
 * a live module registered. WP-B's agent session service resolves a spawn
 * request's `skill.id` through this.
 */
export function resolveSkillById(skillId: string): BuiltinSkill | null {
  return findBuiltinSkill(skillId) ?? findModuleSkill(skillId)?.skill ?? null
}

function skillHarnesses(skill: BuiltinSkill): readonly SkillHarness[] {
  return skill.harnesses && skill.harnesses.length > 0 ? skill.harnesses : DEFAULT_HARNESSES
}

function skillDestination(workspaceRoot: string, skillId: string, harness: SkillHarness): string {
  const workspace = resolve(workspaceRoot)
  const destination = resolve(workspace, SKILL_HARNESS_DIR[harness], 'skills', skillId)
  if (!isPathInsideOrEqual(workspace, destination)) {
    throw new Error('Skill destination must stay inside the workspace.')
  }
  return destination
}

function canonicalTarget(targets: BuiltinSkillTargetState[]): BuiltinSkillTargetState {
  return (
    targets.find((target) => target.harness === 'agents' && target.destinationPath) ??
    targets.find((target) => Boolean(target.destinationPath)) ??
    targets[0]
  )
}

/**
 * Where the skills the app ships live, bundled or in the checkout.
 *
 * `resources/builtin-skills`, deliberately OUTSIDE the marketplace we publish
 * (`resources/studio-plugin`). They sat in it as a `studio-skills` plugin from
 * 2026-09-06, which made them a plugin every Claude launch was handed whole and
 * a row every catalogue offered; they are neither now. Only the launch whose
 * prompt names one gets it (2026-09-28).
 */
export const BUILTIN_SKILLS_RESOURCE_DIR = 'builtin-skills'

export function builtinSkillSourceRoot(): string {
  const paths = studioPlatform().paths
  const resourcesDir = paths.resourcesDir()
  if (paths.isPackaged() && resourcesDir) return join(resourcesDir, BUILTIN_SKILLS_RESOURCE_DIR)
  return join(process.cwd(), 'resources', BUILTIN_SKILLS_RESOURCE_DIR)
}

export function createBuiltinSkillManager(options: BuiltinSkillManagerOptions = {}) {
  const sourceRoot = options.sourceRoot ?? builtinSkillSourceRoot()
  const listPlugins = options.listPlugins ?? (() => [])

  function getSkill(id: string): BuiltinSkill | null {
    return resolveSkillById(id)
  }

  // A module skill's bytes come from the module's own tree, not from the
  // bundled source root — the only difference between the two kinds.
  function getSourcePath(id: string): string {
    return findModuleSkill(id)?.sourceDir ?? join(sourceRoot, id)
  }

  function staticSkillTargets(workspaceRoot: string, skill: BuiltinSkill): SkillTargetDescriptor[] {
    return skillHarnesses(skill).map((harness) => ({
      harness,
      destinationPath: skillDestination(workspaceRoot, skill.id, harness),
      support: 'native',
      installScope: 'workspace',
      format: harness,
    }))
  }

  function pluginSkillTargets(workspaceRoot: string, skill: BuiltinSkill): SkillTargetDescriptor[] {
    if (skill.targetPolicy !== ALL_NATIVE_TARGET_POLICY) return []
    const targets: SkillTargetDescriptor[] = []
    for (const plugin of listPlugins()) {
      const integration = plugin.manifest.skillIntegration
      if (!integration) {
        targets.push({
          harness: plugin.manifest.id,
          pluginId: plugin.manifest.id,
          displayName: plugin.manifest.displayName,
          support: 'unsupported',
          status: 'unsupported',
        })
        continue
      }

      if (integration.support !== 'native') {
        targets.push({
          harness: integration.harnessId,
          pluginId: plugin.manifest.id,
          displayName: plugin.manifest.displayName,
          support: integration.support,
          status: integration.support === 'prompt-shim' ? 'prompt-shim' : 'unsupported',
        })
        continue
      }

      for (const installTarget of integration.installTargets ?? []) {
        const destinationPath = renderSkillInstallTargetPath({
          workspaceRoot,
          skillId: skill.id,
          target: installTarget,
        })
        if (!destinationPath) continue
        targets.push({
          harness: integration.harnessId,
          destinationPath,
          pluginId: plugin.manifest.id,
          displayName: plugin.manifest.displayName,
          support: 'native',
          installScope: installTarget.scope,
          format: installTarget.format,
          restartRequired: installTarget.restartRequired === true,
        })
      }
    }
    return targets
  }

  // A harness every one of whose CLIs is handed this bundled skill by the
  // launch that asks for it (today: `claude`, read by Claude Code, Z.AI and
  // Kimi Claude). A launch-time install for ANOTHER CLI skips it too: its
  // `all-native` fan-out would otherwise drop `.claude/skills/<id>` into the
  // repository on a Codex launch, where the next Claude session that wants the
  // skill is handed its own and a `claude` from a plain terminal would pick the
  // copy up. `agents` has no CLI of its own here, so it is never skipped.
  function launchDeliveredHarness(harness: string, skillId: string, launch: SkillLaunchHost = {}): boolean {
    const readers = listPlugins().filter(
      (plugin) =>
        plugin.manifest.skillIntegration?.support === 'native' &&
        plugin.manifest.skillIntegration.harnessId === harness,
    )
    return (
      readers.length > 0 && readers.every((plugin) => launchDeliversBundledSkillTo(plugin.manifest.id, skillId, launch))
    )
  }

  function skillTargets(
    workspaceRoot: string,
    skill: BuiltinSkill,
    options: SkillTargetOptions = {},
  ): SkillTargetDescriptor[] {
    const seen = new Set<string>()
    const result: SkillTargetDescriptor[] = []
    const skipLaunchDelivered = options.skipLaunchDeliveredHarnesses === true && findBuiltinSkill(skill.id) !== null
    for (const target of [...staticSkillTargets(workspaceRoot, skill), ...pluginSkillTargets(workspaceRoot, skill)]) {
      if (
        skipLaunchDelivered &&
        target.destinationPath &&
        launchDeliveredHarness(target.harness, skill.id, options.launch)
      ) {
        continue
      }
      // Path-bearing targets dedupe on the resolved destination alone: several
      // plugins can render the same native path (claude-code and zai both
      // target .claude/skills/<id>), and install() cp's each listed target with
      // errorOnExist — a duplicate path means the second copy dies EEXIST right
      // after the first one succeeds. First declarer wins; status-only targets
      // (prompt-shim/unsupported) keep their per-plugin identity.
      const key = target.destinationPath
        ? `path:${target.destinationPath}`
        : `${target.pluginId ?? ''}:${target.harness}:${target.status ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(target)
    }
    return result
  }

  async function getTargetState(
    skill: BuiltinSkill,
    sourceHash: string,
    target: SkillTargetDescriptor,
  ): Promise<BuiltinSkillTargetState> {
    const base = {
      harness: target.harness,
      ...(target.destinationPath ? { destinationPath: target.destinationPath } : {}),
      ...(target.pluginId ? { pluginId: target.pluginId } : {}),
      ...(target.displayName ? { displayName: target.displayName } : {}),
      ...(target.support ? { support: target.support } : {}),
      ...(target.installScope ? { installScope: target.installScope } : {}),
      ...(target.format ? { format: target.format } : {}),
      ...(target.restartRequired ? { restartRequired: true } : {}),
    }
    if (target.status === 'prompt-shim' || target.status === 'unsupported') {
      return { ...base, status: target.status }
    }
    const destinationPath = target.destinationPath
    if (!destinationPath) return { ...base, status: 'unsupported' }
    if (!(await pathExists(destinationPath))) {
      return { ...base, destinationPath, status: 'missing' }
    }

    const manifest = await readJson<ManagedSkillManifest>(join(destinationPath, MANAGED_SKILL_MANIFEST_FILE))
    if (!manifest || manifest.id !== skill.id || manifest.source !== 'sprintengine-builtin') {
      return { ...base, destinationPath, status: 'local' }
    }

    const currentHash = await hashSkillDirectory(destinationPath, new Set([MANAGED_SKILL_MANIFEST_FILE]))
    if (currentHash !== manifest.installedSkillHash) {
      return { ...base, destinationPath, status: 'modified', installedVersion: manifest.version }
    }

    if (sourceHash !== manifest.sourceHash || manifest.version !== skill.version) {
      return { ...base, destinationPath, status: 'update-available', installedVersion: manifest.version }
    }

    return { ...base, destinationPath, status: 'installed', installedVersion: manifest.version }
  }

  async function getStatus(
    workspaceRoot: string | null,
    skillId: string,
    options: SkillTargetOptions = {},
  ): Promise<BuiltinSkillStatus> {
    const skill = getSkill(skillId)
    if (!skill) return { ok: false, status: 'unknown-skill', skillId, message: `Unknown built-in skill: ${skillId}` }
    if (!workspaceRoot)
      return { ok: false, status: 'missing-workspace', skillId, message: 'Workspace root is required.' }

    const sourcePath = getSourcePath(skill.id)
    if (!(await pathExists(sourcePath))) {
      return { ok: false, status: 'missing-source', skillId, message: `Built-in skill source is missing: ${skill.id}` }
    }

    const sourceHash = await hashSkillDirectory(sourcePath)
    const targets: BuiltinSkillTargetState[] = []
    for (const target of skillTargets(workspaceRoot, skill, options)) {
      targets.push(await getTargetState(skill, sourceHash, target))
    }
    // Every target was one a launch carries: nothing to write, and nothing
    // missing either.
    if (targets.length === 0) {
      return { ok: true, status: 'installed', skill, destinationPath: '', installedVersion: skill.version, targets }
    }

    const destinationPath = canonicalTarget(targets).destinationPath ?? ''
    const installedVersion = targets.find((target) => target.installedVersion)?.installedVersion ?? skill.version

    // Aggregate by actionability: anything installable wins over anything
    // merely protected, so install stays offered while modified/local copies
    // are skipped rather than blocking every other harness.
    if (targets.some((target) => target.status === 'missing')) {
      return { ok: true, status: 'missing', skill, destinationPath, targets }
    }
    if (targets.some((target) => target.status === 'update-available')) {
      return { ok: true, status: 'update-available', skill, destinationPath, installedVersion, targets }
    }
    if (targets.some((target) => target.status === 'modified')) {
      return { ok: true, status: 'modified', skill, destinationPath, installedVersion, targets }
    }
    if (targets.some((target) => target.status === 'local')) {
      return {
        ok: true,
        status: 'local',
        skill,
        destinationPath,
        message: 'A local skill exists but is not managed here.',
        targets,
      }
    }
    return { ok: true, status: 'installed', skill, destinationPath, installedVersion, targets }
  }

  async function install(
    workspaceRoot: string | null,
    skillId: string,
    options: SkillTargetOptions = {},
  ): Promise<BuiltinSkillInstallResult> {
    const status = await getStatus(workspaceRoot, skillId, options)
    if (!status.ok) return status

    const actionable = status.targets.filter(
      (target) =>
        Boolean(target.destinationPath) &&
        (target.status === 'missing' || target.status === 'installed' || target.status === 'update-available'),
    )
    const skipped = status.targets.filter(
      (target) => Boolean(target.destinationPath) && (target.status === 'modified' || target.status === 'local'),
    )
    if (actionable.length === 0) {
      return {
        ok: false,
        status: skipped.every((target) => target.status === 'local') ? 'local' : 'modified',
        skillId,
        message: 'The workspace skill has local changes. It will not be overwritten.',
      }
    }

    const sourcePath = getSourcePath(status.skill.id)
    const sourceHash = await hashSkillDirectory(sourcePath)
    const now = new Date().toISOString()

    for (const target of actionable) {
      if (!target.destinationPath) continue
      await copySkillDirectory(sourcePath, target.destinationPath)
      await writeManagedSkillManifest({
        destinationDir: target.destinationPath,
        skill: status.skill,
        sourceHash,
        now,
      })
    }

    return {
      ok: true,
      status: actionable.every((target) => target.status === 'missing') ? 'installed' : 'updated',
      skill: status.skill,
      destinationPath: canonicalTarget(status.targets).destinationPath ?? '',
      ...(skipped.length > 0 ? { skipped } : {}),
    }
  }

  return {
    list: async (): Promise<BuiltinSkill[]> => [...BUILTIN_SKILLS, ...listModuleSkills().map((entry) => entry.skill)],
    getStatus,
    install,
  }
}

export type BuiltinSkillManager = ReturnType<typeof createBuiltinSkillManager>

// ── The process-wide installer ───────────────────────────────────────────────
//
// `ensureSkillInstalled` is the plain function every "make this skill present
// before the agent launches" caller reaches for: the terminal spawn path, the
// Backlog automation action, WP-B's module agent-session service, and a module
// pre-installing its own skill through `MainHost.ensureSkillInstalled`. They
// all need the same manager — one that knows the installed CLI plugins, so the
// `all-native` fan-out has targets — which app-services builds once and hands
// here. Without that call (tests, headless tools) a plugin-less manager is
// built lazily, so the function is never a hard dependency on app startup.

let defaultSkillManager: BuiltinSkillManager | null = null

export function setDefaultSkillManager(manager: BuiltinSkillManager | null): void {
  defaultSkillManager = manager
}

function skillManager(): BuiltinSkillManager {
  return (defaultSkillManager ??= createBuiltinSkillManager())
}

// ── Skills a launch carries itself ───────────────────────────────────────────
//
// A CLI whose launch takes the app's plugin directories (`--plugin-dir`, see
// agent-integration-home.ts) is handed a plugin holding just the bundled skill
// its prompt invokes — the launch asks for it by id — so copying that skill
// into the repository first would only put a second, ageing copy of the same
// bytes where the person's colleagues, and any `claude` run from a plain
// terminal, would find it. app-services publishes the predicate, because only
// it knows whether this build managed to materialise that skill's plugin on the
// launch's machine; until then (or on a platform that does not take the flag)
// it answers false and the workspace install stays how the skill arrives.
//
// Bundled skills only. A module-registered skill lives in the module's own
// tree, so it has no launch-scoped route and is still copied for every CLI.

/**
 * The machine a launch runs on, and what it said about itself when the launch
 * prepared it. Whether a launch carries the plugin directory is a property of
 * that machine: on Windows this PC's launches never do, while a WSL
 * distribution's do once its helper has written the copy. Absent is this
 * machine; an absent `integration` is read from the machine as it stands.
 */
export type SkillLaunchHost = { hostId?: string | null; integration?: HostAgentIntegration | null }

type LaunchDeliversBundledSkillResolver = (
  cli: string,
  skillId: string,
  hostId?: string | null,
  integration?: HostAgentIntegration | null,
) => boolean

let launchDeliversBundledSkill: LaunchDeliversBundledSkillResolver | null = null

export function setLaunchDeliversBundledSkillResolver(resolver: LaunchDeliversBundledSkillResolver | null): void {
  launchDeliversBundledSkill = resolver
}

function launchDeliversBundledSkillTo(cli: string, skillId: string, launch: SkillLaunchHost = {}): boolean {
  const id = cli.trim()
  if (id === '') return false
  try {
    return launchDeliversBundledSkill?.(id, skillId, launch.hostId, launch.integration) === true
  } catch {
    return false
  }
}

/**
 * Whether a launch of `cli` on `launch`'s machine that asks for `skillId` is
 * handed it as a plugin of its own. The launch asks by passing the id (see
 * `launchSkills` in terminal-launch.ts), which the terminal runtime does for
 * exactly the skills it ensures here, so the two agree.
 */
export function bundledSkillDeliveredAtLaunch(
  cli: string | undefined,
  skillId: string,
  launch: SkillLaunchHost = {},
): boolean {
  return findBuiltinSkill(skillId) !== null && launchDeliversBundledSkillTo(cli ?? '', skillId, launch)
}

/**
 * Take out the copies earlier builds wrote of the skills that no longer ship
 * (`RETIRED_BUILTIN_SKILL_IDS`), from every harness's skill directory.
 *
 * Only a copy this installer wrote and nobody has touched since: its managed
 * marker names the skill and `sprintengine-builtin`, and its content still
 * hashes to what was installed. A copy someone edited is theirs now; a copy the
 * repository committed is the project's (removing it would leave the checkout
 * modified), the rule the quit removal follows. A skill installed from a
 * catalogue carries a different marker and is the person's own choice, so it
 * stays too. Never throws; returns the directories removed, for the diagnostic.
 */
export async function pruneRetiredBuiltinSkillCopies(workspaceRoot: string): Promise<string[]> {
  const root = workspaceRoot.trim()
  if (root === '') return []
  const removed: string[] = []
  for (const harnessDir of new Set(Object.values(SKILL_HARNESS_DIR))) {
    const skillsRoot = join(root, harnessDir, 'skills')
    for (const skillId of RETIRED_BUILTIN_SKILL_IDS) {
      const directory = join(skillsRoot, skillId)
      try {
        const manifest = await readJson<ManagedSkillManifest>(join(directory, MANAGED_SKILL_MANIFEST_FILE))
        if (manifest?.source !== 'sprintengine-builtin' || manifest.id !== skillId) continue
        const hash = await hashSkillDirectory(directory, new Set([MANAGED_SKILL_MANIFEST_FILE]))
        if (hash !== manifest.installedSkillHash) continue
        if (await gitTracksPath(skillsRoot, skillId)) continue
        await rm(directory, { recursive: true, force: true })
        removed.push(directory)
      } catch {
        // Leaving it costs a stale copy, never a broken workspace.
      }
    }
  }
  if (removed.length > 0) {
    const gone = new Set(removed)
    void integrationLedger()
      ?.forgetWhere((entry) => entry.kind === 'skill-copy' && gone.has(entry.path))
      .catch(() => undefined)
  }
  return removed
}

/**
 * Make `skillId` present in `workspaceRoot`, check-first: an already-installed
 * workspace is not rewritten, a missing or stale copy is filled in, and a copy
 * the user edited is left alone. Never throws — a launch boundary must not die
 * because a skill could not be copied.
 *
 * `cli` names the agent about to launch, when the caller knows it. A bundled
 * skill that launch will carry itself is not written at all — it answers
 * `delivered-at-launch` — so a Claude Code session started by the app leaves
 * the repository exactly as it found it. Any other launch still fans the skill
 * out, minus the native directories whose CLIs all receive it with their own
 * launch. Without a `cli` (a module pre-installing its own skill, a handoff that
 * names no agent yet) the same fan-out runs.
 *
 * An unknown id answers `{ ok: false, status: 'unknown-skill' }` rather than
 * quietly doing nothing: a skill that no longer exists (a module was disabled,
 * an id was renamed) is a real failure the caller should be able to see.
 */
export async function ensureSkillInstalled(
  workspaceRoot: string,
  skillId: string,
  options: { cli?: string } & SkillLaunchHost = {},
): Promise<EnsureSkillInstalledResult> {
  if (!resolveSkillById(skillId)) {
    return { ok: false, status: 'unknown-skill', message: `Unknown skill: ${skillId}` }
  }
  const { cli, ...launch } = options
  if (bundledSkillDeliveredAtLaunch(cli, skillId, launch)) {
    return { ok: true, status: 'delivered-at-launch' }
  }
  try {
    const manager = skillManager()
    // A launch-time install: native targets a launch on this machine carries
    // are left out even when THIS launch does not carry them (see
    // `launchDeliveredHarness`).
    const targetOptions: SkillTargetOptions = { skipLaunchDeliveredHarnesses: true, launch }
    const status = await manager.getStatus(workspaceRoot, skillId, targetOptions)
    if (!status.ok) return { ok: false, status: status.status, ...(status.message ? { message: status.message } : {}) }
    if (status.status === 'missing' || status.status === 'update-available') {
      const installed = await manager.install(workspaceRoot, skillId, targetOptions)
      return installed.ok
        ? { ok: true, status: installed.status }
        : { ok: false, status: installed.status, ...(installed.message ? { message: installed.message } : {}) }
    }
    // installed / local / modified: the skill is present in the native dir.
    return { ok: true, status: status.status }
  } catch (error) {
    return {
      ok: false,
      status: 'install-failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * What `ensureSkillInstalled` would find, without writing anything: the read
 * half a module's door shows ("installed in this project") before the person
 * asks for the install. Same targets, same launch-delivery rule, same
 * vocabulary — `missing` and `update-available` are the two states `ensure…`
 * would have acted on. Never throws.
 */
export async function getSkillStatus(
  workspaceRoot: string,
  skillId: string,
  options: { cli?: string } & SkillLaunchHost = {},
): Promise<ModuleSkillStatusResult> {
  if (!resolveSkillById(skillId)) {
    return { ok: false, status: 'unknown-skill', message: `Unknown skill: ${skillId}` }
  }
  const { cli, ...launch } = options
  if (bundledSkillDeliveredAtLaunch(cli, skillId, launch)) {
    return { ok: true, status: 'delivered-at-launch' }
  }
  try {
    const status = await skillManager().getStatus(workspaceRoot, skillId, {
      skipLaunchDeliveredHarnesses: true,
      launch,
    })
    if (!status.ok) return { ok: false, status: status.status, message: status.message }
    return status.status === 'missing' ? { ok: false, status: 'missing' } : { ok: true, status: status.status }
  } catch (error) {
    return {
      ok: false,
      status: 'install-failed',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

function renderSkillInstallTargetPath(input: {
  workspaceRoot: string
  skillId: string
  target: PluginSkillInstallTarget
}): string | null {
  const workspace = resolve(input.workspaceRoot)
  const home = resolve(homedir())
  const rendered = input.target.path
    .replace(/\{\{\s*workspaceRoot\s*\}\}/g, workspace)
    .replace(/\{\{\s*home\s*\}\}/g, home)
    .replace(/\{\{\s*skillId\s*\}\}/g, input.skillId)
  const destination = resolve(input.target.scope === 'workspace' ? workspace : home, rendered)
  const root = input.target.scope === 'workspace' ? workspace : home
  if (!isPathInsideOrEqual(root, destination)) return null
  return destination
}
