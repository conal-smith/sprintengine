import { isFolderOpenTargetId } from '../../../../shared/folder-open-targets'
import { DEFAULT_AUTO_SETTLE_AFTER_DAYS, normalizeAutoSettleAfterDays } from '../../utils/workspaceSettle'
import type { ExecutionHostId, ExecutionHostSettings } from '../../../../shared/execution-host'
import {
  normalizeAgentLaunchHosts,
  normalizeCliPermissionModes,
  normalizeCliPermissionPresets,
} from '../../../../shared/launch-settings'
import { normalizeMachineMarkSettings, type MachineMarkSetting } from '../../../../shared/machine-identity'
import { normalizeProjectUsageMap } from '../../../../shared/project-frecency'
import {
  AGENT_BRANCH_PREFIX,
  effectiveWorktreeBranchPrefix,
  sanitizeWorktreeBranchPrefix,
} from '../../../../shared/worktree-branch'
import { normalizeTextGenerationSettings } from '../../../../shared/text-generation/contract'
import {
  DEFAULT_WRITING_STYLE,
  normalizeWritingStyle,
  type TextGenerationWritingStyle,
} from '../../../../shared/text-generation/writing-style'
import { normalizeMcpSourceRef } from '../../../../shared/mcp/normalize-server'
import type { FolderOpenTargetId } from '../../../../shared/folder-open-targets'
import { normalizeProjectKnowledgeRoots } from './memorySlice'
import { launchSettingsClient } from '../launchSettingsClient'
import { isProjectColorSetting, type ProjectColorSetting } from '../../utils/projectColor'
import { isProjectIconSetting, normalizeProjectIcons, type ProjectIconSetting } from '../../../../shared/project-icon'
import { normalizeFolderKey } from '../../../../shared/project-hue'
import { isConnectorsFoldedSettingsTab, SKILLS_SETTINGS_TAB } from '../../components/settings/extensionsRoute'
import {
  dispatchExtensionsSurfaceTarget,
  EXTENSIONS_DRAWER_VIEWS,
  type ExtensionsDrawerView,
} from '../../components/workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { isExtensionsDrawerSurface } from '../../components/workspace/extensionsDrawer'
import type {
  AgentCli,
  AgentCliModelSelection,
  AgentConfigAdoptionResult,
  AppSettings,
  CliRuntimeSettings,
  KeybindingSettings,
  McpServerConfig,
  McpSettings,
  NewChatAgentChoice,
  AgentConversationRuntime,
  CliPermissionPreset,
  FollowUpBehavior,
  Workspace,
} from '../../types/workspace'
import type { DiscoveredCliModel, DiscoveredCliModelCatalog } from '../../../../shared/cli-model-catalog'
import {} from '../onboardingState'
import { SIDEBAR_DEFAULT_WIDTH, clampSidebarWidth } from '../../components/workspace/sidebarWidth'
import { isSelectableAgentCli } from '../../components/workspace/newWorkspace/cliRuntimeOptions'
import { WORKSPACE_ASIDE_DEFAULT_WIDTH, clampWorkspaceAsideWidth } from '../../components/workspace/workspaceAsideWidth'
import {
  DEFAULT_CHAT_CONTRAST,
  DEFAULT_CHAT_WIDTH,
  isAppTheme,
  DEFAULT_SYSTEM_DARK_THEME,
  DEFAULT_SYSTEM_LIGHT_THEME,
  normalizeSystemTheme,
  isChatWidth,
  isClockFormat,
  isReplyStreaming,
  DEFAULT_REPLY_STREAMING,
  DEFAULT_CLOCK_FORMAT,
  LEGACY_CHAT_WIDTH,
  isWindowMaterial,
  normalizeChatContrast,
  type AppearanceSettings,
  type AppTheme,
  type ChatWidth,
  type ClockFormat,
  type ReplyStreaming,
  type ResolvedAppTheme,
  type WindowMaterial,
} from '../../types/appTheme'
import { normalizeModuleOverrides } from '../../../../shared/modules/manifest'
import { normalizeFontFamilyPreference } from '../../utils/fontFamilyPreference'
import { LEGACY_COMMAND_ID_ALIASES, collapseDuplicateKeybindings } from '../../commands/keybindings'

export const MAX_RECENT_WORKSPACE_FOLDERS = 50

// Settings is a MODAL (`activeModalSurface === 'settings'`, doors→modals
// 2026-09-01; it was a door before that). What survives here is the REQUEST
// that opened it — which category to land on, and whether the caller asked for
// an update check — read once by the surface as it mounts. Openness itself
// lives in `activeModalSurface`, so there is one answer to "is settings
// showing".
export type SettingsOverlayState = {
  initialTab: string | null
  checkForUpdatesRequestId: number | null
  /**
   * The machine Settings ▸ Agents should show, when the opener knows which one
   * its news is about — a CLI update is this machine's, so its toast, its bell
   * row and a card that names the retired Agent CLIs view all land on This PC
   * rather than on whichever machine the tab last showed. `requestId` makes a
   * second open for the same machine a new request, so an Agents tab already
   * showing another machine still moves. Absent for a plain open.
   */
  agentsMachineRequest?: { hostId: ExecutionHostId; requestId: number }
}

/** Options for `openSettingsOverlay`. */
export type SettingsOverlayOptions = {
  initialTab?: string | null
  checkForUpdates?: boolean
  /** Select this machine on the Agents tab (see `agentsMachineRequest`). */
  agentsMachine?: ExecutionHostId
}

// A monotonic request id: two opens in the same millisecond are still two.
let lastAgentsMachineRequestId = 0

export function defaultAppearanceSettings(): AppearanceSettings {
  return {
    theme: 'system',
    systemLightTheme: DEFAULT_SYSTEM_LIGHT_THEME,
    systemDarkTheme: DEFAULT_SYSTEM_DARK_THEME,
    windowMaterial: 'glass',
    chatContrast: DEFAULT_CHAT_CONTRAST,
    chatWidth: DEFAULT_CHAT_WIDTH,
    clockFormat: DEFAULT_CLOCK_FORMAT,
    replyStreaming: DEFAULT_REPLY_STREAMING,
    agentCharacters: true,
    usageLimits: true,
    interfaceFont: '',
    codeFont: '',
  }
}

export function normalizeAppearanceSettings(value: unknown): AppearanceSettings {
  const defaults = defaultAppearanceSettings()
  if (!value || typeof value !== 'object') return defaults
  const candidate = value as Partial<AppearanceSettings>
  return {
    theme: isAppTheme(candidate.theme) ? candidate.theme : defaults.theme,
    // Absent before the pair existed: `system` resolved to Light and Dark.
    systemLightTheme: normalizeSystemTheme(candidate.systemLightTheme, 'light'),
    systemDarkTheme: normalizeSystemTheme(candidate.systemDarkTheme, 'dark'),
    windowMaterial: isWindowMaterial(candidate.windowMaterial) ? candidate.windowMaterial : defaults.windowMaterial,
    // Both chat fields arrived after the envelope's other appearance fields, so
    // a stored appearance without them is an older profile, not a corrupt one:
    // it reads as the chat looked before — the default contrast, and the full
    // width, which is not the default a new install opens on.
    chatContrast: normalizeChatContrast(candidate.chatContrast),
    chatWidth: isChatWidth(candidate.chatWidth) ? candidate.chatWidth : LEGACY_CHAT_WIDTH,
    clockFormat: isClockFormat(candidate.clockFormat) ? candidate.clockFormat : defaults.clockFormat,
    replyStreaming: isReplyStreaming(candidate.replyStreaming) ? candidate.replyStreaming : defaults.replyStreaming,
    agentCharacters:
      typeof candidate.agentCharacters === 'boolean' ? candidate.agentCharacters : defaults.agentCharacters,
    usageLimits: typeof candidate.usageLimits === 'boolean' ? candidate.usageLimits : defaults.usageLimits,
    // Absent before the font settings existed, which reads as the bundled faces.
    interfaceFont: normalizeFontFamilyPreference(candidate.interfaceFont),
    codeFont: normalizeFontFamilyPreference(candidate.codeFont),
  }
}

export function defaultMcpSettings(): McpSettings {
  return {
    syncEnabled: false,
    servers: {},
  }
}

export function normalizeMcpId(value: unknown): string {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
    : ''
}

function normalizeMcpStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeMcpRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[0].trim()))
    .map(([key, item]) => [key.trim(), item] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

export function normalizeMcpServer(value: unknown): McpServerConfig | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<McpServerConfig>
  const id = normalizeMcpId(candidate.id)
  const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : id
  const transport = candidate.transport === 'http' || candidate.transport === 'sse' ? candidate.transport : 'stdio'
  const clients = normalizeMcpStringList(candidate.clients).map(normalizeMcpId).filter(Boolean)
  const scope = candidate.scope === 'user' ? 'user' : 'workspace'
  // Provenance survives the round trip through the store, or Sync loses track
  // of every server a source installed the moment the app restarts. A 'source'
  // server without a usable reference is a hand-maintained one — 'custom' —
  // which is also what keeps a sync off entries it never wrote
  // (backlog/2026-09-06-mcp-installs-carry-source-provenance.md).
  const sourceRef = normalizeMcpSourceRef(candidate.sourceRef)
  const source =
    candidate.source === 'source' && sourceRef
      ? 'source'
      : candidate.source === 'custom' || candidate.source === 'source'
        ? 'custom'
        : 'bundled'
  const riskLevel =
    candidate.riskLevel === 'network' || candidate.riskLevel === 'local-command' || candidate.riskLevel === 'secrets'
      ? candidate.riskLevel
      : 'low'

  if (!id || !name || clients.length === 0) return null
  if (transport === 'stdio' && !(typeof candidate.command === 'string' && candidate.command.trim())) return null
  if ((transport === 'http' || transport === 'sse') && !(typeof candidate.url === 'string' && candidate.url.trim()))
    return null

  return {
    id,
    name,
    ...(typeof candidate.description === 'string' && candidate.description.trim()
      ? { description: candidate.description.trim() }
      : {}),
    transport,
    ...(typeof candidate.command === 'string' && candidate.command.trim() ? { command: candidate.command.trim() } : {}),
    args: normalizeMcpStringList(candidate.args),
    ...(typeof candidate.url === 'string' && candidate.url.trim() ? { url: candidate.url.trim() } : {}),
    ...(normalizeMcpRecord(candidate.env) ? { env: normalizeMcpRecord(candidate.env) } : {}),
    envVarNames: normalizeMcpStringList(candidate.envVarNames),
    ...(normalizeMcpRecord(candidate.headers) ? { headers: normalizeMcpRecord(candidate.headers) } : {}),
    enabled: candidate.enabled === true,
    required: candidate.required === true,
    clients,
    scope,
    source,
    ...(source === 'source' && sourceRef ? { sourceRef } : {}),
    riskLevel,
  }
}

