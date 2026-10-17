// The app-owned launch home: the plugin directories this app hands a CLI at
// launch time, instead of writing its skills, its MCP bridge and its
// agent-state hook into the user's repository.
//
// Why it exists. Everything this app shipped a workspace used to live in that
// workspace — `.sprintengine/studio-plugin`, `.sprintengine/hooks/agent-state.mjs`,
// hook entries in `.claude/settings.local.json`, the MCP gateway in `.mcp.json`,
// skill copies under `.claude/skills`. docs/agent-launch-isolation.md lists every
// one of them, which CLI reads it, and which have moved here. That has three costs a person
// actually feels: the files show up in their repository, a colleague who never
// ran this app inherits hook commands naming paths that do not exist on their
// machine, and anyone running `claude` in that checkout OUTSIDE this app gets
// this app's hooks and skills. Handing the CLI a `--plugin-dir` at launch has
// none of them: the copy lives here, the flag applies to that one session, and
// a CLI started any other way sees nothing.
//
// What the directory holds, and why here rather than `~/.sprintengine`. One
// materialised copy of the bundled marketplace per PLUGIN VERSION, under this
// profile's userData directory. Two of the values substituted into it — the
// node binary that runs the MCP bridge, and the bridge script itself — belong
// to the build that wrote them, so the copy cannot be shared across builds; a
// dev build (whose userData is its own `sprintengine-dev-<port>` directory) and a
// packaged build therefore never overwrite each other's, which is exactly the
// collision the shared workspace file had.
//
// The socket is substituted too, but the reporter prefers
// `SPRINTENGINE_AGENT_STATE_SOCKET` from the launch env over the baked value, so a
// copy written by one app instance still reports to the instance that actually
// launched the agent.

import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  materialiseStudioPluginInto,
  readStudioPluginTemplate,
  STUDIO_PLUGIN_ID,
  syncMaterialisedStudioSkills,
  type StudioPluginTokens,
} from './skills/studio-plugin'
import { buildLauncherHookCommand } from './agent-state'
import type { StudioLauncherRef } from './integrations/launcher'

/** The directory under userData that holds every version's copy. */
export const AGENT_INTEGRATION_DIR = 'agent-integration'

/**
 * Where the agent-state reporter lands inside the materialised copy: next to
 * the `hooks.json` that names it, so the plugin directory is self-contained and
 * a person reading it can see what the hook runs.
 */
export const LAUNCH_REPORTER_REL = join(STUDIO_PLUGIN_ID, 'hooks', 'agent-state.mjs')

/**
 * The status-line forwarder, beside the reporter.
 *
 * It is not a hook and no plugin can declare it — Claude Code takes a status
 * line only from a settings file or from `--settings` at launch. It lives here
 * anyway because the launch names it in that setting, and a path under the
 * person's workspace is exactly what this whole arrangement stops writing.
 */
export const LAUNCH_STATUS_LINE_REL = join(STUDIO_PLUGIN_ID, 'hooks', 'status-line.mjs')

/** Written last, so a half-finished copy is never mistaken for a usable one. */
const MARKER_FILE = '.installed.json'

/**
 * What the materialiser wrote, independent of the template's version.
 *
 * The marker is otherwise keyed on the plugin version alone, so a change to HOW
 * the copy is written (not to what the template holds) would never reach a
 * machine that already has this version's copy. Bump it whenever the copier's
 * output changes. 2: `$comment` keys are stripped from every JSON file, which
 * Claude Code reported as unknown keys at the end of each session. 3: no
 * `studio-skills` bundle; one plugin per bundled skill under `launch-skills/`
 * (a copy from layout 2 still holds the retired bundle, so it is rebuilt).
 * 4: no `launch-skills/debug`, retired with Debug Mode.
 * 5: the hook commands may run the Studio launcher (`hookLauncher`), and the
 * marker records which form a copy was written with.
 */
export const AGENT_INTEGRATION_LAYOUT = 5

