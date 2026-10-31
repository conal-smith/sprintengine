/* global __dirname */
// The pull request viewer: the two reads it sends the desktop, how their
// answers are read, how a desktop too old to serve them is told apart, and the
// words the screen says about checks, reviews and files.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  createPullRequestApi,
  joinDiffPages,
  pullRequestReadsUnsupported,
  readPullRequestDetail,
  readPullRequestDiffPage,
} = require(path.join(buildRoot, "src/api/pullRequests.js"));
const {
  branchWords,
  checksSummaryWords,
  diffProgress,
  fileChangeStatus,
  filesNotListed,
  pullRequestStateWords,
  remarksSummaryWords,
  reviewSummaryWords,
} = require(path.join(buildRoot, "src/features/pullRequests/pullRequestView.js"));
const { tailnetGrantAllows, readSnapshotCommands } = require(path.join(buildRoot, "src/api/tailnetControlClient.js"));
const { validateMobileControlCommand, mobileControlProtocolVersion } = require(
  path.join(buildRoot, "src/shared/mobile-control/protocol.js"),
);

const URL = "https://github.com/acme/app/pull/42";
const detail = (overrides = {}) => ({
  url: URL,
  number: 42,
  title: "Add the thing",
  state: "open",
  isDraft: false,
  author: "dev",
  baseRefName: "main",
  headRefName: "feature",
  openedAt: 1000,
  endedAt: null,
  mergeable: "mergeable",
  checks: {
    passed: 3,
    failed: 1,
    pending: 0,
    items: [{ name: "build", workflow: "CI", status: "failed", required: true }],
  },
  reviewDecision: "approved",
  reviews: { approved: 2, changesRequested: 0, commented: 1 },
  remarks: { total: 3, latest: [{ kind: "review", author: "acme", verdict: "approved", excerpt: "LGTM", at: 5 }] },
  files: {
    total: 120,
    additions: 10,
    deletions: 4,
    items: [{ path: "src/a.ts", additions: 1, deletions: 1, change: "modified" }],
  },
  ...overrides,
});

test("a pull request answer is read in its shape, its lists entry by entry", () => {
  const read = readPullRequestDetail(detail());
  assert.equal(read.title, "Add the thing");
  assert.equal(read.checks.items[0].required, true);
  assert.equal(read.files.items[0].path, "src/a.ts");
  // An entry out of shape is dropped on its own; the rest stand.
  const mixed = readPullRequestDetail(
    detail({
      checks: {
        passed: 1,
        failed: 0,
        pending: 0,
        items: [
          { name: "lint", status: "weird" },
          { name: "ok", status: "passed" },
        ],
      },
      files: { total: 1, additions: 0, deletions: 0, items: [{ additions: 3 }, { path: "b.ts" }] },
    }),
  );
  assert.deepEqual(
    mixed.checks.items.map((check) => check.name),
    ["ok"],
  );
  assert.deepEqual(
    mixed.files.items.map((file) => file.path),
    ["b.ts"],
  );
  assert.equal(readPullRequestDetail(detail({ files: null })).files, null, "files the desktop could not read");
  // Not a pull request at all.
  assert.equal(readPullRequestDetail(detail({ state: "draft" })), null);
  assert.equal(readPullRequestDetail({ url: URL, state: "open" }), null);
  assert.equal(readPullRequestDetail(null), null);
});

test("a diff page is read only for the file asked about, and pages join into one diff", () => {
  const first = {
    path: "f",
    patch: "diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b",
    offset: 0,
    nextOffset: 4,
    totalLines: 7,
  };
  const second = { path: "f", patch: "@@ -9 +9 @@\n-c\n+d", offset: 4, nextOffset: null, totalLines: 7 };
  assert.deepEqual(readPullRequestDiffPage(first, "f"), first);
  assert.equal(readPullRequestDiffPage(first, "g"), null, "another file's page");
  assert.equal(readPullRequestDiffPage({ ...first, nextOffset: 0 }, "f"), null, "a next page that does not move on");
  assert.equal(readPullRequestDiffPage({ ...first, offset: -1 }, "f"), null);
  assert.equal(joinDiffPages([first, second]).split("\n").length, 7);
  assert.deepEqual(diffProgress([first]), { more: true, read: 4, total: 7 });
  assert.deepEqual(diffProgress([first, second]), { more: false, read: 7, total: 7 });
  assert.deepEqual(diffProgress([]), { more: false, read: 0, total: 0 });
});

