// Several photos from the library in one pick, on New and in a chat. Pure, so
// the regression suite reads the same rules the screens follow.
//
// A message carries at most `CONVERSATION_MAX_IMAGES` uploads (the desktop
// refuses a send naming more), photos and files counted together, so the
// library is opened for the room the tray still has and never more. Each
// photo is read and refused on its own: one HEIC or one over the size limit
// is left out with the reason, and the rest are added. The camera takes one.

import { readPickedImage, type PickedImage } from "./composerOptions";

/** What the library is opened with: as many as the tray has room for, one at a time when that is one. */
export function librarySelection(
  held: number,
  max: number,
): { allowsMultipleSelection: boolean; selectionLimit: number } | null {
  const room = Math.floor(max - held);
  if (!(room > 0)) return null;
  // A limit of 0 is the platform's own maximum, never what is meant here.
  return room > 1 ? { allowsMultipleSelection: true, selectionLimit: room } : { allowsMultipleSelection: false, selectionLimit: 1 };
}

/** One asset the picker handed back, with what its written file says (see `readPickedImage`). */
export interface InspectedAsset {
  asset: { uri: string; fileName?: string | null; mimeType?: string | null; fileSize?: number | null };
  inspected?: { type?: string | null; size?: number | null };
}

/**
 * The photos a pick adds, in the order they were picked, and why any were
 * left out: null when every one was added. No more than `room` are kept, in
 * case a picker hands back more than it was asked for.
 */
export function readPickedImages(
  picks: readonly InspectedAsset[],
  maxBytes: number,
  room: number,
): { images: PickedImage[]; problem: string | null } {
  const images: PickedImage[] = [];
  const reasons: string[] = [];
  let refused = 0;
  for (const pick of picks) {
    const read = readPickedImage(pick.asset, pick.inspected, maxBytes);
    if (!read.ok) {
      refused++;
      if (!reasons.includes(read.message)) reasons.push(read.message);
      continue;
    }
    // The same photo twice in one pick is one photo.
    if (!images.some((image) => image.uri === read.image.uri)) images.push(read.image);
  }
  const kept = images.slice(0, Math.max(0, Math.floor(room)));
  const over = images.length - kept.length;
  const problems: string[] = [];
  if (refused) {
    // A pick of one says only why, as it always has.
    const count = refused === 1 ? `One of the ${picks.length} photos was` : `${refused} of the ${picks.length} photos were`;
    problems.push(picks.length === 1 ? reasons.join(" ") : `${count} left out. ${reasons.join(" ")}`);
  }
  if (over > 0) {
    problems.push(`${over === 1 ? "One photo was" : `${over} photos were`} left out: the message had room for ${kept.length} more.`);
  }
  return { images: kept, problem: problems.length ? problems.join(" ") : null };
}

/**
 * Uploads each picture in turn, handing each to `added` the moment it is on
 * the desktop, so a failure part way keeps those already sent in the tray.
 * Answers why any did not go, or null when all did.
 */
export async function uploadEach<Picked extends { name: string }, Uploaded>(
  images: readonly Picked[],
  upload: (image: Picked) => Promise<Uploaded>,
  added: (uploaded: Uploaded) => void,
): Promise<string | null> {
  const failures: { name: string; reason: string }[] = [];
  for (const image of images) {
    try {
      added(await upload(image));
    } catch (error) {
      failures.push({ name: image.name, reason: error instanceof Error && error.message ? error.message : "Image upload failed." });
    }
  }
  if (!failures.length) return null;
  if (images.length === 1) return failures[0].reason;
  const reasons = [...new Set(failures.map((failure) => failure.reason))].join(" ");
  return failures.length === images.length
    ? `None of the ${images.length} photos uploaded: ${reasons}`
    : `${failures.map((failure) => failure.name).join(", ")} did not upload: ${reasons}`;
}
