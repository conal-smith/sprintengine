/* global __dirname, Buffer */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// What the composer's "+" holds. The phone starts conversations only, so
// "Start as" has one answer and, as on the desktop, a group with one answer is
// not drawn. Pictures are next: from the library, or taken now. Schedule
// comes last, on New only and where the pairing may operate the desktop. Plan
// mode and a goal are not offered: the protocol does not carry them.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const {
  ATTACH_LABELS,
  CHAT_IMAGE_DOWNSCALED_MAX_BYTES,
  CHAT_IMAGE_MAX_BYTES,
  PHONE_START_AS,
  chatImageMaxBytes,
  bytesFromBase64,
  composerHasOptions,
  composerOptions,
  composerOptionsLabel,
  pictureTypeOf,
  readPickedImage,
} = require(path.join(buildRoot, "src/features/conversations/composerOptions.js"));

const phone = { offered: PHONE_START_AS, selected: "conversation" };

test("without a schedule asked for, the phone's + holds the two picture rows and nothing else", () => {
  const rows = composerOptions({ startAs: phone, attach: { held: 0, max: 4, busy: false } });
  assert.deepEqual(rows, [
    { kind: "attach", source: "library", label: "Choose a photo", disabledReason: null },
    { kind: "attach", source: "camera", label: "Take a photo", disabledReason: null },
  ]);
  assert.deepEqual(PHONE_START_AS, ["conversation"]);
  assert.equal(rows.some((row) => row.kind === "start-as"), false);
  for (const banned of ["plan", "goal", "schedule"]) {
    assert.equal(
      rows.some((row) => JSON.stringify(row).toLowerCase().includes(banned)),
      false,
      `${banned} is not offered`,
    );
  }
  assert.deepEqual(ATTACH_LABELS, { library: "Choose a photo", camera: "Take a photo", file: "Choose a file" });
});

test("a desktop that takes files adds a File row after the photo rows", () => {
  const rows = composerOptions({ startAs: phone, attach: { held: 0, max: 4, busy: false, files: true } });
  assert.deepEqual(
    rows.map((row) => [row.source, row.label]),
    [
      ["library", "Choose a photo"],
      ["camera", "Take a photo"],
      ["file", "Choose a file"],
    ],
  );
  assert.equal(composerOptionsLabel(rows), "Attach a photo or file");
});

test("a chat whose agent reads no pictures still takes a file, where the desktop takes one", () => {
  const rows = composerOptions({ startAs: phone, attach: { held: 0, max: 4, busy: false, pictures: false, files: true } });
  assert.deepEqual(
    rows.map((row) => row.source),
    ["file"],
  );
  assert.equal(composerOptionsLabel(rows), "Attach a file");
  const neither = composerOptions({ startAs: phone, attach: { held: 0, max: 4, busy: false, pictures: false } });
  assert.deepEqual(neither, []);
  assert.equal(composerHasOptions(neither), false);
});

test("photos and files share one limit, and the reason says attachments", () => {
  const full = composerOptions({ startAs: phone, attach: { held: 4, max: 4, busy: false, files: true } });
  assert.equal(full.length, 3);
  for (const row of full) assert.equal(row.disabledReason, "4 attachments is the most one message takes.");
  const busy = composerOptions({ startAs: phone, attach: { held: 1, max: 4, busy: true, files: true } });
  for (const row of busy) assert.equal(row.disabledReason, "Adding the last attachment…");
});

test("where the chat's agent reads no pictures there is nothing behind the +, and no + is drawn", () => {
  const rows = composerOptions({ startAs: phone, attach: null });
  assert.deepEqual(rows, []);
  assert.equal(composerHasOptions(rows), false);
});

test("a full tray, or a picture still being added, keeps the rows and says why they are off", () => {
  const full = composerOptions({ startAs: phone, attach: { held: 4, max: 4, busy: false } });
  assert.equal(full.length, 2);
  for (const row of full) assert.equal(row.disabledReason, "4 pictures is the most one message takes.");
  const busy = composerOptions({ startAs: phone, attach: { held: 1, max: 4, busy: true } });
  for (const row of busy) assert.equal(row.disabledReason, "Adding the last picture…");
});

