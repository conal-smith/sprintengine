import type { EditorRange } from '../../../shared/editor-reveal'
import type { ProjectIconSetting } from '../../../shared/project-icon'
import type { BranchStepSelection } from '../../../shared/electron-api'
import type { IJsonModel } from 'flexlayout-react'
import type { BrowserViewport } from '../../../shared/browser-devices'
import type { CliPermissionPreset } from '../../../shared/cli-permission-preset'
import type { ProjectUsageMap } from '../../../shared/project-frecency'
// The `AgentState` record is shared with the main process, which composes agent
// launches with no window open. Canonical definitions — including all field
// documentation — live in `src/shared/agent-state.ts`; the imports pull in the
// names this module still references and the re-export block below keeps every
// existing renderer import site working unchanged.
import type { AgentCli, AgentId, AgentConversationRuntime, AgentState, McpSettings } from '../../../shared/agent-state'

export type {
  AgentCli,
  AgentConversationRuntime,
  AgentExecution,
  AgentExecutionMode,
  AgentId,
  AgentRuntimeKind,
  AgentState,
  McpServerConfig,
  McpSettings,
} from '../../../shared/agent-state'
export type { CliPermissionPreset } from '../../../shared/cli-permission-preset'
export type WorkspaceId = string
export type WorkspaceWindowId = string
export const STANDARD_WORKSPACE_MODE = 'standard'

export type BundledWorkspaceMode = typeof STANDARD_WORKSPACE_MODE

// Lifted to the shared layer so shared contracts can name the mode without
// importing the renderer; `STANDARD_WORKSPACE_MODE` is its `'standard'` member.
// Module-registered types that hide from the rail set
// `WorkspaceTypeDefinition.hiddenFromRail`. Imported here (so this module's own
// references resolve) and re-exported so every existing import site keeps
// resolving here.
import type { WorkspaceMode } from '../../../shared/workspace-mode'
export type { WorkspaceMode }

export type HighlightColor = 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink'

export type WorkspaceHighlight = {
  starred: boolean
  color: HighlightColor | null
}

/**
 * The hue a project's folder glyph wears: a whole degree on the OKLCH wheel,
 * 0 to 359 (owner, 2026-09-09; hashed from the project's name since
 * 2026-09-11). Lightness and chroma are design tokens, so the angle is the only
 * thing that varies between projects.
 *
 * Declared here, beside HighlightColor and for the same reason: AppSettings is
 * shared with main (tsconfig.node lists this file and nothing else out of the
 * renderer), so the type has to live somewhere main can reach. The hash, the
 * guards and the picker's presets are utils/projectColor.ts, which re-exports
 * these two names.
 */
export type ProjectColor = number

/**
 * What is stored per project, and only when the person chose it: a hue, or
 * `'none'` for "no colour". A project with no entry wears its hashed hue.
 */
export type ProjectColorSetting = ProjectColor | 'none'

export type PreviewSlot = {
  x: number
  y: number
  w: number
  h: number
  type: 'agent' | 'editor' | 'explorer'
  label: string
}

export type LayoutTemplate = {
  id: string
  name: string
  description: string
  previewSlots: PreviewSlot[]
  layout: IJsonModel
}

type WorktreeEntryStatus = 'available' | 'assigned' | 'missing' | 'removing' | 'error'

export type CliRuntimeSettings = {
  // The command on THIS machine. A WSL machine keeps its own commands in the
  // launch settings' `hosts` (Settings ▸ Machines).
  command: string
  // User-added model ids for this CLI, merged with the plugin manifest's seed
  // options in pickers. Mirrors the shared electron-api type.
  models?: string[]
}

// Whether an agent CLI's binary is actually installed/runnable on this machine,
// distinct from whether its plugin manifest is registered. Mirrors the shared
// electron-api type. Keyed by plugin id in AgentCliAvailabilityMap.
type CliAvailability = {
  cli: AgentCli
  installed: boolean
  resolvedPath: string | null
  version: string | null
}

export type AgentCliAvailabilityMap = Record<AgentCli, CliAvailability>

export type WorktreeEntry = {
  id: string
  path: string
  branch: string | null
  ownerAgentId: AgentId | null
  status: WorktreeEntryStatus
  createdAt: number
  updatedAt: number
  missingAt?: number | null
}

export type WorkspaceWorktreeState = {
  containerPath: string | null
  entries: Record<string, WorktreeEntry>
  updatedAt: number | null
}

export type MemoryGraphColorRule = {
  id: string
  pattern: string
  color: string
}

export type MemoryGraphFiltersConfig = {
  hideOrphans: boolean
  hideAttachments: boolean
  hideUnresolved: boolean
  depthFromSelection: number | null
  disabledGroups: string[]
}

export type MemoryGraphDisplayConfig = {
  nodeSizeScale: number
  lineThicknessScale: number
  labelFadeThreshold: number
  labelFontSize: number
  showArrows: boolean
  curvedEdges: boolean
  glowHalos: boolean
  starfield: boolean
}

export type MemoryGraphForcesConfig = {
  centerForce: number
  repelForce: number
  linkForce: number
  linkDistance: number
}

export type MemoryGraphSettings = {
  /** Bumped when default tuning changes so the renderer can migrate stored values. */
  version?: number
  sidebarOpen: boolean
  activeTab: 'filters' | 'groups' | 'display' | 'forces'
  filters: MemoryGraphFiltersConfig
  colorRules: MemoryGraphColorRule[]
  display: MemoryGraphDisplayConfig
  forces: MemoryGraphForcesConfig
}

