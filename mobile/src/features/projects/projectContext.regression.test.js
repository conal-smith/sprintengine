/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  buildProjectList,
  buildProjectSwitcherRows,
  findProject,
  projectMetaLine,
  projectNameForKey,
  projectRank,
  resolveCurrentProject,
  toggleStarredProjectKey,
} = require(path.join(buildRoot, "src/features/projects/projectContext.js"));

const backlogGroup = (overrides = {}) => ({
  workspaceId: "ws_1",
  workspacePath: "/repos/alpha",
  workspaceName: "Alpha",
  items: [{ relativePath: "backlog/one.md", title: "One", status: "idea" }],
  ...overrides,
});

// --- Building the list --------------------------------------------------------
//
// A project is a `backlog` group. This section used to test a join of that
// collection with `workspaces` — on path, then on `projectKey` once it was found that
// the path join split every real repo in two. The desktop sent `workspaces`
// empty from 2026-09-08 and protocol v4 took it off the wire, so the join, the
// workspace kinds and the pathless-workspace projects are gone with it.

test("a backlog group is a project, named by the desktop", () => {
  const projects = buildProjectList({ backlog: [backlogGroup()] });

  assert.equal(projects.length, 1);
  assert.equal(projects[0].key, "/repos/alpha");
  assert.equal(projects[0].workspacePath, "/repos/alpha");
  assert.equal(projects[0].name, "Alpha");
  assert.equal(projects[0].backlogItemCount, 1);
  assert.deepEqual(Object.keys(projects[0]).sort(), ["backlogItemCount", "key", "name", "workspacePath"]);
});

// The shape the desktop actually sends: its snapshot sanitizer replaces the
// absolute path with a hashed token and stamps the same token as `projectKey`.
test("the desktop's projectKey is the key, and the token is the path that rides back", () => {
  const token = "ws_9f8e7d6c5b4a";
  const projects = buildProjectList({
    backlog: [backlogGroup({ workspaceId: `backlog:${token}`, projectKey: token, workspacePath: token, workspaceName: "multicode" })],
  });

  assert.equal(projects.length, 1);
  assert.equal(projects[0].key, token);
  assert.equal(projects[0].workspacePath, token);
  assert.equal(projects[0].name, "multicode");
});

test("a desktop that sends no projectKey is keyed on the path, trailing slash and all", () => {
  const projects = buildProjectList({
    backlog: [
      backlogGroup({ workspacePath: "/repos/alpha/" }),
      backlogGroup({ workspacePath: "/repos/alpha", items: [{ relativePath: "backlog/two.md", title: "Two", status: "idea" }] }),
    ],
  });

  assert.equal(projects.length, 1, "/repos/alpha/ and /repos/alpha are the same repo");
  assert.equal(projects[0].key, "/repos/alpha");
  assert.equal(projects[0].backlogItemCount, 2, "the two groups' items add up");
  // The exact string the desktop sent is kept, because that is what rides the wire.
  assert.equal(projects[0].workspacePath, "/repos/alpha");
});

// `sprintEngines` (off the wire at v3) and `workspaces` and `roadmaps` (off at
// v4) could each once mint or feed a project. A payload still carrying one must
// be ignored, not throw and not conjure a project the switcher cannot open.
test("collections that left the wire mint no project", () => {
  const retired = {
    sprintEngines: [{ sprintEngineId: "se_1", workspacePath: "/repos/beta" }],
    workspaces: [{ workspaceId: "ws_1", kind: "switchboard", name: "Board", workspacePath: "/repos/gamma" }],
    roadmaps: [{ roadmapId: "r", name: "R", projectKey: "ws_delta", lanes: [] }],
  };
  assert.deepEqual(buildProjectList(retired), []);

  const withBacklog = buildProjectList({ ...retired, backlog: [backlogGroup()] });
  assert.deepEqual(withBacklog.map((project) => project.key), ["/repos/alpha"]);
});

test("a garbage wire shape yields no projects rather than throwing", () => {
  assert.deepEqual(buildProjectList(null), []);
  assert.deepEqual(buildProjectList(undefined), []);
  assert.deepEqual(buildProjectList({ workspaces: "nope", backlog: 7, sprintEngines: {} }), []);
  assert.deepEqual(buildProjectList({ backlog: ["junk", null, {}] }), []);
});

// --- Resolving the current project ------------------------------------------

test("the stored project wins when it is still in the snapshot", () => {
  const projects = buildProjectList({
    backlog: [backlogGroup({ workspacePath: "/repos/alpha", workspaceName: "Alpha" }), backlogGroup({ workspacePath: "/repos/beta", workspaceName: "Beta" })],
  });

  assert.equal(resolveCurrentProject(projects, "/repos/beta").key, "/repos/beta");
});

test("a stored project that has vanished falls back to the cold-start heuristic", () => {
  const projects = buildProjectList({
    backlog: [
      backlogGroup({ workspacePath: "/repos/empty", workspaceName: "Empty", items: [] }),
      backlogGroup({ workspacePath: "/repos/withitems", workspaceName: "With items" }),
    ],
  });

  // Not "/repos/gone" — that desktop is not paired any more. The fallback is the
  // first project carrying backlog items, which is the pre-epic heuristic.
  const resolved = resolveCurrentProject(projects, "/repos/gone");
  assert.equal(resolved.key, "/repos/withitems");
  assert.equal(resolved.backlogItemCount, 1);
});

