// A session's prompt cache, as the agent CLI last reported it.
//
// The API keeps a conversation's prefix cached for a fixed lifetime after the
// last request that wrote or read it: five minutes by default, an hour when
// asked for (Claude Code asks for an hour on a Pro or Max subscription). Inside
// that window the next message re-reads the whole conversation at a tenth of
// the input price or less; past it, the next message writes the whole
// conversation to the cache again at full price or more. For a long session
// that is hundreds of thousands of tokens, so an idle session's cache is worth
// showing — and worth compacting before it goes cold.
//
// Two sources fill it:
//   * a terminal agent's own status line: Claude Code hands its status-line
//     command a `prompt_cache` object (warm, ttl, expires_at, and the tokens a
//     cold resume re-caches), which the status-line forwarder passes on;
//   * a chat agent's provider, which reads each API request's usage as it
//     starts: its size, and whether the cache it wrote lives for five minutes
//     or an hour.
//
// Every surface derives warm / expiring / cold from this reading and a clock,
// so a session whose process has since gone quiet — suspended, or parked
// across a restart — still goes cold on time.

export type PromptCacheTtl = '5m' | '1h'

const PROMPT_CACHE_TTL_MS: Readonly<Record<PromptCacheTtl, number>> = {
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
}

export type PromptCacheReading = {
  // The lifetime of the cached prefix. Null when the source has not said.
  ttl: PromptCacheTtl | null
  // When the cached prefix goes cold, in epoch ms. Null when the last request
  // reported no cache tokens at all: nothing is cached, so it is already cold.
  expiresAt: number | null
  // How many tokens the next request writes to the cache again if the cache
  // has gone cold by then — the size of the conversation. Null when unknown,
  // which the CLI reports right after a compaction until the next request.
  recacheTokens: number | null
}

// Far past any real context window, so every number off an untrusted source
// (the agent-state socket, a sidecar on disk, a transcript) is bounded.
const MAX_RECACHE_TOKENS = 100_000_000
// An expiry more than a day past its reading is not a cache lifetime.
const MAX_EXPIRY_AHEAD_MS = 24 * 60 * 60_000

/**
 * A reading from untrusted input, field by field, or null when it is not a
 * reading at all. `now` bounds the expiry: a cache cannot outlive its longest
 * lifetime by more than a day.
 *
 * A reading whose fields are all null IS a reading — nothing cached, nothing
 * known about the conversation's size (a fresh one after `/clear`) — and it
 * must replace the last one rather than leave that one's size standing.
 * Only something with none of the fields at all is not a reading.
 */
export function parsePromptCacheReading(raw: unknown, now = Date.now()): PromptCacheReading | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>
  const ttl = candidate.ttl === '5m' || candidate.ttl === '1h' ? candidate.ttl : null
  const expiresAt =
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt) &&
    candidate.expiresAt > 0 &&
    candidate.expiresAt <= now + MAX_EXPIRY_AHEAD_MS
      ? Math.floor(candidate.expiresAt)
      : null
  const recacheTokens =
    typeof candidate.recacheTokens === 'number' &&
    Number.isFinite(candidate.recacheTokens) &&
    candidate.recacheTokens >= 0
      ? Math.min(Math.floor(candidate.recacheTokens), MAX_RECACHE_TOKENS)
      : null
  if (!('ttl' in candidate) && !('expiresAt' in candidate) && !('recacheTokens' in candidate)) return null
  return { ttl, expiresAt, recacheTokens }
}

/**
 * Fold one conversation event into a chat's prompt-cache reading. A provider's
 * per-request report (`usage_updated.promptCache`: the lifetime, whether
 * anything was cached, the conversation's size) goes cold one lifetime after
 * the event, read off the event's own time so a replayed transcript restores
 * when it really went cold. Main's runtime and the chat's projection both fold
 * with this, so the summary and the view never disagree.
 */
