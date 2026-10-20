/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// Starting a chat with pictures from New. The session a picture uploads to
// exists only once `conversation.create` has made it, so New starts the chat
// bare, uploads each picture, and only then hands the words and the upload
// ids to the chat. Every failure must leave the words and every picture in
// New, and a retry must use the chat it already started and skip a picture
// already uploaded: a second chat beside an empty first one, or the same
// picture sent twice, is the bug this pins.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const { launchWithPhotos, openingStillInBox } = require(
  path.join(buildRoot, "src/features/conversations/photoLaunch.js"),
);

const target = { deviceId: "d1", workspaceId: "ws-1", machineName: "mac-mini" };
const photo = (n) => ({ uri: `file:///photo-${n}.jpg`, name: `photo-${n}.jpg`, mediaType: "image/jpeg" });
const started = {
  ok: true,
  conversation: {
    workspaceId: "ws-1",
    agentId: "agent-1",
    name: "Chat",
    cli: "claude-code",
    providerId: "claude-agent",
    modelId: "default",
    sessionId: "session-1",
  },
};

function desktop({ create = started, failUploads = new Set() } = {}) {
  const calls = { create: 0, uploads: [] };
  return {
    calls,
    steps: {
      async create() {
        calls.create += 1;
        return create;
      },
      async upload(sessionId, image) {
        calls.uploads.push([sessionId, image.name]);
        if (failUploads.has(image.name)) throw new Error("The picture is over the desktop's 5 MB limit.");
        return `upload-${image.name}`;
      },
    },
  };
}

test("a launch with pictures starts the chat once, uploads each picture to its session, and hands over the ids in order", async () => {
  const { calls, steps } = desktop();
  const result = await launchWithPhotos({ target, images: [photo(1), photo(2)], progress: null }, steps);
  assert.equal(result.ok, true);
  assert.equal(calls.create, 1);
  assert.deepEqual(calls.uploads, [
    ["session-1", "photo-1.jpg"],
    ["session-1", "photo-2.jpg"],
  ]);
  assert.deepEqual(result.uploads, [
    { id: "upload-photo-1.jpg", name: "photo-1.jpg" },
    { id: "upload-photo-2.jpg", name: "photo-2.jpg" },
  ]);
});

test("a chat the desktop would not start uploads nothing and says why; nothing was started", async () => {
  const { calls, steps } = desktop({
    create: { ok: false, failure: "unavailable", title: "mac-mini did not answer.", message: "Is Tailscale up on both devices?" },
  });
  const result = await launchWithPhotos({ target, images: [photo(1)], progress: null }, steps);
  assert.equal(result.ok, false);
  assert.equal(result.started, false);
  assert.equal(result.message, "mac-mini did not answer. Is Tailscale up on both devices?");
  assert.deepEqual(calls.uploads, []);
  assert.equal(result.progress.conversation, null);
  assert.equal("code" in result, false);
});

test("a worktree the desktop could not make keeps its code, so New can offer to start without one", async () => {
  const { calls, steps } = desktop({
    create: {
      ok: false,
      failure: "refused",
      title: "mac-mini could not make a worktree for the chat.",
      message: "/srv/notes is not a git repository.",
      code: "worktree_unavailable",
    },
  });
  const result = await launchWithPhotos({ target, images: [photo(1)], progress: null }, steps);
  assert.equal(result.ok, false);
  assert.equal(result.started, false);
  assert.equal(result.code, "worktree_unavailable");
  assert.deepEqual(calls.uploads, []);
});

test("a picture that fails to upload keeps the chat it started, and the retry uses that chat and skips what already went", async () => {
  const first = desktop({ failUploads: new Set(["photo-2.jpg"]) });
  const failed = await launchWithPhotos({ target, images: [photo(1), photo(2)], progress: null }, first.steps);
  assert.equal(failed.ok, false);
  assert.equal(failed.started, true);
  assert.match(failed.message, /The chat started on mac-mini, but photo-2\.jpg did not upload: The picture is over the desktop's 5 MB limit\./);
  assert.match(failed.message, /same chat/);

  const second = desktop();
  const retried = await launchWithPhotos({ target, images: [photo(1), photo(2)], progress: failed.progress }, second.steps);
  assert.equal(retried.ok, true);
  assert.equal(second.calls.create, 0, "a retry must not start a second chat beside the first");
  assert.deepEqual(second.calls.uploads, [["session-1", "photo-2.jpg"]], "a picture that already uploaded is not sent twice");
  assert.equal(retried.conversation.agentId, "agent-1");
  assert.deepEqual(
    retried.uploads.map((upload) => upload.id),
    ["upload-photo-1.jpg", "upload-photo-2.jpg"],
  );
});

test("a picture taken out between tries is not sent, and every picture out still reuses the started chat", async () => {
  const first = desktop({ failUploads: new Set(["photo-2.jpg"]) });
  const failed = await launchWithPhotos({ target, images: [photo(1), photo(2)], progress: null }, first.steps);

  const second = desktop();
  const fewer = await launchWithPhotos({ target, images: [photo(2)], progress: failed.progress }, second.steps);
  assert.deepEqual(fewer.uploads.map((upload) => upload.name), ["photo-2.jpg"]);
  assert.equal(second.calls.create, 0);

  const third = desktop();
  const none = await launchWithPhotos({ target, images: [], progress: failed.progress }, third.steps);
  assert.equal(none.ok, true);
  assert.equal(third.calls.create, 0);
  assert.deepEqual(none.uploads, []);
});

test("progress from another project or machine is not resumed: that chat is somewhere else", async () => {
  const first = desktop({ failUploads: new Set(["photo-1.jpg"]) });
  const failed = await launchWithPhotos({ target, images: [photo(1)], progress: null }, first.steps);
  const elsewhere = desktop();
  await launchWithPhotos(
    { target: { ...target, deviceId: "d2", machineName: "build-box" }, images: [photo(1)], progress: failed.progress },
    elsewhere.steps,
  );
  assert.equal(elsewhere.calls.create, 1);
});

test("a started chat with no session to upload to says so rather than sending the words without their pictures", async () => {
  const { calls, steps } = desktop({ create: { ok: true, conversation: { ...started.conversation, sessionId: "" } } });
  const result = await launchWithPhotos({ target, images: [photo(1)], progress: null }, steps);
  assert.equal(result.ok, false);
  assert.equal(result.started, true);
  assert.deepEqual(calls.uploads, []);
  assert.match(result.message, /under Chats/);
});

test("the chat sends New's opening only while the box still holds it as New left it", () => {
  const opening = { text: "What is wrong here?", uploads: [{ id: "u1", name: "photo-1.jpg" }] };
  assert.equal(openingStillInBox(opening, { text: "What is wrong here?", uploads: [{ id: "u1" }] }), true);
  assert.equal(openingStillInBox(opening, { text: "What is wrong here? And here", uploads: [{ id: "u1" }] }), false);
  assert.equal(openingStillInBox(opening, { text: "What is wrong here?", uploads: [] }), false);
  assert.equal(openingStillInBox({ text: "", uploads: [{ id: "u1", name: "a" }] }, { text: "", uploads: [{ id: "u1" }] }), true);
});
