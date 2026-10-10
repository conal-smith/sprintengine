// How the sidebar files workspaces: folder groups, remote groups, the
// All chats shelves, and reordering within and between them.

import { type Workspace, type WorkspaceId } from '../../../types/workspace'
import type { RepositoryIdentity } from '../../../../../shared/repository-identity'
import { type RemoteConversation } from '../remoteBand/remoteSessionsModel'
import { type FolderIdentityMap, folderIdentityKey } from '../useFolderRepositoryIdentities'
import { workspaceProjectRoot } from '../../../utils/workspaceWorktree'
import { shortMachineName } from '../../remote/machineRowModel'
import { isMeshConversationPane } from '../../../../../shared/tailnet-mesh'
import { isProjectlessChatsRoot, PROJECTLESS_CHATS_LABEL } from '../../../../../shared/projectless-chats'

export type FolderGroup = {
  key: string
  displayName: string
  fullPath: string | null
  missing: boolean
  workspaces: Workspace[]
  // A header for chats born on a paired machine (remote-sessions-ux /
  // new-chat-on-a-remote-machine): the machine plus the remote workspace's
  // root. Epic decision 6 puts project identity on the folder header, and a
  // remote row's project is on another machine — so the header names the
  // folder there, rather than filing the row under "No folder". Null for every
  // local group, AND for a remote project that has a local clone open here:
  // that one is the local header, which remote rows simply join.
  remote: {
    machineName: string
    workspaceRoot: string | null
    /**
     * Which repository the machine said the folder is. It is what this group's
     * hue is keyed on — a project is a repository (decision 3), so the same
     * repository wears one colour wherever it runs. Null when the machine could
     * not say, and then the group has no key and no hue: a path on another
     * disk must never key a colour, or one project ends up in two.
     */
    repository: RepositoryIdentity | null
  } | null
  /**
   * Conversations on paired machines that no window here is attached to
   * (owner, 2026-09-11). They are rows of this project like any other — the
   * difference is that opening one attaches a pane rather than focusing a
   * workspace, so they cannot be `Workspace`s until they are opened.
   */
  remoteRows: RemoteConversation[]
}

export const NULL_FOLDER_KEY = '__no_folder__'

/**
 * The header facts a merged group takes from its local folder (the row that
 * founds the group may be the remote one, which has no folder of its own).
 */
export type LocalGroupHeader = { key: string; folderPath: string; missing: boolean }

export function resolveGroups(
  workspaces: readonly Workspace[],
  identities: FolderIdentityMap,
): { keys: Map<string, string>; headers: Map<string, LocalGroupHeader> } {
  // The local twin per repository, chosen by a rule that does not move when
  // rows are reordered or a chat is added: a plain checkout over a worktree
  // (a worktree shares its checkout's remote, and is its own header), then
  // the lexically first folder. Otherwise a remote row hopped between the
  // two headers on unrelated actions.
  const localByIdentity = new Map<string, { key: string; folder: string; worktree: boolean }>()
  const keys = new Map<string, string>()
  for (const workspace of workspaces) {
    const key = groupKeyOf(workspace)
    keys.set(workspace.id, key)
    const folder = workspace.folderPath?.trim()
    if (!folder || workspace.remoteOrigin || workspace.environment) continue
    const identity = identities.get(folderIdentityKey(folder))
    if (!identity?.canonicalKey) continue
    const candidate = {
      key,
      // The group's key, not the row's own folder: a worktree row already
      // files under its parent, so that is the header a remote twin would
      // be joining if this row were the pick.
      folder: key,
      worktree: Boolean(workspace.worktree) || ownFolderKeyOf(workspace) !== key,
    }
    const current = localByIdentity.get(identity.canonicalKey)
    const better =
      !current ||
      (current.worktree && !candidate.worktree) ||
      (current.worktree === candidate.worktree && candidate.folder < current.folder)
    if (better) localByIdentity.set(identity.canonicalKey, candidate)
  }
  for (const workspace of workspaces) {
    const repository = workspace.remoteOrigin?.repository
    if (!repository?.canonicalKey) continue
    const local = localByIdentity.get(repository.canonicalKey)
    if (local) keys.set(workspace.id, local.key)
  }
  // Two passes, because a header is a folder's own statement first. A row
  // that IS the folder speaks for it — path and missing-ness both — so a
  // plain workspace of the project always wins the header over a worktree
  // filed under it.
  const headers = new Map<string, LocalGroupHeader>()
  for (const workspace of workspaces) {
    const key = keys.get(workspace.id) ?? groupKeyOf(workspace)
    const folderPath = workspace.folderPath?.trim()
    if (workspace.remoteOrigin || workspace.environment || !folderPath || headers.has(key)) continue
    if (ownFolderKeyOf(workspace) !== key) continue
    headers.set(key, { key, folderPath, missing: workspace.folderMissing === true })
  }
  // Then the keys nobody spoke for: a worktree chat whose parent project is
  // not itself open. The header is still the parent's — its name and its
  // full path — and never missing, since no row here has looked at it.
  for (const workspace of workspaces) {
    const key = keys.get(workspace.id) ?? groupKeyOf(workspace)
    if (workspace.remoteOrigin || workspace.environment || headers.has(key)) continue
    const folderPath = workspaceProjectRoot(workspace)
    if (!folderPath) continue
    headers.set(key, { key, folderPath, missing: false })
  }
  return { keys, headers }
}

