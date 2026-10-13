/**
 * The agent-launch settings, which main owns.
 *
 * Every input main needs to compose an agent launch with no window open lives
 * here: the user-configured CLI runtimes, MCP settings, project knowledge
 * roots, the last-selected CLI and the agent-spawn permission presets. Main
 * holds the one authoritative record under userData; a window reads it at
 * boot, writes to it only through partial `update` patches, and follows every
 * change through the `changed` broadcast. A boot with zero windows (the
 * headless scheduler, a mobile-originated launch) spawns with the same record
 * a window shows. docs/launch-settings-ownership.md has the whole picture.
 *
 * Persistence is a versioned record with a monotonic revision and write
 * provenance: a reader can tell a migrated record from a user write, and a
 * subscriber can order writes. Pure data logic only — all fs/clock access
 * lives in `src/main/launch-settings-store.ts`.
 */
import type { McpServerConfig, McpSettings } from './agent-state'
import {
  DEFAULT_CLI_PERMISSION_PRESET,
  parseCliPermissionPreset,
  type CliPermissionPreset,
} from './cli-permission-preset'
import { defaultPermissionPresetFor, parseCliPermissionModeId } from './cli-permission-mode'
import {
  normalizeMachineMarkSetting,
  normalizeMachineMarkSettings,
  type MachineMarkSetting,
  type MachineMarkSettings,
} from './machine-identity'
import {
  normalizeExecutionHostId,
  normalizeExecutionHostSettings,
  type ExecutionHostId,
  type ExecutionHostSettings,
} from './execution-host'
import { normalizeProjectUsageMap, withProjectUse, type ProjectUsageMap } from './project-frecency'
import { effectiveWorktreeBranchPrefix, sanitizeWorktreeBranchPrefix } from './worktree-branch'

// 2: the per-CLI "run through WSL" switch left the CLI runtime, and each
// machine this computer offers (a WSL distribution) got settings of its own in
// `hosts`. There are no released installs, so a version-1 record is read
// through the same normalizer rather than migrated: its runtimes keep their
// commands and models, and the switch is dropped.
const AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION = 2
const READABLE_SCHEMA_VERSIONS: readonly number[] = [1, AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION]

/**
 * A CLI's settings that hold on every machine: its models, and its command on
 * THIS machine (the local host). A WSL distribution keeps its own commands in
 * `hosts[id].cliCommands`.
 */
export type AgentLaunchCliRuntimeSettings = {
  command: string
  models?: string[]
}

export type AgentLaunchSettings = {
  cliRuntimes: Record<string, AgentLaunchCliRuntimeSettings>
  /**
   * Per-machine settings, keyed by host id (`wsl:<distro>`). The local machine
   * has no entry in normal use: its commands live on `cliRuntimes`.
   */
  hosts: Partial<Record<ExecutionHostId, ExecutionHostSettings>>
  /**
   * The kind and colour a person chose for a machine (Settings › Machines),
   * keyed by its machine id (`shared/machine-identity`): a WSL host id,
   * `ssh:<host>` or `tailnet:<name>`. A machine with no entry wears its
   * defaults. Kept beside `hosts` and written the same way, per machine.
   */
  machineMarks: MachineMarkSettings
  mcp: McpSettings
  projectKnowledgeRoots: Record<string, string | null>
  /**
   * The CLI a spawn defaults to when the caller names none. `null` = never
   * chosen; the reader applies its own default rather than inventing one.
   */
  lastSelectedCli: string | null
  /** The permission preset an agent spawn defaults to. `null` = never chosen. */
  lastAgentSpawnPermissionPreset: CliPermissionPreset | null
  /**
   * The permission preset a spawn on each CLI launches with, keyed by CLI id:
   * what the spawn footer's picker last chose for that runtime. A CLI with no
   * entry falls back to `lastAgentSpawnPermissionPreset`. Per CLI and not per
   * model, because a person trusts a runtime in a repository, and skipping
   * Claude Code's prompts is not lifting Codex's sandbox (owner ruling
   * 2026-09-24). Main owns it so
   * a launch with no window open, and every window, read the same choice.
   */
  cliPermissionPresets: Record<string, CliPermissionPreset>
  /**
   * The CLI's own mode chosen with that preset, keyed by CLI id, for a CLI
   * whose choice is one of its modes other than the preset's own (Claude
   * Code's Accept edits, at Auto). A CLI with no entry runs the preset's own
   * mode. Read only beside the CLI's entry in `cliPermissionPresets`, which
   * stays the level everything else reasons with.
   */
  cliPermissionModes: Record<string, string>
  /**
   * Where chats were started, by project folder (`projectUsageKey`): each
   * project's frecency score, latest use and use count (`project-frecency.ts`).
   * Every project picker for a new chat lists by it, here and on a paired
   * phone through `workspace.list`. Kept beside `lastSelectedCli` because it is
   * the same kind of memory, of where launches went, and main records a chat
   * started from the phone with no window open.
   */
  projectUsage: ProjectUsageMap
  /**
   * What every worktree branch Studio names starts with (Settings ▸
   * Worktrees): `feat` names `feat/<name>`, and `''` names the branch `<name>`
   * alone. `null` = never chosen, which reads as `agent`, the prefix there
   * was before it could be chosen (`effectiveWorktreeBranchPrefix`). Kept
   * here because main names a launch's worktree with no window open, as it
   * reads every other launch input; held sanitized (`worktree-branch.ts`).
   */
  worktreeBranchPrefix: string | null
}

