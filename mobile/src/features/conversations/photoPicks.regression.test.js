/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

// Several photos from the library in one pick. The library is opened for the
// room the message still has (the desktop takes sixteen uploads a send,
// photos and files together), each photo is read and refused on its own, and
// each joins the tray as it uploads, so a failure part way keeps the rest.

const buildRoot = path.resolve(__dirname, "../../../.mobile-test-build");
const { librarySelection, readPickedImages, uploadEach } = require(
  path.join(buildRoot, "src/features/conversations/photoPicks.js"),
);
const { CHAT_IMAGE_MAX_BYTES, chatImageMaxBytes } = require(
  path.join(buildRoot, "src/features/conversations/composerOptions.js"),
);
const { CONVERSATION_MAX_IMAGES } = require(path.join(buildRoot, "src/api/conversationWire.js"));

const jpeg = (name, size = 1024) => ({
  asset: { uri: `file:///cache/${name}`, fileName: name, mimeType: "image/jpeg", fileSize: size },
  inspected: { type: "image/jpeg", size },
});

test("the library opens for as many photos as the message has room for", () => {
  assert.equal(CONVERSATION_MAX_IMAGES, 16);
  assert.deepEqual(librarySelection(0, CONVERSATION_MAX_IMAGES), { allowsMultipleSelection: true, selectionLimit: 16 });
  assert.deepEqual(librarySelection(13, CONVERSATION_MAX_IMAGES), { allowsMultipleSelection: true, selectionLimit: 3 });
});

test("room for one opens the library for one, and a full tray does not open it", () => {
  // A limit of 0 would be the platform's own maximum, so it is never sent.
  assert.deepEqual(librarySelection(15, 16), { allowsMultipleSelection: false, selectionLimit: 1 });
  assert.equal(librarySelection(16, 16), null);
  assert.equal(librarySelection(20, 16), null);
});

test("several photos are added in the order they were picked", () => {
  const read = readPickedImages([jpeg("a.jpg"), jpeg("b.jpg"), jpeg("c.jpg")], CHAT_IMAGE_MAX_BYTES, 16);
  assert.deepEqual(
    read.images.map((image) => image.name),
    ["a.jpg", "b.jpg", "c.jpg"],
  );
  assert.equal(read.problem, null);
});

test("each photo is held to the size limit on its own, and the rest are still added", () => {
  const big = jpeg("big.jpg", CHAT_IMAGE_MAX_BYTES + 1);
  const read = readPickedImages([jpeg("a.jpg"), big, jpeg("c.jpg")], chatImageMaxBytes(false), 16);
  assert.deepEqual(
    read.images.map((image) => image.name),
    ["a.jpg", "c.jpg"],
  );
  assert.equal(read.problem, "One of the 3 photos was left out. Choose an image smaller than 5 MB.");
  // A desktop that sizes pictures itself takes the same photo.
  assert.equal(readPickedImages([big], chatImageMaxBytes(true), 16).images.length, 1);
});

test("a pick of one that cannot be sent says only why, as a single pick always has", () => {
  const heic = { asset: { uri: "file:///cache/h.heic", fileName: "h.heic" }, inspected: { type: "image/heic" } };
  assert.deepEqual(readPickedImages([heic], CHAT_IMAGE_MAX_BYTES, 16), {
    images: [],
    problem: "Choose a JPEG, PNG, GIF, or WebP image.",
  });
});

test("different reasons are each said once", () => {
  const heic = (name) => ({ asset: { uri: `file:///cache/${name}`, fileName: name }, inspected: { type: "image/heic" } });
  const big = jpeg("big.jpg", CHAT_IMAGE_MAX_BYTES + 1);
  const read = readPickedImages([heic("x.heic"), heic("y.heic"), big, jpeg("ok.jpg")], CHAT_IMAGE_MAX_BYTES, 16);
  assert.deepEqual(
    read.images.map((image) => image.name),
    ["ok.jpg"],
  );
  assert.equal(
    read.problem,
    "3 of the 4 photos were left out. Choose a JPEG, PNG, GIF, or WebP image. Choose an image smaller than 5 MB.",
  );
});

test("no more than the room is kept, even where a picker hands back more", () => {
  const read = readPickedImages([jpeg("a.jpg"), jpeg("b.jpg"), jpeg("c.jpg")], CHAT_IMAGE_MAX_BYTES, 2);
  assert.deepEqual(
    read.images.map((image) => image.name),
    ["a.jpg", "b.jpg"],
  );
  assert.equal(read.problem, "One photo was left out: the message had room for 2 more.");
});

test("the same photo twice in one pick is added once", () => {
  const read = readPickedImages([jpeg("a.jpg"), jpeg("a.jpg")], CHAT_IMAGE_MAX_BYTES, 16);
  assert.equal(read.images.length, 1);
  assert.equal(read.problem, null);
});

test("each photo joins the tray as it uploads, in order, and a failure keeps the rest", async () => {
  const added = [];
  const problem = await uploadEach(
    [{ name: "a.jpg" }, { name: "b.jpg" }, { name: "c.jpg" }],
    async (image) => {
      if (image.name === "b.jpg") throw new Error("The desktop refused the image upload.");
      return { id: `id-${image.name}`, name: image.name };
    },
    (uploaded) => added.push(uploaded.id),
  );
  assert.deepEqual(added, ["id-a.jpg", "id-c.jpg"]);
  assert.equal(problem, "b.jpg did not upload: The desktop refused the image upload.");
});

test("uploads go one at a time, never together", async () => {
  let inFlight = 0;
  let most = 0;
  await uploadEach(
    [{ name: "a" }, { name: "b" }, { name: "c" }],
    async (image) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return image.name;
    },
    () => {},
  );
  assert.equal(most, 1);
});

test("a single upload that fails says the desktop's reason alone, and all failing says so", async () => {
  const refuse = async () => {
    throw new Error("Desktop unavailable.");
  };
  assert.equal(await uploadEach([{ name: "a.jpg" }], refuse, () => {}), "Desktop unavailable.");
  assert.equal(
    await uploadEach([{ name: "a.jpg" }, { name: "b.jpg" }], refuse, () => {}),
    "None of the 2 photos uploaded: Desktop unavailable.",
  );
  assert.equal(await uploadEach([{ name: "a.jpg" }], async () => "id", () => {}), null);
});
