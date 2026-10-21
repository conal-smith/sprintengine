// Files of any type a person attaches to a chat's message, beside its photos.
// No react-native import, so `node --test` can pin it.
//
// A desktop that declares `conversation-message-files` takes a file on its
// upload route with `kind=file`, up to 25 MB, keeps it in Studio's own data
// folder (never the project's), and answers an upload id. The send names that
// id beside any photo's, and the desktop attaches the file to the message by
// its path there: the agent is told where it is, and the `user_message` lists
// it in `files`, which the bubble draws as a card (attachedFiles.ts).
//
// The picker is expo-file-system's own (`File.pickFileAsync`), already in the
// app, so no new native module and no new build: pickChatFile.ts.

/** The largest file a desktop takes with a message, as its upload route caps it. */
export const CHAT_FILE_MAX_BYTES = 25 * 1024 * 1024;

/** A file the picker handed back, before it is uploaded. */
export interface PickedFile {
  uri: string;
  name: string;
  mediaType: string;
}

// The extension a name is given when the picker's uri carries none: the kinds
// a message usually attaches. Anything else goes without one.
const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/html": "html",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
};

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u;

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// The prefixes Android's document providers put before a document's id:
// external storage (`primary`, an SD card's `1234-ABCD`), a download's path
// (`raw`), and the ids of downloads and media (`msf`, `document`, `image`…).
const PROVIDER_PREFIX = /^(?:raw|primary|home|secondary|msf|document|image|video|audio|[0-9A-F]{4}-[0-9A-F]{4}):/iu;

/**
 * What a picked file is called, from its uri. iOS hands back a copy whose uri
 * ends in the file's own name. Android hands back a document uri whose last
 * segment is the provider's id for it: `raw:/storage/emulated/0/Download/report.pdf`
 * or `primary:Download/report.pdf` names the file after its last slash, while
 * `msf:1234` names nothing, and gets `file` with the extension its type says.
 * The desktop makes the name safe again either way.
 */
export function pickedFileName(uri: string, mediaType?: string | null): string {
  const path = uri.split(/[?#]/u)[0] ?? "";
  const segment = decoded(path.split("/").filter(Boolean).pop() ?? "");
  const tail = segment.split("/").filter(Boolean).pop() ?? "";
  const named = PROVIDER_PREFIX.test(tail) ? tail.slice(tail.indexOf(":") + 1) : tail;
  const clean = named.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  // A bare provider id (all digits) is not a name a person would recognise.
  const base = clean && !/^\d+$/u.test(clean) ? clean : "file";
  if (/\.[A-Za-z0-9]{1,8}$/u.test(base)) return base;
  const extension = mediaType ? EXTENSIONS[mediaType.trim().toLowerCase()] : undefined;
  return extension ? `${base}.${extension}` : base;
}

/** A size as the line refusing it says it: whole megabytes. */
function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * A picked file as the composer holds it, or why it cannot be sent. Too
 * large is refused here, before a byte goes, with the limit named; the
 * desktop refuses it too, since this is only a courtesy. An empty file is
 * refused because the agent would be told about nothing. The type is the
 * picker's word when it is a media type, else plain bytes, and the name is
 * read off the uri (`pickedFileName`).
 */
export function readPickedFile(
  picked: { uri: string; size?: number | null; type?: string | null },
  maxBytes: number = CHAT_FILE_MAX_BYTES,
): { ok: true; file: PickedFile } | { ok: false; message: string } {
  if (typeof picked.size === "number" && picked.size > maxBytes) {
    return { ok: false, message: `Choose a file smaller than ${megabytes(maxBytes)}.` };
  }
  if (picked.size === 0) return { ok: false, message: "That file is empty." };
  const type = picked.type?.trim().toLowerCase() ?? "";
  const mediaType = MEDIA_TYPE.test(type) ? type : "application/octet-stream";
  return { ok: true, file: { uri: picked.uri, name: pickedFileName(picked.uri, mediaType), mediaType } };
}

// The files this phone uploaded, by upload id, so a message still on its way
// draws each as a file card rather than as a photo square. A send carries only
// ids; the names are known here, where the file was picked. Kept for this run
// only and bounded: once the desktop has the message, its own `files` say
// what the message carried.
const MAX_REMEMBERED = 64;
const ownFiles = new Map<string, string>();

/** A file this phone uploaded, under the id the desktop gave it. */
export function rememberSentFile(uploadId: string, name: string): void {
  if (!uploadId || !name) return;
  ownFiles.delete(uploadId);
  ownFiles.set(uploadId, name);
  while (ownFiles.size > MAX_REMEMBERED) ownFiles.delete(ownFiles.keys().next().value!);
}

/** The name of a file this phone uploaded under that id; undefined for a photo, or one it does not know. */
export function sentFileName(uploadId: string): string | undefined {
  return ownFiles.get(uploadId);
}

/** A message's upload ids, split into the photos and the files among them, each in the order sent. */
export function splitSentUploads(uploadIds: readonly string[]): { photos: string[]; files: { id: string; name: string }[] } {
  const photos: string[] = [];
  const files: { id: string; name: string }[] = [];
  for (const id of uploadIds) {
    const name = ownFiles.get(id);
    if (name) files.push({ id, name });
    else photos.push(id);
  }
  return { photos, files };
}

/** What a message still on its way says in place of words it has none of. */
export function attachmentsOnlyText(uploadIds: readonly string[]): string {
  const { photos, files } = splitSentUploads(uploadIds);
  if (!files.length) return "Images";
  if (!photos.length) return files.length === 1 ? files[0]!.name : "Files";
  return "Attachments";
}
