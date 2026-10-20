// How much of the model's context window a chat holds, folded from its
// `usage_updated` events, for the ring at the right of the composer's strip
// (the desktop's ContextRing, design-system/components/context-ring).
//
// The desktop reports the window on `usage_updated` as `contextWindow` (the
// window's size in tokens) and `contextUsed` (the tokens in context now). ACP
// agents already send exactly these. A report without `contextUsed` is read as
// the request it describes: that request's input plus its output, the latest
// report's alone and never a sum across turns, since every request re-sends
// the conversation. A report that names neither (the prompt cache's own
// report) leaves the reading as it was.
//
// No window, no ring: a ring at 0% and a ring for a chat that reports nothing
// are the same picture, and one of them is a lie. The phone keeps no model
// catalog with a window in it, so the window comes from the events alone.

export type ContextReading = {
  /** Tokens in context, by the latest report that said; null when unknown (after a compaction that gave no size). */
  used: number | null;
  /** The model's window, by the latest report that named it; null when none has. */
  window: number | null;
};

/** Past this share of the window a compaction is close, and the ring takes the warn tone. */
export const CONTEXT_RING_WARN_PERCENTAGE = 80;
// Far past any context window: a number beyond it is a bad payload.
const MAX_TOKENS = 100_000_000;

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TOKENS
    ? Math.floor(value)
    : undefined;
}

/** Fold one event into the reading. */
export function applyContextEvent(
  previous: ContextReading | null,
  event: { type: string; payload?: Record<string, unknown> },
): ContextReading | null {
  const p = event.payload ?? {};
  if (event.type === "usage_updated") {
    const reported = tokens(p.contextWindow);
    const window = reported && reported > 0 ? reported : (previous?.window ?? null);
    const input = tokens(p.inputTokens);
    const output = tokens(p.outputTokens);
    if (reported === undefined && tokens(p.contextUsed) === undefined && input === undefined && output === undefined)
      return previous;
    const used =
      tokens(p.contextUsed) ??
      (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : (previous?.used ?? null));
    if (used === null && window === null) return previous;
    return { used, window };
  }
  // A compaction gives context back: its own after-size where it says one,
  // else unknown until the next request reports.
  if (event.type === "context_compacted" && previous)
    return { window: previous.window, used: tokens(p.postTokens) ?? null };
  return previous;
}

export type ContextRingValue = { used: number; total: number; percentage: number; high: boolean };

/** What the ring draws, or null when there is no reading to draw. */
export function contextRingValue(reading: ContextReading | null | undefined): ContextRingValue | null {
  if (!reading || reading.used === null || !reading.window) return null;
  const percentage = Math.max(0, Math.min(100, Math.round((reading.used / reading.window) * 100)));
  return { used: reading.used, total: reading.window, percentage, high: percentage >= CONTEXT_RING_WARN_PERCENTAGE };
}

/** 76000 → "76,000": grouped by hand, so the words do not hang on the engine's Intl. */
function grouped(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

/** What a long press on the ring says: the tokens and nothing else, "76,000 / 200,000 tokens". */
export function contextRingLabel(value: Pick<ContextRingValue, "used" | "total">): string {
  return `${grouped(value.used)} / ${grouped(value.total)} tokens`;
}
