import { moduleAssetUrl } from '../../../shared/modules/assets'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { RowBadge } from '../components/workspace/SidebarNavButton'

import type { ModuleEventEnvelope } from '../../../shared/modules/events'
import type { CapabilityManifest } from '../../../shared/modules/manifest'
import { COMMAND_REGISTRY } from '../commands/commandRegistry'
import { collapseDuplicateKeybindings } from '../commands/keybindings'
import type { CommandAvailability, CommandContribution, CommandScope, ModuleCommandContext } from '../commands/types'
import type { AppNotification, LayoutTemplate, Workspace } from '../types/workspace'
import type { BacklogItem, BacklogItemLink, BacklogItemStatus, BacklogResolvedLink } from '../utils/backlog'
import type { ModuleWorkspaceGitInfoResult, ModuleWorkspaceView } from '../../../shared/modules/workspace-view'
import { AGENT_RUNTIME_MODULE_ID } from '../../../shared/backlog/agent-links'
import type { WorkspaceFileWatcher, WorkspaceFileWatchEvent } from './workspace-file-watch'
import type { ColorSchemeWatcher, ModuleColorScheme } from './color-scheme-watch'
import type { WorkspaceListSource } from './workspace-list-watch'
import type { ModuleFocusTabInput, ModuleTabFocuser } from './workspace-tabs'
import type { WorkspaceRunGlyph, WorkspaceRunGlyphProviderInput } from '../utils/workspaceRunGlyph'
import { HOST_API_VERSION, hostSupports, type HostCapability } from '../../../shared/modules/host-api'
import type {
  ModuleChatRuntimeOption,
  ModuleOpenChatInput,
  ModuleOpenChatResult,
} from '../../../shared/modules/conversation-service'
import { getWorkspaceChatOpener } from './chat-opener'
import type {
  BacklogWatchError,
  BacklogWatchOptions,
  ModuleBacklogCreated,
  ModuleBacklogCreateInput,
  ModuleBacklogLinkInput,
  ModuleBacklogLocation,
  ModuleBacklogResult,
  ModuleBacklogTriageInput,
} from '../../../shared/modules/backlog-service'
import type { UsageQuery, UsageQueryResult } from '../../../shared/modules/activity-service'
import type { ModuleHostServiceName } from '../../../shared/modules/host-service-bridge'
import { publishSurfaceView } from '../components/workspace/surfaceView'

// Renderer-side host kernel. Mirrors the main-process MainHost: capability
// modules register their contributions (panels for now) into shared registries
// instead of the hardcoded factory switch + lazy-import block in
// WorkspaceLayout.tsx. Enablement is computed reactively from settings so a
// feature can be toggled without a reload.
//
// See docs/module-authors/drop-in-extensions.md.

export type WorkspacePanelProps = {
  workspaceId: string
}

// A panel may be an eager component or a React.lazy() wrapper; both render the
// same way in JSX, and lazy keeps a disabled feature's bundle off the wire.
export type WorkspacePanelComponent =
  ComponentType<WorkspacePanelProps> | LazyExoticComponent<ComponentType<WorkspacePanelProps>>

export type WorkspaceTypeIconComponent = ComponentType<{ className?: string }>

export type WorkspaceTypeTopBarView = {
  component: string
  name: string
}

export type WorkspaceTypeSupervisorScope = 'global' | 'all-windows'

export type WorkspaceTypeSupervisorComponent = ComponentType | LazyExoticComponent<ComponentType>

export type WorkspaceTypeSupervisor = {
  Component: WorkspaceTypeSupervisorComponent
  scope: WorkspaceTypeSupervisorScope
}

/** Confirm copy for a type-contributed sidebar row action. */
export type WorkspaceTypeRowActionConfirm = {
  title: string
  body: string
  confirmLabel: string
  cancelLabel?: string
}

/**
 * The workspace fields a type's sidebar status hooks may read. The shell
 * passes a richer row (agents, clocks) — this is the published identity plus
 * the module bag.
 */
export type WorkspaceTypeSidebarWorkspace = {
  id: string
  name: string
  mode: WorkspaceRunGlyphProviderInput['mode']
  moduleState?: Workspace['moduleState']
}

/**
 * Extra context-menu item on a sidebar row of this type. Gone with the
 * module; never a disabled core row. `confirm` opens the shell's confirm
 * modal before `run`.
 */
export type WorkspaceTypeRowAction = {
  id: string
  label: string
  variant?: 'danger'
  isVisible?: (workspace: WorkspaceTypeSidebarWorkspace) => boolean
  confirm?: (workspace: { name: string }) => WorkspaceTypeRowActionConfirm
  run: (workspaceId: string) => void | Promise<void>
}

// A module-owned config step in the workspace-creation hub. One step per type
// (v1): the hub renders it as the flow's one config page after the shared
// name/folder fields, holds the value shell-side for the pane's lifetime only,
// and hands it to createTemplate(context) on create — nothing is persisted by
// the shell. A throwing Component degrades to the type's zero-config flow
// (standard error surface), never a blocked hub.
export type WorkspaceCreationStepProps = {
  value: unknown
  setValue: (value: unknown) => void
}

export type WorkspaceCreationStepComponent =
  ComponentType<WorkspaceCreationStepProps> | LazyExoticComponent<ComponentType<WorkspaceCreationStepProps>>

export type WorkspaceTypeCreationStep = {
  id: string
  /** Page title in the hub pane. */
  heading: string
  /** One-line page subtitle. */
  description?: string
  Component: WorkspaceCreationStepComponent
  /** Gates the Create button; absent means the step never blocks creation. */
  isReady?: (value: unknown) => boolean
  /** Footer hint while isReady is false, e.g. "Name a city to forecast." */
  blockedHint?: string
}

/** Context handed to createTemplate on create. */
export type WorkspaceTypeCreateContext = {
  /** The module creation step's collected value; undefined without a step. */
  stepValue?: unknown
}

// What the hub hands a type's async create hook. `createTemplate` is
// synchronous by design — it answers "what layout?" — so a type whose creation
// is real orchestration (probe a source, materialize it on disk, roll back on
// failure) had nowhere to put that work and left the hub driving it through a
// hard-coded branch. This is the contribution point for it.
export type WorkspaceTypeCreateRequest = {
  /** The name field's value, untrimmed. Empty means the user named nothing. */
  name: string
  /** The materialized folder. The hub creates/opens it before calling. */
  folderPath: string
  /** The creation step's collected value; undefined without a step. */
  stepValue?: unknown
  /**
   * Write back into the creation step's value. The step is where a module
   * renders its own failure (it owns that page's body), and the step value is
   * the one piece of state the two halves share — so a hook that fails puts
   * the reason here rather than throwing prose at a shell error surface.
   */
  setStepValue: (value: unknown) => void
}

// The shell capabilities an async create hook may use. Deliberately two: mint
// this type's workspace, and take it back. Anything else the module wants it
// does through its own surfaces.
export type WorkspaceTypeCreateHost = {
  /**
   * Create the workspace from this type's `createTemplate` and return its id —
   * the same row the zero-config path would have made. `name` overrides the
   * request's (use it for the type's own fallback, e.g. "Review"); the step
   * value reaches `createTemplate` either way.
   */
  createWorkspace(input?: { name?: string }): string
  /** Remove a workspace this hook created. The rollback half of the pair. */
  removeWorkspace(workspaceId: string): void
}

export type WorkspaceTypeDefinition = {
  id: string
  label: string
  description: string
  icon: WorkspaceTypeIconComponent
  accentToken?: string
  searchTerms?: string[]
  createTemplate(context?: WorkspaceTypeCreateContext): LayoutTemplate
  /** Open this zero-config type once after its first enabled, trusted load. */
  openOnFirstLoad?: boolean
  /**
   * Own this type's create action. When present the hub calls this
   * instead of creating the workspace itself: resolve to mean "created, close
   * the hub"; reject to leave the hub open with the create still available.
   * Call `host.createWorkspace()` to mint the row (that is what runs
   * `createTemplate`) and `host.removeWorkspace(id)` to roll it back — a create
   * that fails after minting must not leave an empty workspace behind.
   * Absent ⇒ the hub creates from `createTemplate` directly, unchanged.
   */
  createWorkspace?(request: WorkspaceTypeCreateRequest, host: WorkspaceTypeCreateHost): Promise<void>
  topBarViews?: {
    label: string
    views: WorkspaceTypeTopBarView[]
  }
  deriveRunGlyph?(workspace: WorkspaceRunGlyphProviderInput): WorkspaceRunGlyph | null
  /**
   * Label for this type's create control (picker, hub). Absent ⇒ `label`.
   * When `createWorkspace` is present, that control runs the hook instead of
   * minting from `createTemplate`.
   */
  createLabel?: string
  /** Glyph beside the sidebar row title for workspaces of this type. */
  RowMark?: WorkspaceTypeIconComponent
  /** Extra context-menu items on this type's sidebar rows. */
  rowActions?: WorkspaceTypeRowAction[]
  supervisors?: WorkspaceTypeSupervisor[]
  /** The type's config step in the creation hub (one per type in v1). */
  creationStep?: WorkspaceTypeCreationStep
  creationStepsId?: string
  pickerOrder?: number
  /**
   * Keep the type registered (so its runtime workspaces still resolve, render,
   * and get created programmatically) but withhold it from the new-workspace
   * creation picker. For a runtime-only container the user never creates by
   * hand — one a module's own door creates instead. The picker analog of
   * `isHiddenFromRail`.
   */
  hiddenFromPicker?: boolean
  /**
   * Keep the type registered (so its runtime workspaces still resolve, render,
   * and get created programmatically) but withhold those workspaces from the
   * normal workspace rail — Projects list, keyboard switch targets, and
   * command-palette results. For a type whose own door surface took over
   * finding and steering the workspaces, so listing them again under one
   * project would claim they belong there. Hidden means hidden from
   * DISCOVERY: the workspace stays in the store, in window assignments, and
   * explicitly activatable. The rail analog of `hiddenFromPicker`.
   */
  hiddenFromRail?: boolean
}

export type RegisteredWorkspaceTypeDefinition = WorkspaceTypeDefinition & {
  moduleId: string
}

export type BacklogItemActionCategory = 'execute' | 'analyze' | 'transform' | 'publish' | 'review' | 'organize'

export type BacklogItemActionContext = {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItem
  readSource(): Promise<string>
  updateStatus(status: BacklogItemStatus): Promise<void>
  addLink(link: BacklogItemLink): Promise<void>
  updateModuleMetadata(moduleId: string, value: unknown): Promise<void>
  /**
   * Present when the context menu was opened on a multi-selection:
   * every selected item in list order — `item` is the anchor row and is always
   * one of them, and all of them are from the row's own project — plus that
   * project's full scanned item set for epic-membership expansion. Actions
   * that ignore this field keep their single-item behavior against `item`.
   */
  selection?: {
    items: ReadonlyArray<BacklogItem>
    projectItems: ReadonlyArray<BacklogItem>
  }
}

export type BacklogItemActionState = 'enabled' | 'disabled'

export type BacklogItemAction = {
  id: string
  label: string
  category: BacklogItemActionCategory
  /**
   * Position within the Backlog menus — the row's right-click menu and the
   * detail header's More-actions menu — sorted by `order` then label. It does
   * not earn a header button; those belong to the shell
   * (owner ruling 2026-09-15).
   */
  order?: number
  /** Selection-aware display label; falls back to `label` when absent. */
  getLabel?: (context: BacklogItemActionContext) => string
  isVisible?: (context: BacklogItemActionContext) => boolean
  getState?: (context: BacklogItemActionContext) => BacklogItemActionState
  run: (context: BacklogItemActionContext) => void | Promise<void>
}

export type RegisteredBacklogItemAction = BacklogItemAction & {
  moduleId: string
}

// Files-tree context-menu actions. Sibling of BacklogItemAction: the explorer
// renders enabled-module contributions under a heading named for the module,
// gone with it, never a disabled core row.
export type FileActionEntry = {
  name: string
  path: string
  isDir: boolean
  gitDeleted?: boolean
}

export type FileActionContext = {
  workspaceId: string
  workspaceRoot: string
  entries: readonly FileActionEntry[]
}

export type FileActionState = 'enabled' | 'disabled'

export type FileAction = {
  id: string
  label: string
  order?: number
  getLabel?: (context: FileActionContext) => string
  isVisible?: (context: FileActionContext) => boolean
  getState?: (context: FileActionContext) => FileActionState
  run: (context: FileActionContext) => void | Promise<void>
}

export type RegisteredFileAction = FileAction & {
  moduleId: string
}

export type BacklogLinkProviderInput = {
  workspaceId: string
  workspaceRoot: string
  item: BacklogItem
  link: BacklogItemLink
}

export type BacklogLinkProvider = {
  moduleId: string
  targetKinds: string[]
  resolveLinkStatus(input: BacklogLinkProviderInput): Promise<BacklogResolvedLink>
  openLink?(input: BacklogLinkProviderInput): Promise<void | boolean>
}