export function normalizeMcpSettings(value: unknown): McpSettings {
  const defaults = defaultMcpSettings()
  if (!value || typeof value !== 'object') return defaults
  const candidate = value as Partial<McpSettings>
  const servers: Record<string, McpServerConfig> = {}
  if (candidate.servers && typeof candidate.servers === 'object') {
    for (const server of Object.values(candidate.servers)) {
      const normalized = normalizeMcpServer(server)
      if (normalized) servers[normalized.id] = normalized
    }
  }
  return {
    syncEnabled: candidate.syncEnabled === true,
    servers,
  }
}

export function defaultKeybindingSettings(): KeybindingSettings {
  return { overrides: {}, disabled: {} }
}

function normalizeCommandKeybindings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return collapseDuplicateKeybindings(value.filter((entry): entry is string => typeof entry === 'string'))
}

// Keybinding deltas are stored by command id and filtered at consumption, so
// validation here is shape-only. Ids outside the static shell registry are
// kept on purpose: module commands (`<moduleId>.<commandId>`) must keep their
// user customizations across module disable/enable cycles and even across
// uninstall/reinstall — the merge point (RendererKernel.getCommandContributions)
// decides what is currently bindable, not this normalizer.
export function normalizeKeybindingSettings(value: unknown): KeybindingSettings {
  if (!value || typeof value !== 'object') return defaultKeybindingSettings()
  const candidate = value as Partial<KeybindingSettings>
  const overrides: Record<string, string[]> = {}
  if (candidate.overrides && typeof candidate.overrides === 'object') {
    for (const [commandId, rawBindings] of Object.entries(candidate.overrides as Record<string, unknown>)) {
      const id = commandId.trim()
      if (!id) continue
      const normalized = normalizeCommandKeybindings(rawBindings)
      if (normalized.length > 0) overrides[id] = normalized
    }
  }

  const disabled: Record<string, boolean> = {}
  if (candidate.disabled && typeof candidate.disabled === 'object') {
    for (const [commandId, rawDisabled] of Object.entries(candidate.disabled as Record<string, unknown>)) {
      const id = commandId.trim()
      if (!id || rawDisabled !== true) continue
      disabled[id] = true
    }
  }

  return { overrides, disabled }
}

export function normalizeRecentWorkspaceFolders(folders: unknown, additionalFolders: unknown = []): string[] {
  const candidates = [
    ...(Array.isArray(folders) ? folders : []),
    ...(Array.isArray(additionalFolders) ? additionalFolders : []),
  ]
  const seen = new Set<string>()
  const normalized: string[] = []

  candidates.forEach((folder) => {
    if (typeof folder !== 'string') return
    const value = folder.trim()
    if (!value) return

    const key = value.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase() || value
    if (seen.has(key)) return
    seen.add(key)
    normalized.push(value)
  })

  return normalized.slice(0, MAX_RECENT_WORKSPACE_FOLDERS)
}

/**
 * One stored folder path, or null. Blank and non-string both mean "unset", so a
 * hand-edited settings file cannot leave a surface scoped to the empty string.
 * Deliberately not resolved against disk here: a folder that is temporarily
 * unmounted must not be forgotten by a hydration, and only the surface that uses
 * it can decide what to fall back to.
 */
export function normalizeFolderPathSetting(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * How many design systems' visit stamps are worth keeping.
 *
 * The map grows by one per bundle ever opened and shrinks never — forgetting a
 * library registration does not, and should not, reach into this. A person who
 * has opened forty systems has forty stamps, which is nothing; a profile that
 * somehow accumulates thousands is carrying dead weight in every settings write.
 * Trimmed to the most recently visited, because the oldest stamp is the one
 * whose bundle is least likely to be opened again — and losing it costs only a
 * thirty-day window of markers on a system nobody has looked at in years.
 */
const DESIGN_SYSTEM_SEEN_LIMIT = 200

/**
 * The Design door's per-bundle visit stamps: bundle id → ISO timestamp.
 *
 * Both halves are validated. A key that is not a non-empty string, and a value
 * that is not a parseable date, are dropped rather than carried: an unparseable
 * stamp reads as "never seen", which would quietly re-announce a system's whole
 * contents, and that is the failure mode worth spending a normalizer on.
 */
export function normalizeDesignSystemSeen(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const pairs: Array<[string, string, number]> = []
  for (const [key, stamp] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.trim() === '') continue
    if (typeof stamp !== 'string') continue
    const at = Date.parse(stamp)
    if (Number.isNaN(at)) continue
    pairs.push([key, stamp, at])
  }
  const kept = pairs.sort((left, right) => right[2] - left[2]).slice(0, DESIGN_SYSTEM_SEEN_LIMIT)
  const out: Record<string, string> = {}
  for (const [key, stamp] of kept) out[key] = stamp
  return out
}

/**
 * One colour per project (utils/projectColor): the overrides a person chose.
 * Persisted state is other people's data by the time it is read back — an
 * older build's spelling, a hand-edited settings file — so a key that is not a
 * non-empty string, and a value that is not a whole-degree hue or `'none'`, is
 * dropped rather than carried into the map the glyph reads.
 *
 * That includes the hue NAMES the 2026-09-09 build stored (`'blue'` …). Those
 * were first-come picks, indistinguishable from a person's choice, and keeping
 * them would pin every existing project to a colour no other machine shares;
 * dropped, each project returns to its hashed hue (owner, 2026-09-11).
 */
export function normalizeProjectColors(value: unknown): Record<string, ProjectColorSetting> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, ProjectColorSetting> = {}
  for (const [key, setting] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.trim() === '') continue
    if (!isProjectColorSetting(setting)) continue
    out[key] = setting
  }
  return out
}

// Relocated to shared so main can normalize the preset when it composes
// a launch); re-exported so every existing renderer import site is unchanged.
import { normalizeCliPermissionPreset } from '../../../../shared/cli-permission-preset'
import { parseCliPermissionModeId } from '../../../../shared/cli-permission-mode'

export { normalizeCliPermissionPreset }