test("the reads go to the desktop as mobile-control commands, and a desktop without them is told apart", async () => {
  const sent = [];
  let answer = { ok: true, data: detail() };
  const api = createPullRequestApi({
    async sendCommand(command) {
      sent.push(command);
      return typeof answer === "function" ? answer(command) : answer;
    },
  });
  assert.equal((await api.read(URL)).data.number, 42);
  assert.deepEqual(sent[0], { type: "pullRequest.read", payload: { url: URL } });

  answer = (command) => ({
    ok: true,
    data: {
      path: command.payload.path,
      patch: "x",
      offset: command.payload.offset ?? 0,
      nextOffset: null,
      totalLines: 1,
    },
  });
  await api.diff(URL, "src/a.ts");
  await api.diff(URL, "src/a.ts", 300);
  assert.deepEqual(sent[1].payload, { url: URL, path: "src/a.ts" });
  assert.deepEqual(sent[2].payload, { url: URL, path: "src/a.ts", offset: 300 });

  answer = { ok: true, data: { nonsense: true } };
  assert.equal((await api.read(URL)).ok, false, "an answer out of shape is no answer");

  // An older desktop: its validator does not know the command, or its gateway does not serve it.
  assert.equal(
    pullRequestReadsUnsupported({
      ok: false,
      errorCode: "invalid_payload",
      message: "command.type must be a supported mobile-control command",
    }),
    true,
  );
  assert.equal(pullRequestReadsUnsupported({ ok: false, errorCode: "command_not_supported" }), true);
  assert.equal(
    pullRequestReadsUnsupported({ ok: false, errorCode: "internal_error", message: "GitHub did not answer in time." }),
    false,
  );
});

test("the viewer is offered where the grant covers the reads, and the phone's protocol knows them", () => {
  assert.equal(tailnetGrantAllows(["workspace:operate"], "pullRequest.read"), true);
  assert.equal(tailnetGrantAllows(["workspace:read", "conversation:read"], "pullRequest.read"), false);
  assert.deepEqual(
    [...readSnapshotCommands(["pullRequest.read", "pullRequest.diff", "later.thing"])],
    ["pullRequest.read", "pullRequest.diff"],
  );
  const command = (type, payload) => ({
    protocolVersion: mobileControlProtocolVersion,
    commandId: "c1",
    type,
    issuedAt: "2026-10-30T12:00:00.000Z",
    deviceId: "android-phone",
    payload,
  });
  assert.equal(validateMobileControlCommand(command("pullRequest.diff", { url: URL, path: "f", offset: 3 })).ok, true);
  assert.equal(
    validateMobileControlCommand(command("pullRequest.diff", { url: URL, path: "f", offset: 1.5 })).ok,
    false,
  );
  assert.equal(validateMobileControlCommand(command("pullRequest.read", {})).ok, false);
});

test("the viewer's words: state, checks, reviews, comments, branches and files", () => {
  assert.deepEqual(pullRequestStateWords({ state: "open", isDraft: false }), { text: "Open", tone: "toneGood" });
  assert.equal(pullRequestStateWords({ state: "open", isDraft: true }).text, "Draft");
  assert.equal(pullRequestStateWords({ state: "merged", isDraft: false }).text, "Merged");

  assert.deepEqual(checksSummaryWords({ passed: 3, failed: 1, pending: 2 }), {
    text: "1 failing, 2 running, 3 passed",
    tone: "danger",
  });
  assert.deepEqual(checksSummaryWords({ passed: 4, failed: 0, pending: 0 }), { text: "All 4 passed", tone: "good" });
  assert.equal(checksSummaryWords({ passed: 0, failed: 0, pending: 0 }).text, "No checks");

  assert.equal(reviewSummaryWords(detail()), "Approved · 2 approvals, 1 commented");
  assert.equal(
    reviewSummaryWords({ reviewDecision: null, reviews: { approved: 0, changesRequested: 0, commented: 0 } }),
    "No reviews yet",
  );
  assert.equal(remarksSummaryWords({ total: 1, latest: [] }), "1 comment or review");
  assert.equal(remarksSummaryWords({ total: 0, latest: [] }), "No comments yet");
  assert.equal(branchWords(detail()), "main ← feature");
  assert.equal(branchWords(detail({ headRefName: null })), null);

  assert.equal(fileChangeStatus("added"), "added");
  assert.equal(fileChangeStatus("deleted"), "deleted");
  assert.equal(fileChangeStatus("renamed"), "modified");
  assert.equal(fileChangeStatus(null), "modified");
  assert.equal(filesNotListed(detail().files), 119);
});
