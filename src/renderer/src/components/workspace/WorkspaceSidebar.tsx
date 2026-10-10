import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatGlyph, NewChatIcon, RemoteMachineGlyph, ScheduleGlyph, resolveEnabledWorkspaceType } from '../AppIcons'
import CliIcon from '../CliIcon'
import { PromptCacheMark } from './PromptCacheMark'
import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import { conversationSummaryPhase } from '../../../../shared/conversation/phase'
import { chatLinkFor } from '../../../../shared/deep-link'
import { isProjectlessChatsRoot } from '../../../../shared/projectless-chats'
import { copyToClipboardWithToast } from '../../utils/copyToClipboardWithToast'
import {
  conversationFinishedAt,
  conversationLineMark,
  conversationLineText,
  conversationsWithTabs,
  workspaceIsWorking,
} from './sidebar/conversationLines'
import { isLiveTerminal, useTerminalSessions } from '../../hooks/useTerminalSessions'
import { hasTerminalSessionsSnapshot } from '../../hooks/terminalSessionsStore'
import { groupConversationSessionsByWorkspace } from '../../hooks/conversationSessionsStore'
import { summariesEqual, useSidebarGitSummaries } from './useSidebarGitSummaries'
import { checkoutPathsOf, lineOfRemoteRow, terminalLinesOf } from './terminalLines'
import { suspendWorkspaceTerminals, terminateSettledWorkspaceTerminals } from './workspaceTerminalTermination'
import { ConversationPeekPopover } from './ConversationPeekPopover'
import { hostPlatform } from '../../clientCapabilities'
import { openPullRequestCount, ProjectPullRequestMark, PullRequestMark } from './PullRequestMark'
import { LocalServersRowMark } from './LocalServerMarks'
import { useWorkspaceLocalServers, type WorkspaceLocalServers } from './useLocalServers'
import {
  pullRequestsForRow,
  useConversationPullRequests,
  usePullRequestsByConversation,
  type ConversationPullRequests,
} from './useConversationPullRequests'
import { activityAt, peekStatusOf, rowConversationPeekIdentities } from './conversationPeekRow'
import { cancelOpenIntent, intendToOpenWorkspace } from './sidebarChatPrefetch'
import { changelistOwnerId } from '../../../../shared/git/changelists'
import { folderIdentityKey, useFolderRepositoryIdentities } from './useFolderRepositoryIdentities'
import { FolderIdentityIcon } from './FolderIdentityIcon'
import { getRendererHost, selectModuleEnabled } from '../../modules'
import type { WorkspaceTypeRowAction } from '../../modules/renderer-host'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import { startColumnResizeDrag } from './columnResizeDrag'
import {
  SIDEBAR_COLLAPSED_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  resolveSidebarResize,
} from './sidebarWidth'
import {
  IconButton,
  Input,
  LifecycleGlyph,
  RowButton,
  StarGlyph,
  StatusDot,
  Tooltip,
  TruncatedText,
  WorkingMark,
} from '../ui'
import { Modal, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { ExtensionsRail } from './ExtensionsRail'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { type LayoutTemplate, type Workspace, type WorkspaceId } from '../../types/workspace'
import { usePendingEditorReveal } from '../../utils/agentEditorReveal'
import { hasHighlightOverride, isStarred } from '../../utils/highlight'
import { projectColorKey, projectHue, resolveProjectColor, type ProjectColor } from '../../utils/projectColor'
import { useProjectColors } from '../../hooks/useProjectColors'
import {
  addTabAsNewColumn,
  appendTabAsNewColumnInJson,
  buildSingleTabLayoutModel,
  extractTabSpec,
  getModel,
  removeTab,
  type CrossWorkspaceTabSpec,
} from '../../utils/modelRegistry'
import { dataTransferHasTabDrag, readTabDragPayload, type TabDragPayload } from '../../utils/tabDragPayload'
import { useRelativeNow, useRelativeNowFor } from '../../hooks/useRelativeNow'
import { useWorkspaceMachineRef } from '../../hooks/useMachineIdentity'
import { distroOfHostId, isWslHostId } from '../../../../shared/execution-host'
import { useStableCallback } from '../../hooks/useStableCallback'
import { useRemoteSessions } from './remoteBand/useRemoteSessions'
import {
  attachedConversations,
  buildRemoteBand,
  openSpecOfConversation,
  remoteFinishUnseen,
  remoteConversationTitle,
  followedRemoteRestsToKeep,
  FOLLOWED_REMOTE_RESTS_KEY,
  readFollowedRemoteRests,
  remoteLifecycleWritable,
  remoteRestToFollow,
  unattachedConversations,
  chatRecencyOf,
  interleaveChats,
  sortChatsByRecency,
  type RemoteConversation,
  type RemoteSessionOpenSpec,
} from './remoteBand/remoteSessionsModel'
import { formatRelativeMs, formatRelativeMsAgo, relativeFromNow } from '../../utils/relativeTime'
import { deriveWorkspaceRunGlyph } from '../../utils/workspaceRunGlyph'
import { workspaceProjectRoot } from '../../utils/workspaceWorktree'
import { sortWorkspacesByUserMessage } from '../../utils/workspaceRecency'
import { isHiddenFromRail } from '../../utils/workspaceVisibility'
import { isSettledWorkspace } from '../../utils/workspaceSettle'
import { PANEL_COMMAND_EVENT } from '../../utils/panelCommands'
import { chatSettleStep } from './chatSettleCommand'
import { waitingChatCount, waitingLabel } from './sidebar/projectWaiting'
import { isSnoozedWorkspace, resolveSnoozePresets, snoozeWakeLabel, workspaceWokeAt } from '../../utils/workspaceSnooze'
import { workspaceRowEmphasis } from '../../utils/workspaceRowEmphasis'
import { useScheduledAgents } from '../../store/scheduledAgentsStore'
import { showToast } from '../../store/toastStore'
import { ScheduledAgentRow } from './sidebar/ScheduledAgentRow'
import { isScheduledRunChat, scheduledAgentRunInProgress } from '../../utils/scheduledAgentRuns'
import type { ScheduledAgentView } from '../../../../shared/scheduled-agents'
import {
  buildFolderGroups,
  meshPanesOf,
  folderDisplayName,
  folderKey,
  groupKeyOf,
  newChatProjectTarget,
  remoteProjectName,
  reorderFolders,
  reorderWithinFolder,
  resolveGroups,
  type FolderGroup,
} from './sidebar/folderGroups'
import {
  activeRowClass,
  activityLabel,
  activityTone,
  attentionRowClass,
  doneRowClass,
  inactiveHighlightClass,
  type Activity,
} from './sidebar/rowStyle'
import {
  deriveUnseenCompletions,
  isHookSettledSession,
  keepUnvisitedCompletions,
  rowHasOpenTerminals,
} from './sidebar/rowTerminals'
import { useVisitStamp, type VisitTarget } from './sidebar/useVisitStamp'
import { noteChatLeft, noteChatOpened } from '../panels/agentChat/unreadDivider'
import { onWorkspaceSettledElsewhere, takeWorkspacesSettledElsewhere } from '../../utils/settledElsewhere'
import { useWindowActive } from '../../utils/windowActivity'
import {
  AttentionPulse,
  BranchChip,
  ProjectLine,
  MachineRowGlyph,
  ScheduledRunGlyph,
  RowTooltip,
  RowTooltipsSuppressed,
  SETTLE_TICK_GLYPH,
  ShelfFoldRow,
  WorkingElapsed,
  type FlatProjectLine,
  type RowMachine,
} from './sidebar/rowParts'
import { TerminalLineView } from './sidebar/TerminalLineView'
import {
  FolderContextMenu,
  RemoteConversationContextMenu,
  WorkspaceContextMenu,
  workspaceTypeRowActions,
} from './sidebar/contextMenus'

export { TerminalLineView } from './sidebar/TerminalLineView'

export { AttentionPulse, RowTooltip, RowTooltipsSuppressed, WorkingElapsed } from './sidebar/rowParts'
export type { FlatProjectLine } from './sidebar/rowParts'

export { provenanceMachinesOf, rowHasOpenTerminals, rowOpenTerminals } from './sidebar/rowTerminals'

export { rowAccent } from './sidebar/rowStyle'

export { meshMachineNamesOf, meshPanesOf, groupKeyOf } from './sidebar/folderGroups'
export type { LocalGroupHeader } from './sidebar/folderGroups'

type TerminalRecency = {
  hasRunning: boolean
  idleSince: number | null
  lastInputAt: number | null
  // When the current turn started, for the row's working counter. Null whenever
  // nothing in the workspace is working.
  workingSince: number | null
}

type WorkspaceDetachPlacement = {
  screenX: number
  screenY: number
}

type WorkspaceSidebarProps = {
  workspaces: Workspace[]
  activeWorkspaceId: WorkspaceId | null
  workspaceWindowId: string
  isDetachedWindow: boolean
  sidebarCollapsed: boolean
  /**
   * At a phone's width the sidebar takes the whole width in turn with the
   * content (useNarrowViewport): no resize edge, no width of its own.
   */
  fillWidth?: boolean
  // The sidebar's own top strip (SidebarChrome) — window controls that run to the
  // top of the full-height sidebar. Rendered as the first child inside the aside
  // so it shares the column's exact width and resize behavior.
  chromeSlot?: React.ReactNode
  // The drilled-in surface's rail (item 1993). When a door or another drilled-in
  // surface is open its rail REPLACES this column's own content — one rail, ever,
  // never a second navigation column beside the first. The chrome strip above
  // does not participate in the swap. The workspaces rail stays mounted and
  // hidden underneath, so the row that opened the door is still there to take
  // focus back and the tree's scroll offset survives the round trip.
  contextRail?: React.ReactNode
  // Whether that rail is actually occupying the column. A surface with no rail
  // of its own nests nothing, so it replaces nothing and this stays false — the
  // node above is still mounted (it is the portal target that asks the
  // question), it is simply out of the layout.
  contextRailActive?: boolean
  activityByWorkspaceId: Record<WorkspaceId, Activity>
  // Workspaces whose agents are resident (live PTY) right now — instant to
  // switch into, versus suspended/exited rows that re-launch on open. Said in
  // words on the row for a screen reader, and what bolds a row
  // (see `workspaceRowEmphasis`): a chat with an agent still in it is one you
  // can walk back into and speak to, which is what the foreground is for.
  residentWorkspaceIds: ReadonlySet<WorkspaceId>
  terminalRecencyByWorkspaceId: Record<WorkspaceId, TerminalRecency>
  conversationSessions?: readonly ConversationSessionSummary[]
  // Whether main has listed the chats once. Until it has, every chat reads
  // idle, so the rest sweep waits for it as it waits for the terminals.
  // Absent means listed (a host with no chat runtime has nothing to wait for).
  conversationSessionsReady?: boolean
  // The unseen-completion marks, as they change — the app rail's Home badge
  // counts them (useRailBadges). The sidebar stays their owner: it is the layer
  // that knows what was looked at, and nothing outside it writes a mark.
  onUnseenDoneChange?: (ids: ReadonlySet<WorkspaceId>) => void
  /**
   * The chats this rail is HIDING because they are asleep (snooze, 2026-09-10),
   * reported up for the same reason the unseen-done marks are: the rail's Home
   * badge counts what wants the person, and a badge counting a chat the sidebar
   * has taken off screen is a number pointing at nothing. The sidebar owns the
   * reading because it owns the clock the wake is derived from.
   */
  onSnoozedWorkspacesChange?: (ids: ReadonlySet<WorkspaceId>) => void
  onSelectWorkspace: (id: WorkspaceId) => void
  // Open a session that lives on a paired machine (the Remote band): focus
  // the workspace here that already is it, or attach a new one. Absent in a
  // host with no mesh (partial harnesses); the band then draws its rows
  // and opens nothing.
  onOpenRemoteSession?: (spec: RemoteSessionOpenSpec) => void
  onMoveWorkspaceToNewWindow: (id: WorkspaceId, placement?: WorkspaceDetachPlacement) => void
  onMoveWorkspaceToMainWindow: (id: WorkspaceId) => void
  onCloseWorkspace: (id: WorkspaceId) => void
  onForgetFolder: (folderPath: string) => void
  // Open the pre-creation New Chat panel scoped to the active workspace's
  // folder — the create control. The one way in (owner, 2026-09-04): the split
  // "New…" half and its create menu are gone with the New workspace hub.
  onNewChat: () => void
  // Open New chat switched to Scheduled agent: the clock beside New chat.
  // Absent, there is no clock (a host with no scheduling).
  onNewScheduledAgent?: () => void
  // Open a scheduled agent's card: New chat, editing it.
  onOpenScheduledAgent?: (id: string) => void
  // The scheduled agent the door in this window is editing, drawn selected.
  openScheduledAgentId?: string | null
  // The New chat panel is up in this window. It sits over the active chat
  // without changing it, so the sidebar cannot tell from the id alone that
  // the person has left that chat.
  newChatOpen?: boolean
  // Scope a new chat to a specific project folder (workspace-row context menu).
  // The panel owns the agent/engine choice — the sidebar only opens it.
  onNewChatInFolder: (folderPath: string) => void
  onRevealFolder: (folderPath: string) => void
  onSetSidebarCollapsed: (collapsed: boolean) => void
  // Persisted expanded width (px) and its setter, for drag-to-resize.
  sidebarWidth: number
  onSetSidebarWidth: (width: number) => void
}

// The flat stream's single Snoozed shelf (all-chats-view). It shares the fold
// map with the folders' shelves — one place remembers what is open — under a
// key no folder can produce.
const ALL_CHATS_SNOOZE_SHELF_KEY = '__all_chats_snoozed__'
const ALL_CHATS_SNOOZE_SHELF_ID = 'ws-snoozed-all-chats'
// The Scheduled section's fold, keyed beside the Snoozed shelves' in the same state.
const SCHEDULED_SHELF_KEY = '__scheduled__'
const SCHEDULED_SHELF_ID = 'ws-scheduled-agents'
const NO_SCHEDULED_AGENTS: ScheduledAgentView[] = []

const DRAG_MIME_WORKSPACE = 'application/x-sprintengine-workspace'
const DRAG_MIME_FOLDER = 'application/x-sprintengine-folder'

function didWorkspaceDragLeaveSidebar(event: React.DragEvent, sidebar: HTMLElement | null): boolean {
  if (!sidebar) return false
  const rect = sidebar.getBoundingClientRect()
  const clientOutside =
    event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
  const screenLeft = window.screenX + rect.left
  const screenRight = window.screenX + rect.right
  const screenTop = window.screenY + rect.top
  const screenBottom = window.screenY + rect.bottom
  const screenOutside =
    event.screenX < screenLeft ||
    event.screenX > screenRight ||
    event.screenY < screenTop ||
    event.screenY > screenBottom
  return clientOutside || screenOutside
}

function tabDragAgentId(payload: TabDragPayload): string | null {
  const agentId = payload.config?.agentId
  return typeof agentId === 'string' && agentId ? agentId : null
}

// The settles of a paired machine's chats the rows here have followed
// (`remoteRestToFollow`). Storage that cannot be read or written leaves them
// for this run only, as they were before they were kept.
function readStoredFollowedRests(): string | null {
  try {
    return window.localStorage.getItem(FOLLOWED_REMOTE_RESTS_KEY)
  } catch {
    return null
  }
}

function storeFollowedRests(serialized: string): void {
  try {
    window.localStorage.setItem(FOLLOWED_REMOTE_RESTS_KEY, serialized)
  } catch {
    // Kept for this run only.
  }
}

function WorkspaceSidebar({
  workspaces,
  activeWorkspaceId,
  workspaceWindowId,
  isDetachedWindow,
  sidebarCollapsed,
  fillWidth = false,
  chromeSlot,
  contextRail,
  contextRailActive = false,
  activityByWorkspaceId,
  residentWorkspaceIds,
  terminalRecencyByWorkspaceId,
  conversationSessions = NO_CONVERSATIONS,
  conversationSessionsReady = true,
  onUnseenDoneChange,
  onSnoozedWorkspacesChange,
  onSelectWorkspace,
  onOpenRemoteSession,
  onMoveWorkspaceToNewWindow,
  onMoveWorkspaceToMainWindow,
  onCloseWorkspace,
  onForgetFolder,
  onNewChat,
  onNewScheduledAgent,
  onOpenScheduledAgent,
  openScheduledAgentId = null,
  newChatOpen = false,
  onNewChatInFolder,
  onRevealFolder,
  onSetSidebarCollapsed,
  sidebarWidth,
  onSetSidebarWidth,
}: WorkspaceSidebarProps) {
  // Which of the app rail's sections this column shows. The tree stays mounted
  // and hidden under Extensions (its folds and scroll offset are the
  // operator's), and both step aside while a door's rail owns the column.
  const sidebarSection = useWorkspaceStore((s) => s.sidebarSection)
  // Scheduled agents have a section of their own at the foot of the list
  // (owner ruling 2026-09-30). Filed among their project's chats, a schedule
  // whose run was working read as a second agent beside the run's own chat,
  // and opened an editor where the person expected the run. The schedule is
  // the long-lived thing and each run an ordinary chat, marked with the
  // schedule's clock, so the two now live apart. Off with their module.
  const scheduledAgentsEnabled = useWorkspaceStore((s) =>
    selectModuleEnabled(s.appSettings.modules, 'scheduled-agents'),
  )
  const allScheduledAgents = useScheduledAgents()
  const scheduledAgents = scheduledAgentsEnabled ? allScheduledAgents : NO_SCHEDULED_AGENTS
  // Closing a card is how a scheduled agent is switched off: removed at once,
  // and said so. No Undo on the toast — the toast spec keeps its action row for
  // its two named consumers, and an undo racing a dismissal timer is not one.
  const closeScheduledAgent = useCallback((agent: ScheduledAgentView) => {
    void window.api
      .removeScheduledAgent(agent.id)
      .then((removed) => {
        showToast(
          removed.ok
            ? { tone: 'neutral', title: 'Scheduled agent closed', description: 'It will not run again.' }
            : { tone: 'error', title: 'Not closed', description: removed.message },
        )
      })
      .catch(() => {})
  }, [])
  const extensionsSection = sidebarSection === 'extensions'
  const homeHidden = extensionsSection || Boolean(contextRailActive)
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace)
  const reorderWorkspaces = useWorkspaceStore((s) => s.reorderWorkspaces)
  const setWorkspaceHighlight = useWorkspaceStore((s) => s.setWorkspaceHighlight)
  const setWorkspaceSettled = useWorkspaceStore((s) => s.setWorkspaceSettled)
  const setWorkspaceAutoSettle = useWorkspaceStore((s) => s.setWorkspaceAutoSettle)
  const setWorkspaceSnoozed = useWorkspaceStore((s) => s.setWorkspaceSnoozed)
  const clearWorkspaceHighlight = useWorkspaceStore((s) => s.clearWorkspaceHighlight)
  // The person changing a project's colour from its header menu; the only
  // writer besides the first-sight allocation (one-colour-per-project, 2026-09-09).
  const setProjectColor = useWorkspaceStore((s) => s.setProjectColor)
  const addWorkspaceFromStore = useWorkspaceStore((s) => s.addWorkspace)
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace)
  // A file on the conversation peek's changed-files list opens in the workspace
  // pane's Diff tab — the same tab, and the same focus, a Git panel row opens.
  const openPaneTab = useWorkspaceStore((s) => s.openPaneTab)
  const updateLayout = useWorkspaceStore((s) => s.updateLayout)
  const moveAgentToWorkspace = useWorkspaceStore((s) => s.moveAgentToWorkspace)
  const moveOpenFileToWorkspace = useWorkspaceStore((s) => s.moveOpenFileToWorkspace)
  // Passed to WorkspaceTypeIcon so a disabled-module workspace row degrades to
  // the generic glyph (AC4) instead of its tool icon.
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  // The two-line row's second line (remote-sessions-ux / two-line-session-rows):
  // live terminals grouped per workspace for the agent-head stack, and the slow
  // per-workspace git poll for branch + ±lines.
  const terminalSessions = useTerminalSessions()
  const sessionsByWorkspaceId = useMemo(() => {
    const map = new Map<string, typeof terminalSessions>()
    for (const session of terminalSessions) {
      if (!session.workspaceId || !isLiveTerminal(session)) continue
      const list = map.get(session.workspaceId)
      if (list) list.push(session)
      else map.set(session.workspaceId, [session])
    }
    return map
  }, [terminalSessions])
  // Each row's chats. A row whose chats did not move keeps its array (the
  // sessions store keeps each unchanged session's object), so its memo holds.
  const conversationsByWorkspaceIdRef = useRef<ReadonlyMap<string, readonly ConversationSessionSummary[]> | null>(null)
  const conversationsByWorkspaceId = useMemo(() => {
    const grouped = groupConversationSessionsByWorkspace(conversationSessions, conversationsByWorkspaceIdRef.current)
    conversationsByWorkspaceIdRef.current = grouped
    return grouped
  }, [conversationSessions])
  // The same grouping WITHOUT the alive-process filter, for the conversation
  // peek alone. The map above is deliberately live-only — line 2 and the git
  // poll are about a checkout's current state, which a parked chat has no claim
  // on — but the peek asks the opposite question. "What was this one about?" is
  // asked most about the chat that is NOT running, and gating it on a living
  // process meant most of the sidebar after a restart offered no card at all.
  //
  // A suspended or exited session is still in main's list and still answers, so
  // it belongs here; a chat main has never heard of falls through to its own
  // agent records inside `rowConversationPeekIdentity`.
  const peekSessionsByWorkspaceId = useMemo(() => {
    const map = new Map<string, typeof terminalSessions>()
    for (const session of terminalSessions) {
      if (!session.workspaceId) continue
      const list = map.get(session.workspaceId)
      if (list) list.push(session)
      else map.set(session.workspaceId, [session])
    }
    return map
  }, [terminalSessions])
  // Owner ruling 2026-09-04 (the-diff-an-agent-made, decision 9): line 2 exists
  // only while the row has an open terminal. The git poll is therefore asked
  // about live rows alone — a suspended chat never reads a branch, so it can
  // never wear the checkout's current numbers as if they were its own, which
  // is exactly what every parked chat on `sprintengine` did after a restart. A
  // row that leaves this list drops out of the poll's membership and its
  // facts are pruned with it; a row that joins is swept on the next tick the
  // membership change triggers.
  const liveWorkspaces = useMemo(
    () => workspaces.filter((workspace) => rowHasOpenTerminals(workspace, sessionsByWorkspaceId)),
    [workspaces, sessionsByWorkspaceId],
  )
  // The poll asks about CHECKOUTS (sidebar-lists-every-terminal): the distinct
  // ones a live row's sessions sit on, keyed by path — two agents on one
  // checkout ask once, an agent in a worktree of its own asks for it, and a
  // move between them re-runs the sweep at once through the membership.
  const gitSummaryEntries = useMemo(() => {
    const paths = new Set<string>()
    for (const workspace of liveWorkspaces) {
      for (const path of checkoutPathsOf(workspace, sessionsByWorkspaceId.get(workspace.id) ?? [])) paths.add(path)
    }
    return [...paths].map((path) => ({ id: path, checkoutPath: path }))
  }, [liveWorkspaces, sessionsByWorkspaceId])
  const gitSummaries = useSidebarGitSummaries(gitSummaryEntries)
  // Each row's own slice of those summaries: the checkouts its sessions sit
  // on, which is all its lines read. A slice keeps its identity while what it
  // draws is unchanged, so a sweep that moved one checkout's numbers
  // re-renders the rows on that checkout and not every row in the list.
  const rowGitSummariesRef = useRef(new Map<WorkspaceId, RowGitSummaries>())
  const rowGitSummaries = useMemo(() => {
    const previous = rowGitSummariesRef.current
    const next = new Map<WorkspaceId, RowGitSummaries>()
    for (const workspace of workspaces) {
      const sessions = sessionsByWorkspaceId.get(workspace.id)
      if (!sessions?.length) continue
      const slice: RowGitSummaries = {}
      for (const path of checkoutPathsOf(workspace, sessions)) {
        const summary = gitSummaries[path]
        if (summary) slice[path] = summary
      }
      if (Object.keys(slice).length === 0) continue
      const prior = previous.get(workspace.id)
      next.set(workspace.id, prior && summariesEqual(prior, slice) ? prior : slice)
    }
    rowGitSummariesRef.current = next
    return next
  }, [workspaces, sessionsByWorkspaceId, gitSummaries])
  // A door-routed full-page surface owns the card region (global-surfaces epic
  // 1704). While one is active no project row is "current" — the door row carries
  // the selection instead, so the sidebar shows exactly one selected thing. This
  // resolves + module-gates the active surface exactly as WorkspaceManager does
  // for the mount, so the two agree: a stale id whose surface is unregistered or
  // whose module was disabled falls back to the workspace (region shows it, and a
  // project row re-selects) rather than leaving nothing selected.
  const activeGlobalSurface = useWorkspaceStore((s) => s.activeGlobalSurface)
  const globalSurfaceActive = useMemo(() => {
    if (!activeGlobalSurface) return false
    const entry = getRendererHost().getGlobalSurface(activeGlobalSurface)
    return entry !== undefined && selectModuleEnabled(moduleOverrides, entry.moduleId)
  }, [activeGlobalSurface, moduleOverrides])
  // The chat a person can see: the window's own, unless New chat or a door
  // covers it. A chat started with ⌘⏎ is not it, and neither is the one under
  // New chat while the person types the next task: each is stamped as seen,
  // and loses its finished mark, only once it is uncovered.
  const onScreenWorkspaceId = newChatOpen || globalSurfaceActive ? null : activeWorkspaceId
  // The chat in front of the window, covered or not by New chat: the one it
  // comes back to when New chat closes. A look at New chat is not leaving it —
  // its "New" divider holds, and a Mark unread asked of it waits for the
  // person to actually move on — though while covered nobody is looking at
  // it, so it is not stamped as seen. A door is leaving it. A chat started
  // with ⌘⏎ is not the front chat at all, so neither applies to it.
  const frontWorkspaceId = globalSurfaceActive ? null : activeWorkspaceId
  // The unseen-completion mark (the green row, `doneRowClass`). Session-only: the
  // store's recency slice persists when a workspace was last TYPED into, not
  // when it was last looked at, so "seen" has no honest home there yet and a
  // restart simply starts clean. The transition is read off the same
  // hook-authoritative clock the working counter uses; nothing here reads a
  // pane. A ref carries the previous clocks so the effect compares, not
  // re-renders.
  const [unseenDoneIds, setUnseenDoneIds] = useState<Set<string>>(() => new Set())
  const workingSinceRef = useRef<Record<string, number | null>>({})
  useEffect(() => {
    const workingSinceNow: Record<string, number | null> = {}
    for (const [id, recency] of Object.entries(terminalRecencyByWorkspaceId)) {
      workingSinceNow[id] = recency.workingSince
    }
    const settledWorkspaceIds = new Set<string>()
    for (const session of terminalSessions) {
      if (session.workspaceId && isHookSettledSession(session)) settledWorkspaceIds.add(session.workspaceId)
    }
    for (const session of conversationSessions) {
      if (
        conversationSummaryPhase(session) === 'completed' ||
        (session.status === 'ready' && session.lastAssistantText)
      ) {
        settledWorkspaceIds.add(session.workspaceId)
      }
    }
    const before = workingSinceRef.current
    workingSinceRef.current = workingSinceNow
    setUnseenDoneIds((previous) => {
      const next = deriveUnseenCompletions({
        previous,
        workingSinceBefore: before,
        workingSinceNow,
        settledWorkspaceIds,
        activeWorkspaceId: onScreenWorkspaceId,
      })
      if (next.size === previous.size && [...next].every((id) => previous.has(id))) return previous
      return next
    })
  }, [terminalRecencyByWorkspaceId, terminalSessions, conversationSessions, onScreenWorkspaceId])
  useEffect(() => {
    onUnseenDoneChange?.(unseenDoneIds)
  }, [unseenDoneIds, onUnseenDoneChange])
  // …and read somewhere else. A chat read on the phone, or in a desktop
  // following it, has had its finish seen, and its `lastVisitedAt` moves past
  // the moment this window put the mark up; the mark comes down here too
  // (`keepUnvisitedCompletions`). When each mark went up is kept beside the
  // set, and the store is watched only for the marked chats' visit clocks, so
  // a visit to any other chat does not re-render the rail.
  const unseenMarkedAtRef = useRef(new Map<string, number>())
  useEffect(() => {
    const marked = unseenMarkedAtRef.current
    const now = Date.now()
    for (const id of unseenDoneIds) if (!marked.has(id)) marked.set(id, now)
    for (const id of [...marked.keys()]) if (!unseenDoneIds.has(id)) marked.delete(id)
  }, [unseenDoneIds])
  const unseenVisits = useWorkspaceStore(
    useCallback(
      (state: { workspaces: Workspace[] }) => {
        if (unseenDoneIds.size === 0) return ''
        let visits = ''
        for (const workspace of state.workspaces) {
          if (unseenDoneIds.has(workspace.id) && typeof workspace.lastVisitedAt === 'number')
            visits += `${workspace.id}=${workspace.lastVisitedAt};`
        }
        return visits
      },
      [unseenDoneIds],
    ),
  )
  useEffect(() => {
    if (!unseenVisits) return
    const visitedAt = new Map(
      useWorkspaceStore.getState().workspaces.map((workspace) => [workspace.id, workspace.lastVisitedAt]),
    )
    setUnseenDoneIds((previous) => {
      const next = keepUnvisitedCompletions({
        marks: previous,
        markedAt: unseenMarkedAtRef.current,
        visitedAt: (id) => visitedAt.get(id),
      })
      return next === previous ? previous : new Set(next)
    })
  }, [unseenVisits])
  // Marked unread, here or on any other device: the chat's visit clock went
  // back past its latest finish (`conversation.mark_unread`), and the mark
  // goes up until someone looks at it. Read off the record, so it is still
  // up after a restart. A finish since the rewind is the transitions' to
  // mark, and a visit since it is the person having read it.
  const rewoundVisits = useWorkspaceStore(
    useCallback((state: { workspaces: Workspace[] }) => {
      let rewound = ''
      for (const workspace of state.workspaces) {
        if (typeof workspace.visitRewoundAt === 'number')
          rewound += `${workspace.id}=${workspace.visitRewoundAt}:${workspace.lastVisitedAt ?? ''};`
      }
      return rewound
    }, []),
  )
  useEffect(() => {
    if (!rewoundVisits) return
    const marked: string[] = []
    for (const workspace of useWorkspaceStore.getState().workspaces) {
      const rewoundAt = workspace.visitRewoundAt
      if (typeof rewoundAt !== 'number' || workspace.id === onScreenWorkspaceId || workspace.remoteOrigin) continue
      const finishedAt = latestFinishOf(workspace, conversationsByWorkspaceId.get(workspace.id) ?? NO_CONVERSATIONS)
      const visitedAt = typeof workspace.lastVisitedAt === 'number' ? workspace.lastVisitedAt : null
      if (finishedAt === null || finishedAt > rewoundAt) continue
      if (visitedAt !== null && visitedAt >= finishedAt) continue
      marked.push(workspace.id)
    }
    if (marked.length === 0) return
    setUnseenDoneIds((previous) =>
      marked.every((id) => previous.has(id)) ? previous : new Set([...previous, ...marked]),
    )
  }, [rewoundVisits, conversationsByWorkspaceId, onScreenWorkspaceId])

  // Module-contributed top-nav doors used to be resolved here and handed to
  // ExtensionsRail. They are resolved inside `useExtensionsDrawerRows` now: the
  // memo here was keyed on module enablement alone, so a third-party module
  // that finished loading after boot never appeared in the drawer even though
  // the Extensions home — which uses the same resolver — listed it.
  const now = useRelativeNow()

  // A chat that has come to rest holds no terminals (owner ruling 2026-09-07).
  // Settling was presentation-only when the model landed — the row moved, the
  // ptys kept running — which left a folder's worth of shelved chats each
  // holding a live CLI process for as long as the app was up. Rest now means
  // rest: the ptys go with the row.
  //
  // Every settle goes through here — the hand gesture, the row menu, and the
  // sweep's three-idle-day decision — so the three cannot disagree about what
  // resting means.
  //
  // Gated on the row actually having something open, because the first sweep
  // after a restart settles hundreds of rows at once: without the gate each
  // one would fan out a kill per recorded agent session, and every one of
  // those is a no-op IPC round trip for a chat whose ptys died with the last
  // app run. Only a row with live sessions (or a mounted mesh pane) is worth
  // asking main about.
  //
  // Nothing here can kill a working agent: the sweep never settles a row that
  // is busy, held, or selected, and a hand Settle is the person saying so
  // about a chat they are looking at.
  //
  // A chat agent counts as open too: it has no pty, but main holds a child
  // process for it until the session is stopped.
  //
  // Read through refs, so these keep their identity while sessions move: the
  // sweep below is keyed on `quietSettledWorkspace`, and a new one on every
  // chat refresh re-ran the sweep over every workspace for nothing.
  const openAgentSourcesRef = useRef({
    sessionsByWorkspaceId,
    conversationsByWorkspaceId,
    workspaces,
    activityByWorkspaceId,
  })
  openAgentSourcesRef.current = { sessionsByWorkspaceId, conversationsByWorkspaceId, workspaces, activityByWorkspaceId }
  const rowHasOpenAgents = useCallback((workspace: Workspace) => {
    const sources = openAgentSourcesRef.current
    return (
      rowHasOpenTerminals(workspace, sources.sessionsByWorkspaceId) ||
      (sources.conversationsByWorkspaceId.get(workspace.id) ?? NO_CONVERSATIONS).some(
        (session) => session.status !== 'stopped',
      )
    )
  }, [])
  const rowIsWorking = useCallback((id: WorkspaceId) => {
    const sources = openAgentSourcesRef.current
    return workspaceIsWorking(
      sources.activityByWorkspaceId[id] ?? 'idle',
      sources.conversationsByWorkspaceId.get(id) ?? NO_CONVERSATIONS,
      sources.sessionsByWorkspaceId.get(id) ?? NO_SESSIONS,
    )
  }, [])
  const quietSettledWorkspace = useCallback(
    (id: WorkspaceId) => {
      const workspace = openAgentSourcesRef.current.workspaces.find((candidate) => candidate.id === id)
      if (!workspace || !rowHasOpenAgents(workspace)) return
      // The record as it stands when main has answered, not the render's: a
      // chat un-settled meanwhile keeps its agents. One gone from the record
      // was closed, and Close kills unconditionally anyway.
      void terminateSettledWorkspaceTerminals(workspace, () => {
        const now = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === id)
        return now === undefined || isSettledWorkspace(now)
      })
    },
    [rowHasOpenAgents],
  )

  // Snooze by hand (owner ruling, 2026-09-10): the record first, then PAUSE the
  // ptys — the same order and the same reason as Settle above, and the same
  // gate on the row actually having something open, because asking main to
  // suspend a chat whose ptys died with the last app run is a round trip to
  // say nothing.
  //
  // Paused, not killed. A snoozed chat has to sit like every other non-live
  // chat — no agent process burning while the row is off screen — but it is
  // coming back on a clock, so the session is kept resumable and the person's
  // first keystroke relaunches the agent with `--resume`. Waking resumes
  // nothing; see `suspendWorkspaceTerminals`.
  //
  // Never while an agent in it is working, for Settle's reason: pausing ends
  // the agent processes, and an agent working in the background ends with
  // them and does not come back on the wake.
  const snoozeWorkspaceById = useCallback(
    (id: WorkspaceId, wakeAt: number) => {
      if (rowIsWorking(id)) return
      setWorkspaceSnoozed(id, wakeAt)
      const workspace = openAgentSourcesRef.current.workspaces.find((candidate) => candidate.id === id)
      if (!workspace || !rowHasOpenAgents(workspace)) return
      void suspendWorkspaceTerminals(workspace)
    },
    [rowIsWorking, setWorkspaceSnoozed, rowHasOpenAgents],
  )

  // ─── The pull requests a chat holds after its agents are gone ──────────
  //
  // Owner, 2026-09-10: "he is no longer active, but it doesn't show on his card
  // that he has an open pull request… if I'm scanning through the old chats I
  // don't know is there a pull request open that I'm missing."
  //
  // A live agent's marks arrive on its terminal session and are drawn on its
  // own line; those are the more precise answer and this never overrides them
  // (`pullRequestsForRow`). This is for the rows that have no line left. The
  // rest sweep below reads it too: a chat whose pull requests have landed
  // settles (Settle on merge).
  const allWorkspaceIds = useMemo(() => workspaces.map((workspace) => workspace.id), [workspaces])
  const conversationPullRequests = useConversationPullRequests(allWorkspaceIds)
  // …and each chat line's own: the pull requests that chat's agent opened,
  // which is what its line wears, not everything its workspace holds.
  const conversationLineKeys = useMemo(
    () => conversationSessions.map(({ workspaceId, agentId }) => ({ workspaceId, agentId })),
    [conversationSessions],
  )
  const conversationLinePullRequests = usePullRequestsByConversation(conversationLineKeys)
  // The local servers each chat's agents started, so the list says what is
  // running right now without opening every chat. Asked of the same ids, and
  // pushed by the Studio when one starts or stops.
  const workspaceLocalServers = useWorkspaceLocalServers(allWorkspaceIds)

  // The rest sweep (settled-chats, 2026-09-07): on the 30 s tick the idle
  // labels ride, and whenever an agent's activity flips — so a resting row
  // whose agent starts working wakes at once, not a tick later. This is the
  // one place that knows every blocker: what is working (activity, so it
  // wakes a resting row and holds an active one), and what wants the person
  // (a prompt, or the unseen finished mark — a thing to look at, which holds
  // a row out of the shelf and wakes one the sweep settled, never one the
  // person did). Not before main has listed the sessions once: until then
  // every row reads idle, and a chat parked at a prompt for days would settle
  // on the mount and wake a beat later. The store owns the rule and the
  // record; see `reconcileWorkspaceSettlement`.
  //
  // Keyed on whether both lists have landed rather than on the terminal list
  // itself: a terminal's semantic change moves no row's activity that
  // `activityByWorkspaceId` does not already carry.
  //
  // Busy is `workspaceIsWorking`, the rule Settle by hand follows: a row whose
  // prompt or failed turn outranks a background agent still working is busy
  // all the same, or a merge would settle it and end that agent.
  const sessionsListed = hasTerminalSessionsSnapshot() && conversationSessionsReady
  useEffect(() => {
    if (!sessionsListed) return
    const busyIds = new Set<WorkspaceId>()
    const heldIds = new Set<WorkspaceId>(unseenDoneIds)
    for (const [id, activity] of Object.entries(activityByWorkspaceId)) {
      if (rowIsWorking(id)) busyIds.add(id)
      else if (activity === 'needs-input') heldIds.add(id)
    }
    const settledNow = useWorkspaceStore.getState().reconcileWorkspaceSettlement({
      now,
      busyIds,
      heldIds,
      pullRequestsByWorkspaceId: conversationPullRequests,
    })
    for (const id of settledNow) quietSettledWorkspace(id)
  }, [
    now,
    activityByWorkspaceId,
    conversationSessions,
    unseenDoneIds,
    sessionsListed,
    rowIsWorking,
    quietSettledWorkspace,
    conversationPullRequests,
  ])

  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  // Which Snoozed shelves are open. Session-only and closed by default: the
  // shelf is where rows go to stop asking for attention.
  const [expandedShelves, setExpandedShelves] = useState<Record<string, boolean>>({})
  const [starredCollapsed, setStarredCollapsed] = useState(false)
  const [renamingId, setRenamingId] = useState<WorkspaceId | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<{ workspaceId: WorkspaceId; x: number; y: number } | null>(null)
  // The menu of a chat on a paired machine that no window here holds, by its row's key.
  const [remoteMenu, setRemoteMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [folderMenu, setFolderMenu] = useState<{ folderKey: string; x: number; y: number } | null>(null)
  const [confirmClose, setConfirmClose] = useState<WorkspaceId | null>(null)
  const [pendingTypeAction, setPendingTypeAction] = useState<{
    workspaceId: WorkspaceId
    action: WorkspaceTypeRowAction
  } | null>(null)
  const [typeActionBusy, setTypeActionBusy] = useState(false)
  const [confirmForget, setConfirmForget] = useState<string | null>(null)

  const renameInputRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  // Roving-tabindex tree: `rovingKey` is the row (by its render key) that holds
  // the single tab stop. Arrow/Home/End move focus between the treeitems that
  // are actually in the DOM (folded/collapsed rows are absent), so navigation
  // follows what the user sees. treeRef scopes the query to this tree.
  const treeRef = useRef<HTMLElement>(null)
  const [rovingKey, setRovingKey] = useState<string | null>(null)

  const getTreeRows = useCallback((): HTMLElement[] => {
    const root = treeRef.current
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'))
  }, [])

  // The chat to open when the one you are in is settled: the next chat row
  // down the rail as drawn, else the one above it. Rows on a Settled or
  // Snoozed shelf are skipped — settling one chat should land you in another
  // that is still going, not open a resting one.
  const successorRowOf = useCallback(
    (id: WorkspaceId): WorkspaceId | null => {
      const byId = new Map(openAgentSourcesRef.current.workspaces.map((workspace) => [workspace.id, workspace]))
      const now = Date.now()
      const ids = getTreeRows()
        .map((row) => row.dataset.workspaceId as WorkspaceId | undefined)
        .filter((candidate): candidate is WorkspaceId => {
          if (!candidate) return false
          if (candidate === id) return true
          const workspace = byId.get(candidate)
          return !!workspace && !isSettledWorkspace(workspace) && !isSnoozedWorkspace(workspace, now)
        })
      const index = ids.indexOf(id)
      if (index < 0) return null
      return (
        ids.slice(index + 1).find((candidate) => candidate !== id) ??
        ids
          .slice(0, index)
          .reverse()
          .find((candidate) => candidate !== id) ??
        null
      )
    },
    [getTreeRows],
  )

  // Settling the chat you are in moves you on to the next one. The row you are
  // in is never shelved (`isShelved`), so without the hand-off it sat there,
  // checked off and still open, until you clicked somewhere else.
  //
  // The successor is read off the rail as drawn, so it is chosen BEFORE the
  // record moves, and the returned step is run after.
  const handOffFrom = useCallback(
    (id: WorkspaceId): (() => void) => {
      // Only the chat on screen: with New chat or a full-page surface over it
      // the person has already left it, and settling it from its row must not
      // pull them out of where they are into another chat.
      if (id !== activeWorkspaceId || newChatOpen || globalSurfaceActive) return () => {}
      const successor = successorRowOf(id)
      return () => {
        if (successor) onSelectWorkspace(successor)
        // The last chat still going: there is nothing to move on to, so New
        // chat opens and the settled row leaves the rail (owner, 2026-10-03).
        // Before, it stayed open and checked off.
        else onNewChat()
      }
    },
    [activeWorkspaceId, newChatOpen, globalSurfaceActive, successorRowOf, onSelectWorkspace, onNewChat],
  )

  // Settle by hand: the record first, then the ptys — the row must move even
  // if a kill fails, and `terminateSettledWorkspaceTerminals` absorbs its
  // failures (and spares a chat that started working before the kill landed).
  //
  // Never while an agent in it is working: settling ends the chat's agent
  // processes, and whatever they were doing with them. The row's button and
  // menu item say so; this is the guard for every path.
  const settleWorkspaceById = useCallback(
    (id: WorkspaceId) => {
      if (rowIsWorking(id)) return
      const handOff = handOffFrom(id)
      setWorkspaceSettled(id, true)
      quietSettledWorkspace(id)
      handOff()
    },
    [rowIsWorking, handOffFrom, setWorkspaceSettled, quietSettledWorkspace],
  )

  // A Settle made somewhere else — a paired phone or desktop
  // (`conversation.settle`), or another window here — reaches this window as
  // a record that is suddenly resting (`settledElsewhere.ts`). The rest of a
  // Settle is carried out here as if it had been made here: the chat's
  // processes end, and a window that has it in front moves on.
  //
  // The processes are ended by the window that routes the row, so two
  // windows do not both ask; the hand-off is every window's that has it in
  // front. A row whose agent is working is left running, as Settle by hand
  // leaves it: the rest sweep reads a working row as busy and wakes it on its
  // next tick, so the chat comes back rather than losing its work.
  const settledElsewhere = useStableCallback((id: WorkspaceId) => {
    if (rowIsWorking(id)) return
    const handOff = handOffFrom(id)
    if (useWorkspaceStore.getState().speaksForWorkspace(id)) quietSettledWorkspace(id)
    handOff()
  })
  useEffect(() => {
    // Taken after the store update that noted it has finished, never inside it.
    const drain = () =>
      queueMicrotask(() => {
        for (const id of takeWorkspacesSettledElsewhere()) settledElsewhere(id)
      })
    drain()
    return onWorkspaceSettledElsewhere(drain)
  }, [settledElsewhere])

  // Drilling into a surface hides this rail (item 1993), and hiding a scrollport
  // drops its offset to zero — so Back would return the workspaces rail scrolled
  // to the top instead of returning the rail the surface replaced. The offset is
  // recorded as the user scrolls (a ref write, never a re-render) and put back
  // before the restored rail paints.
  const treeScrollTopRef = useRef(0)
  useEffect(() => {
    if (contextRailActive) return
    const node = treeRef.current
    if (node) node.scrollTop = treeScrollTopRef.current
  }, [contextRailActive])

  const handleTreeRowKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, workspaceId: WorkspaceId | null, activate?: () => void) => {
      // Only the row itself steers the tree; keys from a focused child control
      // (rename input, row-action buttons) keep their own behavior.
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        // A Remote band row with no workspace here yet activates by attaching
        // (`activate`); every other row selects its workspace.
        if (activate) activate()
        else if (workspaceId) onSelectWorkspace(workspaceId)
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
        return
      }
      const rows = getTreeRows()
      if (rows.length === 0) return
      event.preventDefault()
      const currentIndex = rows.indexOf(event.currentTarget)
      let nextIndex = currentIndex
      if (event.key === 'ArrowDown') nextIndex = currentIndex + 1
      else if (event.key === 'ArrowUp') nextIndex = currentIndex - 1
      else if (event.key === 'Home') nextIndex = 0
      else if (event.key === 'End') nextIndex = rows.length - 1
      nextIndex = Math.max(0, Math.min(nextIndex, rows.length - 1))
      const target = rows[nextIndex]
      if (!target) return
      target.focus()
      setRovingKey(target.dataset.rowKey ?? null)
    },
    [getTreeRows, onSelectWorkspace],
  )
  // True while the user is dragging the resize handle — suppresses the width
  // glide so the rail tracks the pointer instead of lagging behind a 150ms
  // transition.
  const [isResizingSidebar, setIsResizingSidebar] = useState(false)
  // Live width during an active drag. The drag writes width straight to the
  // sidebar element's style (see apply()) instead of the store, so no frame
  // pays for a store mutation — which in this app means re-serializing the whole
  // persisted workspace registry (~3× per frame in the persist adapter) plus a
  // full WorkspaceManager re-render. This ref is the drag's source of truth so a
  // stray re-render mid-drag (e.g. a workspace status tick) re-reads the live
  // width instead of snapping back to the stale store value. Committed to the
  // store once on pointer-up.
  const dragWidthRef = useRef<number | null>(null)

  // Drag the right-edge handle to resize the expanded sidebar; drag it close to
  // the left and the rail collapses to the icon strip. Pointer math is shared
  // with the store via resolveSidebarResize so the snap threshold is single-
  // sourced. rAF-coalesced so a fast drag does at most one update per frame, and
  // each frame is a pure DOM width write — the store is touched only on
  // pointer-up (final width) and when crossing the collapse/expand boundary.
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const startX = event.clientX
      const startWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth
      let collapsed = sidebarCollapsed
      dragWidthRef.current = startWidth
      setIsResizingSidebar(true)
      // The gesture is startColumnResizeDrag's, not this component's: a
      // maximised workspace pane covers the row this drag crosses, and a
      // browser tab in it is a `<webview>` guest that would swallow every
      // pointer event from the moment the pointer entered it.
      startColumnResizeDrag(event, {
        onDrag: (clientX) => {
          const outcome = resolveSidebarResize(startWidth + (clientX - startX))
          if (outcome.kind === 'collapse') {
            if (!collapsed) {
              collapsed = true
              dragWidthRef.current = null
              onSetSidebarCollapsed(true)
            }
            return
          }
          if (collapsed) {
            collapsed = false
            onSetSidebarCollapsed(false)
          }
          // Per-frame update stays in the DOM: no store mutation, so no registry
          // re-serialization and no app-wide re-render while dragging.
          dragWidthRef.current = outcome.width
          if (sidebarRef.current) sidebarRef.current.style.width = `${outcome.width}px`
        },
        onDragEnd: () => {
          // Commit the final width to the store exactly once (skipped if the drag
          // ended in the collapsed state, which already updated the store).
          const finalWidth = dragWidthRef.current
          dragWidthRef.current = null
          if (finalWidth !== null && !collapsed) onSetSidebarWidth(finalWidth)
          setIsResizingSidebar(false)
        },
      })
    },
    [sidebarCollapsed, sidebarWidth, onSetSidebarCollapsed, onSetSidebarWidth],
  )

  // Keyboard resizing for the separator handle: arrows nudge width (and cross
  // the collapse/expand boundary), Home restores the default width.
  const handleResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const STEP = 16
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (sidebarCollapsed) return
        const next = sidebarWidth - STEP
        if (next < SIDEBAR_MIN_WIDTH) onSetSidebarCollapsed(true)
        else onSetSidebarWidth(next)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        if (sidebarCollapsed) {
          onSetSidebarCollapsed(false)
          onSetSidebarWidth(SIDEBAR_MIN_WIDTH)
        } else {
          onSetSidebarWidth(sidebarWidth + STEP)
        }
      } else if (event.key === 'Home') {
        event.preventDefault()
        if (sidebarCollapsed) onSetSidebarCollapsed(false)
        onSetSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
      }
    },
    [sidebarCollapsed, sidebarWidth, onSetSidebarCollapsed, onSetSidebarWidth],
  )

  // Double-click resets to the default width (and expands if collapsed).
  const handleResizeDoubleClick = useCallback(() => {
    if (sidebarCollapsed) onSetSidebarCollapsed(false)
    onSetSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
  }, [sidebarCollapsed, onSetSidebarCollapsed, onSetSidebarWidth])
  const dragRef = useRef<
    { type: 'workspace'; id: WorkspaceId; folderKey: string } | { type: 'folder'; folderKey: string } | null
  >(null)
  const [dropIndicator, setDropIndicator] = useState<
    | { kind: 'workspace'; targetId: WorkspaceId; position: 'before' | 'after' }
    | { kind: 'folder'; targetKey: string; position: 'before' | 'after' }
    | null
  >(null)
  const [tabDropTarget, setTabDropTarget] = useState<
    { kind: 'new' } | { kind: 'workspace'; id: WorkspaceId } | { kind: 'folder'; key: string } | null
  >(null)

  // Rail-hidden workspaces — the background Automations host, and any
  // module-registered type that declares itself hidden — stay in the store and in window
  // assignments but never render as rail rows. Every presentation path below —
  // folder groups, starred — derives from this list, while drag-reorder still
  // stitches against the full `workspaces` array so a hidden workspace keeps its
  // place in the persisted order. Cross-workspace search now lives in the
  // global-search palette (T6), not a sidebar box.
  // Resting rows (`settledAt`, settled-chats 2026-09-07) stay in this list
  // but are not drawn: `isShelved` keeps them off the rail (owner,
  // 2026-09-28), and Settings ▸ Settled chats is where they are found.
  const railWorkspaces = useMemo(
    () => workspaces.filter((workspace) => !isHiddenFromRail(workspace, moduleOverrides)),
    [workspaces, moduleOverrides],
  )

  // Each paired machine's sessions, read while this rail is the one showing; a
  // machine that is asleep is drawn from its last read. No longer gated on a
  // band being open — there is no band, and the rows these feed are spread
  // through the projects.
  //
  // Read HERE, above the grouping, because the grouping depends on it: whether
  // this device is on the tailnet decides which rows exist at all (below), and
  // the browse decides how many lines each open remote row draws.
  const remoteSessions = useRemoteSessions({ enabled: !contextRailActive })
  const {
    presence: remotePresence,
    browses: remoteBrowses,
    listening: remoteListening,
    link: remoteLink,
    refresh: refreshRemote,
  } = remoteSessions
  const remoteGroups = useMemo(
    () =>
      buildRemoteBand({
        connections: remotePresence.mesh,
        browses: remoteBrowses,
        reachability: remotePresence.meshReachability,
        workspaces: railWorkspaces,
      }),
    [remotePresence.mesh, remoteBrowses, remotePresence.meshReachability, railWorkspaces],
  )

  // Rows born on a paired machine (`workspace.remoteOrigin`) file under a
  // project header like every other chat (owner, 2026-09-11). They used to be
  // held out of the groups entirely and listed in a "Remote" band above them —
  // which made the machine the thing a chat belonged to, rather than the
  // project it is in. What is remote about a row is now said where it belongs:
  // a green glyph on the row itself, naming the device on hover.
  //
  // `resolveGroups` already knows how to file one: a remote row whose
  // repository has a local clone open here joins that clone's header, and one
  // with no twin founds a header of its own named after its folder over there.
  //
  // …and off the tailnet they file nowhere, because they are not there (owner,
  // 2026-09-13: "when studio has disconnected from the tailnet, it should no
  // longer show the remote conversations in the side panel"). `unattached
  // Conversations` already withheld the rows read from a browse; these are the
  // other half — real `Workspace`s here, stamped with `remoteOrigin`, whose
  // entire content is a pane onto a machine this device can no longer reach.
  // Nothing is forgotten and nothing is closed: the workspaces stay in the
  // store, stay in `railWorkspaces` so the band can still recognise what is
  // attached to what, and their rows come back with the link.
  const localRailWorkspaces = useMemo(
    () => (remoteLink === 'down' ? railWorkspaces.filter((workspace) => !workspace.remoteOrigin) : railWorkspaces),
    [railWorkspaces, remoteLink],
  )

  // Repository identity per open local folder (one-project-across-machines),
  // read once per folder. This is what lets a chat running on the Mini sit
  // under the same header as this disk's clone of the same repository, and what
  // New chat's "Run on" keys on.
  //
  // Asked for the row's own folder AND the project it files under: a worktree row's
  // header is its parent checkout, which may have no row of its own, and the
  // project colour keyed on that header has to be able to ask which repository
  // it is (one-colour-per-project, 2026-09-09). Duplicates and nulls are the
  // hook's to drop.
  const folderIdentities = useFolderRepositoryIdentities(
    useMemo(
      () => localRailWorkspaces.flatMap((workspace) => [workspace.folderPath, workspaceProjectRoot(workspace)]),
      [localRailWorkspaces],
    ),
  )
  // Resolved over the rail's rows, not every workspace: a local folder whose
  // rows are all hidden or archived is not a header a remote row can join.
  const resolvedGroups = useMemo(
    () => resolveGroups(localRailWorkspaces, folderIdentities),
    [localRailWorkspaces, folderIdentities],
  )
  const keyOf = useCallback(
    (workspace: Workspace) => resolvedGroups.keys.get(workspace.id) ?? groupKeyOf(workspace),
    [resolvedGroups],
  )
  const localGroups = useMemo(
    () => buildFolderGroups(localRailWorkspaces, keyOf, resolvedGroups.headers),
    [localRailWorkspaces, keyOf, resolvedGroups],
  )
  // Which header a given repository already has here, so a remote conversation
  // of that repository joins it instead of founding a second one beside it.
  // Read off the groups that exist rather than recomputed, so the two can
  // never disagree about where a project lives.
  const groupKeyByRepository = useMemo(() => {
    const map = new Map<string, string>()
    for (const group of localGroups) {
      if (group.remote || !group.fullPath) continue
      const canonicalKey = folderIdentities.get(folderIdentityKey(group.fullPath))?.canonicalKey
      if (canonicalKey && !map.has(canonicalKey)) map.set(canonicalKey, group.key)
    }
    return map
  }, [localGroups, folderIdentities])

  // The conversations on paired machines that no window here holds. The ones
  // that DO have a window are already `Workspace`s in `railWorkspaces` and
  // group themselves; listing them here too would be the same chat twice.
  const listedRemote = useMemo(
    () => unattachedConversations(remoteGroups, remoteListening, railWorkspaces),
    [remoteGroups, remoteListening, railWorkspaces],
  )
  // Remote chats asked to settle and not yet gone from their machine's list.
  // Hidden at once, as a local Settle moves its row at once; put back, with
  // the machine's reason, if it refuses. A key leaves the set when the list
  // stops naming the chat, so one brought back later is drawn again.
  const [settlingRemote, setSettlingRemote] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (settlingRemote.size === 0) return
    const listed = new Set(listedRemote.map((conversation) => conversation.key))
    const still = [...settlingRemote].filter((key) => listed.has(key))
    if (still.length !== settlingRemote.size) setSettlingRemote(new Set(still))
  }, [listedRemote, settlingRemote])
  const unattachedRemote = useMemo(
    () =>
      settlingRemote.size === 0
        ? listedRemote
        : listedRemote.filter((conversation) => !settlingRemote.has(conversation.key)),
    [listedRemote, settlingRemote],
  )
  // …and the complement: the conversation each OPEN remote row IS, so that row
  // can draw a line per agent standing in it instead of the single inert line
  // its own layout knows about (owner, 2026-09-13). Empty off the tailnet,
  // where those rows are not drawn at all.
  const remoteConversationByWorkspace = useMemo(
    () =>
      remoteLink === 'down'
        ? new Map<string, RemoteConversation>()
        : attachedConversations(remoteGroups, railWorkspaces),
    [remoteGroups, remoteLink, railWorkspaces],
  )
  // When each row here was last written to, on whichever machine it runs on.
  const chatRecency = useMemo(() => chatRecencyOf(remoteConversationByWorkspace), [remoteConversationByWorkspace])
  // Settle a chat on a paired machine: its machine owns the chat's rest, so
  // the row goes now and the machine is asked; a refusal brings it back with
  // the machine's own words.
  const settleRemoteConversation = useCallback(
    (conversation: RemoteConversation) => {
      const settle = window.api?.meshSettleConversation
      if (typeof settle !== 'function') return
      const restore = (message: string) => {
        setSettlingRemote((current) => {
          const next = new Set(current)
          next.delete(conversation.key)
          return next
        })
        showToast({ tone: 'error', title: `${conversation.title} was not settled`, description: message })
      }
      setSettlingRemote((current) => new Set(current).add(conversation.key))
      void settle({ connectionId: conversation.connectionId, workspaceId: conversation.workspaceId })
        .then((answer) => {
          if (!answer.ok) restore(answer.message)
          // Read again, so the list that no longer names it is what clears
          // the hidden key.
          else refreshRemote(conversation.connectionId)
        })
        .catch((error: unknown) => restore(error instanceof Error ? error.message : String(error)))
    },
    [refreshRemote],
  )

  // Mark unread on the chat in front waits for the person to leave it
  // (`canMarkWorkspaceUnread` below).
  const unreadOnLeaveRef = useRef(new Set<string>())
  const markWorkspaceUnread = useCallback((workspaceId: string) => {
    const mark = window.api?.workspaceMarkUnread
    if (typeof mark !== 'function') return
    void mark(workspaceId)
      .then((answer) => {
        if (!answer.ok) showToast({ tone: 'error', title: 'Not marked unread', description: answer.message })
      })
      .catch((error: unknown) =>
        showToast({
          tone: 'error',
          title: 'Not marked unread',
          description: error instanceof Error ? error.message : String(error),
        }),
      )
  }, [])

  // The chat in front in this window, stamped as seen while the window is
  // visible and focused (`useVisitStamp`). A chat here stamps this desktop's
  // own record; a chat followed from a paired machine stamps that machine's,
  // which keeps its read state, when it keeps one. A full-page surface or New
  // chat covering the chat means nobody is looking at it; only a surface
  // means it was left (`frontWorkspaceId`).
  const windowActive = useWindowActive()
  const recordWorkspaceVisit = useWorkspaceStore((s) => s.recordWorkspaceVisit)
  const visitTarget = useMemo((): VisitTarget | null => {
    if (!frontWorkspaceId) return null
    const workspace = workspaces.find((candidate) => candidate.id === frontWorkspaceId)
    if (!workspace) return null
    const origin = workspace.remoteOrigin
    if (origin) {
      const row = remoteConversationByWorkspace.get(workspace.id)?.agents[0]
      const visit = window.api?.meshVisitConversation
      if (!row?.lifecycle || typeof visit !== 'function') return null
      return {
        key: `remote:${origin.connectionId}:${origin.workspaceId}`,
        turnEndedAt: row.lastTurnEndedAt,
        visitedAt: row.lastVisitedAt,
        // The machine stamps the visit with its own clock, which this one's
        // may not agree with.
        stamp: () => {
          void visit({ connectionId: origin.connectionId, workspaceId: origin.workspaceId }).catch(() => undefined)
        },
      }
    }
    // The chat's latest finish this window knows of: its agents' terminals
    // (the registry's clock) and its chat sessions.
    const turnEndedAt = latestFinishOf(workspace, conversationsByWorkspaceId.get(workspace.id) ?? NO_CONVERSATIONS)
    return {
      key: `local:${workspace.id}`,
      turnEndedAt,
      visitedAt: typeof workspace.lastVisitedAt === 'number' ? workspace.lastVisitedAt : null,
      stamp: (at) => recordWorkspaceVisit(workspace.id, at),
      // The clock is read off the live store: the rows here are not drawn
      // again for a visit, so theirs can be a stamp behind.
      opened: () => {
        const live = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
        noteChatOpened(workspace.id, typeof live?.lastVisitedAt === 'number' ? live.lastVisitedAt : null, Date.now())
      },
      // Marked unread while it was in front: it takes effect now, as the
      // person leaves it, or the stamp would have read it again at once.
      left: () => {
        noteChatLeft(workspace.id)
        if (unreadOnLeaveRef.current.delete(workspace.id)) markWorkspaceUnread(workspace.id)
      },
    }
  }, [
    frontWorkspaceId,
    workspaces,
    remoteConversationByWorkspace,
    conversationsByWorkspaceId,
    recordWorkspaceVisit,
    markWorkspaceUnread,
  ])
  useVisitStamp(visitTarget, windowActive && !newChatOpen)

  // Mark unread moves the chat's visit clock back to just before its latest
  // finish, in main (`conversation.mark_unread`, the phone's too): its
  // "finished while you were away" mark comes back on every device, here by
  // `rewoundVisits` above, and the next opening's "New" divider sits above
  // its latest reply. Offered where that means something: an agent in the
  // chat has finished a turn and the row is not already marked. The chat in
  // front is marked as the person leaves it, since looking at it is what
  // reads it. A chat followed from a paired machine keeps its read state
  // there, so it is not offered for one.
  const canMarkWorkspaceUnread = (workspace: Workspace): boolean => {
    if (workspace.remoteOrigin || unseenDoneIds.has(workspace.id) || unreadOnLeaveRef.current.has(workspace.id))
      return false
    return latestFinishOf(workspace, conversationsByWorkspaceId.get(workspace.id) ?? NO_CONVERSATIONS) !== null
  }

  // A row opened from a paired machine's chat is settled by that machine,
  // which owns the chat; Settle from its menu asks it first, and only once it
  // has said yes does the row here go the way a local Settle takes a row: the
  // record rests, its view ends, and a window that has it in front moves on.
  // A refusal leaves the row, with the machine's own words.
  const remoteKeepsRest = useCallback(
    (workspace: Workspace): boolean =>
      Boolean(workspace.remoteOrigin) &&
      remoteLifecycleWritable(remoteBrowses.get(workspace.remoteOrigin!.connectionId)),
    [remoteBrowses],
  )
  const settleOpenedRemote = useCallback(
    (workspace: Workspace) => {
      const origin = workspace.remoteOrigin
      const settle = window.api?.meshSettleConversation
      if (!origin || typeof settle !== 'function') return
      const refused = (message: string) =>
        showToast({ tone: 'error', title: `${workspace.name} was not settled`, description: message })
      void settle({ connectionId: origin.connectionId, workspaceId: origin.workspaceId })
        .then((answer) => {
          if (answer.ok) settleWorkspaceById(workspace.id)
          else refused(answer.message)
        })
        .catch((error: unknown) => refused(error instanceof Error ? error.message : String(error)))
    },
    [settleWorkspaceById],
  )
  // …and one its machine settled without asking here — on the phone, on that
  // machine, from another desktop. Its browse says the chat is resting, and
  // the row here follows, once (`remoteRestToFollow`). The window that routes
  // the row settles it; any other window that has it in front learns from the
  // broadcast and moves on (`settledElsewhere`).
  // Kept across a restart: a row brought back here after its machine settled
  // the chat stays back, rather than being settled again by the first browse.
  const followedRemoteRest = useRef<Map<string, number> | null>(null)
  useEffect(() => {
    followedRemoteRest.current ??= readFollowedRemoteRests(readStoredFollowedRests())
    const followed = followedRemoteRest.current
    const due = remoteRestToFollow({ workspaces: railWorkspaces, browses: remoteBrowses, followed })
    if (due.length === 0) return
    for (const { workspaceId, settledAt } of due) {
      followed.set(workspaceId, settledAt)
      const workspace = railWorkspaces.find((candidate) => candidate.id === workspaceId)
      if (!workspace || isSettledWorkspace(workspace)) continue
      if (useWorkspaceStore.getState().speaksForWorkspace(workspaceId)) settleWorkspaceById(workspaceId)
    }
    storeFollowedRests(followedRemoteRestsToKeep(followed, railWorkspaces))
  }, [railWorkspaces, remoteBrowses, settleWorkspaceById])

  // Which project header a remote conversation files under. The same rule the
  // remote-born WORKSPACES follow (`groupKeyOf` + `resolveGroups`): this disk's
  // clone of the repository when there is one open here, else one header per
  // repository, else one per folder on that machine.
  const remoteGroupKeyOf = useCallback(
    (conversation: RemoteConversation): string => {
      const canonicalKey = conversation.repository?.canonicalKey
      if (canonicalKey) return groupKeyByRepository.get(canonicalKey) ?? `remote-repo:${canonicalKey}`
      return `remote:${conversation.connectionId}:${folderKey(conversation.workspaceRoot)}`
    },
    [groupKeyByRepository],
  )
  // The projects, with the remote conversations filed into them. A project
  // nothing here has open — every chat in it running on another machine — is a
  // real project and gets a header of its own, named after its folder there.
  const groups = useMemo(() => {
    const order = localGroups.map((group) => group.key)
    const byKey = new Map(localGroups.map((group) => [group.key, { ...group, remoteRows: [] as RemoteConversation[] }]))
    for (const conversation of unattachedRemote) {
      const key = remoteGroupKeyOf(conversation)
      let group = byKey.get(key)
      if (!group) {
        group = {
          key,
          displayName: remoteProjectName(conversation.workspaceRoot, conversation.machineName),
          // No LOCAL path: nothing here may reveal, forget, or create into a
          // folder that lives on another machine.
          fullPath: null,
          missing: false,
          workspaces: [],
          remote: {
            machineName: conversation.machineName,
            workspaceRoot: conversation.workspaceRoot,
            repository: conversation.repository,
          },
          remoteRows: [],
        }
        byKey.set(key, group)
        order.push(key)
      }
      group.remoteRows.push(conversation)
    }
    return order.map((key) => byKey.get(key)!)
  }, [localGroups, unattachedRemote, remoteGroupKeyOf])

  // Which shape this rail lists chats in — the project tree, or one stream of
  // all of them (all-chats-view, 2026-09-07). Read from the store rather than
  // drilled through props: it is a persisted app-level preference, the way the
  // active door is, and every window shows the same shape.
  //
  // Read here, set in Settings → Appearance (owner, 2026-09-07). It rode over
  // the list for a day and was struck: a control the person touches once and
  // lives with does not deserve a permanent seat above the thing it arranges,
  // and the rail's one control at the top is New chat.
  const chatListView = useWorkspaceStore((s) => s.chatListView)

  const groupByKey = useMemo(() => {
    const map = new Map<string, FolderGroup>()
    for (const group of groups) map.set(group.key, group)
    return map
  }, [groups])

  // …and the same fact summed per project, which is the second half of the ask:
  // "if those agents are suspended or dead, then they won't be showing in the
  // sidebar but their pull request will be showing beside the project."
  //
  // Summed over the project's CONVERSATIONS rather than scanned out of the
  // repository, so the number beside a project is always the number of rows
  // under it that have one — a header and its rows can never disagree.
  //
  // Open only. A conversation keeps its merged pull requests because that is its
  // history; a project's count is a to-do, and a merged one has nothing left to
  // do (`ProjectPullRequestMark`).
  // Each pull request once, however many of the project's chats wear it.
  const openPullRequestsByGroup = useMemo(() => {
    const lists = new Map<string, Array<readonly BranchPullRequest[]>>()
    for (const workspace of workspaces) {
      const list = conversationPullRequests[workspace.id]
      if (!list || list.length === 0) continue
      const groupKey = keyOf(workspace)
      lists.set(groupKey, [...(lists.get(groupKey) ?? []), list])
    }
    const map = new Map<string, number>()
    for (const [groupKey, group] of lists) {
      const open = openPullRequestCount(...group)
      if (open > 0) map.set(groupKey, open)
    }
    return map
  }, [conversationPullRequests, keyOf, workspaces])
  // ─── One colour per project, worn on the folder glyph ──────────────────
  //
  // Owner review 2026-09-09 (backlog/unfiled/2026-09-09-one-colour-per-project
  // -on-the-folder-glyph.md): "it's easy to get confused and mixed up ... make
  // that folder icon a different colour". With a dozen chats open, "which repo
  // is this row?" is answered by reading the folder name every time; a hue on
  // the glyph answers it before the name is read.
  //
  // THE GLYPH AND NOTHING ELSE ON THE ROW. Not a tinted pill, not a dot, not
  // the project's name in colour — the design system's "identity colour"
  // clause: a glyph may wear an identity hue only where nothing else on the row
  // is coloured, and the hue identifies, it never grades. This rail already
  // spends colour on state — gold for a turn waiting on the person, green for
  // one that finished, the selection edge — and a second coloured thing on the
  // same row would make the person read which of the two a colour meant. The
  // hue is hashed from the project's name, so it is the same on every machine;
  // yellow and green are on the wheel too, by the owner's ruling of 2026-09-11,
  // because the hue lives only on the folder glyph (utils/projectColor.ts).
  //
  // TWO CARRIERS in this rail, and only two: the flat stream's project line and
  // the folder header in the tree. Not the Starred or Remote band rows —
  // reviewed and cut on 2026-09-09. Those rows already carry the gold star or
  // the machine glyph, and a hue there would be a third colour channel on a row
  // that can also be wearing the needs-input wash; a red folder inside a gold
  // row is the exact fight the identity-colour clause exists to prevent. A
  // remote row filed under a local folder reads its project off that header,
  // which is what decision 3 asks for anyway.
  //
  // KEYED BY REPOSITORY, not by folder. A project is a repository, so this
  // disk's clone and a paired machine's copy of it are one project and wear one
  // hue — the machine is a glyph on the row, never a second colour, which keeps
  // the one-project-across-machines ruling intact. `folderIdentities` is
  // already read for every open folder, so the key costs nothing new; a folder
  // with no remote falls back to its normalised path.
  const projectColors = useProjectColors()

  // The key a folder group's header and rows colour by, or null when the group
  // is not a project at all: the "No folder" bucket, and a legacy remote group
  // whose root lives on another machine and has no local identity to read.
  //
  // `settled` is whether the repository question has been ANSWERED for this
  // folder. A hue is painted only then: the hue is hashed from the key, so a
  // project coloured under its path key and re-keyed to its repository a moment
  // later would change colour just after the window opened. Until the answer
  // lands the glyph is simply the plain folder outline — one beat, once per
  // project.
  const projectKeyOfGroup = useCallback(
    (group: FolderGroup): { key: string | null; settled: boolean } => {
      // A project that lives only on paired machines keys on its REPOSITORY,
      // so this disk's clone and that machine's wear one hue (decision 3) —
      // and on nothing at all when the machine could not say which repository
      // it is, since a path over there would key a colour that could disagree
      // with the local clone's. Settled either way: the machine has answered,
      // and there is no second read coming that would change the key.
      if (group.remote) {
        return {
          key: group.remote.repository
            ? projectColorKey({ folderPath: null, repository: group.remote.repository })
            : null,
          settled: true,
        }
      }
      // "No project" is not a project either, so it has no hue to key.
      if (!group.fullPath || isProjectlessChatsRoot(group.fullPath)) return { key: null, settled: true }
      const identityKey = folderIdentityKey(group.fullPath)
      return {
        key: projectColorKey({
          folderPath: group.fullPath,
          repository: folderIdentities.get(identityKey) ?? null,
        }),
        settled: folderIdentities.has(identityKey),
      }
    },
    [folderIdentities],
  )
  const projectKeyByGroupKey = useMemo(() => {
    const map = new Map<string, { key: string | null; settled: boolean }>()
    for (const group of groups) map.set(group.key, projectKeyOfGroup(group))
    return map
  }, [groups, projectKeyOfGroup])
  const projectKeyOf = useCallback(
    (groupKey: string): string | null => projectKeyByGroupKey.get(groupKey)?.key ?? null,
    [projectKeyByGroupKey],
  )
  const projectKeySettled = useCallback(
    (groupKey: string): boolean => projectKeyByGroupKey.get(groupKey)?.settled === true,
    [projectKeyByGroupKey],
  )
  // The hue a group's glyph wears: the person's override, else the hue hashed
  // from its key — and null until that key is final, per `settled` above.
  const projectColorOf = useCallback(
    (groupKey: string): ProjectColor | null => {
      const project = projectKeyByGroupKey.get(groupKey)
      return project?.settled ? resolveProjectColor(projectColors, project.key) : null
    },
    [projectKeyByGroupKey, projectColors],
  )

  // A stream row's project line. The same header the tree would have filed the
  // row under, so switching views never renames anything: one resolver, two
  // shapes. It carries the colour too, since the line IS the glyph's only
  // caller in the flat stream.
  const flatProjectOf = useCallback(
    (workspace: Workspace) => {
      const groupKey = keyOf(workspace)
      const group = groupByKey.get(groupKey)
      const folderPath = group?.fullPath ?? workspace.folderPath ?? null
      return {
        name: group?.displayName ?? 'No folder',
        folderPath,
        color: projectColorOf(groupKey),
        // No folder is not a project (decision 6): the dashed grey outline, so
        // "unfiled" reads as its own thing rather than as a project of its own.
        // Narrower than "has no colour" on purpose — a project whose read has
        // not landed, whose person chose "No colour", or that lives on another
        // machine has a folder and is NOT unfiled; it keeps the solid glyph in
        // the row's own ink.
        unfiled: !group?.remote && !folderPath,
      }
    },
    [groupByKey, keyOf, projectColorOf],
  )

  // The same line for a conversation on a paired machine. It resolves through
  // the SAME group the tree files it under, so a remote chat of a project open
  // here reads with that project's name and that project's hue — which is the
  // whole point of `one-project-across-machines`: the Mini's copy of sprintengine
  // is sprintengine, not "the Mini".
  //
  // Never unfiled: a remote conversation has a folder, it is simply on another
  // disk. The dashed outline means "no folder at all", which is a different
  // thing (decision 6).
  const flatProjectOfRemote = useCallback(
    (conversation: RemoteConversation): FlatProjectLine => {
      const groupKey = remoteGroupKeyOf(conversation)
      const group = groupByKey.get(groupKey)
      return {
        name: group?.displayName ?? remoteProjectName(conversation.workspaceRoot, conversation.machineName),
        folderPath: group?.fullPath ?? conversation.workspaceRoot,
        color: projectColorOf(groupKey),
        unfiled: false,
      }
    },
    [groupByKey, remoteGroupKeyOf, projectColorOf],
  )

  // The same line for a scheduled agent's row in the Scheduled section: the
  // project its runs start in, named and coloured as that project's header
  // is, since the row no longer sits under it.
  const flatProjectOfScheduled = useCallback(
    (agent: ScheduledAgentView): FlatProjectLine => {
      const groupKey = folderKey(agent.folderPath)
      const group = groupByKey.get(groupKey)
      return {
        name: group?.displayName ?? folderDisplayName(agent.folderPath),
        folderPath: agent.folderPath,
        color: projectColorOf(groupKey),
        unfiled: false,
      }
    },
    [groupByKey, projectColorOf],
  )

  // The row you are in always has a row: a settled chat you selected (or
  // settled from its own menu) keeps its place in the active list until you
  // leave it, and leaves the rail then. Reading it never wakes it. New chat
  // over it is leaving it, though the window's active id has not moved.
  const isShelved = useCallback(
    (workspace: Workspace) => isSettledWorkspace(workspace) && (workspace.id !== activeWorkspaceId || newChatOpen),
    [activeWorkspaceId, newChatOpen],
  )

  // Asleep RIGHT NOW: the wake time is still ahead, and that is the whole test
  // — nothing brings a row back early. Reading a chat never sends it to sleep,
  // the same exemption `isShelved` gives the row you are in, though in
  // practice opening one already spent its snooze (`setActiveWorkspace`), so
  // this is the belt to that braces.
  const isAsleep = useCallback(
    (workspace: Workspace) => workspace.id !== activeWorkspaceId && isSnoozedWorkspace(workspace, now),
    [activeWorkspaceId, now],
  )

  // A row that came back and has not been opened since. The list's order is
  // deliberately static, so a woken row does not move to announce itself and
  // has to say so on its own face; opening it clears the stamp and the mark
  // with it.
  const wokeAtOf = useCallback((workspace: Workspace) => workspaceWokeAt(workspace, now), [now])

  // The sleeping set, reported up for the rail's Home badge. Held as state and
  // compared by CONTENTS rather than rebuilt into the parent on every tick: the
  // wake is derived from a clock that moves every 30 s, and a fresh Set each
  // time would re-render the whole manager for a set that had not changed.
  // Same shape as the unseen-done marks above, which report up for the same
  // reason and bail out the same way.
  const [snoozedWorkspaceIds, setSnoozedWorkspaceIds] = useState<ReadonlySet<WorkspaceId>>(() => new Set())
  useEffect(() => {
    const next = new Set<WorkspaceId>()
    for (const workspace of workspaces) if (isAsleep(workspace)) next.add(workspace.id)
    setSnoozedWorkspaceIds((previous) => {
      if (next.size === previous.size && [...next].every((id) => previous.has(id))) return previous
      return next
    })
  }, [workspaces, isAsleep])
  useEffect(() => {
    onSnoozedWorkspacesChange?.(snoozedWorkspaceIds)
  }, [snoozedWorkspaceIds, onSnoozedWorkspacesChange])

  // A project whose every chat has come to rest leaves the sidebar (owner
  // ruling, 2026-09-07). Its header was a line that said nothing was happening
  // — a folder name over a "Settled 1" fold and nothing to do — and a person
  // with a dozen quiet projects read a dozen of them before reaching the work.
  // It is not archived and not forgotten: the folder is still open, and New
  // chat is where you pick a project to start a conversation in. The tree shows
  // the projects that have something going on.
  //
  // A folder returns the moment anything in it wakes, is un-settled, or is
  // selected — the active chat is never shelved, so opening one of its chats
  // from search or New chat brings its project back with it.
  //
  // Sleeping counts as gone for this test too (owner, 2026-09-10). A snoozed
  // chat is coming back, but the folder comes back WITH it — the wake needs no
  // event, so the header returns on the tick the stamp expires, and until then
  // it would be a project line over a fold with nothing to do, which is the
  // exact thing the ruling above removed. Nothing is stranded: the All chats
  // stream keeps one Snoozed shelf across every project (`renderChatStream`),
  // so a sleeper in a folder that has stepped out is still there to be found
  // and woken early.
  //
  // Starred workspaces order the same way the folders do: by the person's last
  // message, newest first, and nothing else. This supersedes manual drag
  // position within the Starred section.
  //
  // Starring MOVES the row here. It used to also stay under its project (and
  // in the all-chats stream), so the same chat was drawn twice; the session
  // manager dropdown already listed each one once (`buildSidebarWorkspaceOrder`)
  // and the rail now matches. A starred row never settles on its own, but a
  // person can settle one by hand; rest means rest, so it then leaves the
  // rail with every other settled chat.
  const starredWorkspaces = useMemo(
    () =>
      sortChatsByRecency(
        // `localRailWorkspaces`, so a STARRED remote chat goes with the tailnet
        // too: a row withheld from its project and left standing up here would
        // be the same chat saying two different things about whether it exists.
        localRailWorkspaces.filter(
          (workspace) => isStarred(workspace.highlight) && !isSettledWorkspace(workspace) && !isAsleep(workspace),
        ),
        chatRecency,
      ),
    [localRailWorkspaces, isAsleep, chatRecency],
  )
  const starredWorkspaceIds = useMemo(
    () => new Set(starredWorkspaces.map((workspace) => workspace.id)),
    [starredWorkspaces],
  )

  // A conversation running on a paired machine keeps its project here, the
  // same as a local one: it is something going on, and rest and sleep are
  // states a chat enters on THIS disk — nothing over there has one.
  //
  // A chat that has moved to Starred does not keep its project alive either:
  // the row is already on screen, and a header over an empty body is the
  // quiet-folder case above.
  const activeGroups = useMemo(
    () =>
      groups.filter(
        (group) =>
          group.remoteRows.length > 0 ||
          !group.workspaces.every((w) => isShelved(w) || isAsleep(w) || starredWorkspaceIds.has(w.id)),
      ),
    [groups, isShelved, isAsleep, starredWorkspaceIds],
  )

  const workspaceById = useMemo(() => {
    const map = new Map<WorkspaceId, Workspace>()
    for (const ws of workspaces) map.set(ws.id, ws)
    return map
  }, [workspaces])

  // `chat.settle` (⌘⇧S), routed here by the window for the chat on screen: the
  // same toggle as Settle in that row's menu, with the same hand-off.
  const settleFromCommand = useStableCallback((id: WorkspaceId) => {
    const workspace = workspaceById.get(id)
    if (!workspace || id !== activeWorkspaceId) return
    const step = chatSettleStep(workspace, rowIsWorking(id))
    if (step === 'restore') setWorkspaceSettled(id, false)
    else if (step === 'settle-remote') settleOpenedRemote(workspace)
    else if (step === 'settle') settleWorkspaceById(id)
    else
      showToast({
        tone: 'neutral',
        title: `${workspace.name} is still working`,
        description: 'It can be settled once its agents finish.',
      })
  })
  useEffect(() => {
    const onPanelCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; workspaceId?: string }>).detail
      if (detail?.id === 'chat.settle' && detail.workspaceId) settleFromCommand(detail.workspaceId)
    }
    window.addEventListener(PANEL_COMMAND_EVENT, onPanelCommand)
    return () => window.removeEventListener(PANEL_COMMAND_EVENT, onPanelCommand)
  }, [settleFromCommand])

  // Seed / repair the single tab stop. When no row owns it (first paint) or the
  // owning row has left the DOM (folder collapsed, workspace closed), hand it to
  // the active row if present, else the first row.
  useEffect(() => {
    const rows = getTreeRows()
    if (rows.length === 0) return
    if (rovingKey && rows.some((el) => el.dataset.rowKey === rovingKey)) return
    const activeRow = rows.find((el) => el.getAttribute('aria-current') === 'true')
    setRovingKey((activeRow ?? rows[0]).dataset.rowKey ?? null)
  }, [
    getTreeRows,
    rovingKey,
    localRailWorkspaces,
    groups,
    starredWorkspaces,
    collapsedFolders,
    expandedShelves,
    starredCollapsed,
    activeWorkspaceId,
    globalSurfaceActive,
  ])

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  const startRename = useCallback((workspace: Workspace) => {
    setRenamingId(workspace.id)
    setRenameValue(workspace.name)
  }, [])

  // F2 on the active workspace begins inline rename.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'F2') return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (renamingId || !activeWorkspaceId) return
      const workspace = workspaceById.get(activeWorkspaceId)
      if (!workspace) return
      event.preventDefault()
      startRename(workspace)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeWorkspaceId, renamingId, workspaceById, startRename])

  const commitRename = useCallback(() => {
    if (renamingId) renameWorkspace(renamingId, renameValue)
    setRenamingId(null)
  }, [renamingId, renameValue, renameWorkspace])

  const handleClose = useCallback(
    (workspaceId: WorkspaceId) => {
      const workspace = workspaceById.get(workspaceId)
      if (!workspace) return
      const activity = activityByWorkspaceId[workspaceId] ?? 'idle'
      if (activity === 'working' || activity === 'failed' || activity === 'needs-input') {
        setConfirmClose(workspaceId)
        return
      }
      onCloseWorkspace(workspaceId)
    },
    [workspaceById, activityByWorkspaceId, onCloseWorkspace],
  )

  const runWorkspaceTypeRowAction = useCallback(
    async (workspaceId: WorkspaceId, action: WorkspaceTypeRowAction) => {
      if (typeActionBusy) return
      setTypeActionBusy(true)
      try {
        await action.run(workspaceId)
      } finally {
        setTypeActionBusy(false)
      }
    },
    [typeActionBusy],
  )

  const handleRowDragStart = (event: React.DragEvent, workspace: Workspace, fKey: string) => {
    dragRef.current = { type: 'workspace', id: workspace.id, folderKey: fKey }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(DRAG_MIME_WORKSPACE, workspace.id)
  }

  const handleRowDragOver = (event: React.DragEvent, targetWorkspace: Workspace, fKey: string) => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.type !== 'workspace') return
    if (drag.folderKey !== fKey) {
      event.dataTransfer.dropEffect = 'none'
      setDropIndicator(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const position: 'before' | 'after' = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
    setDropIndicator({ kind: 'workspace', targetId: targetWorkspace.id, position })
  }

  const handleRowDrop = (event: React.DragEvent, targetWorkspace: Workspace, fKey: string) => {
    const drag = dragRef.current
    dragRef.current = null
    setDropIndicator(null)
    if (!drag || drag.type !== 'workspace') return
    if (drag.folderKey !== fKey) return
    event.preventDefault()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const position: 'before' | 'after' = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
    if (drag.id === targetWorkspace.id) return

    const folderWorkspaces = workspaces.filter((w) => keyOf(w) === fKey)
    const localOrderedIds = reorderWithinFolder(folderWorkspaces, drag.id, targetWorkspace.id, position)

    // Stitch: rebuild the global workspace order, replacing the contiguous block
    // for this folder with the new local order while leaving every other folder
    // alone.
    const localSet = new Set(localOrderedIds)
    const globalOrder: WorkspaceId[] = []
    let injected = false
    for (const ws of workspaces) {
      if (localSet.has(ws.id)) {
        if (!injected) {
          for (const id of localOrderedIds) globalOrder.push(id)
          injected = true
        }
      } else {
        globalOrder.push(ws.id)
      }
    }
    reorderWorkspaces(globalOrder)
  }

  const handleFolderDragStart = (event: React.DragEvent, fKey: string) => {
    dragRef.current = { type: 'folder', folderKey: fKey }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(DRAG_MIME_FOLDER, fKey)
  }

  const handleFolderDragOver = (event: React.DragEvent, fKey: string) => {
    const drag = dragRef.current
    if (!drag || drag.type !== 'folder') return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const position: 'before' | 'after' = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
    setDropIndicator({ kind: 'folder', targetKey: fKey, position })
  }

  const handleFolderDrop = (event: React.DragEvent, fKey: string) => {
    const drag = dragRef.current
    dragRef.current = null
    setDropIndicator(null)
    if (!drag || drag.type !== 'folder') return
    event.preventDefault()
    if (drag.folderKey === fKey) return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const position: 'before' | 'after' = event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
    const newOrder = reorderFolders(workspaces, drag.folderKey, fKey, position, keyOf)
    reorderWorkspaces(newOrder)
  }

  const handleDragEnd = (event: React.DragEvent) => {
    const drag = dragRef.current
    if (drag?.type === 'workspace' && didWorkspaceDragLeaveSidebar(event, sidebarRef.current)) {
      onMoveWorkspaceToNewWindow(drag.id, { screenX: event.screenX, screenY: event.screenY })
    }
    dragRef.current = null
    setDropIndicator(null)
    setTabDropTarget(null)
  }

  const migrateTabSideEffects = useCallback(
    (payload: TabDragPayload, destWorkspaceId: WorkspaceId) => {
      if (payload.sourceWorkspaceId === destWorkspaceId) return
      if (payload.component === 'agent') {
        const agentId = tabDragAgentId(payload)
        if (agentId) {
          moveAgentToWorkspace(payload.sourceWorkspaceId, destWorkspaceId, agentId)
        }
        return
      }
      if (payload.component === 'file-editor') {
        const filePath = payload.config && typeof payload.config.filePath === 'string' ? payload.config.filePath : null
        if (filePath) {
          moveOpenFileToWorkspace(payload.sourceWorkspaceId, destWorkspaceId, filePath)
        }
      }
    },
    [moveAgentToWorkspace, moveOpenFileToWorkspace],
  )

  const handleTabDragOverNew = useCallback((event: React.DragEvent) => {
    if (!dataTransferHasTabDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setTabDropTarget({ kind: 'new' })
  }, [])

  const handleTabDragLeaveNew = useCallback(() => {
    setTabDropTarget((current) => (current?.kind === 'new' ? null : current))
  }, [])

  // Extract a dragged tab into a brand-new workspace. `folderPath` decides which
  // project the new workspace belongs to: the source workspace's folder when the
  // tab is dropped on the "New chat" target, or the folder's own path when it is
  // dropped straight onto a project header.
  const extractTabIntoNewWorkspace = useCallback(
    (payload: TabDragPayload, folderPath: string | null) => {
      // Prefer the live-model spec (has the most up-to-date className/config)
      // and fall back to the drag payload if the source model has been
      // unmounted between drag start and drop.
      const liveSpec = extractTabSpec(payload.sourceWorkspaceId, payload.tabId) ?? null
      const spec: CrossWorkspaceTabSpec = liveSpec ?? {
        component: payload.component,
        name: payload.name,
        config: payload.config,
        className: payload.className,
      }

      const syntheticTemplate: LayoutTemplate = {
        id: `extracted-tab-${Date.now()}`,
        name: payload.name || 'Workspace',
        description: '',
        previewSlots: [],
        layout: buildSingleTabLayoutModel(spec),
      }

      const newWorkspaceId = addWorkspaceFromStore(syntheticTemplate, {
        name: payload.name || undefined,
        folderPath,
        windowId: workspaceWindowId,
        // The tab is an agent that already exists: it moves in with the create,
        // under its own id, rather than the new chat minting a stranger for its
        // tab or being created in main with a tab and no agent.
        moveLayoutAgentsFrom: payload.sourceWorkspaceId,
      })

      if (payload.component !== 'agent') migrateTabSideEffects(payload, newWorkspaceId)
      removeTab(payload.sourceWorkspaceId, payload.tabId, { preserveRuntime: true })
    },
    [addWorkspaceFromStore, migrateTabSideEffects, workspaceWindowId],
  )

  const handleTabDropOnNew = useCallback(
    (event: React.DragEvent) => {
      const payload = readTabDragPayload(event.dataTransfer)
      setTabDropTarget(null)
      if (!payload) return
      event.preventDefault()
      event.stopPropagation()

      const sourceWorkspace = workspaceById.get(payload.sourceWorkspaceId) ?? null
      extractTabIntoNewWorkspace(payload, sourceWorkspace?.folderPath ?? null)
    },
    [extractTabIntoNewWorkspace, workspaceById],
  )

  const handleTabDragOverRow = useCallback((event: React.DragEvent, workspace: Workspace) => {
    if (!dataTransferHasTabDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setTabDropTarget({ kind: 'workspace', id: workspace.id })
  }, [])

  const handleTabDragLeaveRow = useCallback((workspaceId: WorkspaceId) => {
    setTabDropTarget((current) => (current?.kind === 'workspace' && current.id === workspaceId ? null : current))
  }, [])

  const handleTabDropOnRow = useCallback(
    (event: React.DragEvent, workspace: Workspace) => {
      const payload = readTabDragPayload(event.dataTransfer)
      setTabDropTarget(null)
      if (!payload) return
      event.preventDefault()
      event.stopPropagation()

      // No-op if dropped on the source workspace itself.
      if (payload.sourceWorkspaceId === workspace.id) return
      // An agent keeps its id when it moves, so one whose id the destination
      // already has (two chats that each began with an `agent-1`) cannot go
      // there: the move would overwrite that chat's own agent. Refused before
      // anything changes, so the tab stays where it was.
      const movingAgentId = payload.component === 'agent' ? tabDragAgentId(payload) : null
      const destination = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)
      if (movingAgentId && destination?.agents[movingAgentId]) {
        showToast({
          tone: 'error',
          title: 'Agent not moved',
          description: `${workspace.name} already has an agent with the same id. Drop it on New chat to give it a chat of its own.`,
        })
        return
      }

      const liveSpec = extractTabSpec(payload.sourceWorkspaceId, payload.tabId) ?? null
      const spec: CrossWorkspaceTabSpec = liveSpec ?? {
        component: payload.component,
        name: payload.name,
        config: payload.config,
        className: payload.className,
      }

      const destinationModel = getModel(workspace.id)
      if (destinationModel) {
        addTabAsNewColumn(workspace.id, spec)
      } else {
        // Destination is unmounted; mutate persisted JSON so the new tab is
        // present when the layout next mounts. The store's layout, not the
        // row's: rows render from a projection that ignores layout changes.
        const currentLayout =
          useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)?.layoutModel ??
          workspace.layoutModel
        const nextLayout = appendTabAsNewColumnInJson(currentLayout, spec)
        updateLayout(workspace.id, nextLayout)
      }

      migrateTabSideEffects(payload, workspace.id)
      removeTab(payload.sourceWorkspaceId, payload.tabId, { preserveRuntime: true })
      setActiveWorkspace(workspace.id)
    },
    [migrateTabSideEffects, setActiveWorkspace, updateLayout],
  )

  // Dropping a tab on a project header extracts it into a NEW workspace filed
  // under that project — the gesture that reads as obvious once a project row is
  // on screen, and previously the one sidebar target that ignored tab drags
  // entirely (its handlers bail unless a folder-reorder drag is in flight). A
  // missing folder is refused: it cannot host a new workspace, matching the
  // folder context menu, which hides "New workspace" for the same reason.
  const handleTabDragOverFolder = useCallback((event: React.DragEvent, group: FolderGroup) => {
    if (!dataTransferHasTabDrag(event.dataTransfer)) return
    if (group.missing) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setTabDropTarget({ kind: 'folder', key: group.key })
  }, [])

  const handleTabDragLeaveFolder = useCallback((groupKey: string) => {
    setTabDropTarget((current) => (current?.kind === 'folder' && current.key === groupKey ? null : current))
  }, [])

  const handleTabDropOnFolder = useCallback(
    (event: React.DragEvent, group: FolderGroup) => {
      const payload = readTabDragPayload(event.dataTransfer)
      setTabDropTarget(null)
      if (!payload) return
      // A remote group has no local folder to file a tab under; accepting the
      // drop would create a folderless local workspace under a header that
      // names another machine.
      if (group.missing || group.remote) return
      event.preventDefault()
      event.stopPropagation()
      extractTabIntoNewWorkspace(payload, group.fullPath)
    },
    [extractTabIntoNewWorkspace],
  )

  // Everything a row can do, as callbacks whose identity never changes: each
  // runs the latest closure, so a row that skipped a render still acts on the
  // sidebar's current state (the drag in flight, the rename being typed).
  const stableSetContextMenu = useStableCallback(setContextMenu)
  const stableHandleClose = useStableCallback(handleClose)
  const stableSetWorkspaceSnoozed = useStableCallback(setWorkspaceSnoozed)
  const stableSettleWorkspaceById = useStableCallback(settleWorkspaceById)
  const stableSettleOpenedRemote = useStableCallback(settleOpenedRemote)
  const stableSetWorkspaceSettled = useStableCallback(setWorkspaceSettled)
  const stableOpenPaneTab = useStableCallback(openPaneTab)
  const stableSetRovingKey = useStableCallback(setRovingKey)
  const stableHandleTreeRowKeyDown = useStableCallback(handleTreeRowKeyDown)
  const stableHandleRowDragStart = useStableCallback(handleRowDragStart)
  const stableHandleRowDragOver = useStableCallback(handleRowDragOver)
  const stableHandleRowDrop = useStableCallback(handleRowDrop)
  const stableHandleDragEnd = useStableCallback(handleDragEnd)
  const stableHandleTabDragOverRow = useStableCallback(handleTabDragOverRow)
  const stableHandleTabDragLeaveRow = useStableCallback(handleTabDragLeaveRow)
  const stableHandleTabDropOnRow = useStableCallback(handleTabDropOnRow)
  const stableOnSelectWorkspace = useStableCallback(onSelectWorkspace)
  const stableStartRename = useStableCallback(startRename)
  const stableCommitRename = useStableCallback(commitRename)
  const stableSetRenameValue = useStableCallback(setRenameValue)
  const stableSetRenamingId = useStableCallback(setRenamingId)
  const rowHandlers = useMemo<WorkspaceRowHandlers>(
    () => ({
      setContextMenu: stableSetContextMenu,
      handleClose: stableHandleClose,
      setWorkspaceSnoozed: stableSetWorkspaceSnoozed,
      settleWorkspaceById: stableSettleWorkspaceById,
      settleOpenedRemote: stableSettleOpenedRemote,
      setWorkspaceSettled: stableSetWorkspaceSettled,
      openPaneTab: stableOpenPaneTab,
      setRovingKey: stableSetRovingKey,
      handleTreeRowKeyDown: stableHandleTreeRowKeyDown,
      handleRowDragStart: stableHandleRowDragStart,
      handleRowDragOver: stableHandleRowDragOver,
      handleRowDrop: stableHandleRowDrop,
      handleDragEnd: stableHandleDragEnd,
      handleTabDragOverRow: stableHandleTabDragOverRow,
      handleTabDragLeaveRow: stableHandleTabDragLeaveRow,
      handleTabDropOnRow: stableHandleTabDropOnRow,
      onSelectWorkspace: stableOnSelectWorkspace,
      startRename: stableStartRename,
      commitRename: stableCommitRename,
      setRenameValue: stableSetRenameValue,
      setRenamingId: stableSetRenamingId,
      renameInputRef,
    }),
    // Every entry is stable by construction; the list is here for the linter.
    [
      stableSetContextMenu,
      stableHandleClose,
      stableSetWorkspaceSnoozed,
      stableSettleWorkspaceById,
      stableSettleOpenedRemote,
      stableSetWorkspaceSettled,
      stableOpenPaneTab,
      stableSetRovingKey,
      stableHandleTreeRowKeyDown,
      stableHandleRowDragStart,
      stableHandleRowDragOver,
      stableHandleRowDrop,
      stableHandleDragEnd,
      stableHandleTabDragOverRow,
      stableHandleTabDragLeaveRow,
      stableHandleTabDropOnRow,
      stableOnSelectWorkspace,
      stableStartRename,
      stableCommitRename,
      stableSetRenameValue,
      stableSetRenamingId,
    ],
  )

  // Each row is its own memoized component (`WorkspaceRow`, below). It is
  // handed the values that are about ITS workspace, picked out of the
  // sidebar's maps here, so a change to one row's activity, a drag over
  // another, or a tick of the sidebar's clock re-renders the rows it touches
  // and not the whole list. The handlers ride one object that never changes
  // identity (`rowHandlers`).
  //
  // The flat stream's options carry a project line built afresh on every
  // render. A row keeps the options object it was last handed while what it
  // says is the same, so an equal copy is not a new prop.
  // Each render records the options it handed out, and the committed render's
  // record replaces the last one, so a row no longer drawn is forgotten.
  const rowOptionsRef = useRef(new Map<string, WorkspaceRowOptions>())
  const rowOptionsThisRender = new Map<string, WorkspaceRowOptions>()
  useEffect(() => {
    rowOptionsRef.current = rowOptionsThisRender
  })
  const stableRowOptions = (rowKey: string, options: WorkspaceRowOptions | undefined) => {
    if (!options?.flatProject) return options
    const prior = rowOptionsRef.current.get(rowKey)
    const kept = prior && rowOptionsEqual(prior, options) ? prior : options
    rowOptionsThisRender.set(rowKey, kept)
    return kept
  }
  const renderWorkspaceRow = (workspace: Workspace, fKey: string, options?: WorkspaceRowOptions) => {
    const rowKey = `${options?.keyPrefix ?? ''}${workspace.id}`
    return (
      <WorkspaceRow
        key={rowKey}
        workspace={workspace}
        fKey={fKey}
        options={stableRowOptions(rowKey, options)}
        // When a door-routed full-page surface owns the card region (epic
        // 1704), no workspace row is "current" — the door row carries the
        // selection, so a highlighted project row here would be a second,
        // conflicting selected state.
        active={!globalSurfaceActive && workspace.id === activeWorkspaceId}
        activity={activityByWorkspaceId[workspace.id] ?? 'idle'}
        recency={terminalRecencyByWorkspaceId[workspace.id]}
        wokeAt={wokeAtOf(workspace)}
        unseenDoneMark={unseenDoneIds.has(workspace.id)}
        resident={residentWorkspaceIds.has(workspace.id)}
        dropMark={
          dropIndicator?.kind === 'workspace' && dropIndicator.targetId === workspace.id ? dropIndicator.position : null
        }
        isTabDropTarget={tabDropTarget?.kind === 'workspace' && tabDropTarget.id === workspace.id}
        rowConversation={remoteConversationByWorkspace.get(workspace.id) ?? null}
        remoteSettle={remoteKeepsRest(workspace)}
        liveSessions={sessionsByWorkspaceId.get(workspace.id) ?? NO_SESSIONS}
        peekSessions={peekSessionsByWorkspaceId.get(workspace.id) ?? NO_SESSIONS}
        conversationSessions={conversationsByWorkspaceId.get(workspace.id) ?? NO_CONVERSATIONS}
        gitSummaries={rowGitSummaries.get(workspace.id) ?? NO_GIT_SUMMARIES}
        rowConversationPullRequests={conversationPullRequests[workspace.id]}
        chatLinePullRequestsByAgent={conversationLinePullRequests[workspace.id]}
        rowLocalServers={workspaceLocalServers[workspace.id]}
        moduleOverrides={moduleOverrides}
        isRovingTarget={rovingKey === rowKey}
        anyRenaming={renamingId !== null}
        renaming={renamingId === workspace.id}
        renameValue={renamingId === workspace.id ? renameValue : ''}
        handlers={rowHandlers}
      />
    )
  }

  // A conversation on a paired machine that no workspace here is attached to.
  //
  // The same row a local chat gets (owner, 2026-09-11): its own title, a line
  // per agent in it saying what a local chat's line says, and — in the flat
  // stream — the project line above it, with the same glyph in the same hue
  // the project wears everywhere else. What is different is said in one mark:
  // the machine glyph beside the project's folder icon, naming the device on
  // hover. Opening it attaches a pane here.
  //
  // No drag, rename, or close: those are a workspace's, and this row has none
  // until it is opened. Settle is the chat's, and its machine keeps it, so
  // the seat offers the same tick a local row does wherever that machine may
  // be asked (`RemoteSessionRow.lifecycle`).
  //
  // The seat and the surface are the local rows' own (owner ruling
  // 2026-09-05): the working mark with how long the turn has run, the gold
  // surface for a turn waiting on a person, the green one for a finish nobody
  // has seen, a quiet time since an idle row last worked. No status dot —
  // that vocabulary was already spoken for.
  const renderRemoteConversationRow = (
    conversation: RemoteConversation,
    options?: { flatProject?: FlatProjectLine },
  ) => {
    const rowKey = `remote-session-${conversation.key}`
    const open = () => onOpenRemoteSession?.(openSpecOfConversation(conversation))
    const agent = conversation.agents[0]!
    const needsAttention = conversation.activity === 'needs-input'
    const unseenDone = !needsAttention && conversation.agents.some(remoteFinishUnseen)
    const working = conversation.activity === 'working'
    const flatProject = options?.flatProject ?? null
    const surface = needsAttention
      ? attentionRowClass(false)
      : unseenDone
        ? doneRowClass(false)
        : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]'
    const lines = conversation.agents.map(lineOfRemoteRow)
    const machine: RowMachine = {
      ref: { kind: 'paired', name: conversation.machineName },
      name: conversation.machineName,
    }
    // The local rows' hover-and-focus-revealed actions, in the same place:
    // "More actions", then Settle, which waits while the agent works.
    const actions = (
      <span className="pointer-events-none absolute inset-y-0 right-0 inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <Tooltip content="More actions">
          <IconButton
            onClick={(event) => {
              event.stopPropagation()
              const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
              setRemoteMenu({ key: conversation.key, x: bounds.right, y: bounds.bottom })
            }}
            tone="quiet"
            aria-label="Chat actions"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="icon-xs" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.2" />
              <circle cx="8" cy="8" r="1.2" />
              <circle cx="12.5" cy="8" r="1.2" />
            </svg>
          </IconButton>
        </Tooltip>
        {agent.lifecycle ? (
          <Tooltip content={working ? 'Settle once its agents finish' : 'Settle'}>
            <IconButton
              onClick={(event) => {
                event.stopPropagation()
                if (working) return
                settleRemoteConversation(conversation)
              }}
              tone="quiet"
              aria-disabled={working || undefined}
              aria-label={`Settle ${conversation.title}`}
            >
              {SETTLE_TICK_GLYPH}
            </IconButton>
          </Tooltip>
        ) : null}
      </span>
    )
    // The flat stream's seat rides the project line, as a local row's does;
    // in the tree the first agent line's own seat carries the actions.
    const idleSince = lines[0]!.idleSince
    const idleText = !working && idleSince !== null ? formatRelativeMs(idleSince, now) : ''
    const flatSeat = (
      <span className="relative ml-auto flex h-5 min-w-[44px] shrink-0 items-center justify-end pl-2">
        <span className="inline-flex items-center gap-1 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
          {working ? (
            <>
              <WorkingMark label={activityLabel('working')} seed={conversation.key} />
              {lines[0]!.workingSince !== null ? <WorkingElapsed since={lines[0]!.workingSince} /> : null}
            </>
          ) : idleText ? (
            <RowTooltip
              content={`Idle ${formatRelativeMsAgo(idleSince, now)} (${new Date(idleSince!).toLocaleString()})`}
            >
              <span className="text-meta tabular-nums text-[color:var(--text-subtle)]">
                <span aria-hidden="true">{idleText}</span>
                <span className="sr-only">Idle {formatRelativeMsAgo(idleSince, now)}</span>
              </span>
            </RowTooltip>
          ) : null}
        </span>
        {actions}
      </span>
    )
    return (
      <div
        key={rowKey}
        data-row-key={rowKey}
        data-remote-session={agent.sessionId}
        data-remote-conversation={conversation.key}
        data-remote-activity={conversation.activity}
        tabIndex={rovingKey === rowKey ? 0 : -1}
        onFocus={() => setRovingKey(rowKey)}
        onKeyDown={(event) => handleTreeRowKeyDown(event, null, open)}
        onClick={open}
        // The local rows' menu gesture: a right-click, or the context-menu
        // key and Shift+F10 on the focused row, which the browser turns into
        // this same event.
        onContextMenu={(event) => {
          event.preventDefault()
          setRemoteMenu({ key: conversation.key, x: event.clientX, y: event.clientY })
        }}
        // design-tokens-allow: alignment — the same 26px inset as the workspace rows, so a remote title sits on the content column; the flat stream's rows start at the project line instead
        className={`interactive group relative mx-1.5 my-0.5 flex min-h-control-sm cursor-pointer select-none flex-col justify-center gap-0.5 rounded-md border-l-[4px] border-l-transparent py-1 pr-1.5 text-heading ${
          flatProject ? 'pl-1.5' : 'pl-[26px]'
        } ${surface} ${FOCUS_RING_CLASS}`}
        role="treeitem"
      >
        {flatProject ? (
          <ProjectLine project={flatProject} machine={machine}>
            {flatSeat}
          </ProjectLine>
        ) : null}
        <AttentionPulse active={needsAttention} resetKey={conversation.key} />
        <AttentionPulse active={unseenDone} resetKey={conversation.key} tone="good" />
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {/* In the tree the project header is above and carries no machine,
                so the row wears the glyph; in the flat stream the project line
                already wears it, right of the folder icon. */}
            {flatProject ? null : <MachineRowGlyph machine={machine} />}
            {/* Weight marks a running turn, or one that wants you, the way
                `workspaceRowEmphasis` weights a local row. */}
            <TruncatedText
              as="span"
              text={conversation.title}
              className={`min-w-0 flex-1 ${working || needsAttention || unseenDone ? 'font-semibold' : ''}`}
            />
            <span className="sr-only"> (on {conversation.machineName}, not open here)</span>
            {needsAttention ? <span className="sr-only"> (needs your input)</span> : null}
            {unseenDone ? <span className="sr-only"> (finished while you were away)</span> : null}
          </span>
        </div>
        {/* One line per agent, the way a local chat draws its chats.
            `disambiguate` is what makes a row of three say WHICH of them is
            the one waiting on a person. */}
        {lines.map((line, index) => (
          <TerminalLineView
            key={line.key}
            line={line}
            now={now}
            seatOverlay={index === 0 && !flatProject ? actions : undefined}
            disambiguate={lines.length > 1}
            rowOwnsStatus={flatProject !== null}
          />
        ))}
      </div>
    )
  }

  // Sleeping rows order by WAKE TIME, soonest first — the one question a person
  // opening that shelf is asking. The active list's last-message order would
  // rank them by a past nobody is looking at.
  const sortByWake = (rows: Workspace[]): Workspace[] =>
    [...rows].sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0))

  // Renders a folder's workspace rows: the active rows, most recently messaged
  // first, then — only when the folder has any — its Snoozed shelf: one fold
  // row carrying the count, closed by default, over the sleeping rows.
  //
  // Settled rows are not drawn here at all (owner, 2026-09-28). The Settled
  // shelf was one more line to read past on every folder, for chats the
  // person had already called finished; they live in Settings ▸ Settled chats
  // now (`SettledChatsSettingsTab`), where they are opened or un-settled. A
  // chat still comes to rest only by the settle rule (`utils/workspaceSettle.ts`),
  // and the one you are in keeps its row until you leave it (`isShelved`).
  //
  // `folderBodyId` lets the folder header's toggle button own an
  // aria-controls pointing at the body it expands/collapses.
  const renderFolderBody = (
    group: FolderGroup,
    visibleWorkspaces: Workspace[],
    folderCollapsed: boolean,
    folderBodyId: string,
  ) => {
    // Keep the body element mounted (empty + hidden) while collapsed so the
    // header's aria-controls always resolves to a real node.
    if (folderCollapsed) return <div id={folderBodyId} hidden />

    // Rest outranks sleep: a settled row that also carries a stale snooze is
    // off the rail, not in the Snoozed shelf.
    const snoozedRows = sortByWake(visibleWorkspaces.filter((w) => !isShelved(w) && isAsleep(w)))
    const activeRows = visibleWorkspaces.filter((workspace) => !isShelved(workspace) && !isAsleep(workspace))

    // The project's conversations on paired machines among its local ones,
    // by when each was last written to (`interleaveChats`).
    const rows = interleaveChats(activeRows, group.remoteRows, chatRecency).map((entry) =>
      entry.kind === 'local'
        ? renderWorkspaceRow(entry.workspace, group.key)
        : renderRemoteConversationRow(entry.conversation),
    )

    if (snoozedRows.length === 0) {
      return <div id={folderBodyId}>{rows}</div>
    }

    const slug = group.key.replace(/[^a-z0-9]+/giu, '-')
    const snoozeKey = `__snoozed__:${group.key}`
    const snoozeExpanded = expandedShelves[snoozeKey] === true
    const snoozeShelfId = `ws-snoozed-${slug}`

    return (
      <div id={folderBodyId}>
        {rows}
        <ShelfFoldRow
          label="Snoozed"
          count={snoozedRows.length}
          expanded={snoozeExpanded}
          controlsId={snoozeShelfId}
          onToggle={() => setExpandedShelves((prev) => ({ ...prev, [snoozeKey]: !snoozeExpanded }))}
        />
        <div
          id={snoozeShelfId}
          role="group"
          aria-label={`Snoozed chats in ${group.displayName}`}
          hidden={!snoozeExpanded}
        >
          {snoozeExpanded
            ? snoozedRows.map((workspace) => renderWorkspaceRow(workspace, group.key, SNOOZED_ROW))
            : null}
        </div>
      </div>
    )
  }

  // The flat stream (all-chats-view, 2026-09-07): every local chat in one list,
  // ordered by when you last messaged each (owner, 2026-09-07 — this list used
  // to count the agent's turn too, and a chat finishing then jumped ahead of
  // the row you were reaching for), except the ones that have moved to Starred
  // so the same chat is not drawn twice. No headings: the gold and green washes
  // say which rows want you, and a band would be a second, weaker way of saying
  // it (owner, 2026-09-07).
  //
  // Sleep works exactly as it does in the tree, with one shelf instead of one
  // per project: the same rows, the same fold, the same count. Settled rows
  // are off the rail here too — Settings ▸ Settled chats holds them.
  //
  // A chat running on a paired machine is a row of this list like any other
  // (owner, 2026-09-11) — same project line, same title, same shape — with the
  // green machine glyph beside the folder icon saying where it runs, and it
  // sits among them by when it was last written to, as the tree's rows do
  // (`interleaveChats`).
  // The Scheduled section, after every chat in either shape of the list: one
  // fold row over a row per scheduled agent, hidden when there are none. The
  // fold is the Snoozed shelves' own, and its state lives beside theirs, but
  // it starts open: a schedule is something the person set up to keep, and
  // one they just made should be on screen, not behind a count.
  //
  // A row opens its schedule's editor, never a run — the runs are chats, in
  // the list above with the schedule's clock on them, and the editor lists a
  // schedule's recent ones.
  const renderScheduledSection = () => {
    if (scheduledAgents.length === 0) return null
    const expanded = expandedShelves[SCHEDULED_SHELF_KEY] !== false
    return (
      <section role="group" className="relative pt-1" aria-label="Scheduled agents">
        <ShelfFoldRow
          label="Scheduled"
          count={scheduledAgents.length}
          expanded={expanded}
          flush
          controlsId={SCHEDULED_SHELF_ID}
          onToggle={() => setExpandedShelves((prev) => ({ ...prev, [SCHEDULED_SHELF_KEY]: !expanded }))}
        />
        <div id={SCHEDULED_SHELF_ID} role="group" aria-label="Scheduled agents" hidden={!expanded}>
          {expanded
            ? scheduledAgents.map((agent) => (
                <ScheduledAgentRow
                  key={`scheduled-${agent.id}`}
                  agent={agent}
                  now={now}
                  project={flatProjectOfScheduled(agent)}
                  runInProgress={scheduledAgentRunInProgress(agent, activityByWorkspaceId)}
                  selected={openScheduledAgentId === agent.id}
                  onOpen={() => onOpenScheduledAgent?.(agent.id)}
                  onClose={() => closeScheduledAgent(agent)}
                />
              ))
            : null}
        </div>
      </section>
    )
  }

  const renderChatStream = () => {
    const snoozedRows = sortByWake(localRailWorkspaces.filter((w) => !isShelved(w) && isAsleep(w)))
    const streamRows = sortWorkspacesByUserMessage(
      localRailWorkspaces.filter((w) => !isShelved(w) && !isAsleep(w) && !starredWorkspaceIds.has(w.id)),
    )
    const snoozeExpanded = expandedShelves[ALL_CHATS_SNOOZE_SHELF_KEY] === true
    return (
      <section role="group" className="relative pt-1" aria-label="All chats">
        {interleaveChats(streamRows, unattachedRemote, chatRecency).map((entry) =>
          entry.kind === 'local'
            ? renderWorkspaceRow(entry.workspace, keyOf(entry.workspace), {
                keyPrefix: 'all-',
                flatProject: flatProjectOf(entry.workspace),
              })
            : renderRemoteConversationRow(entry.conversation, {
                flatProject: flatProjectOfRemote(entry.conversation),
              }),
        )}
        {snoozedRows.length > 0 ? (
          <>
            <ShelfFoldRow
              label="Snoozed"
              count={snoozedRows.length}
              expanded={snoozeExpanded}
              flush
              controlsId={ALL_CHATS_SNOOZE_SHELF_ID}
              onToggle={() =>
                setExpandedShelves((prev) => ({
                  ...prev,
                  [ALL_CHATS_SNOOZE_SHELF_KEY]: !snoozeExpanded,
                }))
              }
            />
            <div id={ALL_CHATS_SNOOZE_SHELF_ID} role="group" aria-label="Snoozed chats" hidden={!snoozeExpanded}>
              {snoozeExpanded
                ? snoozedRows.map((workspace) =>
                    renderWorkspaceRow(workspace, keyOf(workspace), {
                      keyPrefix: 'all-',
                      snoozed: true,
                      flatProject: flatProjectOf(workspace),
                    }),
                  )
                : null}
            </div>
          </>
        ) : null}
      </section>
    )
  }

  // One folder's section: the header (drag, context menu, disclosure) over the
  // body.
  const renderFolderSection = (group: FolderGroup) => {
    const collapsed = collapsedFolders[group.key] === true
    // Rows order by the person's last message, newest first. A finishing or
    // blocked agent tints the row but never moves it (owner ruling
    // 2026-09-09) — the same order the Starred band and the flat stream use,
    // so a row only ever changes seat when someone speaks in it.
    const visibleWorkspaces = sortWorkspacesByUserMessage(
      group.workspaces.filter((workspace) => !starredWorkspaceIds.has(workspace.id)),
    )
    const folderBodyId = `ws-folder-body-${group.key.replace(/[^a-z0-9]+/giu, '-')}`
    // Folded, the header says how many of the rows it hides are waiting on
    // the person (`projectWaiting.ts`): the rows a fold would draw, so a
    // resting or sleeping chat is not counted, and the paired machine's too.
    const waiting = collapsed
      ? waitingLabel(
          waitingChatCount([
            ...visibleWorkspaces
              .filter((workspace) => !isShelved(workspace) && !isAsleep(workspace))
              .map((workspace) => activityByWorkspaceId[workspace.id]),
            ...group.remoteRows.map((conversation) => conversation.activity),
          ]),
        )
      : null
    const dropMark =
      dropIndicator?.kind === 'folder' && dropIndicator.targetKey === group.key ? dropIndicator.position : null
    const isFolderTabDropTarget = tabDropTarget?.kind === 'folder' && tabDropTarget.key === group.key
    return (
      <section key={group.key} role="group" className="relative pt-1">
        {/* The header container carries drag + context-menu; the disclosure
            itself is a real button (aria-expanded / aria-controls) so the
            folder is keyboard-operable, with the overflow control as a
            sibling rather than a nested interactive element. */}
        <header
          draggable
          onDragStart={(event) => handleFolderDragStart(event, group.key)}
          onDragOver={(event) => {
            if (dataTransferHasTabDrag(event.dataTransfer)) {
              handleTabDragOverFolder(event, group)
              return
            }
            handleFolderDragOver(event, group.key)
          }}
          onDragLeave={() => handleTabDragLeaveFolder(group.key)}
          onDrop={(event) => {
            if (dataTransferHasTabDrag(event.dataTransfer)) {
              handleTabDropOnFolder(event, group)
              return
            }
            handleFolderDrop(event, group.key)
          }}
          onDragEnd={handleDragEnd}
          onContextMenu={(event) => {
            event.preventDefault()
            setFolderMenu({ folderKey: group.key, x: event.clientX, y: event.clientY })
          }}
          // `min-h-control-sm`, not a fixed 26px: the fold row inside is the
          // kit's nav row now, and its floor is the sidebar's control step.
          className={`group/folder relative flex min-h-control-sm select-none items-center gap-1.5 pr-2 text-[color:var(--text-muted)] ${
            group.missing ? 'text-[color:var(--tone-warn)]' : ''
          }`}
        >
          {dropMark === 'before' ? (
            <span
              aria-hidden="true"
              className="absolute inset-x-1 top-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]"
            />
          ) : null}
          {dropMark === 'after' ? (
            <span
              aria-hidden="true"
              className="absolute inset-x-1 bottom-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]"
            />
          ) : null}
          {isFolderTabDropTarget ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-1 inset-y-0 rounded-md ring-2 ring-[color:var(--accent-primary)]"
            />
          ) : null}
          <Tooltip
            content={
              group.remote
                ? `${group.remote.machineName} · ${group.remote.workspaceRoot ?? 'remote workspace'}`
                : (group.fullPath ?? 'Workspaces with no folder')
            }
            placement="bottom"
            wrapperClassName="flex h-full min-w-0 flex-1"
          >
            {/* The kit's nav row. The missing-folder hover tint is gone rather
              than carried over: it was a second `hover:text-[color:var(--…)]`
              at equal specificity, so which ink painted was stylesheet order.
              The `Missing` chip beside the name is what states that fact. */}
            <RowButton
              density="nav"
              onClick={() => setCollapsedFolders((prev) => ({ ...prev, [group.key]: !collapsed }))}
              aria-expanded={!collapsed}
              aria-controls={folderBodyId}
              className="min-w-0 flex-1 pl-4"
            >
              {/* One icon slot: the folder's identity at
                rest — the project's own logo when its repo has one, the
                folder glyph when it does not (re-sited here by
                the owner on 2026-09-02) — and the collapse chevron
                swapped in on hover. */}
              <span className="relative flex size-icon-sm shrink-0 items-center justify-center">
                {/* A remote group's root lives on another machine: looking
                  it up on THIS disk would present an unrelated local
                  folder's logo (or stat a path that does not exist), so
                  the header wears the neutral mark until the gateway
                  serves project identity.

                  The project's colour rides the same slot, and the logo still
                  wins inside FolderIdentityIcon: a detected logo already
                  answers "which project is this", and a hue behind it would
                  answer it twice. The "No folder" bucket is not a project at
                  all, so it gets the dashed outline instead of a hue. */}
                <FolderIdentityIcon
                  folderPath={group.remote ? null : group.fullPath}
                  className="icon-sm shrink-0 transition-opacity group-hover/folder:opacity-0"
                  color={projectColorOf(group.key)}
                  unfiled={!group.remote && !group.fullPath}
                />
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                  className={`icon-xs absolute inset-0 m-auto text-[color:var(--text-muted)] opacity-0 transition-[opacity,transform] group-hover/folder:opacity-100 ${
                    collapsed ? '-rotate-90' : ''
                  }`}
                >
                  <path
                    d="M5 6L8 9L11 6"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              {group.remote ? <RemoteMachineGlyph className="icon-xs shrink-0 text-[color:var(--text-muted)]" /> : null}
              <span className="min-w-0 flex-1 truncate text-heading font-semibold text-[color:var(--text-strong)]">
                {group.displayName}
              </span>
              {waiting ? (
                <span data-project-waiting="" className="shrink-0 text-micro text-[color:var(--tone-warn)]">
                  {waiting}
                </span>
              ) : null}
              {/* What is open across this project's chats, including the ones
                whose agents have finished and which therefore say nothing for
                themselves. Inside the header's own button: it is part of what
                this header says, and it is not a control — a count of three has
                no single pull request to open, and a button here would steal
                the header's click. */}
              <ProjectPullRequestMark
                openCount={openPullRequestsByGroup.get(group.key) ?? 0}
                projectName={group.displayName}
              />
            </RowButton>
          </Tooltip>
          {group.missing ? (
            <span className="inline-flex items-center gap-1.5 text-meta font-medium text-[color:var(--tone-warn)]">
              <StatusDot tone="warn" label="Folder missing" />
              Missing
            </span>
          ) : null}
          <Tooltip content="Folder actions">
            <IconButton
              onClick={(event) => {
                event.stopPropagation()
                setFolderMenu({
                  folderKey: group.key,
                  x: (event.currentTarget as HTMLElement).getBoundingClientRect().right,
                  y: (event.currentTarget as HTMLElement).getBoundingClientRect().bottom,
                })
              }}
              tone="quiet"
              className="ml-1 opacity-0 transition-opacity group-hover/folder:opacity-100 focus-visible:opacity-100"
              aria-label={`Folder actions: ${group.displayName}`}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" className="icon-xs" aria-hidden="true">
                <circle cx="3.5" cy="8" r="1.2" />
                <circle cx="8" cy="8" r="1.2" />
                <circle cx="12.5" cy="8" r="1.2" />
              </svg>
            </IconButton>
          </Tooltip>
        </header>
        {renderFolderBody(group, visibleWorkspaces, collapsed, folderBodyId)}
      </section>
    )
  }

  return (
    <aside
      ref={sidebarRef}
      aria-label="Workspaces"
      // The shell's LEADING list, so `primary` rather than `auto`
      // (assets/index.css, "Selection tiers"). `auto` rests on anything that is
      // not `:focus-within`, and the pane beside this one is a terminal or a
      // chat transcript — a canvas, not a selection pane. So in the app's
      // ordinary state, focus sits outside every marked pane and the current
      // chat's row spent its whole life at the resting tier: the fill dropped a
      // rung and `--text-strong` fell back to `--text-default`, which left the
      // selected row DIMMER than a neighbouring resident row wearing
      // `font-semibold text-strong` on its own. The screen showed zero focused
      // selections — the failure the pattern exists to prevent. `primary`
      // holds the tier while focus sits outside every pane and rests only once
      // another pane (the composer's roster, the file tree) actually takes it,
      // which is the same ruling the door rails already carry.
      //
      // Dropped entirely while a door owns this column, because then this aside
      // is not the pane — the door's rail inside it is, and that rail declares
      // itself `primary`. Two `primary` marks nested one inside the other would
      // put two full-strength selections on one screen the moment focus left
      // both, and "one per surface" is the whole rule. Nothing here loses its
      // own tier by standing down: the workspaces tree is `hidden` in that
      // state, so its rows are neither visible nor focusable.
      {...(contextRailActive ? {} : { 'data-selection-pane': 'primary' })}
      // Width is class-driven when collapsed (fixed icon rail) and style-driven
      // when expanded (user-resizable). The width glide is suppressed mid-drag
      // so the rail tracks the pointer instead of lagging the 150ms transition.
      // During a drag the live width comes from dragWidthRef (the drag writes it
      // straight to this element and never to the store), so an unrelated
      // re-render mid-drag keeps the current width instead of the stale store one.
      style={
        sidebarCollapsed || fillWidth
          ? undefined
          : {
              width: clampSidebarWidth(
                isResizingSidebar && dragWidthRef.current !== null ? dragWidthRef.current : sidebarWidth,
              ),
              // The persisted width is absolute and this rail is shrink-0, so a
              // window narrower than the width the user last dragged handed the
              // sidebar most of it — 296px of a 390px window, leaving 94px for
              // the whole workspace. The cap is a share of the shell, so the
              // rail gives ground before the surface beside it does. It only
              // binds under a ~1156px window (45% of that is SIDEBAR_MAX_WIDTH);
              // on a narrower one a drag past the cap still records the width the
              // pointer asked for, so widening the window restores it.
              maxWidth: '45%',
            }
      }
      className={`relative flex flex-col bg-[color:var(--bg-canvas)] ${fillWidth ? 'min-w-0 flex-1' : 'shrink-0'} ${
        isResizingSidebar ? '' : 'transition-[width] duration-150 ease-out motion-reduce:transition-none'
      } ${sidebarCollapsed ? 'hidden' : ''}`}
    >
      {/* Drag the right edge to resize; drag it close to the left to collapse.
          A focusable separator is a window splitter, so it says its position:
          the sidebar's width within its bounds. */}
      {fillWidth ? null : (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={Math.round(sidebarWidth)}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
          onDoubleClick={handleResizeDoubleClick}
          className={`group absolute right-0 top-0 z-[var(--z-pane)] h-full w-1.5 translate-x-1/2 cursor-col-resize ${FOCUS_RING_CLASS}`}
        >
          <span
            aria-hidden="true"
            // Starts BELOW the 36px band, exactly like the app rail's hairline
            // (AppRail.tsx): nothing draws a vertical line through the top bar,
            // and this indicator used to run the window's full height.
            className={`absolute bottom-0 top-[36px] left-1/2 w-px -translate-x-1/2 bg-[color:var(--accent-primary)] transition-opacity ${
              isResizingSidebar ? 'opacity-100' : 'opacity-0 group-hover:opacity-60'
            }`}
          />
        </div>
      )}
      {/*
       * The sidebar runs to the top of the window, so its own top strip
       * (SidebarChrome) leads: window controls (collapse, search, back/forward,
       * and on win/linux the app menu) that used to sit in the full-width title
       * bar. The Files / Git / Backlog panel switches live in the workspace
       * header over the content, not here.
       *
       * `window-chrome` on the strip and NOT on the card below it: the strip is
       * made of the OS frost under the glass window material, so the neutral
       * fills its controls wear — hover, press — are tints of the frost rather
       * than opaque slabs over it (assets/index.css, the glass block). The card
       * is an opaque surface and keeps the opaque ramp. On a solid window the
       * class carries nothing.
       */}
      <div className="window-chrome shrink-0">{chromeSlot}</div>
      {/* Everything below the chrome strip is ONE card (owner, 2026-09-09): the
          sidebar reads like the pane column on the other side of the workspace —
          a rounded opaque surface with a thin frost gap beside it — so the shell
          is rail · card · card · card and the glass shows as the frame around
          them rather than as the ground three different columns happen to sit
          on. The strip above stays in the frosted band with the rest of the
          window's top 36px, exactly as the pane's tab strip does, and the app
          rail to the left stays frost. The DOOR rail lands in here too: while a
          door owns this column it is what the column shows, so it wears the same
          card rather than reverting the column to bare canvas for one state.
          `overflow-hidden` clips the tree's rows to the corners (every menu,
          modal and tooltip in this file is a portal or a later sibling, so
          nothing that must escape is inside). `min-h-0 flex-1` keeps the tree
          the scrolling child it was. The gap toward the workspace card is this
          card's own margin and reads --shell-card-gap, the same token the pane
          card uses on its other side, so the shell's two gaps measure the
          same. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--shell-card-radius)] bg-[color:var(--bg-surface)] mr-[var(--shell-card-gap)] mb-[var(--shell-card-gap)]">
        {/* Drill-in REPLACES the rail (item 1993,
         * `design-system/patterns/context-rail.html`): while a surface is open its
         * rail renders here, in this column, at this width — never as a second
         * navigation column beside it. `hidden` rather than unmounted, because the
         * door row that opened the surface has to still be here for Back to hand
         * focus back to it, and the tree's folds/reveals belong to the operator,
         * not to whether they visited a door in between.
         *
         * Every door declares a rail in every load state (T19), so this column is
         * active for the whole of a door's visit rather than only once the door has
         * content in it. A surface that brought no rail leaves this inactive: it
         * nests no second navigation column, so it has nothing to replace, and
         * emptying the column for it would trade a problem it does not have for a
         * blank rail. */}
        {contextRail}
        {/* The Extensions drawer (app shell, 2026-09-05): the ruled
          product rows — Design, Plugins, Skills — followed by
          installed module doors. The app rail's Extensions glyph shows it in
          place of the tree, and it STAYS while the card region swaps: a door
          that is one of its rows renders its own rail beside its canvas rather
          than taking this column (`railPlacement: 'inline'`). A door whose rail
          is a list of its own still swaps in.
          Unmounted rather than hidden — unlike the tree it keeps no fold or
          scroll state worth preserving across a section switch. */}
        {extensionsSection && !contextRailActive ? <ExtensionsRail collapsed={sidebarCollapsed} /> : null}
        {/* `mb-2` where a hairline used to be (owner, 2026-09-07): the rule under
          New chat boxed the one control into a strip of its own, and the tree
          below it is separated by the space, not by a line — the same call
          as the account cluster at the rail's foot. */}
        <div className={`mx-2 mb-2 mt-1 flex flex-col gap-1.5 ${homeHidden ? 'hidden' : ''}`}>
          {/* Home's one control above the tree: New chat, the one way in (owner,
            2026-09-04). The doors that used to share this band — Backlog,
            Reviews — live under the app rail's Extensions glyph now, so the
            tree starts one row down. The row keeps the
            tab-extract drop target. */}
          <div className="flex items-stretch gap-px">
            <Tooltip content="New chat" placement="right" wrapperClassName="flex min-w-0 flex-1">
              {/* The same nav row `SidebarNavButton` draws, and `selected` is the
                drop highlight — a transient target, so `aria-current` is
                explicitly withheld: this row is not somewhere you are. */}
              <RowButton
                density="nav"
                selected={tabDropTarget?.kind === 'new'}
                aria-current={undefined}
                onClick={onNewChat}
                onDragOver={handleTabDragOverNew}
                onDragLeave={handleTabDragLeaveNew}
                onDrop={handleTabDropOnNew}
                className="min-w-0 flex-1 text-heading font-medium"
              >
                <NewChatIcon className="icon-sm pointer-events-none shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {tabDropTarget?.kind === 'new' ? 'Drop to extract' : 'New chat'}
                </span>
              </RowButton>
            </Tooltip>
            {/* The way in to scheduled agents (owner, 2026-09-30): a clock beside
                New chat, which opens the same panel switched to Scheduled agent.
                A scheduled agent is a New chat that starts itself, so it has no
                door of its own. */}
            {onNewScheduledAgent && scheduledAgentsEnabled ? (
              <Tooltip content="New scheduled agent" placement="right">
                <IconButton
                  size="md"
                  tone="quiet"
                  aria-label="New scheduled agent"
                  onClick={onNewScheduledAgent}
                  className="shrink-0"
                >
                  <ScheduleGlyph className="icon-sm" />
                </IconButton>
              </Tooltip>
            ) : null}
          </div>
        </div>

        {/* Tree: Starred first, then folder groups directly — no "Projects"
          umbrella header; the folder headers are the top level.
          Projects and human workspaces only: a module's own background
          workspace is not a row here (item 1767, mockup §1) — its door lists
          its work across every project and jumps into the terminals from
          there.

          Alignment grid, re-measured in situ 2026-08-05. This comment
          used to claim 36px for all four families; it was computing with icon
          sizes that had since moved, and three of the four had drifted apart:

            workspace-row content  mx-1.5 + 4px rail + pl-[26px]      = 36px
            fold row chevron       mx-1.5 + pl-[30px]                 = 36px
            section-header labels  pl-4 + 16px icon slot + gap-1.5    = 38px
            top-nav labels         mx-2 + px-2 + 16px icon + gap-2    = 40px

          36px is the grid of record — it is what the row families carry, and
          what the door rails were ruled onto (design-system/patterns/
          context-rail.html, "The alignment grid"), so a drill-in swaps the
          column without moving its text edge. The 38/40px families are recorded
          drift, not a second grid to build to; closing them is its own change.
          Keep these in step when touching any one, and re-measure rather than
          trusting the arithmetic above — that is exactly how it went stale.

          A since-reversed ruling briefly opened each workspace row with a 16px
          identity slot, pushing row TITLES to 36 + 16 + gap-2 = 60px. The owner
          reversed that on 2026-09-02: the row has no icon, so its title is back
          on the 36px grid and aligns with the fold-row chevron again. The
          identity slot survives one level up, on the folder header, where it
          sits in the section-header family's 38px column. */}
        <nav
          ref={treeRef}
          className={`flex-1 overflow-y-auto pb-2 ${homeHidden ? 'hidden' : ''}`}
          role="tree"
          data-control-tab-scope
          // Read by Primary+1…9, which count these rows as drawn
          // (`manager/numberedChats.ts`).
          data-workspace-tree
          onScroll={(event) => {
            treeScrollTopRef.current = event.currentTarget.scrollTop
          }}
        >
          {starredWorkspaces.length > 0 ? (
            <section role="group" className="relative pt-1" aria-label="Starred workspaces">
              {/* The kit's nav row. `group/folder` is the hover scope the icon
                slot below reads, and the insets are the tree's own grid. */}
              <RowButton
                density="nav"
                onClick={() => setStarredCollapsed((prev) => !prev)}
                aria-expanded={!starredCollapsed}
                aria-controls="ws-starred-body"
                className="group/folder relative select-none pl-4 pr-2"
              >
                {/* One icon slot: the star at rest, the collapse
                  chevron swapped in on hover — no dedicated chevron column, so
                  child rows don't have to indent past it. */}
                <span className="relative flex size-icon-sm shrink-0 items-center justify-center">
                  <StarGlyph
                    filled
                    className="icon-sm shrink-0 text-[color:var(--tone-warn)] transition-opacity group-hover/folder:opacity-0"
                  />
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                    className={`icon-xs absolute inset-0 m-auto text-[color:var(--text-muted)] opacity-0 transition-[opacity,transform] group-hover/folder:opacity-100 ${
                      starredCollapsed ? '-rotate-90' : ''
                    }`}
                  >
                    <path
                      d="M5 6L8 9L11 6"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className="min-w-0 flex-1 truncate text-heading font-semibold text-[color:var(--text-strong)]">
                  Starred
                </span>
              </RowButton>
              <div id="ws-starred-body" hidden={starredCollapsed}>
                {!starredCollapsed
                  ? starredWorkspaces.map((workspace) => renderWorkspaceRow(workspace, keyOf(workspace), STARRED_ROW))
                  : null}
              </div>
            </section>
          ) : null}
          {/* No "Remote" band (owner, 2026-09-11). The sessions on paired
            machines used to be listed here, above the projects, under a
            heading named after the transport — which filed a chat by the
            computer it happened to run on rather than by the project it is in,
            and titled each row with its agent's name because a band row was a
            SESSION. They are rows of their projects now, below, wearing one
            green machine glyph each. */}
          {chatListView === 'all' ? renderChatStream() : activeGroups.map((group) => renderFolderSection(group))}
          {renderScheduledSection()}
        </nav>
      </div>
      {/* The account + Settings cluster that used to pin to this column's foot
          lives at the foot of the app rail now (AppRail's accountSlot): it belongs to the window, not to whichever
          section this column happens to be showing. */}

      {/* Context menu (workspace row) */}
      {contextMenu ? (
        <WorkspaceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          workspace={workspaceById.get(contextMenu.workspaceId) ?? null}
          moduleOverrides={moduleOverrides}
          isDetachedWindow={isDetachedWindow}
          now={now}
          working={
            rowIsWorking(contextMenu.workspaceId) ||
            remoteConversationByWorkspace.get(contextMenu.workspaceId)?.activity === 'working'
          }
          remoteSettle={(() => {
            const workspace = workspaceById.get(contextMenu.workspaceId)
            return workspace ? remoteKeepsRest(workspace) : false
          })()}
          canMarkUnread={(() => {
            const workspace = workspaceById.get(contextMenu.workspaceId)
            return workspace ? canMarkWorkspaceUnread(workspace) : false
          })()}
          onClose={() => setContextMenu(null)}
          onSelect={(action) => {
            const workspace = workspaceById.get(contextMenu.workspaceId)
            if (!workspace) {
              setContextMenu(null)
              return
            }
            if (action.startsWith('type-action:')) {
              const actionId = action.slice('type-action:'.length)
              const typeAction = workspaceTypeRowActions(workspace, moduleOverrides).find(
                (candidate) => candidate.id === actionId,
              )
              setContextMenu(null)
              if (!typeAction) return
              if (typeAction.confirm) {
                setPendingTypeAction({ workspaceId: workspace.id, action: typeAction })
                return
              }
              void runWorkspaceTypeRowAction(workspace.id, typeAction)
              return
            }
            if (action === 'open') {
              onSelectWorkspace(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'mark-unread') {
              setContextMenu(null)
              if (workspace.id === frontWorkspaceId) unreadOnLeaveRef.current.add(workspace.id)
              else markWorkspaceUnread(workspace.id)
              return
            }
            if (action === 'rename') {
              startRename(workspace)
              setContextMenu(null)
              return
            }
            if (action === 'copy-link') {
              const link = chatLinkFor(workspace.id)
              if (link) void copyToClipboardWithToast(link)
              setContextMenu(null)
              return
            }
            // The item says "New chat in project", and the project is the
            // header this row files under — for a worktree row, the checkout
            // it was cut from, not the worktree itself. One rule decides both
            // whether the item is offered and where it goes.
            const newChatTarget = newChatProjectTarget(workspace)
            if (action === 'new-chat' && newChatTarget) {
              onNewChatInFolder(newChatTarget)
              setContextMenu(null)
              return
            }
            if (action === 'reveal' && workspace.folderPath) {
              onRevealFolder(workspace.folderPath)
              setContextMenu(null)
              return
            }
            if (action === 'move-to-new-window') {
              onMoveWorkspaceToNewWindow(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'move-to-main-window') {
              onMoveWorkspaceToMainWindow(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'close') {
              handleClose(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'toggle-star') {
              setWorkspaceHighlight(workspace.id, {
                starred: !isStarred(workspace.highlight),
              })
              return
            }
            if (action === 'toggle-auto-settle') {
              setWorkspaceAutoSettle(workspace.id, workspace.autoSettleEnabled !== true)
              return
            }
            if (action === 'toggle-settle') {
              if (workspace.remoteOrigin) settleOpenedRemote(workspace)
              else if (isSettledWorkspace(workspace)) setWorkspaceSettled(workspace.id, false)
              else settleWorkspaceById(workspace.id)
              setContextMenu(null)
              return
            }
            if (action === 'wake') {
              setWorkspaceSnoozed(workspace.id, null)
              setContextMenu(null)
              return
            }
            if (action.startsWith('snooze:')) {
              const presetId = action.slice('snooze:'.length)
              // Re-resolved against the clock at CLICK time, not at open time:
              // a menu left open across the hour would otherwise snooze to a
              // wake time already in the past, and the row would sleep for no
              // time at all.
              const preset = resolveSnoozePresets(Date.now()).find((candidate) => candidate.id === presetId)
              if (preset) snoozeWorkspaceById(workspace.id, preset.wakeAt)
              setContextMenu(null)
              return
            }
            if (action === 'clear-color') {
              if (isStarred(workspace.highlight)) {
                setWorkspaceHighlight(workspace.id, { color: null })
              } else {
                clearWorkspaceHighlight(workspace.id)
              }
              return
            }
          }}
          onPickColor={(color) => {
            setWorkspaceHighlight(contextMenu.workspaceId, { color })
          }}
        />
      ) : null}

      {/* Context menu (a chat on a paired machine, not open here) */}
      {remoteMenu
        ? (() => {
            const conversation = unattachedRemote.find((candidate) => candidate.key === remoteMenu.key)
            if (!conversation) return null
            return (
              <RemoteConversationContextMenu
                x={remoteMenu.x}
                y={remoteMenu.y}
                title={conversation.title}
                machineName={conversation.machineName}
                canSettle={conversation.agents[0]?.lifecycle === true}
                working={conversation.activity === 'working'}
                onClose={() => setRemoteMenu(null)}
                onSelect={(action) => {
                  setRemoteMenu(null)
                  if (action === 'open') onOpenRemoteSession?.(openSpecOfConversation(conversation))
                  else if (action === 'settle') settleRemoteConversation(conversation)
                }}
              />
            )
          })()
        : null}

      {/* Folder context menu */}
      {folderMenu ? (
        <FolderContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          group={groups.find((g) => g.key === folderMenu.folderKey) ?? null}
          projectColorKey={projectKeyOf(folderMenu.folderKey)}
          projectColorSettled={projectKeySettled(folderMenu.folderKey)}
          projectColor={projectColors[projectKeyOf(folderMenu.folderKey) ?? ''] ?? null}
          automaticProjectColor={projectHue(projectKeyOf(folderMenu.folderKey) ?? '')}
          onPickProjectColor={(color) => {
            const key = projectKeyOf(folderMenu.folderKey)
            if (key) setProjectColor(key, color)
            setFolderMenu(null)
          }}
          onClose={() => setFolderMenu(null)}
          onSelect={(action) => {
            const group = groups.find((g) => g.key === folderMenu.folderKey)
            setFolderMenu(null)
            if (!group) return
            if (action === 'new-chat' && group.fullPath && !group.missing) {
              onNewChatInFolder(group.fullPath)
            }
            if (action === 'reveal' && group.fullPath) onRevealFolder(group.fullPath)
            if (action === 'forget' && group.fullPath) setConfirmForget(group.fullPath)
          }}
        />
      ) : null}

      {/* Close-confirm popover (modal-style for safety) */}
      <Modal
        open={confirmClose !== null}
        onClose={() => setConfirmClose(null)}
        labelledBy="ws-close-title"
        size="confirm"
      >
        {confirmClose
          ? (() => {
              const workspace = workspaceById.get(confirmClose)
              const activity = activityByWorkspaceId[confirmClose] ?? 'idle'
              return (
                <>
                  <ModalHeader
                    titleId="ws-close-title"
                    title={`Close “${workspace?.name ?? 'workspace'}”?`}
                    subtitle={
                      activity === 'needs-input'
                        ? 'An agent is waiting for input. Closing will lose that prompt.'
                        : 'Running agents will be stopped. Workspace files on disk are kept.'
                    }
                    onClose={() => setConfirmClose(null)}
                  />
                  <ModalFooter>
                    <ModalButton onClick={() => setConfirmClose(null)}>Cancel</ModalButton>
                    <ModalButton
                      variant="danger"
                      onClick={() => {
                        const id = confirmClose
                        setConfirmClose(null)
                        if (id) onCloseWorkspace(id)
                      }}
                    >
                      Close workspace
                    </ModalButton>
                  </ModalFooter>
                </>
              )
            })()
          : null}
      </Modal>

      {/* Type-contributed row-action confirm */}
      <Modal
        open={pendingTypeAction !== null}
        onClose={() => setPendingTypeAction(null)}
        labelledBy="ws-type-action-title"
        size="confirm"
      >
        {pendingTypeAction
          ? (() => {
              const workspace = workspaceById.get(pendingTypeAction.workspaceId)
              const copy = pendingTypeAction.action.confirm?.({ name: workspace?.name ?? 'workspace' })
              if (!copy) return null
              return (
                <>
                  <ModalHeader
                    titleId="ws-type-action-title"
                    title={copy.title}
                    subtitle={copy.body}
                    onClose={() => setPendingTypeAction(null)}
                  />
                  <ModalFooter>
                    <ModalButton onClick={() => setPendingTypeAction(null)} disabled={typeActionBusy}>
                      {copy.cancelLabel ?? 'Cancel'}
                    </ModalButton>
                    <ModalButton
                      variant="danger"
                      disabled={typeActionBusy}
                      onClick={() => {
                        const pending = pendingTypeAction
                        setPendingTypeAction(null)
                        if (pending) void runWorkspaceTypeRowAction(pending.workspaceId, pending.action)
                      }}
                    >
                      {copy.confirmLabel}
                    </ModalButton>
                  </ModalFooter>
                </>
              )
            })()
          : null}
      </Modal>

      {/* Forget folder confirm */}
      <Modal
        open={confirmForget !== null}
        onClose={() => setConfirmForget(null)}
        labelledBy="ws-forget-title"
        size="confirm"
      >
        {confirmForget
          ? (() => {
              const group = groups.find((g) => g.fullPath === confirmForget)
              // Forgetting a folder closes its LOCAL rows; a paired machine's
              // clone filed under it keeps its own machine header afterwards,
              // so it is not counted as something this closes.
              const count = group?.workspaces.filter((workspace) => !workspace.remoteOrigin).length ?? 0
              return (
                <>
                  <ModalHeader
                    titleId="ws-forget-title"
                    title={`Forget folder “${folderDisplayName(confirmForget)}”?`}
                    subtitle={`Closes ${count} workspace${count === 1 ? '' : 's'} under this folder and removes the folder from recents. Files on disk are kept.`}
                    onClose={() => setConfirmForget(null)}
                  />
                  <ModalFooter>
                    <ModalButton onClick={() => setConfirmForget(null)}>Cancel</ModalButton>
                    <ModalButton
                      variant="danger"
                      onClick={() => {
                        const path = confirmForget
                        setConfirmForget(null)
                        if (path) onForgetFolder(path)
                      }}
                    >
                      Forget folder
                    </ModalButton>
                  </ModalFooter>
                </>
              )
            })()
          : null}
      </Modal>
    </aside>
  )
}

type WorkspaceRowOptions = {
  keyPrefix?: string
  /** The band's rows lead with the machine glyph; its tooltip is where the machine is named. */
  remoteMachine?: string
  /** A row in its folder's Snoozed shelf: the same compact row, wearing the countdown to its wake. */
  snoozed?: boolean
  /**
   * The row is in the flat stream (all-chats-view), where there is no
   * folder header above it: it grows a line for the project it belongs to,
   * and that line takes the row's clock and its hover actions. Null in the
   * tree, where the header says the project once for all its chats.
   */
  flatProject?: FlatProjectLine
}

const NO_SESSIONS: TerminalSessionSnapshot[] = []
const NO_CONVERSATIONS: readonly ConversationSessionSummary[] = []

/** When an agent in the chat last finished a turn, as far as this window knows; null when none has. */
function latestFinishOf(
  workspace: Pick<Workspace, 'lastTurnEndedAt'>,
  sessions: readonly ConversationSessionSummary[],
): number | null {
  let latest = typeof workspace.lastTurnEndedAt === 'number' ? workspace.lastTurnEndedAt : null
  for (const session of sessions)
    if (typeof session.lastTurnEndedAt === 'number' && session.lastTurnEndedAt > (latest ?? -1))
      latest = session.lastTurnEndedAt
  return latest
}
const EMPTY_PULL_REQUESTS: readonly BranchPullRequest[] = []

// A row's options, as constants: a fresh `{ snoozed: true }` on every sidebar
// render was a new prop for a memoized row, which re-rendered it every time.
const SNOOZED_ROW: WorkspaceRowOptions = { snoozed: true }
const STARRED_ROW: WorkspaceRowOptions = { keyPrefix: 'starred-' }

function rowOptionsEqual(left: WorkspaceRowOptions, right: WorkspaceRowOptions): boolean {
  const a = left.flatProject
  const b = right.flatProject
  return (
    left.keyPrefix === right.keyPrefix &&
    left.remoteMachine === right.remoteMachine &&
    left.snoozed === right.snoozed &&
    (a === b ||
      (a !== undefined &&
        b !== undefined &&
        a.name === b.name &&
        a.folderPath === b.folderPath &&
        a.color === b.color &&
        a.unfiled === b.unfiled))
  )
}

type RowGitSummaries = ReturnType<typeof useSidebarGitSummaries>

// How long a row that was just settled holds its seat open: the flourish's
// ring and tick (`.settle-mark-flourish`, one pulse) plus a beat to read the
// state they land on.
const SETTLE_FLOURISH_MS = 1200
const NO_GIT_SUMMARIES: RowGitSummaries = {}

/** What a row does, held in one object whose identity never changes. */
type WorkspaceRowHandlers = {
  setContextMenu: (menu: { workspaceId: WorkspaceId; x: number; y: number } | null) => void
  handleClose: (workspaceId: WorkspaceId) => void
  setWorkspaceSnoozed: (workspaceId: WorkspaceId, until: number | null) => void
  settleWorkspaceById: (workspaceId: WorkspaceId) => void
  settleOpenedRemote: (workspace: Workspace) => void
  setWorkspaceSettled: (workspaceId: WorkspaceId, settled: boolean) => void
  openPaneTab: ReturnType<typeof useWorkspaceStore.getState>['openPaneTab']
  setRovingKey: (key: string) => void
  handleTreeRowKeyDown: (
    event: React.KeyboardEvent<HTMLDivElement>,
    workspaceId: WorkspaceId | null,
    open?: () => void,
  ) => void
  handleRowDragStart: (event: React.DragEvent, workspace: Workspace, fKey: string) => void
  handleRowDragOver: (event: React.DragEvent, workspace: Workspace, fKey: string) => void
  handleRowDrop: (event: React.DragEvent, workspace: Workspace, fKey: string) => void
  handleDragEnd: (event: React.DragEvent) => void
  handleTabDragOverRow: (event: React.DragEvent, workspace: Workspace) => void
  handleTabDragLeaveRow: (workspaceId: WorkspaceId) => void
  handleTabDropOnRow: (event: React.DragEvent, workspace: Workspace) => void
  onSelectWorkspace: (workspaceId: WorkspaceId) => void
  startRename: (workspace: Workspace) => void
  commitRename: () => void
  setRenameValue: (value: string) => void
  setRenamingId: (workspaceId: WorkspaceId | null) => void
  renameInputRef: React.RefObject<HTMLInputElement | null>
}

type WorkspaceRowProps = {
  workspace: Workspace
  fKey: string
  options?: WorkspaceRowOptions
  active: boolean
  activity: Activity
  recency: TerminalRecency | undefined
  wokeAt: number | null
  unseenDoneMark: boolean
  resident: boolean
  dropMark: 'before' | 'after' | null
  isTabDropTarget: boolean
  rowConversation: RemoteConversation | null
  /** A chat born on a paired machine that keeps its rest, so the seat's tick asks it to settle (`remoteKeepsRest`). */
  remoteSettle: boolean
  liveSessions: TerminalSessionSnapshot[]
  peekSessions: TerminalSessionSnapshot[]
  conversationSessions: readonly ConversationSessionSummary[]
  /** Only this row's checkouts, so a sweep that moved another row's numbers leaves this one alone. */
  gitSummaries: RowGitSummaries
  rowConversationPullRequests: ConversationPullRequests[string] | undefined
  /** Agent → the pull requests its conversation opened: what each chat line wears. */
  chatLinePullRequestsByAgent: ConversationPullRequests | undefined
  rowLocalServers: WorkspaceLocalServers[string] | undefined
  moduleOverrides: ReturnType<typeof useWorkspaceStore.getState>['appSettings']['modules']
  isRovingTarget: boolean
  anyRenaming: boolean
  renaming: boolean
  renameValue: string
  handlers: WorkspaceRowHandlers
}

/**
 * One chat's row. Memoized: it re-renders when something about THIS row
 * changes, not whenever the sidebar does. Its clock is its own
 * (`useRelativeNow`), so the idle and wake labels advance without the list
 * above them re-rendering.
 */
const WorkspaceRow = React.memo(function WorkspaceRow({
  workspace,
  fKey,
  options,
  active,
  activity,
  recency,
  wokeAt,
  unseenDoneMark,
  resident,
  dropMark,
  isTabDropTarget,
  rowConversation,
  remoteSettle,
  liveSessions,
  peekSessions,
  conversationSessions,
  gitSummaries,
  rowConversationPullRequests,
  chatLinePullRequestsByAgent,
  rowLocalServers,
  moduleOverrides,
  isRovingTarget,
  anyRenaming,
  renaming,
  renameValue,
  handlers,
}: WorkspaceRowProps) {
  const {
    setContextMenu,
    handleClose,
    setWorkspaceSnoozed,
    settleWorkspaceById,
    settleOpenedRemote,
    setWorkspaceSettled,
    openPaneTab,
    setRovingKey,
    handleTreeRowKeyDown,
    handleRowDragStart,
    handleRowDragOver,
    handleRowDrop,
    handleDragEnd,
    handleTabDragOverRow,
    handleTabDragLeaveRow,
    handleTabDropOnRow,
    onSelectWorkspace,
    startRename,
    commitRename,
    setRenameValue,
    setRenamingId,
    renameInputRef,
  } = handlers
  // Every time this row draws, read off the clock: a tick that leaves all of
  // them as they were leaves the row alone, which on a list of rows idle for
  // hours is nearly every tick. A label added below that reads `now` belongs
  // here too, or it waits for some other change to advance.
  const now = useRelativeNowFor((at) => {
    const stamps = [
      recency?.lastInputAt,
      recency?.idleSince,
      wokeAt,
      ...rowLines.lines.map((line) => line.idleSince),
      ...peekSessions.map(activityAt),
      ...conversationSessions.map(conversationFinishedAt),
    ]
    const wake = asleepUntil === null ? '' : `${snoozeWakeLabel(asleepUntil, at)}|${relativeFromNow(asleepUntil, at)}`
    return `${stamps.map((stamp) => formatRelativeMs(stamp, at)).join('|')}|${wake}`
  })
  // An agent's editor reveal waiting for this workspace to be shown.
  const revealPending = usePendingEditorReveal(workspace.id)
  const flatProject = options?.flatProject ?? null
  // The machine a chat born over there runs on, read off its own provenance
  // rather than passed down: the row no longer comes from a band that knew,
  // and the stamp rides the workspace whether or not a pane is open.
  const rowMachineName = options?.remoteMachine ?? workspace.remoteOrigin?.machineName ?? null
  // The machine the row runs on, for its mark (owner ruling 2026-10-04): the
  // paired machine above, else the SSH machine or WSL distribution the
  // workspace was created on. Null on this computer, which wears no mark.
  const workspaceMachineRef = useWorkspaceMachineRef(workspace)
  const rowMachine: RowMachine | null = rowMachineName
    ? { ref: { kind: 'paired', name: rowMachineName }, name: rowMachineName }
    : workspace.environment?.kind === 'ssh'
      ? { ref: workspaceMachineRef, name: workspace.environment.label }
      : workspace.hostId && isWslHostId(workspace.hostId)
        ? { ref: workspaceMachineRef, name: `WSL: ${distroOfHostId(workspace.hostId) ?? workspace.hostId}` }
        : null
  const tone = activityTone(activity)
  // A row whose module ships a run-glyph provider carries that lifecycle
  // glyph in the status slot instead of the dot + recency idiom: the run
  // state (spinner / needs input / paused / failed / done) is the signal such
  // a workspace wants. Recency still drives ordering and survives in the
  // glyph's tooltip.
  const runGlyph = deriveWorkspaceRunGlyph(workspace)
  const runGlyphRecencyAgo =
    runGlyph && typeof recency?.lastInputAt === 'number' ? formatRelativeMsAgo(recency.lastInputAt, now) : null
  const runGlyphLabel = runGlyph
    ? `${runGlyph.label}${runGlyphRecencyAgo ? ` · last typed ${runGlyphRecencyAgo}` : ''}`
    : null
  const idleRecencyText = typeof recency?.idleSince === 'number' ? formatRelativeMs(recency.idleSince, now) : ''
  // The countdown a sleeping row wears in the shelf, and the mark a woken one
  // wears in the active list until it is opened. Mutually exclusive by
  // construction: `workspaceWokeAt` is null while the row is still asleep.
  const asleepUntil = options?.snoozed ? (workspace.snoozedUntil ?? null) : null
  // A resting row only draws while it is the row you are in (`isShelved`), so
  // this is the settled chat you just settled or just opened. Settling it used
  // to look like nothing at all: the row stays put, and its seat went on
  // offering the same grey tick. The seat now says it rested — a green tick in
  // a ring, which un-settles on the next click — and the moment it happens
  // plays once (`.settle-mark-flourish`), with the seat pinned open for the
  // length of it so the cursor leaving, or the row shrinking as its terminals
  // die, cannot hide the one frame that answers the click. Derived in render
  // rather than an effect so the first paint after the click already has it.
  const settled = isSettledWorkspace(workspace)
  const [settleFlourish, setSettleFlourish] = useState(false)
  const [seenSettled, setSeenSettled] = useState(settled)
  if (seenSettled !== settled) {
    setSeenSettled(settled)
    setSettleFlourish(settled)
  }
  useEffect(() => {
    if (!settleFlourish) return
    const timer = window.setTimeout(() => setSettleFlourish(false), SETTLE_FLOURISH_MS)
    return () => window.clearTimeout(timer)
  }, [settleFlourish])
  const showRecencyText =
    !runGlyph &&
    activity === 'idle' &&
    !!recency &&
    !recency.hasRunning &&
    !!idleRecencyText &&
    // The wake countdown and the Woke mark each take this seat when they
    // apply: two numbers in one 44px slot is a row saying nothing twice.
    !options?.snoozed &&
    wokeAt === null
  // The row that wants you: it wears the gold treatment instead of a dot.
  const needsAttention = activity === 'needs-input'
  // The row that finished while you were away: the same treatment in green,
  // held until you open it. Gold outranks it when both apply.
  // A sleeping row never wears the green "finished while you were away" wash,
  // and never pulses. The mark is a request for attention, and this row's
  // person has just declined to give it; a chat whose terminals are suspended
  // is not finishing anything anyway. The wash is waiting for them when the
  // row wakes, which is when it is news again.
  const unseenDone = !needsAttention && !options?.snoozed && unseenDoneMark
  // A chat whose worktree the cleanup gave back (`worktree.reclaimedAt`) has
  // no folder on disk, and that is expected, not broken: opening it checks the
  // worktree out again (chatWorktreeRestore.ts). So it never wears the
  // strike-through and the warning triangle of a folder that went missing;
  // its branch chip, which the parked line already draws, says the rest in
  // its tooltip. No new mark: the branch is the durable fact, and the row
  // reads like any other parked worktree chat. A restore that fails drops the
  // mark, and the row then reads as missing, which it is.
  const worktreeReclaimed = workspace.worktree?.reclaimedAt !== undefined
  const folderMissing = workspace.folderMissing === true && !worktreeReclaimed
  const starred = isStarred(workspace.highlight)
  // "Hot": at least one resident (live-PTY) agent — instant to switch into.
  // Said in words for a screen reader, and since 2026-09-09 it is also what
  // lights the row: an agent alive in a chat is what makes it a place you can
  // work, whatever its clock says (owner).
  // How loudly this row is drawn — weight for the rows with an agent in them,
  // the row you are in, and the rows asking for you; muted ink for the rest.
  // No clock: the row's idle label reports time, and weight reports use.
  const emphasis = workspaceRowEmphasis({
    resident,
    selected: active,
    working: activity === 'working',
    wantsYou: needsAttention || unseenDone,
  })
  const highlighted = hasHighlightOverride(workspace.highlight)
  const rowKey = `${options?.keyPrefix ?? ''}${workspace.id}`
  // The row's lines (sidebar-lists-every-terminal): one per open terminal —
  // the local live sessions AND the mesh panes the layout mounts from
  // other machines.
  // Owner ruling 2026-09-04 (the-diff-an-agent-made, decision 9): a row with
  // no open terminal is the one-liner it always was — title only, with idle
  // recency keeping its old seat in the line-1 status cluster. Its branch and
  // ±lines are not facts about a chat that is not running; they are the
  // checkout's current state, which a parked chat has no claim on. So the
  // lines, and everything on them, are gated on liveness: no terminal, no
  // line. (The poll above already asks about live rows only; the gate here
  // keeps the render honest even mid-transition.)
  // A remote-born row is titled with the CHAT, never with an agent standing
  // in it (owner, 2026-09-13). `remoteConversationTitle` also rescues the
  // rows already stored under the old `${agentName} · ${chatName}` rule, so
  // the fix reaches chats that exist rather than only the next one opened.
  const rowTitle = remoteConversationTitle(workspace)
  // The conversation this row is, over on its machine — present only for a
  // remote-born row whose machine has answered a browse.
  // A remote chat with agents standing in it is live whatever this window is
  // holding: `rowHasOpenTerminals` asks about panes HERE, and a person who
  // closed the pane did not stop the chat. The browse saying the agents are
  // there is the better answer, and without this the row went silent the
  // moment its pane closed even though the machine was still working.
  const rowIsLive =
    liveSessions.length > 0 ||
    conversationSessions.length > 0 ||
    meshPanesOf(workspace).length > 0 ||
    rowConversation !== null
  // A sleeping row is the one-liner by construction: it is waiting on a
  // clock, and a checkout's branch and ±lines are not facts about that.
  const rowLines =
    rowIsLive && !options?.snoozed
      ? rowConversation
        ? // A remote chat draws the agents standing in IT, not the one pane this
          // window happens to hold (owner, 2026-09-13). `meshPanesOf` can only
          // see the session this workspace attached, so a chat running three
          // agents over there drew one nameless, activity-free line here while
          // the very same chat, unopened, drew three live ones in the band
          // beside it — opening a chat made it say less. The browse already read
          // all three; these are the band's own lines, which is what makes an
          // open remote row and a local multi-agent row read alike.
          { lines: rowConversation.agents.map(lineOfRemoteRow), overflow: 0 }
        : terminalLinesOf({
            workspace,
            sessions: liveSessions,
            meshPanes: meshPanesOf(workspace),
            summaries: gitSummaries,
          })
      : { lines: [], overflow: 0 }
  // A band row names its machine on the title glyph, so its lines do not
  // say it again; a local row that holds a remote pane still marks it there.
  if (rowMachineName) for (const line of rowLines.lines) line.machineName = null
  // The one thing a parked row still gets to say (orchestrator ruling
  // 2026-09-07). The gate above is about the checkout's live state, which a
  // chat with nothing running has no claim on; a worktree workspace's branch
  // is not that. The workspace IS the worktree, cut onto a branch the app
  // minted for it, and it stays that whether or not a terminal is up — the
  // same durable fact its header no longer says now that the row files under
  // the project it came from. So: the branch chip, alone, and no ± diff,
  // which would be live state again.
  const parkedWorktreeBranch = rowIsLive ? null : workspace.worktree?.branch?.trim() || null
  // What this chat holds once nothing is running in it. A row WITH lines
  // draws its marks on those lines, where they belong to the agent that
  // opened them; this is only ever the fallback for a row with none
  // (`pullRequestsForRow`), and it spans every agent the chat ever had —
  // "in the sidebar, we should just see all the pull requests that are
  // related to a particular conversation" (owner, 2026-09-10).
  //
  // Merged ones included, deliberately. The mark is this chat's record and it
  // keeps holding a merged pull request; the DIFF is the separate live
  // reading, and it empties itself once the branch lands.
  const parkedPullRequests = pullRequestsForRow({
    hasLiveLines: rowLines.lines.length > 0,
    conversation: rowConversationPullRequests,
  })
  // Settle waits while an agent in the chat works (`settleWorkspaceById`), here
  // or, for a chat born on a paired machine, over there.
  const settleBlocked =
    workspaceIsWorking(activity, conversationSessions, liveSessions) || rowConversation?.activity === 'working'
  const tabbedConversations = useMemo(
    () => conversationsWithTabs(conversationSessions, workspace.layoutModel),
    [conversationSessions, workspace.layoutModel],
  )
  const visibleConversations = rowIsLive && !options?.snoozed ? tabbedConversations : NO_CONVERSATIONS
  // A chat's pull requests sit on its chat's line, just after the agent's
  // mark, as a terminal line's do: the ones THAT chat's agent opened, which
  // the record files under its conversation. What the row holds besides
  // (an agent that is gone, a terminal agent's) keeps a line of its own.
  const chatLinePullRequestsOf = (agentId: string): readonly BranchPullRequest[] =>
    chatLinePullRequestsByAgent?.[agentId] ?? EMPTY_PULL_REQUESTS
  const onChatLines = new Set(
    visibleConversations.flatMap((session) => chatLinePullRequestsOf(session.agentId).map((pr) => pr.url)),
  )
  const rowOnlyPullRequests =
    onChatLines.size > 0 ? parkedPullRequests.filter((pr) => !onChatLines.has(pr.url)) : parkedPullRequests
  // The second line exists for either fact now. A parked chat with a pull
  // request but no worktree branch used to have no line at all, which is
  // exactly the row the owner could not read anything off. A closed one is
  // not drawn (`PullRequestMark`), so it does not hold a line open either.
  const parkedLine = parkedWorktreeBranch !== null || rowOnlyPullRequests.some((pr) => pr.state !== 'closed')
  const metaHasSubstance = rowLines.lines.length > 0 || visibleConversations.length > 0 || parkedLine

  // The row's status seat: run glyph / working mark + elapsed / tone dot /
  // idle recency, with the hover-revealed row actions layered over it.
  //
  // Owner ruling 2026-09-04: this used to live on line 1, where its
  // permanently reserved 44px plus its gap cost every title a fifth of the
  // sidebar's content column. It now rides line 2's trailing edge whenever
  // there IS a line 2, so the title claims the full width the way list-row
  // says it should; a row with no meta to show keeps the seat exactly where
  // it was, and stays exactly the height it was.
  const rowActionsOverlay = (
    <>
      {/* Hover-and-focus-revealed row actions: keyboard focus surfaces them
          (group-focus-within) so they are reachable and never a focus trap
          on an invisible control. The seat's min-w is the width they reserve
          (list-row's `data-actions` rule), so revealing never reflows — and
          reserving it here rather than on line 1 is the whole point of the
          move. */}
      <span className="pointer-events-none absolute inset-y-0 right-0 inline-flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-data-[settle-flourish]:pointer-events-auto group-data-[settle-flourish]:opacity-100">
        <Tooltip content="More actions">
          <IconButton
            onClick={(event) => {
              event.stopPropagation()
              setContextMenu({
                workspaceId: workspace.id,
                x: (event.currentTarget as HTMLElement).getBoundingClientRect().right,
                y: (event.currentTarget as HTMLElement).getBoundingClientRect().bottom,
              })
            }}
            tone="quiet"
            aria-label="Workspace actions"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="icon-xs" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.2" />
              <circle cx="8" cy="8" r="1.2" />
              <circle cx="12.5" cy="8" r="1.2" />
            </svg>
          </IconButton>
        </Tooltip>
        {/* The one-click seat is rest, not removal (settled-chats,
            2026-09-07). It used to be the ✕, which terminates the row's
            terminals and removes the chat — the irreversible gesture in the
            cheapest place on the row, and against this epic's own thesis
            that a chat comes to rest instead of vanishing. Close keeps its
            entry in `···`, where a gesture that cannot be taken back
            belongs; Settle, the one you make fifty times a day and can undo
            with the next click, takes the seat.

            Neutral ink, deliberately: green already means "an agent
            finished while you were away — come look" on this exact surface
            (`doneRowClass` washes the whole row in --tone-good-faint), so a
            green tick would be the opposite instruction in the same hue six
            pixels away — the mistake the green ring was struck down for
            (owner ruling 2026-09-05). The tick's SHAPE says done; it does
            not need the tone to say it.

            A row born on a paired machine settles the same way when its
            machine keeps its chats' rest: the tick asks the machine, and the
            row goes once it has said yes (`settleOpenedRemote`), the rule
            the menu's Settle entry follows. One whose machine keeps no rest
            has nothing to settle into, and keeps the ✕. */}
        {workspace.remoteOrigin && !remoteSettle ? (
          <Tooltip content="Close workspace">
            <IconButton
              onClick={(event) => {
                event.stopPropagation()
                handleClose(workspace.id)
              }}
              tone="quiet"
              aria-label={`Close ${workspace.name}`}
            >
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </IconButton>
          </Tooltip>
        ) : settled ? (
          /* The settled seat: the same tick, drawn smaller inside a ring and
             in the good tone. Green here does not collide with the ruling
             above: that was about the resting AFFORDANCE on every row, and
             this is a state that one row — the one you are in — is in. The
             ring is what says it without colour; the label says it in words. */
          <Tooltip content="Un-settle">
            <IconButton
              onClick={(event) => {
                event.stopPropagation()
                setWorkspaceSettled(workspace.id, false)
              }}
              tone="quiet"
              aria-label={`Un-settle ${workspace.name}`}
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                className={`icon-xs settle-mark${settleFlourish ? ' settle-mark-flourish' : ''}`}
                aria-hidden="true"
              >
                <circle
                  className="settle-mark-ring"
                  cx="8"
                  cy="8"
                  r="6.9"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  pathLength={1}
                  transform="rotate(-90 8 8)"
                />
                <path
                  className="settle-mark-tick"
                  d="M5.1 8.25L7 10.15L10.9 6.1"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </IconButton>
          </Tooltip>
        ) : options?.snoozed ? (
          /* The one-click seat on a sleeping row is Wake. Settle is wrong
             here — the row is not asking to be called finished, it is
             waiting on a clock — and an undo arrow would be saying "put
             this back" about a state the row is going to leave on its own
             anyway. The alarm-bell shape says the clock
             is what you are cancelling. */
          <Tooltip content="Wake now">
            <IconButton
              onClick={(event) => {
                event.stopPropagation()
                setWorkspaceSnoozed(workspace.id, null)
              }}
              tone="quiet"
              aria-label={`Wake ${workspace.name}`}
            >
              <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
                <circle cx="8" cy="9" r="4.6" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M8 6.6V9l1.6 1.1"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M2.6 4.2 4.7 2.5M13.4 4.2l-2.1-1.7"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip content={settleBlocked ? 'Settle once its agents finish' : 'Settle'}>
            {/* `aria-disabled`, not `disabled`: a disabled button takes no
                hover and no focus, so the tooltip saying why it waits could
                never open. `settleWorkspaceById` refuses a working chat too. */}
            <IconButton
              onClick={(event) => {
                event.stopPropagation()
                if (settleBlocked) return
                if (workspace.remoteOrigin) settleOpenedRemote(workspace)
                else settleWorkspaceById(workspace.id)
              }}
              tone="quiet"
              aria-disabled={settleBlocked || undefined}
              aria-label={`Settle ${workspace.name}`}
            >
              {SETTLE_TICK_GLYPH}
            </IconButton>
          </Tooltip>
        )}
      </span>
    </>
  )
  const statusSeat = (
    <span className="relative ml-auto flex h-5 min-w-[44px] shrink-0 items-center justify-end pl-2">
      <span className="inline-flex items-center gap-1 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 group-data-[settle-flourish]:opacity-0">
        {runGlyph && runGlyphLabel ? (
          <RowTooltip content={runGlyphLabel}>
            <LifecycleGlyph state={runGlyph.state} live={runGlyph.live} label={runGlyphLabel} />
          </RowTooltip>
        ) : null}
        {/* Active work earns the working mark; the other
            attention states keep the tone dot. */}
        {/* An attention row renders NO dot: the row's own gold surface is the
            mark, and status-dot's spec calls a dot beside something already
            saying the same thing a reject-on-sight. Working and failed keep
            their marks — neither tints the row. */}
        {!runGlyph && tone && !needsAttention ? (
          activity === 'working' ? (
            <>
              <WorkingMark label={activityLabel(activity)} seed={workspace.id} />
              {/* How long the turn has been running. The workspace-level
                  activity above decides WHETHER work is in flight (hooks are
                  the authority on that); the terminal snapshot only supplies
                  the timestamp, and a turn without one simply shows the dots
                  alone. */}
              {typeof recency?.workingSince === 'number' ? <WorkingElapsed since={recency.workingSince} /> : null}
            </>
          ) : (
            <StatusDot tone={tone.tone} pulse={tone.pulse} label={activityLabel(activity)} />
          )
        ) : null}
        {/* A sleeping row says when it comes back — the one thing it is for.
            Same seat, same type step and the same muted ink as the idle
            clock it stands in for, because it is the same kind of reading. */}
        {asleepUntil !== null ? (
          <RowTooltip
            content={`Wakes ${relativeFromNow(asleepUntil, now)} (${new Date(asleepUntil).toLocaleString()})`}
          >
            <span className="text-meta tabular-nums text-[color:var(--text-subtle)]">
              <span aria-hidden="true">{snoozeWakeLabel(asleepUntil, now)}</span>
              <span className="sr-only">Wakes in {snoozeWakeLabel(asleepUntil, now)}</span>
            </span>
          </RowTooltip>
        ) : null}
        {/* A row that came back. The list's order is static, so nothing about
            its position says it returned; this is the whole of the signal,
            and opening the row spends it. Muted, not gold: gold on this
            surface means "the agent is waiting on you", which a woken row is
            not necessarily doing. */}
        {wokeAt !== null ? (
          <RowTooltip content={`Woke ${formatRelativeMsAgo(wokeAt, now) || 'just now'}`}>
            <span className="text-meta text-[color:var(--text-subtle)]">Woke</span>
          </RowTooltip>
        ) : null}
        {showRecencyText ? (
          <RowTooltip
            content={`Idle ${formatRelativeMsAgo(recency!.idleSince!, now)} (${new Date(recency!.idleSince!).toLocaleString()})`}
          >
            <span
              className={`text-meta tabular-nums ${
                emphasis === 'quiet' ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
              }`}
            >
              <span aria-hidden="true">{idleRecencyText}</span>
              <span className="sr-only">Idle {formatRelativeMsAgo(recency!.idleSince!, now)}</span>
            </span>
          </RowTooltip>
        ) : null}
      </span>
      {rowActionsOverlay}
    </span>
  )

  // The row's conversation peek (2026-09-07). The row says what the chat is
  // CALLED; the card says what was actually asked — the message that started
  // it, everything sent since, and the model and session behind it. Null when
  // there is no session id worth asking about: nothing to read, and a card
  // that only restated the row's own title is the noise this replaced.
  //
  // Note the map: every session main knows about, running or not, and then
  // the row's own agent records. Whether the PROCESS is alive is not the
  // question — whether there is an id to ask about is.
  // One identity per agent (2026-09-09): the card opens from the agent line
  // the pointer is on, and a chat with a single agent opens from its row.
  const peekIdentities = rowConversationPeekIdentities({
    workspace,
    sessions: peekSessions,
    conversations: conversationSessions,
    status: peekStatusOf(activity, idleRecencyText),
    now,
    platform: hostPlatform(),
  })
  const hasPeek = peekIdentities.length > 0
  // The whole row is the peek's hover target (owner ruling 2026-09-07), which
  // costs the title its own tooltip. `TruncatedText` opens one the moment a
  // title is clipped, and with the card opening from the same row that would
  // be a second surface over the first — saying the same name the card's
  // header is already saying in full. So where there IS a peek the title
  // truncates plainly and the card carries the name.
  //
  // Only where there is one. A row with no agent session opens no card, and
  // dropping the tooltip there too would leave a long chat name with no way
  // to be read at all — so that row keeps `TruncatedText` exactly as it was.
  // `TruncatedText` itself is untouched; this is only how the row uses it.
  const titleClusterClass = `flex min-w-0 flex-1 items-center gap-1.5 ${folderMissing ? 'line-through decoration-[color:var(--text-subtle)]' : ''}`
  const titleClass = `min-w-0 flex-1 ${
    // Weight ONLY, and for every row anyone is using — the row you are in,
    // the ones working, the ones that want you, and anything touched inside
    // the hour. The ink lift stays selection's channel, not weight's: the
    // selected row is the one that also brightens (its row class carries
    // `--text-strong`), so a bold row never reads as the row you are in
    // (design-system/patterns/selection.html). It is also what keeps the
    // mark honest on an attention row, where a second ink would cancel the
    // warn colour the row is wearing.
    emphasis === 'active' ? 'font-semibold' : ''
  } ${
    // The background tier, and deliberately a step below list-row's Rest:
    // `text.muted` still read as foreground on this near-black rail, so a
    // chat nobody is using sits at `text.subtle` and lifts to `text.default`
    // on hover — reaching for one is never reading dim text. Selection's own
    // ink lift never reaches here: a selected row is `active`.
    emphasis === 'quiet' ? 'text-[color:var(--text-subtle)] group-hover:text-[color:var(--text-default)]' : ''
  }`
  const titleClusterContent = (
    <>
      {/* Where the row runs, when it is not here. In the flat stream the
          project line above already carries this mark after the project's
          name, so the title does not say it twice. */}
      {rowMachine && !flatProject ? <MachineRowGlyph machine={rowMachine} /> : null}
      {/* A schedule started this chat. Beside the title in both shapes of the
          list: the project line says where a chat is, not how it began. */}
      {isScheduledRunChat(workspace) ? <ScheduledRunGlyph scheduledAgentId={workspace.scheduledAgentId} /> : null}
      {starred ? <StarGlyph filled className="icon-xs shrink-0 text-[color:var(--tone-warn)]" label="Starred" /> : null}
      {(() => {
        const RowMark = resolveEnabledWorkspaceType(workspace.mode, moduleOverrides)?.RowMark
        return RowMark ? <RowMark /> : null
      })()}
      {hasPeek ? (
        <span className={`${titleClass} truncate`}>{rowTitle}</span>
      ) : (
        <TruncatedText as="span" text={rowTitle} className={titleClass} />
      )}
      {resident ? <span className="sr-only"> (agents resident)</span> : null}
      {/* The gold surface is the visible mark; this is the same meaning
          in words, since no state may be carried by colour alone. */}
      {needsAttention ? <span className="sr-only"> (needs your input)</span> : null}
      {unseenDone ? <span className="sr-only"> (finished while you were away)</span> : null}
      {revealPending ? <span className="sr-only"> (an agent opened something for you here)</span> : null}
      {options?.snoozed ? <span className="sr-only"> (snoozed)</span> : null}
      {settled ? <span className="sr-only"> (settled)</span> : null}
    </>
  )
  const titleCluster = hasPeek ? (
    <ConversationPeekPopover identities={peekIdentities} now={now} className={titleClusterClass}>
      {titleClusterContent}
    </ConversationPeekPopover>
  ) : (
    <span className={titleClusterClass}>{titleClusterContent}</span>
  )

  const rowElement = (
    <div
      data-row-key={rowKey}
      data-workspace-id={workspace.id}
      // Roving tabindex: exactly one treeitem is in the tab order at a time,
      // and Arrow/Home/End move focus between rows (handleTreeRowKeyDown).
      tabIndex={isRovingTarget ? 0 : -1}
      onFocus={() => {
        setRovingKey(rowKey)
        intendToOpenWorkspace(workspace.id)
      }}
      // A pointer resting on the row reads its chat ahead of the click.
      onPointerEnter={() => intendToOpenWorkspace(workspace.id)}
      onPointerLeave={() => cancelOpenIntent(workspace.id)}
      onKeyDown={(event) => handleTreeRowKeyDown(event, workspace.id)}
      // Drag-to-reorder is the tree's: it rewrites the stored order of a
      // folder's chats, and the flat stream is ordered by the clock, so a
      // drag there would move a row you cannot see moving. Dropping a
      // TERMINAL onto a chat is untouched — that is not about order.
      draggable={!anyRenaming && !flatProject}
      onDragStart={(event) => {
        if (flatProject) return
        handleRowDragStart(event, workspace, fKey)
      }}
      onDragOver={(event) => {
        if (dataTransferHasTabDrag(event.dataTransfer)) {
          handleTabDragOverRow(event, workspace)
          return
        }
        if (flatProject) return
        handleRowDragOver(event, workspace, fKey)
      }}
      onDragLeave={() => handleTabDragLeaveRow(workspace.id)}
      onDrop={(event) => {
        if (dataTransferHasTabDrag(event.dataTransfer)) {
          handleTabDropOnRow(event, workspace)
          return
        }
        if (flatProject) return
        handleRowDrop(event, workspace, fKey)
      }}
      onDragEnd={handleDragEnd}
      onClick={() => {
        if (anyRenaming) return
        onSelectWorkspace(workspace.id)
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        startRename(workspace)
      }}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault()
          handleClose(workspace.id)
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        setContextMenu({ workspaceId: workspace.id, x: event.clientX, y: event.clientY })
      }}
      // design-tokens-allow: alignment — 26px inset after the 4px highlight rail puts the row title on the sidebar's 36px content column (see the layout note below); the flat stream has no folder header to sit under, so its rows give the indent back and start on the column's own 16px edge, where New chat starts
      // Two-line row (remote-sessions-ux): a column now — line 1 is the title
      // + status cluster, line 2 the meta (heads · provenance · branch ·
      // diff). min-h keeps a metaless row exactly the height it always was.
      className={`interactive group relative mx-1.5 my-0.5 flex min-h-control-sm cursor-pointer select-none flex-col justify-center gap-0.5 rounded-md border-l-[4px] border-l-transparent py-1 pr-1.5 text-heading ${
        flatProject ? 'pl-1.5' : 'pl-[26px]'
      } ${FOCUS_RING_CLASS} ${
        needsAttention
          ? attentionRowClass(active)
          : unseenDone
            ? doneRowClass(active)
            : active
              ? activeRowClass(workspace)
              : highlighted
                ? `${inactiveHighlightClass(workspace)} text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]`
                : 'text-[color:var(--text-default)] hover:bg-[color:var(--bg-surface-raised)] hover:text-[color:var(--text-strong)]'
      } ${folderMissing ? 'opacity-70' : ''}`}
      role="treeitem"
      aria-current={active ? 'true' : undefined}
      data-settle-flourish={settleFlourish ? '' : undefined}
    >
      {/* The flat stream's top line (all-chats-view): the project this chat
          belongs to, and the clock — or what the agent is doing — at the
          trailing edge. It is the one line that is the same shape on every
          row, which is what lets the eye find the clock without reading the
          row; in the tree the folder header says the project instead and the
          clock rides whichever line the row happens to end on.

          A folder glyph, not the project's logo: the logo belongs to the one
          header that names the project (reversed 2026-09-02 for
          exactly this — a project's mark once per chat is repetition), and
          this line is a row's filing, not a heading. */}
      {flatProject ? (
        <ProjectLine
          project={flatProject}
          // A chat on another machine wears that machine's mark here too: in
          // this view it IS an ordinary row of its project, so the mark
          // trailing the project's name is the only thing saying where it runs.
          machine={rowMachine}
          dim={emphasis === 'quiet'}
        >
          {statusSeat}
        </ProjectLine>
      ) : null}
      <AttentionPulse active={needsAttention} resetKey={workspace.id} />
      <AttentionPulse active={unseenDone} resetKey={workspace.id} tone="good" />
      {/* An agent opened a file or diff here while no window showed it: the
          row's own flash says something is waiting, and switching to the
          workspace opens it. Nothing else moves. */}
      <AttentionPulse active={revealPending} resetKey={workspace.id} />
      {dropMark === 'before' ? (
        <span
          aria-hidden="true"
          className="absolute inset-x-1 top-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]"
        />
      ) : null}
      {dropMark === 'after' ? (
        <span
          aria-hidden="true"
          className="absolute inset-x-1 bottom-[-1px] h-[2px] rounded bg-[color:var(--accent-primary)]"
        />
      ) : null}
      {isTabDropTarget ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-[color:var(--accent-primary)] ring-offset-0"
        />
      ) : null}

      <div className="flex min-w-0 items-center gap-2">
        {/* No identity slot on the row. Owner, 2026-09-02: the project's
          discovered logo belongs to the FOLDER header that names the project,
          not repeated once per chat beneath it, and the terminal glyph the
          logo-less rows fell back to said nothing a row of chats needs said.
          So the row opens on its title again, as it did before project logos'
          ruling C, and the whole slot — logo and glyph — moved up to the
          header (`FolderIdentityIcon`). Mode identity still reads from the
          row accent and the trailing run glyph. */}
        {renaming ? (
          // The kit's field, spliced into a row that has already decided its
          // height: `size="none"` spends no ramp step, so the inset and the
          // row's own type step stay here as layout. `variant="default"` is
          // the right ground — `--bg-field` IS `--bg-surface-raised` on an
          // opaque window — and brings the border, the radius, the hover edge
          // lift and the one focus ring with it.
          <Input
            ref={renameInputRef}
            size="none"
            fullWidth={false}
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onBlur={commitRename}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename()
              if (event.key === 'Escape') setRenamingId(null)
              event.stopPropagation()
            }}
            className="min-w-0 flex-1 px-1.5 py-0 text-heading"
          />
        ) : (
          titleCluster
        )}

        {/* What this chat's agents have running: a dev server, a preview.
            On the title line rather than the meta line because it is about
            the chat as a whole and is live state, which a parked row with no
            second line still has. Drawn only while one is up. */}
        {rowLocalServers && !renaming ? (
          <LocalServersRowMark workspaceId={workspace.id} servers={rowLocalServers} dim={emphasis === 'quiet'} />
        ) : null}

        {folderMissing ? (
          <svg
            className="icon-xs shrink-0 text-[color:var(--tone-warn)]"
            viewBox="0 0 16 16"
            fill="none"
            aria-label="Folder missing"
          >
            <path d="M8 1L15 14H1L8 1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M8 6V9M8 11.5V11.51" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        ) : null}

        {/* A provider-derived run lifecycle is the ROW's state, not a terminal's, so
          when the LINES carry the seats it keeps line 1's trailing edge —
          a terminal's seat has no room for it. The parked worktree line
          below carries the row's own `statusSeat`, which already draws this
          glyph, so the condition is the lines and not `metaHasSubstance`:
          the two diverged the moment a lineless row could have a line 2,
          and asking the wrong one drew the glyph twice on any row whose
          module hands it one. */}
        {rowLines.lines.length > 0 && runGlyph && runGlyphLabel ? (
          <RowTooltip content={runGlyphLabel}>
            <LifecycleGlyph state={runGlyph.state} live={runGlyph.live} label={runGlyphLabel} />
          </RowTooltip>
        ) : null}
        {/* A lineless row has no line to carry the seat, so it keeps it
          here — the one-liner it always was. Never in the flat stream,
          where the project line above already took it. */}
        {metaHasSubstance || flatProject ? null : statusSeat}
      </div>
      {parkedLine ? (
        // The same line container a terminal's line uses, so a parked
        // worktree row is exactly as tall as a live one and its seat sits
        // where every other seat sits.
        <div
          className={`flex h-5 min-w-0 items-center gap-2 overflow-hidden text-meta ${
            emphasis === 'quiet' ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
          }`}
        >
          {parkedWorktreeBranch ? (
            <BranchChip
              branch={parkedWorktreeBranch}
              worktree
              cwd={workspace.folderPath ?? null}
              dim={emphasis === 'quiet'}
              tooltip={
                worktreeReclaimed
                  ? 'Worktree given back once its work was merged · checked out again from this branch when you open the chat'
                  : undefined
              }
            />
          ) : null}
          {/* After the branch, where a live line puts it, so the two rows
              read the same way. No ±lines beside it: a parked row's diff is
              the checkout's present state and not anything this chat did
              (the-diff-an-agent-made, decision 9) — the pull request is the
              one fact that is still this conversation's. */}
          <PullRequestMark pullRequests={rowOnlyPullRequests} dim={emphasis === 'quiet'} />
          {flatProject ? null : statusSeat}
        </div>
      ) : null}
      {rowLines.lines.map((line, index) => {
        // An agent line's ±count is that agent's own work, so pressing it
        // opens that agent's changelist. The agent id comes from the row's
        // sessions rather than from the line, because a line is a drawing of
        // a terminal and the diff is a fact about the agent inside it.
        const lineSession =
          line.kind === 'agent' ? peekSessions.find((session) => session.sessionId === line.key) : undefined
        const lineAgentId = lineSession?.agentId ?? null
        // An agent's list is filed under the workspace its process was launched
        // in, which for one moved here from another chat is not this one.
        const lineListWorkspaceId = lineSession?.launchWorkspaceId ?? workspace.id
        return (
          <TerminalLineView
            key={line.key}
            line={line}
            now={now}
            seatOverlay={index === 0 && !flatProject ? rowActionsOverlay : undefined}
            disambiguate={rowLines.lines.length > 1}
            dim={emphasis === 'quiet'}
            rowOwnsStatus={flatProject !== null}
            onOpenDiff={
              lineAgentId
                ? () =>
                    openPaneTab(workspace.id, {
                      kind: 'diff',
                      diff: {
                        focusPath: null,
                        focusKind: null,
                        changelistId: changelistOwnerId({ workspaceId: lineListWorkspaceId, agentId: lineAgentId }),
                      },
                    })
                : undefined
            }
          />
        )
      })}
      {visibleConversations.map((session, index) => {
        const mark = conversationLineMark(session)
        return (
          <div
            key={session.sessionId}
            data-peek-session={session.sessionId}
            className={`flex h-5 min-w-0 items-center gap-2 overflow-hidden text-meta ${emphasis === 'quiet' ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'}`}
          >
            <Tooltip content={mark.tooltip} placement="bottom" wrapperClassName="flex shrink-0 items-center">
              {/* The same ringed provider mark a terminal line wears
                  (TerminalLineView), so a chat and a terminal running the same
                  CLI say so in the same place; a provider that is not a CLI
                  keeps the chat glyph inside the same ring. */}
              <span
                role="img"
                aria-label={mark.runtimeLabel}
                className="flex size-icon-sm shrink-0 items-center justify-center rounded-full border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)]"
              >
                {mark.cli ? (
                  <CliIcon cli={mark.cli} className="icon-xs" />
                ) : (
                  <ChatGlyph className="icon-xs text-[color:var(--text-muted)]" />
                )}
              </span>
            </Tooltip>
            <PullRequestMark pullRequests={chatLinePullRequestsOf(session.agentId)} dim={emphasis === 'quiet'} />
            <span className="min-w-0 flex-1 truncate">{conversationLineText(session)}</span>
            {index === 0 && rowLines.lines.length === 0 && !flatProject ? (
              <>
                {/* A chat with no finished turn to rest on (running, waiting on
                    a person, brand new) has no idle cache to mark. */}
                <PromptCacheMark
                  reading={session.promptCache}
                  working={conversationFinishedAt(session) === null}
                  includeCold={false}
                />
                {statusSeat}
              </>
            ) : !flatProject ? (
              <ConversationLineSeat session={session} now={now} />
            ) : (
              // The flat list's row says when; the line says only the cache
              // about to go cold.
              <PromptCacheMark
                reading={session.promptCache}
                working={conversationFinishedAt(session) === null}
                includeCold={false}
              />
            )}
          </div>
        )
      })}
      {rowLines.overflow > 0 ? (
        <div
          className={`flex h-5 items-center text-micro ${
            emphasis === 'quiet' ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-subtle)]'
          }`}
        >
          +{rowLines.overflow} more {rowLines.overflow === 1 ? 'terminal' : 'terminals'}
        </div>
      ) : null}
    </div>
  )
  // The card is this row's hover surface where it has one, so the row's own
  // readings stop opening tooltips underneath it (`RowTooltip`).
  return <RowTooltipsSuppressed.Provider value={hasPeek}>{rowElement}</RowTooltipsSuppressed.Provider>
})

