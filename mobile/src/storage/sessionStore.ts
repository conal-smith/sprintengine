import { MobileSession } from "../api/types";
import { readFollowUpBehavior, type FollowUpBehavior } from "../features/conversations/followUp";
import type { ThemePreference } from "../theme/ThemeProvider";

export interface SessionStorageAdapter {
  isAvailable(): Promise<boolean>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

// The `multicode.mobile.*` prefix SURVIVES the SprintEngine rename, and
// deliberately:
//
// - It is invisible. Nothing renders a storage key, so it is not the product
//   naming itself at anyone — the rule the rename exists to satisfy.
// - Renaming it buys nothing. A bundle-identifier change already makes the
//   renamed build a DIFFERENT app to the OS, with its own empty keychain and its
//   own storage; there is no value under an old key for a new key to inherit.
//   Migrating would be code that can only ever run zero times.
// - Renaming it costs something. Every key here is load-bearing for a session, a
//   pairing, or a star, and a migration is a place to lose one.
//
// So this is a historical reference that is explained where it sits, which is
// what the identity epic's cross-cutting acceptance asks for.
// v3: the list holds tailnet pairings only, in their
// own shape. The v1 single-session key and the v2 list — which also held relay
// pairings — are read once by `sweepRelayRecords` (relayCleanup.ts), which moves
// the tailnet pairings here and deletes the rest.
export const legacySessionKey = "multicode.mobile.session.v1";
export const legacySessionListKey = "multicode.mobile.sessions.v2";
export const sessionListKey = "multicode.mobile.sessions.v3";
const themePreferenceKey = "multicode.mobile.theme.v1";
// Settings → Appearance → Agent characters, beside the theme it sits under.
const agentCharactersKey = "multicode.mobile.agentCharacters.v1";
// v2: a project's identity changed from its path to the desktop's
// `projectKey` token, so every v1 value names a project that can no longer be
// found. The current project would merely fall back, but a star is deliberately
// kept when its project is missing (an offline desktop must not silently unstar
// it) — so a v1 star would sit in the panel forever as "Not on the paired
// desktop". Bumping the key drops the stale values once instead. The cost is
// that existing stars are forgotten, which is the honest outcome: the phone
// cannot map an old path key onto a token it has never seen.
const currentProjectKey = "multicode.mobile.workspace.v2";
const starredProjectsKey = "multicode.mobile.starred.v2";
// What the chat list and the bell persist, and the only things they do: when
// this phone last opened each chat, which is the half of "finished while you
// were away" the desktop cannot know, and which can-wait notices have been
// read. Everything else on those screens is derived from state the phone
// already holds.
//
// The opened-at key keeps its `threadsOpened` name from when the list held
// terminal threads (removed 2026-09-29). It already holds the chats' own
// entries (`chat:<device>:<agent>`, see `chatOpenedKey`), so renaming it would
// be a migration whose only possible effect is losing some; the terminal
// session ids still in it are never looked up again and fall off under the
// 200-entry cap as chats are opened.
const chatsOpenedKey = "multicode.mobile.threadsOpened.v1";
const noticesReadKey = "multicode.mobile.noticesRead.v1";
// Held the "Tell me when an agent needs me" switch, which nothing ever acted
// on once push registration left with the relay. Only ever deleted now
// (`forgetRetiredNotes`).
const retiredNeedsMePushKey = "multicode.mobile.needsMePush.v1";
const groupChatsByProjectKey = "multicode.mobile.groupChatsByProject.v1";
const followUpBehaviorKey = "multicode.mobile.followUpBehavior.v1";

export interface StoredSessionList {
  schemaVersion: 3;
  sessions: MobileSession[];
  activeDeviceId: string | null;
}

const emptySessionList: StoredSessionList = { schemaVersion: 3, sessions: [], activeDeviceId: null };

// The explicit Light/Dark override from Settings. An absent or unreadable
// value means "no override recorded" — the provider then follows the system
// appearance rather than inventing a theme.
export const createThemePreferenceStore = (adapter: SessionStorageAdapter | null) => {
  let cachedPreference: ThemePreference | null = null;
  let cachedAgentCharacters: boolean | null = null;

  return {
    async getPreference(): Promise<ThemePreference | null> {
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) {
        return cachedPreference;
      }

      cachedPreference = readThemePreference(await activeAdapter.getItem(themePreferenceKey));
      return cachedPreference;
    },
    // Caching first keeps the choice applied for this session even when it
    // cannot be written. Rejecting afterwards is what lets Settings say so:
    // resolving here would report a durable save that never happened.
    async savePreference(preference: ThemePreference) {
      cachedPreference = preference;
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) {
        throw new Error("Secure storage is unavailable; the theme preference was not persisted.");
      }

      await activeAdapter.setItem(themePreferenceKey, preference);
    },
    // Absent or unreadable is "never chosen", which the provider reads as on.
    async getAgentCharacters(): Promise<boolean | null> {
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) {
        return cachedAgentCharacters;
      }