export function normalizeFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '')
}

// A folder of nothing but whitespace is no folder at all, and has to be no
// folder to EVERY reader: `workspaceProjectRoot` already trims it away, so a
// key that kept it would file the row under a header spelled "   " while the
// project it hands to New chat is null.
export function folderKey(value: string | null): string {
  if (!value?.trim()) return NULL_FOLDER_KEY
  return normalizeFolder(value).toLowerCase()
}

export function folderDisplayName(value: string | null): string {
  if (!value?.trim()) return 'No folder'
  // The root every chat started without a project files under.
  if (isProjectlessChatsRoot(value)) return PROJECTLESS_CHATS_LABEL
  const normalized = normalizeFolder(value)
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}

/**
 * Which header a row files under. Local rows group by folder exactly as they
 * always have; a remote-born row (`workspace.remoteOrigin`, the durable
 * provenance record — the mark rides the workspace, not a live pane, so
 * closing the pane never loses it) groups by the machine
 * and the remote workspace, never under "No folder". A legacy remote row —
 * no `remoteOrigin`, no folder, but mesh panes in its layout — groups by
 * the machine its layout names.
 *
 * A worktree-backed row files under the project it was cut from, not under
 * its own checkout: the person branched one project, they did not open a
 * second one, and a header named after the slug says otherwise. The row says
 * it is a worktree on its own line instead.
 */
export function groupKeyOf(workspace: Workspace): string {
  // A row on an SSH machine (phase 8) files under that machine's folder: the
  // same path on this computer is another folder.
  if (workspace.environment) return `ssh:${workspace.environment.id}:${folderKey(workspace.folderPath)}`
  const origin = workspace.remoteOrigin
  // A remote row files under its PROJECT, not under itself (owner,
  // 2026-09-11). Keyed by the repository where the machine could name one — so
  // two chats in one checkout over there share a header, and the same
  // repository on two machines is one project — and otherwise by the folder
  // they stand in on that machine. Keying by the remote workspace id, as this
  // did, gave every remote chat a header of its own.
  if (origin) {
    if (origin.repository?.canonicalKey) return `remote-repo:${origin.repository.canonicalKey}`
    return `remote:${origin.connectionId}:${folderKey(origin.workspaceRoot)}`
  }
  if (!workspace.folderPath) {
    const [machine] = meshMachineNamesOf(workspace)
    if (machine) return `remote:${machine.toLowerCase()}`
  }
  return folderKey(workspaceProjectRoot(workspace))
}