// A deep-link action a module contributes for its own notifications. Mirrors
// registerBacklogItemAction: the provider is keyed by the notification `source`
// it owns, enablement-gated, and returns serializable-data-driven actions. An
// action's run() composes shell capabilities (revealWorkspace) — the
// notification record itself never carries a callback (it persists to
// localStorage). The shell supplies a generic workspace-reveal fallback when no
// provider matches, so Open works for every workspace type; a provider only
// adds deeper focus on top.
export type NotificationActionContext = {
  notification: AppNotification
  /** Shell capability: switch the active workspace in the current window. */
  revealWorkspace(workspaceId: string): void
}

export type NotificationAction = {
  id: string
  label: string
  isVisible?(context: NotificationActionContext): boolean
  run(context: NotificationActionContext): void | Promise<void>
}

export type NotificationActionProvider = {
  /**
   * The notification source this provider owns — the emitter tag its module
   * writes. A module's own `notify` rows are keyed by its module id, so a
   * provider registered with `source: host.moduleId` adds actions to them; a
   * third-party module may register no other source.
   */
  source: string
  resolveActions(context: NotificationActionContext): NotificationAction[]
}

export type RegisteredNotificationActionProvider = NotificationActionProvider & {
  moduleId: string
}

// A command contributed by a module. Unlike shell CommandDefinitions, module
// commands carry their handler callback directly — handlerPath indirection is
// a shell-internal idiom. The registered command id is namespaced
// `<moduleId>.<id>`, so user keybinding overrides persist by full id and
// survive module disable/enable cycles (storage keeps them; consumers filter
// by enablement instead).
export type ModuleCommandDefinition = {
  /** Bare command id; the registered id becomes `<moduleId>.<id>`. */
  id: string
  title: string
  /** Grouping label in the palette and Shortcuts settings, e.g. the module's display name. */
  category: string
  /**
   * `panel:<moduleId>` gates on "a workspace whose mode belongs to my module
   * is active" — the shell derives it from the workspace-type registry.
   */
  scopes: readonly CommandScope[]
  defaultKeybindings?: readonly string[]
  /**
   * Either shell availability preconditions, or a predicate over the
   * published `ModuleCommandContext` view — the module path for "offer this
   * only when…" without growing the shell's availability enum per module.
   */
  availability?: readonly CommandAvailability[] | ((context: ModuleCommandContext) => boolean)
  allowInEditableTarget?: boolean
  /**
   * The handler. It receives the same `ModuleCommandContext` the availability
   * predicate was evaluated against, from the window the command ran in — so
   * "this workspace" is the one the person was looking at. A zero-argument
   * handler is still a valid one.
   */
  run: (context: ModuleCommandContext) => void | Promise<void>
}

export type RegisteredModuleCommand = CommandContribution & {
  moduleId: string
  run: (context: ModuleCommandContext) => void | Promise<void>
}

// A Settings overlay section contributed by a module. The host owns
// persistence: section values live in the module's `module:<id>` namespace
// inside the existing app-settings storage (never a new store or file), so
// they survive module disable/enable cycles and app restarts.
export type SettingsSectionProps = {
  values: Readonly<Record<string, unknown>>
  /** Persist one value in the module's namespace; `undefined` deletes the key. */
  setValue: (key: string, value: unknown) => void
}

export type SettingsSectionComponent =
  ComponentType<SettingsSectionProps> | LazyExoticComponent<ComponentType<SettingsSectionProps>>

// Brand constraint: icons follow the house glyph pattern (24×24 viewBox,
// fill="none", currentColor strokes). The Settings rail sizes and tints the
// glyph via className; a module must not bake in its own colors.
export type SettingsSectionIconComponent = ComponentType<{ className?: string }>

export type SettingsSectionDefinition = {
  id: string
  label: string
  /** One-line rail description; the overlay falls back to naming the owning module. */
  description?: string
  icon: SettingsSectionIconComponent
  /** Eager component or React.lazy() wrapper, mirroring WorkspacePanelComponent. */
  Component: SettingsSectionComponent
  /** Sort hint among contributed sections; built-in tabs always render first. */
  order?: number
}

export type RegisteredSettingsSection = SettingsSectionDefinition & {
  moduleId: string
}

// Read-only workspace snapshot for module code: the id → root/name/mode
// resolution both processes need for per-workspace persistence and scoped
// services. Deliberately a snapshot, not a subscription — live workspace state
// stays a separate surface. The declaration + mapping live in
// shared/modules/workspace-view so the renderer and main surfaces can't drift.
export type { ModuleWorkspaceView } from '../../../shared/modules/workspace-view'

// A module's own row component for its door. The sidebar's instance-level nav
// cluster these were first drawn in is gone (Extensions drawer ruling,
// 2026-09-05): a door is a row of the Extensions drawer now, so that is where
// a nav entry is drawn — AS its door's row, in place of the generic
// label-and-glyph one, when its id is the id of a global surface the same
// module registered (the door contract: entry id == surface id). An entry that
// names no surface of its module's is not drawn; there is no row for it to be.
// The component owns its full behaviour — an open action against the LOCAL
// window's store, its own reading of selected — and wears the `badge` the host
// derived for the row. Consumers filter by the owning module's enablement, so a
// module toggle adds/removes the row without a reload.
export type SidebarNavEntryRenderProps = {
  /** The sidebar is collapsed to the icon rail; render icon-only with a tooltip. */
  collapsed: boolean
  /**
   * The unread count the host has derived for this row (`useExtensionsRowBadges`),
   * or null for none. The host counts because the count spans things the
   * module cannot see — bell rows, the rail's sum — and a row that drew its
   * own would disagree with the square above it. The row wears it through
   * `SidebarNavButton`'s `badge`, in place of any status dot it would draw.
   */
  badge?: RowBadge | null
}

export type SidebarNavEntryComponent =
  ComponentType<SidebarNavEntryRenderProps> | LazyExoticComponent<ComponentType<SidebarNavEntryRenderProps>>

export type SidebarNavEntryDefinition = {
  /** The id of the global surface this row is the door of (`registerGlobalSurface`). */
  id: string
  /**
   * Sort key among nav entries; lower first, ties break on id. Installed doors
   * sit in the drawer in surface-id order after the product's own rows, so
   * this only orders entries against each other.
   */
  order: number
  /** The row. Rendered as its own element so it may use hooks and own its behavior. */
  Component: SidebarNavEntryComponent
}

export type RegisteredSidebarNavEntry = SidebarNavEntryDefinition & {
  moduleId: string
}

/**
 * A waiting-count a module contributes for a drawer / nav-entry row.
 * The shell's badge hook reads this instead of importing a module's run index;
 * the row is absent with the module, so a count with no row never appears.
 */
export type DoorBadgeContribution = {
  /**
   * The row that wears the count: a fixed Extensions drawer row id (`design`,
   * `plugins`, `skills`) for a bundled module, or — for an installed module —
   * the id of a global surface it registered. A surface with several `views`
   * wears it on its first row.
   */
  rowId: string
  /** Live items on this door waiting on the operator. Not a React hook. */
  getWaitingCount(): number
  subscribe(onChange: () => void): () => void
  /**
   * Notification source whose unnamed rows fall to this door. An emitter that
   * knows the row still sets `extensionsRow` on the notification itself.
   */
  notificationSource?: string
}

export type RegisteredDoorBadge = DoorBadgeContribution & {
  moduleId: string
}

// A control a module contributes to the app's top bar (the title-strip control
// cluster WorkspaceActions renders). Mirrors registerSidebarNavEntry: the item
// is a self-contained zero-prop component that owns its full behavior — state,
// tooltip, action — exactly like the shell's own top-bar controls; the host
// only owns placement + gating. Consumers filter by the owning module's
// enablement and sort by `order`, so a module toggle adds/removes its control
// live, without a reload, at a deterministic slot.
export type TopBarItemComponent = ComponentType | LazyExoticComponent<ComponentType>

export type TopBarItemDefinition = {
  id: string
  /**
   * Sort key among contributed top-bar items; lower renders first, ties break
   * on id. The shell's own controls are not part of this ordering — contributed
   * items render together in the bar's module slot (after Notifications).
   */
  order: number
  /** The control. Rendered as its own element so it may use hooks and own its behavior. */
  Component: TopBarItemComponent
}

export type RegisteredTopBarItem = TopBarItemDefinition & {
  moduleId: string
}

// The glyph a surface contributes for whatever chrome names it — an app-rail
// square, a drawer row, a view row. Sized by the shell through `className`.
export type SurfaceIconComponent = ComponentType<{ className?: string }>

// One drawer row of a surface that is several things to the person (Extensions
// drawer ruling, 2026-09-05). The agent-runtime module registers ONE
// `extensions` surface, but Plugins and Skills are two separate destinations
// to the operator and the ruling gives each its own row in the
// Extensions drawer. A view is that row: the module owns its name, its glyph
// and how the surface lands on it, so the shell never learns a module's
// internal sections — it only places the rows.
//
// A surface with no views contributes one row (its own label and glyph), which
// is every surface but Plugins today.
export type SurfaceViewDefinition = {
  /**
   * Unique within the surface. This is the id the surface publishes while it is
   * showing this view (`publishSurfaceView`), which is how the drawer knows
   * which of a surface's rows is the selected one.
   */
  id: string
  /** The row's label and accessible name. Non-empty; sentence case. */
  label: string
  /** The row's glyph; the shell sizes it via className. */
  Icon: SurfaceIconComponent
  /**
   * Land the surface on this view. Runs BEFORE the shell opens the surface, so
   * a deep-link latch dispatched here is drained by the surface as it mounts —
   * the order every other deep-link opener uses. This replaces `onOpen` for a
   * view row: a view IS a target, so there is no stale latch to discard.
   */
  open: () => void
}

// A door-routed full-page surface a module contributes (global-surfaces epic
// 1704). The companion to a sidebar nav door: the door calls
// `openGlobalSurface(id)` on the local window's store, and WorkspaceManager
// mounts the surface registered under that same id over the workspace card
// region (gated on the owning module's enablement). Splitting the surface
// component out of the shell is what lets the Automations/Reviews door tasks
// register their page without editing WorkspaceManager/WorkspaceSidebar. The
// component is zero-prop and owns its own data/state, exactly like a panel.
export type GlobalSurfaceComponent = ComponentType | LazyExoticComponent<ComponentType>

// The shell's own surface openers, behind a module's `openGlobalSurface` /
// `openModalSurface`: the same store actions a door or a pane row calls.
export type ModuleSurfaceOpener = {
  openGlobalSurface(id: string): void
  openModalSurface(id: string): void
}

// Where a door's own rail goes while the door is open (Extensions drawer
// ruling, 2026-09-05).
//
//   sidebar — the context-rail swap (item 1993): the door's rail REPLACES the
//             app sidebar's column for the length of the visit: for a door
//             whose rail is a list the person walks, and which is the
//             navigation while it is open.
//   inline  — the rail renders inside the card region beside the canvas, and
//             the sidebar column keeps whatever it was showing. This is what
//             the ruling means by "the drawer stays put": a door that IS a row
//             of the Extensions drawer must not take the drawer away, or the
//             one column of navigation would vanish the moment it was used.
export type SurfaceRailPlacement = 'sidebar' | 'inline'

export type GlobalSurfaceDefinition = {
  /** Matches the id the door opens via `openGlobalSurface`. Non-empty; unique. */
  id: string
  /**
   * User-facing name for the surface — the drawer/rail row's label, the door
   * bar's fallback title, and the absent-door explainer's heading. Decoupled
   * from the id ("Plugins" over id `extensions`). Optional: a door whose row is
   * its own `registerSidebarNavEntry` component names itself there,
   * and the shell falls back to the capitalised id. Non-empty when given.
   */
  label?: string
  /**
   * The glyph for chrome that names this surface — a drawer row, an app-rail
   * square. Optional for the same reason `label` is.
   */
  Icon?: SurfaceIconComponent
  /**
   * Called just before the shell opens this surface from a PLAIN opener (a rail
   * glyph, a drawer row) — one landing on the surface's default view. Discard
   * stale deep-link latches here: the Plugins surface drains a pending view
   * target on mount, so a latch left by a dispatch that never mounted would
   * otherwise reroute a plain open. Deep-link openers dispatch their own state
   * and bypass this.
   */
  onOpen?: () => void
  /**
   * The drawer rows this one surface offers, when it is more than one
   * destination to the person. Absent (the common case) means one row, named by
   * `label` and drawn with `Icon`.
   */
  views?: readonly SurfaceViewDefinition[]
  /** Where the door's rail goes. Defaults to `sidebar` — the swap every door did before the drawer ruling. */
  railPlacement?: SurfaceRailPlacement
  /** The full-page surface. Eager or React.lazy(), mirroring WorkspacePanelComponent. */
  Component: GlobalSurfaceComponent
}

export type RegisteredGlobalSurface = GlobalSurfaceDefinition & {
  moduleId: string
}

