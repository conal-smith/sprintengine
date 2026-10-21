// A chat's prompt cache, folded from its events the way the desktop folds it
// (studio shared/prompt-cache.ts and workspace/promptCacheState.ts), so the
// phone and the desk say the same thing about the same conversation.
//
// The API keeps a conversation's prefix cached for a fixed lifetime after the
// last request that touched it: five minutes by default, an hour when asked
// for. Inside that window the next message re-reads the conversation cheaply;
// past it, the whole conversation is written again at full price. For a long
// chat that is hundreds of thousands of tokens, which is why the notice above
// the composer offers a compaction while the cache is still warm.
//
// The reading is derived from events and a clock and never stored, so a chat
// whose desktop went quiet still goes cold on time.

export type PromptCacheTtl = "5m" | "1h";
export type PromptCacheReading = {
  /** The cached prefix's lifetime; null when the source has not said. */
  ttl: PromptCacheTtl | null;
  /** When it goes cold, in epoch ms; null when nothing is cached. */
  expiresAt: number | null;
  /** What the next request re-caches once cold: the conversation's size. Null when unknown. */
  recacheTokens: number | null;
};
export type PromptCacheState =
  | { kind: "warm"; remainingMs: number; recacheTokens: number | null }
  | { kind: "expiring"; remainingMs: number; recacheTokens: number | null }
  | { kind: "cold"; expiredAt: number | null; recacheTokens: number | null };

const TTL_MS: Readonly<Record<PromptCacheTtl, number>> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
};
// Long enough before it goes cold to act on: a five-minute cache would be
// "expiring" for most of its life, so only its last two minutes count.
const EXPIRING_WITHIN_MS: Readonly<Record<PromptCacheTtl, number>> = {
  "5m": 2 * 60_000,
  "1h": 10 * 60_000,
};
/** Below this, re-caching is cheap enough not to mention. */
export const PROMPT_CACHE_NOTICE_TOKENS = 50_000;
// Bounds for numbers off an untrusted event: far past any context window, and
// no cache outlives its longest lifetime by more than a day.
const MAX_RECACHE_TOKENS = 100_000_000;
const MAX_EXPIRY_AHEAD_MS = 24 * 60 * 60_000;

function parseReading(
  raw: { ttl: unknown; expiresAt: unknown; recacheTokens: unknown },
  now: number,
): PromptCacheReading {
  const ttl = raw.ttl === "5m" || raw.ttl === "1h" ? raw.ttl : null;
  const expiresAt =
    typeof raw.expiresAt === "number" &&
    Number.isFinite(raw.expiresAt) &&
    raw.expiresAt > 0 &&
    raw.expiresAt <= now + MAX_EXPIRY_AHEAD_MS
      ? Math.floor(raw.expiresAt)
      : null;
  const recacheTokens =
    typeof raw.recacheTokens === "number" &&
    Number.isFinite(raw.recacheTokens) &&
    raw.recacheTokens >= 0
      ? Math.min(Math.floor(raw.recacheTokens), MAX_RECACHE_TOKENS)
      : null;
  return { ttl, expiresAt, recacheTokens };
}

/**
 * Fold one event into the reading. A request's report goes cold one lifetime
 * after the event that carried it, read off the event's own time so replayed
 * history restores when it really went cold. A compaction rewrites the
 * conversation, so its size is unknown until the next request reports it and
 * the chat is not offered compacting again meanwhile.
 */
export function applyPromptCacheEvent(
  previous: PromptCacheReading | null,
  event: { type: string; createdAt: number; payload?: Record<string, unknown> },
): PromptCacheReading | null {
  if (event.type === "usage_updated") {
    const report = event.payload?.promptCache;
    if (!report || typeof report !== "object" || Array.isArray(report)) return previous;
    const { ttl: rawTtl, cached, recacheTokens } = report as Record<string, unknown>;
    // A read-only request says nothing of the lifetime: the last write's
    // stands, and one never reported is the API's default, the shorter guess.
    const reported = rawTtl === "5m" || rawTtl === "1h" ? rawTtl : null;
    const ttl = reported ?? previous?.ttl ?? (cached === true ? "5m" : null);
    return parseReading(
      {
        ttl,
        expiresAt: cached === true && ttl ? event.createdAt + TTL_MS[ttl] : null,
        recacheTokens,
      },
      event.createdAt,
    );
  }
  if (event.type === "context_compacted" && previous)
    return { ttl: previous.ttl, expiresAt: null, recacheTokens: null };
  return previous;
}