/**
 * The key this row's own folder makes, before regrouping — the answer to
 * "did this row found its own group?", which `groupKeyOf` can no longer give
 * now that a worktree row is deliberately filed elsewhere.
 */
export function ownFolderKeyOf(workspace: Workspace): string {
  return folderKey(workspace.folderPath)
}

/**
 * Where "New chat in project" lands from this row, and null when there is
 * nowhere live to land it. The project is the header the row files under —
 * for a worktree row, the checkout it was cut from — so a worktree pruned
 * from under a chat does not take the action away: what went missing is the
 * worktree, not the project. Only a row whose target IS its own folder is
 * stopped by that folder being gone; a parent's own state is the header's to
 * report, and a header synthesized from a worktree never reports missing.
 */
export function newChatProjectTarget(workspace: Workspace): string | null {
  const own = workspace.folderPath?.trim()
  if (!own) return null
  const target = workspaceProjectRoot(workspace) ?? own
  if (folderKey(target) === ownFolderKeyOf(workspace)) return workspace.folderMissing ? null : target
  return target
}

export function remoteGroupOf(workspace: Workspace): FolderGroup['remote'] {
  if (workspace.environment)
    return { machineName: workspace.environment.label, workspaceRoot: workspace.folderPath, repository: null }
  const origin = workspace.remoteOrigin
  if (origin) {
    return {
      machineName: origin.machineName,
      workspaceRoot: origin.workspaceRoot,
      repository: origin.repository ?? null,
    }
  }
  if (!workspace.folderPath) {
    const [machine] = meshMachineNamesOf(workspace)
    if (machine) return { machineName: machine, workspaceRoot: null, repository: null }
  }
  return null
}

/**
 * A remote-only project's header: the FOLDER's name on that machine, and
 * nothing else (owner, 2026-09-11).
 *
 * It used to read "mac-mini.example.ts.net · sprintengine" — the machine
 * first, the project second, so the same repository on two machines read as two
 * different projects and neither header lined up with the local one. The
 * machine is a glyph on each row now, with the device's name on hover, which is
 * where provenance belongs when the project is the thing being grouped.
 *
 * `workspaceRoot` is the folder over there; `workspaceName` is a CHAT's name
 * and is never a header, which is the same reason the New-chat project chip
 * stopped offering chats as projects.
 */
export function remoteProjectName(workspaceRoot: string | null, machineName: string): string {
  // The machine, not "No folder", when the remote could not name a folder: a
  // chat over there IS somewhere, and a header spelled "No folder" would both
  // lie and collide with the local folderless group's name.
  if (!workspaceRoot?.trim()) return shortMachineName(machineName)
  return folderDisplayName(workspaceRoot)
}

export function remoteGroupDisplayName(workspace: Workspace): string {
  if (workspace.environment) return remoteProjectName(workspace.folderPath, workspace.environment.label)
  const origin = workspace.remoteOrigin
  if (origin) return remoteProjectName(origin.workspaceRoot, origin.machineName)
  const [machine] = meshMachineNamesOf(workspace)
  return machine ? shortMachineName(machine) : 'No folder'
}

export function buildFolderGroups(
  workspaces: Workspace[],
  keyOf: (workspace: Workspace) => string = groupKeyOf,
  headers: ReadonlyMap<string, LocalGroupHeader> = new Map(),
): FolderGroup[] {
  const groupOrder: string[] = []
  const groups = new Map<string, FolderGroup>()

  for (const workspace of workspaces) {
    const key = keyOf(workspace)
    if (!groups.has(key)) {
      groupOrder.push(key)
      // A row that is not itself the folder — a remote row filed under a
      // local one, a worktree filed under its project — never founds the
      // group with a header of its own: the header is the project's, read
      // off the header map whatever row happens to come first in the list.
      const merged = key !== ownFolderKeyOf(workspace) ? (headers.get(key) ?? null) : null
      const remote = merged ? null : remoteGroupOf(workspace)
      // Trimmed for the same reason `folderKey` trims: whatever the key
      // called "no folder" must not reappear as a header path made of spaces.
      const folderPath = merged ? merged.folderPath : workspace.folderPath?.trim() || null
      groups.set(key, {
        key,
        displayName: remote ? remoteGroupDisplayName(workspace) : folderDisplayName(folderPath),
        // A remote group has no LOCAL path: nothing here may reveal, forget,
        // or create into a folder that lives on another machine.
        fullPath: remote ? null : folderPath,
        missing: remote ? false : merged ? merged.missing : workspace.folderMissing === true,
        workspaces: [],
        remote,
        remoteRows: [],
      })
    }
    const group = groups.get(key)!
    group.workspaces.push(workspace)
    // Only a row that IS the folder may report it gone. A pruned worktree is
    // its own folder's loss, not the project's, and painting the project
    // missing would also take away the header's New chat and Reveal.
    if (workspace.folderMissing && !group.remote && ownFolderKeyOf(workspace) === key) group.missing = true
  }

  return groupOrder.map((key) => groups.get(key)!)
}

