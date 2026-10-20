import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import type { ConversationKey } from "../api/conversationWire";
import {
  createConversationCacheStore,
  MAX_CACHE_CHARS,
  type CachedConversation,
} from "./conversationCacheModel";
export {
  boundedConversationCache,
  MAX_PENDING_SENDS,
  type CachedConversation,
} from "./conversationCacheModel";

const folder = () => new Directory(Paths.document, "conversation-cache");
const store = createConversationCacheStore({
  async keys() {
    const directory = folder();
    if (!directory.exists) return [];
    return directory
      .list()
      .filter((entry): entry is File => entry instanceof File)
      .map((entry) => entry.name);
  },
  async read(key) {
    const file = new File(folder(), key);
    if (!file.exists || (file.info().size ?? Infinity) > MAX_CACHE_CHARS * 4)
      return null;
    return file.text();
  },
  async write(key, text) {
    folder().create({ idempotent: true, intermediates: true });
    new File(folder(), key).write(text);
  },
  async remove(key) {
    const file = new File(folder(), key);
    if (file.exists) file.delete();
  },
});
// A chat's file name is a hash of its key, worked out once per run rather
// than by a native call on every load and every write while a reply streams.
const stems = new Map<string, Promise<string>>();
const stem = (deviceId: string, key: ConversationKey) => {
  const plain = `${deviceId}\0${key.workspaceId}\0${key.agentId}`;
  let hashed = stems.get(plain);
  if (!hashed) {
    hashed = Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, plain);
    stems.set(plain, hashed);
    // A failed hash is asked for again next time, not remembered.
    hashed.catch(() => stems.delete(plain));
  }
  return hashed;
};
export async function loadConversationCache(
  deviceId: string,
  key: ConversationKey,
): Promise<CachedConversation | null> {
  try {
    return await store.load(await stem(deviceId, key));
  } catch {
    return null;
  }
}
export async function saveConversationCache(
  deviceId: string,
  key: ConversationKey,
  value: CachedConversation,
): Promise<void> {
  await store.save(await stem(deviceId, key), value);
}

export async function updateConversationCache(
  deviceId: string,
  key: ConversationKey,
  updater: (current: CachedConversation) => CachedConversation,
): Promise<CachedConversation> {
  return store.update(await stem(deviceId, key), updater);
}