export type WorkspaceMemoryConfig = {
  relativeRoot: string | null
  graphSettings?: MemoryGraphSettings
}

// Records why a persisted workspace registry intentionally has zero workspaces.
// Hydration failure, parse failure, migration failure, and unknown startup
// empties all remain distinct (they are classifications of the persisted shape,
// not states of the registry). This record only exists for user-initiated wipes
// so the model unambiguously distinguishes intent from failure.
export type WorkspaceRegistryEmptyState = {
  reason: 'user_removed_all'
  updatedAt: string
}

export type WorkspaceWindowState = {
  id: WorkspaceWindowId
  kind: 'primary' | 'detached'
  workspaceIds: WorkspaceId[]
  activeWorkspaceId: WorkspaceId | null
  bounds: { x: number; y: number; width: number; height: number } | null
  isMaximized: boolean
  displayId: number | null
  createdAt: number
  lastFocusedAt: number
}

// Theme system source of truth lives in `src/renderer/src/types/appTheme.ts`.
// AppearanceSettings is imported here so AppSettings (below) can reference it;
// every other theme symbol (AppTheme, ResolvedAppTheme, the picker option list,
// the normalizer) imports directly from appTheme.ts.
import type { AppearanceSettings } from './appTheme'
import type { ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import type { PluginRegistryListEntry } from '../../../shared/plugin-manifest'
import type { DiscoveredCliModelCatalog } from '../../../shared/cli-model-catalog'
import type { FolderOpenTargetId } from '../../../shared/folder-open-targets'
import type { TextGenerationSettings } from '../../../shared/text-generation/contract'

export type PluginCatalogStatus = 'loading' | 'ready' | 'error'

export type PluginCatalogEntry = PluginRegistryListEntry

export type KeybindingSettings = {
  /**
   * User-defined command shortcut overrides. Empty or missing arrays mean
   * "use the command registry defaults"; dispatch must also check `disabled`.
   */
  overrides: Record<string, string[]>
  /**
   * Persisted command disablement flags. Only `true` values are meaningful;
   * missing/false means the command remains enabled.
   */
  disabled: Record<string, boolean>
}

// A model choice scoped to the CLI it was made for. Model ids are only
// meaningful per-CLI; pairing them prevents cross-CLI leakage.
//
// `reasoning` is the selected reasoning-effort level, and it is a property of
// the CLI rather than of the model (owner ruling 2026-07-26): switching model
// within a CLI leaves it untouched, and switching CLI drops it, because the
// levels a CLI accepts are manifest knowledge that does not transfer. Absent
// means "the CLI's own default effort", which passes no flag.
//
// `model` may therefore be empty while `reasoning` is set: choosing the CLI's
// default model is a model switch, not a reason to forget the level. Readers
// resolve through resolveCliModel / resolveCliReasoning, which treat an empty
// value as "no flag".
export type AgentCliModelSelection = {
  cli: AgentCli
  model: string
  reasoning?: string
}

// The agent the sidebar's "New chat in project" item spawns on a plain click,
// remembered from the last pick in the agent picker. Only the kind is stored —
// the CLI/model still resolves from `lastSelectedCli` and
// `lastSelectedAgentModel` at spawn time, so a later CLI switch is honored.
export type NewChatAgentChoice = { kind: 'general' } | { kind: 'terminal' } | { kind: 'conversation' }

/**
 * What a message sent while a chat's agent is working does: `queue` holds it
 * and sends it when the turn ends; `steer` hands it to the running turn.
 */
export type FollowUpBehavior = 'queue' | 'steer'

export type AppSettings = {
  cliRuntimes: Record<AgentCli, CliRuntimeSettings>
  /**
   * Per-machine settings for the machines this computer offers besides itself
   * (the WSL distributions on Windows), keyed by host id: whether each is a
   * machine for new chats, its own CLI commands, environment and shell. A read
   * model of main's launch settings, like `cliRuntimes`.
   */
  hosts?: Partial<
    Record<
      import('../../../shared/execution-host').ExecutionHostId,
      import('../../../shared/execution-host').ExecutionHostSettings
    >
  >
  /**
   * The kind and colour a person chose for each machine (Settings › Machines),
   * keyed by machine id (`shared/machine-identity`). A read model of main's
   * launch settings, like `hosts`; a machine with no entry wears its defaults.
   */
  machineMarks?: import('../../../shared/machine-identity').MachineMarkSettings
  /**
   * What each agent CLI last reported about its own models, keyed by plugin id.
   * A sibling of `cliRuntimes[id].models`, never the same store: that list is
   * the user's own escape hatch and must survive a refresh, while this one is
   * replaced wholesale every time the CLI is re-probed. No code path writes
   * both. Pickers show this, else the manifest seed, then the user's list
   * (mergeCliModelCatalog); absent means "never probed", and an entry with no
   * models means "probed and the CLI listed nothing", which the picker shows
   * as the seed.
   */
  cliModelCatalog?: Partial<Record<AgentCli, DiscoveredCliModelCatalog>>
  keybindings: KeybindingSettings
  mcp: McpSettings
  /**
   * The CLI an agent spawn runs on unless the caller names one: what the
   * composer's engine picker writes, the fallback for an automation with no
   * runtime of its own, and settable directly in Settings.
   */
  lastSelectedCli: AgentCli
  /**
   * Last provider/model pair spawned as a conversation agent, so a new
   * Conversation agent reopens with it. `null` until the user spawns one; a
   * remembered pair that is no longer installed falls back to the first
   * available option at spawn time.
   */
  lastSelectedConversationModel: AgentConversationRuntime | null
  /**
   * Whether, and on which of the person's own agent CLIs, small pieces of
   * text are written by a model instead of a heuristic — today the chat
   * title from a first prompt. Runs under the CLI's own login, never an API
   * key, and the heuristic stands whenever this is off, no supported CLI is
   * installed, or the call fails. `engine: null` means the first supported
   * installed CLI at its cheap default (see TEXT_GENERATION_BACKENDS).
   */
  textGeneration: TextGenerationSettings
  /**
   * Agent the sidebar's "New chat in project" item spawns on a plain click.
   * Updated whenever the user picks an agent from the new-chat picker, so the
   * next plain click repeats that choice and the menu can show what will spawn.
   */
  lastNewChatAgent: NewChatAgentChoice
  /**
   * Target the workspace bar's open-in-editor split button last used, so its
   * primary half repeats that choice. Per APP, not per workspace: which editor
   * you use is a property of the machine you are sitting at, not of the project
   * (item 1990). `null` until the user picks one, which resolves to the first
   * available target at render time; a remembered target that no longer probes
   * as installed falls back the same way rather than offering a dead editor.
   */
  lastFolderOpenTarget: FolderOpenTargetId | null
  lastAgentSpawnPermissionPreset: CliPermissionPreset
  /**
   * The preset a spawn on each CLI launches with, keyed by CLI id: what the
   * spawn footer's picker last chose for that runtime. A CLI with no entry
   * reads `lastAgentSpawnPermissionPreset`. A read model of main's launch
   * settings, like `cliRuntimes`, so every window and a launch with no window
   * open read the same choice.
   */
  cliPermissionPresets?: Partial<Record<AgentCli, CliPermissionPreset>>
  /**
   * The CLI's own mode chosen with that preset, keyed by CLI id, for a choice
   * that is not the preset's own mode (Claude Code's Accept edits). Read only
   * beside the CLI's `cliPermissionPresets` entry. A read model of main's.
   */
  cliPermissionModes?: Partial<Record<AgentCli, string>>
  /**
   * Where chats were started, by project folder: what the New chat project
   * picker lists by (`shared/project-frecency.ts`). A read model of main's;
   * recorded through `recordProjectUse`.
   */
  projectUsage?: ProjectUsageMap
  /**
   * What new worktree branches start with (Settings ▸ Worktrees): `agent`
   * unless changed, `''` for no prefix. A read model of main's launch
   * settings, which name a worktree with no window open too; never chosen
   * reads as `agent` (`effectiveWorktreeBranchPrefix`).
   */
  worktreeBranchPrefix: string
  /**
   * Auto compact for every chat whose own menu leaves it unset (Settings ▸
   * Settled chats): off unless switched on. A read model of main's launch
   * settings, since main runs the compaction with no window open.
   */
  autoCompactChats: boolean
  /**
   * The model (and reasoning-effort level) an agent spawn last ran on, stored
   * with the CLI it was picked for so a later CLI switch cannot leak a stale
   * model across CLIs. Honored only when the spawn's effective CLI matches;
   * otherwise no model flag is passed. `null` until the user picks one.
   */
  lastSelectedAgentModel: AgentCliModelSelection | null
  projectKnowledgeRoots: Record<string, string | null>
  /**
   * The colours a person chose for projects' folder glyphs, keyed by
   * `projectColorKey` (utils/projectColor) — the canonical repository key when
   * the folder has a remote, else the normalised folder path.
   *
   * Overrides only. A project with no entry wears the hue hashed from its key,
   * which is the same on every machine; an entry is a hue the person picked or
   * `'none'` for "no colour", and is this machine's alone.
   */
  projectColors: Record<string, ProjectColorSetting>
  /**
   * A project's chosen icon, keyed by its folder (`normalizeFolderKey`):
   * a file of the person's, or a generated monogram. Overrides only; a project
   * with no entry shows its detected logo, else the folder glyph.
   */
  projectIcons?: Record<string, ProjectIconSetting>
  recentWorkspaceFolders: string[]
  /**
   * The project the Design door is showing, chosen with its own project chip.
   *
   * The door opens from the Extensions drawer, which is global: without this it
   * bound to whichever workspace happened to be focused last, so pointing the
   * app at another folder made it claim knowledge of a project the user never
   * chose (owner, 2026-09-07). It is a VIEWING scope and nothing else — what an
   * agent is told about a design system still comes from the presence of
   * `design-system/` in its own execution root, so browsing project B here can
   * never change what an agent in project A is told.
   *
   * Null (the default) means "follow the active workspace", which is also where
   * a stored folder that has since gone lands.
   */
  designProjectScopePath: string | null
  /**
   * When the Design door last SHOWED each design system: bundle id → ISO.
   *
   * The bundle id is `designSystemRegistrationId(path)` — the library's own
   * stable key for a folder, so the attached in-project copy and the same folder
   * registered in the library are one bundle here, which is what they are.
   *
   * It is what "New" is measured against: an entry that arrived after this
   * stamp is marked, and opening the bundle re-stamps it so the next visit is
   * clean. Per MACHINE, deliberately — this is a fact about what this person has
   * looked at on this computer, not about the bundle, and it must never be
   * written into a folder someone else authored.
   *
   * `{}` (the default) means nothing has been opened yet, and a bundle absent
   * from the map has never been seen: everything in it is treated as already
   * seen except what arrived inside the last thirty days, so a fresh profile
   * pointed at a five-year-old repo surfaces this week rather than every week.
   */
  designSystemSeen: Record<string, string>
  appearance: AppearanceSettings
  /** Capability-module enablement overrides, keyed by module id. */
  modules: ModuleEnablementOverrides
  /**
   * Values persisted by module-contributed settings sections, keyed by
   * `module:<moduleId>` namespace so module keys can never collide with shell
   * settings. Disabling a module hides its section but leaves this namespace
   * intact, so values survive a disable/enable cycle. Values must be
   * JSON-serializable.
   */
  moduleSettings: Record<string, Record<string, unknown>>
  /**
   * Whether the user has made a first-run capability-module choice. Until then
   * the module chooser is shown. Existing installs (with workspaces) are treated
   * as already-chosen so an upgrade never interrupts them.
   */
  modulesChosen: boolean
  /**
   * Whether the first-run "you have no agent CLI" card has been dismissed. The
   * only persisted trace of the retired onboarding wizard, and deliberately a
   * boolean rather than a step position: whether to ASK is a live predicate over
   * probe state (see store/onboardingState.ts), and only the user's "not now"
   * needs to survive a restart. Defaults true for any profile that predates the
   * wizard's removal, so an upgrade is never asked.
   */
  firstRunCliCardDismissed: boolean
  /**
   * Whether this profile has already had an existing Claude Code / Codex agent
   * config adopted. Adoption runs silently at first workspace creation — it
   * needs a real folder on disk, which does not exist any earlier — and this
   * flag is what makes it once-per-profile rather than once-per-workspace.
   */
  hasAdoptedAgentConfig: boolean
  /**
   * Whether this profile has been offered its Claude Code and Codex sessions
   * to import, on the first-run card. Set by the card's import and by its
   * "not now", once: Settings → Agents imports at any time after. Defaults
   * true for a profile that already had chats, which never sees the card.
   */
  conversationImportOffered: boolean
  /**
   * How long an idle agent terminal sits before it is paused (its CLI process is
   * killed to reclaim memory, with the painted view frozen and resumed on click
   * or keystroke). In MINUTES; default 15. Never applies to agents waiting on the
   * user or mid-work. Synced to the main reap policy, which clamps it to
   * [1 minute, 24 hours]. See terminal-reap-policy.ts.
   */
  terminalIdleSuspendMinutes: number
  /**
   * Recency floor for the idle-terminal pauser: the N most recently used agent
   * terminals are always left running, even once idle past the threshold, so
   * the reaper can never pause the user's whole active set. 0 disables the
   * floor. Synced to the main reap policy, which clamps it to [0, 20].
   */
  terminalKeepRecentAlive: number
  /**
   * Settle a chat once its pull requests have landed (Settings ▸ Settled
   * chats), for chats with Auto-settle switched on (`autoSettleEnabled`). On
   * by default: a merged pull request is the clearest sign a chat's work is
   * done. See `pullRequestsLanded`.
   */
  settleOnPullRequestMerge: boolean
  /**
   * Keep a chat with an open pull request out of the three-quiet-days rule
   * (Settings ▸ Settled chats), for chats with Auto-settle switched on. On by
   * default: a pull request waiting on review is work still in flight, however
   * long the chat itself has been quiet. Settle on merge is separate.
   */
  keepChatsWithOpenPullRequest: boolean
  /** How many quiet days settle a chat with Auto-settle on (Settings ▸ Settled chats), 1 to 90. */
  autoSettleAfterDays: number
  /**
   * Float the pane's browser over the workspace when an agent opens or drives
   * a page while the pane is closed, so the person sees what it is doing
   * without giving up the chat's width. On by default. Off, an agent's
   * `browser.open` opens the pane, as it did before the player existed, and
   * driving a tab in a closed pane shows nothing.
   */
  browserAutoFloatAgentPreview: boolean
  /**
   * What Enter does in a chat whose agent is working (Settings ▸ Agents).
   * `queue`, the default and every message's rule before the choice existed,
   * holds the message and sends it when the turn ends; `steer` hands it to the
   * running turn, where the chat's provider takes one, and queues it anywhere
   * else. Primary+Enter, or a Primary-click on the send button, does the other
   * for one message.
   */
  followUpBehavior: FollowUpBehavior
  /**
   * Keep the app running when its last window closes, on every platform.
   * Off by default, which is byte-for-byte the rule before background mode existed:
   * quit on Windows/Linux, survive on macOS. On, the process stays up with a
   * tray presence, so running agents, the scheduler and the Studio gateway keep
   * working with no window open. Mirrored to main (`setBackgroundMode`), which
   * reads it at last-window-close when no renderer is left to ask.
   */
  keepRunningInBackground: boolean
  /**
   * Share anonymous usage data. On by default; the switch a user flips to opt
   * out of product telemetry.
   *
   * Mirrored to main (`setTelemetryEnabled`), which is the only process that
   * sends anything — the renderer neither holds the project key nor records
   * events, so turning this off here is a push, not a local suppression. What
   * may be collected, and the environment kill switch that outranks this
   * setting, are both in `src/shared/telemetry.ts`.
   */
  telemetryEnabled: boolean
}

/**
 * Live outcome of the first-run config adoption, read out as one line in
 * Settings → Agents. Transient app state (not persisted): set when adoption runs
 * at workspace creation, never resumed.
 */
export type AgentConfigAdoptionResult =
  | { status: 'adopting' }
  | { status: 'adopted'; mcpServerCount: number; skillCount: number; warnings: string[] }
  | { status: 'failed'; message: string }

export type DiagnosticLevel = 'info' | 'warning' | 'error'
// `module` is a capability module's own `notify` row (the bell rows
// shared/modules/notifications.ts delivers); which module is `sourceModule`.
export type DiagnosticSource =
  'agents' | 'auth' | 'cli' | 'filesystem' | 'marketplace' | 'models' | 'module' | 'terminal' | 'update' | 'workspace'

// A typed, serializable deep-focus target for a notification's Open action. The
// shell treats it as opaque (it only knows how to reveal the workspace); the
// owning module interprets `kind`/`ref` and resolves it to a selection of its
// own. Must stay plain data — notifications persist to localStorage, so this
// never carries a callback.
export type NotificationNavigationTarget = {
  kind: string
  ref: string
}

export type DiagnosticLogInput = {
  level: DiagnosticLevel
  source: DiagnosticSource
  title: string
  message: string
  details?: string
  workspaceId?: string
  workspaceName?: string
  agentId?: string
  sessionId?: string
  navigationTarget?: NotificationNavigationTarget
  /**
   * The Extensions drawer row this news belongs to (`ExtensionsDrawerRowId`:
   * design, plugins, skills), when the emitter
   * knows. Absent, the row is read off `source` (`extensionsRowOfNotification`).
   * A string rather than the row type because this shape is shared with the
   * main process and persists to localStorage; unknown values fall back to the
   * source rule.
   */
  extensionsRow?: string
  /**
   * Set only on a capability module's `notify` row (source `module`): the
   * module that sent it, stamped by the host kernel from the module's scope —
   * never taken from the module — so the row can say who it is from and only
   * that module's action provider can add to it.
   */
  sourceModule?: { id: string; name: string }
  /**
   * The module door the row opens: one of `sourceModule`'s own global surfaces,
   * and optionally the view to land on. Opening refuses a surface another
   * module registered.
   */
  surfaceTarget?: { surfaceId: string; viewId?: string }
  /**
   * A message the person wrote that never reached its agent CLI, kept so the
   * row can give it back (Copy message). Only the undelivered-first-message
   * notice sets it, and that notice goes straight to the bell rather than
   * through the diagnostics log: the text lives in the bell's own stored list,
   * like every other row, and is never written to a log file.
   */
  returnedPrompt?: string
}

export type DiagnosticLogEntry = DiagnosticLogInput & {
  id: string
  timestamp: string
  logPath?: string
}

export type AppNotification = DiagnosticLogEntry & {
  read: boolean
}

type OpenFile = {
  path: string
  name: string
  content?: string
  language: string
  isDirty: boolean
}

export type EditorState = {
  openFiles: OpenFile[]
  activeFilePath: string | null
}

// What a folder IS, as declared through "Mark Directory As". Canonically defined here, beside the state that
// persists it, for the same reason BacklogView is: the node tsconfig project
// sees this module, and the renderer-only util that owns the behaviour
// (utils/folderRoles.ts, which re-exports this as FolderRole) it does not.
export type WorkspaceFolderRole = 'sources' | 'test-sources' | 'resources' | 'test-resources' | 'generated' | 'excluded'

export type WorkspaceFileExplorerState = {
  expandedPaths: string[]
  // Absolute folder path -> the role declared ON it. Descendants inherit and
  // are never stored, so this stays as small as the number of folders actually
  // marked — a handful, against a tree of thousands.
  folderRoles?: Record<string, WorkspaceFolderRole>
  // The file the user last clicked in the tree, restored as the highlighted row
  // after a reload/restart. Only the focused/lead path is persisted, never the
  // whole multi-select set. Best-effort: it highlights only when the row is
  // visible, which works because expandedPaths restores its ancestor folders.
  selectedPath?: string | null
}

// Backlog triage lens + sort. Canonically defined here (the shared workspace
// types module, also visible to the main/preload tsconfig project) so the
// persisted WorkspaceBacklogState can reference them without dragging the
// renderer-only triage util into the node project. `utils/backlogTriage.ts`
// re-exports these and owns their behavior (matchesBacklogView/compareBacklogItems).
export type BacklogView =
  'active' | 'all' | 'epics' | 'quick_wins' | 'strategic_bets' | 'defer' | 'unestimated' | 'completed' | 'archived'

// `dependency` is "Dependency order": a whole-list topological transform
// (prerequisites before dependents, unblocked frontier first) the panel applies
// via orderItemsByDependencies, branching around the pairwise compareBacklogItems
// the other sorts use.
export type BacklogSort =
  'best' | 'recent' | 'created' | 'status' | 'priority' | 'largest' | 'smallest' | 'dependency' | 'no_epic'

// Backlog grouping axis, orthogonal to view/sort. `none` is the flat list;
// `by_epic` renders collapsible epic headers with their children nested.
export type BacklogGroup = 'none' | 'by_epic'

// The Backlog panel's per-workspace navigation/view state, persisted so a
// reload/restart restores the item the user was reading plus the lens, sort, and
// search they left it in. Selection is keyed by project-root-relative
// `backlog/...` path (the durable identity) and resolved to the live scan's item
// id on restore — a deleted item degrades to no selection via the panel's
// existing scan-validity guard. The list/detail split is intentionally NOT
// persisted: it is derived from panel width by a ResizeObserver, not a user
// choice.
export type WorkspaceBacklogState = {
  selectedRelativePath: string | null
  view: BacklogView
  sort: BacklogSort
  group: BacklogGroup
  search: string
}

export type GitPanelView = 'changes' | 'worktrees' | 'log' | 'stashes' | 'terminal'

// The Git panel's per-workspace view state. Commit-message drafts are keyed by
// scope id (per worktree/main checkout) so a half-written message can never
// bleed across worktrees and is cleared once that scope commits.
export type WorkspaceGitPanelState = {
  activeView: GitPanelView
  activeScopeId: string
  commitDraftsByScopeId: Record<string, string>
}

// The workspace pane (browser-pane epic): the full-height tabbed column on the
// right that hosts a browser, terminals, Files, Git, Diff and the workspace's
// Backlog. Tabs are a plain per-workspace record rather than a FlexLayout
// tabset because the pane mixes kinds FlexLayout used to scatter across two
// exclusive rails.
export type WorkspacePaneTabKind =
  'browser' | 'terminal' | 'files' | 'diff' | 'git' | 'backlog' | 'canvas' | 'document' | 'agents' | 'library'

export type WorkspacePaneTab = {
  id: string
  kind: WorkspacePaneTabKind
  // A browser tab's page title or a terminal's pty title; absent, the tab
  // reads as its kind.
  title?: string
  // Browser only: the URL the tab is on, persisted so a restart reloads it.
  url?: string
  // Browser only: the page favicon as a data URL. Session-only — partialize
  // strips it; a favicon is fetched again on load.
  faviconUrl?: string
  // Terminal only: the pty id the tab owns; closing the tab kills it.
  terminalId?: string
  // Diff only: the repository the viewer reads, the file it opened on, and
  // which side. `repoRoot` is the opener's repository — the Git panel's active
  // scope, which is not always the workspace's own worktree — and the pane
  // honours it rather than re-deriving one; absent, the workspace's worktree
  // is the repository (a Diff tab opened from the pane's own + menu).
  diff?: {
    repoRoot?: string
    focusPath: string | null
    focusKind: 'staged' | 'unstaged' | null
    /** Filter the viewer to one changelist (an agent's is `changelistOwnerId`); absent = all. */
    changelistId?: string
    /**
     * An agent's reveal (editor.open_diff), session-only — the normalizer
     * drops these on restore. `reveal.key` is new per request, so the same
     * narrowing or range can be asked for twice.
     */
    reveal?: {
      key: string
      paths?: string[]
      step?: BranchStepSelection
      range?: EditorRange
      side?: 'modified' | 'original'
    }
    /**
     * Diff tours. `tour` is the tour the viewer has open and whether it was
     * playing, so switching tabs does not lose it; `tourOffer` is a tour an
     * agent has just written (`tour.create`) and the owner has not yet seen —
     * the tab's "tour ready" mark.
     */
    tour?: { id: string; playing: boolean }
    tourOffer?: string
    /**
     * The branch step the viewer has open, so switching to another pane tab
     * and back does not put it back on the whole branch; `afterReveal` is the
     * agent reveal it was chosen after, which a remount does not apply again.
     * Session-only, like `reveal`.
     */
    kept?: { step: BranchStepSelection; afterReveal: string | null }
  }
  // Canvas only: the board the tab is drawing on, project-relative and
  // normalized (`normalizeCanvasPath`). Absent is a real state, not a broken
  // one — that tab shows the board picker. A workspace holds at most one tab
  // per board, so this doubles as the tab's identity for the opener.
  canvas?: { path: string }
  // Document only: the markdown file the tab reads, absolute. Required — a
  // document tab is always opened ON something (a plan an agent proposed), so
  // the normalizer drops one without it. One tab per file, like Canvas.
  document?: { path: string }
  // Browser only: the device toolbar's viewport; absent means fill.
  viewport?: BrowserViewport
  // Browser and canvas only: where the floating player sits, in viewport pixels. Persisted
  // — the rect is the thing worth remembering across a restart. Keyed on the
  // TAB rather than the workspace so two agents floating previews do not fight
  // over one rectangle: a floating player is keyed per thread, and a tab is this
  // app's equivalent grain now that agents hold tabs of their own.
  float?: { x: number; y: number; width: number; height: number }
  // Browser and canvas only: whether the tab is floating right now. Session-only —
  // partialize strips it, because a cold start showing a collapsed pane and a
  // window floating over the workspace is a confusing first frame, and the
  // spec only promises the RECT across restarts.
  floating?: boolean
  // Shown in a window of its own: the id of the pop-out window holding it. The
  // pane keeps the tab in its strip and draws a placeholder where the body
  // would be; the pop-out window mounts the body instead. Session-only —
  // partialize strips it, because the window does not survive a restart and a
  // tab left marked would come back as a placeholder pointing at nothing.
  poppedOut?: string
}

export type WorkspacePaneState = {
  open: boolean
  activeTabId: string | null
  tabs: WorkspacePaneTab[]
  // The URLs this workspace's browser tabs visited last, newest first, for the
  // new-tab surface. Optional: records written before the browser child exist.
  recentUrls?: string[]
}

/**
 * Marks a standard workspace as living in a git worktree — set when a worktree
 * is opened as a workspace from the Worktree manager. The workspace's
 * `folderPath` already points at the worktree in this case, so this only carries
 * display info (branch/base) and flags the workspace as worktree-backed.
 * Normalized by `resolveWorkspaceWorktree` (utils/workspaceWorktree.ts).
 */
export type WorkspaceWorktree = {
  branch?: string
  baseRef?: string
  /**
   * The project this worktree was cut from — the folder header the workspace
   * files under in the sidebar, in the app's own spelling of that path rather
   * than git's realpath (a symlinked root would otherwise not string-match the
   * open parent workspace and would found a second header). Absent on rows
   * written before this field existed, where it is instead derived from the
   * container convention (`repoRootFromWorktreePath`).
   */
  repoRoot?: string
  /**
   * When the agent worktree cleanup gave this chat's worktree back: removed
   * from disk once the chat had settled and its work was merged and clean,
   * with its branch kept. Its absent folder is then expected rather than
   * broken, and opening the chat checks the worktree out again from that
   * branch at the same path (`utils/chatWorktreeRestore.ts`), which clears
   * this. Absent on every worktree still on disk.
   */
  reclaimedAt?: number
}

/**
 * Per-module workspace state, keyed by module id. The canonical home
 * for state a module keeps on a workspace: entries persist with the workspace
 * registry and ride workspace-sync exactly like sibling fields, and modules
 * reach their own entry through the SDK accessors
 * (`RendererHost.getWorkspaceModuleState` / `setWorkspaceModuleState`).
 */
export type WorkspaceModuleStateBag = Record<string, unknown>

export type WorkspaceRemoteOrigin = {
  // The paired machine (mesh connection id) the workspace was created on.
  connectionId: string
  machineName: string
  // The remote gateway's workspace: its id, display name, and folder there.
  workspaceId: string
  workspaceName: string
  workspaceRoot: string | null
  /**
   * The remote session this workspace's pane attaches to
   * (remote-band-in-the-sidebar): how the sidebar's Remote band knows that a
   * session the machine lists is THIS row, and focuses it rather than opening
   * a second attachment. Absent on rows born before the band existed, which
   * the band matches by the mesh pane still in their layout instead.
   */
  sessionId?: string
  /**
   * Where the chat runs there (checkout-and-branch-on-remote-create): the
   * remote workspace's own checkout, or a worktree the create minted, and
   * the branch either is on as of the create. The row's branch reads from
   * here — the local git poll has no path on this disk to ask. Absent on
   * rows born before the choice existed.
   */
  checkout?: {
    mode: 'current' | 'worktree'
    branch: string | null
    worktreePath: string | null
  } | null
  /**
   * Which repository the remote workspace is a clone of, as its machine's
   * `workspace.list` served it (one-project-across-machines). The sidebar
   * files the row under a local clone of the same repository when one is
   * open. Null when the remote had no identity to give.
   */
  repository?: import('../../../shared/repository-identity').RepositoryIdentity | null
}

/** Another machine a workspace lives on: today an SSH machine, by its saved id. */
export type WorkspaceEnvironmentRef = { kind: 'ssh'; id: string; label: string }

export type Workspace = {
  id: WorkspaceId
  name: string
  mode: WorkspaceMode
  folderPath: string | null
  folderMissing?: boolean
  // Where a remote-born workspace's code and agent actually live
  // (remote-sessions-ux / new-chat-on-a-remote-machine). Set once at creation
  // for a chat started on a paired machine; the sidebar groups and badges by
  // it, so the row keeps its provenance even after its mesh pane closes.
  // Absent for every local workspace — local is the unmarked default.
  remoteOrigin?: WorkspaceRemoteOrigin | null
  // The machine on this computer the workspace runs on (shared/execution-host):
  // absent or `local` is this machine; `wsl:<distro>` is a WSL distribution,
  // where its agents, terminals and git all run. Set when the workspace is
  // created and never changed after — a chat does not move machines.
  hostId?: import('../../../shared/execution-host').ExecutionHostId | null
  // The SSH machine the workspace is on (phase 8): its folder is that
  // machine's path, and its chats run on that machine's Studio server, reached
  // over the SSH connection the desktop holds. Absent for every workspace on
  // this computer. Set at creation and never changed, as `hostId` is.
  environment?: WorkspaceEnvironmentRef | null
  worktree?: WorkspaceWorktree | null
  // The scheduled agent whose run started this chat (shared/scheduled-agents).
  // Set once, by main, when a run's workspace is created, and never changed:
  // the chat is otherwise an ordinary chat, and this is how the sidebar marks
  // it, the schedule's editor lists it, and a run is kept from starting while
  // the one before it is still working. Absent on every chat a person or an
  // agent started, which is the unmarked default.
  scheduledAgentId?: string | null
  templateId: string
  layoutModel: IJsonModel
  agents: Record<AgentId, AgentState>
  worktreeState: WorkspaceWorktreeState
  memory: WorkspaceMemoryConfig
  editorState: EditorState
  fileExplorerState?: WorkspaceFileExplorerState
  backlogState?: WorkspaceBacklogState
  gitPanelState?: WorkspaceGitPanelState
  // The workspace pane's tabs (browser-pane epic); absent until first opened.
  paneState?: WorkspacePaneState
  // Per-module state bag — see WorkspaceModuleStateBag.
  moduleState?: WorkspaceModuleStateBag
  highlight?: WorkspaceHighlight
  createdAt: number
  lastTerminalActivityAt?: number | null
  // When the person last SENT A MESSAGE to an agent in this chat — the
  // `UserPromptSubmit` hook, mirrored off the session snapshots' `lastPrompt`
  // by WorkspaceManager. Monotonic like the clocks around it.
  //
  // This is the sidebar's ordering key (`workspaceLastUserMessageAt`), and the
  // reason it exists apart from `lastTerminalActivityAt`: that one moves on
  // every keystroke — an arrow key, a `y` at a permission prompt, a `git log`
  // in a plain shell — so the list reordered under the cursor of someone who
  // had not said anything. A submitted message is the one event a person
  // performs on purpose and expects to reorder their chats.
  //
  // Absent until the first prompt, and for a runtime whose reporter forwards
  // none (a plain shell, a hookless CLI) — for those rows the ordering key
  // falls back to `workspaceLastWorkedAt`, which is all that is knowable.
  lastUserMessageAt?: number | null
  // When an agent in this workspace last finished a turn (hook-reported Stop),
  // monotonic like `lastTerminalActivityAt`. The sidebar's idle time for a
  // parked chat with no live session, so it says when the agent finished
  // rather than when the person last typed — or nothing.
  lastTurnEndedAt?: number | null
  // When a person last had this chat on screen, on any device: a window here
  // that is focused and showing it, a phone, or another desktop following it
  // (those two through the `conversation.visit` tool). Monotonic like the clocks
  // above. A chat whose agent finished after this has a finish nobody has
  // seen yet, and every device reads its "finished, unseen" mark from that one
  // comparison, so reading a chat anywhere clears the mark everywhere. Absent
  // until the first visit after this was kept.
  lastVisitedAt?: number | null
  // When the visit clock was last moved back on purpose: Mark unread, on any
  // device (`conversation.mark_unread`), sets `lastVisitedAt` to just before
  // the chat's latest finish and stamps this beside it. It is the one way the
  // visit clock moves back: a patch may lower `lastVisitedAt` only together
  // with a newer stamp here (`applyWorkspaceFieldsPatch`), so a lagging
  // window's older reading still cannot. Monotonic itself.
  visitRewoundAt?: number | null
  // When set, the chat has come to rest: it renders as a compact row in its
  // folder's Settled shelf rather than in the active list. Set by the
  // sidebar's reconcile sweep after three idle days, or by hand from the row
  // menu; cleared by input into the chat, by the agent working or blocking
  // on input again, or by hand. Settling kills the chat's terminals (owner
  // ruling 2026-09-07) — the agent record, its CLI session id and the run
  // state are untouched, so opening the chat resumes it. See
  // `utils/workspaceSettle.ts`. The
  // retired `archivedAt` (the startup archive sweep, gone 2026-09-07) heals
  // into this on registry read.
  settledAt?: number | null
  // A hand decision about rest that outranks the sweep. `'settled'` is a
  // manual Settle; `'active'` is a manual Un-settle, which holds the row in
  // the active list until new input into it clears it — otherwise
  // the sweep would settle it straight back on its next tick. The sweep never
  // touches a row carrying either value.
  settledOverride?: 'settled' | 'active' | null
  // The person switched Auto-settle on for this chat from its menu: three
  // quiet days, or its pull requests landing, settles it without a hand
  // Settle. Absent or null is the default, auto-settle OFF — a chat only ever
  // leaves the list because someone asked it to.
  autoSettleEnabled?: boolean | null
  // Auto compact, from the chat's menu: Studio compacts the chat by itself
  // while it sits idle, just before its prompt cache expires. `true` or
  // `false` is the person's choice for this chat; absent or null follows the
  // app-wide default (Settings ▸ Settled chats, `autoCompactChats`), which is
  // off. Read in main (conversation-auto-compact.ts), never by a window.
  autoCompactEnabled?: boolean | null
  // When set, the chat is asleep until this instant: it renders in its folder's
  // Snoozed shelf rather than in the active list, wearing the countdown to its
  // wake. Set from the row menu's Snooze presets; cleared by opening the chat,
  // by Wake, and by settling.
  //
  // Snoozing SUSPENDS the chat's terminals, so a sleeping chat sits like every
  // other non-live chat — no agent process — and the wake returns the row with
  // them still paused; the person's first keystroke resumes the agent with
  // `--resume`. Suspend and not kill is the difference from `settledAt`, which
  // drops the ptys for good: a snoozed chat is coming back on a known clock.
  //
  // Nothing schedules that wake — a row is asleep while this stamp is in the
  // future and awake when it is not, so a wake missed while the app was closed
  // simply never happens. See `utils/workspaceSnooze.ts`.
  snoozedUntil?: number | null
  // True once this workspace's name is settled and auto-titling must never touch
  // it again. Set by the auto-title itself (a name derived from the first real
  // prompt), by a manual rename, and at creation for any workspace given an
  // explicit name (the wizard, a chained run).
  //
  // This is what makes the name stop moving: a second prompt, a second terminal,
  // or a resumed session all find the lock set and leave the name alone. Absent
  // on workspaces created before the field existed, which reads as unlocked —
  // correct, since those are sitting on a default "Chat 44" name.
  titleLocked?: boolean
  // The agent whose terminal was last selected in this workspace's layout
  // (agent changelists, Wave 4). It is the DEFAULT the Diff surfaces open on:
  // a Diff tab asked for with no file and no changelist shows that agent's
  // changelist, because "show me the diff" in a workspace where an agent has
  // been working means that agent's diff far more often than it means the
  // whole repository's.
  //
  // Only a default, and only when the list is really there: the helper that
  // reads it (`utils/diffChangelistDefault.ts`) checks the repository's lists
  // first, so an agent that exited and had its list reconciled away leaves the
  // Diff tab unfiltered rather than empty.
  //
  // Null once nothing qualifies; absent on every workspace written before the
  // field existed, which reads the same way. Persisted like its siblings — it
  // is a remembered choice, and forgetting it on every restart would make the
  // first Diff of a session the one that never obeys.
  lastActiveAgentId?: string | null
}