// The app defaults for a never-chosen CLI and spawn preset live in shared, so
// main launches on exactly what this window shows (see
// effectiveAgentLaunchSettings); re-exported so the renderer import sites are
// unchanged.
import { DEFAULT_AGENT_LAUNCH_CLI, DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../../../shared/launch-settings'

export { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET }

// A remembered model + reasoning-effort pick. Kept only when it names a CLI and
// carries at least one choice for it; a partial blob drops back to "no
// override" so resolution falls through to the CLI's own default (no model and
// no effort flag). A level with no model is kept on purpose — "the CLI's
// default model at high effort" is a real selection — so `model` may normalize
// to an empty string while `reasoning` survives.
export function normalizeCliModelSelection(
  input: AgentCliModelSelection | null | undefined,
): AgentCliModelSelection | null {
  if (!input || typeof input !== 'object') return null
  const selection = input as Partial<AgentCliModelSelection>
  const cli = typeof selection.cli === 'string' ? selection.cli.trim() : ''
  const model = typeof selection.model === 'string' ? selection.model.trim() : ''
  const reasoning = typeof selection.reasoning === 'string' ? selection.reasoning.trim() : ''
  if (!cli || (!model && !reasoning)) return null
  return { cli, model, ...(reasoning ? { reasoning } : {}) }
}

export function normalizeSelectedCli(
  input: AgentCli | null | undefined,
  fallback: AgentCli = DEFAULT_AGENT_LAUNCH_CLI,
): AgentCli {
  const safeFallback = isSelectableAgentCli(fallback) ? fallback : DEFAULT_AGENT_LAUNCH_CLI
  if (typeof input === 'string' && input.trim()) {
    const trimmed = input.trim()
    // A persisted selection naming a CLI that is not agent-selectable (muse,
    // generic-shell — the hooks-only rule) normalizes to the fallback HERE, at
    // read time, so every picker shows the real default before any spawn —
    // instead of the value being silently swapped at spawn time by the catalog
    // clamp. Unknown ids pass through: a user plugin may well be eligible, and
    // the catalog/availability layers own that question.
    return isSelectableAgentCli(trimmed) ? trimmed : safeFallback
  }
  return safeFallback
}

function normalizeCliRuntimes(
  cliRuntimes: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>> | undefined,
  defaults: AppSettings,
): AppSettings['cliRuntimes'] {
  const canonicalClaude = cliRuntimes?.['claude-code']
  const merged: AppSettings['cliRuntimes'] = {
    ...defaults.cliRuntimes,
    ...cliRuntimes,
    'claude-code': {
      ...defaults.cliRuntimes['claude-code'],
      ...canonicalClaude,
    },
  }
  delete merged.claude
  // Rebuild entries rather than mutating them: the spread above shares object
  // references with the caller's persisted settings, which may be frozen.
  const result: AppSettings['cliRuntimes'] = {}
  for (const [id, runtime] of Object.entries(merged)) {
    const models = normalizeUserModelList(runtime.models)
    const { models: _dropped, ...rest } = runtime
    // The per-CLI "run through WSL" switch is gone (a WSL distribution is a
    // machine of its own now); a copy persisted before that must not ride
    // back to main on the next write.
    delete (rest as Record<string, unknown>).useWsl
    result[id] = models ? { ...rest, models } : rest
  }
  return result
}

// User-added model ids for one CLI: trimmed, non-empty, deduped.
export function normalizeUserModelList(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined
  const seen = new Set<string>()
  const models: string[] = []
  for (const entry of input) {
    if (typeof entry !== 'string') continue
    const model = entry.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    models.push(model)
  }
  return models.length > 0 ? models : undefined
}

// One model row as a CLI reported it. Everything but `id` is optional and
// dropped when it is not the type the shape declares, so a probe parser that
// grows a field cannot inject a wrong-typed value into every picker.
function normalizeDiscoveredModel(input: unknown): DiscoveredCliModel | null {
  if (!input || typeof input !== 'object') return null
  const candidate = input as Partial<DiscoveredCliModel>
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : ''
  if (!id) return null
  const model: DiscoveredCliModel = { id }
  const text = (value: unknown): string | undefined => {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    return trimmed || undefined
  }
  const displayName = text(candidate.displayName)
  if (displayName) model.displayName = displayName
  const description = text(candidate.description)
  if (description) model.description = description
  const resolvedModel = text(candidate.resolvedModel)
  if (resolvedModel) model.resolvedModel = resolvedModel
  if (
    typeof candidate.contextWindow === 'number' &&
    Number.isFinite(candidate.contextWindow) &&
    candidate.contextWindow > 0
  ) {
    model.contextWindow = candidate.contextWindow
  }
  if (Array.isArray(candidate.effortLevels)) {
    const levels = candidate.effortLevels.map((level) => text(level)).filter((level): level is string => Boolean(level))
    if (levels.length > 0) model.effortLevels = levels
  }
  const defaultEffort = text(candidate.defaultEffort)
  if (defaultEffort) model.defaultEffort = defaultEffort
  if (typeof candidate.supportsFastMode === 'boolean') model.supportsFastMode = candidate.supportsFastMode
  // Kept only as a parseable ISO timestamp: the "New" chip does date arithmetic
  // on it, and a garbled value would either light a row up forever or never.
  const firstSeenAt = text(candidate.firstSeenAt)
  if (firstSeenAt && Number.isFinite(Date.parse(firstSeenAt))) model.firstSeenAt = firstSeenAt
  return model
}

// What each CLI last reported about its own models, keyed by plugin id. Wholly
// app-owned: an entry that does not carry the recorded shape (models array,
// known source, a fetch timestamp) is dropped rather than repaired, because a
// half-parsed catalog would put rows the CLI never listed into every picker.
// An entry whose models array is empty is kept — "probed, listed nothing" is a
// state the Settings CLI detail has to be able to tell from "never probed".
export function normalizeCliModelCatalogs(
  input: unknown,
): Partial<Record<AgentCli, DiscoveredCliModelCatalog>> | undefined {
  if (!input || typeof input !== 'object') return undefined
  const result: Partial<Record<AgentCli, DiscoveredCliModelCatalog>> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const cli = key.trim()
    if (!cli || !value || typeof value !== 'object') continue
    const candidate = value as Partial<DiscoveredCliModelCatalog>
    if (!Array.isArray(candidate.models)) continue
    if (candidate.source !== 'argv-probe' && candidate.source !== 'agent-sdk') continue
    const fetchedAt = typeof candidate.fetchedAt === 'string' ? candidate.fetchedAt.trim() : ''
    if (!fetchedAt) continue
    const seen = new Set<string>()
    const models: DiscoveredCliModel[] = []
    for (const entry of candidate.models) {
      const model = normalizeDiscoveredModel(entry)
      if (!model || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
    const catalog: DiscoveredCliModelCatalog = { models, fetchedAt, source: candidate.source }
    const cliVersion = typeof candidate.cliVersion === 'string' ? candidate.cliVersion.trim() : ''
    if (cliVersion) catalog.cliVersion = cliVersion
    result[cli] = catalog
  }
  return Object.keys(result).length > 0 ? result : undefined
}

// Persisted last-used conversation provider/model. Keeps only a well-formed
// non-empty pair; anything else (legacy absence, partial blob) resets to null so
// spawn falls back to the first available option.
export function normalizeConversationModel(
  input: AgentConversationRuntime | null | undefined,
): AgentConversationRuntime | null {
  if (!input || typeof input !== 'object') return null
  const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : ''
  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : ''
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}

// What "New chat in project" opens before the person has ever picked: a plain
// Terminal, the one choice that needs no provider or CLI set up (owner ruling
// 2026-09-26). After the first pick the launcher remembers the last one.
const FIRST_RUN_NEW_CHAT_AGENT: NewChatAgentChoice = { kind: 'terminal' }

// Persisted "New chat in project" agent choice. Anything that is not one of the
// three spawn kinds — a malformed blob, a shape from an older build — falls
// back to the first-run choice. A remembered explicit choice still wins.
export function normalizeNewChatAgentChoice(input: unknown): NewChatAgentChoice {
  if (!input || typeof input !== 'object') return { ...FIRST_RUN_NEW_CHAT_AGENT }
  const choice = input as Partial<NewChatAgentChoice>
  if (choice.kind === 'terminal' || choice.kind === 'general' || choice.kind === 'conversation')
    return { kind: choice.kind }
  return { ...FIRST_RUN_NEW_CHAT_AGENT }
}

// Module-contributed settings sections persist their values in a `module:<id>`
// namespace inside app settings (see AppSettings.moduleSettings). The prefix is
// the collision guard between module keyspaces and shell settings keys.
export const MODULE_SETTINGS_NAMESPACE_PREFIX = 'module:'

export function moduleSettingsNamespace(moduleId: string): string {
  return `${MODULE_SETTINGS_NAMESPACE_PREFIX}${moduleId.trim()}`
}

export function normalizeModuleSettings(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object') return {}
  const result: Record<string, Record<string, unknown>> = {}
  for (const [namespace, entry] of Object.entries(value as Record<string, unknown>)) {
    const key = namespace.trim()
    if (!key.startsWith(MODULE_SETTINGS_NAMESPACE_PREFIX)) continue
    if (key.length === MODULE_SETTINGS_NAMESPACE_PREFIX.length) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    result[key] = { ...(entry as Record<string, unknown>) }
  }
  return result
}

// Settings keys that were core's before their owning module had a place to keep
// them, mapped to where they live now. These are core's OWN persisted
// rows, and only core can read them once the field is gone from `AppSettings`.
// Values pass through untouched — the owning module normalizes what it reads,
// so core keeps no knowledge of their shape.
//
// Each entry dies when a profile that predates the move can no longer exist.
// Empty today: the review rows retired with the review surfaces themselves. The
// mechanism stays because the next key that moves out of core needs it.
const RETIRED_MODULE_SETTINGS: ReadonlyArray<{ from: string; moduleId: string; key: string }> = []

// Lift any retired key still on a persisted settings blob into its module's
// namespace, without overwriting a value the module has already written there.
function liftRetiredModuleSettings(
  moduleSettings: Record<string, Record<string, unknown>>,
  settings: Partial<AppSettings> | undefined,
): Record<string, Record<string, unknown>> {
  if (!settings) return moduleSettings
  const source = settings as Record<string, unknown>
  let lifted = moduleSettings
  for (const { from, moduleId, key } of RETIRED_MODULE_SETTINGS) {
    const value = source[from]
    if (value === undefined || value === null) continue
    const namespace = moduleSettingsNamespace(moduleId)
    const entry = lifted[namespace] ?? {}
    if (key in entry) continue
    lifted = { ...lifted, [namespace]: { ...entry, [key]: value } }
  }
  return lifted
}

// Idle-terminal pause threshold, in minutes. Default 15. Bounds mirror the main
// reap policy's clamp ([1 min, 24 h]) so the UI and the runtime agree.
export const DEFAULT_TERMINAL_IDLE_SUSPEND_MINUTES = 15
export const MIN_TERMINAL_IDLE_SUSPEND_MINUTES = 1
export const MAX_TERMINAL_IDLE_SUSPEND_MINUTES = 24 * 60

export function normalizeTerminalIdleSuspendMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_IDLE_SUSPEND_MINUTES
  }
  return Math.max(MIN_TERMINAL_IDLE_SUSPEND_MINUTES, Math.min(MAX_TERMINAL_IDLE_SUSPEND_MINUTES, Math.round(value)))
}

// Recency floor for the idle-terminal pauser: the N most recently used agent
// terminals are always left running, even once idle past the threshold. Bounds
// mirror the main reap policy's clamp ([0, 20]); 0 means pause everything idle.
export const DEFAULT_TERMINAL_KEEP_RECENT_ALIVE = 3
export const MIN_TERMINAL_KEEP_RECENT_ALIVE = 0
export const MAX_TERMINAL_KEEP_RECENT_ALIVE = 20

export function normalizeTerminalKeepRecentAlive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TERMINAL_KEEP_RECENT_ALIVE
  }
  return Math.max(MIN_TERMINAL_KEEP_RECENT_ALIVE, Math.min(MAX_TERMINAL_KEEP_RECENT_ALIVE, Math.round(value)))
}

export function normalizeFollowUpBehavior(value: unknown): FollowUpBehavior {
  return value === 'steer' ? 'steer' : 'queue'
}

export const defaultAppSettings = (): AppSettings => ({
  cliRuntimes: {
    codex: { command: 'codex' },
    'claude-code': {
      command: 'claude',
    },
  },
  hosts: {},
  machineMarks: {},
  keybindings: defaultKeybindingSettings(),
  mcp: defaultMcpSettings(),
  lastSelectedCli: DEFAULT_AGENT_LAUNCH_CLI,
  lastSelectedConversationModel: null,
  textGeneration: { enabled: true, engine: null, writingStyle: { ...DEFAULT_WRITING_STYLE } },
  lastNewChatAgent: { ...FIRST_RUN_NEW_CHAT_AGENT },
  // No default editor: the control resolves the first target the machine
  // actually has. Naming one here would claim an install we have not probed.
  lastFolderOpenTarget: null,
  lastAgentSpawnPermissionPreset: DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  // No CLI chosen for yet: every one reads the app-wide default above.
  cliPermissionPresets: {},
  cliPermissionModes: {},
  projectUsage: {},
  worktreeBranchPrefix: AGENT_BRANCH_PREFIX,
  autoCompactChats: false,
  lastSelectedAgentModel: null,
  projectKnowledgeRoots: {},
  // Nothing seen yet. Every project in the map got there by being shown once,
  // so a fresh profile allocates as its first sidebar renders rather than
  // pre-colouring projects it has never opened.
  projectColors: {},
  projectIcons: {},
  recentWorkspaceFolders: [],
  // Null follows the active workspace, which is what the Design door did before
  // it had a chip at all.
  designProjectScopePath: null,
  // Nothing opened yet. A bundle absent from the map has never been seen, which
  // the marker rule treats as "already seen, except the last thirty days".
  designSystemSeen: {},
  appearance: defaultAppearanceSettings(),
  modules: {},
  moduleSettings: {},
  modulesChosen: false,
  firstRunCliCardDismissed: false,
  hasAdoptedAgentConfig: false,
  conversationImportOffered: false,
  terminalIdleSuspendMinutes: DEFAULT_TERMINAL_IDLE_SUSPEND_MINUTES,
  terminalKeepRecentAlive: DEFAULT_TERMINAL_KEEP_RECENT_ALIVE,
  settleOnPullRequestMerge: true,
  keepChatsWithOpenPullRequest: true,
  sidebarWorkingSection: false,
  autoSettleAfterDays: DEFAULT_AUTO_SETTLE_AFTER_DAYS,
  browserAutoFloatAgentPreview: true,
  // A message sent mid-turn waits for the turn, as every one did before the
  // choice: a steer is something a person asks for.
  followUpBehavior: 'queue',
  // Off is the rule from before background mode exactly; keeping a process alive is a choice
  // the user has to make, never one an upgrade makes for them.
  keepRunningInBackground: false,
  // On, and the main-side mirror reads an absent file the same way, so the two
  // agree on a profile that has never touched the switch. Opting out is the
  // choice; it is recorded, and it outlives the process that made it.
  telemetryEnabled: true,
})

