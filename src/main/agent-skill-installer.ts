// Attaching a skill: making one skill exist in every workspace directory an
// installed, skill-capable CLI reads — and removing it only from the copies
// the studio wrote.
//
// The fan-out is derived, never listed. The harness map turns the plugin
// manifests into the distinct directories they declare, which today is four
// covering six CLIs, because claude-code, kimi-claude and zai all read
// `.claude/skills`. A thirteenth CLI declaring a new harness receives its copy
// with no edit here.
//
// Only CLIs actually installed on this machine get a directory: a copy nothing
// on this machine can read is not an install, and a user without OpenCode
// should not find an `.opencode/` in their repository.
//
// FORMAT, settled here so nobody re-derives it. Install targets declare a
// `format` — `claude-code`, `codex`, `opencode`, `agent-skills-v1`, `generic`.
// On disk they are the same layout: a directory whose entry document is
// `SKILL.md` with YAML frontmatter, plus whatever files the skill ships. The
// three the bundled manifests actually use (`claude-code` for .claude and
// .grok, `codex`, `opencode`) were each read by their own CLI from a
// byte-identical directory while building this. `format` is a routing label,
// not a conversion, so there is one writer instead of a per-format adapter. A
// format that genuinely differs on disk is the moment to add one, mirroring the
// MCP reader registry in src/main/mcp-config-readers/.

import { existsSync } from 'fs'
import { readFile, rm, stat, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join, resolve } from 'path'

import type {
  AgentCliAvailabilityMap,
  AgentSkillTarget,
  AgentSkillWriteInput,
  AgentSkillWriteResult,
  BuiltinSkill,
  SkillHarness,
} from '../shared/electron-api'
import { buildHarnessMap } from '../shared/harness-map'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import {
  builtinSkillSourceRoot,
  copySkillDirectory,
  findBuiltinSkill,
  hashSkillDirectory,
  MANAGED_SKILL_MANIFEST_FILE,
  writeManagedSkillManifest,
} from './builtin-skills'
import { detectAgentCliAvailability } from './cli-availability'
import { listPluginRegistryEntries } from './plugin-registry-instance'
import { isPathStrictlyInside } from './path-containment'
import { skillDirStaysInRoot } from './skills/skill-dir-containment'

/**
 * Marker source for a copy this installer made of a skill that carried no
 * provenance of its own — a directory the user hand-authored in one harness and
 * then attached to the rest. Its own copies are the studio's to remove; the
 * hand-authored original is not, and stays unmarked.
 *
 * Third shape of `.sprintengine-skill.json`, alongside the built-in manifest
 * (src/main/builtin-skills.ts) and the source-install marker
 * (src/main/skills/install.ts). One filename for "the studio put this here";
 * each reader recognises only its own shape.
 */
const ATTACHED_MARKER_SOURCE = 'sprintengine-attach'

const NO_TARGET_MESSAGE = 'No agent CLI on this machine reads workspace skills.'

export type AgentSkillInstaller = {
  /** Write the skill into every installed, skill-capable harness directory. */
  attach(input: AgentSkillWriteInput): Promise<AgentSkillWriteResult>
  /** Delete it from the harness directories the studio wrote it into. */
  remove(input: AgentSkillWriteInput): Promise<AgentSkillWriteResult>
}

/** What is at one harness's copy of a skill right now. */
type InstalledSkillCopy = {
  exists: boolean
  /** Carries a studio provenance marker: ours to replace or delete. */
  managed: boolean
  /** Content identity ignoring the marker; '' when the directory is absent. */
  contentHash: string
}

type SkillCopyMarker =
  | { kind: 'builtin'; skill: Pick<BuiltinSkill, 'id' | 'version'>; sourceHash: string }
  | { kind: 'attached'; skillId: string; copiedFrom: string }

/**
 * The filesystem the installer writes through. One implementation ships; the
 * port exists so the per-target outcomes — including a write that fails while
 * its neighbours succeed — are testable without arranging a permission error.
 */
export interface SkillCopyIo {
  inspect(dir: string): Promise<InstalledSkillCopy>
  write(input: { sourceDir: string; destinationDir: string; marker?: SkillCopyMarker }): Promise<void>
  remove(dir: string): Promise<void>
}

