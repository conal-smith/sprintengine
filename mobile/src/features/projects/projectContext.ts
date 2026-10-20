import { normalizeBacklogWorkspaces } from "../backlog/backlogLogic";

// ---------------------------------------------------------------------------
// The app's one answer to "which project am I in".
//
// A project is the *repo*. The wire's `backlog` collection carries one group per
// repo the desktop has open, and that is what this module turns into the
// project list.
//
// It used to join a second collection, `workspaces`, onto the same repos, on the
// `projectKey` token the desktop stamps on every collection. The
// desktop sent `workspaces` empty from the day its Switchboard and Watchtower
// modules were retired (2026-09-08), so the list was already built from
// `backlog` alone; protocol v4 took the collection off the wire, and the join,
// the per-project workspace kinds and ids went with it.
//
// `projectKey` is still the key when the desktop sends one. A desktop from
// before `projectKey` sends none, and the key falls back to the path.
//
// Kept free of react-native imports so `node --test` can pin it.
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  /** Stable identity: the desktop's `projectKey`, or the normalised workspace path. */
  key: string;
  /** The repo path as the desktop sent it; what rides the wire back on a command. */
  workspacePath: string;
  name: string;
  backlogItemCount: number;
}

/**
 * The join key for a repo path.
 *
 * Used only when the desktop sends no `projectKey`. Trailing slashes are
 * stripped, because nothing on the wire guarantees two desktop code paths agree
 * on one: `/repo/foo/` and `/repo/foo` are the same repo.
 *
 * This is the key only. `ProjectSummary.workspacePath` keeps the exact string the
 * desktop sent, because that is what rides the wire back on a command and what
 * the backlog collection is matched on.
 */
export function projectKeyForPath(path: string): string {
  return normalizePathKey(path);
}

/** A readable name for a key whose project is not in the current snapshot. */
export function projectNameForKey(key: string): string {
  return lastPathSegment(key) || key;
}

/** Every project the paired desktop reports: one per `backlog` group. */
export function buildProjectList(snapshot: { backlog?: unknown } | null | undefined): ProjectSummary[] {
  const projects = new Map<string, ProjectSummary>();

  for (const group of normalizeBacklogWorkspaces(snapshot?.backlog)) {
    const key = group.projectKey || projectKeyForPath(group.workspacePath);
    // Two groups for one repo (a trailing-slash difference between desktop code
    // paths) are one project; their items add up.
    const existing = projects.get(key);
    projects.set(key, {
      key,
      workspacePath: group.workspacePath,
      name: group.workspaceName,
      backlogItemCount: (existing?.backlogItemCount ?? 0) + group.items.length,
    });
  }

  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export function findProject(projects: ProjectSummary[], key: string | null): ProjectSummary | null {
  return key ? projects.find((project) => project.key === key) ?? null : null;
}

/**
 * The project the app is in.
 *
 * Normally the user's stored pick. A stored project can vanish mid-session (the
 * repo is closed on the desktop, a different desktop is paired), and then the
 * cold-start heuristic applies: the first project carrying backlog items, else
 * the first project at all — the rule the Backlog tab used locally before the
 * choice was global, kept as the fallback rather than as the rule.
 *
 * `fallenBackKey` is what makes that fallback *stick*. Once the app has fallen
 * back to a project and the user has started working in it, a 20-second poll that
 * brings the stored project back must not silently yank them out of it — so a
 * live fallback outranks the stored key. It is session-only and is never
 * persisted: the user's actual choice stays on disk, so the next launch (or the
 * other desktop) still restores what they picked. Selecting a project clears it.
 */
export function resolveCurrentProject(
  projects: ProjectSummary[],
  selectedKey: string | null,
  fallenBackKey: string | null = null,
): ProjectSummary | null {
  if (projects.length === 0) {
    return null;
  }
  const fallen = findProject(projects, fallenBackKey);
  if (fallen) {
    return fallen;
  }
  const picked = findProject(projects, selectedKey);
  if (picked) {
    return picked;
  }
  return projects.find((project) => project.backlogItemCount > 0) ?? projects[0];
}

/** 0 for the current project, 1 for a starred one, 2 for the rest. */
export function projectRank(key: string | null, currentKey: string | null, starredKeys: string[]): number {
  if (key && key === currentKey) {
    return 0;
  }
  if (key && starredKeys.includes(key)) {
    return 1;
  }
  return 2;
}

export interface ProjectSwitcherRow {
  key: string;
  name: string;
  starred: boolean;
  /** False when the key is starred but its project is not in this snapshot. */
  available: boolean;
  /** Null exactly when `available` is false. */
  project: ProjectSummary | null;
}

/**
 * The switcher's two lists: starred projects pinned above everything else, then
 * the rest.
 *
 * A starred project that has vanished from the snapshot keeps its row rather than
 * disappearing — the star is the user's, and silently dropping it would read as
 * the app having forgotten. It is rendered unavailable (not selectable) and can
 * still be unstarred.
 */
export function buildProjectSwitcherRows(
  projects: ProjectSummary[],
  starredKeys: string[],
): { starred: ProjectSwitcherRow[]; others: ProjectSwitcherRow[] } {
  const starred: ProjectSwitcherRow[] = [];
  const others: ProjectSwitcherRow[] = [];

  for (const project of projects) {
    const row: ProjectSwitcherRow = {
      key: project.key,
      name: project.name,
      starred: starredKeys.includes(project.key),
      available: true,
      project,
    };
    (row.starred ? starred : others).push(row);
  }

  for (const key of starredKeys) {
    if (!projects.some((project) => project.key === key)) {
      starred.push({ key, name: projectNameForKey(key), starred: true, available: false, project: null });
    }
  }

  // Starred rows follow the star order the user built them in; unavailable ones
  // sink so a missing repo never leads the list.
  starred.sort((a, b) => {
    if (a.available !== b.available) {
      return a.available ? -1 : 1;
    }
    return starredKeys.indexOf(a.key) - starredKeys.indexOf(b.key);
  });

  return { starred, others };
}

/** Star/unstar, preserving the order stars were added in. */
export function toggleStarredProjectKey(starredKeys: string[], key: string): string[] {
  return starredKeys.includes(key) ? starredKeys.filter((candidate) => candidate !== key) : [...starredKeys, key];
}

/** The one muted line under a project's name: what it holds. */
export function projectMetaLine(project: ProjectSummary): string {
  return project.backlogItemCount === 1 ? "1 item" : `${project.backlogItemCount} items`;
}




/** Trim, and drop trailing slashes: `/repo/foo/` and `/repo/foo` are one repo. */
function normalizePathKey(path: string): string {
  return path.trim().replace(/\/+$/u, "");
}

function lastPathSegment(path: string): string {
  const cleaned = normalizePathKey(path);
  return cleaned.split("/").filter(Boolean).at(-1) ?? cleaned;
}