/**
 * A chat line's own seat, for a line that does not carry the row's: the
 * working mark while a turn or its background agents run, else how long since
 * its last turn finished — what a
 * terminal line's seat says (TerminalLineView), so a row with a terminal and a
 * chat can tell you when each one stopped. A chat waiting on a person says so
 * in its text; the row's gold surface is the mark.
 */
function ConversationLineSeat({ session, now }: { session: ConversationSessionSummary; now: number }) {
  const phase = conversationSummaryPhase(session)
  const finishedAt = conversationFinishedAt(session)
  let content: React.ReactNode = null
  if (phase === 'running' || phase === 'starting')
    content = <WorkingMark label="Agent working" seed={session.agentId} />
  else if (finishedAt !== null && formatRelativeMs(finishedAt, now)) {
    content = (
      <>
        <PromptCacheMark reading={session.promptCache} working={false} includeCold={false} />
        <RowTooltip content={`${formatRelativeMsAgo(finishedAt, now)} (${new Date(finishedAt).toLocaleString()})`}>
          <span className="text-meta tabular-nums text-[color:var(--text-subtle)]">
            <span aria-hidden="true">{formatRelativeMs(finishedAt, now)}</span>
            <span className="sr-only">{formatRelativeMsAgo(finishedAt, now)}</span>
          </span>
        </RowTooltip>
      </>
    )
  }
  return content ? (
    <span className="ml-auto flex h-5 shrink-0 items-center justify-end gap-1 pl-2">{content}</span>
  ) : null
}

// Memoized: the manager re-renders on every store write it projects, and the
// sidebar only needs to follow when one of its own props moved. Its rows are
// memoized again underneath (`WorkspaceRow`).
export default React.memo(WorkspaceSidebar)
