import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { createPricing, createPricingStore, modelLookupKeys, parseLiteLlmPrices } from './usage-pricing'

const MTOK = 1_000_000
const near = (actual: number | undefined, expected: number): void =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-15, `${actual} ≈ ${expected}`)

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'se-usage-pricing-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('the live list keeps whole prices only, and a missing cache price is the input price', () => {
  const table = parseLiteLlmPrices({
    sample_spec: { input_cost_per_token: 'n/a' },
    'gpt-x': { input_cost_per_token: 1e-6, output_cost_per_token: 8e-6, cache_read_input_token_cost: 1e-7 },
    'half-priced': { input_cost_per_token: 1e-6 },
    'xai/grok-9': { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6 },
    'vendor-a/shared': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    'vendor-b/shared': { input_cost_per_token: 5e-6, output_cost_per_token: 9e-6 },
  })
  assert.deepEqual(table.get('gpt-x'), { input: 1e-6, output: 8e-6, cacheRead: 1e-7, cacheWrite: 1e-6 })
  assert.equal(table.has('half-priced'), false)
  assert.equal(table.has('sample_spec'), false)
  // A provider's model answers to its bare name too…
  assert.equal(table.get('grok-9')?.input, 3e-6)
  // …unless two providers price that name differently.
  assert.equal(table.has('shared'), false)
})

test('a model is looked up without its window suffix, release date or provider', () => {
  assert.deepEqual(modelLookupKeys('Claude-Opus-4-6[1m]'), ['claude-opus-4-6[1m]', 'claude-opus-4-6'])
  assert.ok(modelLookupKeys('claude-haiku-4-5-20251001').includes('claude-haiku-4-5'))
  assert.ok(modelLookupKeys('anthropic/claude-sonnet-4-5').includes('claude-sonnet-4-5'))
})

test('the live list wins; the bundled table covers what it lacks; aliases and placeholders are unpriced', () => {
  const live = new Map([['claude-opus-5-5', { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }]])
  const pricing = createPricing(live, { source: 'live', fetchedAt: 1 })
  assert.equal(pricing.ratesFor('claude-opus-5-5')?.input, 1)
  const haiku = pricing.ratesFor('claude-haiku-4-5-20251001')
  near(haiku?.input, 1 / MTOK)
  near(haiku?.cacheRead, 0.1 / MTOK)
  near(haiku?.cacheWrite, 1.25 / MTOK)
  // Opus 5.5's cache read is its own price, not a tenth of input.
  near(createPricing(null, { source: 'bundled', fetchedAt: null }).ratesFor('claude-opus-5-5')?.cacheRead, 0.2 / MTOK)
  for (const model of ['<synthetic>', 'default', 'opus', 'mimo-v2.6-flash-free']) {
    assert.equal(pricing.ratesFor(model), null, model)
  }
})

test('the price list is fetched once a day, kept on disk, and a failed fetch falls back to the copy', async () => {
  let clock = Date.parse('2026-10-10T12:00:00Z')
  const calls: string[] = []
  let failing = false
  const fetchStub = (async (url: string) => {
    calls.push(url)
    if (failing) throw new Error('offline')
    return new Response(JSON.stringify({ 'gpt-x': { input_cost_per_token: 2e-6, output_cost_per_token: 4e-6 } }))
  }) as unknown as typeof fetch
  const cacheFile = join(dir, 'usage', 'model-prices.json')
  const store = createPricingStore({ cacheFile: () => cacheFile, fetch: fetchStub, now: () => clock })

  const first = await store.get()
  assert.equal(first.source, 'live')
  assert.equal(first.ratesFor('gpt-x')?.input, 2e-6)
  assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).fetchedAt, clock)

  clock += 60 * 60_000
  await store.get()
  assert.equal(calls.length, 1, 'under a day old: no second fetch')

  // A new process reads the copy rather than fetching.
  const reopened = createPricingStore({ cacheFile: () => cacheFile, fetch: fetchStub, now: () => clock })
  assert.equal((await reopened.get()).ratesFor('gpt-x')?.output, 4e-6)
  assert.equal(calls.length, 1)

  clock += 25 * 60 * 60_000
  failing = true
  const stale = await store.get()
  assert.equal(calls.length, 2)
  assert.equal(stale.source, 'cached')
  assert.equal(stale.ratesFor('gpt-x')?.input, 2e-6)
  await store.get()
  assert.equal(calls.length, 2, 'a failed fetch is not retried on the next read')
})

test('with no copy and no network, the bundled table prices alone', async () => {
  const store = createPricingStore({
    cacheFile: () => join(dir, 'none.json'),
    fetch: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
  })
  const pricing = await store.get()
  assert.equal(pricing.source, 'bundled')
  assert.equal(pricing.fetchedAt, null)
  assert.ok(pricing.ratesFor('claude-sonnet-4-5'))
})

test('the live list keeps premium speeds: priced outright, or as a multiple of the list price', () => {
  const table = parseLiteLlmPrices({
    'gpt-tiered': {
      input_cost_per_token: 2e-6,
      output_cost_per_token: 10e-6,
      cache_read_input_token_cost: 2e-7,
      input_cost_per_token_priority: 4e-6,
      output_cost_per_token_priority: 20e-6,
      cache_read_input_token_cost_priority: 4e-7,
      input_cost_per_token_ultrafast: 12e-6,
      output_cost_per_token_ultrafast: 60e-6,
    },
    'claude-fast': {
      input_cost_per_token: 4e-6,
      output_cost_per_token: 20e-6,
      cache_read_input_token_cost: 2e-7,
      cache_creation_input_token_cost: 5e-6,
      provider_specific_entry: { us: 1.1, fast: 2 },
    },
    // Half a priority price is no price for that tier.
    'gpt-half-tier': { input_cost_per_token: 5e-8, output_cost_per_token: 4e-7, input_cost_per_token_priority: 2.5e-6 },
  })
  assert.deepEqual(table.get('gpt-tiered')?.fast, { input: 4e-6, output: 20e-6, cacheRead: 4e-7, cacheWrite: 4e-6 })
  assert.deepEqual(table.get('gpt-tiered')?.ultrafast, {
    input: 12e-6,
    output: 60e-6,
    cacheRead: 12e-6,
    cacheWrite: 12e-6,
  })
  assert.deepEqual(table.get('claude-fast')?.fast, { input: 8e-6, output: 40e-6, cacheRead: 4e-7, cacheWrite: 10e-6 })
  assert.equal(table.get('claude-fast')?.ultrafast, undefined)
  assert.equal(table.get('gpt-half-tier')?.fast, undefined)
  assert.equal(table.get('gpt-half-tier')?.input, 5e-8)
})

test('the bundled table prices fast mode for the models that have it', () => {
  const pricing = createPricing(null, { source: 'bundled', fetchedAt: null })
  near(pricing.ratesFor('claude-opus-5-5')?.fast?.output, 40 / MTOK)
  near(pricing.ratesFor('gpt-5')?.fast?.input, 2.5 / MTOK)
  assert.equal(pricing.ratesFor('claude-sonnet-4-5')?.fast, undefined)
})