test("Start as is drawn only when there is a second answer, and leads the sheet", () => {
  const rows = composerOptions({
    startAs: { offered: ["conversation", "terminal-agent", "conversation"], selected: "conversation" },
    attach: { held: 0, max: 4, busy: false },
  });
  assert.deepEqual(rows[0], {
    kind: "start-as",
    label: "Start as",
    choices: ["conversation", "terminal-agent"],
    selected: "conversation",
  });
  assert.equal(rows.length, 3);
});

test("a picked picture is held with its type and name, and one the desktop would refuse is said up front", () => {
  assert.deepEqual(readPickedImage({ uri: "file:///a.png", mimeType: "image/png", fileName: null }), {
    ok: true,
    image: { uri: "file:///a.png", name: "image.png", mediaType: "image/png" },
  });
  assert.deepEqual(readPickedImage({ uri: "file:///b" }).image, { uri: "file:///b", name: "image.jpg", mediaType: "image/jpeg" });
  assert.equal(readPickedImage({ uri: "file:///c.heic", mimeType: "image/heic" }).ok, false);
  assert.deepEqual(readPickedImage({ uri: "file:///d.jpg", mimeType: "image/jpeg", fileSize: CHAT_IMAGE_MAX_BYTES + 1 }), {
    ok: false,
    message: "Choose an image smaller than 5 MB.",
  });
});

// "Options" named nothing to a screen reader while pictures were all the sheet held.
test("the + is spoken as what is behind it", () => {
  const pictures = composerOptions({ startAs: phone, attach: { held: 0, max: 4, busy: false } });
  assert.equal(composerOptionsLabel(pictures), "Attach a photo");
  const more = composerOptions({
    startAs: { offered: ["conversation", "terminal-agent"], selected: "conversation" },
    attach: { held: 0, max: 4, busy: false },
  });
  assert.equal(composerOptionsLabel(more), "Options");
});

// The desktop's upload refuses a request with no name (400) and reads the type
// case-blind; the phone used to pass an empty name through, and to refuse a
// type the desktop would have taken.
test("a picked picture always has a name, and its type is read the way the desktop reads it", () => {
  assert.equal(readPickedImage({ uri: "file:///e", mimeType: "image/png", fileName: "  " }).image.name, "image.png");
  assert.equal(readPickedImage({ uri: "file:///f", mimeType: "image/webp", fileName: "" }).image.name, "image.webp");
  assert.equal(readPickedImage({ uri: "file:///g", mimeType: "IMAGE/PNG" }).image.mediaType, "image/png");
  assert.deepEqual(readPickedImage({ uri: "file:///h", mimeType: "image/jpg", fileName: "h.jpg" }).image, {
    uri: "file:///h",
    name: "h.jpg",
    mediaType: "image/jpeg",
  });
});