      const stored = await activeAdapter.getItem(agentCharactersKey);
      cachedAgentCharacters = stored === "on" ? true : stored === "off" ? false : null;
      return cachedAgentCharacters;
    },
    async saveAgentCharacters(enabled: boolean) {
      cachedAgentCharacters = enabled;
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) {
        throw new Error("Secure storage is unavailable; the agent characters setting was not persisted.");
      }

      await activeAdapter.setItem(agentCharactersKey, enabled ? "on" : "off");
    },
  };
};

export function readThemePreference(value: string | null): ThemePreference | null {
  // "herbarium" was the light theme's name until 2026-09-01; a phone that
  // pinned it keeps a light theme rather than silently falling back to system.
  if (value === "herbarium") {
    return "light";
  }
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

/**
 * The current project and the starred ones — the two durable pieces of project
 * context (epic 37, ids 38 and 40).
 *
 * Both are keyed by `ProjectSummary.key` (the workspace path, or the namespaced
 * id of a pathless workspace), because that is the identifier the wire's two
 * workspace collections can be joined on.
 *
 * Starring is deliberately phone-local: the wire has no favourite concept, and
 * giving it one would mean a desktop-side data model, a protocol change, and
 * conflict semantics. Neither write throws when secure storage is unavailable —
 * a project switch that cannot be persisted still has to *work* for this session,
 * unlike the theme preference, where Settings reports the failed save.
 */
export const createProjectContextStore = (adapter: SessionStorageAdapter | null) => {
  let cachedProjectKey: string | null = null;
  let cachedStarredKeys: string[] = [];

  return {
    async getCurrentProjectKey(): Promise<string | null> {
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) {
        return cachedProjectKey;
      }

      cachedProjectKey = readStoredProjectKey(await activeAdapter.getItem(currentProjectKey));
      return cachedProjectKey;
    },
    async saveCurrentProjectKey(key: string) {
      cachedProjectKey = key;
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) {
        return;
      }

      await activeAdapter.setItem(currentProjectKey, key);
    },
    async getStarredProjectKeys(): Promise<string[]> {
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) {
        return cachedStarredKeys;
      }

      cachedStarredKeys = readStoredStarredProjectKeys(await activeAdapter.getItem(starredProjectsKey));
      return cachedStarredKeys;
    },
    async saveStarredProjectKeys(keys: string[]) {
      cachedStarredKeys = keys;
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) {
        return;
      }

      await activeAdapter.setItem(starredProjectsKey, JSON.stringify(keys));
    },
  };
};

/** An empty or blank stored key means "nothing chosen", not a project named "". */
export function readStoredProjectKey(value: string | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Stars survive an unreadable or half-written value as an empty list rather than
 * a crash — a corrupt favourites file must never be able to wedge the app.
 * Duplicates are collapsed so a key cannot be starred twice.
 */
export function readStoredStarredProjectKeys(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const keys = parsed
      .filter((key): key is string => typeof key === "string")
      .map((key) => key.trim())
      .filter(Boolean);
    return [...new Set(keys)];
  } catch {
    return [];
  }
}

export interface DeviceNotesStore {
  getChatsOpened(): Promise<Record<string, number>>;
  markChatOpened(key: string, at: number): Promise<Record<string, number>>;
  /**
   * Moves a chat's opened stamp back to `at`, and never forward: a Mark unread
   * made after this phone last opened the chat, which that opening must not
   * hide (`visitRewindApplies`). The one write that lowers a stamp.
   */
  rewindChatOpened(key: string, at: number): Promise<Record<string, number>>;
  getReadNoticeIds(): Promise<string[]>;
  saveReadNoticeIds(ids: string[]): Promise<void>;
  /** Deletes notes no build reads any more. Idempotent, and a failure leaves only an unread value behind. */
  forgetRetiredNotes(): Promise<void>;
  /** Whether Home groups chats under their projects rather than listing them newest first. */
  getGroupChatsByProject(): Promise<boolean>;
  saveGroupChatsByProject(enabled: boolean): Promise<void>;
  /** What a message sent while an agent works does by default; never chosen reads as Queue. */
  getFollowUpBehavior(): Promise<FollowUpBehavior>;
  saveFollowUpBehavior(behavior: FollowUpBehavior): Promise<void>;
}

