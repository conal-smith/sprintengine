/** How long a workspace list read by the chat list stands in for a chat's own read of it. */
export const RECENT_READ_MS = 60_000;

/**
 * One desktop read shared by the screens that want it.
 *
 * `fresh()` always asks the desktop, except that a read already in flight is
 * joined rather than sent twice. `recent()` takes the last good answer when it
 * is younger than `maxAgeMs`, and otherwise reads fresh: for a screen that
 * wants what the list it was opened from has just read, not a copy of it.
 * A failed answer is never kept.
 */
export function createRecentRead<T extends { ok: boolean }>(
  read: () => Promise<T>,
  now: () => number = Date.now,
) {
  let last: { at: number; answer: T } | null = null;
  let inFlight: Promise<T> | null = null;
  const fresh = (): Promise<T> => {
    if (inFlight) return inFlight;
    const reading = read()
      .then((answer) => {
        if (answer.ok) last = { at: now(), answer };
        return answer;
      })
      .finally(() => {
        if (inFlight === reading) inFlight = null;
      });
    inFlight = reading;
    return reading;
  };
  return {
    fresh,
    recent(maxAgeMs: number = RECENT_READ_MS): Promise<T> {
      return last && now() - last.at <= maxAgeMs ? Promise.resolve(last.answer) : fresh();
    },
  };
}
