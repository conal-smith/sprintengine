import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { UsagePricingSource } from '../../shared/usage-report'

// What a token costs, per model, for the usage dashboard's "API estimate":
// what the same tokens would have cost at the provider's list price. A
// subscription pays nothing per token, so on a plan the figure says what the
// plan was worth, not what was billed.
//
// Two tables. The live one is the public price list LiteLLM keeps for every
// provider (a JSON file on GitHub), read at most once a day and kept on disk so
// a run with no network prices from the last copy. The bundled one below holds
// the Claude and OpenAI models the agents run most, so a machine that has never
// reached the list still prices those. The live list wins where it has a model:
// it moves when a price does, and this file only moves with a release.
//
// A model neither table knows is unpriced, never free: its tokens still count,
// and the dashboard says "Unpriced" rather than $0.

/** USD per token. */
export type TokenRates = { input: number; output: number; cacheRead: number; cacheWrite: number }

/**
 * A model's list price, and what it costs at a premium speed where the list
 * names one: `fast` for Claude's fast mode and OpenAI's priority tier (Codex's
 * `fast`), `ultrafast` for OpenAI's ultrafast tier.
 */
export type ModelRates = TokenRates & { fast?: TokenRates; ultrafast?: TokenRates }

export type UsagePricing = {
  ratesFor(model: string): ModelRates | null
  source: UsagePricingSource
  /** When the live list was fetched (epoch ms), or null when only the bundled table prices. */
  fetchedAt: number | null
}

export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const LIVE_TTL_MS = 24 * 60 * 60 * 1000
/** A refresh asked for by hand fetches again, but not more than once a minute. */
const FORCED_FLOOR_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000
/** After a failed fetch, the copy at hand serves this long before the next try. */
const RETRY_AFTER_MS = 15 * 60_000

const MTOK = 1_000_000

/**
 * List prices per million tokens: input, output, and the cache read where it
 * is not a tenth of input. A cache write is 1.25x input (the five-minute
 * cache the CLIs use). `fast` is the premium speed's multiple of every rate,
 * where the model has one (the live list's `provider_specific_entry.fast` for
 * Claude, its `_priority` prices for OpenAI's).
 */
const BUNDLED: ReadonlyArray<
  readonly [model: string, input: number, output: number, cacheRead?: number, fast?: number]
> = [
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-5-5', 4, 20, 0.2, 2],
  ['claude-opus-5', 5, 25, undefined, 2],
  ['claude-opus-4-8', 5, 25, undefined, 2],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4-5', 5, 25],
  ['claude-opus-4-1', 15, 75],
  ['claude-opus-4', 15, 75],
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10],
  ['claude-sonnet-4-6', 3, 15],
  ['claude-sonnet-4-5', 3, 15],
  ['claude-sonnet-4', 3, 15],
  ['claude-3-7-sonnet', 3, 15],
  ['claude-haiku-5-5', 0.1, 0.5],
  ['claude-haiku-4-5', 1, 5],
  ['claude-3-5-haiku', 0.8, 4],
  ['gpt-5', 1.25, 10, undefined, 2],
  ['gpt-5-codex', 1.25, 10],
  ['gpt-5.1', 1.25, 10, undefined, 2],
  ['gpt-5.1-codex', 1.25, 10],
  ['gpt-5-mini', 0.25, 2, undefined, 1.8],
  ['gpt-5-nano', 0.05, 0.4],
]

function bundledTable(): Map<string, ModelRates> {
  const table = new Map<string, ModelRates>()
  for (const [model, input, output, cacheRead, fast] of BUNDLED) {
    const rates: TokenRates = {
      input: input / MTOK,
      output: output / MTOK,
      cacheRead: (cacheRead ?? input / 10) / MTOK,
      cacheWrite: (input * 1.25) / MTOK,
    }
    table.set(model, fast ? { ...rates, fast: scaled(rates, fast) } : rates)
  }
  return table
}

const scaled = (rates: TokenRates, by: number): TokenRates => ({
  input: rates.input * by,
  output: rates.output * by,
  cacheRead: rates.cacheRead * by,
  cacheWrite: rates.cacheWrite * by,
})

