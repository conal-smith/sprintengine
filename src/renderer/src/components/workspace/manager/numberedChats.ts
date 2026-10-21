import type { Workspace, WorkspaceId } from '../../../types/workspace'
import { isSettledWorkspace } from '../../../utils/workspaceSettle'
import { isSnoozedWorkspace } from '../../../utils/workspaceSnooze'

// The attribute the sidebar's chat tree carries (`WorkspaceSidebar`), so the
// window can read its rows in the order they are drawn.
const WORKSPACE_TREE_ATTRIBUTE = 'data-workspace-tree'

/** One chat row of the sidebar's tree: its own key (`data-row-key`) and its chat. */
type DrawnChatRow = { rowKey: string; workspaceId: WorkspaceId }

/**
 * The sidebar's chat rows, top to bottom, as they are drawn — or null when this
 * document has no sidebar tree to read. A collapsed sidebar keeps its rows in
 * the DOM, so this still answers while it is hidden. A chat drawn twice (in
 * Starred and under its project) is two rows here.
 */
function drawnSidebarChatRows(root: ParentNode): DrawnChatRow[] | null {
  const tree = root.querySelector(`[${WORKSPACE_TREE_ATTRIBUTE}]`)
  if (!tree) return null
  const rows: DrawnChatRow[] = []
  for (const row of tree.querySelectorAll<HTMLElement>('[role="treeitem"][data-workspace-id]')) {
    const id = row.dataset.workspaceId
    if (id) rows.push({ rowKey: row.dataset.rowKey ?? id, workspaceId: id as WorkspaceId })
  }
  return rows
}

/**
 * The chat ids of the sidebar's rows, top to bottom, as they are drawn — or
 * null when this document has no sidebar tree to read.
 */
export function drawnSidebarChatIds(root: ParentNode): WorkspaceId[] | null {
  return drawnSidebarChatRows(root)?.map((row) => row.workspaceId) ?? null
}

/**
 * The rows Primary+1…9 open, in order: for each numbered chat, the first row
 * it is drawn in — the one `numberedChatIds` counted, so a hint on it names
 * the chord that opens exactly that chat. Empty when there is no sidebar tree.
 */
export function numberedChatRows(root: ParentNode, workspaces: readonly Workspace[], now: number): DrawnChatRow[] {
  const rows = drawnSidebarChatRows(root)
  if (!rows) return []
  const firstRowOf = new Map<WorkspaceId, DrawnChatRow>()
  for (const row of rows) if (!firstRowOf.has(row.workspaceId)) firstRowOf.set(row.workspaceId, row)
  return numberedChatIds(
    rows.map((row) => row.workspaceId),
    workspaces,
    now,
  ).flatMap((id) => firstRowOf.get(id) ?? [])
}

/**
 * The chats Primary+1…9 reach, in order — and the order Primary+` and
 * Primary+Shift+` step through, from the chat on screen (`keep`). The number keys follow the rail as
 * the person sees it — Starred first, then each project's chats by last
 * message, with a collapsed project's rows skipped — so "the third chat" is
 * the third row on screen. Rows on a Settled or Snoozed shelf are passed over,
 * as the hand-off after a Settle passes over them: a number key is for a chat
 * that is still going. A row drawn twice counts once.
 *
 * `drawn` is null when there is no sidebar to read; the store order of the
 * rail's chats stands in, with the resting and sleeping ones left out.
 */
export function numberedChatIds(
  drawn: readonly WorkspaceId[] | null,
  workspaces: readonly Workspace[],
  now: number,
  /** Kept even if it rests: the chat on screen, which a step goes on from. */
  keep: WorkspaceId | null = null,
): WorkspaceId[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  const candidates = drawn ?? workspaces.map((workspace) => workspace.id)
  const seen = new Set<WorkspaceId>()
  const ids: WorkspaceId[] = []
  for (const id of candidates) {
    if (seen.has(id)) continue
    seen.add(id)
    const workspace = byId.get(id)
    if (!workspace) continue
    if (id !== keep && (isSettledWorkspace(workspace) || isSnoozedWorkspace(workspace, now))) continue
    ids.push(id)
  }
  return ids
}
