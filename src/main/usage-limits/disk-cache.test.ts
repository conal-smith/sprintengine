import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { createUsageLimitsDiskCache, readUsageLimitsCache, USAGE_LIMITS_CACHE_FILE } from './disk-cache'
import { createUsageLimitsStore } from './store'

const HOUR = 60 * 60 * 1000
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function scratchFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'usage-limits-'))
  dirs.push(dir)
  return join(dir, USAGE_LIMITS_CACHE_FILE)
}

test('a reading written by one run is restored by the next, as of when it was read', async () => {
  const file = await scratchFile()
  const now = Date.now()
  const first = createUsageLimitsStore()
  const cache = createUsageLimitsDiskCache({ file, debounceMs: 5 })
  await cache.attach(first)
  first.noteBilling('codex', 'subscription', 'plus')
  first.noteWindows(
    'codex',
    [
      {
        id: 'codex:primary',
        label: 'Session (5h)',
        usedPercent: 33,
        resetsAt: now + HOUR,
        durationMs: 5 * HOUR,
        status: 'allowed',
      },
    ],
    now - 1000,
  )
  first.noteWindows('claude', [{ id: 'seven_day', label: 'Weekly', usedPercent: 12, resetsAt: now + 24 * HOUR }], now)
  await cache.dispose()

  const second = createUsageLimitsStore()
  await createUsageLimitsDiskCache({ file }).attach(second)
  expect(second.state()).toEqual(first.state())
  expect(second.state().snapshots.find((snapshot) => snapshot.provider === 'codex')?.observedAt).toBe(now - 1000)
})

test('an API-billed provider is never written', async () => {
  const file = await scratchFile()
  const store = createUsageLimitsStore()
  const cache = createUsageLimitsDiskCache({ file, debounceMs: 5 })
  await cache.attach(store)
  // A reading an earlier run kept, and this run's only Claude chat on a key.
  const at = Date.now()
  store.restore([
    {
      provider: 'claude',
      billing: 'subscription',
      windows: [
        { id: 'five_hour', label: 'five_hour', usedPercent: 5, resetsAt: at + HOUR, status: 'allowed', observedAt: at },
      ],
      observedAt: at,
    },
  ])
  store.noteBilling('claude', 'api')
  await cache.dispose()
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, snapshots: [] })
})

test('a missing, malformed or foreign file is an empty cache, and a bad window drops alone', async () => {
  const file = await scratchFile()
  expect(await readUsageLimitsCache(file)).toEqual([])
  await writeFile(file, '{not json')
  expect(await readUsageLimitsCache(file)).toEqual([])
  await writeFile(file, JSON.stringify({ version: 99, snapshots: [] }))
  expect(await readUsageLimitsCache(file)).toEqual([])
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      snapshots: [
        { provider: 'gemini', billing: 'subscription', windows: [], observedAt: 5 },
        { provider: 'claude', billing: 'api', windows: [], observedAt: 5 },
        {
          provider: 'claude',
          billing: 'subscription',
          observedAt: 5,
          windows: [
            {
              id: 'five_hour',
              label: 'Session (5h)',
              usedPercent: 40,
              resetsAt: 9e12,
              status: 'allowed',
              observedAt: 5,
            },
            { id: 'seven_day', label: 'Weekly', usedPercent: 40, resetsAt: 9e12, status: 'exploded', observedAt: 5 },
          ],
        },
      ],
    }),
  )
  const snapshots = await readUsageLimitsCache(file)
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0].windows.map((window) => window.id)).toEqual(['five_hour'])
})

test('a model’s own window read back from a cache that predates its scope is still that model’s', async () => {
  const file = await scratchFile()
  const now = Date.now()
  const window = (id: string, label: string) => ({
    id,
    label,
    usedPercent: 100,
    resetsAt: now + HOUR,
    status: 'rejected',
    observedAt: now,
  })
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      snapshots: [
        {
          provider: 'claude',
          billing: 'subscription',
          observedAt: now,
          windows: [window('seven_day_opus', 'Weekly · Opus'), window('five_hour', 'Session (5h)')],
        },
        {
          provider: 'codex',
          billing: 'subscription',
          observedAt: now,
          windows: [window('codex_spark:primary', 'Spark')],
        },
      ],
    }),
  )
  const scopes = (await readUsageLimitsCache(file)).flatMap((snapshot) =>
    snapshot.windows.map((entry) => [entry.id, entry.scope ?? null]),
  )
  expect(scopes).toEqual([
    ['seven_day_opus', 'model'],
    ['five_hour', null],
    ['codex_spark:primary', 'model'],
  ])
})