// Android writes a compressed JPEG for a HEIC, GIF or WebP photo and still
// reports the original's type and size; the desktop hands the type on to the
// model as given. What the file itself says is what is sent.
test("a picked picture is sent as what its file is, not what the picker said", () => {
  const head = (text) => bytesFromBase64(Buffer.from(text, "latin1").toString("base64"));
  assert.equal(pictureTypeOf(head("\xff\xd8\xff\xe0\x00\x10JFIF")), "image/jpeg");
  assert.equal(pictureTypeOf(head("\x89PNG\r\n\x1a\n\x00\x00")), "image/png");
  assert.equal(pictureTypeOf(head("GIF89a")), "image/gif");
  assert.equal(pictureTypeOf(head("RIFF\x10\x00\x00\x00WEBPVP8 ")), "image/webp");
  assert.equal(pictureTypeOf(head("\x00\x00\x00\x18ftypheic\x00\x00")), "image/heic");
  assert.equal(pictureTypeOf(head("%PDF-1.7")), null);
  assert.equal(pictureTypeOf([]), null);

  const heicAsJpeg = readPickedImage(
    { uri: "file:///cache/a.jpeg", fileName: "IMG_0001.HEIC", mimeType: "image/heic", fileSize: 7_000_000 },
    { type: "image/jpeg", size: 1_200_000 },
  );
  assert.deepEqual(heicAsJpeg, {
    ok: true,
    image: { uri: "file:///cache/a.jpeg", name: "IMG_0001.jpg", mediaType: "image/jpeg" },
  });
  assert.equal(
    readPickedImage({ uri: "file:///b.gif", fileName: "b.gif", mimeType: "image/gif" }, { type: "image/jpeg" }).image.mediaType,
    "image/jpeg",
  );
  assert.equal(readPickedImage({ uri: "file:///c", fileName: "c.heic" }, { type: "image/heic" }).ok, false);
  assert.equal(readPickedImage({ uri: "file:///d", mimeType: "image/png" }, { type: null, size: null }).image.mediaType, "image/png");
  assert.equal(readPickedImage({ uri: "file:///e", fileName: "notes" }, { type: "image/png" }).image.name, "notes");
  assert.deepEqual(readPickedImage({ uri: "file:///f", mimeType: "image/jpeg" }, { size: CHAT_IMAGE_MAX_BYTES + 1 }), {
    ok: false,
    message: "Choose an image smaller than 5 MB.",
  });
});

test("a picture over 5 MB is refused before upload, unless the desktop sizes pictures itself", () => {
  assert.equal(chatImageMaxBytes(false), 5 * 1024 * 1024);
  assert.equal(chatImageMaxBytes(true), 20 * 1024 * 1024);
  const photo = { uri: "file:///camera.jpg", mimeType: "image/jpeg", fileName: "camera.jpg" };
  const twelveMegabytes = { size: 12 * 1024 * 1024 };
  assert.deepEqual(readPickedImage(photo, twelveMegabytes, chatImageMaxBytes(false)), {
    ok: false,
    message: "Choose an image smaller than 5 MB.",
  });
  assert.equal(readPickedImage(photo, twelveMegabytes, chatImageMaxBytes(true)).ok, true);
  assert.deepEqual(readPickedImage(photo, { size: CHAT_IMAGE_DOWNSCALED_MAX_BYTES + 1 }, chatImageMaxBytes(true)), {
    ok: false,
    message: "Choose an image smaller than 20 MB.",
  });
  // Without a limit given, the older desktop's is the one applied.
  assert.equal(readPickedImage(photo, twelveMegabytes).ok, false);
});

test("New's + ends with Schedule, which waits on nothing but the attachments", () => {
  const rows = composerOptions({ startAs: phone, attach: { held: 0, max: 4, busy: false }, schedule: { busy: false } });
  assert.deepEqual(rows.at(-1), { kind: "schedule", label: "Schedule", disabledReason: null });
  assert.equal(composerOptionsLabel(rows), "Attach or schedule");
  const holding = composerOptions({ startAs: phone, attach: { held: 1, max: 4, busy: false }, schedule: { busy: false } });
  assert.equal(holding.at(-1).disabledReason, "Each run starts from words alone: remove the attachments to schedule it.");
  const adding = composerOptions({ startAs: phone, attach: { held: 0, max: 4, busy: true }, schedule: { busy: true } });
  assert.equal(adding.at(-1).disabledReason, "Wait for the last attachment.");
  const alone = composerOptions({ startAs: phone, attach: null, schedule: { busy: false } });
  assert.equal(composerHasOptions(alone), true);
  assert.equal(composerOptionsLabel(alone), "Schedule");
  assert.equal(
    composerOptions({ startAs: phone, attach: { held: 0, max: 4, busy: false }, schedule: null }).some((row) => row.kind === "schedule"),
    false,
    "a chat, or a read-only pairing, has no Schedule",
  );
});
