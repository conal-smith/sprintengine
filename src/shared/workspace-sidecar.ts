/**
 * The folder older builds kept the app's per-project state in, inside the
 * project: `<project>/.sprintengine/` (transcripts, the backlog's config and
 * link cache, browser captures, module storage). That state now lives in the
 * project's store in the person's home (main/workspace-store.ts), and the
 * store's one-time move empties this folder. The name stays known so the
 * move can find it, and so what still reads a checkout (worktree keep checks,
 * checkpoints, the pull request's change count, the file watcher) keeps
 * treating one an older build left, or a newer build has not moved yet, as
 * the app's rather than the person's.
 */
export const SIDECAR_DIR_NAME = '.sprintengine'