/** The version-keyed root. Sibling versions coexist; see `prune`. */
export function agentIntegrationRoot(userDataDir: string, version: string): string {
  return resolve(userDataDir, AGENT_INTEGRATION_DIR, version)
}

/**
 * The directories a launch passes as `--plugin-dir`, in order.
 *
 * One flag per plugin, never the marketplace root: measured against Claude Code
 * 2.1.268 on 2026-09-11, `--plugin-dir <marketplace root>` loaded NEITHER child
 * plugin (the model could not see either plugin's skill), while two directories
 * passed as two flags loaded both. The `--help` text reads as though a
 * directory of plugins loads each child; it does not.
 *
 * Every launch gets the app's own plugin and nothing else. A `studio-skills`
 * directory used to ride along as a second flag, handing every Claude session
 * nine workflow skills whatever it was for; it was removed on 2026-09-28. The
 * bundled skill a prompt can invoke is passed only to the launch whose prompt
 * invokes it (`launchSkillPluginDir`).
 */
export function launchPluginDirs(root: string): string[] {
  return [join(root, STUDIO_PLUGIN_ID)]
}

/** Where the one-skill plugins live inside a copy. */
const LAUNCH_SKILLS_DIR = 'launch-skills'

/**
 * The plugin holding just `skillId`, which a launch adds as one more
 * `--plugin-dir` when its prompt invokes that skill: a Backlog handoff's
 * `/backlog <item>`. Nothing is written to the repository, and no other
 * session sees the skill. The bare `/backlog` resolves: Claude
 * Code invokes a plugin skill by its bare name whenever no other command
 * claims it, exactly as it did from the retired bundle.
 */
export function launchSkillPluginDir(root: string, skillId: string): string {
  return join(root, LAUNCH_SKILLS_DIR, skillId)
}

/** The plugin's name in its manifest: unique beside ours, and never the skill's own name. */
function launchSkillPluginName(skillId: string): string {
  return `sprintengine-${skillId}`
}

/**
 * Write one plugin per skill directory under `sourceRoot` into `root`, and
 * return them by skill id. Shared by this machine's copy and the one a WSL
 * distribution is sent, so both hold the same bytes.
 */
export async function writeLaunchSkillPlugins(root: string, sourceRoot: string): Promise<Record<string, string>> {
  const written: Record<string, string> = {}
  const entries = await readdir(sourceRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !existsSync(join(sourceRoot, entry.name, 'SKILL.md'))) continue
    const dir = launchSkillPluginDir(root, entry.name)
    await writeSkillPlugin(dir, entry.name, join(sourceRoot, entry.name))
    written[entry.name] = dir
  }
  return written
}

/**
 * Write `dir` as a plugin holding the one skill at `sourceDir`. Also how a
 * module's skill reaches the one launch that invokes it: built on demand, since
 * it ships in the module rather than in this build's copy.
 */