/**
 * The phone's own notes about what it has seen: when each chat was last
 * opened, which can-wait notices are read, whether Home groups chats by
 * project, and what a message sent mid-turn does.
 *
 * Deliberately a *device* store rather than anything sent to a desktop. "I have
 * seen this" is a fact about this phone, not about the run — a second phone
 * paired to the same desktop has its own answer, and syncing it would mean one
 * phone clearing another's gold rows.
 *
 * Every read survives a corrupt or half-written value as the empty answer. The
 * worst case is a row drawing green once more than it should, which is strictly
 * better than a wedged list.
 */
export const createDeviceNotesStore = (adapter: SessionStorageAdapter | null): DeviceNotesStore => {
  let cachedChatsOpened: Record<string, number> = {};
  // The stored map is read once, before the first write: writing the cache
  // alone after a relaunch replaced everything stored with only what this run
  // had opened, so every chat seen before it drew green again.
  let chatsOpenedLoad: Promise<void> | null = null;
  let cachedReadIds: string[] = [];
  let cachedGroupByProject = false;
  let cachedFollowUp: FollowUpBehavior = "queue";
  // One write of the opened-at map at a time. Marks made while one is going
  // out are written together by the one after it: a fresh pairing marks every
  // chat it lists as first seen, and wrote the keychain once per chat.
  let chatsOpenedWrite: Promise<void> | null = null;
  let chatsOpenedUnwritten = false;
  const writeChatsOpened = (activeAdapter: SessionStorageAdapter) => {
    chatsOpenedUnwritten = true;
    chatsOpenedWrite ??= (async () => {
      // Begins once it is the write in progress, so a mark made at any point
      // after this either finds it still looping or finds none and starts one.
      await Promise.resolve();
      try {
        while (chatsOpenedUnwritten) {
          chatsOpenedUnwritten = false;
          await activeAdapter.setItem(chatsOpenedKey, JSON.stringify(cachedChatsOpened));
        }
      } finally {
        chatsOpenedWrite = null;
      }
    })();
    // Settles once a write holding this mark has landed.
    return chatsOpenedWrite;
  };

  const loadChatsOpened = async (activeAdapter: SessionStorageAdapter) => {
    chatsOpenedLoad ??= activeAdapter.getItem(chatsOpenedKey).then(
      (value) => {
        const stored = readStoredChatsOpened(value);
        // Anything marked while the read was in flight is newer than the store.
        for (const [key, at] of Object.entries(cachedChatsOpened)) stored[key] = Math.max(stored[key] ?? 0, at);
        cachedChatsOpened = pruneChatsOpened(stored);
      },
      () => undefined,
    );
    await chatsOpenedLoad;
  };

  return {
    async getChatsOpened() {
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) return cachedChatsOpened;
      await loadChatsOpened(activeAdapter);
      return cachedChatsOpened;
    },
    async markChatOpened(key, at) {
      const activeAdapter = await getAvailableAdapter(adapter);
      if (activeAdapter) await loadChatsOpened(activeAdapter);
      // Monotonic per chat: a clock that jumped backwards must not un-see a
      // row the person has already read.
      const next = { ...cachedChatsOpened, [key]: Math.max(cachedChatsOpened[key] ?? 0, at) };
      cachedChatsOpened = pruneChatsOpened(next);
      if (activeAdapter) await writeChatsOpened(activeAdapter);
      return cachedChatsOpened;
    },
    async rewindChatOpened(key, at) {
      const activeAdapter = await getAvailableAdapter(adapter);
      // Read first: the stored stamp is the one to lower, and a load landing
      // after the write would take the later of the two back.
      if (activeAdapter) await loadChatsOpened(activeAdapter);
      const current = cachedChatsOpened[key];
      if (current === undefined || current <= at) return cachedChatsOpened;
      cachedChatsOpened = { ...cachedChatsOpened, [key]: at };
      if (activeAdapter) await writeChatsOpened(activeAdapter);
      return cachedChatsOpened;
    },
    async getReadNoticeIds() {
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) return cachedReadIds;
      cachedReadIds = readStoredStarredProjectKeys(await activeAdapter.getItem(noticesReadKey));
      return cachedReadIds;
    },
    async saveReadNoticeIds(ids) {
      cachedReadIds = [...new Set(ids.filter(Boolean))];
      const activeAdapter = await getAvailableAdapter(adapter);
      if (activeAdapter) await activeAdapter.setItem(noticesReadKey, JSON.stringify(cachedReadIds));
    },
    async forgetRetiredNotes() {
      const activeAdapter = await getAvailableAdapter(adapter);
      if (activeAdapter) await activeAdapter.deleteItem(retiredNeedsMePushKey);
    },
    async getGroupChatsByProject() {
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) return cachedGroupByProject;
      cachedGroupByProject = (await activeAdapter.getItem(groupChatsByProjectKey)) === "true";
      return cachedGroupByProject;
    },
    async saveGroupChatsByProject(enabled) {
      cachedGroupByProject = enabled;
      const activeAdapter = await getAvailableAdapter(adapter);
      if (activeAdapter) await activeAdapter.setItem(groupChatsByProjectKey, enabled ? "true" : "false");
    },
    async getFollowUpBehavior() {
      const activeAdapter = await getAvailableAdapter(adapter);
      if (!activeAdapter) return cachedFollowUp;
      cachedFollowUp = readFollowUpBehavior(await activeAdapter.getItem(followUpBehaviorKey));
      return cachedFollowUp;
    },
    async saveFollowUpBehavior(behavior) {
      cachedFollowUp = behavior;
      const activeAdapter = await getAvailableAdapter(adapter);
      if (activeAdapter) await activeAdapter.setItem(followUpBehaviorKey, behavior);
    },
  };
};

