import type { MobileSession } from "../api/types";

import {
  getAvailableAdapter,
  isStoredSession,
  legacySessionKey,
  legacySessionListKey,
  readStoredSessionList,
  sessionListKey,
  upsertSessionIntoList,
  type SessionStorageAdapter,
  type StoredSessionList,
} from "./sessionStore";

/**
 * Set once the sweep has finished. Every step below is idempotent, so a sweep
 * interrupted before this is written simply runs again on the next launch.
 */
export const relayCleanupMarkerKey = "multicode.mobile.relayCleanup.v1";

/**
 * Where a relay-era build kept its account sign-in tokens and an unfinished
 * sign-in. The sign-in code itself is gone; the sweep still clears these keys
 * on a phone that updates from such a build.
 */
export const legacyAuthTokenStorageKeys = ["multicode.mobile.auth.tokens.v1", "multicode.mobile.auth.pending.v1"] as const;

/**
 * The one-time sweep of what the phone stored for the hosted relay, which the
 * phone no longer uses: it pairs over Tailscale only, and nothing talks to the
 * relay.
 *
 * - The relay-era session keys (v1 single session, v2 list) are read; every
 *   TAILNET pairing in them moves into the v3 list in its own shape, and every
 *   relay pairing — its relay token, its relay session id — is dropped. Then
 *   both legacy keys are deleted.
 * - The account sign-in tokens are deleted. The only tokens a phone ever held
 *   were minted to pair with the relay (scope `relay:pair`), and nothing reads
 *   them now. Nothing is sent anywhere: this clears the device, it does not
 *   call a server.
 *
 * Never touched: the v3 list's own pairings (a legacy entry never replaces
 * one), project context, theme, device notes, or the conversation cache.
 *
 * Resolves false when there was nothing to sweep, so the v3 list was not
 * touched: on every launch after the first, a read of the list made while
 * this ran is already the list.
 */
export async function sweepRelayRecords(adapter: SessionStorageAdapter | null): Promise<boolean> {
  const activeAdapter = await getAvailableAdapter(adapter);
  if (!activeAdapter) {
    return false;
  }
  if ((await activeAdapter.getItem(relayCleanupMarkerKey)) === "done") {
    return false;
  }

  const legacyList = await activeAdapter.getItem(legacySessionListKey);
  const legacySingle = await activeAdapter.getItem(legacySessionKey);
  if (legacyList !== null || legacySingle !== null) {
    const legacy = [...readLegacySessionList(legacyList), ...readLegacySingleSession(legacySingle)];
    const currentValue = await activeAdapter.getItem(sessionListKey);
    const current: StoredSessionList = currentValue
      ? readStoredSessionList(currentValue)
      : { schemaVersion: 3, sessions: [], activeDeviceId: null };
    const merged = mergeLegacyTailnetSessions(current, legacy, legacyActiveDeviceId(legacyList));
    // Written before the legacy keys go, so an interruption between the two
    // leaves the pairings in both places rather than in neither.
    if (merged !== current || !currentValue) {
      await activeAdapter.setItem(sessionListKey, JSON.stringify(merged));
    }
    await activeAdapter.deleteItem(legacySessionListKey);
    await activeAdapter.deleteItem(legacySessionKey);
  }

  for (const key of legacyAuthTokenStorageKeys) {
    await activeAdapter.deleteItem(key);
  }

  await activeAdapter.setItem(relayCleanupMarkerKey, "done");
  return true;
}

/**
 * The legacy tailnet pairings folded into the current list. A pairing already
 * in the list — same device, or same gateway endpoint — wins over its legacy
 * copy, because it is the newer one. Returns `current` itself when nothing was
 * added.
 */
export function mergeLegacyTailnetSessions(
  current: StoredSessionList,
  legacy: MobileSession[],
  legacyActiveDeviceId: string | null,
): StoredSessionList {
  let sessions = current.sessions;
  for (const session of legacy) {
    const known = sessions.some(
      (candidate) => candidate.deviceId === session.deviceId || candidate.baseUrl === session.baseUrl,
    );
    if (!known) {
      sessions = upsertSessionIntoList(sessions, session);
    }
  }
  if (sessions === current.sessions) {
    return current;
  }
  const activeDeviceId =
    current.activeDeviceId ??
    (legacyActiveDeviceId && sessions.some((session) => session.deviceId === legacyActiveDeviceId)
      ? legacyActiveDeviceId
      : sessions[0]?.deviceId ?? null);
  return { schemaVersion: 3, sessions, activeDeviceId };
}

/**
 * A relay-era stored record as a v3 pairing, or null when it is not a tailnet
 * pairing. The v2 shape reused relay-named fields for tailnet pairings:
 * `relayUrl` held the gateway base URL and `credentials.relayToken` the device
 * token. A record with no `transport: "tailnet"` is a relay pairing and is
 * dropped.
 *
 * Pairings made before the gateway's own grant was stored carry only the
 * mapped scope list; it is mapped back to the grant it came from, so a pairing
 * that could update the backlog yesterday still can.
 */
export function sessionFromLegacyRecord(value: unknown): MobileSession | null {
  if (!isRecord(value) || value.transport !== "tailnet") {
    return null;
  }
  const credentials = isRecord(value.credentials) ? value.credentials : {};
  const tailnetScopes = isStringArray(value.tailnetScopes)
    ? [...value.tailnetScopes]
    : grantFromMappedScopes(isStringArray(credentials.scopes) ? credentials.scopes : []);
  const candidate: Record<string, unknown> = {
    deviceId: value.deviceId,
    desktopName: value.desktopName,
    baseUrl: value.relayUrl,
    deviceToken: credentials.relayToken,
    pairedAt: value.pairedAt,
    tailnetScopes,
  };
  for (const key of ["tailnetTransportVersion", "tailnetCapabilities", "status", "lastSeenAt", "revokedAt"] as const) {
    if (value[key] !== undefined) {
      candidate[key] = value[key];
    }
  }
  return isStoredSession(candidate) ? candidate : null;
}

function grantFromMappedScopes(scopes: readonly string[]): string[] {
  const grant: string[] = [];
  if (scopes.includes("relay:backlog:update")) {
    grant.push("workspace:operate");
  } else if (scopes.includes("relay:snapshot:read")) {
    grant.push("workspace:read");
  }
  return grant;
}

function readLegacySessionList(value: string | null): MobileSession[] {
  const parsed = parseJson(value);
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
    return [];
  }
  return parsed.sessions
    .map((entry) => sessionFromLegacyRecord(entry))
    .filter((session): session is MobileSession => session !== null);
}

function readLegacySingleSession(value: string | null): MobileSession[] {
  const session = sessionFromLegacyRecord(parseJson(value));
  return session ? [session] : [];
}

function legacyActiveDeviceId(value: string | null): string | null {
  const parsed = parseJson(value);
  return isRecord(parsed) && typeof parsed.activeDeviceId === "string" ? parsed.activeDeviceId : null;
}

function parseJson(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
