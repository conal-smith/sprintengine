/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  backlogCreateCriticalityOptions,
  backlogCreateDifficultyOptions,
  backlogCreateTitleMaxChars,
  backlogCreateTypeOptions,
  backlogStatusLabel,
  backlogStatusTone,
  buildBacklogCreatePayload,
  normalizeBacklogWorkspaces,
  selectBacklogCreateWorkspaces,
  selectBacklogEmptyState,
  triageSummary,
  matchesBacklogView,
  compareBacklogItems,
  toTriageable,
  selectBacklogRows,
  groupBacklogByEpic,
  epicColor,
  epicColorFromSlug,
  normalizeBacklogEpics,
  backlogHighlightColors,
  backlogViewOptions,
  backlogSortOptions,
  backlogSortLabel,
  backlogGroupOptions,
} = require(path.join(buildRoot, "src/features/backlog/backlogLogic.js"));

test("normalizeBacklogWorkspaces accepts desktop-shaped backlog snapshots", () => {
  const workspaces = normalizeBacklogWorkspaces([
    {
      workspaceId: "backlog:/work/app",
      workspacePath: "/work/app",
      workspaceName: "app",
      updatedAt: "2026-06-11T00:00:00Z",
      items: [
        {
          itemId: "backlog_1",
          relativePath: "backlog/2026-06-11-widget.md",
          title: "Ship the widget",
          excerpt: "Users need the widget.",
          status: "ready",
          type: "feature",
          difficulty: "m",
          criticality: "high",
          updatedAt: "2026-06-11T00:00:00Z",
        },
      ],
    },
  ]);

  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].workspaceName, "app");
  assert.equal(workspaces[0].items.length, 1);
  const item = workspaces[0].items[0];
  assert.equal(item.title, "Ship the widget");
  assert.equal(item.status, "ready");
  assert.equal(item.workspacePath, "/work/app");
  assert.equal(item.workspaceName, "app");
});

test("normalizeBacklogWorkspaces tolerates malformed wire data without throwing", () => {
  assert.deepEqual(normalizeBacklogWorkspaces(undefined), []);
  assert.deepEqual(normalizeBacklogWorkspaces("nonsense"), []);
  assert.deepEqual(normalizeBacklogWorkspaces([null, 42, { items: [] }]), []);

  const workspaces = normalizeBacklogWorkspaces([
    {
      workspacePath: "/work/app",
      items: [
        { relativePath: "backlog/ok.md", status: "bogus-status", type: "bogus", difficulty: "huge" },
        { title: "missing path is dropped" },
        "not-an-object",
      ],
    },
  ]);

  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].workspaceName, "app");
  assert.equal(workspaces[0].items.length, 1);
  const item = workspaces[0].items[0];
  assert.equal(item.status, "idea", "unknown statuses fall back to idea");
  assert.equal(item.type, undefined, "unknown types are dropped");
  assert.equal(item.difficulty, undefined, "unknown difficulties are dropped");
  assert.equal(item.title, "ok.md", "missing titles fall back to the filename");
});

test("normalizeBacklogWorkspaces accepts spike as a backlog item type and renders it", () => {
  const workspaces = normalizeBacklogWorkspaces([
    {
      workspacePath: "/work/app",
      items: [{ relativePath: "backlog/probe.md", status: "ready", type: "spike" }],
    },
  ]);

  const item = workspaces[0].items[0];
  assert.equal(item.type, "spike", "spike is a recognized type and survives normalization");
  assert.equal(triageSummary({ type: "spike" }), "Spike", "spike renders in the triage summary");
});

test("normalizeBacklogWorkspaces accepts epic as a backlog item type and renders it", () => {
  const workspaces = normalizeBacklogWorkspaces([
    {
      workspacePath: "/work/app",
      items: [{ relativePath: "backlog/epics/mobile-premium-redesign.md", status: "in_progress", type: "epic" }],
    },
  ]);

  const item = workspaces[0].items[0];
  assert.equal(item.type, "epic", "epic is a recognized type and survives normalization");
  assert.equal(item.epic, undefined, "an epic container carries no up-pointing epic slug of its own");
  assert.equal(triageSummary({ type: "epic" }), "Epic", "epic renders in the triage summary");
});

