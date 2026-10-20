/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// A chat in one of a project's worktrees files under the project, as the
// desktop's sidebar files it: by the recorded root where the desktop sends
// one, else by the container its worktrees are cut under.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  WORKTREE_CONTAINER_DIR,
  projectFolderOf,
  repoRootFromWorktreePath,
  workspaceProject,
} = require(path.join(buildRoot, "src/features/projects/worktreeProjectLogic.js"));

test("a path in a worktree container names the checkout it was cut from", () => {
  assert.equal(WORKTREE_CONTAINER_DIR, ".sprintengine-worktrees");
  assert.equal(repoRootFromWorktreePath("/Users/dev/code/.sprintengine-worktrees/multicode/pool-02"), "/Users/dev/code/multicode");
  assert.equal(repoRootFromWorktreePath("/Users/dev/code/.sprintengine-worktrees/multicode/chat-ab12/"), "/Users/dev/code/multicode");
  // A slug may hold a "/": everything past the repo is the slug.
  assert.equal(repoRootFromWorktreePath("/u/.sprintengine-worktrees/app/agent/fix-1"), "/u/app");
  // A Windows path keeps its separators.
  assert.equal(repoRootFromWorktreePath("C:\\work\\.sprintengine-worktrees\\app\\pool-01"), "C:\\work\\app");
  // Not in a container, or no slug under the repo: not a worktree of anything.
  assert.equal(repoRootFromWorktreePath("/Users/dev/code/multicode"), null);
  assert.equal(repoRootFromWorktreePath("/u/.sprintengine-worktrees/app"), null);
  assert.equal(repoRootFromWorktreePath(".sprintengine-worktrees/app/x"), null);
});

test("a worktree cut from a worktree files under the real project, and the desktop's record wins", () => {
  // pool-01's own container sits beside it: <parent>/.sprintengine-worktrees/pool-01.
  assert.equal(projectFolderOf("/u/.sprintengine-worktrees/app/.sprintengine-worktrees/pool-01/chat-1"), "/u/app");
  assert.equal(projectFolderOf("/elsewhere/feature-x", "/u/app"), "/u/app");
  assert.equal(projectFolderOf("/u/app"), "/u/app");
  assert.equal(projectFolderOf(null), null);
  assert.equal(projectFolderOf("  "), null);
});

test("a workspace says its project's folder and name, and its worktree's name when it is one", () => {
  assert.deepEqual(workspaceProject({ folderPath: "/Users/dev/code/.sprintengine-worktrees/multicode/pool-02" }), {
    projectFolder: "/Users/dev/code/multicode",
    projectName: "multicode",
    worktree: "pool-02",
  });
  assert.deepEqual(workspaceProject({ folderPath: "/Users/dev/code/multicode/" }), {
    projectFolder: "/Users/dev/code/multicode/",
    projectName: "multicode",
    worktree: null,
  });
  // A worktree made outside the container is known only by the desktop's record.
  assert.deepEqual(workspaceProject({ folderPath: "/tmp/wt/fix-login", recordedRoot: "/Users/dev/app" }), {
    projectFolder: "/Users/dev/app",
    projectName: "app",
    worktree: "fix-login",
  });
  assert.deepEqual(workspaceProject({ folderPath: null }), { projectFolder: null, projectName: null, worktree: null });
});