/**
 * One tier's prices from a live-list entry: the fields named with `suffix`
 * (`_priority`, `_ultrafast`), or the base ones for none. Null when its input
 * or output price is missing; a missing cache price falls back to that
 * tier's input price.
 */
function tierRates(entry: Record<string, unknown>, suffix: string): TokenRates | null {
  const input = finite(entry[`input_cost_per_token${suffix}`])
  const output = finite(entry[`output_cost_per_token${suffix}`])
  if (input === null || output === null) return null
  return {
    input,
    output,
    cacheRead: finite(entry[`cache_read_input_token_cost${suffix}`]) ?? input,
    cacheWrite: finite(entry[`cache_creation_input_token_cost${suffix}`]) ?? input,
  }
}

/**
 * Rates for a bucket at its speed: the premium tier's when the list prices
 * one, else the list price. A premium tier the list does not price is costed
 * at the list price, which under-reports it, rather than as unpriced: the
 * tokens were billed at least that, and the model's row should not lose its
 * cost over a tier the price list has not caught up with.
 */
export function ratesAtSpeed(rates: ModelRates, speed: 'fast' | 'ultrafast' | undefined): TokenRates {
  return (speed && rates[speed]) || rates
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

/**
 * The live list as a table. An entry missing its input or output price is left
 * out: half a price would under-report, which is worse than saying unpriced. A
 * missing cache price falls back to the input price, not to free. Keys are
 * lowercased, and a provider-qualified key (`xai/grok-4`) also answers to its
 * bare name when nothing else claims that name.
 */
export function parseLiteLlmPrices(document: unknown): Map<string, ModelRates> {
  const table = new Map<string, ModelRates>()
  const aliases = new Map<string, ModelRates | null>()
  if (!document || typeof document !== 'object') return table
  for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const base = tierRates(entry, '')
    if (!base) continue
    // A premium speed is priced either outright (OpenAI's `_priority` and
    // `_ultrafast` fields) or as a multiple of the list price (Claude's fast
    // mode, `provider_specific_entry.fast`).
    const multiple = finite(rec(entry.provider_specific_entry)?.fast)
    const fast = tierRates(entry, '_priority') ?? (multiple ? scaled(base, multiple) : null)
    const ultrafast = tierRates(entry, '_ultrafast')
    const rates: ModelRates = { ...base, ...(fast ? { fast } : {}), ...(ultrafast ? { ultrafast } : {}) }
    const name = key.toLowerCase()
    table.set(name, rates)
    const bare = name.slice(name.lastIndexOf('/') + 1)
    if (bare !== name) {
      // Two providers listing one name at different prices: the bare name is
      // ambiguous and answers to neither.
      const known = aliases.get(bare)
      aliases.set(bare, known === undefined || (known && sameRates(known, rates)) ? rates : null)
    }
  }
  for (const [bare, rates] of aliases) if (rates && !table.has(bare)) table.set(bare, rates)
  return table
}

const sameTokenRates = (a: TokenRates | undefined, b: TokenRates | undefined): boolean =>
  a === b ||
  (!!a &&
    !!b &&
    a.input === b.input &&
    a.output === b.output &&
    a.cacheRead === b.cacheRead &&
    a.cacheWrite === b.cacheWrite)

const sameRates = (a: ModelRates, b: ModelRates): boolean =>
  sameTokenRates(a, b) && sameTokenRates(a.fast, b.fast) && sameTokenRates(a.ultrafast, b.ultrafast)

const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** Names that are an alias or a placeholder, never one billed model. */
const UNPRICEABLE = new Set(['<synthetic>', 'synthetic', 'default', 'unknown', 'opus', 'sonnet', 'haiku', 'fable'])

/**
 * The names to look a model up under, most specific first: as written, without
 * a context-window suffix (`claude-opus-4-6[1m]`), without a release date
 * (`claude-haiku-4-5-20251001`), and without a provider in front.
 */