test("a fallback sticks, so a returning project cannot yank the user out mid-session", () => {
  const withoutStored = buildProjectList({
    backlog: [backlogGroup({ workspacePath: "/repos/beta", workspaceName: "Beta" })],
  });
  // The stored project has dropped out of the snapshot; the app falls back.
  const fallen = resolveCurrentProject(withoutStored, "/repos/alpha", null);
  assert.equal(fallen.key, "/repos/beta");

  // A 20s poll brings /repos/alpha back while the user is working in Beta. The
  // remembered fallback outranks the stored key, so nothing moves under them.
  const withStoredBack = buildProjectList({
    backlog: [
      backlogGroup({ workspacePath: "/repos/alpha", workspaceName: "Alpha" }),
      backlogGroup({ workspacePath: "/repos/beta", workspaceName: "Beta" }),
    ],
  });
  assert.equal(resolveCurrentProject(withStoredBack, "/repos/alpha", "/repos/beta").key, "/repos/beta");

  // The fallback is session-only and never persisted, so once it is cleared (an
  // explicit pick, a desktop switch, a relaunch) the stored choice rules again.
  assert.equal(resolveCurrentProject(withStoredBack, "/repos/alpha", null).key, "/repos/alpha");
});

test("with nothing stored and nothing carrying items, the first project is current", () => {
  const projects = buildProjectList({ backlog: [backlogGroup({ workspacePath: "/repos/only", items: [] })] });
  assert.equal(resolveCurrentProject(projects, null).key, "/repos/only");
});

test("no projects means no current project", () => {
  assert.equal(resolveCurrentProject([], "/repos/alpha"), null);
  assert.equal(findProject([], "/repos/alpha"), null);
});

// --- Stars ------------------------------------------------------------------

test("starring toggles, and preserves the order stars were added in", () => {
  let starred = [];
  starred = toggleStarredProjectKey(starred, "/repos/a");
  starred = toggleStarredProjectKey(starred, "/repos/b");
  assert.deepEqual(starred, ["/repos/a", "/repos/b"]);

  starred = toggleStarredProjectKey(starred, "/repos/a");
  assert.deepEqual(starred, ["/repos/b"]);
});

test("starred projects pin above the rest in the switcher", () => {
  const projects = buildProjectList({
    backlog: [
      backlogGroup({ workspacePath: "/repos/alpha", workspaceName: "Alpha" }),
      backlogGroup({ workspacePath: "/repos/beta", workspaceName: "Beta" }),
      backlogGroup({ workspacePath: "/repos/gamma", workspaceName: "Gamma" }),
    ],
  });

  const { starred, others } = buildProjectSwitcherRows(projects, ["/repos/gamma"]);

  assert.deepEqual(starred.map((row) => row.key), ["/repos/gamma"]);
  assert.deepEqual(others.map((row) => row.key), ["/repos/alpha", "/repos/beta"]);
  assert.equal(starred[0].starred, true);
  assert.equal(others[0].starred, false);
});

test("a starred project missing from the snapshot keeps its row, marked unavailable", () => {
  const projects = buildProjectList({ backlog: [backlogGroup({ workspacePath: "/repos/alpha", workspaceName: "Alpha" })] });

  const { starred } = buildProjectSwitcherRows(projects, ["/repos/alpha", "/repos/moved-away"]);

  assert.equal(starred.length, 2);
  // Available rows lead; the missing repo sinks rather than heading the list.
  assert.equal(starred[0].key, "/repos/alpha");
  assert.equal(starred[0].available, true);
  assert.equal(starred[1].key, "/repos/moved-away");
  assert.equal(starred[1].available, false);
  assert.equal(starred[1].project, null);
  // It still has a name to render, and it is still starred, so it can be unstarred.
  assert.equal(starred[1].name, "moved-away");
  assert.equal(starred[1].starred, true);
});

test("a key renders as its last path segment", () => {
  assert.equal(projectNameForKey("/repos/alpha"), "alpha");
  assert.equal(projectNameForKey("/repos/alpha/"), "alpha");
  assert.equal(projectNameForKey("ws_9f8e7d6c5b4a"), "ws_9f8e7d6c5b4a");
});

test("rank puts the current project first, then starred, then the rest", () => {
  assert.equal(projectRank("/repos/a", "/repos/a", ["/repos/b"]), 0);
  assert.equal(projectRank("/repos/b", "/repos/a", ["/repos/b"]), 1);
  assert.equal(projectRank("/repos/c", "/repos/a", ["/repos/b"]), 2);
  // The current project outranks its own star rather than double-counting.
  assert.equal(projectRank("/repos/a", "/repos/a", ["/repos/a"]), 0);
  assert.equal(projectRank(null, "/repos/a", []), 2);
});

// --- Presentation -----------------------------------------------------------

test("the project meta line counts the project's backlog items", () => {
  const [one] = buildProjectList({ backlog: [backlogGroup()] });
  assert.equal(projectMetaLine(one), "1 item");

  const [none] = buildProjectList({ backlog: [backlogGroup({ items: [] })] });
  assert.equal(projectMetaLine(none), "0 items");
});