// A modal surface a module contributes (doors→modals, 2026-09-01). The modal
// counterpart to a door's nav-entry + global-surface pair: the surface mounts
// inside the shell's modal shell over whatever the window is showing, floating
// over the card region rather than routing it. The body is zero-prop and exits
// through SurfaceExitContext, exactly as it would through a door's back
// chevron.
//
// The registry STAYS, and it is deliberately no longer the main road (Extensions
// drawer ruling, 2026-09-05). Automations, Design and Plugins/Skills went back
// to being doors, so nothing the shell's own chrome offers is a modal
// any more; what is left here is Reviews, opened from the workspace pane strip
// because a walkthrough is Monaco beside a transcript and the pane column is too
// narrow to read it in. That is the shape a modal surface is FOR — a
// pick-and-close task floated over work that stays put — and a third-party
// module has the same need, so the extension point outlives the four surfaces
// that were pushed through it. Settings and the Diff popout are core and never
// register here; their ids are reserved below so a module cannot claim them.
//
// `views` is deliberately NOT offered here. A view is a row of the Extensions
// drawer, and the drawer is made of doors: a modal floats over the card region
// without routing it, so a drawer row that opened one would leave the drawer
// pointing at a surface the region does not hold.
// What a modal body is handed (2026-09-10). A modal floats over work that
// stays put, so "which work?" is the one piece of context the shell knows and
// the body cannot derive: `openModalSurface(id, { workspaceId })` records the
// workspace the opener acted from — the pane strip passes its own — and the
// mount forwards it here. Optional, because an opener that is not a
// workspace's (a command, a notification) records none; a zero-prop component
// still satisfies this type, so a body that does not care ignores it.
export type ModalSurfaceComponentProps = {
  workspaceId?: string
}

export type ModalSurfaceComponent =
  ComponentType<ModalSurfaceComponentProps> | LazyExoticComponent<ComponentType<ModalSurfaceComponentProps>>

// The pane-strip row a modal surface contributes (D7, 2026-09-10). A modal is
// opened from inside the content it floats over, and for a workspace-scoped
// task that content is the workspace pane: its "+" menu and its empty-state
// launcher list the kinds this workspace can open. Reviews was a hard-coded
// row there; this is the seam that replaces it, so an installed module puts
// its own row in the same list without editing the shell.
export type ModalSurfaceLauncher = {
  /** The row's name, e.g. "Reviews". Non-empty; sentence case. */
  label: string
  /**
   * The key that opens the row while the menu or the launcher has focus.
   * Exactly one character; uppercased by the host. A letter a static row (or
   * an earlier contributed one) already owns is dropped — the row keeps its
   * label and glyph and simply has no shortcut, because the shell's own kinds
   * must not lose their keys to an installed module.
   */
  letter: string
  /** The row's mark, in both the menu and the launcher card. */
  Glyph: SurfaceIconComponent
}

export type ModalSurfaceDefinition = {
  /** Matches the id opened via `openModalSurface`. Non-empty; unique. */
  id: string
  /**
   * Sort key among modal surfaces; lower first, ties break on id.
   *
   * Optional, because nothing renders a LIST of modal surfaces any more. It
   * ordered the trigger glyphs in the sidebar footer's settings cluster
   * (doors→modals, 2026-09-01); the Extensions drawer ruling (2026-09-05) sent
   * every destination the shell's chrome offers back to being a door and
   * retired the cluster, so a modal surface is now opened from inside the
   * content it floats over and orders nothing. Kept rather than deleted so a
   * module that declares it still compiles, and so the field is there if a
   * future surface lists these again.
   */
  order?: number
  /**
   * The surface's user-facing name — the dialog's accessible name and its bar
   * title, decoupled from the id. Non-empty; sentence case.
   */
  label: string
  /** A glyph for chrome that names this surface. Optional for the same reason `order` is: the pane launcher below carries its own. */
  Icon?: SurfaceIconComponent
  /**
   * Contribute this surface's row to the workspace pane's kind list (the "+"
   * menu and the empty-state launcher). Absent means the module opens the
   * modal from somewhere of its own instead.
   */
  launcher?: ModalSurfaceLauncher
  /**
   * Called just before the shell opens this modal from a plain opener. Discard
   * stale deep-link latches here, exactly as a door's `onOpen` does.
   */
  onOpen?: () => void
  /** The modal body. Eager or React.lazy(), mirroring GlobalSurfaceComponent. */
  Component: ModalSurfaceComponent
}

export type RegisteredModalSurface = ModalSurfaceDefinition & {
  moduleId: string
}

// One contributed pane row, resolved: the launcher plus the surface it opens
// and the module that owns it, so the pane can gate the row on enablement and
// route the pick back to `openModalSurface`.
export type RegisteredModalSurfaceLauncher = ModalSurfaceLauncher & {
  surfaceId: string
  moduleId: string
}

// Read access to the workspace's Backlog for module renderers. The kernel owns
// only the seam: the backlog module provides the implementation (shared scan +
// watcher), and the scoped host methods below route through it — the kernel
// never imports backlog internals.
export type BacklogReader = {
  list(workspaceId: string): Promise<BacklogItem[]>
  /**
   * Fires once with the current snapshot, then on every change; returns the
   * unsubscriber. `onError` hears each snapshot that could not be delivered.
   */
  watch(
    workspaceId: string,
    cb: (items: BacklogItem[]) => void,
    onError?: (error: BacklogWatchError) => void,
  ): () => void
}

// Backing store for the per-module workspace-state accessors. The
// kernel owns only the seam: modules/index.ts wires it over the workspace
// store's `Workspace.moduleState` bag, and the scoped host methods route
// through it with the owning module's id — the kernel never imports the store.
export type WorkspaceModuleStateStore = {
  get(workspaceId: string, moduleId: string): unknown
  /** False when the write was not stored (unknown workspace, reserved key). */
  set(workspaceId: string, moduleId: string, state: unknown): boolean
}

// Backing store for the app-level module-state accessors. Same seam
// shape as WorkspaceModuleStateStore, one scope up: modules/index.ts wires it
// over the app-settings `module:<id>` namespace that already backs contributed
// Settings sections, so a module's app-level state and its settings section
// share one keyspace and one persistence path.
export type ModuleAppStateStore = {
  /** The module's whole namespace; `{}` when it has never written. */
  get(moduleId: string): Readonly<Record<string, unknown>>
  /** False when the write was not stored (empty key, store not wired). */
  set(moduleId: string, key: string, value: unknown): boolean
  /** Fires whenever the module's namespace changes. Returns the unsubscriber. */
  subscribe(moduleId: string, cb: (values: Readonly<Record<string, unknown>>) => void): () => void
}

// Source of main→renderer module events. The kernel owns only the
// seam: modules/index.ts wires it over `window.api.onModuleEvent`, and the
// scoped host's `subscribe` filters the stream to the calling module's own
// events. One preload listener backs every module's subscriptions.
export type ModuleEventSource = (cb: (envelope: ModuleEventEnvelope) => void) => () => void

// ── Shell feedback, links and context for module code ──────────────────────

/** A toast's tone: the toast region's own vocabulary (components/ui/tokens `Tone`). */
export type ModuleToastTone = 'neutral' | 'accent' | 'good' | 'warn' | 'error'

/**
 * Transient feedback — the answer to "did it work?" after a command or a click
 * in a door. Rides the app's one toast region, under the module's name, and
 * leaves on its own (polite tones after 5 s, warn and error after 10 s,
 * held while hovered). Anything the person must be able to find again belongs
 * in the bell (`MainHost.notify`), not here.
 */
export type ModuleToastInput = {
  tone: ModuleToastTone
  /** One line, sentence case. Non-empty; clipped at 200 characters. */
  message: string
  /** An optional second line; clipped at 500 characters. */
  detail?: string
  /** At most one button. Pressing it runs `run` and dismisses the toast. */
  action?: { label: string; run: () => void | Promise<void> }
}

/** What the shell's toast region takes from a module toast; the module's name is stamped by the host. */
export type ModuleToastSink = (input: ModuleToastInput & { moduleId: string; moduleName: string }) => () => void

export type ModuleOpenExternalResult =
  { ok: true } | { ok: false; code: 'invalid_url' | 'unavailable' | 'failed'; message: string }

/** The shell's own external-link path (`window.api.openExternal`): the system browser, never this window. */
export type ModuleExternalLinkOpener = (url: string) => Promise<{ ok: true } | { ok: false; message: string }>

/** The workspace this window is showing, for `getActiveWorkspaceId` / `watchActiveWorkspace`. */
export type ActiveWorkspaceSource = {
  get(): string | null
  /** `onChange` may fire for unrelated writes; the kernel dedupes. Returns the unsubscriber. */
  subscribe(onChange: () => void): () => void
}