/** Chat key → the millisecond this phone last opened it. Anything else is dropped. */
export function readStoredChatsOpened(value: string | null): Record<string, number> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (key && typeof at === "number" && Number.isFinite(at) && at > 0) out[key] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * The most recent 200 chats. A chat's key is never reused, so this map only
 * grows — and secure storage is a keychain item, not a database. Two hundred is
 * far past any list a person scrolls, and the rows that fall off simply draw
 * their finished state once more.
 */
const CHATS_OPENED_LIMIT = 200;

export function pruneChatsOpened(entries: Record<string, number>): Record<string, number> {
  const ordered = Object.entries(entries).sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(ordered.slice(0, CHATS_OPENED_LIMIT));
}

/**
 * The paired desktops (schema v3). `prepare` runs once, before the first read,
 * and is where the secure store sweeps the relay-era records into this list
 * (`sweepRelayRecords`) — injected rather than imported so the sweep, which
 * reads this module's legacy keys, does not make the two modules a cycle.
 *
 * The first read of the list goes out alongside `prepare` rather than after
 * it, and is used when `prepare` resolves `false` (it touched nothing, which
 * is every launch after the first); otherwise the list is read again.
 */
export const createSessionListStore = (
  adapter: SessionStorageAdapter | null,
  options: { prepare?: () => Promise<boolean | void> } = {},
) => {
  let cachedList: StoredSessionList = emptySessionList;
  let prepared: Promise<boolean | void> | null = null;

  const persist = async (list: StoredSessionList) => {
    cachedList = list;
    const activeAdapter = await getAvailableAdapter(adapter);
    if (activeAdapter) {
      await activeAdapter.setItem(sessionListKey, JSON.stringify(list));
    }
    return list;
  };

  const load = async (): Promise<StoredSessionList> => {
    let alongside: Promise<string | null> | null = null;
    if (options.prepare) {
      if (!prepared) {
        // A failed sweep must not wedge the list: the pairings already in v3
        // still load, and the sweep is tried again on the next launch.
        prepared = options.prepare().catch(() => undefined);
        alongside = getAvailableAdapter(adapter).then((active) => active?.getItem(sessionListKey) ?? null);
        // Unused when the sweep wrote the list, and never left unhandled.
        alongside.catch(() => undefined);
      }
      const touched = await prepared;
      if (touched !== false) alongside = null;
    }
    const activeAdapter = await getAvailableAdapter(adapter);
    if (!activeAdapter) {
      return cachedList;
    }

    const serializedList = alongside ? await alongside : await activeAdapter.getItem(sessionListKey);
    cachedList = serializedList ? readStoredSessionList(serializedList) : emptySessionList;
    return cachedList;
  };

  return {
    getSessionList: load,
    async upsertSession(session: MobileSession) {
      const list = await load();
      return persist({
        schemaVersion: 3,
        sessions: upsertSessionIntoList(list.sessions, session),
        activeDeviceId: session.deviceId,
      });
    },
    async updateSession(session: MobileSession) {
      const list = await load();
      return persist({
        ...list,
        sessions: list.sessions.map((candidate) => (candidate.deviceId === session.deviceId ? session : candidate)),
      });
    },
    async removeSession(deviceId: string) {
      const list = await load();
      const sessions = list.sessions.filter((candidate) => candidate.deviceId !== deviceId);
      return persist({
        schemaVersion: 3,
        sessions,
        activeDeviceId: list.activeDeviceId === deviceId ? sessions[0]?.deviceId ?? null : list.activeDeviceId,
      });
    },
    async setActiveSession(deviceId: string) {
      const list = await load();
      if (!list.sessions.some((candidate) => candidate.deviceId === deviceId)) {
        return list;
      }
      return persist({ ...list, activeDeviceId: deviceId });
    },
  };
};