export function promptCacheState(
  reading: PromptCacheReading | null | undefined,
  now: number,
): PromptCacheState | null {
  if (!reading) return null;
  const { expiresAt, recacheTokens } = reading;
  if (expiresAt !== null && expiresAt > now) {
    const remainingMs = expiresAt - now;
    const window = EXPIRING_WITHIN_MS[reading.ttl ?? "1h"];
    return { kind: remainingMs <= window ? "expiring" : "warm", remainingMs, recacheTokens };
  }
  return { kind: "cold", expiredAt: expiresAt, recacheTokens };
}

/** Going or gone, and big enough that re-caching matters. An unknown size is not assumed big. */
export function promptCacheNeedsAttention(
  state: PromptCacheState | null,
): state is Exclude<PromptCacheState, { kind: "warm" }> {
  return (
    state !== null &&
    state.kind !== "warm" &&
    (state.recacheTokens ?? 0) >= PROMPT_CACHE_NOTICE_TOKENS
  );
}

// 950 → "950", 12_345 → "12.3k", 412_000 → "412k", 1_200_000 → "1.2M".
export function formatTokenCount(count: number): string {
  const value = Math.max(0, Math.round(count));
  if (value < 1000) return String(value);
  const [scaled, unit] = value < 999_500 ? [value / 1000, "k"] : [value / 1_000_000, "M"];
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit}`;
}

// "8m", or "under a minute" where the minutes have nothing to say.
function minutes(ms: number): string {
  const whole = Math.floor(Math.max(0, ms) / 60_000);
  if (whole < 1) return "under a minute";
  if (whole < 60) return `${whole}m`;
  const hours = Math.floor(whole / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The notice's words: the desktop's, so both surfaces say the same thing. */
export function promptCacheCopy(
  state: Exclude<PromptCacheState, { kind: "warm" }>,
  now: number,
): { label: string; detail: string } {
  const tokens =
    state.recacheTokens !== null
      ? `~${formatTokenCount(state.recacheTokens)} tokens`
      : "the whole conversation";
  if (state.kind === "expiring")
    return {
      label: `Cache expires in ${minutes(state.remainingMs)}`,
      detail: `After that, the next message re-sends ${tokens} uncached. Compacting now, while the cache is warm, is cheap.`,
    };
  const ago = state.expiredAt !== null && now - state.expiredAt >= 60_000 ? minutes(now - state.expiredAt) : "";
  return {
    label: ago ? `Cache expired ${ago} ago` : "Cache cold",
    // Compacting a cold cache re-reads the conversation uncached too; what it
    // buys is every message after it.
    detail: `The next message re-sends ${tokens} uncached, a compaction included. Compacting first makes every message after it smaller.`,
  };
}

/**
 * The same reading as one line, for the composer's tray: "Cache expires in 1m
 * · ~198k tokens cached", or "Cache expired 13m ago · ~198k tokens uncached".
 * The tray has a row, not a card, so the explanation `promptCacheCopy` gives
 * is left to its Compact action.
 */
export function promptCacheLine(state: Exclude<PromptCacheState, { kind: "warm" }>, now: number): string {
  const { label } = promptCacheCopy(state, now);
  if (state.recacheTokens === null) return label;
  const tokens = `~${formatTokenCount(state.recacheTokens)} tokens`;
  return `${label} · ${tokens} ${state.kind === "expiring" ? "cached" : "uncached"}`;
}

/** What a "Not now" is about: this reading. The next request writes a new one. */
export function promptCacheReadingKey(reading: PromptCacheReading): string {
  return `${reading.expiresAt ?? "cold"}:${reading.recacheTokens ?? ""}`;
}
