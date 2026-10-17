import { test } from 'vitest'
import assert from 'node:assert/strict'
import { applyPromptCacheEvent, parsePromptCacheReading, terminalCompactBlocker } from '../src/promptCache.js'

const NOW = 1_800_000_000_000

test('a prompt-cache reading off an untrusted source keeps each valid field and bounds the rest', () => {
  assert.deepEqual(parsePromptCacheReading({ ttl: '1h', expiresAt: NOW + 60_000, recacheTokens: 310_200.7 }, NOW), {
    ttl: '1h',
    expiresAt: NOW + 60_000,
    recacheTokens: 310_200,
  })
  // The nulls are facts: nothing cached, a size not known yet.
  assert.deepEqual(parsePromptCacheReading({ ttl: '5m', expiresAt: null, recacheTokens: null }, NOW), {
    ttl: '5m',
    expiresAt: null,
    recacheTokens: null,
  })
  // Every field bad or null is still a reading — nothing cached, nothing known —
  // so it replaces the last one; a thing with none of the fields is not one.
  assert.deepEqual(parsePromptCacheReading({ ttl: '2h', expiresAt: 'soon', recacheTokens: -1 }, NOW), {
    ttl: null,
    expiresAt: null,
    recacheTokens: null,
  })
  assert.equal(parsePromptCacheReading({ warm: true }, NOW), null)
  assert.equal(
    parsePromptCacheReading({ ttl: '1h', expiresAt: NOW + 2 * 24 * 60 * 60_000 }, NOW)?.expiresAt,
    null,
    'a cache does not live for days',
  )
  assert.equal(parsePromptCacheReading([1], NOW), null)
  assert.equal(parsePromptCacheReading(null, NOW), null)
})

test('a chat folds its provider’s per-request reports into when the cache goes cold', () => {
  const report = (promptCache: Record<string, unknown>, createdAt = NOW) => ({
    type: 'usage_updated',
    createdAt,
    payload: { promptCache },
  })
  // Cold one lifetime after the request was seen to start, off the event's time.
  const warm = applyPromptCacheEvent(null, report({ ttl: '1h', cached: true, recacheTokens: 240_000 }))
  assert.deepEqual(warm, { ttl: '1h', expiresAt: NOW + 60 * 60_000, recacheTokens: 240_000 })
  assert.deepEqual(
    applyPromptCacheEvent(null, report({ ttl: '5m', cached: true, recacheTokens: 9 }))?.expiresAt,
    NOW + 5 * 60_000,
  )
  // A request that cached nothing leaves nothing warm.
  assert.equal(
    applyPromptCacheEvent(warm, report({ ttl: '1h', cached: false, recacheTokens: 250_000 }))?.expiresAt,
    null,
  )
  // A read-only request carries the last lifetime over — across a restart
  // too, where only the replayed reading remembers it.
  assert.equal(
    applyPromptCacheEvent(warm, report({ ttl: null, cached: true, recacheTokens: 5 }, NOW + 10))?.expiresAt,
    NOW + 10 + 60 * 60_000,
  )
  // Never reported at all, it is the API's default: the shorter guess.
  assert.deepEqual(applyPromptCacheEvent(null, report({ ttl: null, cached: true, recacheTokens: 5 })), {
    ttl: '5m',
    expiresAt: NOW + 5 * 60_000,
    recacheTokens: 5,
  })
  // A usage report without a cache report (a turn's totals) leaves the reading.
  assert.equal(
    applyPromptCacheEvent(warm, { type: 'usage_updated', createdAt: NOW, payload: { inputTokens: 5 } }),
    warm,
  )
  // A compaction rewrites the conversation: nothing of it cached, and its
  // size unknown until the next request — so it is not offered compacting again.
  assert.deepEqual(
    applyPromptCacheEvent(warm, { type: 'context_compacted', createdAt: NOW, payload: { postTokens: 24_000 } }),
    { ttl: '1h', expiresAt: null, recacheTokens: null },
  )
  assert.equal(applyPromptCacheEvent(warm, { type: 'content_delta', createdAt: NOW }), warm)
})

test('a terminal agent is compacted only at Claude Code’s own prompt, waiting and empty', () => {
  const idle = {
    cli: 'claude-code',
    processAlive: true,
    suspended: false,
    agentState: { phase: 'idle' },
    lastInputAt: 100,
    lastTurnEndedAt: 200,
  }
  assert.equal(terminalCompactBlocker(idle), null)
  assert.match(terminalCompactBlocker({ ...idle, cli: 'codex' }) ?? '', /Claude Code/)
  assert.match(terminalCompactBlocker({ ...idle, suspended: true }) ?? '', /not running/)
  assert.match(terminalCompactBlocker({ ...idle, processAlive: false }) ?? '', /not running/)
  assert.match(terminalCompactBlocker({ ...idle, agentState: { phase: 'thinking' } }) ?? '', /busy/)
  assert.match(terminalCompactBlocker({ ...idle, lastTurnEndedAt: null }) ?? '', /busy/)
  // Keystrokes since the turn ended: a draft may be sitting at the prompt, and
  // `/compact` would be sent on the end of it.
  assert.match(terminalCompactBlocker({ ...idle, lastInputAt: 300 }) ?? '', /typed/)
  assert.equal(terminalCompactBlocker({ ...idle, lastInputAt: null }), null)
  // Switching windows is not typing: focus reports move `lastInputAt` but not
  // `lastKeyInputAt`, which is what counts when main reports it.
  assert.equal(terminalCompactBlocker({ ...idle, lastInputAt: 300, lastKeyInputAt: 90 }), null)
  // A draft typed while the turn was still running is after the prompt it
  // followed, even though it is before the turn ended.
  assert.match(
    terminalCompactBlocker({ ...idle, lastPrompt: { at: 50 }, lastKeyInputAt: 150, lastTurnEndedAt: 200 }) ?? '',
    /typed/,
  )
  assert.equal(terminalCompactBlocker({ ...idle, lastPrompt: { at: 50 }, lastKeyInputAt: 40 }), null)
})

test('a /compact turned down for having nothing to compact stops offering Compact', () => {
  const warm = { ttl: '1h' as const, expiresAt: NOW - 1, recacheTokens: 574_000 }
  const declined = { command: 'compact', output: 'Not enough messages to compact.' }
  assert.deepEqual(applyPromptCacheEvent(warm, { type: 'command_output', createdAt: NOW, payload: declined }), {
    ttl: '1h',
    expiresAt: null,
    recacheTokens: null,
  })
  // Another command's output, or another reply from /compact, changes nothing.
  for (const payload of [
    { command: 'context', output: 'Not enough messages to compact.' },
    { command: 'compact', output: 'Compacted.' },
  ])
    assert.equal(applyPromptCacheEvent(warm, { type: 'command_output', createdAt: NOW, payload }), warm)
})
