// The workspace store selector WorkspaceManager renders from, and the
// equality check that keeps it from re-rendering on fields it never reads.

import type { Workspace } from '../../../types/workspace'
import { workspaceLastUserMessageAt } from '../../../utils/workspaceRecency'
import { isMeshConversationPane } from '../../../../../shared/tailnet-mesh'

export type WorkspaceManagerWorkspaceCacheEntry = {
  source: Workspace
  value: Workspace
}

export const workspaceManagerWorkspaceCache = new Map<string, WorkspaceManagerWorkspaceCacheEntry>()

export function workspaceManagerWorkspaceFieldsEqual(left: Workspace, right: Workspace): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.mode === right.mode &&
    left.folderPath === right.folderPath &&
    left.folderMissing === right.folderMissing &&
    // The row's provenance and machine: the remote badge and grouping, the
    // parked worktree branch, and the machine the manager opens this chat's
    // new terminals on.
    left.remoteOrigin === right.remoteOrigin &&
    left.hostId === right.hostId &&
    left.worktree === right.worktree &&
    left.templateId === right.templateId &&
    // Not the layout itself: a tab click, a splitter drag and every tab
    // selection write a new layoutModel, and nothing the manager or the
    // sidebar renders reads more of it than which mesh panes it holds.
    // Anything that needs the whole layout reads the store at the moment it
    // acts (the sidebar's cross-workspace drop, the terminal kill paths).
    layoutMeshSignature(left) === layoutMeshSignature(right) &&
    left.worktreeState === right.worktreeState &&
    left.memory === right.memory &&
    left.editorState === right.editorState &&
    left.fileExplorerState === right.fileExplorerState &&
    left.moduleState === right.moduleState &&
    left.highlight === right.highlight &&
    left.createdAt === right.createdAt &&
    // The sidebar's ordering key: without it a chat kept its old place until
    // some unrelated field moved the projection along. The key, not the raw
    // keystroke clock: `lastTerminalActivityAt` advances on terminal input,
    // and it only orders the rows that have never been messaged, for which it
    // is the fallback. A spoken-in chat's keystrokes no longer re-render the
    // manager and the whole sidebar.
    workspaceLastUserMessageAt(left) === workspaceLastUserMessageAt(right) &&
    left.lastUserMessageAt === right.lastUserMessageAt &&
    left.lastTurnEndedAt === right.lastTurnEndedAt &&
    // Rest (settled-chats, 2026-09-07): a Settle or Un-settle changes only
    // these, and the sidebar renders from this projection — without them the
    // row stayed where it was until something unrelated moved.
    left.settledAt === right.settledAt &&
    left.settledOverride === right.settledOverride &&
    // The row menu's Auto-settle choice draws its check from this.
    left.autoSettleEnabled === right.autoSettleEnabled &&
    // And its Auto compact choice.
    left.autoCompactEnabled === right.autoCompactEnabled &&
    // Sleep: Snooze and Wake write only this, and the sidebar files the row
    // under the Snoozed shelf from it. Without it a snoozed chat stayed in
    // the active list until something unrelated moved the projection.
    left.snoozedUntil === right.snoozedUntil &&
    // The pane column: open/closed, its tabs, the tab showing. Without it the
    // projection handed back the cached workspace when the pane opened, so a
    // value derived from `paneState` off this projection (the pane-open flag
    // the card's right edge used to gate on) kept what it had at first render
    // until an unrelated field moved.
    left.paneState === right.paneState
  )
}

// Keyed by layout object: a layout is written whole and never mutated, so a
// signature computed once holds for as long as that object lives.
const meshSignatureByLayout = new WeakMap<object, string>()

/**
 * The part of a layout the sidebar renders: its mesh panes (the machine
 * names on the row, and which workspace a remote session is attached to), in
 * layout order. A layout change that leaves these alone is invisible to every
 * consumer of this projection.
 */
export function layoutMeshSignature(workspace: Pick<Workspace, 'layoutModel'>): string {
  const model = workspace.layoutModel as { layout?: unknown; borders?: unknown } | undefined
  if (!model || typeof model !== 'object') return ''
  const cached = meshSignatureByLayout.get(model)
  if (cached !== undefined) return cached
  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as { type?: unknown; component?: unknown; id?: unknown; config?: unknown; children?: unknown }
    if (record.type === 'tab' && isMeshConversationPane(record.component)) {
      parts.push(JSON.stringify([record.id ?? null, record.config ?? null]))
    }
    if (Array.isArray(record.children)) for (const child of record.children) walk(child)
  }
  walk(model.layout)
  if (Array.isArray(model.borders)) for (const border of model.borders) walk(border)
  const signature = parts.join('\n')
  meshSignatureByLayout.set(model, signature)
  return signature
}

export function selectWorkspaceManagerWorkspaces(workspaces: Workspace[]): Workspace[] {
  const liveIds = new Set<string>()
  const selected = workspaces.map((workspace) => {
    liveIds.add(workspace.id)
    const cached = workspaceManagerWorkspaceCache.get(workspace.id)
    if (cached && workspaceManagerWorkspaceFieldsEqual(cached.source, workspace)) {
      return cached.value
    }
    workspaceManagerWorkspaceCache.set(workspace.id, { source: workspace, value: workspace })
    return workspace
  })

  for (const workspaceId of workspaceManagerWorkspaceCache.keys()) {
    if (!liveIds.has(workspaceId)) workspaceManagerWorkspaceCache.delete(workspaceId)
  }

  return selected
}
