import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import {
  Actions,
  Layout,
  Model,
  TabNode,
  TabSetNode,
  type Action,
  type BorderNode,
  type IJsonModel,
  type ITabRenderValues,
  type ITabSetRenderValues,
  type NodeMouseEvent,
} from 'flexlayout-react'
// combined.css carries the structural FlexLayout CSS — its theme variables
// are scoped under `.flexlayout__theme_*` classes that we never apply. Our own
// `.flexlayout__layout { --fl-*: var(--bg-*) }` block in
// src/renderer/src/assets/index.css drives every color, so the FlexLayout
// chrome follows our data-theme on Dark / Light / Slate / Dark Conifer.
// The previous `style/dark.css` import declared its own `.flexlayout__layout`
// rule with hardcoded dark color variables that painted over our theme
// tokens on every non-dark theme — the dark horizontal bars in light mode.
import 'flexlayout-react/style/combined.css'
import { AgentRevealStrip } from './AgentRevealStrip'
import { FLEX_LAYOUT_ICONS } from './flexLayoutIcons'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { normalizeAgentRuntime } from '../../store/slices/agentsSlice'
import { openExternalFileWindow } from '../auxWindows/openFileWindow'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import { samePath } from '../../utils/paths'
import { EXTENSIONS_BROWSE_DEEPLINK, MODULES_SETTINGS_TAB } from '../settings/extensionsRoute'
import { MissingModulePanelSurface, ModuleNotInstalledSurface, workspaceModuleAbsence } from './ModuleAbsenceSurfaces'
import {
  isSessionFailed,
  isSessionWorking,
  pickAgentTabRecency,
  pickTerminalTabRecency,
  tabRecencyLabel,
  useWorkspaceTerminalSessions,
} from '../../hooks/useTerminalSessions'
import { useRelativeNow } from '../../hooks/useRelativeNow'
import { formatRelativeMs, formatRelativeMsAgo } from '../../utils/relativeTime'
import type { HighlightColor, Workspace } from '../../types/workspace'
import {
  NEW_AGENT_TAB_COMPONENT,
  captureRailWidthFractions,
  consumePendingAgentFlash,
  deleteTabPreservingRails,
  registerModel,
  restoreRailWidthFractions,
  unregisterModel,
} from '../../utils/modelRegistry'
import { TAB_DRAG_MIME, serializeTabDragPayload } from '../../utils/tabDragPayload'
import { logPerfEvent } from '../../utils/perfDiagnostics'
import { rememberClosedLayoutTab } from '../../utils/recentlyClosedTabs'
import { getHighlightSwatch } from '../../utils/highlight'
import { resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { ChatGlyph } from '../AppIcons'
import { MachineGlyph } from '../ui'
import { resolveMachineIdentity, type MachineIdentity } from '../../../../shared/machine-identity'
import { distroOfHostId, isWslHostId } from '../../../../shared/execution-host'
import { useMachineIdentity, useWorkspaceMachineRef } from '../../hooks/useMachineIdentity'
import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import { conversationTabSignature } from './stableRowSlices'
import { conversationSummaryPhase } from '../../../../shared/conversation/phase'
import { cliForConversationProvider } from '../../../../shared/conversation-harness'
import { conversationFinishedAt } from './sidebar/conversationLines'
import { PromptCacheMark } from './PromptCacheMark'
import CliIcon from '../CliIcon'
import { AgentTabIdentityPopover, type AgentTabIdentity } from './AgentTabIdentityPopover'
import { agentCheckoutOf, type AgentTabCheckout } from './agentCheckout'
import { labelForCliRuntime } from './newWorkspace/cliRuntimeOptions'
import { TabPromptPeek } from './TabPromptPeek'
import { ChatAppToolsMenuItems } from './ChatAppToolsMenuItems'
import { chatResumesInTerminal, resumeChatInTerminalOrToast } from '../panels/agentChat/resumeInTerminal'
import { requestChatReplay } from '../panels/agentChat/chatReplayRequests'
import { ModuleContributionBoundary } from '../../modules/ModuleContributionBoundary'
import { GitBranchGlyph } from './WorkspaceActions'
import { remotePaneTabLabel } from './remoteBand/remoteSessionsModel'
import { shortMachineName } from '../remote/machineRowModel'
import {
  ContextMenu,
  IconButton,
  LoadingOverlay,
  MenuDivider,
  MenuItem,
  MenuSwatchRow,
  StatusDot,
  type Tone,
  Tooltip,
  WorkingMark,
} from '../ui'
import {
  canonicalMeshPaneComponent,
  isMeshConversationPane,
  MESH_CONVERSATION_COMPONENT,
} from '../../../../shared/tailnet-mesh'

const EMPTY_LAYOUT_MODEL: IJsonModel = { global: {}, borders: [], layout: { type: 'row', children: [] } }

interface Props {
  workspaceId: string
  conversationSessions?: readonly ConversationSessionSummary[]
  // The tab strip's "+": opens the tab an agent will run in, holding
  // the launch surface until something spawns. The strip's own tabset id is
  // passed so the tab lands in that panel rather than tiling a new one.
  // Absent → no plus: background layers and hosts that are not agent
  // workspaces (the Automations host) do not open one.
  onNewAgentTab?: (hostTabsetId?: string) => void
  // Renders the launch surface inside that tab. `tabId` is the node the spawn
  // retypes in place, so the terminal appears where the surface was.
  renderNewAgentPanel?: (tabId: string, agentName?: string) => React.ReactNode
}

// Count the live tabs in a model. A workspace whose last tab was closed leaves
// FlexLayout with an empty grid (sometimes empty tabsets), so we look for real
// TabNodes rather than trusting tabset presence.
function countOpenTabs(model: Model | null): number {
  if (!model) return 0
  let count = 0
  model.visitNodes((node) => {
    if (node instanceof TabNode) count += 1
  })
  return count
}

// Dev Tools panels. The canonical `editor` panel is
// served through the renderer host (gated on the dev-tools module). The local
// `EditorPanel` below backs `file-editor`, a per-file editor that takes the
// `filePath` prop the host contract omits. It shares the editor panel's chunk
// with the host-served panel, so a disabled dev-tools module loads none of it.
// The agent tab's panel — the chat composer, its transcript and the terminal
// under them. Lazy like every other panel in this factory, so the first paint
// does not wait on code it cannot show: it is the largest thing boot used to
// evaluate that no first paint can show before a workspace layout has resolved
// its tabs, and the
// terminal inside it is already fetched on demand, so a tab that opens goes
// through one Suspense step it was going through anyway. It also kept the kit's
// skill picker (and the skills catalogue behind it) eager for everyone.
const AgentPanel = React.lazy(() => import('../panels/AgentPanel'))
const EditorPanel = React.lazy(() => import('../panels/EditorPanel'))
const GitConflictResolverPanel = React.lazy(() => import('../panels/GitConflictResolverPanel'))
const PlainTerminalPanel = React.lazy(() => import('../panels/PlainTerminalPanel'))
const RemoteConversationPanel = React.lazy(() => import('../panels/agentChat/RemoteConversationPanel'))
// Files, Git and the Skills aside are no longer FlexLayout components: Files
// and Git are workspace-pane tabs (pane/WorkspacePaneBody.tsx) and the Skills
// aside was retired (browser-pane epic). Store v73 strips their tabs from
// persisted layouts; a stray one falls through to the unavailable surface.
// Shown when a host panel can't render because its owning module is disabled or
// the layout tab is stale/unknown. An explicit, labeled unavailable state —
// never a silently blank surface — applied to every gated/stale arm below.
const DISABLED_SURFACE = (
  <div
    role="note"
    aria-label="Panel unavailable"
    className="flex h-full flex-col items-center justify-center gap-1 bg-[color:var(--bg-app)] px-6 text-center"
  >
    <p className="text-meta font-medium text-[color:var(--text-strong)]">Panel unavailable</p>
    <p className="max-w-xs text-micro leading-5 text-[color:var(--text-muted)]">
      This view isn’t available right now. Its feature may be disabled, or the tab may be out of date.
    </p>
  </div>
)
// What the tab strip's right-click menu offers, sampled when it opens.
type TabMenuState = {
  x: number
  y: number
  node: TabNode
  canHideTab: boolean
  canHideAllTabs: boolean
  canCloseOtherTabs: boolean
  isTerminal: boolean
  currentColor: HighlightColor | null
  /** The chat this tab shows, when its CLI can carry the conversation on in a terminal. */
  resumableChatId: string | null
  /** The agent this tab shows, for the tools apps may give it. */
  agentId: string | null
  /** The tab's chat, when it is one: what "Replay conversation" plays. */
  chatId: string | null
}

/**
 * A tab's leading identity chip: a 16px plate carrying a 14px glyph. Several
 * tab kinds wear it — remote machine, a module panel, the CLI brand — and they
 * have to stay the same object, because they sit next to each other in one
 * strip and any difference reads as a difference in kind.
 *
 * Spelled once rather than six times because the geometry is OFF the icon ramp:
 * 14px falls between `icon-xs` (13px) and `icon-sm` (16px), so it cannot be
 * expressed in tokens today and is carried as debt by the `icon` ratchet in
 * `components/ui/designSystemAxes.test.ts`. 2026-09-06: the remote-machine chip
 * (8866d95e6, 2026-09-05) copied the shape a sixth time and pushed that ratchet
 * to 31 against a baseline of 30 — unseen for a day because verify:app halts
 * long before that step. Six copies is also six edits the day the ramp grows a
 * step that fits; one constant is one.
 */
const TAB_CHIP_CLASS = 'flex h-4 w-4 shrink-0 items-center justify-center rounded-xs'
const TAB_CHIP_GLYPH_CLASS = 'h-3.5 w-3.5'

// The mark a chat or terminal tab wears after its name when it runs on another
// machine: that machine's glyph in its colour (owner ruling 2026-10-04), named
// for a screen reader and on hover. This computer's tabs wear none.
function tabMachineMark(identity: MachineIdentity | null, machineName: string): React.ReactNode {
  if (!identity) return null
  // The machine's name, not its tailnet address: the part after the first
  // label is the same for every machine on the tailnet.
  const name = shortMachineName(machineName)
  return (
    <span role="img" className="inline-flex shrink-0 items-center" title={`On ${name}`} aria-label={`On ${name}`}>
      <MachineGlyph identity={identity} className={TAB_CHIP_GLYPH_CLASS} />
    </span>
  )
}
const loadedPanelComponents = new Set<string>()
const EMPTY_WORKSPACE_AGENTS: Workspace['agents'] = {}
const NO_CONVERSATION_SESSIONS: readonly ConversationSessionSummary[] = []
const EMPTY_OPEN_FILES: Workspace['editorState']['openFiles'] = []

/**
 * The chats as the tab strip reads them: the array last handed in, kept while
 * nothing a tab draws has moved. `renderTab` depends on it, and FlexLayout
 * re-renders every tab through a new `renderTab`, so a reply streaming into a
 * chat must not rebuild the strip it sits in.
 */
function useConversationTabSessions(
  sessions: readonly ConversationSessionSummary[],
): readonly ConversationSessionSummary[] {
  const held = useRef<{ signature: string; sessions: readonly ConversationSessionSummary[] } | null>(null)
  const signature = conversationTabSignature(sessions)
  if (held.current?.signature !== signature) held.current = { signature, sessions }
  return held.current.sessions
}

type AgentTabActivityDot = {
  tone: Tone
  pulse: boolean
  label: string
}

// The tab status dot follows actual work rather than mere process residency.
// Priority: working > failed. Idle sessions fall back to elapsed idle time.
function agentTabStatusDot(session: TerminalSessionSnapshot | undefined): AgentTabActivityDot | null {
  // A paused agent keeps a retained (frozen) snapshot with the process gone, so
  // it is stopped, not resting — distinguish it from a live idle tab (which has
  // no dot). "Paused" mirrors the AgentPanel footer's user-facing wording.
  if (session?.suspended) {
    return { tone: 'neutral', pulse: false, label: 'Paused' }
  }
  if (isSessionWorking(session)) {
    return { tone: 'good', pulse: true, label: 'Working' }
  }
  if (isSessionFailed(session)) {
    return { tone: 'error', pulse: false, label: 'Failed' }
  }
  return null
}

// The kit's loading state at panel scale (spinner/component.md): the UI face,
// a sentence with a real ellipsis, and the pulsed dot. The brand mark it used
// to render was a dark-tuned hex gradient that washed out on the light themes
// (audit, suspense-loader-is-a-dark-tuned-brand-mark; ruling 6).
function PanelLoadingFallback() {
  return <LoadingOverlay label="Loading panel…" className="bg-[color:var(--bg-app)]" />
}

function TimedPanelLoad({
  component,
  startedAt,
  children,
}: {
  component: string
  startedAt: number
  children: React.ReactNode
}) {
  const initialStartedAtRef = useRef(startedAt)

  useEffect(() => {
    const firstLoad = !loadedPanelComponents.has(component)
    loadedPanelComponents.add(component)
    logPerfEvent('WorkspaceLayout', 'panel-load', {
      component,
      elapsedMs: Math.round(performance.now() - initialStartedAtRef.current),
      firstLoad,
    })
  }, [component])

  return <>{children}</>
}

function timedPanel(component: string, children: React.ReactNode) {
  return (
    <Suspense fallback={<PanelLoadingFallback />}>
      <TimedPanelLoad component={component} startedAt={performance.now()}>
        {children}
      </TimedPanelLoad>
    </Suspense>
  )
}

function renderTerminalRecencyIndicator(session: TerminalSessionSnapshot | undefined): React.ReactNode {
  if (!session) return null
  // Active work gets the working mark — the one "working" mark the sidebar and
  // the tab's card already draw. Idle sessions show elapsed idle time instead,
  // beginning at 1m; sub-minute recency renders blank.
  if (isSessionWorking(session)) {
    return <WorkingMark label="Working" seed={session.sessionId} />
  }
  if (isSessionFailed(session)) {
    return <StatusDot tone="error" label="Failed" className="ml-0.5" />
  }
  const recency = pickTerminalTabRecency(session)
  if (!recency) return null
  return <TabRecencyText at={recency.at} label={tabRecencyLabel(recency.source)} />
}

/**
 * A tab's "how long ago", reading its own clock. The tab strip is rebuilt by
 * `renderTab`, and a clock there made every tab of the workspace re-render on
 * each tick; this leaf re-renders alone. Sub-minute recency renders nothing.
 */
function TabRecencyText({ at, label }: { at: number; label: string }): React.ReactElement | null {
  const now = useRelativeNow()
  const text = formatRelativeMs(at, now)
  if (!text) return null
  return (
    <span
      className="ml-0.5 shrink-0 text-micro tabular-nums text-[color:var(--text-subtle)]"
      title={`${label} ${formatRelativeMsAgo(at, now)} (${new Date(at).toLocaleString()})`.trim()}
      aria-label={`${label} ${formatRelativeMsAgo(at, now)}`.trim()}
    >
      {text}
    </span>
  )
}

/**
 * The agent a selected tab is showing, or null when it is showing no agent at
 * all (a file editor, the browser, a plain shell nobody launched an agent in).
 *
 * Two kinds of tab can be an agent's: the agent tab, which names its agent in
 * its config, and a plain terminal tab whose SESSION carries an `agentId` —
 * an agent attached to a terminal that was already there. Both are "the agent
 * the person is working with", which is what the Diff surfaces default to.
 */
function agentIdOfTab(node: TabNode, sessions: readonly { sessionId: string; agentId?: string }[]): string | null {
  const component = node.getComponent()
  if (component === 'agent') {
    const config = node.getConfig() as { agentId?: string } | undefined
    return config?.agentId ?? node.getId()
  }
  if (component === 'terminal') {
    const config = node.getConfig() as { terminalId?: string } | undefined
    const terminalId = config?.terminalId ?? node.getId()
    return sessions.find((session) => session.sessionId === `terminal-${terminalId}`)?.agentId ?? null
  }
  return null
}

// A workspace with no layout renders nothing. That is decided here, above the
// body, rather than by an early return inside it: the body calls its hooks
// unconditionally, and a return ahead of them would change how many ran
// between one render and the next.
function WorkspaceLayout(props: Props) {
  const hasLayout = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === props.workspaceId)?.layoutModel != null)
  if (!hasLayout) return null
  return <WorkspaceLayoutBody {...props} />
}