export type RendererHost = {
  /** The host API this app provides; see shared/modules/host-api.ts. */
  readonly hostApiVersion: number
  /**
   * This module's id: the one its manifest declares, which every scoped call
   * is stamped with — the prefix its `invoke` channels carry, the `source`
   * its notification rows are filed under.
   */
  readonly moduleId: string
  /** Whether this host provides `capability` now; false for names it does not know. */
  supports(capability: HostCapability): boolean
  /** Stable URL for a file packaged inside this trusted module. Relative HTML assets and workers retain this module origin. */
  getAssetUrl(relativePath: string): string
  registerPanel(componentId: string, component: WorkspacePanelComponent): void
  registerWorkspaceType(definition: WorkspaceTypeDefinition): void
  /** Create or focus a workspace of this module's zero-config type. */
  openWorkspace(typeId: string): Promise<string>
  registerBacklogItemAction(action: BacklogItemAction): void
  registerBacklogLinkProvider(provider: BacklogLinkProvider): void
  /**
   * Contribute a Files-tree context-menu action. The explorer renders
   * enabled-module contributions under a heading named for this module.
   * Duplicate ids throw. The row is absent when this module is off.
   */
  registerFileAction(action: FileAction): void
  registerNotificationActionProvider(provider: NotificationActionProvider): void
  registerCommand(definition: ModuleCommandDefinition): void
  registerSettingsSection(definition: SettingsSectionDefinition): void
  /**
   * Contribute this module's own row component for one of its doors: drawn in
   * the Extensions drawer AS the row of the global surface with the same id,
   * in place of the generic label-and-glyph row, and handed the row's `badge`.
   * An entry whose id names no global surface of this module's is not drawn.
   * Registered unconditionally at boot; the drawer filters by this module's
   * enablement, so a toggle shows/hides the row without a reload.
   */
  registerSidebarNavEntry(definition: SidebarNavEntryDefinition): void
  /**
   * Contribute the waiting-count a drawer row wears: `rowId` is the id of one
   * of this module's global surfaces (or a fixed drawer row, for a bundled
   * module). The shell merges it with the row's unread bell news — this
   * module's `notify` rows that name the door as their `target` — and the
   * app rail's Extensions square sums the rows. The contribution is gone with
   * the module, so a count with no row never appears. Duplicate `rowId` is a
   * registration error.
   */
  registerDoorBadge(contribution: DoorBadgeContribution): void
  /**
   * Contribute a control to the app's top bar (the title-strip control
   * cluster). Registered unconditionally at boot; the bar filters by this
   * module's enablement and orders by `order`, so a module toggle shows/hides
   * the control without a reload. Duplicate ids throw.
   */
  registerTopBarItem(definition: TopBarItemDefinition): void
  /**
   * Contribute a door-routed full-page surface (global-surfaces epic 1704),
   * mounted by WorkspaceManager over the workspace card region when a door
   * opens it via `openGlobalSurface(id)`. A `label` + `Icon` make it offerable
   * by the shell's own chrome (an Extensions drawer row, an app-rail square);
   * `views` splits it into several such rows; `railPlacement` says whether its
   * rail takes the sidebar column or renders beside its canvas. Registered
   * unconditionally at boot; the mount gates on this module's live enablement.
   * Duplicate ids throw, as does the reserved `extensions-home`.
   */
  registerGlobalSurface(definition: GlobalSurfaceDefinition): void
  /**
   * Contribute a modal surface: a body the shell mounts in its modal shell when
   * `openModalSurface(id)` opens it, floating over whatever owns the card
   * region. For a pick-and-close task over work that stays put — the shape
   * Reviews has; the product's own destinations are doors (Extensions drawer
   * ruling, 2026-09-05). Registered unconditionally at boot; the mount gates on
   * this module's enablement. Duplicate and reserved ids throw.
   *
   * `launcher` contributes the surface's row to the workspace pane's kind
   * list (the "+" menu and the empty-state launcher) — the trigger Reviews
   * had hard-coded there. A malformed launcher (empty label, a `letter` that
   * is not exactly one character, a missing Glyph) throws at registration.
   */
  registerModalSurface(definition: ModalSurfaceDefinition): void
  /**
   * Open one of THIS module's global surfaces, as if its door had been picked.
   * False for an id this module did not register, while the module is
   * disabled, or before the shell has wired its surface opener.
   */
  openGlobalSurface(id: string): boolean
  /**
   * Open one of THIS module's modal surfaces over whatever the window shows.
   * False for an id this module did not register, while the module is
   * disabled, or before the shell has wired its surface opener.
   */
  openModalSurface(id: string): boolean
  /**
   * Invoke an IPC channel this module's own `entry.main` registered via
   * `MainHost.registerIpc`. The channel must be `<moduleId>:`-prefixed —
   * validated here before any IPC, and again by the main-side dispatcher,
   * which requires the owning module to declare `module:bridge` (or the broad
   * `ipc:invoke` it was split out of).
   * A contract, not a security boundary.
   */
  invoke(channel: string, payload?: unknown): Promise<unknown>
  /** The workspace's Backlog items (read-only views; change them with the write methods below). Requires `backlog.read`. */
  listBacklogItems(workspaceId: string): Promise<BacklogItem[]>
  /**
   * Observe the workspace's Backlog: fires with the current snapshot, then on
   * change. `options.onError` hears why a snapshot could not be delivered; the
   * watch stays open. Requires `backlog.read`.
   */
  watchBacklogItems(workspaceId: string, cb: (items: BacklogItem[]) => void, options?: BacklogWatchOptions): () => void
  // ── Backlog writes and usage, through main's moduleId-first registries ──
  // (shared/modules/host-service-bridge.ts). Result-shaped, never a throw.
  getBacklogLocation(workspaceId: string): Promise<ModuleBacklogResult<{ location: ModuleBacklogLocation }>>
  createBacklogItem(
    workspaceId: string,
    input: ModuleBacklogCreateInput,
  ): Promise<ModuleBacklogResult<ModuleBacklogCreated>>
  updateBacklogStatus(workspaceId: string, itemId: string, status: BacklogItemStatus): Promise<ModuleBacklogResult>
  updateBacklogTriage(
    workspaceId: string,
    itemId: string,
    triage: ModuleBacklogTriageInput,
  ): Promise<ModuleBacklogResult>
  addBacklogLink(workspaceId: string, itemId: string, link: ModuleBacklogLinkInput): Promise<ModuleBacklogResult>
  updateBacklogModuleMetadata(workspaceId: string, itemId: string, value: unknown): Promise<ModuleBacklogResult>
  queryUsage(query: UsageQuery): Promise<UsageQueryResult>
  /**
   * Resolve a workspace id to its read-only view. Null means "not currently
   * resolvable" — an unknown id, or early boot before the shell wires the
   * resolver — never a throw and never a deletion signal.
   * Disclosure permission: `ipc:workspace-read`.
   */
  getWorkspace(workspaceId: string): Promise<ModuleWorkspaceView | null>
  /**
   * Every open workspace as a read-only view, in the order the shell lists
   * them. For a surface that is not mounted inside one workspace — a modal
   * floating over the window, a settings section — and so has no id to
   * resolve. Empty before the shell wires workspace state (early boot,
   * tests); never a throw.
   * Disclosure permission: `ipc:workspace-read`.
   */
  listWorkspaces(): Promise<ModuleWorkspaceView[]>
  /**
   * A workspace's checked-out branch (null when detached) and its remotes,
   * each with `owner/repo` when it is a GitHub repository — SSH host aliases
   * from ~/.ssh/config resolved. Read by git from the workspace's working
   * root, so a worktree reports its own branch and a submodule its own
   * remotes. The `entry.main` twin is `MainHost.getWorkspaceGitInfo`.
   * Requires `ipc:workspace-read` (checked: `permission_missing` without it).
   * Never throws.
   */
  getWorkspaceGitInfo(workspaceId: string): Promise<ModuleWorkspaceGitInfoResult>
  /**
   * Observe the open workspaces: `cb` fires once with the current list, then
   * on every change (deduped by value, so an unrelated store write does not
   * wake it). Returns the unsubscriber — call it on unmount. Before the shell
   * wires workspace state the first call reports an empty list.
   * Disclosure permission: `ipc:workspace-read`.
   */
  watchWorkspaces(cb: (workspaces: ModuleWorkspaceView[]) => void): () => void
  /**
   * Observe the app's resolved light/dark surface: `cb` fires immediately
   * with the current scheme, then whenever it changes — an explicit theme
   * switch, or an OS switch while the preference is `system`. Returns the
   * unsubscriber; call it on unmount. This is how a themed third-party
   * runtime a module hosts (Monaco, a chart library) stays in step with the
   * app; ordinary module UI should read the theme CSS variables instead.
   */
  watchColorScheme(cb: (scheme: ModuleColorScheme) => void): () => void
  /**
   * Your module's entry in the workspace's per-module state bag.
   * Scoped to the calling module — one module can never read another's entry
   * through this surface. `undefined` means no state is recorded for this
   * workspace, the workspace id is unknown, or the shell hasn't wired the
   * store yet (early boot, tests) — never a throw and never a deletion
   * signal; retry later instead of discarding state. Entries persist with the
   * workspace and sync across windows. Disclosure permission: `storage`.
   */
  getWorkspaceModuleState<T = unknown>(workspaceId: string): T | undefined
  /**
   * Replace your module's entry in the workspace's per-module state bag;
   * null/undefined removes it. Keep entries JSON-serializable — they persist
   * into the workspace registry verbatim. False means the write was NOT
   * stored (unknown workspace id, or the shell hasn't wired the store yet) —
   * surface it or retry; never assume success. Disclosure permission:
   * `storage`.
   */
  setWorkspaceModuleState(workspaceId: string, state: unknown): boolean
  /**
   * Read one key from your module's APP-level state — the scope
   * above `getWorkspaceModuleState`, for state that belongs to the module
   * rather than to any one workspace: remembered defaults, the last thing the
   * user opened. Synchronous and store-backed, so a renderer selector can
   * derive from it without an IPC round trip changing render timing.
   * `undefined` means the key has never been set (or the shell has not wired
   * the store yet, at early boot) — never a throw and never a deletion signal.
   * Scoped to the calling module: one module can never read another's.
   * Persists with app settings and survives a disable/enable cycle.
   * Disclosure permission: `storage`.
   */
  getModuleAppState<T = unknown>(key: string): T | undefined
  /**
   * Write one key in your module's app-level state; `undefined` deletes it.
   * Keep values JSON-serializable — they persist into app settings verbatim.
   * False means the write was NOT stored (empty key, or the shell has not
   * wired the store yet) — surface it or retry; never assume success.
   * Disclosure permission: `storage`.
   */
  setModuleAppState(key: string, value: unknown): boolean
  /**
   * Observe your module's app-level state: `cb` fires with the current values
   * on every change (not on subscribe — read the current value with
   * `getModuleAppState`). Returns the unsubscriber; call it on unmount. Pair
   * the two with `useSyncExternalStore` for a reactive read.
   */
  watchModuleAppState(cb: (values: Readonly<Record<string, unknown>>) => void): () => void
  /**
   * Subscribe to events your module's `entry.main` pushed with
   * `MainHost.emit` — the subscribe verb `invoke` does not have.
   * Scoped to your module: another module's events never reach you, and yours
   * never reach it. `cb` receives the emitted payload. Returns the
   * unsubscriber; call it on unmount. Nothing is replayed, so a subscriber
   * must be correct having missed every event emitted before it subscribed —
   * read current state through an invoke and let events keep it fresh. See the
   * delivery contract in shared/modules/events.ts.
   */
  subscribe(topic: string, cb: (payload: unknown) => void): () => void
  /**
   * The workspace's *effective working root*: where its live work happens.
   * `ModuleWorkspaceView.folderPath` deliberately reports the durable primary
   * checkout; a worktree-backed workspace does live work under a
   * worktree, and this resolves that root. The live-runtime methods below
   * (`watchWorkspaceFile`, `focusTab`) resolve workspace-relative
   * paths against it. Null means "not currently resolvable" — never a throw.
   * Disclosure permission: `ipc:workspace-read`.
   */
  getWorkingRoot(workspaceId: string): Promise<string | null>
  /**
   * Watch one workspace-relative file (resolved against the effective working
   * root): the callback fires once with the current content (null when the
   * file doesn't exist), then debounced on every change. Rejects with a named
   * cause for absolute/escaping paths, unknown/folderless workspaces, an
   * unwired backend (early boot, tests), or a disabled Agent Runtime module.
   * Resolve the returned closure's promise, keep it, and call it on unmount.
   * Disclosure permission: `filesystem:read-workspace`.
   */
  watchWorkspaceFile(
    workspaceId: string,
    relativePath: string,
    cb: (event: WorkspaceFileWatchEvent) => void,
  ): Promise<() => void>
  /**
   * Focus a workspace tab: a chat by its agent id (its tab added if missing)
   * or a file tab by workspace-relative path. False when there is no such chat
   * or the file is not focusable. Throws with a named cause when agent runtime
   * is unavailable.
   */
  focusTab(input: ModuleFocusTabInput): boolean
  /**
   * Open a chat in a workspace and focus it; the prompt lands as a draft
   * unless `send: true`. `name` titles it, and `dedupeKey` focuses the chat
   * this module opened under that key instead of opening another. Answers
   * `unavailable` until the shell registers its opener (see chat-opener.ts).
   * A draft requires `chat:draft` or `conversation:operate`; `send: true`
   * requires `conversation:operate`.
   */
  openChat(input: ModuleOpenChatInput): Promise<ModuleOpenChatResult>
  /**
   * The agent runtimes a chat can run on, from the catalog the shell's own
   * chat picker reads, with the user's last choice marked. Empty before the
   * shell wires the catalog.
   */
  listChatRuntimes(): ModuleChatRuntimeOption[]
  /**
   * Show a toast: transient feedback in the app's toast region, under this
   * module's name. Returns its dismisser. An empty message or an unknown tone
   * throws; while this module is disabled, or before the window has wired its
   * toast region (`supports('toast')`), nothing shows and the dismisser is a
   * no-op.
   */
  toast(input: ModuleToastInput): () => void
  /**
   * The workspace this window is showing, or null — none is open, or a door
   * holds the card region with no workspace behind it. Null before the shell
   * wires workspace state.
   */
  getActiveWorkspaceId(): string | null
  /**
   * Observe the workspace this window is showing: `cb` fires once with the
   * current id, then whenever it changes (deduped). Returns the unsubscriber;
   * call it on unmount.
   */
  watchActiveWorkspace(cb: (workspaceId: string | null) => void): () => void
  /**
   * Say which of this module's surface `views` the surface is showing, so
   * exactly that drawer row reads selected — including after the person moved
   * with the surface's own rail. `null` says it shows none (call it as the
   * surface unmounts). False for a surface this module did not register, a
   * view id the surface does not declare, or while the module is disabled.
   */
  setSurfaceView(surfaceId: string, viewId: string | null): boolean
  /**
   * Open an http(s) URL in the system browser, through the app's own
   * external-link path — never in this window. Anything else is refused as
   * `invalid_url` before it leaves the renderer; `unavailable` while this
   * module is disabled or before the window has wired its link opener.
   */
  openExternal(url: string): Promise<ModuleOpenExternalResult>
}

// What a bundled module's renderer half receives: the published surface plus
// the seams only first-party modules fill. A third-party module is handed the
// same object typed as `RendererHost`, and every member here refuses it at
// runtime too — the type is a convenience, the check is the rule.
export type InternalRendererHost = RendererHost & {
  /**
   * Provide the Backlog read implementation. The backlog module's alone — any
   * other caller throws — and a single slot.
   */
  provideBacklogReader(reader: BacklogReader): void
}

