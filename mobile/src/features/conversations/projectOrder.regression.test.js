const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  PROJECT_PICKS_LIMIT,
  normalizeProjectPicks,
  pickableProjects,
  projectFolderKey,
  recordProjectPick,
} = require("../../../.mobile-test-build/src/features/conversations/conversationListLogic.js");
const { createTailnetWorkspacesApi } = require("../../../.mobile-test-build/src/api/tailnetWorkspaces.js");

// Step one of New lists the projects used most first, in
// the order New chat on the desktop lists them. The desktop counts the uses and
// sends each folder's score on `workspace.list`; a desktop that sends none is
// ordered by this phone's own picks; never-used projects stay alphabetical.

const NOW = Date.UTC(2026, 9, 6, 12);
const DAY = 24 * 60 * 60 * 1000;

const row = (workspaceId, folderPath, extra = {}) => ({
  workspaceId,
  folderPath,
  projectName: folderPath.split("/").filter(Boolean).at(-1),
  ...extra,
});

const names = (projects) => projects.map((project) => project.projectName);

test("the desktop's score orders the projects, the highest first, and never-used ones stay alphabetical below", () => {
  const projects = pickableProjects([
    row("ws-1", "/Users/dev/alpha", { projectFrecency: 0, projectLastUsedAt: null }),
    row("ws-2", "/Users/dev/zulu", { projectFrecency: 3.2, projectLastUsedAt: NOW - DAY }),
    row("ws-3", "/Users/dev/mike", { projectFrecency: 0, projectLastUsedAt: null }),
    row("ws-4", "/Users/dev/kilo", { projectFrecency: 1.1, projectLastUsedAt: NOW }),
    row("ws-5", "/Users/dev/bravo", { projectFrecency: 0, projectLastUsedAt: null }),
  ]);
  assert.deepEqual(names(projects), ["zulu", "kilo", "alpha", "bravo", "mike"]);
  assert.equal(projects[0].frecency, 3.2);
});

test("a tie on the score goes to the later use, then to the alphabet", () => {
  const projects = pickableProjects([
    row("ws-1", "/Users/dev/alpha", { projectFrecency: 1, projectLastUsedAt: NOW - DAY }),
    row("ws-2", "/Users/dev/bravo", { projectFrecency: 1, projectLastUsedAt: NOW }),
    row("ws-3", "/Users/dev/charlie", { projectFrecency: 1, projectLastUsedAt: NOW }),
  ]);
  assert.deepEqual(names(projects), ["bravo", "charlie", "alpha"]);
});

test("every chat in a folder answers for it: the folder takes the highest score any of its rows carries", () => {
  const projects = pickableProjects([
    row("ws-7", "/Users/dev/wingfoil", { projectFrecency: 0.4, projectLastUsedAt: NOW - DAY }),
    row("ws-3", "/Users/dev/wingfoil/", { projectFrecency: 0.5, projectLastUsedAt: NOW }),
    row("ws-9", "/Users/dev/acme", { projectFrecency: 0.45, projectLastUsedAt: NOW }),
  ]);
  assert.deepEqual(
    projects.map((project) => [project.projectName, project.workspaceId, project.frecency]),
    [
      ["wingfoil", "ws-3", 0.5],
      ["acme", "ws-9", 0.45],
    ],
  );
});

test("a desktop that sends no score is ordered by this phone's own picks, the latest first", () => {
  const rows = [row("ws-1", "/Users/dev/alpha"), row("ws-2", "/Users/dev/bravo"), row("ws-3", "/Users/dev/charlie")];
  assert.deepEqual(names(pickableProjects(rows)), ["alpha", "bravo", "charlie"], "no picks: the alphabet");
  let picks = recordProjectPick({}, "desk-1", projectFolderKey("/Users/dev/charlie"), NOW - DAY);
  picks = recordProjectPick(picks, "desk-1", projectFolderKey("/Users/dev/bravo/"), NOW);
  picks = recordProjectPick(picks, "desk-2", projectFolderKey("/Users/dev/alpha"), NOW);
  assert.deepEqual(names(pickableProjects(rows, picks["desk-1"])), ["bravo", "charlie", "alpha"]);
  assert.deepEqual(names(pickableProjects(rows, picks["desk-2"])), ["alpha", "bravo", "charlie"], "picks are per desktop");
});

test("the desktop's score wins over this phone's picks when it is sent", () => {
  const rows = [
    row("ws-1", "/Users/dev/alpha", { projectFrecency: 2, projectLastUsedAt: NOW }),
    row("ws-2", "/Users/dev/bravo", { projectFrecency: 0, projectLastUsedAt: null }),
  ];
  const picks = recordProjectPick({}, "desk-1", projectFolderKey("/Users/dev/bravo"), NOW);
  assert.deepEqual(names(pickableProjects(rows, picks["desk-1"])), ["alpha", "bravo"]);
});

test("only the latest picks are remembered, and stored picks are read fail-soft", () => {
  let picks = {};
  for (let i = 0; i <= PROJECT_PICKS_LIMIT; i += 1) picks = recordProjectPick(picks, "desk-1", `/p${i}`, NOW + i);
  assert.equal(Object.keys(picks["desk-1"]).length, PROJECT_PICKS_LIMIT);
  assert.equal(picks["desk-1"]["/p0"], undefined, "the oldest pick fell off");
  assert.deepEqual(normalizeProjectPicks({ "desk-1": { "/a": NOW, "/b": "soon" }, "desk-2": [1], "": {} }), {
    "desk-1": { "/a": NOW },
  });
  assert.deepEqual(normalizeProjectPicks("nope"), {});
});

test("workspace.list's usage fields are read when sent and left off when not", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      jsonrpc: "2.0",
      id: "ws-1",
      result: {
        structuredContent: {
          ok: true,
          workspaces: [
            { id: "ws-new", name: "Chat", folderPath: "/Users/dev/app", projectFrecency: 1.5, projectLastUsedAt: new Date(NOW).toISOString() },
            { id: "ws-never", name: "Chat", folderPath: "/Users/dev/notes", projectFrecency: 0, projectLastUsedAt: null },
            { id: "ws-old", name: "Chat", folderPath: "/Users/dev/old" },
            { id: "ws-bad", name: "Chat", folderPath: "/Users/dev/bad", projectFrecency: "lots" },
          ],
        },
      },
    }),
  });
  try {
    const api = createTailnetWorkspacesApi({ baseUrl: "http://mac-mini.tail1234.ts.net:7420", deviceToken: "token" });
    const listed = await api.listWorkspaces();
    assert.equal(listed.ok, true);
    const byId = Object.fromEntries(listed.data.map((workspace) => [workspace.workspaceId, workspace]));
    assert.equal(byId["ws-new"].projectFrecency, 1.5);
    assert.equal(byId["ws-new"].projectLastUsedAt, NOW);
    assert.equal(byId["ws-never"].projectFrecency, 0);
    assert.equal(byId["ws-never"].projectLastUsedAt, null);
    assert.equal("projectFrecency" in byId["ws-old"], false, "an older desktop sends none");
    assert.equal("projectFrecency" in byId["ws-bad"], false, "a score that is not a number is no score");
  } finally {
    globalThis.fetch = realFetch;
  }
});
