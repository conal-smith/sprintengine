// Which project a desktop workspace's folder belongs to, so a chat in one of
// the project's worktrees files under the project rather than under the
// worktree's own folder. Pure, so `node --test` pins the rule.
//
// New on the desktop starts a chat in a worktree of its own by default, cut
// from a pool (`pool-02`) or named for the chat (`chat-ab12`). Grouped by
// folder, every such chat founded a project of its own named after the slug.
// The desktop files them under the checkout they were cut from: by the
// workspace's recorded `worktree.repoRoot` where it has one, else by the path
// convention its worktrees are cut under,
// `<parent>/.sprintengine-worktrees/<repo>/<slug>`, whose project is
// `<parent>/<repo>` (`workspaceProjectRootOf` there). Its `workspace.list`
// does not send the recorded root today, so the phone reads the convention,
// which holds for every worktree the desktop cuts itself, and takes the
// recorded root too should a desktop send it.

/** The directory every worktree container sits under, as the desktop names it. */
export const WORKTREE_CONTAINER_DIR = ".sprintengine-worktrees";

/**
 * The checkout a path inside a worktree container was cut from, or null for
 * a path in no container. Anything past `<repo>` is the worktree's slug, which
 * may itself hold a "/", and is dropped. The desktop's `repoRootFromWorktreePath`.
 */
export function repoRootFromWorktreePath(path: string): string | null {
  const trimmed = trimPath(path);
  const segments = trimmed.split(/[\\/]/u);
  const marker = segments.lastIndexOf(WORKTREE_CONTAINER_DIR);
  // Nothing before the marker is no parent to rebuild from; fewer than three
  // segments from it is no `<repo>` with a slug under it.
  if (marker < 1 || segments.length - marker < 3) return null;
  return [...segments.slice(0, marker), segments[marker + 1]].join(separatorOf(trimmed));
}

/**
 * The project folder a workspace files under: the recorded root where the
 * desktop sent one, else its own folder, peeled out of every container it
 * sits in, so a worktree cut from a worktree files under the real project.
 * Bounded, since it runs on strings off the wire.
 */
export function projectFolderOf(folderPath: string | null, recordedRoot?: string | null): string | null {
  const folder = folderPath?.trim() || null;
  if (!folder) return null;
  let current = recordedRoot?.trim() || folder;
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = repoRootFromWorktreePath(current);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/**
 * What a workspace's folder says about its project: the project's folder and
 * name, and the worktree's own name when the folder is one of the project's
 * worktrees rather than the project itself ("pool-02" under "multicode").
 */
export function workspaceProject(input: {
  folderPath: string | null;
  recordedRoot?: string | null;
}): { projectFolder: string | null; projectName: string | null; worktree: string | null } {
  const projectFolder = projectFolderOf(input.folderPath, input.recordedRoot);
  if (!projectFolder || !input.folderPath) return { projectFolder: null, projectName: null, worktree: null };
  const own = comparablePath(input.folderPath) !== comparablePath(projectFolder);
  return {
    projectFolder,
    projectName: lastPathSegment(projectFolder),
    worktree: own ? lastPathSegment(input.folderPath) : null,
  };
}

/** A path as two spellings of one folder compare: forward slashes, no trailing one, lower case. */
export function comparablePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
}

/** The folder's own name, which is what a person calls it. */
export function lastPathSegment(path: string | null): string | null {
  if (!path) return null;
  const segment = trimPath(path).split(/[\\/]/u).pop();
  return segment || null;
}

function trimPath(path: string): string {
  return path.replace(/[\\/]+$/u, "");
}

/** A Windows path keeps its backslashes; anything with a "/" is joined with one. */
function separatorOf(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}
