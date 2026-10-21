const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  applyPromptCacheEvent,
  promptCacheState,
  promptCacheNeedsAttention,
  promptCacheCopy,
  promptCacheLine,
  promptCacheReadingKey,
  formatTokenCount,
} = require("../../../.mobile-test-build/src/features/conversations/promptCache.js");

const usage = (createdAt, promptCache) => ({ type: "usage_updated", createdAt, payload: { promptCache } });

test("a usage report goes cold one lifetime after its own event, and a read-only report keeps the lifetime", () => {
  let reading = applyPromptCacheEvent(null, usage(1_000, { ttl: "1h", cached: true, recacheTokens: 412_000 }));
  assert.deepEqual(reading, { ttl: "1h", expiresAt: 1_000 + 3_600_000, recacheTokens: 412_000 });
  reading = applyPromptCacheEvent(reading, usage(2_000, { cached: true, recacheTokens: 413_000 }));
  assert.equal(reading.ttl, "1h");
  assert.equal(reading.expiresAt, 2_000 + 3_600_000);
  assert.deepEqual(applyPromptCacheEvent(null, usage(0, { cached: true })).ttl, "5m", "never reported is the shorter guess");
  assert.equal(applyPromptCacheEvent(null, usage(0, { cached: false, recacheTokens: 10 })).expiresAt, null);
  assert.equal(applyPromptCacheEvent(reading, { type: "usage_updated", createdAt: 3, payload: {} }), reading);
  assert.deepEqual(applyPromptCacheEvent(reading, { type: "context_compacted", createdAt: 4 }), { ttl: "1h", expiresAt: null, recacheTokens: null });
  assert.equal(applyPromptCacheEvent(null, { type: "context_compacted", createdAt: 4 }), null);
});

test("expiring means the last two minutes of a five-minute cache and the last ten of an hour's", () => {
  const five = { ttl: "5m", expiresAt: 300_000, recacheTokens: 412_000 };
  assert.equal(promptCacheState(five, 0).kind, "warm");
  assert.equal(promptCacheState(five, 180_000).kind, "expiring");
  assert.equal(promptCacheState(five, 300_000).kind, "cold");
  const hour = { ttl: "1h", expiresAt: 3_600_000, recacheTokens: 412_000 };
  assert.equal(promptCacheState(hour, 2_999_000).kind, "warm");
  assert.equal(promptCacheState(hour, 3_000_000).kind, "expiring");
  assert.equal(promptCacheState(null, 0), null);
});

test("only a big conversation's going or gone cache is worth a notice", () => {
  const state = (recacheTokens) => promptCacheState({ ttl: "5m", expiresAt: 100_000, recacheTokens }, 0);
  assert.equal(promptCacheNeedsAttention(state(412_000)), true);
  assert.equal(promptCacheNeedsAttention(state(49_999)), false);
  assert.equal(promptCacheNeedsAttention(state(null)), false, "an unknown size is not assumed big");
  assert.equal(promptCacheNeedsAttention(promptCacheState({ ttl: "5m", expiresAt: 300_000, recacheTokens: 412_000 }, 0)), false, "warm");
});

test("the notice's words are the desktop's", () => {
  const expiring = promptCacheState({ ttl: "1h", expiresAt: 200_000, recacheTokens: 412_000 }, 0);
  assert.deepEqual(promptCacheCopy(expiring, 0), {
    label: "Cache expires in 3m",
    detail: "After that, the next message re-sends ~412k tokens uncached. Compacting now, while the cache is warm, is cheap.",
  });
  const cold = promptCacheState({ ttl: "5m", expiresAt: 100_000, recacheTokens: 412_000 }, 100_000 + 12 * 60_000);
  assert.deepEqual(promptCacheCopy(cold, 100_000 + 12 * 60_000), {
    label: "Cache expired 12m ago",
    detail: "The next message re-sends ~412k tokens uncached, a compaction included. Compacting first makes every message after it smaller.",
  });
  const never = promptCacheState({ ttl: null, expiresAt: null, recacheTokens: 412_000 }, 0);
  assert.equal(promptCacheCopy(never, 0).label, "Cache cold");
  assert.equal(promptCacheCopy(promptCacheState({ ttl: "5m", expiresAt: 30_000, recacheTokens: 60_000 }, 0), 0).label, "Cache expires in under a minute");
  assert.equal(promptCacheReadingKey({ ttl: "5m", expiresAt: null, recacheTokens: 5 }), "cold:5");
  assert.equal(formatTokenCount(12_345), "12.3k");
  assert.equal(formatTokenCount(1_200_000), "1.2M");
});

test("the composer's tray says the reading in one line, as the desktop's does", () => {
  const expiring = promptCacheState({ ttl: "1h", expiresAt: 200_000, recacheTokens: 198_000 }, 0);
  assert.equal(promptCacheLine(expiring, 0), "Cache expires in 3m · ~198k tokens cached");
  const cold = promptCacheState({ ttl: "5m", expiresAt: 100_000, recacheTokens: 198_000 }, 100_000 + 13 * 60_000);
  assert.equal(promptCacheLine(cold, 100_000 + 13 * 60_000), "Cache expired 13m ago · ~198k tokens uncached");
  const unknown = promptCacheState({ ttl: null, expiresAt: null, recacheTokens: null }, 0);
  assert.equal(promptCacheLine(unknown, 0), "Cache cold");
});