// `onboardingStep` is a RETIRED key: the wizard wrote it, nothing writes it now,
// and it is no longer part of AppSettings. It is still read once at hydration —
// through this widened view rather than by re-adding the field — because it is
// the strongest signal that a profile was already in use before the wizard was
// deleted. 'welcome' does not count: that profile installed the app, saw the
// first screen and quit, which makes it a fresh user, not a returning one.
type LegacyOnboardingSettings = { onboardingStep?: unknown }

function isPostWelcomeLegacyOnboarding(settings: Partial<AppSettings> | undefined): boolean {
  const step = (settings as LegacyOnboardingSettings | undefined)?.onboardingStep
  return typeof step === 'string' && step !== 'welcome'
}

export function normalizeAppSettings(settings: Partial<AppSettings> | undefined, workspaces: Workspace[]): AppSettings {
  const defaults = defaultAppSettings()
  return {
    ...defaults,
    cliRuntimes: normalizeCliRuntimes(settings?.cliRuntimes, defaults),
    hosts: normalizeAgentLaunchHosts(settings?.hosts),
    machineMarks: normalizeMachineMarkSettings(settings?.machineMarks),
    cliModelCatalog: normalizeCliModelCatalogs(settings?.cliModelCatalog),
    keybindings: normalizeKeybindingSettings(settings?.keybindings),
    mcp: normalizeMcpSettings(settings?.mcp),
    lastSelectedCli: normalizeSelectedCli(settings?.lastSelectedCli, defaults.lastSelectedCli),
    lastSelectedConversationModel: normalizeConversationModel(settings?.lastSelectedConversationModel),
    textGeneration: normalizeTextGenerationSettings(settings?.textGeneration),
    lastNewChatAgent: normalizeNewChatAgentChoice(settings?.lastNewChatAgent),
    lastFolderOpenTarget: isFolderOpenTargetId(settings?.lastFolderOpenTarget) ? settings.lastFolderOpenTarget : null,
    lastAgentSpawnPermissionPreset: normalizeCliPermissionPreset(settings?.lastAgentSpawnPermissionPreset),
    cliPermissionPresets: normalizeCliPermissionPresets(settings?.cliPermissionPresets),
    cliPermissionModes: normalizeCliPermissionModes(settings?.cliPermissionModes),
    projectUsage: normalizeProjectUsageMap(settings?.projectUsage),
    worktreeBranchPrefix: effectiveWorktreeBranchPrefix(settings?.worktreeBranchPrefix),
    autoCompactChats: settings?.autoCompactChats === true,
    // Every field here is built explicitly and `settings` is never spread, so a
    // key an older build persisted drops on every hydration — the same
    // merge-not-only-migrate enforcement as the opt-in reset below.
    lastSelectedAgentModel: normalizeCliModelSelection(settings?.lastSelectedAgentModel),
    projectKnowledgeRoots: normalizeProjectKnowledgeRoots(settings?.projectKnowledgeRoots, workspaces),
    // Not pruned against the open workspaces, unlike the knowledge roots above:
    // a project's colour has to survive closing every chat in it and opening
    // one again next week, or "it never changes behind your back" is untrue for
    // exactly the projects a person comes back to.
    projectColors: normalizeProjectColors(settings?.projectColors),
    projectIcons: normalizeProjectIcons(settings?.projectIcons),
    recentWorkspaceFolders: normalizeRecentWorkspaceFolders(
      settings?.recentWorkspaceFolders,
      workspaces.map((ws) => ws.folderPath),
    ),
    designProjectScopePath: normalizeFolderPathSetting(settings?.designProjectScopePath),
    designSystemSeen: normalizeDesignSystemSeen(settings?.designSystemSeen),
    appearance: normalizeAppearanceSettings(settings?.appearance),
    modules: normalizeModuleOverrides(settings?.modules),
    moduleSettings: liftRetiredModuleSettings(normalizeModuleSettings(settings?.moduleSettings), settings),
    // Existing installs (already have workspaces) are treated as chosen so the
    // first-run chooser only appears for a genuinely fresh install.
    modulesChosen: settings?.modulesChosen ?? workspaces.length > 0,
    // MIGRATION off the retired onboarding wizard. `modulesChosen` and
    // `onboardingStep` are the two signals that used to keep an existing install
    // out of onboarding; both stay READABLE here (and are never written again) so
    // an upgrade is recognised and converted, once, into this boolean.
    //
    // A profile parked at 'welcome' with no workspaces is deliberately NOT
    // treated as dismissed: it installed, saw the welcome step, quit, and
    // upgraded — which makes it exactly the fresh user this card is for. Anything
    // past 'welcome' is someone who was already using the app.
    firstRunCliCardDismissed:
      settings?.firstRunCliCardDismissed ??
      (workspaces.length > 0 || settings?.modulesChosen === true || isPostWelcomeLegacyOnboarding(settings)),
    // An existing install already had its chance to adopt through the wizard's
    // card, so it is not re-offered; a fresh profile adopts on its first
    // workspace creation.
    hasAdoptedAgentConfig: settings?.hasAdoptedAgentConfig ?? workspaces.length > 0,
    // The card is a first-run offer; a profile with chats already imports
    // from Settings instead.
    conversationImportOffered:
      typeof settings?.conversationImportOffered === 'boolean'
        ? settings.conversationImportOffered
        : workspaces.length > 0,
    terminalIdleSuspendMinutes: normalizeTerminalIdleSuspendMinutes(settings?.terminalIdleSuspendMinutes),
    terminalKeepRecentAlive: normalizeTerminalKeepRecentAlive(settings?.terminalKeepRecentAlive),
    settleOnPullRequestMerge:
      typeof settings?.settleOnPullRequestMerge === 'boolean' ? settings.settleOnPullRequestMerge : true,
    // Only an explicit stored `false` lets the idle rule settle a chat whose
    // pull request is still open: a profile from before the setting keeps them.
    keepChatsWithOpenPullRequest: settings?.keepChatsWithOpenPullRequest !== false,
    sidebarWorkingSection: settings?.sidebarWorkingSection === true,
    // Absent before the setting existed: the three days it always was.
    autoSettleAfterDays: normalizeAutoSettleAfterDays(settings?.autoSettleAfterDays),
    // Only an explicit stored `false` turns the player off: it is the
    // feature's default, and an unreadable value should not hide an agent.
    browserAutoFloatAgentPreview: settings?.browserAutoFloatAgentPreview !== false,
    // Only an explicit stored `steer` steers. A profile from before the choice
    // has none, and keeps queueing, which is what its Enter always did.
    followUpBehavior: normalizeFollowUpBehavior(settings?.followUpBehavior),
    // Only an explicit stored `true` keeps the app alive past its last window;
    // anything else (fresh profile, corrupt value) reads as off.
    keepRunningInBackground: settings?.keepRunningInBackground === true,
    // The inverse, and deliberately so: only an explicit stored `false` opts
    // out. A fresh or unreadable profile takes the product default, exactly as
    // main's mirror does.
    telemetryEnabled: settings?.telemetryEnabled !== false,
  }
}

// Where files open: the editor window, beside its own file tree (owner ruling
// 2026-09-25: the in-app editor tab is too much going on around the file). The
// in-app editor stays a choice in Settings → Appearance, and Settings is the
// only thing that moves this value — docking one file back, or dragging one
// tab out, moves that file and leaves the preference alone.
export const DEFAULT_OPEN_FILES_IN_EXTERNAL_WINDOW = true
// Where a Git diff opens (git-commit-window T3). A separate OS window is
// the default; the
// pane's Diff tab is the in-app home the person can flip back to. Sticky, like
// the file preference above: the band's two buttons are what write it.
export const DEFAULT_DIFF_OPENS_IN_WINDOW = true
/**
 * How a diff is drawn (git-commit-window T4): two panes or one. The
 * default is side by side; the diff window's icon-only toggle is
 * the only thing that writes it, and it is app-wide rather than per window
 * because it is how this person reads a diff, not a property of one file.
 */
export type DiffViewMode = 'side-by-side' | 'unified'
export const DEFAULT_DIFF_VIEW: DiffViewMode = 'side-by-side'
export const DEFAULT_CHECK_CLI_VERSIONS = true