/** Names the process boundary a write came through, never the human. */
export type AgentLaunchSettingsActor = 'ui' | 'system'

export type AgentLaunchSettingsRecord = {
  schemaVersion: typeof AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION
  /**
   * Monotonic write counter. Broadcasts carry it; a subscriber ignores
   * anything at or below the revision it already applied, so a slow echo can
   * never re-assert a stale value over a newer one.
   */
  revision: number
  settings: AgentLaunchSettings
  changedAt: number
  lastWrite: { actor: AgentLaunchSettingsActor; at: string }
}

/**
 * A partial write to main's record. Each field is independent, so two windows
 * editing different CLIs, different MCP servers or different knowledge roots
 * never overwrite each other with a stale copy of the rest.
 *
 * - `cliRuntimes`: per CLI, an entry replaces that CLI's runtime whole and
 *   `null` removes it. CLIs the patch does not name are untouched.
 * - `hosts`: the same, per machine.
 * - `machineMarks`: the same, per machine id.
 * - `mcp.syncEnabled` sets the switch; `mcp.servers` upserts per server id,
 *   `null` removing that server.
 * - `projectKnowledgeRoots`: per project root, a string sets it and `null`
 *   removes the entry.
 * - `lastSelectedCli` and `lastAgentSpawnPermissionPreset` replace the value;
 *   `null` returns it to "never chosen".
 * - `cliPermissionPresets`: per CLI, a preset sets it and `null` removes the
 *   entry, so that CLI reads the app-wide default again. Either way the CLI's
 *   mode goes with it unless the same patch names one, so a window that knows
 *   only presets never leaves a mode behind under a preset it did not choose.
 * - `cliPermissionModes`: per CLI, a mode id sets it and `null` removes it.
 * - `projectUse` records one use of the project at that folder, at `at`
 *   (epoch milliseconds). It adds to what main holds rather than replacing it,
 *   so two windows and the phone each starting a chat all count.
 * - `worktreeBranchPrefix` replaces the prefix, sanitized; `null` returns it
 *   to "never chosen", which reads as `agent`.
 */
export type AgentLaunchSettingsPatch = {
  cliRuntimes?: Record<string, AgentLaunchCliRuntimeSettings | null>
  /** Per host id, an entry replaces that host's settings whole and `null` removes them. */
  hosts?: Partial<Record<ExecutionHostId, ExecutionHostSettings | null>>
  /** Per machine id, an entry replaces that machine's mark whole and `null` returns it to the defaults. */
  machineMarks?: Record<string, MachineMarkSetting | null>
  mcp?: {
    syncEnabled?: boolean
    servers?: Record<string, McpServerConfig | null>
  }
  projectKnowledgeRoots?: Record<string, string | null>
  lastSelectedCli?: string | null
  lastAgentSpawnPermissionPreset?: CliPermissionPreset | null
  cliPermissionPresets?: Record<string, CliPermissionPreset | null>
  cliPermissionModes?: Record<string, string | null>
  projectUse?: { folderPath: string; at: number }
  worktreeBranchPrefix?: string | null
}

