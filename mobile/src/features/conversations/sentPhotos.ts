// The pictures a person sent with a message, as their bubble draws them: a
// small square of each, as the desktop's sent bubble has. No react-native
// import, so `node --test` can pin it.
//
// The desktop records each picture a turn carried on its `user_message`, as
// `attachments: [{ id, mediaType, name?, byteLength, ref }]`: `id` is the
// upload id the sending device named it by, and `ref` where the desktop's
// attachment store keeps its bytes. The bytes are never on the wire.
//
// So a square is drawn from the first of these that has the picture:
// - the phone's own copy, for a photo this phone sent: it was picked or taken
//   here, and its file is still on the phone. Kept by upload id from the
//   moment it uploads, so the message shows it before the desktop has echoed
//   the message and after, without a fetch;
// - the desktop, by `ref`, where it declares `conversation-message-images`;
// - neither: the picture's name, in the square the picture would have filled,
//   as the desktop draws a picture it no longer has.

export type SentImage = {
  /** The upload id the sending device named it by: what finds the phone's own copy. */
  id: string;
  /** The picture's name as it was sent, when it had one. */
  name?: string;
  /** Where the desktop keeps it (`<folder>/<file>`), when it kept it. */
  ref?: string;
};

/** The most pictures one message carries: the desktop's per-turn limit, and the most squares drawn. */
export const MAX_SENT_IMAGES = 16;
const MAX_ID_CHARS = 200;
const MAX_NAME_CHARS = 255;
// The shape of a reference the desktop's store chose: its folder for the chat,
// a random file name, and the extension of the picture's type.
const REF_PATTERN = /^[0-9a-f]{32}\/[0-9a-f-]{36}\.[a-z]+$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= max && !CONTROL.test(text) ? text : undefined;
}

/**
 * A `user_message` payload's `attachments`, as the squares its bubble draws;
 * empty for anything else. An entry without an id is skipped rather than
 * costing the message its other pictures; a ref not in the store's shape is
 * left off, so that picture is named rather than asked for.
 */
export function parseSentImages(value: unknown): SentImage[] {
  if (!Array.isArray(value)) return [];
  const images: SentImage[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (images.length >= MAX_SENT_IMAGES) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const entry = candidate as Record<string, unknown>;
    const id = cleanText(entry.id, MAX_ID_CHARS);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = cleanText(entry.name, MAX_NAME_CHARS);
    const ref = typeof entry.ref === "string" && REF_PATTERN.test(entry.ref) ? entry.ref : undefined;
    images.push({ id, ...(name ? { name } : {}), ...(ref ? { ref } : {}) });
  }
  return images;
}

// The phone's own copies, by upload id: where each photo it uploaded is on
// the phone. Outliving the chat screen that sent them, and the app too (its
// storage restores them at start, storage/sentPhotoCopies.ts): a desktop
// that does not serve sent pictures would otherwise leave a photo the phone
// still has drawn as its name after a restart. Bounded, oldest first out.
const MAX_REMEMBERED = 64;
const ownCopies = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Hear that the phone's copies changed; returns what stops the hearing. */
export function subscribeSentPhotos(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A number that moves whenever the copies do, for a view that reads them. */
export function sentPhotosVersion(): number {
  return version;
}

/** The copies as kept, oldest first: what the storage writes. */
export function sentPhotoEntries(): [string, string][] {
  return [...ownCopies];
}

/**
 * The copies a past run kept, put back under the ones this run already has:
 * a photo uploaded since start is the newer word on where it is. Entries that
 * are not two strings are skipped.
 */
export function restoreSentPhotos(entries: unknown): void {
  if (!Array.isArray(entries)) return;
  const current = [...ownCopies];
  ownCopies.clear();
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
    if (entry[0] && entry[1]) ownCopies.set(entry[0], entry[1]);
  }
  for (const [id, uri] of current) {
    ownCopies.delete(id);
    ownCopies.set(id, uri);
  }
  while (ownCopies.size > MAX_REMEMBERED) ownCopies.delete(ownCopies.keys().next().value!);
  changed();
}

/** A photo this phone uploaded, under the id the desktop gave it, at the uri it was picked from. */
export function rememberSentPhoto(uploadId: string, uri: string): void {
  if (!uploadId || !uri) return;
  ownCopies.delete(uploadId);
  ownCopies.set(uploadId, uri);
  while (ownCopies.size > MAX_REMEMBERED) ownCopies.delete(ownCopies.keys().next().value!);
  changed();
}

/** Where on the phone a photo it uploaded is; undefined for one it did not, or has let go of. */
export function sentPhotoUri(uploadId: string): string | undefined {
  return ownCopies.get(uploadId);
}

/** Lets go of the phone's copy, once it would not load (the picker's cache was cleared). */
export function forgetSentPhoto(uploadId: string): void {
  if (ownCopies.delete(uploadId)) changed();
}

/** What one square shows. */
export type SentImageShow = { kind: "local"; uri: string } | { kind: "desktop"; ref: string } | { kind: "named" };

/**
 * Where a square's picture comes from: the phone's copy, else the desktop
 * where it serves sent pictures and kept this one, else the picture's name.
 * `failed` names the sources that were tried and would not load.
 */
export function sentImageShows(
  image: SentImage,
  input: { localUri?: string; served: boolean; failed?: ReadonlySet<"local" | "desktop"> },
): SentImageShow {
  if (input.localUri && !input.failed?.has("local")) return { kind: "local", uri: input.localUri };
  if (input.served && image.ref && !input.failed?.has("desktop")) return { kind: "desktop", ref: image.ref };
  return { kind: "named" };
}

/** What a screen reader says for a square, and the name a square without its picture shows. */
export function sentImageLabel(image: SentImage, index: number, count: number): string {
  if (image.name) return image.name;
  return count > 1 ? `Image ${index + 1}` : "Image";
}