export interface SettingsSliceState {
  appSettings: AppSettings
  settingsOverlay: SettingsOverlayState
  // The active door-routed full-page surface for this window (global-surfaces
  // epic 1704): a registered surface id (e.g. 'design') or null when a
  // workspace — not a door — owns the card region. Per-window and transient
  // (omitted from extractSettingsFields / partializeWorkspaceStoreState, so
  // never persisted and never replicated across windows). Unlike the Settings
  // overlay this is a MOUNT KIND that pre-empts the workspace card region
  // rather than floating a dialog over it, so opening a door and activating a
  // workspace are mutually exclusive — the sidebar selection invariant.
  activeGlobalSurface: string | null
  // The active modal surface for this window (doors→modals, 2026-09-01): a
  // registered modal-surface id ('settings', 'diff', or a module-registered
  // id) or null. Automations, Design and Plugins left this field
  // for `activeGlobalSurface` (Extensions drawer ruling, 2026-09-05): the
  // product's own destinations route the card region rather than floating over
  // it. Per-window and transient like
  // activeGlobalSurface, but a FLOAT, not a mount kind: the modal shell sits
  // over whatever owns the card region — a workspace or a door — and closing
  // it lands exactly where the user was. One modal at a time: opening one
  // replaces another. Activating a workspace clears it (workspacesSlice), so
  // a reveal always lands on a visible workspace.
  activeModalSurface: string | null
  // The workspace the open modal was opened FROM, when its opener had one (the
  // pane strip passes its own; a command or a notification passes none). A
  // sibling field rather than a shape change on `activeModalSurface`, so every
  // existing reader of "which modal is open?" keeps reading one string. It is
  // set, cleared and survived exactly as that field is — the two are only ever
  // written together.
  activeModalSurfaceWorkspaceId: string | null
  // Which of the app rail's sections the sidebar column is showing (the
  // app shell, 2026-09-05): `home` is the workspaces tree, `extensions`
  // the Extensions drawer — Design, Plugins, Skills (2026-09-05 ruling;
  // Agent CLIs moved to Settings ▸ Agents 2026-09-25); Automations is what the product does rather than
  // something added to it, so it stands on the rail and is not in the drawer.
  // Beside it the rail's Extensions glyph opens the Extensions home. Per window
  // and transient like activeGlobalSurface — a restart lands on Home.
  // Opening a door that BELONGS to the drawer flips it to `extensions`, so
  // leaving that door lands back on the drawer it was opened from; a door that
  // does not (Automations, which stands on the rail) leaves the section alone,
  // and the glyph that reads current stays whichever one was showing. Selecting
  // a workspace or starting a chat flips it to `home`.
  sidebarSection: SidebarSection
  // How the chat rail lists conversations (all-chats-view, 2026-09-07):
  // `projects` is the folder tree — a header per project over its chats;
  // `all` is one stream of every chat, newest activity first, with each row
  // naming the project it belongs to. The stream is what a fresh profile opens
  // on. Persisted in the settings envelope, so
  // the rail reopens in the shape the person left it in. App-wide rather than
  // per window: it is how this person reads their work, not a property of one
  // window.
  chatListView: ChatListView
  sidebarCollapsed: boolean
  // User-resizable expanded width of the workspace sidebar, in px. Persisted so
  // the rail reopens at the width the user dragged it to. Only meaningful while
  // expanded; the collapsed rail is a fixed icon width.
  sidebarWidth: number
  // The workspace pane column (browser-pane epic): app-level width, in px,
  // persisted in the settings envelope like sidebarWidth. Whether the pane is
  // open is per workspace (`workspace.paneState.open`); maximised is transient
  // so a restart never comes back with the workspace card hidden.
  workspacePaneWidth: number
  workspacePaneMaximised: boolean
  // Sticky "where do files open" preference. When true, opening a file routes to
  // the external editor window (a tabbed pop-up) instead of a workspace tab.
  // Set by user action — popping a tab out turns it on, docking a file back
  // turns it off — and remembered so the next file reuses the last surface.
  openFilesInExternalWindow: boolean
  // Sticky "where does a diff open" preference. True (the default) routes a
  // Git row to the standalone diff window; false routes it to the workspace
  // pane's Diff tab. Written by user action alone — the pane band's "Open in
  // separate window" turns it on, the window's "Show in the app" turns it off
  // — so the next diff opens where the last one was left.
  diffOpensInWindow: boolean
  // How a diff is DRAWN, once it is open: side by side or unified. Persisted in
  // the settings envelope beside the preference above, applied to Monaco with
  // `updateOptions` so the toggle never remounts the editor.
  diffView: DiffViewMode
  // Ask each CLI's package registry for its newest version (the Settings
  // switch "Check for CLI updates"). Mirrored into main, which runs the check.
  checkCliVersions: boolean
  // Live outcome of the deferred first-run agent-config adoption, shown on the
  // first-run overlay. Transient (not persisted via extractSettingsFields) — it
  // describes an action that ran this session, never a resumed one.
  agentConfigAdoptionResult: AgentConfigAdoptionResult | null
}

export type SidebarSection = 'home' | 'extensions'

// The two shapes the chat rail can take. See `chatListView` above.
export type ChatListView = 'projects' | 'all'

export interface SettingsSliceActions {
  setSidebarSection: (section: SidebarSection) => void
  setChatListView: (view: ChatListView) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setSidebarWidth: (width: number) => void
  setWorkspacePaneWidth: (width: number) => void
  setWorkspacePaneMaximised: (maximised: boolean) => void
  setOpenFilesInExternalWindow: (enabled: boolean) => void
  setDiffOpensInWindow: (enabled: boolean) => void
  setDiffView: (view: DiffViewMode) => void
  setCheckCliVersions: (enabled: boolean) => void
  openSettingsOverlay: (opts?: SettingsOverlayOptions) => void
  closeSettingsOverlay: () => void
  // Opens the Plugins modal on the requested view: every legacy caller — the
  // command palette, Settings → Modules, the agent "Manage skills" footers —
  // lands on the modal with its deep-link latched. (Was the Extensions door
  // until doors→modals, 2026-09-01; the Extensions door before that.)
  openExtensionsSurface: (opts?: { view?: ExtensionsDrawerView; installed?: boolean }) => void
  // Open/close the door-routed full-page surface (global-surfaces epic 1704).
  // `openGlobalSurface` is the generic entry a module's door calls with its own
  // registered surface id; `closeGlobalSurface` returns the card region to the
  // active workspace. Activating a workspace clears it too (see workspacesSlice).
  openGlobalSurface: (surfaceId: string) => void
  closeGlobalSurface: () => void
  // Open/close the modal surface registered under `surfaceId` (doors→modals,
  // 2026-09-01). The generic entry for the surfaces that stayed modals —
  // Settings, the Diff popout, Reviews from the pane strip, a third party's.
  // `openSettingsOverlay` sets the same field with its own extra state. One
  // modal at a time — opening one replaces another — and opening a DOOR closes
  // the modal (see openGlobalSurface), so a routed destination is never hidden
  // behind the scrim.
  // `options.workspaceId` records the workspace the opener acted from; the
  // shell hands it to the surface's body, which is how a modal that acts on a
  // workspace knows which one without guessing at the active row.
  openModalSurface: (surfaceId: string, options?: { workspaceId?: string }) => void
  closeModalSurface: () => void
  setCliRuntime: (cli: AgentCli, update: Partial<CliRuntimeSettings>) => void
  setHostSettings: (hostId: ExecutionHostId, settings: ExecutionHostSettings | null) => void
  /** One machine's kind and colour (Settings › Machines); `null` returns it to the defaults. */
  setMachineMark: (machineId: string, mark: MachineMarkSetting | null) => void
  // Record (or clear) what one CLI reported about its own models. Replaces that
  // CLI's entry wholesale — a model the CLI no longer lists is gone from the
  // discovered layer — and never touches `cliRuntimes[cli].models`.
  setCliModelCatalog: (cli: AgentCli, catalog: DiscoveredCliModelCatalog | null) => void
  setMcpSyncEnabled: (enabled: boolean) => void
  upsertMcpServer: (server: McpServerConfig) => void
  /**
   * Write back the servers a source's Sync refreshed. Distinct from
   * `upsertMcpServer` in exactly one way: it leaves `syncEnabled` as it is.
   * Adding a server is a person saying "wire this up"; refreshing one they
   * already have is not, and turning their MCP config sync back on because
   * they pressed Sync on a source would undo a setting they chose
   * (backlog/2026-09-06-mcp-installs-carry-source-provenance.md).
   */
  refreshMcpServersFromSource: (servers: McpServerConfig[]) => void
  removeMcpServer: (serverId: string) => void
  setLastSelectedCli: (cli: AgentCli) => void
  /** The prefix new worktree branches start with (Settings ▸ Worktrees); sanitized, `''` for none. */
  setWorktreeBranchPrefix: (prefix: string) => void
  /** Auto compact for chats that leave it to the default (Settings ▸ Settled chats). */
  setAutoCompactChats: (enabled: boolean) => void
  /**
   * Count a new chat started in the project at `folderPath`, for the project
   * pickers' order. Main records it and the store follows main's broadcast;
   * nothing is applied here first, because no picker is open while it lands.
   */
  recordProjectUse: (folderPath: string) => void
  setLastSelectedConversationModel: (selection: AgentConversationRuntime | null) => void
  /** Turn model-written chat titles on or off. The engine choice survives an off. */
  setTextGenerationEnabled: (enabled: boolean) => void
  /**
   * Choose the CLI/model/effort that writes chat titles, or `null` for "the
   * first supported installed CLI at its default". Same effort rule as
   * setLastSelectedAgentModel: a level outlives a model change within the CLI
   * and is dropped when the CLI changes.
   */
  setTextGenerationEngine: (selection: AgentCliModelSelection | null) => void
  /**
   * How drafted commit messages and pull requests are written: the mode, the
   * person's own instructions, or both. The instructions are kept when another
   * mode is chosen, so switching back finds them.
   */
  setTextGenerationWritingStyle: (style: Partial<TextGenerationWritingStyle>) => void
  setLastNewChatAgent: (choice: NewChatAgentChoice) => void
  /** Remember the open-in-editor target the user just used (app-wide). */
  setLastFolderOpenTarget: (target: FolderOpenTargetId) => void
  /** The Design door's viewing scope. Null returns it to following the active workspace. */
  setDesignProjectScopePath: (path: string | null) => void
  /**
   * Set (or clear) one project's colour override, keyed by `projectColorKey`.
   *
   * A hue or `'none'` (the person choosing no colour) is stored as chosen.
   * `null` deletes the entry, which returns the project to the hue hashed from
   * its key — "Automatic" in the picker.
   */
  setProjectColor: (key: string, color: ProjectColorSetting | null) => void
  /** Set one project's icon, keyed by its folder; `null` returns it to the detected one. */
  setProjectIcon: (folderPath: string, icon: ProjectIconSetting | null) => void
  /**
   * Stamp a design system as seen, now.
   *
   * Called by the Design door AFTER it has computed the markers for the render
   * that is showing the bundle, so the visit that reveals them is the visit that
   * clears them: the person sees what is new while they are looking, and the
   * next open is quiet.
   */
  markDesignSystemSeen: (bundleId: string, at?: string) => void
  setLastAgentSpawnPermissionPreset: (preset: CliPermissionPreset) => void
  /** The preset spawns on one CLI launch with; `null` returns it to the app-wide default. */
  setCliPermissionPreset: (cli: AgentCli, preset: CliPermissionPreset | null, mode?: string | null) => void
  /**
   * Write (or clear with `null`) the model an agent spawn is remembered on. A
   * stored reasoning-effort level survives a model change within the same CLI
   * and is dropped when the CLI changes, per the per-CLI effort ruling; pass
   * `model: ''` for "the CLI's own default model" so the level survives that
   * choice too. `null` clears the whole selection, level included.
   */
  setLastSelectedAgentModel: (selection: AgentCliModelSelection | null) => void
  /**
   * Drop `modelIds` from the remembered launch default for `cli`, so a spawn
   * whose default named one of them falls back to the CLI's own default model
   * (no `--model` flag) rather than launching an id nothing offers.
   *
   * Called when the user RETIRES an id from `cliRuntimes[cli].models` and the
   * CLI's own list does not supply it either. Deliberately not driven by the
   * catalog going quiet: a CLI may accept an id it does not advertise, so a
   * persisted model the CLI merely stopped listing keeps launching — that is
   * the "Not listed" row in CliModelPicker. An explicit removal is a different
   * fact from a probe that no longer lists an id, and only it forgets.
   *
   * A reasoning-effort level survives, per the per-CLI effort ruling: the level
   * was chosen for the CLI, not for the model that just went away.
   */
  forgetCliModels: (cli: AgentCli, modelIds: readonly string[]) => void
  /**
   * Write (or clear with `null`) the remembered reasoning-effort level for
   * `cli`, keeping the model already chosen for that CLI. A level set while a
   * different CLI is stored replaces the selection, since levels do not
   * transfer between CLIs.
   */
  setLastSelectedAgentReasoning: (cli: AgentCli, reasoning: string | null) => void
  // Command ids are open strings: shell registry ids plus namespaced module
  // command ids (`<moduleId>.<commandId>`). The Shortcuts tab only offers rows
  // the merged registry currently exposes.
  setCommandKeybindings: (commandId: string, keybindings: string[]) => void
  setCommandKeybindingDisabled: (commandId: string, disabled: boolean) => void
  resetCommandKeybindings: (commandId: string) => void
  resetAllKeybindings: () => void
  setModuleEnabled: (moduleId: string, enabled: boolean) => void
  /**
   * Forget uninstalled modules: their enablement override and their settings
   * namespace. A later module that takes the same id starts from its own
   * manifest default, not from the choices made for the one before it.
   */
  forgetModules: (moduleIds: readonly string[]) => void
  /**
   * Write one value in a module's settings namespace (`module:<moduleId>`).
   * `undefined` deletes the key. Module enablement never touches this state,
   * so values survive a disable/enable cycle.
   */
  setModuleSettingValue: (moduleId: string, key: string, value: unknown) => void
  /** Record the user's "not now" on the first-run CLI card. One way only —
   *  there is no affordance that brings the card back, and none should be. */
  dismissFirstRunCliCard: () => void
  /** Mark this profile's one-time agent-config adoption as done. */
  markAgentConfigAdopted: () => void
  /** Record that the first-run import card was answered, by an import or by "not now". */
  markConversationImportOffered: () => void
  /** Set (or clear with `null`) the live outcome of the first-run adoption,
   *  read out as one line in Settings → Agents. */
  setAgentConfigAdoptionResult: (result: AgentConfigAdoptionResult | null) => void
  /** Set how long an idle agent terminal waits before it is paused (minutes). */
  setTerminalIdleSuspendMinutes: (minutes: number) => void
  setTerminalKeepRecentAlive: (count: number) => void
  setSettleOnPullRequestMerge: (enabled: boolean) => void
  /** Keep a chat with an open pull request out of the idle rule (Settings ▸ Settled chats). */
  setKeepChatsWithOpenPullRequest: (enabled: boolean) => void
  setSidebarWorkingSection: (enabled: boolean) => void
  setAutoSettleAfterDays: (days: number) => void
  setBrowserAutoFloatAgentPreview: (enabled: boolean) => void
  setFollowUpBehavior: (behavior: FollowUpBehavior) => void
  /** Keep the app (and its running agents) alive after the last window closes. */
  setKeepRunningInBackground: (enabled: boolean) => void
  setTelemetryEnabled: (enabled: boolean) => void
  setAppearanceTheme: (theme: AppTheme) => void
  /** The theme `system` uses on one side of the OS's light/dark switch. */
  setAppearanceSystemTheme: (side: 'light' | 'dark', theme: ResolvedAppTheme) => void
  setAppearanceWindowMaterial: (material: WindowMaterial) => void
  setAppearanceChatContrast: (contrast: number) => void
  setAppearanceChatWidth: (width: ChatWidth) => void
  setAppearanceClockFormat: (format: ClockFormat) => void
  setAppearanceReplyStreaming: (mode: ReplyStreaming) => void
  setAppearanceAgentCharacters: (enabled: boolean) => void
  setAppearanceUsageLimits: (enabled: boolean) => void
  /** A family name (or comma-separated list); empty restores the bundled face. */
  setAppearanceInterfaceFont: (family: string) => void
  setAppearanceCodeFont: (family: string) => void
}

