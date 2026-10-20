const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  CHAT_FILE_MAX_BYTES,
  pickedFileName,
  readPickedFile,
  rememberSentFile,
  sentFileName,
  splitSentUploads,
} = require("../../../.mobile-test-build/src/features/conversations/chatFiles.js");
const { declaresMessageFiles } = require("../../../.mobile-test-build/src/api/tailnetTransport.js");
const { conversationFileUploadRefusal } = require("../../../.mobile-test-build/src/api/conversationImages.js");

// Files of any type a person attaches to a chat's message, beside its photos:
// offered where the desktop declares `conversation-message-files`, held with
// the name the person knows the file by, refused up front when the desktop
// would refuse it, and drawn as a file card while the message is on its way.

test("a desktop offers files only where it says it takes them", () => {
  assert.equal(declaresMessageFiles({ tailnetCapabilities: ["conversations", "conversation-message-files"] }), true);
  assert.equal(declaresMessageFiles({ tailnetCapabilities: ["conversations", "conversation-message-images"] }), false);
  // A desktop that declared nothing is an older one, which takes pictures only.
  assert.equal(declaresMessageFiles({}), false);
});

test("an iOS copy is named by the file's own name", () => {
  assert.equal(
    pickedFileName("file:///private/var/mobile/Containers/Data/Application/X/tmp/ai.sprintengine.mobile-Inbox/Quarterly%20report.pdf"),
    "Quarterly report.pdf",
  );
});

test("an Android document is named by the path its provider id carries", () => {
  assert.equal(
    pickedFileName(
      "content://com.android.providers.downloads.documents/document/raw%3A%2Fstorage%2Femulated%2F0%2FDownload%2Freport.pdf",
    ),
    "report.pdf",
  );
  assert.equal(
    pickedFileName("content://com.android.externalstorage.documents/document/primary%3ADocuments%2Fnotes.txt"),
    "notes.txt",
  );
});

test("an Android document whose id names nothing is a file, with the extension its type says", () => {
  assert.equal(
    pickedFileName("content://com.android.providers.downloads.documents/document/msf%3A1000000123", "application/pdf"),
    "file.pdf",
  );
  assert.equal(pickedFileName("content://com.android.providers.media.documents/document/document%3A42", null), "file");
});

test("a name with a colon of its own keeps it", () => {
  assert.equal(pickedFileName("file:///tmp/Inbox/Plan%3A%20v2.md"), "Plan: v2.md");
});

test("a picked file is held with its name and type", () => {
  assert.deepEqual(readPickedFile({ uri: "file:///tmp/Inbox/data.csv", size: 12, type: "text/csv" }), {
    ok: true,
    file: { uri: "file:///tmp/Inbox/data.csv", name: "data.csv", mediaType: "text/csv" },
  });
});

test("a type the picker cannot say goes as bytes", () => {
  const read = readPickedFile({ uri: "file:///tmp/Inbox/blob", size: 3, type: "" });
  assert.ok(read.ok);
  assert.equal(read.file.mediaType, "application/octet-stream");
  assert.equal(read.file.name, "blob");
});

test("a file over the desktop's limit is refused before it goes, with the limit named", () => {
  assert.equal(CHAT_FILE_MAX_BYTES, 25 * 1024 * 1024);
  assert.deepEqual(readPickedFile({ uri: "file:///tmp/Inbox/huge.zip", size: CHAT_FILE_MAX_BYTES + 1, type: "application/zip" }), {
    ok: false,
    message: "Choose a file smaller than 25 MB.",
  });
});

test("an empty file is refused, since the agent would be told about nothing", () => {
  assert.deepEqual(readPickedFile({ uri: "file:///tmp/Inbox/empty.txt", size: 0, type: "text/plain" }), {
    ok: false,
    message: "That file is empty.",
  });
});

test("a message on its way draws the files it carries as files, and the rest as photos", () => {
  rememberSentFile("upload-file-1", "report.pdf");
  assert.equal(sentFileName("upload-file-1"), "report.pdf");
  assert.equal(sentFileName("upload-photo-1"), undefined);
  assert.deepEqual(splitSentUploads(["upload-photo-1", "upload-file-1", "upload-photo-2"]), {
    photos: ["upload-photo-1", "upload-photo-2"],
    files: [{ id: "upload-file-1", name: "report.pdf" }],
  });
});

test("an older desktop's refusal of a file says to update it, not that the file is a bad picture", () => {
  assert.equal(
    conversationFileUploadRefusal(415, { error: { code: "invalid_media_type", message: "Only PNG, JPEG, WebP and GIF images can be attached." } }),
    "This desktop takes pictures only. Update Studio there to send files.",
  );
  assert.equal(
    conversationFileUploadRefusal(413, { error: { code: "too_large", message: "That file is over the 25MB limit." } }),
    "That file is over the 25MB limit.",
  );
  assert.equal(conversationFileUploadRefusal(500, null), "The desktop refused the file upload.");
});