// The kernel owns the registries and is consumed by the factory/rail. Modules
// register through a scoped `hostFor(moduleId)` (mirroring the main-process
// MainKernel) so each panel records its owning module — that's what lets the
// factory gate a host panel by its module's enablement without a per-feature
// switch arm.
export type RendererKernel = {
  /**
   * `manifest` carries the permissions `openChat` checks; a host made without
   * one has declared nothing.
   */
  hostFor(moduleId: string, manifest?: CapabilityManifest): InternalRendererHost
  getPanel(componentId: string): WorkspacePanelComponent | undefined
  /** The capability module that registered the panel, for enablement gating. */
  getPanelModule(componentId: string): string | undefined
  getWorkspaceType(id: string): RegisteredWorkspaceTypeDefinition | undefined
  getWorkspaceTypes(moduleEnabled?: (moduleId: string) => boolean): RegisteredWorkspaceTypeDefinition[]
  getWorkspaceTypeModule(id: string): string | undefined
  getBacklogItemActions(): RegisteredBacklogItemAction[]
  getFileActions(): RegisteredFileAction[]
  getBacklogLinkProviders(moduleEnabled?: (moduleId: string) => boolean): BacklogLinkProvider[]
  getNotificationActionProviders(moduleEnabled?: (moduleId: string) => boolean): RegisteredNotificationActionProvider[]
  getModuleCommand(commandId: string): RegisteredModuleCommand | undefined
  getModuleCommands(moduleEnabled?: (moduleId: string) => boolean): RegisteredModuleCommand[]
  /**
   * The one merge point for the command pipeline: the static shell registry
   * followed by enabled module commands. The palette, the keyboard dispatcher,
   * and the Shortcuts settings tab all consume this so a module toggle removes
   * (and re-enabling restores) a command everywhere at once, without a reload.
   * Shell commands come first, so on a duplicate binding at equal scope
   * specificity the dispatcher keeps firing the built-in.
   */
  getCommandContributions(moduleEnabled?: (moduleId: string) => boolean): CommandContribution[]
  /**
   * Contributed Settings sections for enabled modules, in stable order
   * (order hint, then id) regardless of registration order, so the rail reads
   * the same across reloads. The overlay renders these after built-in tabs.
   */
  getSettingsSections(moduleEnabled?: (moduleId: string) => boolean): RegisteredSettingsSection[]
  /**
   * Contributed sidebar nav doors for enabled modules, sorted by `order` then
   * id so the top-nav cluster reads the same across reloads. The sidebar merges
   * these with its own built-in doors (Create/Automations/Connectors),
   * which carry their own `order`, into one deterministic band.
   */
  getSidebarNavEntries(moduleEnabled?: (moduleId: string) => boolean): RegisteredSidebarNavEntry[]
  /**
   * Door / nav-entry waiting-count contributions for enabled modules, in
   * registration order. The badge hook reads these instead of a module's run
   * index.
   */
  getDoorBadges(moduleEnabled?: (moduleId: string) => boolean): RegisteredDoorBadge[]
  /**
   * Contributed top-bar controls for enabled modules, sorted by `order` then
   * id so the bar reads the same across reloads. WorkspaceActions renders
   * these in the bar's module slot, so a module toggle adds/removes a control
   * without a reload.
   */
  getTopBarItems(moduleEnabled?: (moduleId: string) => boolean): RegisteredTopBarItem[]
  /**
   * The full-page surface registered under `id`, with its owning module — so
   * WorkspaceManager can gate the mount on that module's enablement. Undefined
   * when no surface (or a disabled/absent module's surface) claims the id.
   */
  getGlobalSurface(id: string): RegisteredGlobalSurface | undefined
  /**
   * All contributed full-page surfaces for enabled modules, in stable order
   * (id) regardless of registration order. The mount resolves a single surface
   * by id; this listing exists for parity with the other registries.
   */
  getGlobalSurfaces(moduleEnabled?: (moduleId: string) => boolean): RegisteredGlobalSurface[]
  /**
   * The modal surface registered under `id`, with its owning module — so the
   * modal mount can gate on that module's enablement. Undefined when no
   * surface claims the id.
   */
  getModalSurface(id: string): RegisteredModalSurface | undefined
  /**
   * Contributed modal surfaces for enabled modules, sorted by `order` then id
   * so the settings-cluster trigger glyphs read the same across reloads.
   */
  getModalSurfaces(moduleEnabled?: (moduleId: string) => boolean): RegisteredModalSurface[]
  /**
   * The pane rows contributed by modal surfaces that declare a `launcher`, in
   * the same stable order as `getModalSurfaces`. The workspace pane composes
   * these after its own static kinds (composePaneKinds), so a module's row
   * lands in the "+" menu and the empty-state launcher without the shell
   * knowing what it is.
   */
  getModalSurfaceLaunchers(moduleEnabled?: (moduleId: string) => boolean): RegisteredModalSurfaceLauncher[]
  /**
   * Enablement source for host methods that must gate on a module's live
   * enablement without a caller-supplied predicate (the Backlog read API).
   * Wired once at boot by modules/index.ts from the workspace store; absent
   * (early boot, tests) the reader's owning module is treated as enabled.
   */
  setModuleEnablementResolver(resolver: (moduleId: string) => boolean): void
  /**
   * Read that same resolver, for the few shell helpers that need "is this
   * module on?" but must not import the workspace store — importing it from a
   * module the store's own slices reach would close a cycle. Absent a resolver
   * (early boot, tests) every module reads as enabled, matching the
   * `!moduleEnabled ||` rule every registry lookup already applies.
   */
  isModuleEnabled(moduleId: string): boolean
  /**
   * Workspace-view source for `RendererHost.getWorkspace`. Wired once at boot
   * by modules/index.ts from the workspace store; absent (early boot, tests)
   * every lookup resolves to null.
   */
  setWorkspaceResolver(resolver: (workspaceId: string) => ModuleWorkspaceView | null): void
  setModuleAssetOrigin(moduleId: string, origin: string): void
  setWorkspaceOpener(opener: (typeId: string) => Promise<string>): void
  /**
   * Surface backend for `RendererHost.openGlobalSurface` / `openModalSurface`.
   * Wired once at boot by modules/index.ts over the workspace store's own
   * openers; absent (early boot, tests) both answer false.
   */
  setSurfaceOpener(opener: ModuleSurfaceOpener): void
  /**
   * Backing store for the per-module workspace-state accessors.
   * Wired once at boot by modules/index.ts over the workspace store's bag;
   * absent (early boot, tests) reads resolve undefined and writes report
   * false. The kernel scopes every call by the owning module's id.
   */
  setWorkspaceModuleStateStore(store: WorkspaceModuleStateStore): void
  /**
   * Backing store for the app-level module-state accessors. Wired
   * once at boot by modules/index.ts over the app-settings `module:<id>`
   * namespace; until it lands reads resolve undefined and writes report false.
   * A watch registered before it lands is held by the kernel and attaches here,
   * because modules register synchronously at import and this wiring is a
   * microtask later. The kernel scopes every call by the owning module's id.
   */
  setModuleAppStateStore(store: ModuleAppStateStore): void
  /**
   * Source for `RendererHost.subscribe`. Wired once at boot by modules/index.ts
   * over `window.api.onModuleEvent`. The kernel owns the subscriber set, so ONE
   * listener on this source backs every module's subscriptions and a subscribe
   * made before the source lands still receives once it does — module code
   * never has to guard the wiring window. Absent (tests, windowless bundles)
   * nothing is delivered, which is indistinguishable from nothing being emitted.
   */
  setModuleEventSource(source: ModuleEventSource): void
  /**
   * Working-root source for `RendererHost.getWorkingRoot`. Wired once at boot
   * by modules/index.ts (store + worktree resolution); absent (early boot,
   * tests) every lookup resolves to null.
   */
  setWorkingRootResolver(resolver: (workspaceId: string) => string | null): void
  /**
   * File-watch backend for `RendererHost.watchWorkspaceFile`. Wired once at
   * boot by modules/index.ts over the shell's fs watch plumbing; absent
   * (tests, early boot) the host method rejects with a named cause.
   */
  setWorkspaceFileWatcher(watcher: WorkspaceFileWatcher): void
  /**
   * Workspace-list source for `RendererHost.listWorkspaces` /
   * `watchWorkspaces`. Wired once at boot by modules/index.ts over the
   * workspace store; absent (early boot, tests) the list reads empty.
   */
  setWorkspaceListSource(source: WorkspaceListSource): void
  /**
   * Colour-scheme source for `RendererHost.watchColorScheme`. Wired once at
   * boot by modules/index.ts over the same appearance preference +
   * media-query pair `useResolvedColorScheme` reads; absent (early boot,
   * tests) a watch reports 'dark' once and never fires again.
   */
  setColorSchemeWatcher(watcher: ColorSchemeWatcher): void
  /**
   * Tab-focus backend for `RendererHost.focusTab`. Wired once at boot by
   * modules/index.ts over the workspace store and the layout tab helpers.
   */
  setTabFocuser(focuser: ModuleTabFocuser): void
  /**
   * Catalog source for `RendererHost.listChatRuntimes`. Wired once at boot by
   * modules/index.ts over the availability-filtered CLI catalog; absent (early
   * boot, tests) the list reads empty.
   */
  setChatRuntimeSource(source: () => ModuleChatRuntimeOption[]): void
  /**
   * Source for `RendererHost.getWorkspaceGitInfo`. Wired once at boot by
   * modules/index.ts (store working root + the shell's git read over IPC);
   * absent (early boot, tests) every read answers `unavailable`.
   */
  setWorkspaceGitInfoSource(source: (workspaceId: string) => Promise<ModuleWorkspaceGitInfoResult>): void
  /**
   * This window files module notifications into its bell (modules/index.ts
   * wires the push channel). What `RendererHost.supports('notifications')`
   * answers.
   */
  setModuleNotificationsWired(wired: boolean): void
  /**
   * The toast region behind `RendererHost.toast`, set by the window's toast
   * host while it is mounted and cleared (null) when it unmounts. Absent,
   * `supports('toast')` is false and a toast shows nothing.
   */
  setToastSink(sink: ModuleToastSink | null): void
  /** The link path behind `RendererHost.openExternal`. Absent, it answers `unavailable`. */
  setExternalLinkOpener(opener: ModuleExternalLinkOpener): void
  /** Source for `RendererHost.getActiveWorkspaceId` / `watchActiveWorkspace`. Absent, both read null. */
  setActiveWorkspaceSource(source: ActiveWorkspaceSource): void
  /**
   * A module notification row's Open: the opener for `target` when it names
   * one of `moduleId`'s own global surfaces (and, given, one of its views) and
   * the module is enabled; null otherwise — a row can never open another
   * module's door. Runs the view's `open` (or the surface's `onOpen`) first,
   * the order every deep-link opener uses.
   */
  moduleSurfaceTargetOpener(moduleId: string, target: { surfaceId: string; viewId?: string }): (() => void) | null
}

const MAX_TOAST_MESSAGE_LENGTH = 200
const MAX_TOAST_DETAIL_LENGTH = 500
const TOAST_TONES: ReadonlySet<string> = new Set<ModuleToastTone>(['neutral', 'accent', 'good', 'warn', 'error'])

// What `openExternal` takes: an absolute http(s) URL and nothing else, checked
// before it leaves the renderer (main's own check stays the last word).
function externalHttpUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url.trim().length === 0) return null
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.username || parsed.password) return null
    return parsed.toString()
  } catch {
    return null
  }
}

const SHELL_COMMAND_IDS: ReadonlySet<string> = new Set(COMMAND_REGISTRY.map((command) => command.id))

// Validate a surface's drawer rows, and return them with their ids NORMALISED.
// A view id is what the surface publishes to say which of its rows is showing,
// so the registry and the drawer must agree on it character for character: a
// duplicate or blank id would light two rows at once (or none), and an id that
// validated trimmed but was STORED untrimmed (`" plugins "`) passed here and
// then never matched the drawer's lookup — a row that could not be selected,
// with nothing to explain why. Failing loudly at registration is the whole
// point of this pass, so the stored id is the one that was checked.
function normalizeSurfaceViews(
  kind: string,
  surfaceId: string,
  views: readonly SurfaceViewDefinition[] | undefined,
): readonly SurfaceViewDefinition[] | undefined {
  if (!views) return undefined
  const seen = new Set<string>()
  return views.map((view) => {
    const id = view.id.trim()
    if (id.length === 0) {
      throw new Error(`${kind} "${surfaceId}" has a view with an empty id.`)
    }
    if (view.label.trim().length === 0) {
      throw new Error(`${kind} view "${surfaceId}/${id}" must have a non-empty label.`)
    }
    if (seen.has(id)) {
      throw new Error(`${kind} "${surfaceId}" registers view "${id}" twice.`)
    }
    seen.add(id)
    return { ...view, id }
  })
}