function WorkspaceLayoutBody({
  workspaceId,
  onNewAgentTab,
  renderNewAgentPanel,
  conversationSessions: conversationSessionsProp = NO_CONVERSATION_SESSIONS,
}: Props) {
  const conversationSessions = useConversationTabSessions(conversationSessionsProp)
  const layoutModel = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.layoutModel)
  const workspaceMode = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.mode ?? 'standard')
  // The machine this workspace runs on, for the mark its chat and terminal
  // tabs wear when it is not this computer (owner ruling 2026-10-04). Read as
  // primitives so a write elsewhere on the workspace does not redraw the tabs.
  const workspaceHostId = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.hostId ?? null)
  const workspaceSshId = useWorkspaceStore((s) => {
    const environment = s.workspaces.find((w) => w.id === workspaceId)?.environment
    return environment?.kind === 'ssh' ? environment.id : null
  })
  const workspaceSshLabel = useWorkspaceStore((s) => {
    const environment = s.workspaces.find((w) => w.id === workspaceId)?.environment
    return environment?.kind === 'ssh' ? environment.label : null
  })
  const workspaceRemoteName = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.remoteOrigin?.machineName ?? null,
  )
  const workspaceMachineRef = useWorkspaceMachineRef(
    React.useMemo(
      () => ({
        hostId: workspaceHostId,
        environment:
          workspaceSshId && workspaceSshLabel
            ? { kind: 'ssh' as const, id: workspaceSshId, label: workspaceSshLabel }
            : null,
        remoteOrigin: workspaceRemoteName ? { machineName: workspaceRemoteName } : null,
      }),
      [workspaceHostId, workspaceRemoteName, workspaceSshId, workspaceSshLabel],
    ),
  )
  const workspaceMachineIdentity = useMachineIdentity(workspaceMachineRef)
  const workspaceMachineName =
    workspaceSshLabel ??
    workspaceRemoteName ??
    (workspaceHostId && isWslHostId(workspaceHostId)
      ? `WSL: ${distroOfHostId(workspaceHostId) ?? workspaceHostId}`
      : null)
  const machineMarks = useWorkspaceStore((s) => s.appSettings.machineMarks)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)
  const workspaceAgents = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.agents ?? EMPTY_WORKSPACE_AGENTS,
  )
  const editorOpenFiles = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.editorState?.openFiles ?? EMPTY_OPEN_FILES,
  )
  // Worktree-backed workspace (a worktree opened as a workspace). The branch
  // glyph is workspace-level on the tabs below: every
  // terminal/agent tab earns it when the workspace is worktree-backed, because
  // after the cwd-redirect slices every terminal actually runs in the worktree
  // (see the resolution in `renderTab`). Selected as primitives so the panel
  // doesn't re-render on unrelated workspace churn.
  //   - `worktreeGitRoot`: absolute git root of the workspace's worktree (null
  //      when not worktree-backed; otherwise it equals `folderPath`). The tab
  //      glyph condition + tooltip cwd.
  const worktreeGitRoot = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? (resolveWorkspaceWorktree(ws)?.gitRoot ?? null) : null
  })
  const worktreeBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? (resolveWorkspaceWorktree(ws)?.branch ?? null) : null
  })
  // A worktree-backed workspace's worktree can be removed out from under it
  // (merge cleanup, the Worktree manager, `git worktree prune`). When it is gone,
  // the tab glyph flips to the danger token and new terminals fall back to the
  // main checkout (Slices 2-3 enforce the fallback; this is the visible signal).
  // Checked on mount, whenever the resolved worktree root changes, and on window
  // focus — no polling loop, since a worktree only vanishes via an out-of-app
  // action the user returns to the window from.
  const [worktreeMissing, setWorktreeMissing] = useState(false)
  useEffect(() => {
    if (!worktreeGitRoot) {
      setWorktreeMissing(false)
      return
    }
    let cancelled = false
    const check = (): void => {
      void window.api.pathExists(worktreeGitRoot).then((exists) => {
        if (!cancelled) setWorktreeMissing(!exists)
      })
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      cancelled = true
      window.removeEventListener('focus', check)
    }
  }, [worktreeGitRoot])
  // This workspace's sessions only: an agent moving in another workspace
  // must not rebuild every tab here.
  const terminalSessions = useWorkspaceTerminalSessions(workspaceId)
  const updateLayout = useWorkspaceStore((s) => s.updateLayout)
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const setActiveFile = useWorkspaceStore((s) => s.setActiveFile)
  const setFocusedAgent = useWorkspaceStore((s) => s.setFocusedAgent)
  const setLastActiveAgent = useWorkspaceStore((s) => s.setLastActiveAgent)
  // The sessions, without making them a dependency of the selection callback:
  // the snapshot array changes on every terminal frame, and a callback rebuilt
  // that often would be a new `onModelChange` on every keystroke in a terminal.
  const terminalSessionsRef = useRef(terminalSessions)
  terminalSessionsRef.current = terminalSessions
  // The agent tab the layout is on, recorded as the workspace's focused agent
  // (sidebar-lists-every-terminal): the branch chip follows it. Read from the
  // model's active tabset rather than from `onAction`, because a tab is
  // selected programmatically as often as by a click — a fresh spawn, a
  // cross-workspace "Open agent", a reveal — and those go through the model
  // without an action the layout sees. flexlayout marks the selected tab's
  // tabset active on every select, so the active tabset's selected node IS
  // the tab the person is on. A no-op when it has not changed.
  //
  // It also records the workspace's LAST-ACTIVE AGENT (agent changelists),
  // which is a wider net: a plain terminal tab running an agent session counts
  // too, because the changelist the Diff surfaces default to is the agent's,
  // and which kind of tab that agent happens to be drawn in is not a fact the
  // diff cares about. `setFocusedAgent` keeps its narrower rule exactly.
  const followSelectedAgentTab = useCallback(
    (model: Model) => {
      const selected = model.getActiveTabset()?.getSelectedNode()
      if (!(selected instanceof TabNode)) return
      const agentId = agentIdOfTab(selected, terminalSessionsRef.current)
      if (agentId) setLastActiveAgent(workspaceId, agentId)
      if (selected.getComponent() !== 'agent') return
      const config = selected.getConfig() as { agentId?: string } | undefined
      setFocusedAgent(workspaceId, config?.agentId ?? selected.getId())
    },
    [setFocusedAgent, setLastActiveAgent, workspaceId],
  )
  const closeFile = useWorkspaceStore((s) => s.closeFile)
  // Keep a stable Model instance per workspace — re-creating it destroys drag/resize state
  const modelRef = useRef<Model | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const skipNextRenameCommitRef = useRef(false)
  const hideTabWithoutCleanupRef = useRef(new Set<string>())
  const killOnUnmountSessionIdsRef = useRef(new Set<string>())
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)

  if (!modelRef.current) {
    // Mounted only once the workspace has a layout (`WorkspaceLayout` above),
    // and built once; the empty model covers the render in which the layout
    // is removed, before the parent unmounts this body.
    modelRef.current = Model.fromJson(layoutModel ?? EMPTY_LAYOUT_MODEL)
    // Applied to EVERY model, not just newly-built ones: a persisted layout
    // carries its own `global` block. The splitter's width and grab area are
    // CSS (`--fl-splitter-size` in index.css), not model attributes.
    modelRef.current.doAction(Actions.updateModelAttributes({ tabEnableRename: false }))
  }

  useEffect(() => {
    logPerfEvent('WorkspaceLayout', 'workspace-layout-mounted', { workspaceId })
    return () => {
      logPerfEvent('WorkspaceLayout', 'workspace-layout-unmounted', { workspaceId })
    }
  }, [workspaceId])

  useEffect(() => {
    if (modelRef.current) {
      registerModel(workspaceId, modelRef.current)
      // Drain a flash latched by a cross-workspace "Open agent" before this
      // workspace's Model existed, now that it is registered.
      consumePendingAgentFlash(workspaceId)
      // Seed the focused agent from the restored layout's selected tab, so a
      // workspace opened from disk follows the agent it was left on rather
      // than waiting for the first click. A focus already recorded this
      // window (a workspace switched away from and back) stands.
      if (!useWorkspaceStore.getState().focusedAgentByWorkspaceId[workspaceId]) {
        followSelectedAgentTab(modelRef.current)
      }
    }
    return () => unregisterModel(workspaceId)
  }, [followSelectedAgentTab, workspaceId])

  useEffect(() => {
    if (!renamingTabId) return

    const input = renameInputRef.current
    if (!input) return

    input.focus()
    const caretPosition = input.value.length
    input.setSelectionRange(caretPosition, caretPosition)
  }, [renamingTabId])

  const shouldKillTerminalOnUnmount = useCallback((sessionId: string) => {
    const shouldKill = killOnUnmountSessionIdsRef.current.has(sessionId)
    if (shouldKill) killOnUnmountSessionIdsRef.current.delete(sessionId)
    return shouldKill
  }, [])

  const startRename = useCallback((event: React.MouseEvent, node: TabNode) => {
    event.preventDefault()
    event.stopPropagation()
    skipNextRenameCommitRef.current = false
    setRenamingTabId(node.getId())
    setRenameValue(node.getName())
  }, [])

  const commitRename = useCallback(() => {
    if (!renamingTabId) return

    if (skipNextRenameCommitRef.current) {
      skipNextRenameCommitRef.current = false
      setRenamingTabId(null)
      return
    }

    const nextName = renameValue.trim()
    const model = modelRef.current
    const node = model?.getNodeById(renamingTabId)

    if (nextName && node instanceof TabNode) {
      model?.doAction(Actions.renameTab(node.getId(), nextName))

      if (node.getComponent() === 'agent') {
        const config = node.getConfig() as { agentId?: string } | undefined
        updateAgent(workspaceId, config?.agentId ?? node.getId(), { name: nextName })
      }
    }

    setRenamingTabId(null)
  }, [renameValue, renamingTabId, updateAgent, workspaceId])

  useEffect(() => {
    const model = modelRef.current
    if (!model) return

    model.visitNodes((node) => {
      if (!(node instanceof TabNode)) return

      if (node.getComponent() !== 'agent') return

      const config = node.getConfig() as { agentId?: string } | undefined
      const agentId = config?.agentId ?? node.getId()
      const agent = workspaceAgents[agentId]
      if (agent?.name && node.getName() !== agent.name) {
        model.doAction(Actions.renameTab(node.getId(), agent.name))
      }
    })
  }, [workspaceAgents])

  // Capability-module gate. Host-registered panels (editor, git, memory-graph,
  // …) are gated generically in the factory's default case by their owning
  // module's enablement, so a disabled module's panel falls back to the explicit
  // DISABLED_SURFACE and PanelRail hides its button. Only the panels with
  // bespoke props (file-editor, git-conflict) need an explicit gated
  // arm below; those read enablement from this single overrides object.
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  // Read through a ref: the factory is not rebuilt when the launch surface's
  // renderer changes (it is absent while this layer is in the background, and
  // present once it is active), and a tab drawn later must use the current one.
  const renderNewAgentPanelRef = useRef(renderNewAgentPanel)
  renderNewAgentPanelRef.current = renderNewAgentPanel

  const factory = useCallback(
    (node: TabNode) => {
      // A remote pane saved under its pre-rename name renders as the same pane.
      const component = canonicalMeshPaneComponent(node.getComponent())
      const devToolsEnabled = selectModuleEnabled(moduleOverrides, 'dev-tools')
      const gitEnabled = selectModuleEnabled(moduleOverrides, 'git')
      const config = node.getConfig() as
        | {
            agentId?: string
            terminalId?: string
            filePath?: string
            repoRoot?: string
            checkForUpdatesRequestId?: number
            initialTab?: string
            highlightColor?: HighlightColor
            executionId?: string
            workspaceRoot?: string
            role?: string
            title?: string
            sessionId?: string
          }
        | undefined

      const wrapWithHighlight = (children: React.ReactNode): React.ReactNode => {
        if (component !== 'terminal' || !config?.highlightColor) return children
        const swatch = getHighlightSwatch(config.highlightColor)
        return (
          <div className="relative h-full w-full" style={{ boxShadow: `inset 0 0 0 1px ${swatch.hex}` }}>
            {children}
          </div>
        )
      }

      // Arms below are only for components the host can't serve generically:
      // the shell's own chrome (agent, terminal) and panels that take bespoke props
      // (file-editor's filePath, git-conflict's
      // paths).
      // Every plain `{ workspaceId }` host panel — editor, git,
      // memory-graph — falls
      // through to `default`, which renders it gated by its owning module.
      switch (component) {
        case 'agent':
          return timedPanel(
            'AgentPanel',
            <AgentPanel
              workspaceId={workspaceId}
              agentId={config?.agentId ?? node.getId()}
              sessionId={config?.sessionId}
              shouldKillTerminalOnUnmount={shouldKillTerminalOnUnmount}
            />,
          )
        case 'file-editor':
          return devToolsEnabled && config?.filePath
            ? timedPanel('EditorPanel', <EditorPanel workspaceId={workspaceId} filePath={config.filePath} />)
            : DISABLED_SURFACE
        case 'git-conflict':
          return gitEnabled && config?.repoRoot && config.filePath
            ? timedPanel(
                'GitConflictResolverPanel',
                <GitConflictResolverPanel repoRoot={config.repoRoot} filePath={config.filePath} />,
              )
            : DISABLED_SURFACE
        case 'terminal':
          return wrapWithHighlight(
            timedPanel(
              'PlainTerminalPanel',
              <PlainTerminalPanel
                workspaceId={workspaceId}
                terminalId={config?.terminalId ?? node.getId()}
                shouldKillOnUnmount={shouldKillTerminalOnUnmount}
              />,
            ),
          )
        // The tab the "+" opened, holding the launch surface until a spawn
        // retypes this same node into an agent tab. Nothing is created while it
        // is open, so a host that cannot spawn (no handler) renders nothing.
        case NEW_AGENT_TAB_COMPONENT:
          // The tab already wears the name its agent will take; the surface
          // hands it back on launch so the spawn adopts it.
          return (
            renderNewAgentPanelRef.current?.(node.getId(), (config as { agentName?: string } | undefined)?.agentName) ??
            null
          )
        // A conversation on another machine, in the regular chat view. Core
        // chrome, not a module: tailnet remote control is a built-in opt-in
        // feature, and a pane that vanished with a module toggle would strand a
        // person mid-conversation on another machine. (The Fleet panel, retired
        // on 2026-09-05, and the remote terminal pane, retired on 2026-09-29,
        // left persisted tabs behind; both take the default branch's
        // unavailable surface.)
        case MESH_CONVERSATION_COMPONENT: {
          const remote = config as
            | {
                connectionId?: string
                machineName?: string
                remoteWorkspaceId?: string
                remoteAgentId?: string
                title?: string
              }
            | undefined
          return remote?.connectionId && remote.remoteWorkspaceId && remote.remoteAgentId
            ? timedPanel(
                'RemoteConversationPanel',
                <RemoteConversationPanel
                  workspaceId={workspaceId}
                  connectionId={remote.connectionId}
                  machineName={remote.machineName ?? 'Remote machine'}
                  remoteWorkspaceId={remote.remoteWorkspaceId}
                  remoteAgentId={remote.remoteAgentId}
                  title={remote.title}
                />,
              )
            : DISABLED_SURFACE
        }
        default: {
          // Host-registered panels: render the registered component gated by its
          // owning module's enablement. A disabled module (or an unknown/stale
          // component) falls back to the explicit unavailable surface.
          const host = getRendererHost()
          const Panel = component ? host.getPanel(component) : undefined
          if (!Panel) {
            // No registered panel: usually a stale tab, but when the component
            // id's `<moduleId>.` prefix names a known marketplace module the
            // owning module is missing, and the tab upgrades to the explicit
            // not-installed surface with the install path.
            return component ? (
              <MissingModulePanelSurface
                componentId={component}
                fallback={DISABLED_SURFACE}
                onOpenMarketplace={() => openSettingsOverlay({ initialTab: EXTENSIONS_BROWSE_DEEPLINK })}
              />
            ) : (
              DISABLED_SURFACE
            )
          }
          const moduleId = host.getPanelModule(component!)
          if (moduleId && !selectModuleEnabled(moduleOverrides, moduleId)) return DISABLED_SURFACE
          // Outside the Suspense, so a chunk that fails to load is contained
          // with a render throw: either stays in this tab.
          return (
            <ModuleContributionBoundary
              moduleId={moduleId ?? component!}
              surface={`panel "${component}"`}
              variant="panel"
              label={node.getName()}
            >
              {timedPanel(component!, <Panel workspaceId={workspaceId} />)}
            </ModuleContributionBoundary>
          )
        }
      }
    },
    [moduleOverrides, openSettingsOverlay, shouldKillTerminalOnUnmount, workspaceId],
  )

  const cleanupNode = useCallback(
    (node: TabNode) => {
      const config = node.getConfig() as
        { agentId?: string; sessionId?: string; terminalId?: string; filePath?: string } | undefined
      if (node.getComponent() === 'file-editor') {
        if (config?.filePath) closeFile(workspaceId, config.filePath)
        return
      }

      if (node.getComponent() === 'agent') {
        const agentId = config?.agentId ?? node.getId()
        const agent = workspaceAgents[agentId]
        const sessionIds = new Set<string>()
        if (config?.sessionId) sessionIds.add(config.sessionId)
        if (agent?.cliSessionId) sessionIds.add(agent.cliSessionId)
        terminalSessions
          .filter(
            (session) => session.kind === 'agent' && session.workspaceId === workspaceId && session.agentId === agentId,
          )
          .forEach((session) => sessionIds.add(session.sessionId))
        sessionIds.forEach((sessionId) => {
          killOnUnmountSessionIdsRef.current.add(sessionId)
          void window.api.terminalKill(sessionId).catch(() => {})
        })
        if (agent) {
          updateAgent(workspaceId, agentId, {
            cliStartRequested: false,
            cliHasLaunched: false,
            cliOnboardingPromptSent: false,
            cliResumeAvailable: false,
            cliSessionId: undefined,
          })
        }
        return
      }

      if (node.getComponent() === 'terminal') {
        const terminalId = config?.terminalId ?? node.getId()
        const sessionIds = new Set<string>([`terminal-${terminalId}`])
        terminalSessions
          .filter(
            (session) =>
              session.kind === 'terminal' && session.workspaceId === workspaceId && session.terminalId === terminalId,
          )
          .forEach((session) => sessionIds.add(session.sessionId))
        sessionIds.forEach((sessionId) => {
          killOnUnmountSessionIdsRef.current.add(sessionId)
          void window.api.terminalKill(sessionId).catch(() => {})
        })
      }
    },
    [closeFile, terminalSessions, updateAgent, workspaceAgents, workspaceId],
  )

  const handleAction = useCallback(
    (action: Action) => {
      // Removing a tabset hands its weight back to flexlayout, which spreads it
      // across every remaining sibling — including the strip-less nav rail on
      // the left (Knowledge Graph), which would otherwise grow when a terminal
      // beside it is closed. Snapshot the rails'
      // widths before the deletion applies, then re-pin them once the model has
      // settled so the freed space goes to the editor/terminal siblings instead.
      if (action.type === Actions.DELETE_TAB || action.type === Actions.DELETE_TABSET) {
        const model = modelRef.current
        const railFractions = model ? captureRailWidthFractions(model) : null
        if (railFractions != null) {
          queueMicrotask(() => {
            const current = modelRef.current
            if (current) restoreRailWidthFractions(current, railFractions)
          })
        }
      }

      if (action.type === Actions.DELETE_TAB) {
        const node = modelRef.current?.getNodeById(action.data.node)
        const nodeId = node?.getId() ?? String(action.data.node ?? '')
        const preserveRuntime = (action.data as Record<string, unknown>).__sprintenginePreserveRuntime === true
        if (preserveRuntime) {
          hideTabWithoutCleanupRef.current.delete(nodeId)
        } else if (hideTabWithoutCleanupRef.current.has(nodeId)) {
          hideTabWithoutCleanupRef.current.delete(nodeId)
        } else if (node instanceof TabNode) {
          // The strip's own close; Primary+W remembers in closeActiveLayoutTab.
          rememberClosedLayoutTab(workspaceId, {
            component: node.getComponent(),
            config: node.getConfig(),
            name: node.getName(),
          })
          cleanupNode(node)
        }
      }

      if (action.type === Actions.SELECT_TAB) {
        const node = modelRef.current?.getNodeById(action.data.tabNode)
        if (node instanceof TabNode && node.getComponent() === 'file-editor') {
          const config = node.getConfig() as { filePath?: string } | undefined
          if (config?.filePath) setActiveFile(workspaceId, config.filePath)
        }
      }

      if (action.type === Actions.RENAME_TAB) {
        const node = modelRef.current?.getNodeById(action.data.node)
        if (node instanceof TabNode && node.getComponent() === 'agent') {
          const config = node.getConfig() as { agentId?: string } | undefined
          const agentId = config?.agentId ?? node.getId()
          const nextName = String(action.data.text ?? '').trim()
          if (nextName) updateAgent(workspaceId, agentId, { name: nextName })
        }
      }

      if (action.type === Actions.DELETE_TABSET) {
        const node = modelRef.current?.getNodeById(action.data.node)
        if (node instanceof TabSetNode) {
          node.getChildren().forEach((child) => {
            if (child instanceof TabNode && child.isEnableClose()) {
              cleanupNode(child)
            }
          })
        }
      }

      return action
    },
    [cleanupNode, setActiveFile, updateAgent, workspaceId],
  )

  const closeTabWithCleanup = useCallback(
    (node: TabNode) => {
      cleanupNode(node)
      const model = modelRef.current
      if (model) deleteTabPreservingRails(model, node.getId())
    },
    [cleanupNode],
  )

  const handleAuxMouseClick = useCallback<NodeMouseEvent>(
    (node, event) => {
      if (event.button !== 1 || !(node instanceof TabNode) || !node.isEnableClose()) return

      event.preventDefault()
      event.stopPropagation()
      closeTabWithCleanup(node)
    },
    [closeTabWithCleanup],
  )

  const findTabNodeFromElement = useCallback((element: Element): TabNode | null => {
    const tabButton = element.closest<HTMLElement>('.flexlayout__tab_button')
    const tabPath = tabButton?.getAttribute('data-layout-path')
    const model = modelRef.current
    if (!tabPath || !model) return null

    let result: TabNode | null = null
    model.visitNodes((node) => {
      if (result || !(node instanceof TabNode)) return
      if (node.getPath() === tabPath) result = node
    })
    return result
  }, [])

  const handleMouseDownCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 1) return
      if (!(event.target instanceof Element)) return

      const node = findTabNodeFromElement(event.target)
      if (!node || !node.isEnableClose()) return
      event.preventDefault()
      event.stopPropagation()
      closeTabWithCleanup(node)
    },
    [closeTabWithCleanup, findTabNodeFromElement],
  )

  const closeOtherTabsInSet = useCallback(
    (node: TabNode) => {
      const parent = node.getParent()
      if (!(parent instanceof TabSetNode)) return

      parent.getChildren().forEach((child) => {
        if (!(child instanceof TabNode) || child.getId() === node.getId() || !child.isEnableClose()) return
        closeTabWithCleanup(child)
      })
    },
    [closeTabWithCleanup],
  )

  const hideAllAgentTabs = useCallback(() => {
    const model = modelRef.current
    if (!model) return
    const agentNodeIds: string[] = []
    model.visitNodes((candidate) => {
      if (candidate instanceof TabNode && candidate.getComponent() === 'agent') {
        agentNodeIds.push(candidate.getId())
      }
    })
    agentNodeIds.forEach((nodeId) => {
      hideTabWithoutCleanupRef.current.add(nodeId)
      deleteTabPreservingRails(model, nodeId)
    })
  }, [])

  const hideTab = useCallback((node: TabNode) => {
    if (node.getComponent() !== 'agent') return
    hideTabWithoutCleanupRef.current.add(node.getId())
    const parent = node.getParent()
    const model = modelRef.current
    if (model) deleteTabPreservingRails(model, node.getId())

    // The hide button is removed with the tab, leaving focus on <body>; hand it back to the new active tab.
    if (!(parent instanceof TabSetNode)) return
    const parentPath = parent.getPath()
    requestAnimationFrame(() => {
      const escapedPath = parentPath.replace(/"/gu, '\\"')
      const tabsetEl = document.querySelector<HTMLElement>(`[data-layout-path="${escapedPath}"]`)
      const nextActive =
        tabsetEl?.querySelector<HTMLElement>('.flexlayout__tab_button--selected') ??
        tabsetEl?.querySelector<HTMLElement>('.flexlayout__tab_button')
      nextActive?.focus()
    })
  }, [])

  // The tab strip's right-click menu. It was a native Electron popup,
  // which meant the tab colour picker could only offer the seven highlights as
  // Title-Cased checkbox rows of their NAMES — the same choice the workspace
  // sidebar has always made as a row of swatches. Availability is sampled at
  // open time; nothing here can change while the menu is up.
  const openTabContextMenu = useCallback(
    (event: React.MouseEvent, node: TabNode) => {
      event.preventDefault()
      event.stopPropagation()

      const parent = node.getParent()
      const otherClosableTabs =
        parent instanceof TabSetNode
          ? parent
              .getChildren()
              .filter((child) => child instanceof TabNode && child.getId() !== node.getId() && child.isEnableClose())
          : []

      let agentTabCount = 0
      modelRef.current?.visitNodes((candidate) => {
        if (candidate instanceof TabNode && candidate.getComponent() === 'agent') agentTabCount += 1
      })

      const config = node.getConfig() as { highlightColor?: HighlightColor; agentId?: string } | undefined
      const tabAgentId = node.getComponent() === 'agent' ? (config?.agentId ?? node.getId()) : null
      const store = useWorkspaceStore.getState()
      const tabAgent = tabAgentId
        ? store.workspaces.find((workspace) => workspace.id === workspaceId)?.agents[tabAgentId]
        : undefined

      setTabMenu({
        x: event.clientX,
        y: event.clientY,
        node,
        canHideTab: node.getComponent() === 'agent',
        canHideAllTabs: agentTabCount > 0,
        canCloseOtherTabs: otherClosableTabs.length > 0,
        isTerminal: node.getComponent() === 'terminal',
        currentColor: config?.highlightColor ?? null,
        resumableChatId: tabAgentId && chatResumesInTerminal(tabAgent, store.pluginCatalogEntries) ? tabAgentId : null,
        agentId: tabAgentId,
        chatId: tabAgentId && tabAgent?.runtimeKind === 'conversation' ? tabAgentId : null,
      })
    },
    [workspaceId],
  )

  const setTabHighlightColor = useCallback((node: TabNode, nextColor: HighlightColor | undefined) => {
    const nextConfig = { ...node.getConfig(), highlightColor: nextColor }

    // Preserve any existing non-highlight class names on the tab while we
    // replace the tab-highlight-* class.
    const existingClassName = node.getClassName() ?? ''
    const baseClassNames = existingClassName.split(/\s+/u).filter((cls) => cls && !cls.startsWith('tab-highlight-'))
    if (nextColor) baseClassNames.push(`tab-highlight-${nextColor}`)
    const nextClassName = baseClassNames.join(' ').trim() || undefined

    modelRef.current?.doAction(
      Actions.updateNodeAttributes(node.getId(), {
        config: nextConfig,
        className: nextClassName,
      }),
    )
  }, [])

  const renderTab = useCallback(
    (node: TabNode, renderValues: ITabRenderValues) => {
      // Prepend a worktree branch glyph to a tab's leading slot (preserving any
      // identity/highlight icon) when this tab's workspace is worktree-
      // backed. `wt` is the resolved worktree (null → no glyph); its `cwd` is
      // surfaced in the hover tooltip so the worktree's location is discoverable.
      // When `missing`, the worktree directory is gone: the glyph switches to the
      // danger token and the tooltip explains new terminals fall back to the main
      // checkout. The tooltip text carries the missing state independent of color
      // (a11y — pairs with the in-terminal fallback banner).
      const withWorktreeGlyph = (
        existing: React.ReactNode,
        wt: { cwd: string | null; branch: string | null } | null,
        missing = false,
        // The missing tooltip for an OBSERVED directory that vanished: the
        // default sentence describes the workspace worktree's spawn fallback,
        // which is not a promise about a per-agent directory.
        missingTitle?: string,
      ): React.ReactNode => {
        if (!wt) return existing
        const heading = wt.branch ? `Worktree · ${wt.branch}` : 'Running in a git worktree'
        const title = missing
          ? (missingTitle ?? `Worktree removed — ${wt.cwd ?? ''}\nNew terminals open in the main checkout.`)
          : wt.cwd
            ? `${heading}\n${wt.cwd}`
            : heading
        const glyph = (
          <span
            role="img"
            className={`flex h-4 w-3.5 shrink-0 items-center justify-center ${missing ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-muted)]'}`}
            title={title}
            aria-label={title}
          >
            <GitBranchGlyph className="icon-sm" />
          </span>
        )
        return existing ? (
          <span className="flex shrink-0 items-center gap-1">
            {glyph}
            {existing}
          </span>
        ) : (
          glyph
        )
      }

      // A tab whose pane paints --agent-surface — a chat, the New chat surface,
      // a chat on another machine — says so on its label, and index.css paints
      // the tab strip that ground while that tab is the selected one. The pane
      // is not inside the tabset in FlexLayout's DOM, so the label is the only
      // place the strip can learn what it sits over.
      const tabComponent = node.getComponent()
      const tabAgent =
        tabComponent === 'agent'
          ? workspaceAgents[(node.getConfig() as { agentId?: string } | undefined)?.agentId ?? node.getId()]
          : undefined
      const tabSurface =
        tabComponent === NEW_AGENT_TAB_COMPONENT ||
        tabComponent === MESH_CONVERSATION_COMPONENT ||
        (tabAgent !== undefined && normalizeAgentRuntime(tabAgent).runtimeKind === 'conversation')
          ? 'agent'
          : undefined

      if (renamingTabId === node.getId()) {
        renderValues.content = (
          <input
            ref={renameInputRef}
            data-tab-surface={tabSurface}
            className="flexlayout__tab_button_textbox"
            type="text"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitRename()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                skipNextRenameCommitRef.current = true
                event.currentTarget.blur()
                setRenamingTabId(null)
              }
              event.stopPropagation()
            }}
          />
        )
        return
      }

      const canRenameTab = node.getComponent() !== 'file-editor'
      const canDragOut = node.isEnableClose()
      const handleTabDragStart = canDragOut
        ? (event: React.DragEvent<HTMLSpanElement>) => {
            const rawConfig = node.getConfig()
            const payload = serializeTabDragPayload({
              sourceWorkspaceId: workspaceId,
              tabId: node.getId(),
              component: node.getComponent() ?? '',
              name: node.getName(),
              config: rawConfig && typeof rawConfig === 'object' ? (rawConfig as Record<string, unknown>) : null,
              className: node.getClassName() ?? null,
            })
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData(TAB_DRAG_MIME, payload)
            event.dataTransfer.setData('text/plain', node.getName())
          }
        : undefined
      // Dragging a file-editor tab out of the app window pops the file into the
      // external editor window. Drops inside the window fall through to
      // FlexLayout's own tab handling.
      const handleTabDragEnd =
        canDragOut && node.getComponent() === 'file-editor'
          ? (event: React.DragEvent<HTMLSpanElement>) => {
              const left = window.screenX
              const top = window.screenY
              const outside =
                event.screenX < left ||
                event.screenX > left + window.outerWidth ||
                event.screenY < top ||
                event.screenY > top + window.outerHeight
              if (!outside) return
              const config = node.getConfig() as { filePath?: string } | undefined
              const filePath = config?.filePath
              if (!filePath) return
              // Moves this file; where files open next is Settings' call.
              void openExternalFileWindow({ workspaceId, path: filePath, name: node.getName() })
              deleteTabPreservingRails(node.getModel(), node.getId())
            }
          : undefined
      // A live PTY bolds the tab name, mirroring the sidebar's resident-workspace
      // bolding (font-semibold) so suspended/exited terminals read as the quieter
      // state. Covers plain terminals and agent terminals; editors and panels have
      // no liveness and stay normal weight. Uses the same session lookup the status
      // dot below uses, so weight and dot never disagree.
      const tabComponentId = node.getComponent()
      let liveTabSession: TerminalSessionSnapshot | undefined
      if (tabComponentId === 'terminal') {
        const cfg = node.getConfig() as { terminalId?: string } | undefined
        liveTabSession = terminalSessions.find((s) => s.sessionId === `terminal-${cfg?.terminalId ?? node.getId()}`)
      } else if (tabComponentId === 'agent') {
        const cfg = node.getConfig() as { agentId?: string; sessionId?: string } | undefined
        const aId = cfg?.agentId ?? node.getId()
        const sId = cfg?.sessionId ?? workspaceAgents[aId]?.cliSessionId
        liveTabSession = sId ? terminalSessions.find((s) => s.sessionId === sId) : undefined
      }
      const tabConversation =
        tabComponentId === 'agent'
          ? conversationSessions.find(
              (session) =>
                session.agentId === ((node.getConfig() as { agentId?: string } | undefined)?.agentId ?? node.getId()),
            )
          : undefined
      const isLiveTab = Boolean(
        liveTabSession?.processAlive || (tabConversation && tabConversation.status !== 'stopped'),
      )

      // A remote pane's tab says its agent's name, and the machine mark after
      // it says where it runs (`remotePaneTabLabel`).
      if (isMeshConversationPane(tabComponentId))
        renderValues.content = remotePaneTabLabel(
          node.getName(),
          (node.getConfig() as { machineName?: string } | undefined)?.machineName,
        )

      const tabNameSpan = (
        <span
          className={`min-w-0 truncate ${isLiveTab ? 'font-semibold' : ''}`}
          data-tab-surface={tabSurface}
          draggable={canDragOut}
          onDragStart={handleTabDragStart}
          onDragEnd={handleTabDragEnd}
          onContextMenu={(event) => openTabContextMenu(event, node)}
          onDoubleClick={canRenameTab ? (event) => startRename(event, node) : undefined}
        >
          {renderValues.content}
        </span>
      )

      // Hovering a terminal/agent tab reveals the last message sent to it — the
      // tab's own name never says what the work was. Only wrapped when there IS
      // a captured prompt: a tab with none must behave exactly as before, with
      // no empty popover and no added hover latency. Editors and panels have no
      // session, so `liveTabSession` is undefined and they fall straight through.
      const tabPrompt = liveTabSession?.lastPrompt
      const tabContent = tabPrompt ? (
        <TabPromptPeek prompt={tabPrompt} tabLabel={node.getName()}>
          {tabNameSpan}
        </TabPromptPeek>
      ) : (
        tabNameSpan
      )

      if (node.getComponent() === 'file-editor') {
        const config = node.getConfig() as { filePath?: string } | undefined
        const file = editorOpenFiles.find((openFile) => openFile.path === config?.filePath)
        renderValues.content = (
          <span className="inline-flex min-w-0 items-center gap-1">
            {tabContent}
            {file?.isDirty && (
              <span
                className="shrink-0 text-[color:var(--tone-warn)]"
                aria-label="Unsaved changes"
                title="Unsaved changes"
              >
                •
              </span>
            )}
          </span>
        )
        return
      }

      if (node.getComponent() !== 'agent') {
        const componentId = node.getComponent()
        if (componentId === 'terminal') {
          const config = node.getConfig() as { highlightColor?: HighlightColor; terminalId?: string } | undefined
          if (config?.highlightColor) {
            const swatch = getHighlightSwatch(config.highlightColor)
            renderValues.leading = (
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: swatch.hex }}
                aria-label={`${swatch.label} terminal`}
                title={`${swatch.label} terminal`}
              />
            )
          }
          // Workspace-level: every plain terminal in a worktree-backed workspace
          // runs in the worktree (the cwd-redirect slices), so all of them earn
          // the glyph — not just folder-is-a-worktree workspaces.
          renderValues.leading = withWorktreeGlyph(
            renderValues.leading,
            worktreeGitRoot ? { cwd: worktreeGitRoot, branch: worktreeBranch } : null,
            worktreeMissing,
          )
          const terminalId = config?.terminalId ?? node.getId()
          const session = terminalSessions.find((s) => s.sessionId === `terminal-${terminalId}`)
          const indicator = renderTerminalRecencyIndicator(session)
          if (indicator) {
            renderValues.content = (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {tabContent}
                {workspaceMachineIdentity && workspaceMachineName
                  ? tabMachineMark(workspaceMachineIdentity, workspaceMachineName)
                  : null}
                {indicator}
              </span>
            )
            return
          }
        } else if (isMeshConversationPane(componentId)) {
          // A pane on another machine's conversation is a chat, and wears the
          // machine's own mark after its name (remote-sessions-in-the-sidebar,
          // epic decision 4; owner ruling 2026-10-04): the same message means
          // different things on two machines, and the tab's name alone is one
          // truncation away from not saying so.
          const config = node.getConfig() as { machineName?: string } | undefined
          renderValues.leading = (
            <span className={`${TAB_CHIP_CLASS} text-[color:var(--text-muted)]`} title="Chat" aria-label="Chat">
              <ChatGlyph className={TAB_CHIP_GLYPH_CLASS} />
            </span>
          )
          const identity = config?.machineName
            ? resolveMachineIdentity({ kind: 'paired', name: config.machineName }, machineMarks)
            : null
          renderValues.content = (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {tabContent}
              {tabMachineMark(identity, config?.machineName ?? 'a paired machine')}
            </span>
          )
          return
        }
        // A terminal in a workspace on another machine says which one.
        if (componentId === 'terminal' && workspaceMachineIdentity && workspaceMachineName) {
          renderValues.content = (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {tabContent}
              {tabMachineMark(workspaceMachineIdentity, workspaceMachineName)}
            </span>
          )
          return
        }
        renderValues.content = tabContent
        return
      }

      const config = node.getConfig() as { agentId?: string; sessionId?: string } | undefined
      const agentId = config?.agentId ?? node.getId()
      const agent = workspaceAgents[agentId]
      const conversation = conversationSessions.find((session) => session.agentId === agentId)
      const conversationPhase = conversation ? conversationSummaryPhase(conversation) : null
      const agentSessionId = conversation?.sessionId ?? config?.sessionId ?? agent?.cliSessionId
      const agentSession = agentSessionId ? terminalSessions.find((s) => s.sessionId === agentSessionId) : undefined
      const isWorking =
        conversationPhase === 'running' || conversationPhase === 'starting' || isSessionWorking(agentSession)
      const activityDot: AgentTabActivityDot | null =
        conversationPhase === 'waiting_for_approval'
          ? { tone: 'warn', pulse: false, label: 'Needs approval' }
          : conversationPhase === 'waiting_for_input'
            ? { tone: 'warn', pulse: false, label: 'Asked a question' }
            : conversationPhase === 'failed'
              ? { tone: 'error', pulse: false, label: 'Failed' }
              : isWorking
                ? { tone: 'good', pulse: true, label: 'Working' }
                : agentTabStatusDot(agentSession)

      // A chat names the CLI it rides with the same brand mark a terminal
      // agent's tab wears: which harness is the at-a-glance fact, and chat or
      // terminal is what the pane itself already shows. The live session's
      // provider wins over the agent record's, since a chat can switch models
      // (and with them providers) after launch. A provider that is not a CLI
      // keeps the chat glyph.
      const conversationCli =
        agent?.runtimeKind === 'conversation'
          ? cliForConversationProvider(conversation?.providerId ?? agent.conversation?.providerId)
          : null
      if (agent?.runtimeKind === 'conversation' && conversationCli) {
        const runtimeLabel = `${labelForCliRuntime(conversationCli)} chat`
        renderValues.leading = (
          <span
            className={`${TAB_CHIP_CLASS} text-[color:var(--text-muted)]`}
            title={runtimeLabel}
            aria-label={runtimeLabel}
          >
            <CliIcon cli={conversationCli} className={TAB_CHIP_GLYPH_CLASS} />
          </span>
        )
      } else if (agent?.runtimeKind === 'conversation') {
        renderValues.leading = (
          <span className={`${TAB_CHIP_CLASS} text-[color:var(--text-muted)]`} title="Chat" aria-label="Chat agent">
            <ChatGlyph className={TAB_CHIP_GLYPH_CLASS} />
          </span>
        )
      } else if (agent?.cli) {
        // The tab's otherwise-empty leading slot carries the runtime brand mark (Claude Code / Codex / OpenCode) — the
        // at-a-glance "which harness" signal. The exact model lives in the hover
        // popout, since models carry no icon.
        const runtimeLabel = `${labelForCliRuntime(agent.cli)} runtime`
        renderValues.leading = (
          <span
            className={`${TAB_CHIP_CLASS} text-[color:var(--text-muted)]`}
            title={runtimeLabel}
            aria-label={runtimeLabel}
          >
            <CliIcon cli={agent.cli} className={TAB_CHIP_GLYPH_CLASS} />
          </span>
        )
      } else {
        renderValues.leading = null
      }
      // Where the agent runs: the ONE resolution every surface shares
      // (agentCheckout.ts) — observed first, launch intent until git answers.
      // The hover path is the observed cwd itself (where the agent sits, which
      // may be a subdirectory of the checkout), never the git root.
      const observed = agentSession?.observedCheckout
      const agentCheckout: AgentTabCheckout | null = agentCheckoutOf(agentSession, {
        workspaceWorktree: worktreeGitRoot ? { gitRoot: worktreeGitRoot, branch: worktreeBranch } : null,
        execution: agent?.execution ?? null,
      })
      // The tab glyph marks a worktree, in the danger tone when its directory
      // is gone: the workspace-level focus-time check covers a launch-intent
      // worktree and an observed one at the same root; git's own answer covers
      // an observed directory that vanished (kind 'missing').
      // git answers forward-slashed on every platform (`C:/…`) while the
      // workspace root keeps the OS separator, so compare with one separator.
      const slashed = (value: string) => value.replace(/\\/g, '/')
      const observedAtWorkspaceWorktree = Boolean(
        observed?.gitRoot && worktreeGitRoot && samePath(slashed(observed.gitRoot), slashed(worktreeGitRoot)),
      )
      const agentWorktree =
        agentCheckout?.kind === 'worktree'
          ? { cwd: agentCheckout.cwd, branch: agentCheckout.branch }
          : agentCheckout?.kind === 'missing'
            ? { cwd: agentCheckout.cwd, branch: null }
            : null
      const agentWorktreeMissing =
        agentCheckout?.kind === 'missing' ||
        (agentCheckout?.kind === 'worktree' &&
          worktreeMissing &&
          (!agentCheckout.observed || observedAtWorkspaceWorktree))
      if (agent?.runtimeKind !== 'conversation') {
        renderValues.leading = withWorktreeGlyph(
          renderValues.leading,
          agentWorktree,
          agentWorktreeMissing,
          agentCheckout?.kind === 'missing' ? `Directory removed — ${agentCheckout.cwd}` : undefined,
        )
      }

      // Recency only when NOT working: an active agent shows the working mark
      // instead.
      //
      // The workspace's persisted keystroke clock is read off the store here
      // rather than subscribed to: it moves on terminal input, and a
      // subscription re-rendered the whole layout to redraw one tab's label.
      // It is only the fallback for an agent with no live session, and a live
      // session's broadcast is what re-runs this callback anyway.
      const lastTerminalActivityAt =
        useWorkspaceStore.getState().workspaces.find((w) => w.id === workspaceId)?.lastTerminalActivityAt ?? null
      //
      // A chat has no terminal session and never moves the keystroke clock, so
      // it counts from when its last turn ended instead, as the time alone.
      const conversationFinished = conversation ? conversationFinishedAt(conversation) : null
      const agentRecency = isWorking
        ? null
        : conversation
          ? conversationFinished !== null
            ? { at: conversationFinished, source: 'finished' as const }
            : null
          : pickAgentTabRecency(agentSession, lastTerminalActivityAt, agent?.cliLastExitedAt)
      // The chip on the tab and the card's status line each keep their own
      // time (`TabRecencyText`, and the card's `aged` label), so neither
      // freezes at the moment the tab was last drawn.
      const recencyIndicator =
        agentRecency !== null ? (
          <TabRecencyText at={agentRecency.at} label={tabRecencyLabel(agentRecency.source)} />
        ) : null

      // The conversation's prompt cache: a chat's from its runtime, a
      // terminal's from its own status line. The tab marks it once it is about
      // to go cold or has, since an open tab is the chat most likely to be
      // resumed; its card says what that costs and offers to compact.
      const agentPromptCache = conversation?.promptCache ?? agentSession?.promptCache ?? null

      // Trailing status treatment: the activity dot, plus recency while idle.
      // Working wears the working mark, the same mark the sidebar row and the
      // tab's own card use, so "working" reads one way everywhere.
      const trailing = (
        <>
          {activityDot ? (
            activityDot.tone === 'good' && activityDot.pulse ? (
              <WorkingMark label={activityDot.label} seed={agentSessionId ?? undefined} />
            ) : (
              <StatusDot tone={activityDot.tone} pulse={activityDot.pulse} label={activityDot.label} />
            )
          ) : null}
          {recencyIndicator}
          <PromptCacheMark reading={agentPromptCache} working={isWorking} />
        </>
      )

      // Everything needed to identify this agent, surfaced in the hover/focus
      // popout wrapping the tab content: the exact model, the session id, and
      // the conversation itself. No runtime line — it repeated the mark on the
      // tab — and no checkout line, which repeated the branch on the topbar.
      // Paused wins its own self-contained label (with elapsed time) so the
      // popout reads "Paused · 13m" without leaning on the tab's recency chip.
      // Otherwise mirror the tab dot, then the honest recency source
      // (Idle / Last activity / Exited, or a chat's bare time) — never a
      // blanket "Idle".
      // The corner's state, in the card's own three kinds. `working` is the
      // working mark the tab wears; `attention` is Failed and Paused, which
      // are worth the same weight without claiming motion; every other answer
      // is a chat at rest. The card draws the sidebar's working
      // mark for `working` and never a status dot — the row and the card have
      // to say "working" the same way (mockup frame 2).
      const identityStatus: AgentTabIdentity['status'] = agentSession?.suspended
        ? {
            kind: 'attention',
            label: 'Paused',
            ...(agentRecency !== null ? { aged: { label: 'Paused', since: agentRecency.at } } : {}),
          }
        : activityDot
          ? {
              // Paused (the only neutral dot) is answered above, so any other
              // dot is either working or a failure.
              kind: activityDot.tone === 'good' && activityDot.pulse ? 'working' : 'attention',
              label: activityDot.label,
            }
          : agentRecency !== null
            ? {
                kind: 'idle',
                label: 'Idle',
                aged: { label: tabRecencyLabel(agentRecency.source), since: agentRecency.at },
              }
            : { kind: 'idle', label: 'Idle' }
      // The tab's card is about the tab's OWN agent, so the session snapshot it
      // reads is that agent's — the ledger, the subagent count and the context
      // reading all belong to one session and none of them merge.
      const agentSnapshot = agentSessionId
        ? terminalSessions.find((session) => session.sessionId === agentSessionId)
        : undefined
      const agentIdentity: AgentTabIdentity = {
        name: agent?.name ?? node.getName(),
        status: identityStatus,
        agent: {
          // A tab whose agent main has no SESSION for still gets a card: the id
          // is what the peek asks about, and main answers `unknown` for one it
          // holds no state for, which is the card's own arm. A tab with no id at
          // ALL — an agent that has never launched — opens nothing, because
          // there is nothing to ask, and the alternative the roster used to take
          // was to open the card on a SIBLING agent's conversation.
          sessionId: agentSessionId ?? '',
          agentId,
          cli: agent?.cli ?? null,
          model: conversation?.modelId ?? agent?.cliModel ?? null,
          // The tab anchor shows the same head as the sidebar anchor because
          // both feed one card: the pull requests are this agent's session's,
          // exactly as its context reading is.
          pullRequests: agentSnapshot?.pullRequests ?? [],
          activeSubagents: agentSnapshot?.activeSubagents ?? 0,
          contextUsage: agentSnapshot?.contextUsage ?? null,
        },
      }

      // The identity card IS the conversation peek, so the agent tab takes the
      // bare name — wrapping `tabContent` in TabPromptPeek here would open a
      // second hover surface UNDER this card and leave the two fighting over
      // the same pointer. Plain terminal tabs, which have no identity card,
      // keep that peek as their only reveal.
      renderValues.content = (
        <AgentTabIdentityPopover
          identity={agentIdentity}
          // What the card's pull request lookup is coalesced by (epic decision
          // 8a): the branch main last OBSERVED this session on, not the branch
          // the agent was launched onto. Nothing draws it — the card carries no
          // checkout — it only keys the ask, so a session that moves branch is
          // asked about again instead of being answered from the old reading.
          lookupBranch={agentSnapshot?.observedCheckout?.branch ?? null}
        >
          {tabNameSpan}
          {workspaceMachineIdentity && workspaceMachineName
            ? tabMachineMark(workspaceMachineIdentity, workspaceMachineName)
            : null}
          {trailing}
        </AgentTabIdentityPopover>
      )
    },
    [
      commitRename,
      editorOpenFiles,
      hideTab,
      moduleOverrides,
      renameValue,
      renamingTabId,
      openTabContextMenu,
      startRename,
      terminalSessions,
      conversationSessions,
      workspaceAgents,
      worktreeBranch,
      worktreeGitRoot,
      worktreeMissing,
      workspaceId,
      workspaceMachineIdentity,
      workspaceMachineName,
      machineMarks,
    ],
  )

  const handleContextMenu = useCallback<NodeMouseEvent>(
    (node, event) => {
      if (!(node instanceof TabNode)) return
      event.preventDefault()
      event.stopPropagation()
      openTabContextMenu(event, node)
    },
    [openTabContextMenu],
  )

  // The tab strip's "+". It rides the tabsets that host agents and
  // terminals — never a rail pane, whose strip is chrome for a panel, and never
  // an editor-only column, where a new agent has nothing to do with the files
  // beside it. Sticky, so it stays put when the tabs overflow and scroll.
  const renderTabSet = useCallback<(tabSetNode: TabSetNode | BorderNode, values: ITabSetRenderValues) => void>(
    (tabSetNode, values) => {
      if (!onNewAgentTab) return
      if (!(tabSetNode instanceof TabSetNode)) return
      if (tabSetNode.getChildren().length === 0) return
      const hostsAgents = tabSetNode.getChildren().some((child) => {
        if (!(child instanceof TabNode)) return false
        const component = child.getComponent()
        return component === 'agent' || component === 'terminal' || component === NEW_AGENT_TAB_COMPONENT
      })
      if (!hostsAgents) return
      values.stickyButtons.push(
        <Tooltip key="new-agent" content="New agent" placement="bottom">
          {/* `GHOST_TONE.quiet` is this control's rest ink exactly —
              `--text-disabled`, lifting on `--bg-hover` — which is what keeps a
              sticky control from competing with the tab labels beside it. */}
          <IconButton
            tone="quiet"
            aria-label="New agent"
            onClick={(event) => {
              // The strip's own click handler would select whatever tab sits
              // under the button; this is a control, not a tab.
              event.stopPropagation()
              onNewAgentTab(tabSetNode.getId())
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="icon-xs">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            </svg>
          </IconButton>
        </Tooltip>,
      )
    },
    [onNewAgentTab],
  )

  const isEmpty = countOpenTabs(modelRef.current) === 0

  // An empty workspace lands on the New chat surface, not on a launcher page of
  // its own (2026-09-03). The tab the "+" opens IS that surface — same composer,
  // same prompt box, same permission and connector controls — so a workspace
  // with nothing in it opens one instead of standing in front of a second,
  // older chooser that offered a subset of the same choices. That is also what
  // makes a spawn from here work at all: every spawn path bails without a
  // tabset, and an empty FlexLayout model often has none, so the tab both shows
  // the surface and creates the tabset its terminal will dock into.
  //
  // The floor, not a one-shot: close the last tab and another opens, because a
  // workspace with no tabs has nothing to show and no way to start. The handler
  // is absent on background layers and outside standard workspaces, so neither
  // gets a tab it never asked for.
  const openNewAgentTabRef = useRef(onNewAgentTab)
  openNewAgentTabRef.current = onNewAgentTab
  // The handler's identity changes every render, so the effect watches whether
  // there is one rather than which one, and calls through the ref.
  const canOpenNewAgentTab = Boolean(onNewAgentTab)
  useEffect(() => {
    if (!isEmpty || !canOpenNewAgentTab) return
    openNewAgentTabRef.current?.()
  }, [isEmpty, canOpenNewAgentTab])

  // A workspace whose mode is owned by a module that is absent or switched off
  // renders the module-absence surface instead of its layout. The
  // rule itself — which modes can be absent, and which of the two states this
  // is — lives in `workspaceModuleAbsence`; this only paints the answer.
  const moduleAbsence = workspaceModuleAbsence(workspaceMode, {
    workspaceTypeModuleId: (mode) => getRendererHost().getWorkspaceType(mode)?.moduleId,
    isModuleEnabled: (moduleId) => selectModuleEnabled(moduleOverrides, moduleId),
  })
  if (moduleAbsence) {
    // A module that is on the machine and switched off is a toggle, not an
    // install: sending that person to the storefront offers to reinstall what
    // they already have.
    const openSettings = () =>
      openSettingsOverlay({
        initialTab: moduleAbsence.kind === 'disabled' ? MODULES_SETTINGS_TAB : EXTENSIONS_BROWSE_DEEPLINK,
      })
    return (
      <ModuleNotInstalledSurface
        label={moduleAbsence.label}
        installed={moduleAbsence.kind === 'disabled'}
        {...(moduleAbsence.kind === 'disabled' ? { actionLabel: 'Open module settings' } : {})}
        onOpenMarketplace={openSettings}
      />
    )
  }

  return (
    // A column so an agent's note (AgentRevealStrip) takes its own line above
    // the layout rather than covering its tab strips. The layout's own box is
    // always the same element, whether or not a note is showing, so a note
    // arriving never remounts a terminal.
    <div className="relative flex h-full flex-col" onMouseDownCapture={handleMouseDownCapture}>
      <AgentRevealStrip workspaceId={workspaceId} />
      <div className="relative min-h-0 flex-1">
        <Layout
          model={modelRef.current}
          factory={factory}
          icons={FLEX_LAYOUT_ICONS}
          onAction={handleAction}
          onAuxMouseClick={handleAuxMouseClick}
          onContextMenu={handleContextMenu}
          onRenderTab={renderTab}
          onRenderTabSet={renderTabSet}
          onModelChange={(model) => {
            updateLayout(workspaceId, model.toJson())
            followSelectedAgentTab(model)
          }}
        />
      </div>
      {tabMenu ? (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          ariaLabel={`Tab actions: ${tabMenu.node.getName()}`}
          onClose={() => setTabMenu(null)}
          surfaceClassName="min-w-[196px]"
        >
          <MenuItem
            disabled={!tabMenu.canHideTab}
            onClick={() => {
              const { node } = tabMenu
              setTabMenu(null)
              hideTab(node)
            }}
          >
            Hide tab
          </MenuItem>
          <MenuItem
            disabled={!tabMenu.canHideAllTabs}
            onClick={() => {
              setTabMenu(null)
              hideAllAgentTabs()
            }}
          >
            Hide all
          </MenuItem>
          <MenuItem
            disabled={!tabMenu.canCloseOtherTabs}
            onClick={() => {
              const { node } = tabMenu
              setTabMenu(null)
              closeOtherTabsInSet(node)
            }}
          >
            Close other tabs
          </MenuItem>
          {tabMenu.chatId || tabMenu.resumableChatId ? <MenuDivider /> : null}
          {tabMenu.chatId ? (
            <MenuItem
              onClick={() => {
                const { node } = tabMenu
                const agentId = tabMenu.chatId!
                setTabMenu(null)
                // The replay plays in the tab, so the tab comes forward first.
                modelRef.current?.doAction(Actions.selectTab(node.getId()))
                requestChatReplay(workspaceId, agentId)
              }}
            >
              Replay conversation
            </MenuItem>
          ) : null}
          {tabMenu.resumableChatId ? (
            <MenuItem
              onClick={() => {
                const agentId = tabMenu.resumableChatId!
                setTabMenu(null)
                void resumeChatInTerminalOrToast({ workspaceId, agentId })
              }}
            >
              Continue in terminal
            </MenuItem>
          ) : null}
          {tabMenu.agentId ? (
            <ChatAppToolsMenuItems
              workspaceId={workspaceId}
              agentId={tabMenu.agentId}
              onDone={() => setTabMenu(null)}
            />
          ) : null}
          {tabMenu.isTerminal ? (
            <>
              <MenuDivider />
              <MenuSwatchRow
                label="Color"
                value={tabMenu.currentColor}
                onPick={(color) => {
                  const { node } = tabMenu
                  setTabMenu(null)
                  setTabHighlightColor(node, color)
                }}
                onClear={() => {
                  const { node } = tabMenu
                  setTabMenu(null)
                  setTabHighlightColor(node, undefined)
                }}
              />
            </>
          ) : null}
        </ContextMenu>
      ) : null}
    </div>
  )
}

export default React.memo(WorkspaceLayout)
