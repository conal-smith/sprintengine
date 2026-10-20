import { File } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";

import { CHAT_FILE_MAX_BYTES, readPickedFile, type PickedFile } from "./chatFiles";

/**
 * One file for a chat, from the system's document picker, as the chat picks
 * it: null when the person cancels, and an error saying why when the file
 * cannot be sent.
 *
 * expo-file-system's own picker (`File.pickFileAsync`), already in the app, so
 * this needs no new native module and no new build. iOS opens it as a copy in
 * the app's own temporary folder, a `file://` uri the uploader reads directly.
 * Android hands back a `content://` document uri, which the uploader cannot
 * read (it streams from a file), so the file is copied into the app's cache
 * first. The size is read off that file, not the picker's word, which is 0 for
 * a document it cannot stat.
 */
export async function pickChatFile(maxBytes: number = CHAT_FILE_MAX_BYTES): Promise<PickedFile | null> {
  let picked: File;
  try {
    const result = await File.pickFileAsync();
    const first = Array.isArray(result) ? result[0] : result;
    if (!first) return null;
    picked = first;
  } catch (error) {
    // Both platforms answer a cancel by rejecting.
    if (isCancel(error)) return null;
    throw new Error("The file could not be opened.");
  }
  const type = safely(() => picked.type) ?? null;
  // Refused before anything is copied, where the picker can say the size.
  const said = safely(() => picked.size) ?? 0;
  if (said > maxBytes) {
    const refused = readPickedFile({ uri: picked.uri, size: said, type }, maxBytes);
    if (!refused.ok) throw new Error(refused.message);
  }
  const local = picked.uri.startsWith("content:") ? await copyToCache(picked.uri) : picked.uri;
  const info = await LegacyFileSystem.getInfoAsync(local).catch(() => null);
  const size = info?.exists && typeof info.size === "number" ? info.size : said || null;
  const read = readPickedFile({ uri: picked.uri, size, type }, maxBytes);
  if (!read.ok) throw new Error(read.message);
  // The name is the picked document's; the bytes are read from the copy.
  return { ...read.file, uri: local };
}

async function copyToCache(uri: string): Promise<string> {
  const directory = LegacyFileSystem.cacheDirectory;
  if (!directory) throw new Error("The file could not be opened.");
  const to = `${directory}chat-file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await LegacyFileSystem.copyAsync({ from: uri, to });
  } catch {
    throw new Error("The file could not be read.");
  }
  return to;
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function isCancel(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  return (typeof code === "string" && /cancel/iu.test(code)) || /cancel/iu.test(message);
}