export function createRendererHost(): RendererKernel {
  const panels = new Map<string, WorkspacePanelComponent>()
  const panelModules = new Map<string, string>()
  const workspaceTypes = new Map<string, RegisteredWorkspaceTypeDefinition>()
  const backlogItemActions = new Map<string, RegisteredBacklogItemAction>()
  const fileActions = new Map<string, RegisteredFileAction>()
  const backlogLinkProviders = new Map<string, BacklogLinkProvider>()
  const notificationActionProviders = new Map<string, RegisteredNotificationActionProvider>()
  const moduleCommands = new Map<string, RegisteredModuleCommand>()
  const settingsSections = new Map<string, RegisteredSettingsSection>()
  const sidebarNavEntries = new Map<string, RegisteredSidebarNavEntry>()
  const doorBadges = new Map<string, RegisteredDoorBadge>()
  const topBarItems = new Map<string, RegisteredTopBarItem>()
  const globalSurfaces = new Map<string, RegisteredGlobalSurface>()
  const modalSurfaces = new Map<string, RegisteredModalSurface>()
  let backlogReader: { moduleId: string; reader: BacklogReader } | null = null
  const moduleAssetOrigins = new Map<string, string>()
  let moduleEnabledResolver: ((moduleId: string) => boolean) | null = null
  let workspaceResolver: ((workspaceId: string) => ModuleWorkspaceView | null) | null = null
  let workspaceOpener: ((typeId: string) => Promise<string>) | null = null
  let surfaceOpener: ModuleSurfaceOpener | null = null
  let workspaceModuleStateStore: WorkspaceModuleStateStore | null = null
  let moduleAppStateStore: ModuleAppStateStore | null = null
  // Both backings are wired a microtask after boot, but modules register
  // synchronously at import — so a module that subscribes inside
  // `registerRenderer` would silently get a dead subscription. The kernel owns
  // the subscriber sets instead and attaches to each backing when it lands, so
  // an early subscribe survives the wiring window. The event set also means ONE
  // source listener backs every module's subscriptions, however many there are.
  type ModuleEventSubscriber = { moduleId: string; topic: string; cb: (payload: unknown) => void }
  const moduleEventSubscribers = new Set<ModuleEventSubscriber>()
  let detachModuleEventSource: (() => void) | null = null
  type ModuleAppStateWatcher = {
    moduleId: string
    cb: (values: Readonly<Record<string, unknown>>) => void
    detach?: () => void
  }
  const moduleAppStateWatchers = new Set<ModuleAppStateWatcher>()

  const dispatchModuleEvent = (envelope: ModuleEventEnvelope): void => {
    for (const subscriber of [...moduleEventSubscribers]) {
      if (envelope.sourceModuleId !== subscriber.moduleId || envelope.topic !== subscriber.topic) continue
      // Live gate on every delivery, not just at subscribe (the Backlog watcher
      // pattern): a subscription stops receiving the moment the user disables
      // the owning module, and resumes on re-enable.
      if (moduleEnabledResolver && !moduleEnabledResolver(subscriber.moduleId)) continue
      try {
        subscriber.cb(envelope.payload)
      } catch (error) {
        // A throwing subscriber must not break the shared dispatch loop for
        // every other module on the one source listener.
        console.error(`[modules] event subscriber from module "${subscriber.moduleId}" threw:`, error)
      }
    }
  }

  const attachModuleAppStateWatcher = (watcher: ModuleAppStateWatcher): void => {
    if (!moduleAppStateStore || watcher.detach) return
    watcher.detach = moduleAppStateStore.subscribe(watcher.moduleId, watcher.cb)
  }
  let workingRootResolver: ((workspaceId: string) => string | null) | null = null
  let workspaceFileWatcher: WorkspaceFileWatcher | null = null
  let tabFocuser: ModuleTabFocuser | null = null
  let chatRuntimeSource: (() => ModuleChatRuntimeOption[]) | null = null
  let workspaceGitInfoSource: ((workspaceId: string) => Promise<ModuleWorkspaceGitInfoResult>) | null = null
  let workspaceListSource: WorkspaceListSource | null = null
  let colorSchemeWatcher: ColorSchemeWatcher | null = null
  let moduleNotificationsWired = false
  let toastSink: ModuleToastSink | null = null
  let externalLinkOpener: ModuleExternalLinkOpener | null = null
  let activeWorkspaceSource: ActiveWorkspaceSource | null = null
  const moduleIsDisabled = (moduleId: string): boolean =>
    moduleEnabledResolver !== null && !moduleEnabledResolver(moduleId)
  const agentRuntimeDisabled = (): boolean =>
    moduleEnabledResolver !== null && !moduleEnabledResolver(AGENT_RUNTIME_MODULE_ID)
  // Shared gate for the live-runtime methods: the error names the
  // actual cause so a module author can tell "the shell has not wired this
  // backend yet" (early boot, tests) from "the user turned the Agent Runtime
  // module off". Before the enablement resolver lands the module is treated
  // as enabled, matching the Backlog gate's boot window.
  const requireAgentRuntime = <T>(backend: T | null, surface: string): T => {
    if (agentRuntimeDisabled()) {
      throw new Error(`${surface} is not available — the Agent Runtime module is disabled.`)
    }
    if (!backend) {
      throw new Error(`${surface} is not available — the shell has not wired the agent-runtime backend.`)
    }
    return backend
  }
  // Shared gate for the Backlog read methods: the error names the actual cause
  // so a module author can tell "nothing provides this" from "the user turned
  // the backlog module off".
  const requireBacklogReader = (): BacklogReader => {
    if (!backlogReader) {
      throw new Error('No Backlog reader is registered — the backlog module did not load.')
    }
    if (moduleEnabledResolver && !moduleEnabledResolver(backlogReader.moduleId)) {
      throw new Error('The Backlog module is disabled.')
    }
    return backlogReader.reader
  }
  // The Backlog reads are checked against the declared `backlog.read` for a
  // third-party module. A bundled module is the app's own code and declares
  // nothing; it is not held to a disclosure list.
  const requireBacklogRead = (moduleId: string, manifest: CapabilityManifest | undefined): void => {
    if (manifest?.source !== 'third-party' || manifest.permissions?.includes('backlog.read')) return
    throw new Error(
      `Module "${moduleId}" does not declare the "backlog.read" permission, so it cannot read the Backlog.`,
    )
  }
  // A call into one of main's moduleId-first registries. Main checks the
  // permission; a refusal or a missing door comes back as data.
  const callHostService = async <T>(
    moduleId: string,
    service: ModuleHostServiceName,
    method: string,
    args: unknown[],
    unavailableCode: string,
  ): Promise<T> => {
    const invoke = typeof window === 'undefined' ? undefined : window.api?.moduleHostServiceInvoke
    if (!invoke) {
      return { ok: false, code: unavailableCode, message: `The ${service} service is not available here.` } as T
    }
    try {
      return (await invoke({ moduleId, service, method, args })) as T
    } catch (error) {
      return {
        ok: false,
        code: unavailableCode,
        message: error instanceof Error ? error.message : String(error),
      } as T
    }
  }
  // The Backlog writes follow the Backlog module's enablement like its reads:
  // switched off, the Backlog is off for modules too.
  const callBacklog = <T extends object = object>(
    moduleId: string,
    method: string,
    args: unknown[],
  ): Promise<ModuleBacklogResult<T>> => {
    if (backlogReader && moduleEnabledResolver && !moduleEnabledResolver(backlogReader.moduleId)) {
      return Promise.resolve({ ok: false, code: 'backlog_unavailable', message: 'The Backlog module is disabled.' })
    }
    return callHostService<ModuleBacklogResult<T>>(moduleId, 'backlog', method, args, 'backlog_unavailable')
  }
  const enabledModuleCommands = (moduleEnabled?: (moduleId: string) => boolean): RegisteredModuleCommand[] =>
    [...moduleCommands.values()]
      .filter((command) => !moduleEnabled || moduleEnabled(command.moduleId))
      .sort((a, b) => a.id.localeCompare(b.id))
  const enabledModalSurfaces = (moduleEnabled?: (moduleId: string) => boolean): RegisteredModalSurface[] =>
    [...modalSurfaces.values()]
      .filter((surface) => !moduleEnabled || moduleEnabled(surface.moduleId))
      .sort((a, b) => {
        // `order` is optional now that nothing lists these (see the type); an
        // omitted one sorts as 0, so a declared order still leads.
        const order = (a.order ?? 0) - (b.order ?? 0)
        return order === 0 ? a.id.localeCompare(b.id) : order
      })
  return {
    hostFor(moduleId, manifest) {
      const moduleName = manifest?.displayName?.trim() || moduleId
      return {
        hostApiVersion: HOST_API_VERSION,
        moduleId,
        supports(capability) {
          // Opening a chat needs the shell's opener, which a window registers
          // once it mounts; the answer follows it rather than a table. The
          // same for every capability that is a window's wiring, not a build's.
          if (capability === 'chat.open' || capability === 'chat.open-options') return getWorkspaceChatOpener() !== null
          if (capability === 'notifications') return moduleNotificationsWired
          if (capability === 'toast') return toastSink !== null
          if (capability === 'open-external') return externalLinkOpener !== null
          return hostSupports(capability)
        },
        registerPanel(componentId, component) {
          if (panels.has(componentId)) {
            throw new Error(`Renderer panel "${componentId}" is already registered.`)
          }
          panels.set(componentId, component)
          panelModules.set(componentId, moduleId)
        },
        registerWorkspaceType(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Workspace type id must be a non-empty string.')
          }
          if (definition.id === 'standard') {
            throw new Error('Workspace type "standard" is shell-owned and cannot be registered.')
          }
          if (workspaceTypes.has(definition.id)) {
            throw new Error(`Workspace type "${definition.id}" is already registered.`)
          }
          workspaceTypes.set(definition.id, { ...definition, moduleId })
        },
        registerBacklogItemAction(action) {
          if (backlogItemActions.has(action.id)) {
            throw new Error(`Backlog item action "${action.id}" is already registered.`)
          }
          backlogItemActions.set(action.id, { ...action, moduleId })
        },
        registerFileAction(action) {
          if (action.id.trim().length === 0) {
            throw new Error('File action id must be a non-empty string.')
          }
          if (fileActions.has(action.id)) {
            throw new Error(`File action "${action.id}" is already registered.`)
          }
          fileActions.set(action.id, { ...action, moduleId })
        },
        registerBacklogLinkProvider(provider) {
          if (provider.moduleId !== moduleId) {
            throw new Error(
              `Backlog link provider "${provider.moduleId}" must be registered by its owning module "${moduleId}".`,
            )
          }
          if (provider.targetKinds.length === 0) {
            throw new Error(`Backlog link provider "${provider.moduleId}" must own at least one target kind.`)
          }
          const uniqueTargetKinds = new Set(provider.targetKinds)
          if (uniqueTargetKinds.size !== provider.targetKinds.length) {
            throw new Error(`Backlog link provider "${provider.moduleId}" declares duplicate target kinds.`)
          }
          for (const targetKind of provider.targetKinds) {
            const owner = backlogLinkProviders.get(targetKind)
            if (owner) {
              throw new Error(
                `Backlog link target kind "${targetKind}" is already owned by module "${owner.moduleId}".`,
              )
            }
          }
          for (const targetKind of provider.targetKinds) {
            backlogLinkProviders.set(targetKind, provider)
          }
        },
        registerNotificationActionProvider(provider) {
          // An installed module's rows are filed under its own id, and that is
          // the only source it may claim: a provider on a core source would
          // put its actions on rows the app wrote.
          if (manifest?.source === 'third-party' && provider.source !== moduleId) {
            throw new Error(
              `Module "${moduleId}" may only register a notification action provider for its own rows (source "${moduleId}"); got "${provider.source}".`,
            )
          }
          if (notificationActionProviders.has(provider.source)) {
            const owner = notificationActionProviders.get(provider.source)
            throw new Error(
              `Notification action provider for source "${provider.source}" is already registered by module "${owner?.moduleId}".`,
            )
          }
          notificationActionProviders.set(provider.source, { ...provider, moduleId })
        },
        registerCommand(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Module command id must be a non-empty string.')
          }
          const commandId = `${moduleId}.${definition.id}`
          if (SHELL_COMMAND_IDS.has(commandId)) {
            throw new Error(`Command "${commandId}" is already registered by the application command registry.`)
          }
          if (moduleCommands.has(commandId)) {
            throw new Error(`Module command "${commandId}" is already registered.`)
          }
          if (definition.title.trim().length === 0) {
            throw new Error(`Module command "${commandId}" must have a non-empty title.`)
          }
          if (definition.scopes.length === 0) {
            throw new Error(`Module command "${commandId}" must declare at least one scope.`)
          }
          // The shell only ever activates `panel:<moduleId>` for a module's
          // workspaces — a typo'd panel scope would register cleanly and then
          // be permanently dead, so it fails loudly here instead.
          for (const scope of definition.scopes) {
            if (!scope.startsWith('panel:')) continue
            if (scope !== `panel:${moduleId}`) {
              throw new Error(
                `Module command "${commandId}" declares scope "${scope}", but the shell only activates "panel:${moduleId}" for module "${moduleId}" — the command would never be offered.`,
              )
            }
          }
          // A function-form availability lands on the shared contribution
          // shape as `availabilityPredicate`, so the palette and dispatcher
          // evaluate it through the same gate as enum preconditions.
          const { availability, ...rest } = definition
          moduleCommands.set(commandId, {
            ...rest,
            ...(typeof availability === 'function' ? { availabilityPredicate: availability } : { availability }),
            id: commandId,
            moduleId,
            defaultKeybindings: definition.defaultKeybindings
              ? collapseDuplicateKeybindings(definition.defaultKeybindings)
              : undefined,
          })
        },
        registerSettingsSection(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Settings section id must be a non-empty string.')
          }
          const existing = settingsSections.get(definition.id)
          if (existing) {
            throw new Error(
              `Settings section "${definition.id}" is already registered by module "${existing.moduleId}".`,
            )
          }
          settingsSections.set(definition.id, { ...definition, moduleId })
        },
        registerSidebarNavEntry(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Sidebar nav entry id must be a non-empty string.')
          }
          const existing = sidebarNavEntries.get(definition.id)
          if (existing) {
            throw new Error(
              `Sidebar nav entry "${definition.id}" is already registered by module "${existing.moduleId}".`,
            )
          }
          sidebarNavEntries.set(definition.id, { ...definition, moduleId })
        },
        registerDoorBadge(contribution) {
          const rowId = contribution.rowId.trim()
          if (rowId.length === 0) {
            throw new Error('Door badge row id must be a non-empty string.')
          }
          const existing = doorBadges.get(rowId)
          if (existing) {
            throw new Error(`Door badge for row "${rowId}" is already registered by module "${existing.moduleId}".`)
          }
          doorBadges.set(rowId, { ...contribution, rowId, moduleId })
        },
        registerTopBarItem(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Top bar item id must be a non-empty string.')
          }
          const existing = topBarItems.get(definition.id)
          if (existing) {
            throw new Error(`Top bar item "${definition.id}" is already registered by module "${existing.moduleId}".`)
          }
          topBarItems.set(definition.id, { ...definition, moduleId })
        },
        registerGlobalSurface(definition) {
          // Normalised, not merely validated. A padded id passed the old check
          // and was then stored untrimmed, so every lookup that keyed on the
          // clean string missed — a surface that mounts nowhere, with nothing
          // to explain why. That was fixed for a surface's VIEW ids in Stage 2;
          // the surface's own id had the same hole.
          const id = definition.id.trim()
          if (id.length === 0) {
            throw new Error('Global surface id must be a non-empty string.')
          }
          // The Extensions home is core (the app rail's Extensions glyph,
          // Extensions drawer ruling 2026-09-05): it is where the product's own
          // parts are offered, so no module may gate it — the same reservation
          // `settings` and `diff` carry on the modal side, and the one the
          // retired `marketplace` modal carried before this.
          if (id === 'extensions-home') {
            throw new Error('Global surface id "extensions-home" is reserved for the app\'s own Extensions home.')
          }
          if (definition.label !== undefined && definition.label.trim().length === 0) {
            throw new Error(`Global surface "${id}" has an empty label; omit it instead.`)
          }
          // `railPlacement` decides whether the door TAKES the sidebar column.
          // A typo fell through to the `sidebar` default, which is the more
          // destructive of the two: a drawer row that meant `inline` would have
          // deleted the very drawer that opened it, and nothing would have said
          // so. TypeScript catches this for a module compiled against the SDK;
          // a third-party bundle loaded at runtime is not.
          if (
            definition.railPlacement !== undefined &&
            definition.railPlacement !== 'sidebar' &&
            definition.railPlacement !== 'inline'
          ) {
            throw new Error(
              `Global surface "${id}" declares an unknown railPlacement "${String(definition.railPlacement)}"; use "sidebar" or "inline".`,
            )
          }
          const views = normalizeSurfaceViews('Global surface', id, definition.views)
          const existing = globalSurfaces.get(id)
          if (existing) {
            throw new Error(`Global surface "${id}" is already registered by module "${existing.moduleId}".`)
          }
          globalSurfaces.set(id, { ...definition, id, ...(views ? { views } : {}), moduleId })
        },
        registerModalSurface(definition) {
          if (definition.id.trim().length === 0) {
            throw new Error('Modal surface id must be a non-empty string.')
          }
          // Core Settings never registers here (it must not be module-gated —
          // its own enablement toggles live inside it), so without this
          // reservation a module could claim the id, put a second glyph in the
          // cluster, and have it open core Settings. The usage dashboard opens
          // from the same cluster and is reserved for the same reason.
          if (definition.id === 'settings') {
            throw new Error('Modal surface id "settings" is reserved for the app\'s own Settings.')
          }
          if (definition.id === 'usage') {
            throw new Error('Modal surface id "usage" is reserved for the app\'s own usage dashboard.')
          }
          if (definition.label.trim().length === 0) {
            throw new Error(`Modal surface "${definition.id}" must have a non-empty label.`)
          }
          const existing = modalSurfaces.get(definition.id)
          if (existing) {
            throw new Error(`Modal surface "${definition.id}" is already registered by module "${existing.moduleId}".`)
          }
          // The pane row, normalised at the door rather than at the pane: the
          // letter is a keyboard accelerator the "+" menu compares against an
          // uppercased key, so a lowercase or multi-character one is a row
          // whose shortcut silently never fires. Say so here instead.
          const launcher = definition.launcher
          if (launcher) {
            if (launcher.label.trim().length === 0) {
              throw new Error(`Modal surface "${definition.id}" has a launcher with an empty label.`)
            }
            if ([...launcher.letter].length !== 1) {
              throw new Error(
                `Modal surface "${definition.id}" has a launcher letter "${launcher.letter}"; it must be exactly one character.`,
              )
            }
            if (typeof launcher.Glyph !== 'function') {
              throw new Error(`Modal surface "${definition.id}" has a launcher without a Glyph component.`)
            }
          }
          modalSurfaces.set(definition.id, {
            ...definition,
            ...(launcher
              ? { launcher: { ...launcher, label: launcher.label.trim(), letter: launcher.letter.toUpperCase() } }
              : {}),
            moduleId,
          })
        },
        openGlobalSurface(id) {
          const surface = typeof id === 'string' ? globalSurfaces.get(id.trim()) : undefined
          if (surface?.moduleId !== moduleId || !surfaceOpener) return false
          if (moduleEnabledResolver && !moduleEnabledResolver(moduleId)) return false
          surfaceOpener.openGlobalSurface(surface.id)
          return true
        },
        openModalSurface(id) {
          const surface = typeof id === 'string' ? modalSurfaces.get(id) : undefined
          if (surface?.moduleId !== moduleId || !surfaceOpener) return false
          if (moduleEnabledResolver && !moduleEnabledResolver(moduleId)) return false
          surfaceOpener.openModalSurface(surface.id)
          return true
        },
        provideBacklogReader(reader) {
          // The Backlog read API is the backlog module's to serve; another
          // module providing it would answer every listBacklogItems caller.
          if (moduleId !== 'backlog') {
            throw new Error(`Module "${moduleId}" cannot provide the Backlog reader; only the backlog module can.`)
          }
          if (backlogReader) {
            throw new Error(`The Backlog reader is already provided by module "${backlogReader.moduleId}".`)
          }
          backlogReader = { moduleId, reader }
        },
        async listBacklogItems(workspaceId) {
          requireBacklogRead(moduleId, manifest)
          return requireBacklogReader().list(workspaceId)
        },
        watchBacklogItems(workspaceId, cb, options) {
          requireBacklogRead(moduleId, manifest)
          const reader = requireBacklogReader()
          const backlogOff = (): boolean =>
            backlogReader !== null && moduleEnabledResolver !== null && !moduleEnabledResolver(backlogReader.moduleId)
          const onError = options?.onError
          return reader.watch(
            workspaceId,
            (items) => {
              // Live gate on every delivery, not just at subscribe: an active
              // watch stops streaming the moment the user disables the backlog
              // module (and resumes on re-enable) instead of outliving the
              // toggle. The provider is re-read so the gate follows ownership.
              if (backlogOff()) return
              try {
                cb(items)
              } catch (error) {
                // A throwing module callback must not break the shared scan's
                // emit loop for sibling subscribers (the Backlog panel included).
                console.error(`[modules] backlog watch callback from module "${moduleId}" threw:`, error)
              }
            },
            onError
              ? (error) => {
                  if (backlogOff()) return
                  try {
                    onError(error)
                  } catch (thrown) {
                    console.error(`[modules] backlog watch onError from module "${moduleId}" threw:`, thrown)
                  }
                }
              : undefined,
          )
        },
        getBacklogLocation(workspaceId) {
          return callBacklog(moduleId, 'getLocation', [workspaceId])
        },
        createBacklogItem(workspaceId, input) {
          return callBacklog(moduleId, 'create', [workspaceId, input])
        },
        updateBacklogStatus(workspaceId, itemId, status) {
          return callBacklog(moduleId, 'updateStatus', [workspaceId, itemId, status])
        },
        updateBacklogTriage(workspaceId, itemId, triage) {
          return callBacklog(moduleId, 'updateTriage', [workspaceId, itemId, triage])
        },
        addBacklogLink(workspaceId, itemId, link) {
          return callBacklog(moduleId, 'addLink', [workspaceId, itemId, link])
        },
        updateBacklogModuleMetadata(workspaceId, itemId, value) {
          return callBacklog(moduleId, 'updateModuleMetadata', [workspaceId, itemId, value])
        },
        queryUsage(query) {
          return callHostService<UsageQueryResult>(moduleId, 'usage', 'query', [query], 'unavailable')
        },
        getAssetUrl(relativePath) {
          if (moduleEnabledResolver && !moduleEnabledResolver(moduleId)) throw new Error('Module is disabled.')
          const origin = moduleAssetOrigins.get(moduleId)
          if (!origin) throw new Error('Module assets are unavailable until its trusted entry loads.')
          return moduleAssetUrl(moduleId, relativePath, origin)
        },
        async getWorkspace(workspaceId) {
          return workspaceResolver ? workspaceResolver(workspaceId) : null
        },
        async openWorkspace(typeId) {
          if (workspaceTypes.get(typeId)?.moduleId !== moduleId) {
            throw new Error(`Workspace type "${typeId}" is not registered by module "${moduleId}".`)
          }
          if (moduleEnabledResolver && !moduleEnabledResolver(moduleId)) {
            throw new Error(`Module "${moduleId}" is disabled.`)
          }
          if (!workspaceOpener) throw new Error('Workspace opening is not available yet.')
          return workspaceOpener(typeId)
        },
        async listWorkspaces() {
          return workspaceListSource ? workspaceListSource.list() : []
        },
        async getWorkspaceGitInfo(workspaceId) {
          if (!manifest?.permissions?.includes('ipc:workspace-read')) {
            return {
              ok: false,
              code: 'permission_missing',
              message: `Module "${moduleId}" must declare the "ipc:workspace-read" permission to read a workspace's git information.`,
            }
          }
          if (!workspaceGitInfoSource) {
            return { ok: false, code: 'unavailable', message: 'Workspace git information is not available yet.' }
          }
          try {
            return await workspaceGitInfoSource(workspaceId)
          } catch {
            return { ok: false, code: 'git_failed', message: "The workspace's git information could not be read." }
          }
        },
        watchWorkspaces(cb) {
          // Unwired (early boot, windowless bundles) still honours the
          // fires-once contract: a module renders its empty state rather than
          // waiting forever for a first delivery that cannot come.
          if (!workspaceListSource) {
            cb([])
            return () => {}
          }
          return workspaceListSource.watch(cb)
        },
        watchColorScheme(cb) {
          if (!colorSchemeWatcher) {
            // Same reasoning as above: answer once with the app's default
            // surface so a themed runtime boots rather than hanging.
            cb('dark')
            return () => {}
          }
          return colorSchemeWatcher(cb)
        },
        getWorkspaceModuleState<T = unknown>(workspaceId: string): T | undefined {
          return workspaceModuleStateStore
            ? (workspaceModuleStateStore.get(workspaceId, moduleId) as T | undefined)
            : undefined
        },
        setWorkspaceModuleState(workspaceId, state) {
          return workspaceModuleStateStore ? workspaceModuleStateStore.set(workspaceId, moduleId, state) : false
        },
        getModuleAppState<T = unknown>(key: string): T | undefined {
          if (!moduleAppStateStore) return undefined
          return moduleAppStateStore.get(moduleId)[key] as T | undefined
        },
        setModuleAppState(key, value) {
          return moduleAppStateStore ? moduleAppStateStore.set(moduleId, key, value) : false
        },
        watchModuleAppState(cb) {
          const watcher: ModuleAppStateWatcher = { moduleId, cb }
          moduleAppStateWatchers.add(watcher)
          // Held by the kernel, not the store, so a watch registered before the
          // store is wired attaches when it lands rather than silently dying.
          attachModuleAppStateWatcher(watcher)
          return () => {
            moduleAppStateWatchers.delete(watcher)
            watcher.detach?.()
          }
        },
        subscribe(topic, cb) {
          // The kernel owns the subscriber set (see dispatchModuleEvent): one
          // source listener backs every module's subscriptions, and a subscribe
          // made before the source is wired still receives once it lands.
          const subscriber: ModuleEventSubscriber = { moduleId, topic, cb }
          moduleEventSubscribers.add(subscriber)
          return () => {
            moduleEventSubscribers.delete(subscriber)
          }
        },
        async getWorkingRoot(workspaceId) {
          return workingRootResolver ? workingRootResolver(workspaceId) : null
        },
        async watchWorkspaceFile(workspaceId, relativePath, cb) {
          const watcher = requireAgentRuntime(workspaceFileWatcher, 'Workspace file watch')
          return watcher(workspaceId, relativePath, (event) => {
            // Live gate on every delivery, not just at subscribe (the Backlog
            // watcher pattern): an active watch stops streaming the moment the
            // user disables the Agent Runtime module.
            if (agentRuntimeDisabled()) return
            cb(event)
          })
        },
        focusTab(input) {
          return requireAgentRuntime(tabFocuser, 'Tab focus')(input)
        },
        async openChat(input) {
          // A draft the person reads and sends needs only `chat:draft`; a
          // prompt sent for them is driving the chat, which is
          // `conversation:operate`'s, as it is everywhere else.
          const permissions = manifest?.permissions ?? []
          const operate = permissions.includes('conversation:operate')
          if (input?.send === true ? !operate : !operate && !permissions.includes('chat:draft')) {
            return {
              ok: false,
              code: 'permission_missing',
              message:
                input?.send === true
                  ? `Module "${moduleId}" does not declare the "conversation:operate" permission, so it cannot open a chat and send its prompt.`
                  : `Module "${moduleId}" declares neither "chat:draft" nor "conversation:operate", so it cannot open a chat.`,
            }
          }
          const opener = getWorkspaceChatOpener()
          if (!opener) {
            return { ok: false, code: 'unavailable', message: 'This window cannot open a chat yet.' }
          }
          return opener({ ...input, moduleId })
        },
        listChatRuntimes() {
          return chatRuntimeSource ? chatRuntimeSource() : []
        },
        toast(input) {
          if (!input || typeof input !== 'object') throw new Error('toast(...) requires a payload object.')
          if (typeof input.tone !== 'string' || !TOAST_TONES.has(input.tone)) {
            throw new Error('toast(...) tone must be "neutral", "accent", "good", "warn" or "error".')
          }
          const message = typeof input.message === 'string' ? input.message.trim() : ''
          if (message.length === 0) throw new Error('toast(...) requires a non-empty message.')
          if (input.detail !== undefined && typeof input.detail !== 'string') {
            throw new Error('toast(...) detail must be a string when provided.')
          }
          const action = input.action
          if (
            action !== undefined &&
            (!action ||
              typeof action.label !== 'string' ||
              action.label.trim().length === 0 ||
              typeof action.run !== 'function')
          ) {
            throw new Error('toast(...) action must be { label, run } with a non-empty label.')
          }
          if (!toastSink || moduleIsDisabled(moduleId)) return () => {}
          const detail = input.detail?.trim()
          return toastSink({
            tone: input.tone,
            message: message.slice(0, MAX_TOAST_MESSAGE_LENGTH),
            ...(detail ? { detail: detail.slice(0, MAX_TOAST_DETAIL_LENGTH) } : {}),
            ...(action
              ? {
                  action: {
                    label: action.label.trim(),
                    run: () => {
                      // The module's handler, contained: a throw is the
                      // module's bug, not the toast region's.
                      try {
                        void Promise.resolve(action.run()).catch((error: unknown) =>
                          console.error(`[modules] toast action from module "${moduleId}" failed:`, error),
                        )
                      } catch (error) {
                        console.error(`[modules] toast action from module "${moduleId}" threw:`, error)
                      }
                    },
                  },
                }
              : {}),
            moduleId,
            moduleName,
          })
        },
        getActiveWorkspaceId() {
          return activeWorkspaceSource ? activeWorkspaceSource.get() : null
        },
        watchActiveWorkspace(cb) {
          // Fires once either way, like watchWorkspaces: a door renders its
          // no-workspace state rather than waiting for a first delivery.
          if (!activeWorkspaceSource) {
            cb(null)
            return () => {}
          }
          const source = activeWorkspaceSource
          let last = source.get()
          cb(last)
          return source.subscribe(() => {
            const next = source.get()
            if (next === last) return
            last = next
            try {
              cb(next)
            } catch (error) {
              console.error(`[modules] active-workspace watcher from module "${moduleId}" threw:`, error)
            }
          })
        },
        setSurfaceView(surfaceId, viewId) {
          const surface = typeof surfaceId === 'string' ? globalSurfaces.get(surfaceId.trim()) : undefined
          if (surface?.moduleId !== moduleId || moduleIsDisabled(moduleId)) return false
          if (viewId === null) {
            publishSurfaceView(surface.id, null)
            return true
          }
          const wanted = typeof viewId === 'string' ? viewId.trim() : ''
          const view = surface.views?.find((candidate) => candidate.id === wanted)
          if (!view) return false
          publishSurfaceView(surface.id, view.id)
          return true
        },
        async openExternal(url) {
          const safe = externalHttpUrl(url)
          if (!safe) {
            return { ok: false, code: 'invalid_url', message: 'Only an absolute http(s) URL can be opened.' }
          }
          if (!externalLinkOpener || moduleIsDisabled(moduleId)) {
            return { ok: false, code: 'unavailable', message: 'This window cannot open links yet.' }
          }
          try {
            const result = await externalLinkOpener(safe)
            return result.ok ? { ok: true } : { ok: false, code: 'failed', message: result.message }
          } catch (error) {
            return {
              ok: false,
              code: 'failed',
              message: error instanceof Error ? error.message : 'Could not open the link.',
            }
          }
        },
        async invoke(channel, payload) {
          if (!channel.startsWith(`${moduleId}:`)) {
            throw new Error(
              `Module "${moduleId}" may only invoke its own channels ("${moduleId}:*"); got "${channel}".`,
            )
          }
          const outcome = await window.api.moduleBridgeInvoke(channel, payload)
          if (!outcome.ok) {
            // Keep the structured refusal code on the thrown error so module
            // code can branch on the refusal kind without parsing prose.
            throw Object.assign(new Error(outcome.message), { code: outcome.code })
          }
          return outcome.result
        },
      }
    },
    getPanel(componentId) {
      return panels.get(componentId)
    },
    getPanelModule(componentId) {
      return panelModules.get(componentId)
    },
    getWorkspaceType(id) {
      return workspaceTypes.get(id)
    },
    getWorkspaceTypes(moduleEnabled) {
      // The module list registers eagerly at boot and these definitions are
      // stored by reference, so lookups are stable. Components that derive
      // arrays from this registry should still memoize those arrays before
      // returning them from Zustand selectors.
      return [...workspaceTypes.values()]
        .filter((definition) => !moduleEnabled || moduleEnabled(definition.moduleId))
        .sort((a, b) => {
          const order = (a.pickerOrder ?? 100) - (b.pickerOrder ?? 100)
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getWorkspaceTypeModule(id) {
      return workspaceTypes.get(id)?.moduleId
    },
    getBacklogItemActions() {
      return [...backlogItemActions.values()].sort((a, b) => {
        const order = (a.order ?? 100) - (b.order ?? 100)
        return order === 0 ? a.label.localeCompare(b.label) : order
      })
    },
    getFileActions() {
      return [...fileActions.values()].sort((a, b) => {
        const order = (a.order ?? 100) - (b.order ?? 100)
        return order === 0 ? a.label.localeCompare(b.label) : order
      })
    },
    getBacklogLinkProviders(moduleEnabled) {
      const providers = new Set<BacklogLinkProvider>()
      for (const provider of backlogLinkProviders.values()) {
        if (moduleEnabled && !moduleEnabled(provider.moduleId)) continue
        providers.add(provider)
      }
      return [...providers].sort((a, b) => {
        const moduleOrder = a.moduleId.localeCompare(b.moduleId)
        return moduleOrder === 0 ? a.targetKinds.join('\0').localeCompare(b.targetKinds.join('\0')) : moduleOrder
      })
    },
    getNotificationActionProviders(moduleEnabled) {
      return [...notificationActionProviders.values()]
        .filter((provider) => !moduleEnabled || moduleEnabled(provider.moduleId))
        .sort((a, b) => a.source.localeCompare(b.source))
    },
    getModuleCommand(commandId) {
      return moduleCommands.get(commandId)
    },
    getModuleCommands(moduleEnabled) {
      return enabledModuleCommands(moduleEnabled)
    },
    getCommandContributions(moduleEnabled) {
      return [...COMMAND_REGISTRY, ...enabledModuleCommands(moduleEnabled)]
    },
    getSettingsSections(moduleEnabled) {
      return [...settingsSections.values()]
        .filter((section) => !moduleEnabled || moduleEnabled(section.moduleId))
        .sort((a, b) => {
          const order = (a.order ?? 100) - (b.order ?? 100)
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getSidebarNavEntries(moduleEnabled) {
      return [...sidebarNavEntries.values()]
        .filter((entry) => !moduleEnabled || moduleEnabled(entry.moduleId))
        .sort((a, b) => {
          // `order` is optional now that nothing lists these (see the type); an
          // omitted one sorts as 0, so a declared order still leads.
          const order = (a.order ?? 0) - (b.order ?? 0)
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getDoorBadges(moduleEnabled) {
      return [...doorBadges.values()].filter((badge) => !moduleEnabled || moduleEnabled(badge.moduleId))
    },
    getTopBarItems(moduleEnabled) {
      return [...topBarItems.values()]
        .filter((item) => !moduleEnabled || moduleEnabled(item.moduleId))
        .sort((a, b) => {
          // `order` is optional now that nothing lists these (see the type); an
          // omitted one sorts as 0, so a declared order still leads.
          const order = (a.order ?? 0) - (b.order ?? 0)
          return order === 0 ? a.id.localeCompare(b.id) : order
        })
    },
    getGlobalSurface(id) {
      return globalSurfaces.get(id)
    },
    getGlobalSurfaces(moduleEnabled) {
      return [...globalSurfaces.values()]
        .filter((surface) => !moduleEnabled || moduleEnabled(surface.moduleId))
        .sort((a, b) => a.id.localeCompare(b.id))
    },
    getModalSurface(id) {
      return modalSurfaces.get(id)
    },
    getModalSurfaces(moduleEnabled) {
      return enabledModalSurfaces(moduleEnabled)
    },
    getModalSurfaceLaunchers(moduleEnabled) {
      const launchers: RegisteredModalSurfaceLauncher[] = []
      for (const surface of enabledModalSurfaces(moduleEnabled)) {
        if (!surface.launcher) continue
        launchers.push({ ...surface.launcher, surfaceId: surface.id, moduleId: surface.moduleId })
      }
      return launchers
    },
    setModuleEnablementResolver(resolver) {
      moduleEnabledResolver = resolver
    },
    isModuleEnabled(moduleId) {
      return moduleEnabledResolver ? moduleEnabledResolver(moduleId) : true
    },
    setWorkspaceModuleStateStore(store) {
      workspaceModuleStateStore = store
    },
    setModuleAppStateStore(store) {
      moduleAppStateStore = store
      // Attach anything that watched before the store landed (a module's
      // registerRenderer runs synchronously, this wiring a microtask later).
      for (const watcher of moduleAppStateWatchers) attachModuleAppStateWatcher(watcher)
    },
    setModuleEventSource(source) {
      // One listener on the source, whoever subscribed and whenever. Re-wiring
      // replaces the old attachment rather than stacking a second dispatcher.
      detachModuleEventSource?.()
      detachModuleEventSource = source(dispatchModuleEvent)
    },
    setWorkspaceResolver(resolver) {
      workspaceResolver = resolver
    },
    setModuleAssetOrigin(moduleId, origin) {
      if (!/^studio-module:\/\/[a-f0-9]{64}$/.test(origin)) throw new Error('Invalid module asset origin.')
      moduleAssetOrigins.set(moduleId, origin)
    },
    setWorkspaceOpener(opener) {
      workspaceOpener = opener
    },
    setSurfaceOpener(opener) {
      surfaceOpener = opener
    },
    setWorkingRootResolver(resolver) {
      workingRootResolver = resolver
    },
    setWorkspaceFileWatcher(watcher) {
      workspaceFileWatcher = watcher
    },
    setTabFocuser(focuser) {
      tabFocuser = focuser
    },
    setChatRuntimeSource(source) {
      chatRuntimeSource = source
    },
    setWorkspaceGitInfoSource(source) {
      workspaceGitInfoSource = source
    },
    setWorkspaceListSource(source) {
      workspaceListSource = source
    },
    setColorSchemeWatcher(watcher) {
      colorSchemeWatcher = watcher
    },
    setModuleNotificationsWired(wired) {
      moduleNotificationsWired = wired
    },
    setToastSink(sink) {
      toastSink = sink
    },
    setExternalLinkOpener(opener) {
      externalLinkOpener = opener
    },
    setActiveWorkspaceSource(source) {
      activeWorkspaceSource = source
    },
    moduleSurfaceTargetOpener(moduleId, target) {
      const surfaceId = typeof target?.surfaceId === 'string' ? target.surfaceId.trim() : ''
      const surface = globalSurfaces.get(surfaceId)
      if (!surface || surface.moduleId !== moduleId || !surfaceOpener) return null
      if (moduleIsDisabled(moduleId)) return null
      const viewId = typeof target.viewId === 'string' ? target.viewId.trim() : ''
      const view = viewId ? surface.views?.find((candidate) => candidate.id === viewId) : undefined
      // A view the surface no longer declares opens the surface plainly
      // rather than not at all: the row still names this module's door.
      const opener = surfaceOpener
      return () => {
        try {
          if (view) view.open()
          else surface.onOpen?.()
        } catch (error) {
          console.error(`[modules] surface "${surface.id}" of module "${moduleId}" failed to land its view:`, error)
        }
        opener.openGlobalSurface(surface.id)
      }
    },
  }
}

export type RendererModule = {
  manifest: CapabilityManifest
  registerRenderer?: (host: InternalRendererHost) => void
}