/**
 * What a window reads at boot. `record` is null until anything has been
 * written; `settings` is what main spawns with either way (an unrevisioned
 * legacy file, or the empty defaults), so a window can render it at once.
 */
export type AgentLaunchSettingsSnapshot = {
  record: AgentLaunchSettingsRecord | null
  settings: AgentLaunchSettings
  /** Whether `record` is on disk. False for no record, or one a failed write left only in memory. */
  persisted: boolean
}

/**
 * Main's answer to an `update` or a `migrate`: the authoritative record it now
 * holds, which the caller adopts over anything it applied optimistically, and
 * whether the call changed it. An update whose content matches the record is
 * not a new revision; a migration offered onto an existing record is refused
 * and reports `changed: false`.
 */
export type AgentLaunchSettingsWriteAck = {
  ok: true
  record: AgentLaunchSettingsRecord
  changed: boolean
  /**
   * Whether `record` is on disk. False when the write failed and main holds it
   * only in memory until it restarts; a window then keeps its own localStorage
   * copy of these settings, so the next boot can offer them again.
   */
  persisted: boolean
}

/**
 * The launch-settings channels. `get`, `update` and `migrate` are renderer →
 * main invokes; `changed` is main's broadcast to every window, carrying the
 * new record after each write that changed it.
 */
export const LAUNCH_SETTINGS_CHANNELS = {
  get: 'launch-settings:get',
  update: 'launch-settings:update',
  migrate: 'launch-settings:migrate',
  changed: 'launch-settings:changed',
} as const

/**
 * The CLI a launch runs on when the person never picked one. The window's
 * pickers show it and main launches on it, both through
 * `effectiveAgentLaunchSettings`, so the two cannot disagree.
 */
export const DEFAULT_AGENT_LAUNCH_CLI = 'claude-code'

/**
 * The permission preset an agent spawn defaults to when the person never chose
 * one: Auto, each CLI's own mode that neither asks about everything nor skips
 * every check (owner request 2026-10-01). It was Bypass from 2026-07-26 until
 * then. A CLI with no Auto passes no flag instead (`defaultPermissionPresetFor`).
 *
 * Only an absent value, or one no version ever wrote, adopts it. The stored
 * record keeps `null` for a person who never chose, so they move to Auto with
 * this change; a person who chose Bypass, here or for one CLI, keeps it.
 */
export const DEFAULT_AGENT_SPAWN_PERMISSION_PRESET: CliPermissionPreset = DEFAULT_CLI_PERMISSION_PRESET

/** The launch settings with every never-chosen value read as the app default. */
export type EffectiveAgentLaunchSettings = Omit<
  AgentLaunchSettings,
  'lastSelectedCli' | 'lastAgentSpawnPermissionPreset' | 'worktreeBranchPrefix'
> & {
  lastSelectedCli: string
  lastAgentSpawnPermissionPreset: CliPermissionPreset
  worktreeBranchPrefix: string
}

/**
 * What a launch actually uses. The stored record keeps `null` for a value the
 * person never chose — that is honest data, and it lets a later change of the
 * app default reach them — and every reader, main and window alike, reads it
 * through here, so main never launches on anything but what the window shows.
 */
export function effectiveAgentLaunchSettings(settings: AgentLaunchSettings): EffectiveAgentLaunchSettings {
  return {
    ...settings,
    lastSelectedCli: settings.lastSelectedCli || DEFAULT_AGENT_LAUNCH_CLI,
    lastAgentSpawnPermissionPreset: settings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
    worktreeBranchPrefix: effectiveWorktreeBranchPrefix(settings.worktreeBranchPrefix),
  }
}

/**
 * The preset a spawn on `cli` launches with: the caller's own, else the one
 * the person chose for that CLI, else the app-wide spawn default (itself the
 * app default when never chosen). Main's launch service and the window's
 * spawn paths both resolve through here, so a launch with no window open runs
 * on the preset the picker shows for that CLI.
 */