export type AgentSkillInstallerOptions = {
  listPlugins?: () => PluginRegistryListEntry[]
  detectAvailability?: () => Promise<AgentCliAvailabilityMap>
  builtinSourceRoot?: () => string
  io?: SkillCopyIo
  /**
   * Freshness: say only *that* a harness changed and let the pane re-read
   * through `agentCapabilities`. Pushing the new list from here would make the
   * write path a second source of truth for the same query, and a surface that
   * renders what it was told can claim an install that failed.
   */
  invalidate?: (workspaceRoot: string, harnessId: string) => void
  /** Where a write with no workspace lands: the home folder every project's agents read. */
  homeDir?: string
}

export function createFsSkillCopyIo(): SkillCopyIo {
  return {
    async inspect(dir): Promise<InstalledSkillCopy> {
      try {
        await stat(dir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { exists: false, managed: false, contentHash: '' }
        }
        throw error
      }
      return {
        exists: true,
        managed: await isManagedCopy(dir),
        // Ignores the marker for the same reason the built-in status reader
        // does: it is written after the copy, so including it would make every
        // copy differ from its source.
        contentHash: await hashSkillDirectory(dir, new Set([MANAGED_SKILL_MANIFEST_FILE])),
      }
    },

    async write({ sourceDir, destinationDir, marker }): Promise<void> {
      await copySkillDirectory(sourceDir, destinationDir)
      if (marker?.kind === 'builtin') {
        await writeManagedSkillManifest({
          destinationDir,
          skill: marker.skill,
          sourceHash: marker.sourceHash,
        })
        return
      }
      if (marker?.kind === 'attached') {
        await writeFile(
          join(destinationDir, MANAGED_SKILL_MANIFEST_FILE),
          `${JSON.stringify(
            {
              id: marker.skillId,
              source: ATTACHED_MARKER_SOURCE,
              copiedFrom: marker.copiedFrom,
              installedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          'utf-8',
        )
      }
    },

    async remove(dir): Promise<void> {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export function createAgentSkillInstaller(options: AgentSkillInstallerOptions = {}): AgentSkillInstaller {
  const listPlugins = options.listPlugins ?? listPluginRegistryEntries
  // Probed without the renderer's per-CLI command overrides, exactly as the
  // marketplace install path does: a CLI on a custom command may probe absent
  // and only miss its copy.
  const detectAvailability = options.detectAvailability ?? (() => detectAgentCliAvailability())
  const builtinSourceRoot = options.builtinSourceRoot ?? builtinSkillSourceRoot
  const io = options.io ?? createFsSkillCopyIo()
  const invalidate = options.invalidate ?? ((): void => {})
  const homeDir = (): string => options.homeDir ?? homedir()

  return {
    async attach({ workspaceRoot, skillId }): Promise<AgentSkillWriteResult> {
      const request = validate(workspaceRoot?.trim() || homeDir(), skillId)
      if (!request.ok) return request

      const builtin = findBuiltinSkill(skillId)
      const availability = await detectAvailability()
      let root = request.root
      let declared = await containedTargets(harnessTargets(listPlugins(), root, skillId), root, homeDir())
      // Where the bytes may be *read* from is every declared harness, not only
      // the ones being written: a skill sitting in the directory of a CLI the
      // user has since uninstalled is still the copy to spread.
      let origin = await resolveOrigin({ io, builtin, builtinSourceRoot, targets: declared, skillId })
      // A skill installed for every project lives in the home folder, and the
      // CLIs already read it from there. Spreading it stays there too, rather
      // than copying a global skill into one folder.
      const home = resolve(homeDir())
      if (!origin && root !== home) {
        const homeDeclared = await containedTargets(harnessTargets(listPlugins(), home, skillId), home, homeDir())
        const homeOrigin = await resolveOrigin({ io, builtin, builtinSourceRoot, targets: homeDeclared, skillId })
        if (homeOrigin) {
          root = home
          declared = homeDeclared
          origin = homeOrigin
        }
      }
      const targets = declared
        .map((target) => ({
          ...target,
          // Attribution, not filtering by count: `.claude` is reported for
          // whichever of claude-code, kimi-claude and zai this machine has.
          pluginIds: target.pluginIds.filter((pluginId) => availability[pluginId]?.installed === true),
        }))
        .filter((target) => target.pluginIds.length > 0 && allowsHarness(builtin, target.harnessId))
      if (targets.length === 0) return { ok: false, message: NO_TARGET_MESSAGE }
      if (!origin) {
        return {
          ok: false,
          message: `Nothing to attach: ${skillId} is not a built-in skill and is not installed for this workspace or every project.`,
        }
      }

      const outcomes: AgentSkillTarget[] = []
      const changed = new Set<string>()
      for (const target of targets) {
        const outcome = await attachOne({ io, target, origin, skillId })
        if (outcome.status === 'written') changed.add(target.harnessId)
        outcomes.push(outcome)
      }
      for (const harnessId of changed) invalidate(root, harnessId)
      return { ok: true, skillId, targets: outcomes }
    },

    async remove({ workspaceRoot, skillId }): Promise<AgentSkillWriteResult> {
      const request = validate(workspaceRoot?.trim() || homeDir(), skillId)
      if (!request.ok) return request

      // Every declared harness, not only the installed ones: a copy written
      // before the user uninstalled that CLI is still the studio's to clean up,
      // and the provenance check below is what makes reaching wider safe.
      const targets = await containedTargets(
        harnessTargets(listPlugins(), request.root, skillId),
        request.root,
        homeDir(),
      )
      if (targets.length === 0) return { ok: false, message: NO_TARGET_MESSAGE }

      const outcomes: AgentSkillTarget[] = []
      const changed = new Set<string>()
      for (const target of targets) {
        const base = describe(target)
        try {
          const existing = await io.inspect(target.absoluteDir)
          if (!existing.exists) {
            outcomes.push({ ...base, status: 'skipped', reason: 'absent' })
            continue
          }
          if (!existing.managed) {
            outcomes.push({ ...base, status: 'skipped', reason: 'not-ours' })
            continue
          }
          await io.remove(target.absoluteDir)
          changed.add(target.harnessId)
          outcomes.push({ ...base, status: 'removed' })
        } catch (error) {
          outcomes.push({ ...base, status: 'failed', message: formatError(error) })
        }
      }
      for (const harnessId of changed) invalidate(request.root, harnessId)
      return { ok: true, skillId, targets: outcomes }
    },
  }
}

/** One harness's copy of one skill: where it goes and who reads it. */
type HarnessTarget = {
  harnessId: string
  pluginIds: string[]
  /** Workspace-relative, so it survives being read on another machine. */
  path: string
  absoluteDir: string
  restartRequired: boolean
}

type SkillOrigin = {
  dir: string
  path: string
  contentHash: string
  /** Set when the bytes are the ones the studio ships for this skill. */
  builtin: BuiltinSkill | null
  /** The origin already carries a provenance marker the copies inherit. */
  managed: boolean
}

type ValidatedRequest = { ok: true; root: string } | { ok: false; message: string }

function validate(workspaceRoot: string, skillId: string): ValidatedRequest {
  const root = workspaceRoot?.trim()
  if (!root || !existsSync(root)) return { ok: false, message: 'Workspace root does not exist.' }
  // A skill id is a directory name in someone's repository, so it is checked
  // rather than trusted: a `../` in it would resolve outside the harness dir.
  // A leading dot is refused with it — a hidden directory is not a skill any
  // CLI lists, and `.` and `..` are the traversal this is guarding.
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(skillId)) {
    return { ok: false, message: `"${skillId}" is not a usable skill directory name.` }
  }
  return { ok: true, root: resolve(root) }
}

function harnessTargets(
  plugins: readonly PluginRegistryListEntry[],
  workspaceRoot: string,
  skillId: string,
): HarnessTarget[] {
  const targets: HarnessTarget[] = []
  for (const binding of buildHarnessMap(plugins).byHarness.values()) {
    // A harness every bound CLI declares unsupported reads no skills, and one
    // with no workspace install target declares nowhere to put them.
    if (binding.support !== 'native' || !binding.skillsDir) continue
    const absoluteDir = resolve(workspaceRoot, ...binding.skillsDir.split('/'), skillId)
    if (!isPathStrictlyInside(workspaceRoot, absoluteDir)) continue
    targets.push({
      harnessId: binding.harnessId,
      pluginIds: [...binding.pluginIds],
      path: `${binding.skillsDir}/${skillId}`,
      absoluteDir,
      restartRequired: binding.restartRequired,
    })
  }
  return targets
}

/**
 * The targets whose folders really sit inside `root`: a harness folder reached
 * through a link is neither read from, written to nor removed.
 */
async function containedTargets(targets: HarnessTarget[], root: string, home: string): Promise<HarnessTarget[]> {
  const kept: HarnessTarget[] = []
  for (const target of targets) if (await skillDirStaysInRoot(root, target.absoluteDir, { home })) kept.push(target)
  return kept
}

/**
 * A built-in that names its harnesses is restricting where it may go, not
 * describing where it happens to be: a built-in declaring `['claude']` resolves
 * `.claude/skills` and nothing else. `targetPolicy: 'all-native'` and an
 * undeclared list both mean every skill-capable harness.
 */
function allowsHarness(builtin: BuiltinSkill | null, harnessId: string): boolean {
  if (!builtin?.harnesses?.length) return true
  return builtin.harnesses.includes(harnessId as SkillHarness)
}

/**
 * The bytes to copy: what the studio ships for a built-in, otherwise the first
 * harness that already holds the skill — which is how a skill installed from a
 * source, or written by hand in one CLI, reaches the others.
 */
async function resolveOrigin(input: {
  io: SkillCopyIo
  builtin: BuiltinSkill | null
  builtinSourceRoot: () => string
  targets: readonly HarnessTarget[]
  skillId: string
}): Promise<SkillOrigin | null> {
  const { io, builtin, skillId } = input
  if (builtin) {
    const dir = join(input.builtinSourceRoot(), skillId)
    const bundled = await io.inspect(dir).catch(() => null)
    if (bundled?.exists) {
      return { dir, path: dir, contentHash: bundled.contentHash, builtin, managed: false }
    }
  }
  for (const target of input.targets) {
    const existing = await io.inspect(target.absoluteDir).catch(() => null)
    if (!existing?.exists) continue
    return {
      dir: target.absoluteDir,
      path: target.path,
      contentHash: existing.contentHash,
      builtin: null,
      managed: existing.managed,
    }
  }
  return null
}

async function attachOne(input: {
  io: SkillCopyIo
  target: HarnessTarget
  origin: SkillOrigin
  skillId: string
}): Promise<AgentSkillTarget> {
  const { io, target, origin, skillId } = input
  const base = describe(target)
  // The harness the bytes came from is already correct, and copying a
  // directory onto itself would delete it first.
  if (target.absoluteDir === origin.dir) return { ...base, status: 'unchanged' }

  let writing = false
  try {
    const existing = await io.inspect(target.absoluteDir)
    // Someone else's bytes under a name we happen to want. Reported, never
    // overwritten: a hand-authored skill is not ours to replace.
    if (existing.exists && !existing.managed) return { ...base, status: 'skipped', reason: 'not-ours' }
    if (existing.exists && existing.contentHash === origin.contentHash) {
      return { ...base, status: 'unchanged' }
    }
    writing = true
    await io.write({
      sourceDir: origin.dir,
      destinationDir: target.absoluteDir,
      marker: originMarker(origin, skillId),
    })
    return { ...base, status: 'written' }
  } catch (error) {
    // A write that died part-way leaves a directory with no marker, which the
    // check above would read as the user's and refuse to touch ever again —
    // the failure would be permanent. The half-copy is ours, so it goes. Only
    // after a write actually started: an unreadable directory we never touched
    // is somebody else's, whatever the error was.
    if (writing) await io.remove(target.absoluteDir).catch(() => {})
    return { ...base, status: 'failed', message: formatError(error) }
  }
}

function originMarker(origin: SkillOrigin, skillId: string): SkillCopyMarker | undefined {
  if (origin.builtin) {
    return { kind: 'builtin', skill: origin.builtin, sourceHash: origin.contentHash }
  }
  // A copy that already carries provenance passes it on with the bytes; one
  // that carries none would otherwise be indistinguishable from a directory the
  // user wrote, and could never be removed again.
  return origin.managed ? undefined : { kind: 'attached', skillId, copiedFrom: origin.path }
}

function describe(target: HarnessTarget): Omit<AgentSkillTarget, 'status'> {
  return {
    harnessId: target.harnessId,
    pluginIds: target.pluginIds,
    path: target.path,
    restartRequired: target.restartRequired,
  }
}

async function isManagedCopy(dir: string): Promise<boolean> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(dir, MANAGED_SKILL_MANIFEST_FILE), 'utf-8'))
  } catch {
    // No marker, or one that does not parse: not something the studio wrote.
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const marker = parsed as { source?: unknown; sourceId?: unknown }
  return (
    marker.source === 'sprintengine-builtin' ||
    marker.source === ATTACHED_MARKER_SOURCE ||
    (typeof marker.sourceId === 'string' && marker.sourceId !== '')
  )
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