export function applyPromptCacheEvent(
  previous: PromptCacheReading | null,
  event: { type: string; createdAt: number; payload?: Record<string, unknown> },
): PromptCacheReading | null {
  if (event.type === 'usage_updated') {
    const report = event.payload?.promptCache
    if (!report || typeof report !== 'object') return previous
    const { ttl: rawTtl, cached, recacheTokens } = report as Record<string, unknown>
    // A request that only reads says nothing of the lifetime: the one the last
    // write reported stands (the provider's own memory of it starts empty
    // after a restart; the replayed reading does not). Never reported at all,
    // it is the API's default, five minutes — the shorter guess, so a cache is
    // never shown warm after it has gone.
    const reported = rawTtl === '5m' || rawTtl === '1h' ? rawTtl : null
    const ttl = reported ?? previous?.ttl ?? (cached === true ? '5m' : null)
    return (
      parsePromptCacheReading(
        {
          ttl,
          expiresAt: cached === true && ttl ? event.createdAt + PROMPT_CACHE_TTL_MS[ttl] : null,
          recacheTokens,
        },
        event.createdAt,
      ) ?? previous
    )
  }
  // A compaction rewrites the conversation. Its size is not known until the
  // next request reports it — the summary's count leaves out the system prompt
  // and tools that request re-sends — which is what Claude Code's own status
  // line says too, so a compacted session is not offered compacting again.
  if (event.type === 'context_compacted' && previous) {
    return { ttl: previous.ttl, expiresAt: null, recacheTokens: null }
  }
  // A `/compact` the CLI turned down for having nothing to compact says the
  // session it holds is empty, whatever the last reading said it would cost
  // to send: offering Compact again would only be turned down again.
  if (
    event.type === 'command_output' &&
    previous &&
    event.payload?.command === 'compact' &&
    /not enough messages to compact/iu.test(String(event.payload?.output ?? ''))
  ) {
    return { ttl: previous.ttl, expiresAt: null, recacheTokens: null }
  }
  return previous
}

export function samePromptCacheReading(
  a: PromptCacheReading | null | undefined,
  b: PromptCacheReading | null | undefined,
) {
  if (!a || !b) return !a && !b
  return a.ttl === b.ttl && a.expiresAt === b.expiresAt && a.recacheTokens === b.recacheTokens
}

/** What deciding whether a terminal agent can compact needs from its snapshot. */
export type CompactableTerminal = {
  cli?: string | null
  processAlive: boolean
  suspended: boolean
  agentState?: { phase: string } | null
  lastInputAt: number | null
  lastKeyInputAt?: number | null
  lastPrompt?: { at: number } | null
  lastTurnEndedAt?: number | null
}

/**
 * Why a terminal agent cannot be sent `/compact` right now, or null when it
 * can. One rule for the button that offers it and for main, which enforces it:
 * compacting types `/compact` at the agent's prompt and presses Enter, so the
 * prompt has to be Claude Code's, waiting, and empty. Keystrokes since the last
 * prompt was submitted mean a half-typed message may be sitting there, and
 * `/compact` would be appended to it and sent as part of it. Main checks this
 * again inside the control plane's queue, immediately before it types.
 */
export function terminalCompactBlocker(session: CompactableTerminal): string | null {
  if (session.cli !== 'claude-code') return 'Only a Claude Code agent can be compacted from here.'
  if (!session.processAlive || session.suspended) return 'The agent is not running. Resume it to compact.'
  if (session.agentState?.phase !== 'idle' || typeof session.lastTurnEndedAt !== 'number') {
    return 'The agent is busy. Compact once it has finished.'
  }
  // Anything typed since the last prompt was submitted — during the turn as
  // much as after it, since Claude Code takes typing while it works — may
  // still be sitting at the prompt. The keystroke that submitted it came
  // before the prompt was recorded, so it does not count.
  const typedAt = session.lastKeyInputAt === undefined ? session.lastInputAt : session.lastKeyInputAt
  const since = session.lastPrompt?.at ?? session.lastTurnEndedAt
  if (typedAt !== null && typedAt > since) {
    return 'Something may be typed at the agent’s prompt. Clear it, send it, or compact from the terminal.'
  }
  return null
}