export function resolveAgentSpawnPermissionPreset(
  settings: Pick<AgentLaunchSettings, 'cliPermissionPresets' | 'lastAgentSpawnPermissionPreset'>,
  cli: string | null | undefined,
  requested?: CliPermissionPreset | null,
): CliPermissionPreset {
  const presets = settings.cliPermissionPresets
  // Own keys only: a free-form CLI name such as `constructor` must not read
  // something off Object.prototype as its preset.
  const own = cli && presets && Object.hasOwn(presets, cli) ? presets[cli] : undefined
  return requested ?? own ?? settings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET
}

/**
 * The preset and the CLI's own mode a spawn on `cli` launches with. The preset
 * resolves as `resolveAgentSpawnPermissionPreset` does. The mode is the one
 * chosen for that CLI, and only when the preset is that CLI's own choice too:
 * a caller that names a preset gets that preset's own mode, as does a CLI that
 * runs on the app-wide value.
 *
 * `declared` is the presets the launch can hold this CLI to, when the caller
 * knows them. A preset outside it that the caller did not name (the app-wide
 * value, or the default) runs as `none`, which is what it would render anyway:
 * no flag the CLI does not have, and a record that says so.
 */
export function resolveAgentSpawnPermission(
  settings: Pick<AgentLaunchSettings, 'cliPermissionPresets' | 'lastAgentSpawnPermissionPreset' | 'cliPermissionModes'>,
  cli: string | null | undefined,
  requested?: CliPermissionPreset | null,
  declared?: readonly CliPermissionPreset[] | null,
): { preset: CliPermissionPreset; mode?: string } {
  const presets = settings.cliPermissionPresets
  const own = cli && presets && Object.hasOwn(presets, cli) ? presets[cli] : undefined
  if (requested) return { preset: requested }
  if (own) {
    const modes = settings.cliPermissionModes
    const mode = cli && modes && Object.hasOwn(modes, cli) ? parseCliPermissionModeId(modes[cli]) : null
    return { preset: own, ...(mode ? { mode } : {}) }
  }
  const preset = settings.lastAgentSpawnPermissionPreset ?? defaultPermissionPresetFor(declared)
  return { preset: declared && !declared.includes(preset) ? 'none' : preset }
}

