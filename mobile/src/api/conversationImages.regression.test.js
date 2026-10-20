/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const {
  CONVERSATION_IMAGE_PATH,
  conversationImageProblem,
  conversationImageProblemText,
  conversationImageSource,
  conversationImageUrl,
  conversationUploadRefusal,
  readConversationImageProblem,
} = require(path.resolve(__dirname, "../../.mobile-test-build/src/api/conversationImages.js"));

const desktop = { baseUrl: "http://studio.tail1234.ts.net:8471", deviceToken: "mctn_token" };
const ref = { workspaceId: "ws-1", agentId: "agent-1", toolUseId: "ig_1" };

test("a picture's address names the chat and the call, each id encoded", () => {
  assert.equal(CONVERSATION_IMAGE_PATH, "/tailnet/v1/conversation-image");
  assert.equal(
    conversationImageUrl(desktop.baseUrl, ref),
    "http://studio.tail1234.ts.net:8471/tailnet/v1/conversation-image?workspaceId=ws-1&agentId=agent-1&toolUseId=ig_1",
  );
  // Ids are the desktop's; one carrying query syntax must not add or split a parameter.
  const hostile = { workspaceId: "a&b=c", agentId: "x y/z?#", toolUseId: "call_1+2%" };
  const url = new URL(conversationImageUrl(desktop.baseUrl, hostile));
  assert.deepEqual([...url.searchParams.keys()], ["workspaceId", "agentId", "toolUseId"]);
  assert.equal(url.searchParams.get("workspaceId"), "a&b=c");
  assert.equal(url.searchParams.get("agentId"), "x y/z?#");
  assert.equal(url.searchParams.get("toolUseId"), "call_1+2%");
  assert.equal(url.hash, "");
  // A base URL stored with a trailing slash still makes one path.
  assert.equal(new URL(conversationImageUrl(`${desktop.baseUrl}/`, ref)).pathname, CONVERSATION_IMAGE_PATH);
});

test("the image source carries the device token as the upload does", () => {
  assert.deepEqual(conversationImageSource(desktop, ref), {
    uri: conversationImageUrl(desktop.baseUrl, ref),
    headers: { Authorization: "Bearer mctn_token" },
  });
});

test("a refusal reads as the one line a person needs", () => {
  const refusal = (code) => ({ error: { code, message: "…" } });
  assert.equal(conversationImageProblem(404, refusal("unknown_image")), "gone");
  assert.equal(conversationImageProblem(404, refusal("unknown_conversation")), "gone");
  assert.equal(conversationImageProblem(413, refusal("image_too_large")), "too_large");
  assert.equal(conversationImageProblem(415, refusal("not_an_image")), "unavailable");
  assert.equal(conversationImageProblem(403, refusal("tailnet_scope_required")), "unavailable");
  // A body that is not the desktop's error shape falls back to the status.
  assert.equal(conversationImageProblem(404, null), "gone");
  assert.equal(conversationImageProblem(413, "Payload Too Large"), "too_large");
  assert.equal(conversationImageProblem(500, {}), "unavailable");
  assert.equal(conversationImageProblemText("gone"), "This image is no longer on the desktop.");
  assert.equal(conversationImageProblemText("too_large"), "This image is too large to show.");
  assert.equal(conversationImageProblemText("unavailable"), "This image could not be loaded.");
});

test("asking why a picture failed makes one authorised request and never throws", async () => {
  const calls = [];
  const answer = (status, body) => async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body };
  };
  assert.equal(await readConversationImageProblem(desktop, ref, answer(404, { error: { code: "unknown_image" } })), "gone");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, conversationImageUrl(desktop.baseUrl, ref));
  assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer mctn_token" });
  assert.equal(await readConversationImageProblem(desktop, ref, answer(413, { error: { code: "image_too_large" } })), "too_large");
  // The picture did come back this time: nothing to name, so the generic line.
  assert.equal(await readConversationImageProblem(desktop, ref, answer(200, null)), "unavailable");
  assert.equal(
    await readConversationImageProblem(desktop, ref, async () => {
      throw new TypeError("Network request failed");
    }),
    "unavailable",
  );
  assert.equal(
    await readConversationImageProblem(desktop, ref, async () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError("not json"); } })),
    "gone",
  );
});

// A refused upload used to say only "The desktop refused the image upload",
// so a chat whose agent reads no pictures was retried forever with no cause.
test("a refused upload says why: the desktop's own message, else what the status means on the route", () => {
  assert.equal(
    conversationUploadRefusal(409, { error: { code: "images_unsupported", message: "This conversation cannot accept images." } }),
    "This conversation cannot accept images.",
  );
  assert.equal(conversationUploadRefusal(413, null), "The picture is over the desktop's size limit.");
  assert.equal(conversationUploadRefusal(415, { error: { message: "  " } }), "The desktop takes JPEG, PNG, GIF and WebP pictures only.");
  assert.equal(conversationUploadRefusal(409, "not json"), "This chat's agent does not take pictures.");
  assert.equal(conversationUploadRefusal(404, {}), "The desktop no longer has this chat.");
  assert.equal(conversationUploadRefusal(500, { error: { message: 7 } }), "The desktop refused the image upload.");
});
