/**
 * Whether a chat's writes to the phone's cache have failed for long enough to
 * tell the person.
 *
 * The cache is a local copy, not the chat itself: a write that fails is
 * carried by the next one, which a streaming reply makes within a second, and
 * a chat whose cache fell behind resumes from the older cursor, the desktop
 * sending what the phone did not keep. So one failure, or a burst of them, is
 * said nowhere. Only writes that keep failing, several in a row and over some
 * seconds, are worth a line under the composer: then the phone is not keeping
 * the chat at all, and reopening it costs a reload. (A send that cannot be
 * written says so itself, where it was sent.) The first write that succeeds
 * takes the line away again. It is said once for a run of failures:
 * dismissed, it stays away until the writes have recovered and failed again.
 */
export const CACHE_SAVE_NOTICE =
  "This chat could not be saved on the phone. Opening it again loads it from the desktop.";

export interface CacheSaveHealthLimits {
  /** Failed writes in a row before the notice is shown. */
  failures: number;
  /** How long, from the first of them, the writes must have kept failing. */
  sinceMs: number;
}

export const CACHE_SAVE_LIMITS: CacheSaveHealthLimits = { failures: 3, sinceMs: 5_000 };

export function createCacheSaveHealth(limits: CacheSaveHealthLimits = CACHE_SAVE_LIMITS) {
  let failures = 0;
  let firstFailedAt = 0;
  let shown = false;
  return {
    /** A write failed at `now`. True when this is the one that should show the notice. */
    failed(now: number): boolean {
      if (failures++ === 0) firstFailedAt = now;
      if (shown || failures < limits.failures || now - firstFailedAt < limits.sinceMs) return false;
      shown = true;
      return true;
    },
    /** A write landed. True when a notice this shows should be taken away. */
    succeeded(): boolean {
      const wasShown = shown;
      failures = 0;
      shown = false;
      return wasShown;
    },
  };
}

export type CacheSaveHealth = ReturnType<typeof createCacheSaveHealth>;