export function emptyAgentLaunchSettings(): AgentLaunchSettings {
  return {
    cliRuntimes: {},
    hosts: {},
    machineMarks: {},
    mcp: { syncEnabled: false, servers: {} },
    projectKnowledgeRoots: {},
    lastSelectedCli: null,
    lastAgentSpawnPermissionPreset: null,
    cliPermissionPresets: {},
    cliPermissionModes: {},
    projectUsage: {},
    worktreeBranchPrefix: null,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeCliRuntime(value: unknown): AgentLaunchCliRuntimeSettings | null {
  if (!isPlainObject(value) || typeof value.command !== 'string') return null
  return {
    command: value.command,
    ...(Array.isArray(value.models)
      ? { models: value.models.filter((model): model is string => typeof model === 'string') }
      : {}),
  }
}

export function normalizeAgentLaunchHosts(value: unknown): AgentLaunchSettings['hosts'] {
  const hosts: AgentLaunchSettings['hosts'] = {}
  if (!isPlainObject(value)) return hosts
  for (const [rawId, entry] of Object.entries(value)) {
    const id = normalizeExecutionHostId(rawId)
    if (id && isPlainObject(entry)) hosts[id] = normalizeExecutionHostSettings(entry)
  }
  return hosts
}

function normalizeLastSelectedCli(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** A chosen prefix, sanitized (`''` is a choice: no prefix); anything else is never chosen. */
function normalizeWorktreeBranchPrefix(value: unknown): string | null {
  return typeof value === 'string' ? sanitizeWorktreeBranchPrefix(value) : null
}

/**
 * The per-CLI presets from a stored record or a migration offer. An entry is a
 * choice somebody made, so a retired spelling keeps the nearest meaning it
 * still has (`parseCliPermissionPreset`); an entry no version ever wrote is
 * dropped and the CLI reads as never set. Stored records, patches and the
 * app-wide value all read presets this way, so a window built before the
 * two-mode change that still sends `manual` is understood, not refused.
 */
export function normalizeCliPermissionPresets(value: unknown): Record<string, CliPermissionPreset> {
  const presets: Record<string, CliPermissionPreset> = {}
  if (!isPlainObject(value)) return presets
  for (const [cli, entry] of Object.entries(value)) {
    const preset = cli ? parseCliPermissionPreset(entry) : null
    if (preset) presets[cli] = preset
  }
  return presets
}

/** The per-CLI modes from a stored record or a migration offer; an id that is not one is dropped. */
export function normalizeCliPermissionModes(value: unknown): Record<string, string> {
  const modes: Record<string, string> = {}
  if (!isPlainObject(value)) return modes
  for (const [cli, entry] of Object.entries(value)) {
    const mode = cli ? parseCliPermissionModeId(entry) : null
    if (mode) modes[cli] = mode
  }
  return modes
}

/**
 * Fail-soft parse of a settings payload (a migration offer or a legacy on-disk
 * file). Unknown fields are dropped; missing fields default to empty. Never
 * throws.
 */
export function normalizeAgentLaunchSettings(raw: unknown): AgentLaunchSettings {
  const empty = emptyAgentLaunchSettings()
  if (!isPlainObject(raw)) return empty
  const cliRuntimes: AgentLaunchSettings['cliRuntimes'] = {}
  if (isPlainObject(raw.cliRuntimes)) {
    for (const [cli, value] of Object.entries(raw.cliRuntimes)) {
      const runtime = normalizeCliRuntime(value)
      if (runtime) cliRuntimes[cli] = runtime
    }
  }
  const mcp = isPlainObject(raw.mcp) ? (raw.mcp as McpSettings) : empty.mcp
  const projectKnowledgeRoots: Record<string, string | null> = {}
  if (isPlainObject(raw.projectKnowledgeRoots)) {
    for (const [key, value] of Object.entries(raw.projectKnowledgeRoots)) {
      if (typeof value === 'string' || value === null) projectKnowledgeRoots[key] = value
    }
  }
  return {
    cliRuntimes,
    hosts: normalizeAgentLaunchHosts(raw.hosts),
    machineMarks: normalizeMachineMarkSettings(raw.machineMarks),
    mcp,
    projectKnowledgeRoots,
    lastSelectedCli: normalizeLastSelectedCli(raw.lastSelectedCli),
    lastAgentSpawnPermissionPreset: parseCliPermissionPreset(raw.lastAgentSpawnPermissionPreset),
    cliPermissionPresets: normalizeCliPermissionPresets(raw.cliPermissionPresets),
    cliPermissionModes: normalizeCliPermissionModes(raw.cliPermissionModes),
    projectUsage: normalizeProjectUsageMap(raw.projectUsage),
    worktreeBranchPrefix: normalizeWorktreeBranchPrefix(raw.worktreeBranchPrefix),
  }
}

/**
 * Fail-soft parse of an `update` payload. A field of the wrong shape is
 * dropped rather than failing the whole patch, and an entry that is neither a
 * value nor `null` is dropped from its map. Never throws.
 */
export function normalizeAgentLaunchSettingsPatch(raw: unknown): AgentLaunchSettingsPatch {
  if (!isPlainObject(raw)) return {}
  const patch: AgentLaunchSettingsPatch = {}
  if (isPlainObject(raw.cliRuntimes)) {
    const cliRuntimes: Record<string, AgentLaunchCliRuntimeSettings | null> = {}
    for (const [cli, value] of Object.entries(raw.cliRuntimes)) {
      if (!cli) continue
      if (value === null) {
        cliRuntimes[cli] = null
        continue
      }
      const runtime = normalizeCliRuntime(value)
      if (runtime) cliRuntimes[cli] = runtime
    }
    patch.cliRuntimes = cliRuntimes
  }
  if (isPlainObject(raw.hosts)) {
    const hosts: NonNullable<AgentLaunchSettingsPatch['hosts']> = {}
    for (const [rawId, value] of Object.entries(raw.hosts)) {
      const id = normalizeExecutionHostId(rawId)
      if (!id) continue
      if (value === null) hosts[id] = null
      else if (isPlainObject(value)) hosts[id] = normalizeExecutionHostSettings(value)
    }
    patch.hosts = hosts
  }
  if (isPlainObject(raw.machineMarks)) {
    const marks: NonNullable<AgentLaunchSettingsPatch['machineMarks']> = {}
    for (const [id, value] of Object.entries(raw.machineMarks)) {
      if (!id) continue
      if (value === null) {
        marks[id] = null
        continue
      }
      const mark = normalizeMachineMarkSetting(value)
      if (mark) marks[id] = mark
    }
    patch.machineMarks = marks
  }
  if (isPlainObject(raw.mcp)) {
    const mcp: NonNullable<AgentLaunchSettingsPatch['mcp']> = {}
    if (typeof raw.mcp.syncEnabled === 'boolean') mcp.syncEnabled = raw.mcp.syncEnabled
    if (isPlainObject(raw.mcp.servers)) {
      const servers: Record<string, McpServerConfig | null> = {}
      for (const [id, value] of Object.entries(raw.mcp.servers)) {
        if (!id) continue
        if (value === null) servers[id] = null
        else if (isPlainObject(value)) servers[id] = value as McpServerConfig
      }
      mcp.servers = servers
    }
    patch.mcp = mcp
  }
  if (isPlainObject(raw.projectKnowledgeRoots)) {
    const roots: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(raw.projectKnowledgeRoots)) {
      if (key && (typeof value === 'string' || value === null)) roots[key] = value
    }
    patch.projectKnowledgeRoots = roots
  }
  if (raw.lastSelectedCli === null || typeof raw.lastSelectedCli === 'string') {
    patch.lastSelectedCli = normalizeLastSelectedCli(raw.lastSelectedCli)
  }
  if (raw.lastAgentSpawnPermissionPreset === null) {
    patch.lastAgentSpawnPermissionPreset = null
  } else {
    const preset = parseCliPermissionPreset(raw.lastAgentSpawnPermissionPreset)
    if (preset) patch.lastAgentSpawnPermissionPreset = preset
  }
  if (isPlainObject(raw.cliPermissionPresets)) {
    const presets: Record<string, CliPermissionPreset | null> = {}
    for (const [cli, value] of Object.entries(raw.cliPermissionPresets)) {
      if (!cli) continue
      if (value === null) {
        presets[cli] = null
        continue
      }
      const preset = parseCliPermissionPreset(value)
      if (preset) presets[cli] = preset
    }
    patch.cliPermissionPresets = presets
  }
  if (isPlainObject(raw.cliPermissionModes)) {
    const modes: Record<string, string | null> = {}
    for (const [cli, value] of Object.entries(raw.cliPermissionModes)) {
      if (!cli) continue
      if (value === null) {
        modes[cli] = null
        continue
      }
      const mode = parseCliPermissionModeId(value)
      if (mode) modes[cli] = mode
    }
    patch.cliPermissionModes = modes
  }
  if (
    isPlainObject(raw.projectUse) &&
    typeof raw.projectUse.folderPath === 'string' &&
    raw.projectUse.folderPath.trim() &&
    typeof raw.projectUse.at === 'number' &&
    Number.isFinite(raw.projectUse.at)
  ) {
    patch.projectUse = { folderPath: raw.projectUse.folderPath, at: raw.projectUse.at }
  }
  if (raw.worktreeBranchPrefix === null || typeof raw.worktreeBranchPrefix === 'string') {
    patch.worktreeBranchPrefix = normalizeWorktreeBranchPrefix(raw.worktreeBranchPrefix)
  }
  return patch
}

/** The settings with `patch` applied. Pure: neither input is mutated. */
export function applyAgentLaunchSettingsPatch(
  settings: AgentLaunchSettings,
  patch: AgentLaunchSettingsPatch,
): AgentLaunchSettings {
  const next: AgentLaunchSettings = {
    ...settings,
    cliRuntimes: { ...settings.cliRuntimes },
    hosts: { ...settings.hosts },
    machineMarks: { ...settings.machineMarks },
    mcp: { ...settings.mcp, servers: { ...settings.mcp.servers } },
    projectKnowledgeRoots: { ...settings.projectKnowledgeRoots },
    cliPermissionPresets: { ...settings.cliPermissionPresets },
    cliPermissionModes: { ...settings.cliPermissionModes },
    projectUsage: { ...settings.projectUsage },
  }
  for (const [cli, runtime] of Object.entries(patch.cliRuntimes ?? {})) {
    if (runtime === null) delete next.cliRuntimes[cli]
    else next.cliRuntimes[cli] = runtime
  }
  for (const [id, host] of Object.entries(patch.hosts ?? {}) as Array<
    [ExecutionHostId, ExecutionHostSettings | null]
  >) {
    if (host === null) delete next.hosts[id]
    else next.hosts[id] = host
  }
  for (const [id, mark] of Object.entries(patch.machineMarks ?? {})) {
    if (mark === null) delete next.machineMarks[id]
    else next.machineMarks[id] = mark
  }
  if (patch.mcp?.syncEnabled !== undefined) next.mcp.syncEnabled = patch.mcp.syncEnabled
  for (const [id, server] of Object.entries(patch.mcp?.servers ?? {})) {
    if (server === null) delete next.mcp.servers[id]
    else next.mcp.servers[id] = server
  }
  for (const [key, root] of Object.entries(patch.projectKnowledgeRoots ?? {})) {
    if (root === null) delete next.projectKnowledgeRoots[key]
    else next.projectKnowledgeRoots[key] = root
  }
  if (patch.lastSelectedCli !== undefined) next.lastSelectedCli = patch.lastSelectedCli
  if (patch.lastAgentSpawnPermissionPreset !== undefined) {
    next.lastAgentSpawnPermissionPreset = patch.lastAgentSpawnPermissionPreset
  }
  for (const [cli, preset] of Object.entries(patch.cliPermissionPresets ?? {})) {
    if (preset === null) delete next.cliPermissionPresets[cli]
    else next.cliPermissionPresets[cli] = preset
    if (!patch.cliPermissionModes || !Object.hasOwn(patch.cliPermissionModes, cli)) delete next.cliPermissionModes[cli]
  }
  for (const [cli, mode] of Object.entries(patch.cliPermissionModes ?? {})) {
    if (mode === null) delete next.cliPermissionModes[cli]
    else next.cliPermissionModes[cli] = mode
  }
  if (patch.projectUse) {
    next.projectUsage = withProjectUse(next.projectUsage, patch.projectUse.folderPath, patch.projectUse.at)
  }
  if (patch.worktreeBranchPrefix !== undefined) next.worktreeBranchPrefix = patch.worktreeBranchPrefix
  return next
}

/**
 * Parse a persisted store file. Returns null when the payload is not a
 * well-formed current-schema record — including the original, unrevisioned
 * file, which held bare settings with no revision. A null result means "no
 * authoritative record yet": a window's one-time migration offer is accepted,
 * so a legacy or corrupt file costs one migration rather than a crash.
 */
export function parseAgentLaunchSettingsRecord(raw: unknown): AgentLaunchSettingsRecord | null {
  if (!isPlainObject(raw)) return null
  if (typeof raw.schemaVersion !== 'number' || !READABLE_SCHEMA_VERSIONS.includes(raw.schemaVersion)) return null
  const revision = raw.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  const rawWrite = isPlainObject(raw.lastWrite) ? raw.lastWrite : null
  return {
    schemaVersion: AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION,
    revision,
    settings: normalizeAgentLaunchSettings(raw.settings),
    changedAt: typeof raw.changedAt === 'number' && Number.isFinite(raw.changedAt) ? raw.changedAt : 0,
    lastWrite: {
      actor: rawWrite?.actor === 'ui' ? 'ui' : 'system',
      at: typeof rawWrite?.at === 'string' ? rawWrite.at : '',
    },
  }
}

export function nextAgentLaunchSettingsRecord(input: {
  current: AgentLaunchSettingsRecord | null
  settings: AgentLaunchSettings
  actor: AgentLaunchSettingsActor
  now: number
}): AgentLaunchSettingsRecord {
  return {
    schemaVersion: AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION,
    revision: (input.current?.revision ?? 0) + 1,
    settings: input.settings,
    changedAt: input.now,
    lastWrite: { actor: input.actor, at: new Date(input.now).toISOString() },
  }
}

/**
 * Content equality for two settings values, independent of key order: an
 * update that changes nothing must not bump the revision or wake subscribers,
 * and a patch applied to a record can re-insert a key in a different position
 * than the one it already held.
 */
export function agentLaunchSettingsEqual(left: AgentLaunchSettings, right: AgentLaunchSettings): boolean {
  return stableStringify(left) === stableStringify(right)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isPlainObject(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  )
}

export function serializeAgentLaunchSettingsRecord(record: AgentLaunchSettingsRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}
