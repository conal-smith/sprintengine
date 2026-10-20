/* global __dirname */
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const build = path.resolve(__dirname, "../../../.mobile-test-build/src/features/conversations");
const { fitPicture, isConversationImagePath, toolPicture } = require(path.join(build, "conversationImageLogic.js"));
const { toolStep } = require(path.join(build, "conversationLogic.js"));

test("a path names a picture by its extension, in any case", () => {
  for (const file of ["a.png", "b.jpg", "c.jpeg", "d.webp", "e.gif", "SHOT.PNG", "Photo.JpEg", "/tmp/x/y.WebP", "C:\\shots\\z.GIF", " spaced.png "])
    assert.equal(isConversationImagePath(file), true, file);
  // An SVG is markup the agent read as text; the rest are not pictures the phone draws.
  for (const file of ["icon.svg", "notes.txt", "png", "archive.png.zip", "image.pngx", "photo.heic", "", ".png/readme"])
    assert.equal(isConversationImagePath(file), false, file);
});

test("a generated picture shows inline once saved and done, captioned with its prompt", () => {
  const generated = (status, input) => ({ id: "ig_1", name: "GenerateImage", kind: "other", status, input });
  const saved = { prompt: "A flat orange circle", path: "/data/conversation-images/s/ig_1.png" };
  assert.deepEqual(toolPicture(generated("ok", saved)), {
    placement: "inline",
    label: "A flat orange circle",
    caption: "A flat orange circle",
  });
  assert.deepEqual(toolPicture(generated("ok", { path: saved.path })), { placement: "inline", label: "Generated image" });
  // Still running, not saved yet, or it went wrong: nothing to fetch.
  assert.equal(toolPicture(generated("running", saved)), null);
  assert.equal(toolPicture(generated("ok", { prompt: "A flat orange circle" })), null);
  assert.equal(toolPicture(generated("error", saved)), null);
  assert.equal(toolPicture(generated("stopped", saved)), null);
});

test("an image the agent read shows when its step opens, named by its file", () => {
  const read = (input, status = "ok", extra = {}) => ({ id: "r", name: "Read", status, input, ...extra });
  assert.deepEqual(toolPicture(read({ path: "/tmp/Screen Shot.PNG" })), { placement: "expanded", label: "Screen Shot.PNG" });
  // Claude's Read names its file `file_path`; Codex's imageView arrives as Read `path`.
  assert.deepEqual(toolPicture(read({ file_path: "shots/login.webp" })), { placement: "expanded", label: "login.webp" });
  assert.deepEqual(toolPicture(read({ path: "a.jpg" }, "ok", { kind: "file_read", name: "imageView" })), { placement: "expanded", label: "a.jpg" });
  assert.equal(toolPicture(read({ path: "src/app.ts" })), null);
  assert.equal(toolPicture(read({ path: "logo.svg" })), null);
  assert.equal(toolPicture(read({ path: "a.png" }, "running")), null);
  assert.equal(toolPicture(read({ path: "a.png" }, "error")), null);
  // A write of a picture is not a picture the agent looked at.
  assert.equal(toolPicture({ id: "w", name: "Write", status: "ok", input: { path: "a.png" } }), null);
});

test("a generated picture's step reads as the desktop names it", () => {
  const step = toolStep({ id: "ig_1", name: "GenerateImage", kind: "other", status: "ok", input: {} });
  assert.equal(step.label, "Generated image");
  assert.equal(step.detail, "");
  assert.equal(toolStep({ id: "ig_1", name: "GenerateImage", kind: "other", status: "running", input: {} }).label, "Generating image");
  // A tool the presentation has no words for still names itself.
  const other = toolStep({ id: "t", name: "Frobnicate", status: "ok", input: {} });
  assert.equal(other.label, "Called");
  assert.equal(other.detail, "Frobnicate");
});

test("a picture keeps its proportions inside the column and its height cap", () => {
  const bounds = { maxWidth: 300, maxHeight: 320 };
  assert.deepEqual(fitPicture({ width: 1024, height: 1024 }, bounds), { width: 300, height: 300 });
  assert.deepEqual(fitPicture({ width: 1536, height: 1024 }, bounds), { width: 300, height: 200 });
  // Tall: the height cap decides, and the width follows.
  assert.deepEqual(fitPicture({ width: 1024, height: 1536 }, bounds), { width: 213, height: 320 });
  // Small pictures are not blown up.
  assert.deepEqual(fitPicture({ width: 64, height: 48 }, bounds), { width: 64, height: 48 });
  // Nothing measured yet: a box the width of the column.
  assert.deepEqual(fitPicture({ width: 0, height: 0 }, bounds), { width: 300, height: 300 });
});