// Each pairing mints a new deviceId, so re-pairing the same desktop would
// otherwise leave a dead entry behind. Treat an entry with the same gateway
// endpoint as the same desktop and replace it.
export function upsertSessionIntoList(sessions: MobileSession[], session: MobileSession): MobileSession[] {
  const filtered = sessions.filter(
    (candidate) => candidate.deviceId !== session.deviceId && candidate.baseUrl !== session.baseUrl,
  );
  return [...filtered, session];
}

export function readStoredSessionList(value: string): StoredSessionList {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptySessionList;
    }
    const list = parsed as Partial<StoredSessionList>;
    const sessions = Array.isArray(list.sessions)
      ? list.sessions.filter((session): session is MobileSession => isStoredSession(session))
      : [];
    const activeDeviceId =
      typeof list.activeDeviceId === "string" && sessions.some((session) => session.deviceId === list.activeDeviceId)
        ? list.activeDeviceId
        : sessions[0]?.deviceId ?? null;
    return { schemaVersion: 3, sessions, activeDeviceId };
  } catch {
    return emptySessionList;
  }
}

/**
 * The adapter with its availability asked once and then remembered.
 *
 * Every read and write asks first, so a cold start asked the native module
 * nine times before its first value came back. Whether the platform has a
 * keychain does not change while the app runs; a "no", or a failure to say,
 * is asked again next time rather than remembered.
 */
export function rememberAvailability(adapter: SessionStorageAdapter): SessionStorageAdapter {
  let known: Promise<boolean> | null = null;
  return {
    ...adapter,
    isAvailable() {
      known ??= adapter.isAvailable().then(
        (available) => {
          if (!available) known = null;
          return available;
        },
        () => {
          known = null;
          return false;
        },
      );
      return known;
    },
  };
}

export async function getAvailableAdapter(adapter: SessionStorageAdapter | null) {
  if (!adapter) {
    return null;
  }

  try {
    return (await adapter.isAvailable()) ? adapter : null;
  } catch {
    return null;
  }
}

const sessionStatuses: readonly string[] = ["online", "offline", "stale", "revoked"];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStoredMachineMark(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const mark = value as Record<string, unknown>;
  return typeof mark.kind === "string" && typeof mark.color === "string";
}

/** A stored v3 pairing, validated field by field; anything malformed is dropped rather than misread. */
export function isStoredSession(value: unknown): value is MobileSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const session = value as Partial<MobileSession>;
  return (
    typeof session.deviceId === "string" &&
    typeof session.desktopName === "string" &&
    typeof session.baseUrl === "string" &&
    typeof session.deviceToken === "string" &&
    session.deviceToken.length > 0 &&
    typeof session.pairedAt === "string" &&
    Number.isFinite(Date.parse(session.pairedAt)) &&
    isStringArray(session.tailnetScopes) &&
    (session.tailnetTransportVersion === undefined || Number.isInteger(session.tailnetTransportVersion)) &&
    (session.tailnetCapabilities === undefined || isStringArray(session.tailnetCapabilities)) &&
    (session.machineMark === undefined || isStoredMachineMark(session.machineMark)) &&
    (session.status === undefined || sessionStatuses.includes(session.status)) &&
    (session.lastSeenAt === undefined || typeof session.lastSeenAt === "string") &&
    (session.revokedAt === undefined || typeof session.revokedAt === "string")
  );
}