test("normalizeBacklogWorkspaces passes the epic slug through when the snapshot carries it", () => {
  const workspaces = normalizeBacklogWorkspaces([
    {
      workspacePath: "/work/app",
      items: [
        { relativePath: "backlog/child.md", status: "ready", type: "feature", epic: " mobile-premium-redesign " },
        { relativePath: "backlog/orphan.md", status: "ready", type: "feature" },
        { relativePath: "backlog/blank.md", status: "ready", type: "feature", epic: "   " },
        { relativePath: "backlog/wrong-type.md", status: "ready", type: "feature", epic: 42 },
      ],
    },
  ]);

  const [child, orphan, blank, wrongType] = workspaces[0].items;
  assert.equal(child.epic, "mobile-premium-redesign", "the epic slug survives and is trimmed");
  assert.ok(!("epic" in orphan), "an item with no epic omits the field entirely");
  assert.ok(!("epic" in blank), "a whitespace-only epic is omitted, not passed through as empty");
  assert.ok(!("epic" in wrongType), "a non-string epic is dropped");
});

test("status labels and tones cover every backlog status", () => {
  for (const status of ["idea", "ready", "in_progress", "needs_input", "completed", "archived"]) {
    assert.equal(typeof backlogStatusLabel[status], "string");
    assert.ok(backlogStatusLabel[status].length > 0);
    assert.ok(["neutral", "success", "warning", "danger"].includes(backlogStatusTone(status)));
  }
  assert.equal(backlogStatusTone("needs_input"), "warning");
  assert.equal(backlogStatusTone("completed"), "success");
});

test("triageSummary renders only the present axes", () => {
  assert.equal(triageSummary({ type: "feature", difficulty: "m", criticality: "high" }), "Feature · M · High");
  assert.equal(triageSummary({ difficulty: "xl" }), "XL");
  assert.equal(triageSummary({}), "");
});

test("selectBacklogCreateWorkspaces offers every workspace, including empty ones, for the create picker", () => {
  const options = selectBacklogCreateWorkspaces([
    { workspaceId: "backlog:/work/app", workspacePath: "/work/app", workspaceName: "app", items: [] },
    {
      workspacePath: "/work/api",
      items: [{ relativePath: "backlog/x.md", status: "idea" }],
    },
    "garbage",
    { items: [] },
  ]);

  assert.equal(options.length, 2, "valid workspaces survive; malformed entries and pathless groups are dropped");
  assert.deepEqual(
    options.map((option) => option.workspacePath),
    ["/work/app", "/work/api"],
  );
  assert.equal(options[0].workspaceName, "app", "empty workspaces are still offered so the first item can be created");
  assert.equal(options[1].workspaceName, "api", "missing workspaceName falls back to the path's last segment");
});

test("buildBacklogCreatePayload requires a workspace and a title", () => {
  const noWorkspace = buildBacklogCreatePayload({ workspacePath: null, title: "Ship it", description: "" });
  assert.equal(noWorkspace.ok, false);
  assert.match(noWorkspace.error, /workspace/i);

  const blankWorkspace = buildBacklogCreatePayload({ workspacePath: "   ", title: "Ship it", description: "" });
  assert.equal(blankWorkspace.ok, false, "whitespace-only workspace is not a valid pick");

  const noTitle = buildBacklogCreatePayload({ workspacePath: "/work/app", title: "   ", description: "" });
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.error, /title/i);
});

test("buildBacklogCreatePayload trims fields and omits empty optionals", () => {
  const result = buildBacklogCreatePayload({
    workspacePath: " /work/app ",
    title: "  Add export button  ",
    description: "  Lets users download a CSV.  ",
    type: "feature",
    difficulty: "m",
    criticality: "high",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    workspacePath: "/work/app",
    title: "Add export button",
    description: "Lets users download a CSV.",
    type: "feature",
    difficulty: "m",
    criticality: "high",
  });

  const minimal = buildBacklogCreatePayload({ workspacePath: "/work/app", title: "Just a title", description: "   " });
  assert.equal(minimal.ok, true);
  assert.deepEqual(
    Object.keys(minimal.payload).sort(),
    ["title", "workspacePath"],
    "blank description and unset axes are omitted, not sent as empty strings",
  );
});

