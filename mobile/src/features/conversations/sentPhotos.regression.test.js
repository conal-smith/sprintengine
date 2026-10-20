const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  MAX_SENT_IMAGES,
  forgetSentPhoto,
  parseSentImages,
  rememberSentPhoto,
  restoreSentPhotos,
  sentImageLabel,
  sentPhotoEntries,
  sentPhotosVersion,
  subscribeSentPhotos,
  sentImageShows,
  sentPhotoUri,
} = require("../../../.mobile-test-build/src/features/conversations/sentPhotos.js");
const { projectConversation } = require("../../../.mobile-test-build/src/features/conversations/conversationLogic.js");
const { conversationImageSource, conversationImageUrl } = require("../../../.mobile-test-build/src/api/conversationImages.js");
const { declaresMessageImages } = require("../../../.mobile-test-build/src/api/tailnetTransport.js");

// A ref in the shape the desktop's attachment store chooses: its folder for the
// chat, a random file name, the picture's extension.
const FOLDER = "0123456789abcdef0123456789abcdef";
const REF = `${FOLDER}/3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f.jpg`;
const OTHER_REF = `${FOLDER}/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.png`;

test("a message's pictures are its attachments, each by its upload id, with its name and the store's ref", () => {
  assert.deepEqual(
    parseSentImages([
      { id: "upload-1", mediaType: "image/jpeg", name: "IMG_0001.jpg", byteLength: 1200, ref: REF },
      { id: "upload-2", mediaType: "image/png", byteLength: 800, ref: OTHER_REF },
      // The same picture twice is drawn once.
      { id: "upload-1", mediaType: "image/jpeg", name: "IMG_0001.jpg", ref: REF },
    ]),
    [
      { id: "upload-1", name: "IMG_0001.jpg", ref: REF },
      { id: "upload-2", ref: OTHER_REF },
    ],
  );
});

test("no list, or a list in another shape, draws no pictures", () => {
  for (const value of [undefined, null, "IMG_0001.jpg", 3, { id: "upload-1" }, {}])
    assert.deepEqual(parseSentImages(value), [], JSON.stringify(value));
});

test("an entry without an id is skipped; a ref not in the store's shape is never asked for", () => {
  const images = parseSentImages([
    null,
    "upload-1",
    [{ id: "upload-1" }],
    {},
    { id: "" },
    { id: 42 },
    { id: "x".repeat(201) },
    { id: "path", ref: "../../etc/hosts" },
    { id: "absolute", ref: "/Users/dev/Pictures/IMG_0001.jpg" },
    { id: "shaped-but-not", ref: `${FOLDER}/../${FOLDER}/x.png` },
    { id: "named", name: "line\nbreak.jpg", ref: REF },
    { id: "kept", name: "  IMG_0002.png  ", ref: OTHER_REF },
  ]);
  assert.deepEqual(images, [
    { id: "path" },
    { id: "absolute" },
    { id: "shaped-but-not" },
    // A name with a control character is not shown; the picture still is.
    { id: "named", ref: REF },
    { id: "kept", name: "IMG_0002.png", ref: OTHER_REF },
  ]);
});

test("no more pictures are drawn than the desktop lets one message carry", () => {
  const many = Array.from({ length: MAX_SENT_IMAGES + 4 }, (_, index) => ({ id: `upload-${index}` }));
  assert.equal(MAX_SENT_IMAGES, 16);
  assert.equal(parseSentImages(many).length, MAX_SENT_IMAGES);
});

test("the person's bubble carries the pictures its user_message recorded, beside its words and files", () => {
  const user = (payload) => ({ id: "e1", seq: 1, sessionId: "s", workspaceId: "w", agentId: "a", type: "user_message", createdAt: 1, payload });
  const [row] = projectConversation([
    user({
      turnId: "t1",
      text: "What is this?",
      attachments: [{ id: "upload-1", mediaType: "image/jpeg", name: "IMG_0001.jpg", byteLength: 1200, ref: REF }],
    }),
  ]).rows;
  assert.equal(row.kind, "message");
  assert.equal(row.role, "user");
  assert.equal(row.text, "What is this?", "the picture's name is not in the words");
  assert.deepEqual(row.images, [{ id: "upload-1", name: "IMG_0001.jpg", ref: REF }]);
  // A picture alone, with no words.
  const [bare] = projectConversation([user({ turnId: "t1", text: "", attachments: [{ id: "upload-2", ref: OTHER_REF }] })]).rows;
  assert.equal(bare.text, "");
  assert.deepEqual(bare.images, [{ id: "upload-2", ref: OTHER_REF }]);
  // A message without pictures has no member at all.
  const [plain] = projectConversation([user({ turnId: "t1", text: "Hello" })]).rows;
  assert.equal("images" in plain, false);
});

test("a photo this phone uploaded is found by its upload id until it is let go of", () => {
  assert.equal(sentPhotoUri("never-uploaded"), undefined);
  rememberSentPhoto("upload-own", "file:///data/user/0/cache/ImagePicker/photo.jpg");
  assert.equal(sentPhotoUri("upload-own"), "file:///data/user/0/cache/ImagePicker/photo.jpg");
  forgetSentPhoto("upload-own");
  assert.equal(sentPhotoUri("upload-own"), undefined);
  // Nothing is kept under an empty id or for an empty uri.
  rememberSentPhoto("", "file:///x.jpg");
  rememberSentPhoto("upload-empty", "");
  assert.equal(sentPhotoUri(""), undefined);
  assert.equal(sentPhotoUri("upload-empty"), undefined);
});

