import type { Workspace, WorkspaceId } from '../../types/workspace'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import { isSettledWorkspace } from '../../utils/workspaceSettle'
import { isHiddenFromRail } from '../../utils/workspaceVisibility'
import { folderDisplayName, remoteGroupDisplayName, remoteGroupOf } from '../workspace/sidebar/folderGroups'
import { remoteConversationTitle } from '../workspace/remoteBand/remoteSessionsModel'

// Settings ▸ Settled chats reads the same record the sidebar's Settled shelf
// did (`settledAt`) — there is no second store of old chats, only a second
// place to look at the one there is.

export type SettledChatEntry = {
  id: WorkspaceId
  /** The row title the sidebar would have drawn. */
  title: string
  /** The project the sidebar would have filed it under. */
  project: string
  settledAt: number
  /** The paired machine it lives on, for a chat opened here from one; deleting it takes this computer's record only. */
  remoteMachine: string | null
}

/** One workspace's entry, or null when it is not a settled chat the rail would draw. */
function settledChatEntry(
  workspace: Workspace,
  moduleOverrides: ModuleEnablementOverrides | undefined,
): SettledChatEntry | null {
  if (!isSettledWorkspace(workspace) || isHiddenFromRail(workspace, moduleOverrides)) return null
  return {
    id: workspace.id,
    title: remoteConversationTitle(workspace),
    project: remoteGroupOf(workspace) ? remoteGroupDisplayName(workspace) : folderDisplayName(workspace.folderPath),
    settledAt: workspace.settledAt as number,
    remoteMachine: workspace.remoteOrigin?.machineName ?? null,
  }
}

const bySettledAt = (a: SettledChatEntry, b: SettledChatEntry) => b.settledAt - a.settledAt

/**
 * Every settled chat the rail would draw, most recently settled first: the
 * question someone opening this page is asking is "the one I put away the
 * other day", not "the oldest thing I own". Rail-hidden workspaces (a
 * module's own background residency) stay out here for the same reason they
 * are out of the rail — they were never chats.
 */
export function listSettledChats(
  workspaces: readonly Workspace[],
  moduleOverrides?: ModuleEnablementOverrides,
): SettledChatEntry[] {
  const entries: SettledChatEntry[] = []
  for (const workspace of workspaces) {
    const entry = settledChatEntry(workspace, moduleOverrides)
    if (entry) entries.push(entry)
  }
  return entries.sort(bySettledAt)
}

function entriesEqual(a: SettledChatEntry, b: SettledChatEntry): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.project === b.project &&
    a.settledAt === b.settledAt &&
    a.remoteMachine === b.remoteMachine
  )
}

/**
 * `listSettledChats` as a store selector for a page that stays open while the
 * store is written to (background agents write on every turn end). Each
 * workspace object is read once, each entry keeps its object while what it
 * says is unchanged, and the list itself is the previous array when no entry
 * moved, so a write to any other workspace re-renders nothing.
 */
export function createSettledChatsSelector(): (
  workspaces: readonly Workspace[],
  moduleOverrides?: ModuleEnablementOverrides,
) => SettledChatEntry[] {
  let readFor: ModuleEnablementOverrides | undefined
  let read = new WeakMap<Workspace, SettledChatEntry | null>()
  let previous: SettledChatEntry[] = []
  let previousById = new Map<WorkspaceId, SettledChatEntry>()
  return (workspaces, moduleOverrides) => {
    if (moduleOverrides !== readFor) {
      readFor = moduleOverrides
      read = new WeakMap()
    }
    const entries: SettledChatEntry[] = []
    for (const workspace of workspaces) {
      let entry = read.get(workspace)
      if (entry === undefined) {
        entry = settledChatEntry(workspace, moduleOverrides)
        const prior = entry ? previousById.get(entry.id) : undefined
        if (entry && prior && entriesEqual(prior, entry)) entry = prior
        read.set(workspace, entry)
      }
      if (entry) entries.push(entry)
    }
    entries.sort(bySettledAt)
    if (entries.length === previous.length && entries.every((entry, index) => entry === previous[index])) {
      return previous
    }
    previous = entries
    previousById = new Map(entries.map((entry) => [entry.id, entry]))
    return entries
  }
}
