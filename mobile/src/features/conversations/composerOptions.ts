// What the composer's "+" holds, on New and in a chat (as in the desktop's
// New chat composer). Pure, so the regression suite
// reads the sheet the screens draw.
//
// The desktop's "+" opens "Start as" (Conversation, Terminal agent,
// Terminal), Attach files, Skills, plugins & MCPs, and Schedule. The phone
// carries what it can act on:
//
//   - Start as: the phone starts chats only, so it has one choice. The desktop
//     draws the section only when there is more than one, and so does the
//     phone: a group holding the one fixed answer asks nothing.
//   - Attach: a photo from the library, or one taken now, and a file of any
//     type where the desktop takes one (`conversation-message-files`).
//   - Schedule, on New only: the words, the project and the agent go to New
//     scheduled agent, which makes a schedule on the desktop through its
//     `schedule.create` tool rather than starting a chat. It is offered where
//     the pairing may operate the desktop, and a schedule takes words only.
//   - Plan mode and Goal are not offered: the conversation protocol the phone
//     speaks does not carry them yet.

/** How a launch starts. The phone's protocol starts a conversation and nothing else. */
export type StartAs = "conversation" | "terminal-agent" | "terminal";

/** What the phone may start. */
export const PHONE_START_AS: readonly StartAs[] = ["conversation"];

export const START_AS_LABELS: Record<StartAs, string> = {
  conversation: "Conversation",
  "terminal-agent": "Terminal agent",
  terminal: "Terminal",
};

export type AttachSource = "library" | "camera" | "file";

export type ComposerOption =
  | { kind: "start-as"; label: "Start as"; choices: readonly StartAs[]; selected: StartAs }
  | { kind: "attach"; source: AttachSource; label: string; disabledReason: string | null }
  | { kind: "schedule"; label: "Schedule"; disabledReason: string | null };

export const ATTACH_LABELS: Record<AttachSource, string> = {
  library: "Choose a photo",
  camera: "Take a photo",
  file: "Choose a file",
};

/**
 * The "+" sheet's rows, top to bottom.
 *
 * `attach` is null where the composer takes nothing (no session to upload
 * to); then the rows are not drawn, rather than drawn and refused. Within it,
 * `pictures: false` leaves the photo rows off (the chat's agent cannot read
 * one) and `files: true` adds the file row (the desktop declares
 * `conversation-message-files`). A full tray keeps the rows and says why they
 * are off: photos and files count toward the one limit, since a send carries
 * both as its uploads.
 *
 * `schedule` adds the Schedule row last, where New may schedule on the
 * desktop; null or absent leaves it off (a chat, or a read-only pairing).
 * A schedule's runs start from its prompt alone, so while anything is
 * attached the row stays and says so.
 */
export function composerOptions(input: {
  startAs: { offered: readonly StartAs[]; selected: StartAs };
  attach: { held: number; max: number; busy: boolean; pictures?: boolean; files?: boolean } | null;
  schedule?: { busy: boolean } | null;
}): ComposerOption[] {
  const rows: ComposerOption[] = [];
  const offered = input.startAs.offered.filter((kind, index, all) => all.indexOf(kind) === index);
  if (offered.length > 1) {
    rows.push({ kind: "start-as", label: "Start as", choices: offered, selected: input.startAs.selected });
  }
  if (input.attach) {
    const { held, max, busy, pictures = true, files = false } = input.attach;
    const things = files ? "attachments" : "pictures";
    const disabledReason = busy
      ? files
        ? "Adding the last attachment…"
        : "Adding the last picture…"
      : held >= max
        ? `${max} ${things} is the most one message takes.`
        : null;
    const sources: AttachSource[] = [...(pictures ? (["library", "camera"] as const) : []), ...(files ? (["file"] as const) : [])];
    for (const source of sources) {
      rows.push({ kind: "attach", source, label: ATTACH_LABELS[source], disabledReason });
    }
  }
  if (input.schedule) {
    const held = input.attach?.held ?? 0;
    const disabledReason = input.schedule.busy
      ? "Wait for the last attachment."
      : held > 0
        ? "Each run starts from words alone: remove the attachments to schedule it."
        : null;
    rows.push({ kind: "schedule", label: "Schedule", disabledReason });
  }
  return rows;
}

/**
 * What a screen reader says for the "+": what is behind it. "Options" names
 * nothing, so while attachments are all the sheet holds it says which, as the
 * sheet's own title does.
 */
