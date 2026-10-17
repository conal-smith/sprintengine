import { isProjectlessChatsRoot } from '../../../../../shared/projectless-chats'
import type { RepositoryIdentity } from '../../../../../shared/repository-identity'
import type { MeshWorkspace } from '../../../../../shared/tailnet-mesh'
import { workspaceProjectRootOf } from '../../../../../shared/worktree-paths'

// The New-chat machine picker's project list, folded out of what a paired
// machine actually serves.
//
// `workspace.list` reports that machine's open WORKSPACES, and a workspace in
// this app is a conversation — so the raw list is "every chat open over there",
// which is what the remote project chip was drawing: eight rows named after
// eight chats, three of them the same folder. A project is a FOLDER, and the
// picker is choosing where a new chat runs, so the folder is the unit.
//
// Folded by folder path and not by repository, deliberately. Two chats on one
// machine can share a repository and NOT share a folder — a worktree chat is a
// clone of its project by `canonicalKey` and a different checkout on disk — and
// the id this list carries is the one `workspace.checkout` is asked with and
// the folder a launch lands in. Merging those would pick one of the two folders
// arbitrarily and run the chat in whichever won.
//
// The one exception is a worktree the app made itself: a pool slot or a
// `chat-…` folder under `.sprintengine-worktrees/<project>/` (owner, 2026-10-17:
// "I only want to see the actual projects"). That folder is where one chat
// runs, not a place anyone chose, and listing each one put a dozen rows named
// `pool-01` and `chat-k_iq` beside the real projects. Such a chat files under
// the project its worktree was cut from — the same rule the sidebar and the
// local picker follow (`workspaceProjectRootOf`) — and the project's existing
// worktrees stay one pick away in `RemoteWorktreePicker`. A worktree outside
// that container is a checkout the person made and keeps its own row. The
// chats started without a project are not a project either, and are dropped.

/** One project on a paired machine: a folder, and the chats standing in it. */
export type RemoteProject = {
  /** Stable across reads: the normalised folder path. */
  key: string
  /** The folder's own name — what the sidebar would call the project here. */
  name: string
  folderPath: string
  /** The repository the machine read off the folder, for the row's hue. Null when it could not. */
  repository: RepositoryIdentity | null
  /**
   * The workspace this project is asked about with — `workspace.checkout` is
   * keyed by workspace id, and every chat in one folder answers for the folder.
   * Chosen by lowest id so a re-read does not move it.
   */
  workspaceId: string
  /** The machine's open chats in this project, its app-made worktrees' included. */
  conversationCount: number
}

function normalizeFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '')
}

/** The folder's last segment, the way the sidebar names a project. */
function folderName(folderPath: string): string {
  const normalized = normalizeFolder(folderPath)
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}

/**
 * The project a chat over there files under, as a folder path: its own folder,
 * or the checkout an app-made worktree was cut from. Null for a chat with no
 * folder and for one started without a project.
 */
function projectFolderOf(folderPath: string | null | undefined): string | null {
  if (!folderPath) return null
  const project = workspaceProjectRootOf({ folderPath })
  if (!project || isProjectlessChatsRoot(project)) return null
  return project
}

function folderKey(folderPath: string): string {
  return normalizeFolder(folderPath).toLowerCase()
}

/**
 * The machine's projects, in name order.
 *
 * A workspace with no folder is not a project and is dropped: there is nowhere
 * for a new chat to run in it, and a "No folder" row in a list whose only job
 * is picking a folder is a row that cannot be chosen.
 *
 * The seat is a chat standing in the project's own folder when there is one,
 * so the checkout read and the launch are about the project rather than one
 * chat's worktree. A project open over there only through worktree chats is
 * still listed, under its own name and path, seated on the lowest of those.
 */
export function remoteProjectsOf(workspaces: readonly MeshWorkspace[]): RemoteProject[] {
  const byFolder = new Map<string, RemoteProject>()
  // Whether each project's seat stands in the project's own folder.
  const seatInProject = new Map<string, boolean>()
  for (const workspace of workspaces) {
    const ownFolder = workspace.folderPath?.trim()
    const folderPath = projectFolderOf(ownFolder)
    if (!ownFolder || !folderPath) continue
    const key = folderKey(folderPath)
    const inProject = folderKey(ownFolder) === key
    const existing = byFolder.get(key)
    if (!existing) {
      byFolder.set(key, {
        key,
        name: folderName(folderPath),
        folderPath,
        repository: workspace.repository,
        workspaceId: workspace.id,
        conversationCount: 1,
      })
      seatInProject.set(key, inProject)
      continue
    }
    existing.conversationCount += 1
    // A chat in the project's own folder takes the seat from a worktree chat;
    // between two of a kind, the lowest id wins, so the project keeps asking
    // about the same workspace across reads. The repository is taken from
    // whichever chat could answer — a machine that read the remote for one
    // chat in a project read it for the project.
    const seated = seatInProject.get(key) === true
    if ((inProject && !seated) || (inProject === seated && workspace.id < existing.workspaceId)) {
      existing.workspaceId = workspace.id
      // The project's own chat spells its path the way that machine does.
      if (inProject) existing.folderPath = ownFolder
      seatInProject.set(key, inProject)
    }
    if (!existing.repository && workspace.repository) existing.repository = workspace.repository
  }
  return [...byFolder.values()].sort((a, b) => a.name.localeCompare(b.name) || a.folderPath.localeCompare(b.folderPath))
}

/** The project a picked workspace id belongs to, or null when the read no longer holds it. */
export function remoteProjectOfWorkspace(
  projects: readonly RemoteProject[],
  workspaces: readonly MeshWorkspace[],
  workspaceId: string,
): RemoteProject | null {
  const workspace = workspaces.find((entry) => entry.id === workspaceId)
  const folderPath = projectFolderOf(workspace?.folderPath?.trim())
  if (!folderPath) return null
  const key = folderKey(folderPath)
  return projects.find((project) => project.key === key) ?? null
}