export async function writeSkillPlugin(dir: string, skillId: string, sourceDir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(dir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(
      {
        name: launchSkillPluginName(skillId),
        description: `The ${skillId} skill, for the one SprintEngine Studio launch that invokes it.`,
        version: '1.0.0',
        author: { name: 'SprintEngine Studio' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await cp(sourceDir, join(dir, 'skills', skillId), { recursive: true })
}

/** The one-skill plugins a finished copy holds, by skill id. */
async function listLaunchSkillPlugins(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  const entries = await readdir(join(root, LAUNCH_SKILLS_DIR), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const dir = launchSkillPluginDir(root, entry.name)
    if (entry.isDirectory() && existsSync(join(dir, 'skills', entry.name, 'SKILL.md'))) found[entry.name] = dir
  }
  return found
}

export type AgentIntegrationHome = {
  /** The version-keyed marketplace root. */
  root: string
  /** The `--plugin-dir` arguments every launch passes. */
  pluginDirs: string[]
  /** One more `--plugin-dir` each, by skill id, for a launch whose prompt invokes that skill. */
  skillPluginDirs: Record<string, string>
  version: string
}

export type EnsureAgentIntegrationHomeOptions = {
  /** `resources/studio-plugin` in this build, or null when it did not ship. */
  templateRoot: string | null
  /** The bundled stdin-filter reporter, or null when it did not ship. */
  reporterSourcePath: string | null
  /**
   * The bundled status-line forwarder, or null when it did not ship.
   *
   * Optional in the strong sense: a build without it still gets hooks, skills
   * and its MCP server. It is how the app reads a session's context-window
   * usage, not how agent state works, and a missing forwarder must never cost a
   * launch the rest of the plugin.
   */
  statusLineSourcePath?: string | null
  userDataDir: string
  /** The three build-and-moment values the template cannot carry. */
  tokens: Omit<StudioPluginTokens, 'agentStateReporterPath'>
  /**
   * The area skills the person opted into (shared/studio-area-skills.ts). The
   * copy carries only these; a copy already on disk is brought in line, since
   * it is written once per version and a choice must not wait for the next one.
   */
  enabledSkillDirs: readonly string[]
  /**
   * The bundled skills a launch can ask for (`resources/builtin-skills`), each
   * written as a plugin of its own. Absent or null: none, and every launch that
   * wants one falls back to the workspace install.
   */
  launchSkillsSourceRoot?: string | null
  /**
   * Run the copy's hooks through this launcher rather than `node <reporter>`.
   * Passed on native Windows, where nothing says the shell a CLI runs its hooks
   * in finds a Node, and where every hook the workspace install wrote has run
   * the launcher. Absent or null: the reporter beside the hooks, by `node`.
   */
  hookLauncher?: StudioLauncherRef | null
}

/**
 * Materialise this build's copy if it is not already there, and return the
 * directories to launch with.
 *
 * Idempotent and cheap on the settled path: an existing marker naming this
 * version is taken at its word, because the copy landed by atomic rename and
 * the marker is written after it. A build that shipped no template says so
 * rather than handing back a directory that would load nothing.
 */
export async function ensureAgentIntegrationHome(
  options: EnsureAgentIntegrationHomeOptions,
): Promise<{ ok: true; home: AgentIntegrationHome } | { ok: false; message: string }> {
  const templateRoot = options.templateRoot
  if (!templateRoot) return { ok: false, message: 'The SprintEngine Studio plugin did not ship with this build.' }
  const reporterSourcePath = options.reporterSourcePath
  if (!reporterSourcePath || !existsSync(reporterSourcePath)) {
    return { ok: false, message: 'The agent-state reporter did not ship with this build.' }
  }
  const userDataDir = options.userDataDir.trim()
  if (userDataDir === '') return { ok: false, message: 'A userData directory is required.' }

  const read = await readStudioPluginTemplate(templateRoot)
  if (!read.ok) return read
  const { template } = read

  const root = agentIntegrationRoot(userDataDir, template.version)
  const home: AgentIntegrationHome = {
    root,
    pluginDirs: launchPluginDirs(root),
    skillPluginDirs: {},
    version: template.version,
  }
  const hookRunner = options.hookLauncher ? `launcher:${options.hookLauncher.path}` : 'node'
  if (await isUsable(root, template.version, hookRunner)) {
    home.skillPluginDirs = await listLaunchSkillPlugins(root)
    // Every call, not only a fresh copy's: a copy written by an earlier run
    // carries whatever that run chose (and one from before the opt-in, every
    // skill). Cheap on the settled path — a listing and nothing to do.
    // Best-effort: a skill that could not be moved is worth strictly less than
    // the bridge and the hook, which a failed home would cost every launch.
    await syncMaterialisedStudioSkills({ template, root, skillDirs: options.enabledSkillDirs }).catch(() => undefined)
    return { ok: true, home }
  }

  const materialised = await materialiseStudioPluginInto({
    template,
    destination: root,
    tokens: { ...options.tokens, agentStateReporterPath: join(root, LAUNCH_REPORTER_REL) },
    // The opposite of the workspace copy: this one IS the registration, so its
    // hook declaration is what makes agent state work at all.
    neuterHooks: false,
    skillDirs: options.enabledSkillDirs,
  })
  if (!materialised.ok) return materialised

  try {
    const reporterPath = join(root, LAUNCH_REPORTER_REL)
    await mkdir(resolve(reporterPath, '..'), { recursive: true })
    await copyFile(reporterSourcePath, reporterPath)
  } catch (error) {
    return { ok: false, message: `The agent-state reporter could not be copied: ${describe(error)}` }
  }

  if (options.hookLauncher) {
    try {
      await pointHooksAtLauncher(root, options.hookLauncher, options.tokens.agentStateSocketPath)
    } catch (error) {
      return { ok: false, message: `The agent-state hooks could not be written: ${describe(error)}` }
    }
  }

  // Best-effort, and deliberately after the reporter: the launch names this
  // script in its `--settings` status line, which is how the app reads context
  // usage, cost and lines changed. A build that shipped none simply sends no
  // status line — the hooks, the skills and the MCP server are unaffected.
  const statusLineSourcePath = options.statusLineSourcePath
  if (statusLineSourcePath && existsSync(statusLineSourcePath)) {
    await copyFile(statusLineSourcePath, join(root, LAUNCH_STATUS_LINE_REL)).catch(() => undefined)
  }

  // Best-effort too: without them a launch that wants `/backlog` gets the
  // workspace install instead, which is how the skill arrived before any of
  // this.
  if (options.launchSkillsSourceRoot) {
    home.skillPluginDirs = await writeLaunchSkillPlugins(root, options.launchSkillsSourceRoot).catch(() => ({}))
  }

  await writeMarker(root, template.version, hookRunner)
  return { ok: true, home }
}

/** Rewrite every command in the copy's `hooks/hooks.json` as the launcher's `agent-state` target. */
async function pointHooksAtLauncher(root: string, launcher: StudioLauncherRef, socketPath: string): Promise<void> {
  const path = join(root, STUDIO_PLUGIN_ID, 'hooks', 'hooks.json')
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { hooks?: Record<string, unknown> }
  const command = buildLauncherHookCommand(launcher, 'agent-state', socketPath)
  for (const blocks of Object.values(parsed.hooks ?? {})) {
    if (!Array.isArray(blocks)) continue
    for (const block of blocks as Array<{ hooks?: Array<{ command?: unknown }> }>) {
      for (const hook of block.hooks ?? []) if (typeof hook.command === 'string') hook.command = command
    }
  }
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
}

/**
 * Delete every version directory except the one in use.
 *
 * Safe at startup and nowhere else: a CLI reads a plugin directory as it
 * starts, and every agent this app launches dies with the app that launched it,
 * so at startup no live session is reading a sibling version. Failures are
 * swallowed — a stale directory costs disk, and nothing else.
 */
export async function pruneAgentIntegrationHomes(userDataDir: string, keepVersion: string): Promise<void> {
  const base = resolve(userDataDir, AGENT_INTEGRATION_DIR)
  const entries = await readdir(base, { withFileTypes: true }).catch(() => null)
  if (entries === null) return
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepVersion) continue
    await rm(join(base, entry.name), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** A copy is usable when its marker names the version this build ships. */
async function isUsable(root: string, version: string, hookRunner: string): Promise<boolean> {
  const raw = await readFile(join(root, MARKER_FILE), 'utf8').catch(() => null)
  if (raw === null) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    const marker = parsed as Record<string, unknown>
    return (
      marker.version === version &&
      marker.layout === AGENT_INTEGRATION_LAYOUT &&
      (marker.hookRunner ?? 'node') === hookRunner
    )
  } catch {
    return false
  }
}

async function writeMarker(root: string, version: string, hookRunner: string): Promise<void> {
  const path = join(root, MARKER_FILE)
  const temp = `${path}.${process.pid}.tmp`
  const body = `${JSON.stringify({ plugin: STUDIO_PLUGIN_ID, version, layout: AGENT_INTEGRATION_LAYOUT, hookRunner, installedAt: new Date().toISOString() }, null, 2)}\n`
  await writeFile(temp, body, 'utf8')
  await rename(temp, path)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