export function modelLookupKeys(model: string): string[] {
  const keys: string[] = []
  const add = (key: string): void => {
    if (key && !keys.includes(key)) keys.push(key)
  }
  let name = model.trim().toLowerCase()
  add(name)
  name = name.replace(/\[[^\]]*\]$/, '')
  add(name)
  const bare = name.slice(name.lastIndexOf('/') + 1)
  add(bare)
  add(bare.replace(/-\d{8}$/, ''))
  add(bare.replace(/@\d{8}$/, ''))
  return keys
}

export function createPricing(
  live: Map<string, ModelRates> | null,
  meta: { source: UsagePricingSource; fetchedAt: number | null },
): UsagePricing {
  const bundled = bundledTable()
  const cache = new Map<string, ModelRates | null>()
  return {
    ...meta,
    ratesFor(model) {
      const known = cache.get(model)
      if (known !== undefined) return known
      let rates: ModelRates | null = null
      if (!UNPRICEABLE.has(model.trim().toLowerCase())) {
        for (const key of modelLookupKeys(model)) {
          rates = live?.get(key) ?? bundled.get(key) ?? null
          if (rates) break
        }
      }
      cache.set(model, rates)
      return rates
    },
  }
}

export type PricingStoreDeps = {
  /** Where the last copy of the live list is kept. */
  cacheFile: () => string
  fetch?: typeof fetch
  now?: () => number
}

type PricesFile = { fetchedAt: number; document: unknown }

/**
 * The live list, read lazily: the copy on disk when it is under a day old, a
 * fetch when it is not (or when a refresh is asked for and the last fetch is
 * over a minute old), and whatever copy there is when the fetch fails.
 */
export function createPricingStore(deps: PricingStoreDeps) {
  const now = deps.now ?? Date.now
  let current: { table: Map<string, ModelRates>; fetchedAt: number } | null = null
  let loaded = false
  let pending: Promise<UsagePricing> | null = null
  let lastFetchFailed = false
  let lastAttemptAt = -Infinity

  async function loadFromDisk(): Promise<void> {
    if (loaded) return
    loaded = true
    try {
      const file = JSON.parse(await readFile(deps.cacheFile(), 'utf8')) as Partial<PricesFile>
      if (typeof file.fetchedAt === 'number')
        current = { table: parseLiteLlmPrices(file.document), fetchedAt: file.fetchedAt }
    } catch {
      // No copy yet.
    }
  }

  async function fetchLive(): Promise<boolean> {
    const fetcher = deps.fetch ?? globalThis.fetch
    if (typeof fetcher !== 'function') return false
    try {
      const response = await fetcher(LITELLM_PRICES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) return false
      const document = (await response.json()) as unknown
      const table = parseLiteLlmPrices(document)
      if (table.size === 0) return false
      const fetchedAt = now()
      current = { table, fetchedAt }
      const path = deps.cacheFile()
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.${process.pid}.tmp`
      await writeFile(temporary, JSON.stringify({ fetchedAt, document } satisfies PricesFile), 'utf8')
      await rename(temporary, path)
      return true
    } catch {
      return false
    }
  }

  function snapshot(): UsagePricing {
    if (!current) return createPricing(null, { source: 'bundled', fetchedAt: null })
    const fresh = !lastFetchFailed && now() - current.fetchedAt < LIVE_TTL_MS
    return createPricing(current.table, { source: fresh ? 'live' : 'cached', fetchedAt: current.fetchedAt })
  }

  return {
    /** The prices to use now; `force` fetches the live list again (a refresh asked for by hand). */
    get(options: { force?: boolean } = {}): Promise<UsagePricing> {
      pending ??= (async () => {
        try {
          await loadFromDisk()
          const age = current ? now() - current.fetchedAt : Infinity
          const due = options.force
            ? age >= FORCED_FLOOR_MS && now() - lastAttemptAt >= FORCED_FLOOR_MS
            : age >= LIVE_TTL_MS && now() - lastAttemptAt >= RETRY_AFTER_MS
          if (due) {
            lastAttemptAt = now()
            lastFetchFailed = !(await fetchLive())
          }
          return snapshot()
        } finally {
          pending = null
        }
      })()
      return pending
    },
  }
}

export type PricingStore = ReturnType<typeof createPricingStore>