export function reorderWithinFolder(
  workspaces: Workspace[],
  draggedId: WorkspaceId,
  targetId: WorkspaceId,
  position: 'before' | 'after',
): WorkspaceId[] {
  const next = [...workspaces]
  const draggedIdx = next.findIndex((w) => w.id === draggedId)
  if (draggedIdx === -1) return next.map((w) => w.id)
  const [dragged] = next.splice(draggedIdx, 1)
  let targetIdx = next.findIndex((w) => w.id === targetId)
  if (targetIdx === -1) {
    next.push(dragged)
  } else {
    if (position === 'after') targetIdx += 1
    next.splice(targetIdx, 0, dragged)
  }
  return next.map((w) => w.id)
}

export function reorderFolders(
  workspaces: Workspace[],
  draggedKey: string,
  targetKey: string,
  position: 'before' | 'after',
  keyOf: (workspace: Workspace) => string = groupKeyOf,
): WorkspaceId[] {
  const groups = buildFolderGroups(workspaces, keyOf)
  const draggedGroup = groups.find((g) => g.key === draggedKey)
  if (!draggedGroup) return workspaces.map((w) => w.id)
  const remaining = groups.filter((g) => g.key !== draggedKey)
  let targetIdx = remaining.findIndex((g) => g.key === targetKey)
  if (targetIdx === -1) {
    remaining.push(draggedGroup)
  } else {
    if (position === 'after') targetIdx += 1
    remaining.splice(targetIdx, 0, draggedGroup)
  }
  return remaining.flatMap((g) => g.workspaces.map((w) => w.id))
}

export function meshPanesOf(workspace: Workspace): Array<{ tabId: string; machineName: string; cli?: string }> {
  const panes: Array<{ tabId: string; machineName: string; cli?: string }> = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const record = node as { type?: unknown; id?: unknown; component?: unknown; config?: unknown; children?: unknown }
    if (record.type === 'tab' && isMeshConversationPane(record.component)) {
      const config = record.config as { machineName?: unknown; cli?: unknown; remoteSessionId?: unknown } | undefined
      const machine = config?.machineName
      if (typeof machine === 'string' && machine) {
        const tabId =
          typeof record.id === 'string' && record.id
            ? record.id
            : `mesh-conversation:${machine}:${String(config?.remoteSessionId ?? panes.length)}`
        panes.push({
          tabId,
          machineName: machine,
          ...(typeof config?.cli === 'string' && config.cli ? { cli: config.cli } : {}),
        })
      }
    }
    if (Array.isArray(record.children)) for (const child of record.children) walk(child)
  }
  const model = workspace.layoutModel as { layout?: unknown; borders?: unknown } | undefined
  walk(model?.layout)
  if (Array.isArray(model?.borders)) for (const border of model.borders) walk(border)
  return panes
}

/** The unique machine names of the workspace's mesh panes, in layout order. */
export function meshMachineNamesOf(workspace: Workspace): string[] {
  return [...new Set(meshPanesOf(workspace).map((pane) => pane.machineName))]
}