export function composerOptionsLabel(rows: readonly ComposerOption[]): string {
  if (rows.some((row) => row.kind === "start-as")) return "Options";
  const scheduled = rows.some((row) => row.kind === "schedule");
  if (scheduled && !rows.some((row) => row.kind === "attach")) return "Schedule";
  if (scheduled) return "Attach or schedule";
  const sources = rows.flatMap((row) => (row.kind === "attach" ? [row.source] : []));
  const photos = sources.some((source) => source !== "file");
  const files = sources.includes("file");
  return photos && files ? "Attach a photo or file" : files ? "Attach a file" : "Attach a photo";
}

/** Whether the composer draws a "+" at all: only when its sheet would hold a row. */
export function composerHasOptions(rows: readonly ComposerOption[]): boolean {
  return rows.length > 0;
}

/** The image types a chat takes, as the desktop's upload accepts them. */
export const CHAT_IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
/** The largest picture a desktop's upload takes, unless it sizes pictures itself. */
export const CHAT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * The largest picture a desktop that advertises `conversation-image-downscale`
 * takes: it scales a picture down before the model sees it, so a phone photo
 * straight off the camera need not be refused here first.
 */
export const CHAT_IMAGE_DOWNSCALED_MAX_BYTES = 20 * 1024 * 1024;

/** The largest picture worth uploading to a desktop, by whether it sizes pictures itself. */
export function chatImageMaxBytes(desktopDownscales: boolean): number {
  return desktopDownscales ? CHAT_IMAGE_DOWNSCALED_MAX_BYTES : CHAT_IMAGE_MAX_BYTES;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A picture the picker handed back, before it is uploaded. */
export interface PickedImage {
  uri: string;
  name: string;
  mediaType: string;
}

/**
 * What a picture's first bytes say it is: one of the four types a chat takes,
 * HEIC, or null for anything else. The pickers' own word is about the photo
 * they started from, not always the file they wrote (Android writes a JPEG
 * for a HEIC, GIF or WebP photo it compresses, and keeps the original's type
 * and size), and the desktop hands the type on to the model as given.
 */
export function pictureTypeOf(head: ArrayLike<number>): string | null {
  const at = (index: number) => head[index] ?? -1;
  const ascii = (from: number, to: number) => {
    let text = "";
    for (let index = from; index < to; index++) text += String.fromCharCode(at(index));
    return text;
  };
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x89 && ascii(1, 4) === "PNG" && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a)
    return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(8, 12))) return "image/heic";
  return null;
}
const HEIC_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"]);

/** Base64 to bytes, for the few bytes `pictureTypeOf` reads; anything not base64 is skipped. */
export function bytesFromBase64(text: string): number[] {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = alphabet.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes;
}

/**
 * A picked asset as the composer holds it, or why it cannot be sent. What the
 * file itself says (`inspected`: its first bytes' type and its size on disk)
 * outranks the picker's word; failing that the picker's own type is used when
 * it gives one, JPEG when it does not. A name is made up for a picture the
 * library does not name, and a name whose extension says another type than the
 * file is sent under is given the right one.
 */
export function readPickedImage(
  asset: {
    uri: string;
    fileName?: string | null;
    mimeType?: string | null;
    fileSize?: number | null;
  },
  inspected?: { type?: string | null; size?: number | null },
  maxBytes: number = CHAT_IMAGE_MAX_BYTES,
): { ok: true; image: PickedImage } | { ok: false; message: string } {
  const size = typeof inspected?.size === "number" ? inspected.size : asset.fileSize;
  if (typeof size === "number" && size > maxBytes) {
    return { ok: false, message: `Choose an image smaller than ${Math.round(maxBytes / (1024 * 1024))} MB.` };
  }
  // The desktop reads the type case-blind; "image/jpg" is a spelling some
  // Android galleries give JPEG, and the desktop knows only "image/jpeg".
  const given = inspected?.type || asset.mimeType?.trim().toLowerCase() || "image/jpeg";
  const mediaType = given === "image/jpg" ? "image/jpeg" : given;
  if (!CHAT_IMAGE_TYPES.includes(mediaType)) {
    return { ok: false, message: "Choose a JPEG, PNG, GIF, or WebP image." };
  }
  // The desktop refuses an upload with no name, and a picker can hand back an
  // empty one, so a blank name is made up like a missing one.
  const extension = IMAGE_EXTENSIONS[mediaType] ?? "jpg";
  const picked = asset.fileName?.trim();
  const name = !picked
    ? `image.${extension}`
    : inspected?.type && /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/iu.test(picked) && !nameFits(picked, mediaType)
      ? picked.replace(/\.[^.]+$/u, `.${extension}`)
      : picked;
  return { ok: true, image: { uri: asset.uri, name, mediaType } };
}

function nameFits(name: string, mediaType: string): boolean {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return mediaType === "image/jpeg" ? extension === "jpg" || extension === "jpeg" : IMAGE_EXTENSIONS[mediaType] === extension;
}