export type SettingsSlice = SettingsSliceState & SettingsSliceActions

type SettingsSliceCarrier = SettingsSliceState & { workspaces: Workspace[] }
type SettingsSliceSet = (mutator: (state: SettingsSliceCarrier) => void) => void

// The one place the settings REQUEST is cleared (which category, update
// check). Every path that closes or replaces the Settings modal runs this, so
// a later plain open starts clean rather than on a stale tab.
function clearSettingsRequest(state: SettingsSliceCarrier): void {
  state.settingsOverlay.initialTab = null
  state.settingsOverlay.checkForUpdatesRequestId = null
  delete state.settingsOverlay.agentsMachineRequest
}

export function createSettingsSlice(set: SettingsSliceSet): SettingsSlice {
  // Hoisted out of the object literal so the named conveniences below can CALL
  // it rather than restate it. `openRoadmapSurface` restated it and drifted:
  // it kept the unconditional section flip the drawer ruling removed from here.
  const openGlobalSurface = (surfaceId: string) =>
    set((state) => {
      state.activeGlobalSurface = surfaceId
      // A door open closes any modal (doors→modals, 2026-09-01): the door
      // routes the card region, and leaving it under the modal's scrim made
      // history back/forward look dead — the destination mounted invisibly.
      state.activeModalSurface = null
      state.activeModalSurfaceWorkspaceId = null
      // Only a door that BELONGS to the Extensions drawer moves the section
      // (Extensions drawer ruling, 2026-09-05). This used to flip
      // unconditionally, on the reasoning that every door lived under the
      // Extensions glyph — but Automations stands on the RAIL now, and
      // opening it swapped the sidebar into a drawer the person had not asked
      // for and left the Extensions glyph reading current for a surface that
      // is not one of its five rows. A drawer door still flips, so leaving it
      // lands back on the drawer it was opened from rather than on the
      // workspaces tree.
      if (isExtensionsDrawerSurface(surfaceId)) state.sidebarSection = 'extensions'
    })
  return {
    appSettings: defaultAppSettings(),
    settingsOverlay: { initialTab: null, checkForUpdatesRequestId: null },
    activeGlobalSurface: null,
    activeModalSurface: null,
    activeModalSurfaceWorkspaceId: null,
    sidebarSection: 'home',
    chatListView: 'all',
    sidebarCollapsed: false,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    workspacePaneWidth: WORKSPACE_ASIDE_DEFAULT_WIDTH,
    workspacePaneMaximised: false,
    openFilesInExternalWindow: DEFAULT_OPEN_FILES_IN_EXTERNAL_WINDOW,
    diffOpensInWindow: DEFAULT_DIFF_OPENS_IN_WINDOW,
    diffView: DEFAULT_DIFF_VIEW,
    checkCliVersions: DEFAULT_CHECK_CLI_VERSIONS,
    agentConfigAdoptionResult: null,

    setSidebarSection: (section) =>
      set((state) => {
        state.sidebarSection = section
      }),

    setChatListView: (view) =>
      set((state) => {
        state.chatListView = view
      }),

    setSidebarCollapsed: (collapsed) =>
      set((state) => {
        state.sidebarCollapsed = collapsed
      }),

    setSidebarWidth: (width) =>
      set((state) => {
        state.sidebarWidth = clampSidebarWidth(width)
      }),

    setWorkspacePaneWidth: (width) =>
      set((state) => {
        state.workspacePaneWidth = clampWorkspaceAsideWidth(width)
      }),

    setWorkspacePaneMaximised: (maximised) =>
      set((state) => {
        state.workspacePaneMaximised = maximised
      }),

    setOpenFilesInExternalWindow: (enabled) =>
      set((state) => {
        state.openFilesInExternalWindow = enabled
      }),

    setDiffOpensInWindow: (enabled) =>
      set((state) => {
        state.diffOpensInWindow = enabled
      }),

    setDiffView: (view) =>
      set((state) => {
        state.diffView = view
      }),

    setCheckCliVersions: (enabled) =>
      set((state) => {
        state.checkCliVersions = enabled
      }),

    openSettingsOverlay: (opts) => {
      // The MCPs / Skill packs / Extensions settings tabs folded into the
      // connectors surface (T3), which is the Extensions door now.
      // Deep-links that once opened one of those tabs land on the door, so no
      // caller has to know either move happened; the old skill-packs tab lands
      // on Skills, which is what it was asking for. The latch
      // dispatch stays outside the producer — its listeners run synchronously
      // and must never observe a mid-update store.
      if (isConnectorsFoldedSettingsTab(opts?.initialTab)) {
        dispatchExtensionsSurfaceTarget({
          view:
            opts?.initialTab === SKILLS_SETTINGS_TAB ? EXTENSIONS_DRAWER_VIEWS.skills : EXTENSIONS_DRAWER_VIEWS.plugins,
        })
        // Plugins is a door again (Extensions drawer ruling, 2026-09-05), so
        // opening it from inside Settings routes the card region and leaves
        // nothing of the Settings modal behind. Through the one opener, not a
        // second copy of it: the section rule lives there.
        openGlobalSurface('extensions')
        set(clearSettingsRequest)
        return
      }
      set((state) => {
        state.activeModalSurface = 'settings'
        // Settings is the app's, not a workspace's: it replaces whatever modal
        // was open, and the opener workspace goes with that modal.
        state.activeModalSurfaceWorkspaceId = null
        state.settingsOverlay.initialTab = opts?.initialTab ?? null
        state.settingsOverlay.checkForUpdatesRequestId = opts?.checkForUpdates ? Date.now() : null
        if (opts?.agentsMachine) {
          lastAgentsMachineRequestId = Math.max(lastAgentsMachineRequestId + 1, Date.now())
          state.settingsOverlay.agentsMachineRequest = {
            hostId: opts.agentsMachine,
            requestId: lastAgentsMachineRequestId,
          }
        } else {
          delete state.settingsOverlay.agentsMachineRequest
        }
      })
    },

    closeSettingsOverlay: () =>
      set((state) => {
        // Only ever closes SETTINGS: a caller that means "leave settings" must
        // not clear another modal someone opened in the meantime.
        if (state.activeModalSurface === 'settings') {
          state.activeModalSurface = null
          state.activeModalSurfaceWorkspaceId = null
        }
        clearSettingsRequest(state)
      }),

    openExtensionsSurface: (opts) => {
      // Latch the deep-link first (the surface drains it on mount or live),
      // then open the door — the same order the automations deep-link uses.
      // The dispatch stays outside the producer so its synchronous listeners
      // never observe a mid-update store.
      dispatchExtensionsSurfaceTarget({
        view: opts?.view ?? EXTENSIONS_DRAWER_VIEWS.plugins,
        installed: opts?.installed,
      })
      // Through `openGlobalSurface`, which owns "a door closes the modal over
      // it" and "a drawer door moves the section". Restating those here is how
      // the same door came to leave the sidebar in one state from a command and
      // another from an id.
      openGlobalSurface('extensions')
      // Callers sit inside the Settings modal (Settings → Modules "Browse
      // marketplace"), and the settings request it was carrying goes with it
      // rather than surviving to re-open a category later.
      set(clearSettingsRequest)
    },

    openGlobalSurface,

    closeGlobalSurface: () =>
      set((state) => {
        state.activeGlobalSurface = null
      }),

    openModalSurface: (surfaceId, options) =>
      set((state) => {
        state.activeModalSurface = surfaceId
        state.activeModalSurfaceWorkspaceId = options?.workspaceId ?? null
      }),

    closeModalSurface: () =>
      set((state) => {
        state.activeModalSurface = null
        state.activeModalSurfaceWorkspaceId = null
        // A modal that closes takes any settings request with it, so a later
        // plain open starts clean rather than on a stale tab.
        clearSettingsRequest(state)
      }),

    // The five launch settings below (CLI runtimes, MCP, the last-selected CLI,
    // the spawn permission preset; knowledge roots live in memorySlice) are
    // main's. Each setter applies its change here at once, then sends main the
    // part it changed; main's answer replaces this window's copy
    // (launchSettingsClient).
    setCliRuntime: (cli, update) => {
      let runtime: CliRuntimeSettings | null = null
      set((state) => {
        const defaults = defaultAppSettings()
        state.appSettings.cliRuntimes ??= defaults.cliRuntimes
        // Unknown plugin ids default to a blank command so a row the user only
        // adds a model to does not pin the command to the plugin id; a blank
        // command resolves to the plugin manifest binary at launch.
        const fallback = defaults.cliRuntimes[cli] ?? { command: '' }
        const next = {
          ...fallback,
          ...state.appSettings.cliRuntimes[cli],
          ...update,
        }
        state.appSettings.cliRuntimes[cli] = next
        // A plain copy for main: `next.models` can still be the draft's array.
        runtime = { ...next, ...(next.models ? { models: [...next.models] } : {}) }
      })
      if (runtime) launchSettingsClient.update({ cliRuntimes: { [cli]: runtime } })
    },

    // One machine's settings (Settings ▸ Machines), replaced whole; `null`
    // forgets them. Main's answer replaces this copy, like every setter here.
    setHostSettings: (hostId, settings) => {
      set((state) => {
        const hosts = { ...state.appSettings.hosts }
        if (settings) hosts[hostId] = settings
        else delete hosts[hostId]
        state.appSettings.hosts = hosts
      })
      launchSettingsClient.update({ hosts: { [hostId]: settings } })
    },

    // One machine's mark, written the way a host's settings are: replaced
    // whole, `null` forgetting it, main's answer replacing this copy.
    setMachineMark: (machineId, mark) => {
      set((state) => {
        const marks = { ...state.appSettings.machineMarks }
        if (mark) marks[machineId] = mark
        else delete marks[machineId]
        state.appSettings.machineMarks = marks
      })
      launchSettingsClient.update({ machineMarks: { [machineId]: mark } })
    },

    setCliModelCatalog: (cli, catalog) =>
      set((state) => {
        // Only an explicit null clears. A payload that fails normalization is
        // not written at all: a probe that came back unusable must leave the
        // pickers rendering exactly what they rendered before, not wipe the
        // CLI's last good answer.
        const normalized = catalog ? normalizeCliModelCatalogs({ [cli]: catalog })?.[cli] : undefined
        if (catalog && !normalized) return
        const next = { ...state.appSettings.cliModelCatalog }
        if (normalized) {
          next[cli] = normalized
        } else {
          delete next[cli]
        }
        state.appSettings.cliModelCatalog = Object.keys(next).length > 0 ? next : undefined
      }),

    setMcpSyncEnabled: (enabled) => {
      set((state) => {
        state.appSettings.mcp = normalizeMcpSettings({
          ...state.appSettings.mcp,
          syncEnabled: enabled,
        })
      })
      launchSettingsClient.update({ mcp: { syncEnabled: enabled } })
    },

    upsertMcpServer: (server) => {
      const normalized = normalizeMcpServer(server)
      if (!normalized) return
      set((state) => {
        const current = normalizeMcpSettings(state.appSettings.mcp)
        state.appSettings.mcp = {
          ...current,
          syncEnabled: true,
          servers: {
            ...current.servers,
            [normalized.id]: normalized,
          },
        }
      })
      launchSettingsClient.update({ mcp: { syncEnabled: true, servers: { [normalized.id]: normalized } } })
    },

    refreshMcpServersFromSource: (servers) => {
      const refreshed: Record<string, McpServerConfig> = {}
      for (const server of servers) {
        const normalized = normalizeMcpServer(server)
        if (normalized) refreshed[normalized.id] = normalized
      }
      set((state) => {
        const current = normalizeMcpSettings(state.appSettings.mcp)
        state.appSettings.mcp = { ...current, servers: { ...current.servers, ...refreshed } }
      })
      if (Object.keys(refreshed).length > 0) launchSettingsClient.update({ mcp: { servers: refreshed } })
    },

    removeMcpServer: (serverId) => {
      const id = normalizeMcpId(serverId)
      set((state) => {
        const current = normalizeMcpSettings(state.appSettings.mcp)
        delete current.servers[id]
        state.appSettings.mcp = { ...current, syncEnabled: true }
      })
      launchSettingsClient.update({ mcp: { syncEnabled: true, ...(id ? { servers: { [id]: null } } : {}) } })
    },

    setLastSelectedCli: (cli) => {
      set((state) => {
        state.appSettings.lastSelectedCli = cli
      })
      launchSettingsClient.update({ lastSelectedCli: cli })
    },

    setWorktreeBranchPrefix: (prefix) => {
      const worktreeBranchPrefix = sanitizeWorktreeBranchPrefix(prefix)
      set((state) => {
        state.appSettings.worktreeBranchPrefix = worktreeBranchPrefix
      })
      launchSettingsClient.update({ worktreeBranchPrefix })
    },

    setAutoCompactChats: (enabled) => {
      set((state) => {
        state.appSettings.autoCompactChats = enabled
      })
      launchSettingsClient.update({ autoCompactChats: enabled })
    },

    recordProjectUse: (folderPath) => {
      if (!folderPath.trim()) return
      launchSettingsClient.update({ projectUse: { folderPath, at: Date.now() } })
    },

    setLastSelectedConversationModel: (selection) =>
      set((state) => {
        state.appSettings.lastSelectedConversationModel = normalizeConversationModel(selection)
      }),

    setTextGenerationEnabled: (enabled) =>
      set((state) => {
        state.appSettings.textGeneration = {
          ...normalizeTextGenerationSettings(state.appSettings.textGeneration),
          enabled,
        }
      }),

    setTextGenerationEngine: (selection) =>
      set((state) => {
        const current = normalizeTextGenerationSettings(state.appSettings.textGeneration)
        if (!selection) {
          state.appSettings.textGeneration = { ...current, engine: null }
          return
        }
        const stored = current.engine
        const reasoning = (
          selection.reasoning ?? (stored?.cli === selection.cli ? stored.reasoning : undefined)
        )?.trim()
        state.appSettings.textGeneration = {
          ...current,
          engine: { cli: selection.cli, model: selection.model.trim(), ...(reasoning ? { reasoning } : {}) },
        }
      }),

    setTextGenerationWritingStyle: (style) =>
      set((state) => {
        const current = normalizeTextGenerationSettings(state.appSettings.textGeneration)
        state.appSettings.textGeneration = {
          ...current,
          writingStyle: normalizeWritingStyle({ ...current.writingStyle, ...style }),
        }
      }),

    setLastNewChatAgent: (choice) =>
      set((state) => {
        state.appSettings.lastNewChatAgent = normalizeNewChatAgentChoice(choice)
      }),

    setLastFolderOpenTarget: (target) =>
      set((state) => {
        state.appSettings.lastFolderOpenTarget = isFolderOpenTargetId(target) ? target : null
      }),

    setDesignProjectScopePath: (path) =>
      set((state) => {
        state.appSettings.designProjectScopePath = normalizeFolderPathSetting(path)
      }),

    setProjectColor: (key, color) =>
      set((state) => {
        const projectKey = key.trim()
        if (!projectKey) return
        const current = state.appSettings.projectColors ?? {}
        if (color === null) {
          if (!Object.hasOwn(current, projectKey)) return
          const next = { ...current }
          delete next[projectKey]
          state.appSettings.projectColors = next
          return
        }
        if (!isProjectColorSetting(color)) return
        if (current[projectKey] === color) return
        state.appSettings.projectColors = { ...current, [projectKey]: color }
      }),

    setProjectIcon: (folderPath, icon) =>
      set((state) => {
        const key = folderPath.trim() ? normalizeFolderKey(folderPath) : ''
        if (!key) return
        const current = state.appSettings.projectIcons ?? {}
        if (icon === null) {
          if (!Object.hasOwn(current, key)) return
          const next = { ...current }
          delete next[key]
          state.appSettings.projectIcons = next
          return
        }
        if (!isProjectIconSetting(icon)) return
        state.appSettings.projectIcons = { ...current, [key]: icon }
      }),

    markDesignSystemSeen: (bundleId, at) =>
      set((state) => {
        const id = typeof bundleId === 'string' ? bundleId.trim() : ''
        if (!id) return
        const stamp = typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : new Date().toISOString()
        // Through the normalizer rather than a bare assignment, so the trim to
        // the most recent stamps happens on the write that grows the map rather
        // than only on the next hydration.
        state.appSettings.designSystemSeen = normalizeDesignSystemSeen({
          ...state.appSettings.designSystemSeen,
          [id]: stamp,
        })
      }),

    setLastAgentSpawnPermissionPreset: (preset) => {
      const normalized = normalizeCliPermissionPreset(preset)
      set((state) => {
        state.appSettings.lastAgentSpawnPermissionPreset = normalized
      })
      launchSettingsClient.update({ lastAgentSpawnPermissionPreset: normalized })
    },

    // One CLI's preset (the spawn footer's picker). Only that CLI's key goes to
    // main, so two windows setting two CLIs cannot overwrite each other, and
    // main's broadcast carries the result to every window.
    // The CLI's own mode goes with it, and is cleared with it: a choice that is
    // a preset's own mode stores no mode.
    setCliPermissionPreset: (cli, preset, mode) => {
      const normalized = preset === null ? null : normalizeCliPermissionPreset(preset)
      const ownMode = normalized ? parseCliPermissionModeId(mode) : null
      set((state) => {
        const presets = { ...state.appSettings.cliPermissionPresets }
        const modes = { ...state.appSettings.cliPermissionModes }
        if (normalized) presets[cli] = normalized
        else delete presets[cli]
        if (ownMode) modes[cli] = ownMode
        else delete modes[cli]
        state.appSettings.cliPermissionPresets = presets
        state.appSettings.cliPermissionModes = modes
      })
      launchSettingsClient.update({
        cliPermissionPresets: { [cli]: normalized },
        cliPermissionModes: { [cli]: ownMode },
      })
    },

    setLastSelectedAgentModel: (selection) =>
      set((state) => {
        if (!selection) {
          state.appSettings.lastSelectedAgentModel = null
          return
        }
        const model = selection.model.trim()
        const stored = state.appSettings.lastSelectedAgentModel
        // Effort is per-CLI: a level chosen for this CLI outlives a model
        // change (including a switch to the CLI's default model), and a level
        // chosen for a different CLI is dropped rather than carried onto a CLI
        // that may not accept it. An explicit `reasoning` on the incoming
        // selection wins over the stored one.
        const reasoning = (
          selection.reasoning ?? (stored?.cli === selection.cli ? stored.reasoning : undefined)
        )?.trim()
        if (!model && !reasoning) {
          state.appSettings.lastSelectedAgentModel = null
          return
        }
        state.appSettings.lastSelectedAgentModel = {
          cli: selection.cli,
          model,
          ...(reasoning ? { reasoning } : {}),
        }
      }),

    forgetCliModels: (cli, modelIds) =>
      set((state) => {
        const retired = new Set(modelIds.map((id) => id.trim()).filter(Boolean))
        if (retired.size === 0) return
        const stored = state.appSettings.lastSelectedAgentModel
        if (!stored || stored.cli !== cli || !retired.has(stored.model.trim())) return
        // Same shape the model setter writes for "the CLI's own default
        // model": an entry with no model and no level is nothing at all.
        const reasoning = stored.reasoning?.trim()
        state.appSettings.lastSelectedAgentModel = reasoning ? { cli, model: '', reasoning } : null
      }),

    setLastSelectedAgentReasoning: (cli, reasoning) =>
      set((state) => {
        const level = reasoning?.trim()
        const stored = state.appSettings.lastSelectedAgentModel
        // The model only survives when it belongs to the CLI the level was
        // picked for; a level for another CLI starts that CLI's selection on
        // its own default model.
        const model = stored?.cli === cli ? stored.model : ''
        if (!level && !model) {
          state.appSettings.lastSelectedAgentModel = null
          return
        }
        state.appSettings.lastSelectedAgentModel = {
          cli,
          model,
          ...(level ? { reasoning: level } : {}),
        }
      }),

    // The setters accept any non-empty command id: the Shortcuts tab only
    // offers rows from the merged shell + enabled-module registry, and stored
    // deltas for ids that are not currently registered are inert until the
    // owning module is enabled again.
    setCommandKeybindings: (commandId, keybindings) =>
      set((state) => {
        if (!commandId.trim()) return
        const current = normalizeKeybindingSettings(state.appSettings.keybindings)
        const normalized = normalizeCommandKeybindings(keybindings)
        const legacyId = LEGACY_COMMAND_ID_ALIASES[commandId]
        if (normalized.length === 0) {
          delete current.overrides[commandId]
          // Clearing must also drop a persisted legacy-id override, or the
          // read paths would resurrect the stale binding.
          if (legacyId) delete current.overrides[legacyId]
        } else {
          current.overrides[commandId] = normalized
          // The new-id override now owns the binding; the legacy entry would
          // only shadow future clears.
          if (legacyId) delete current.overrides[legacyId]
        }
        state.appSettings.keybindings = current
      }),

    setCommandKeybindingDisabled: (commandId, disabled) =>
      set((state) => {
        if (!commandId.trim()) return
        const current = normalizeKeybindingSettings(state.appSettings.keybindings)
        // A migrated command's persisted state may live under its legacy id
        // (LEGACY_COMMAND_ID_ALIASES) — writes must clear it, or re-enabling
        // could never stick (the read paths honor the legacy key).
        const legacyId = LEGACY_COMMAND_ID_ALIASES[commandId]
        if (disabled) {
          current.disabled[commandId] = true
        } else {
          delete current.disabled[commandId]
          if (legacyId) delete current.disabled[legacyId]
        }
        state.appSettings.keybindings = current
      }),

    resetCommandKeybindings: (commandId) =>
      set((state) => {
        if (!commandId.trim()) return
        const current = normalizeKeybindingSettings(state.appSettings.keybindings)
        const legacyId = LEGACY_COMMAND_ID_ALIASES[commandId]
        delete current.overrides[commandId]
        delete current.disabled[commandId]
        if (legacyId) {
          delete current.overrides[legacyId]
          delete current.disabled[legacyId]
        }
        state.appSettings.keybindings = current
      }),

    resetAllKeybindings: () =>
      set((state) => {
        state.appSettings.keybindings = defaultKeybindingSettings()
      }),

    setModuleEnabled: (moduleId, enabled) =>
      set((state) => {
        const id = moduleId.trim()
        if (!id) return
        state.appSettings.modules = {
          ...normalizeModuleOverrides(state.appSettings.modules),
          [id]: enabled,
        }
      }),

    forgetModules: (moduleIds) =>
      set((state) => {
        const modules = { ...normalizeModuleOverrides(state.appSettings.modules) }
        const moduleSettings = { ...normalizeModuleSettings(state.appSettings.moduleSettings) }
        for (const moduleId of moduleIds) {
          const id = moduleId.trim()
          if (!id) continue
          delete modules[id]
          delete moduleSettings[moduleSettingsNamespace(id)]
        }
        state.appSettings.modules = modules
        state.appSettings.moduleSettings = moduleSettings
      }),

    setModuleSettingValue: (moduleId, key, value) =>
      set((state) => {
        const id = moduleId.trim()
        const settingKey = key.trim()
        if (!id || !settingKey) return
        const namespace = moduleSettingsNamespace(id)
        const current = normalizeModuleSettings(state.appSettings.moduleSettings)
        const entry = { ...current[namespace] }
        if (value === undefined) {
          delete entry[settingKey]
        } else {
          entry[settingKey] = value
        }
        state.appSettings.moduleSettings = { ...current, [namespace]: entry }
      }),

    dismissFirstRunCliCard: () =>
      set((state) => {
        state.appSettings.firstRunCliCardDismissed = true
      }),

    markAgentConfigAdopted: () =>
      set((state) => {
        state.appSettings.hasAdoptedAgentConfig = true
      }),

    markConversationImportOffered: () =>
      set((state) => {
        state.appSettings.conversationImportOffered = true
      }),

    setAgentConfigAdoptionResult: (result) =>
      set((state) => {
        state.agentConfigAdoptionResult = result
      }),

    setTerminalIdleSuspendMinutes: (minutes) =>
      set((state) => {
        state.appSettings.terminalIdleSuspendMinutes = normalizeTerminalIdleSuspendMinutes(minutes)
      }),

    setSettleOnPullRequestMerge: (enabled) =>
      set((state) => {
        state.appSettings.settleOnPullRequestMerge = enabled
      }),

    setKeepChatsWithOpenPullRequest: (enabled) =>
      set((state) => {
        state.appSettings.keepChatsWithOpenPullRequest = enabled === true
      }),

    setSidebarWorkingSection: (enabled) =>
      set((state) => {
        state.appSettings.sidebarWorkingSection = enabled === true
      }),

    setAutoSettleAfterDays: (days) =>
      set((state) => {
        state.appSettings.autoSettleAfterDays = normalizeAutoSettleAfterDays(days)
      }),

    setBrowserAutoFloatAgentPreview: (enabled) =>
      set((state) => {
        state.appSettings.browserAutoFloatAgentPreview = enabled === true
      }),

    setTerminalKeepRecentAlive: (count) =>
      set((state) => {
        state.appSettings.terminalKeepRecentAlive = normalizeTerminalKeepRecentAlive(count)
      }),

    setFollowUpBehavior: (behavior) =>
      set((state) => {
        state.appSettings.followUpBehavior = normalizeFollowUpBehavior(behavior)
      }),

    setKeepRunningInBackground: (enabled) =>
      set((state) => {
        state.appSettings.keepRunningInBackground = enabled === true
      }),

    setTelemetryEnabled: (enabled) =>
      set((state) => {
        state.appSettings.telemetryEnabled = enabled !== false
      }),

    setAppearanceTheme: (theme) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          theme,
        })
      }),

    setAppearanceSystemTheme: (side, theme) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          [side === 'light' ? 'systemLightTheme' : 'systemDarkTheme']: theme,
        })
      }),

    setAppearanceWindowMaterial: (material) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          windowMaterial: material,
        })
      }),

    setAppearanceChatContrast: (contrast) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          chatContrast: contrast,
        })
      }),

    setAppearanceChatWidth: (width) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          chatWidth: width,
        })
      }),

    setAppearanceClockFormat: (format) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          clockFormat: format,
        })
      }),

    setAppearanceReplyStreaming: (mode) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          replyStreaming: mode,
        })
      }),

    setAppearanceAgentCharacters: (enabled) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          agentCharacters: enabled,
        })
      }),

    setAppearanceUsageLimits: (enabled) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          usageLimits: enabled,
        })
      }),

    setAppearanceInterfaceFont: (family) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          interfaceFont: family,
        })
      }),

    setAppearanceCodeFont: (family) =>
      set((state) => {
        state.appSettings.appearance = normalizeAppearanceSettings({
          ...state.appSettings.appearance,
          codeFont: family,
        })
      }),
  }
}