test("buildBacklogCreatePayload rejects an over-long title", () => {
  const result = buildBacklogCreatePayload({
    workspacePath: "/work/app",
    title: "x".repeat(backlogCreateTitleMaxChars + 1),
    description: "",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /characters/i);
});

test("create option lists cover the protocol axes and stay membership-valid", () => {
  assert.deepEqual([...backlogCreateTypeOptions], ["feature", "bug", "spike", "mockup"]);
  assert.deepEqual([...backlogCreateDifficultyOptions], ["xs", "s", "m", "l", "xl"]);
  assert.deepEqual([...backlogCreateCriticalityOptions], ["low", "normal", "high", "critical"]);
});

test("selectBacklogEmptyState distinguishes error, loading, and true-empty", () => {
  const errorState = selectBacklogEmptyState({ errorMessage: "The desktop did not answer.", isLoading: false });
  assert.equal(errorState.title, "Backlog unavailable");
  assert.equal(errorState.body, "The desktop did not answer.");

  const loadingState = selectBacklogEmptyState({ errorMessage: null, isLoading: true });
  assert.equal(loadingState.title, "Loading backlog");

  const emptyState = selectBacklogEmptyState({ errorMessage: null, isLoading: false });
  assert.equal(emptyState.title, "No backlog items");
  assert.ok(emptyState.body.length > 0);
});

// --- Triage: view / sort / group, ported from desktop backlogTriage.ts ---------

// A minimal Triageable matching the desktop test's shape, so the ported
// comparators/predicates can be asserted against the same expectations the
// desktop pins. Fields the mobile snapshot lacks (risk, createdAtMs) are set
// here to prove the port is faithful, not to imply the wire carries them.
function triageable(over) {
  return {
    status: "idea",
    modifiedAt: 0,
    createdAtMs: 0,
    relativePath: "backlog/x.md",
    isEpic: false,
    ...over,
  };
}

test("matchesBacklogView: terminal views and the structural epics lens", () => {
  const active = triageable({ status: "in_progress" });
  const done = triageable({ status: "completed" });
  const archived = triageable({ status: "archived" });
  const epicDone = triageable({ status: "completed", isEpic: true });

  assert.equal(matchesBacklogView(active, "all"), true);
  assert.equal(matchesBacklogView(done, "all"), true);

  assert.equal(matchesBacklogView(done, "completed"), true);
  assert.equal(matchesBacklogView(active, "completed"), false);
  assert.equal(matchesBacklogView(archived, "archived"), true);

  // active hides both terminal states
  assert.equal(matchesBacklogView(active, "active"), true);
  assert.equal(matchesBacklogView(done, "active"), false);
  assert.equal(matchesBacklogView(archived, "active"), false);

  // epics is evaluated before the terminal guard, so a completed epic still shows
  assert.equal(matchesBacklogView(epicDone, "epics"), true);
  assert.equal(matchesBacklogView(active, "epics"), false);
});

test("matchesBacklogView: triage presets span difficulty ranges", () => {
  const quickWin = triageable({ difficulty: "s", criticality: "critical" });
  const bet = triageable({ difficulty: "xl", criticality: "high" });
  const deferItem = triageable({ difficulty: "l", criticality: "low" });
  const unestimated = triageable({ difficulty: undefined, criticality: undefined });

  assert.equal(matchesBacklogView(quickWin, "quick_wins"), true);
  assert.equal(matchesBacklogView(bet, "quick_wins"), false);
  assert.equal(matchesBacklogView(bet, "strategic_bets"), true);
  assert.equal(matchesBacklogView(quickWin, "strategic_bets"), false);
  assert.equal(matchesBacklogView(deferItem, "defer"), true);
  assert.equal(matchesBacklogView(bet, "defer"), false);
  assert.equal(matchesBacklogView(unestimated, "unestimated"), true);
  assert.equal(matchesBacklogView(quickWin, "unestimated"), false);
});

test("compareBacklogItems: status sort ranks the worklist and tiebreaks on recency", () => {
  const items = [
    triageable({ status: "idea", modifiedAt: 100, relativePath: "a" }),
    triageable({ status: "needs_input", modifiedAt: 10, relativePath: "b" }),
    triageable({ status: "in_progress", modifiedAt: 5, relativePath: "c" }),
    triageable({ status: "in_progress", modifiedAt: 50, relativePath: "d" }),
    triageable({ status: "completed", modifiedAt: 999, relativePath: "e" }),
  ];
  const order = [...items].sort((a, b) => compareBacklogItems(a, b, "status")).map((i) => i.relativePath);
  // needs_input, then in_progress newest-first, then idea, then completed
  assert.deepEqual(order, ["b", "d", "c", "a", "e"]);
});

test("compareBacklogItems: priority sort is criticality desc, then smallest difficulty", () => {
  const items = [
    triageable({ criticality: "high", difficulty: "l", relativePath: "bet" }),
    triageable({ criticality: "critical", difficulty: "m", relativePath: "crit" }),
    triageable({ criticality: "high", difficulty: "s", relativePath: "quick" }),
    triageable({ criticality: undefined, difficulty: "xs", relativePath: "unset" }),
  ];
  const order = [...items].sort((a, b) => compareBacklogItems(a, b, "priority")).map((i) => i.relativePath);
  assert.deepEqual(order, ["crit", "quick", "bet", "unset"]);
});

test("compareBacklogItems: largest/smallest sink unestimated to the bottom either way", () => {
  const items = [
    triageable({ difficulty: "m", relativePath: "m" }),
    triageable({ difficulty: undefined, relativePath: "none" }),
    triageable({ difficulty: "xl", relativePath: "xl" }),
  ];
  const largest = [...items].sort((a, b) => compareBacklogItems(a, b, "largest")).map((i) => i.relativePath);
  const smallest = [...items].sort((a, b) => compareBacklogItems(a, b, "smallest")).map((i) => i.relativePath);
  assert.deepEqual(largest, ["xl", "m", "none"]);
  assert.deepEqual(smallest, ["m", "xl", "none"]);
});

test("compareBacklogItems: best sort is impact, then risk, then effort, then stable path", () => {
  const items = [
    triageable({ criticality: "high", risk: "high", difficulty: "s", relativePath: "z" }),
    triageable({ criticality: "high", risk: "low", difficulty: "l", relativePath: "y" }),
    triageable({ criticality: "critical", risk: "normal", difficulty: "m", relativePath: "x" }),
    triageable({ criticality: "high", risk: "low", difficulty: "l", relativePath: "a" }),
  ];
  const order = [...items].sort((a, b) => compareBacklogItems(a, b, "best")).map((i) => i.relativePath);
  // critical first; then among high: lowest risk first (a,y tie on all axes → path order a<y); then high-risk z
  assert.deepEqual(order, ["x", "a", "y", "z"]);
});

test("toTriageable derives modifiedAt from updatedAt and isEpic from type", () => {
  const t = toTriageable({
    itemId: "MC-1",
    relativePath: "backlog/e.md",
    title: "E",
    status: "ready",
    type: "epic",
    updatedAt: "2026-07-01T00:00:00.000Z",
    workspacePath: "/w",
    workspaceName: "w",
  });
  assert.equal(t.isEpic, true);
  assert.equal(t.modifiedAt, Date.parse("2026-07-01T00:00:00.000Z"));
  assert.equal(t.createdAtMs, t.modifiedAt);
});

test("selectBacklogRows applies view, search (title/excerpt/id), and sort together", () => {
  const rows = [
    { itemId: "MC-7", relativePath: "backlog/login.md", title: "Login", status: "ready", updatedAt: "2026-07-02T00:00:00Z", workspacePath: "/w", workspaceName: "w" },
    { itemId: "MC-8", relativePath: "backlog/logout.md", title: "Logout", excerpt: "session teardown", status: "completed", updatedAt: "2026-07-03T00:00:00Z", workspacePath: "/w", workspaceName: "w" },
    { itemId: "MC-9", relativePath: "backlog/theme.md", title: "Theme", status: "in_progress", updatedAt: "2026-07-04T00:00:00Z", workspacePath: "/w", workspaceName: "w" },
  ];

  // active hides the completed row; recent sort orders newest first
  const active = selectBacklogRows(rows, { view: "active", sort: "recent", search: "" });
  assert.deepEqual(active.map((r) => r.itemId), ["MC-9", "MC-7"]);

  // search matches title
  assert.deepEqual(selectBacklogRows(rows, { view: "all", sort: "recent", search: "log" }).map((r) => r.itemId), ["MC-8", "MC-7"]);
  // search matches excerpt
  assert.deepEqual(selectBacklogRows(rows, { view: "all", sort: "recent", search: "teardown" }).map((r) => r.itemId), ["MC-8"]);
  // search matches id
  assert.deepEqual(selectBacklogRows(rows, { view: "all", sort: "recent", search: "mc-9" }).map((r) => r.itemId), ["MC-9"]);
});

test("groupBacklogByEpic buckets members under their slug with done/total rollups", () => {
  const rows = [
    { itemId: "MC-1", relativePath: "backlog/epics/checkout.md", title: "Checkout epic", status: "in_progress", type: "epic", workspacePath: "/w", workspaceName: "w" },
    { itemId: "MC-2", relativePath: "backlog/cart.md", title: "Cart", status: "completed", epic: "checkout", workspacePath: "/w", workspaceName: "w" },
    { itemId: "MC-3", relativePath: "backlog/pay.md", title: "Pay", status: "ready", epic: "checkout", workspacePath: "/w", workspaceName: "w" },
    { itemId: "MC-4", relativePath: "backlog/loose.md", title: "Loose", status: "idea", workspacePath: "/w", workspaceName: "w" },
  ];
  const groups = groupBacklogByEpic(rows);
  const checkout = groups.find((g) => g.epicSlug === "checkout");
  assert.ok(checkout);
  assert.equal(checkout.epicItem?.itemId, "MC-1");
  assert.equal(checkout.totalCount, 2);
  assert.equal(checkout.doneCount, 1);
  assert.ok(checkout.color);
  // the ungrouped bucket collects epic-less rows
  const ungrouped = groups.find((g) => g.epicSlug === null);
  assert.deepEqual(ungrouped.items.map((r) => r.itemId), ["MC-4"]);
});

test("epicColorFromSlug is stable, lowercase-insensitive, and on the wheel", () => {
  assert.equal(epicColorFromSlug("checkout"), epicColorFromSlug("CHECKOUT"));
  assert.ok(backlogHighlightColors.includes(epicColorFromSlug("mobile-premium-redesign")));
});

// The desktop puts the epic's hand-picked colour, display id and rollup on the wire.
// The phone ignored the whole block and hashed the slug instead, so the same epic
// wore one colour on the desktop and a different one on the phone — and colour is
// exactly how a person recognises an epic at a glance.
test("an epic's chosen colour beats the slug hash, and the hash remains the fallback", () => {
  const epics = normalizeBacklogEpics([
    { slug: "checkout", displayId: "MC-1493", title: "Checkout", color: "amber", doneCount: 3, totalCount: 7 },
  ]);

  assert.equal(epicColor("checkout", epics.get("checkout")), "amber", "the desktop's choice wins");
  assert.equal(epicColor("uncovered", undefined), epicColorFromSlug("uncovered"), "an uncovered epic still gets a colour");
});

test("normalizeBacklogEpics rejects a colour that is not on the wheel", () => {
  // `color` is an open string on the wire. An unrecognised value must fall back to
  // the hash, not reach a theme lookup that would return undefined and paint
  // nothing at all.
  const epics = normalizeBacklogEpics([
    { slug: "a", color: "chartreuse", doneCount: 0, totalCount: 0 },
    { slug: "b", color: "green", doneCount: 0, totalCount: 0 },
  ]);
  assert.equal(epics.get("a").color, undefined);
  assert.equal(epicColor("a", epics.get("a")), epicColorFromSlug("a"));
  assert.equal(epics.get("b").color, "green");
});

test("normalizeBacklogEpics survives junk, and counts never go negative or fractional", () => {
  assert.equal(normalizeBacklogEpics(undefined).size, 0);
  assert.equal(normalizeBacklogEpics("nope").size, 0);
  assert.equal(normalizeBacklogEpics([null, 7, {}, { slug: "" }]).size, 0);

  const epics = normalizeBacklogEpics([
    { slug: "X", doneCount: -4, totalCount: 2.7 },
    { slug: "x", displayId: "dupe-ignored", doneCount: 99, totalCount: 99 },
  ]);
  assert.equal(epics.size, 1, "slugs are keyed lowercase, so the duplicate collapses");
  assert.equal(epics.get("x").doneCount, 0);
  assert.equal(epics.get("x").totalCount, 2);
  assert.equal(epics.get("x").displayId, undefined, "first entry wins, mirroring the role catalog");
});

test("the group carries its epic metadata, and rolls up the ROWS not the whole epic", () => {
  const rows = [
    { itemId: "MC-1", relativePath: "backlog/epics/checkout.md", title: "Checkout epic", status: "in_progress", type: "epic", workspacePath: "/w", workspaceName: "w" },
    { itemId: "MC-2", relativePath: "backlog/cart.md", title: "Cart", status: "completed", epic: "checkout", workspacePath: "/w", workspaceName: "w" },
  ];
  const epics = normalizeBacklogEpics([
    { slug: "checkout", displayId: "MC-1493", color: "purple", doneCount: 6, totalCount: 9 },
  ]);

  const [checkout] = groupBacklogByEpic(rows, epics);
  assert.equal(checkout.color, "purple", "the band/chip hue comes from the epic's own choice");
  assert.equal(checkout.meta.displayId, "MC-1493");

  // The group holds what the current view and search left behind, so its rollup
  // must count THOSE rows. Showing the desktop's whole-epic 6-of-9 beside one
  // visible row would be the same count disagreeing with itself on one screen.
  assert.equal(checkout.totalCount, 1);
  assert.equal(checkout.doneCount, 1);
  assert.equal(checkout.meta.totalCount, 9, "the whole-epic figure is still reachable for a surface that wants it");
});

// The container's slug is derived from its filename and lowercased; a member's
// `epic:` is author-typed. Left raw, a member saying `epic: Checkout` formed its
// own group beside the container it meant to join, and missed its epic's colour.
test("a member's epic slug matches its container regardless of the case it was typed in", () => {
  const rows = [
    { itemId: "MC-1", relativePath: "backlog/epics/checkout.md", title: "Checkout epic", status: "in_progress", type: "epic", workspacePath: "/w", workspaceName: "w" },
    { itemId: "MC-2", relativePath: "backlog/cart.md", title: "Cart", status: "ready", epic: "CheckOut", workspacePath: "/w", workspaceName: "w" },
  ];
  const [normalized] = normalizeBacklogWorkspaces([
    { workspaceId: "w", workspacePath: "/w", workspaceName: "w", items: rows },
  ]);

  const groups = groupBacklogByEpic(normalized.items);
  assert.equal(groups.length, 1, "one epic, not two");
  assert.equal(groups[0].epicItem.itemId, "MC-1");
  assert.deepEqual(groups[0].items.map((r) => r.itemId), ["MC-2"]);
});

test("triage option lists cover every axis value once", () => {
  assert.equal(new Set(backlogViewOptions).size, 9);
  assert.equal(new Set(backlogSortOptions).size, 7);
  assert.deepEqual([...backlogGroupOptions], ["none", "by_epic"]);
});

// "Dependency order" was offered and sorted by recency: backlog items carry no
// `dependsOn` on this wire, so the option fell through to the default. The two
// orders correlate on a young backlog, so it read as working rather than broken —
// which is worse than an absent feature. Removed until the wire can feed it.
test("no sort option is offered that the wire cannot actually order by", () => {
  assert.equal(backlogSortOptions.includes("dependency"), false);
  assert.equal("dependency" in backlogSortLabel, false, "an unreachable option must not keep a label either");
});