test("the phone keeps a bounded number of its own copies, the oldest let go first", () => {
  for (let index = 0; index < 70; index++) rememberSentPhoto(`bounded-${index}`, `file:///photo-${index}.jpg`);
  assert.equal(sentPhotoUri("bounded-0"), undefined);
  assert.equal(sentPhotoUri("bounded-5"), undefined);
  assert.equal(sentPhotoUri("bounded-6"), "file:///photo-6.jpg");
  assert.equal(sentPhotoUri("bounded-69"), "file:///photo-69.jpg");
});

test("a square shows the phone's copy first, then the desktop's where it serves them, else the name", () => {
  const image = { id: "upload-1", name: "IMG_0001.jpg", ref: REF };
  const local = "file:///photo.jpg";
  assert.deepEqual(sentImageShows(image, { localUri: local, served: true }), { kind: "local", uri: local });
  assert.deepEqual(sentImageShows(image, { localUri: local, served: false }), { kind: "local", uri: local });
  assert.deepEqual(sentImageShows(image, { served: true }), { kind: "desktop", ref: REF });
  // A desktop that does not declare conversation-message-images is never asked.
  assert.deepEqual(sentImageShows(image, { served: false }), { kind: "named" });
  // Nor for a picture it did not keep.
  assert.deepEqual(sentImageShows({ id: "upload-2" }, { served: true }), { kind: "named" });
  // The phone's copy would not load: the desktop's is asked for; that would not either: the name.
  assert.deepEqual(sentImageShows(image, { localUri: local, served: true, failed: new Set(["local"]) }), { kind: "desktop", ref: REF });
  assert.deepEqual(sentImageShows(image, { localUri: local, served: true, failed: new Set(["local", "desktop"]) }), { kind: "named" });
});

test("a square is said by the picture's name, else by its place among the message's pictures", () => {
  assert.equal(sentImageLabel({ id: "a", name: "IMG_0001.jpg" }, 0, 2), "IMG_0001.jpg");
  assert.equal(sentImageLabel({ id: "a" }, 1, 2), "Image 2");
  assert.equal(sentImageLabel({ id: "a" }, 0, 1), "Image");
});

test("a sent picture's address names the chat and the ref, in place of a step", () => {
  const desktop = { baseUrl: "http://studio.tail1234.ts.net:8471/", deviceToken: "mctn_token" };
  const url = new URL(conversationImageUrl(desktop.baseUrl, { workspaceId: "ws-1", agentId: "agent-1", attachment: REF }));
  assert.equal(url.pathname, "/tailnet/v1/conversation-image");
  assert.deepEqual([...url.searchParams.keys()], ["workspaceId", "agentId", "attachment"]);
  assert.equal(url.searchParams.get("attachment"), REF);
  const source = conversationImageSource(desktop, { workspaceId: "ws-1", agentId: "agent-1", attachment: REF });
  assert.deepEqual(source.headers, { Authorization: "Bearer mctn_token" });
  // A step's picture is still named by its call.
  const step = new URL(conversationImageUrl(desktop.baseUrl, { workspaceId: "ws-1", agentId: "agent-1", toolUseId: "ig_1" }));
  assert.deepEqual([...step.searchParams.keys()], ["workspaceId", "agentId", "toolUseId"]);
});

test("sent pictures are fetched only from a desktop that declared conversation-message-images; silence is a no", () => {
  assert.equal(declaresMessageImages({ tailnetCapabilities: ["conversations", "conversation-images", "conversation-message-images"] }), true);
  // A desktop that serves step pictures only answers a sent picture's request 400.
  assert.equal(declaresMessageImages({ tailnetCapabilities: ["conversations", "conversation-images"] }), false);
  assert.equal(declaresMessageImages({}), false);
});

test("the phone's copies a past run kept come back under the ones this run has, and say when they change", () => {
  // Earlier cases filled the bounded list; this one starts from none.
  for (const [id] of sentPhotoEntries()) forgetSentPhoto(id);
  let heard = 0;
  const stop = subscribeSentPhotos(() => (heard += 1));
  const before = sentPhotosVersion();
  rememberSentPhoto("upload-this-run", "file:///cache/now.jpg");
  restoreSentPhotos([
    ["upload-last-run", "file:///cache/then.jpg"],
    // This run's word on a photo wins over the file's.
    ["upload-this-run", "file:///cache/stale.jpg"],
    ["bad"],
    [1, 2],
  ]);
  assert.equal(sentPhotoUri("upload-last-run"), "file:///cache/then.jpg");
  assert.equal(sentPhotoUri("upload-this-run"), "file:///cache/now.jpg");
  assert.deepEqual(sentPhotoEntries().slice(-2), [
    ["upload-last-run", "file:///cache/then.jpg"],
    ["upload-this-run", "file:///cache/now.jpg"],
  ]);
  forgetSentPhoto("upload-last-run");
  forgetSentPhoto("upload-never");
  assert.equal(heard, 3, "remember, restore and one real forget; forgetting nothing is no change");
  assert.ok(sentPhotosVersion() > before);
  restoreSentPhotos("not a list");
  stop();
  forgetSentPhoto("upload-this-run");
  assert.equal(heard, 3, "a stopped listener hears nothing more");
});
