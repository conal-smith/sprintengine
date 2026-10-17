import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { AgentCliAvailabilityMap } from '../../shared/electron-api'
import type { DiscoveredCliModel, DiscoveredCliModelCatalog } from '../../shared/cli-model-catalog'
import type { CliModelDiscoveryInput } from '../../shared/ipc/cli-model-discovery'
import { CliModelProbeError, type CliModelProbe } from './probe-types'
import {
  carryFirstSeenAt,
  createFileModelDiscoveryCache,
  discoverCliModels,
  type CliModelDiscoveryDeps,
  type ModelDiscoveryCache,
} from './service'

const DAY = 24 * 60 * 60 * 1000
const T0 = Date.parse('2026-09-22T10:00:00.000Z')
const iso = (ms: number): string => new Date(ms).toISOString()

const CLIS = [
  { id: 'codex', displayName: 'Codex', binary: 'codex' },
  { id: 'grok', displayName: 'Grok', binary: 'grok' },
  { id: 'kimi-code', displayName: 'Kimi Code', binary: 'kimi' },
]

function memoryCache(initial: Record<string, DiscoveredCliModelCatalog> = {}): ModelDiscoveryCache & {
  data: Record<string, DiscoveredCliModelCatalog>
  writes: number
} {
  const store = {
    data: { ...initial },
    writes: 0,
    read: async () => ({ ...store.data }),
    update: async (
      apply: (catalogs: Record<string, DiscoveredCliModelCatalog>) => Record<string, DiscoveredCliModelCatalog>,
    ) => {
      store.writes += 1
      store.data = apply({ ...store.data })
    },
  }
  return store
}

type Harness = {
  deps: CliModelDiscoveryDeps
  cache: ReturnType<typeof memoryCache>
  runs: string[]
  clock: { now: number }
  lists: Record<string, DiscoveredCliModel[] | Error>
  availability: AgentCliAvailabilityMap
}

function harness(initialCache: Record<string, DiscoveredCliModelCatalog> = {}): Harness {
  const runs: string[] = []
  const clock = { now: T0 }
  const lists: Harness['lists'] = {
    codex: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-sol' }],
    grok: [{ id: 'grok-4.6' }],
  }
  const probe = (cli: string): CliModelProbe => ({
    source: 'argv-probe',
    run: async () => {
      runs.push(cli)
      const answer = lists[cli]
      if (answer instanceof Error) throw answer
      return answer.map((model) => ({ ...model }))
    },
  })
  const availability: AgentCliAvailabilityMap = {
    codex: { cli: 'codex', installed: true, resolvedPath: '/Users/dev/.local/bin/codex', version: 'codex-cli 0.155.1' },
    grok: { cli: 'grok', installed: true, resolvedPath: '/Users/dev/.grok/bin/grok', version: 'grok 1.0.25' },
    'kimi-code': { cli: 'kimi-code', installed: true, resolvedPath: '/Users/dev/.local/bin/kimi', version: '1.2.0' },
  }
  const cache = memoryCache(initialCache)
  return {
    runs,
    clock,
    lists,
    availability,
    cache,
    deps: {
      listClis: () => CLIS,
      probes: { codex: probe('codex'), grok: probe('grok') },
      detect: async () => availability,
      cache,
      now: () => clock.now,
    },
  }
}

const entryFor = (result: Awaited<ReturnType<typeof discoverCliModels>>, cli: string) =>
  result.entries.find((entry) => entry.cli === cli)

test('the first-ever probe of a CLI dates no row; a CLI with no probe is skipped as such', async () => {
  const h = harness()
  const result = await discoverCliModels({}, h.deps)
  assert.deepEqual(entryFor(result, 'codex'), {
    cli: 'codex',
    catalog: {
      models: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-sol' }],
      fetchedAt: iso(T0),
      source: 'argv-probe',
      cliVersion: 'codex-cli 0.155.1',
    },
  })
  assert.deepEqual(entryFor(result, 'kimi-code'), { cli: 'kimi-code', catalog: null, skipped: 'no-probe' })
  assert.deepEqual(h.runs.sort(), ['codex', 'grok'])
  assert.equal(h.cache.data.codex?.fetchedAt, iso(T0), 'the answer is kept in main for the next pass to gate on')
  assert.equal(result.startedAt, iso(T0))
})

test('a later probe carries firstSeenAt forward by id and dates only the ids that are new', async () => {
  const h = harness()
  const previous: CliModelDiscoveryInput['previous'] = {
    codex: {
      models: [{ id: 'gpt-6-astra' }, { id: 'gpt-6-sol', firstSeenAt: iso(T0 - 10 * DAY) }, { id: 'gpt-5.5' }],
      fetchedAt: iso(T0 - 2 * DAY),
      source: 'argv-probe',
      cliVersion: 'codex-cli 0.155.1',
    },
  }
  h.lists.codex = [{ id: 'gpt-6-luna' }, { id: 'gpt-6-sol' }, { id: 'gpt-6-astra' }]
  const result = await discoverCliModels({ previous, clis: ['codex'] }, h.deps)
  assert.deepEqual(entryFor(result, 'codex')?.catalog?.models, [
    { id: 'gpt-6-luna', firstSeenAt: iso(T0) },
    { id: 'gpt-6-sol', firstSeenAt: iso(T0 - 10 * DAY) },
    { id: 'gpt-6-astra' },
  ])
  assert.equal(result.entries.length, 1, '`clis` narrows the pass')
})

test("main's own cache dates rows when the renderer sent nothing", async () => {
  const h = harness({
    codex: {
      models: [{ id: 'gpt-6-astra', firstSeenAt: iso(T0 - 40 * DAY) }],
      fetchedAt: iso(T0 - 3 * DAY),
      source: 'argv-probe',
      cliVersion: 'codex-cli 0.155.1',
    },
  })
  const result = await discoverCliModels({ clis: ['codex'] }, h.deps)
  assert.deepEqual(entryFor(result, 'codex')?.catalog?.models, [
    { id: 'gpt-6-astra', firstSeenAt: iso(T0 - 40 * DAY) },
    { id: 'gpt-6-sol', firstSeenAt: iso(T0) },
  ])
})

test('a catalog under a day old from the same version is fresh; force, age and a new version each re-probe', async () => {
  const h = harness()
  await discoverCliModels({}, h.deps)
  const first = { ...h.cache.data }
  h.runs.length = 0

  h.clock.now = T0 + 23 * 60 * 60 * 1000
  const fresh = await discoverCliModels({ previous: first }, h.deps)
  assert.deepEqual(entryFor(fresh, 'codex'), { cli: 'codex', catalog: null, skipped: 'fresh' })
  assert.deepEqual(h.runs, [], 'nothing was started')

  await discoverCliModels({ previous: first, force: true, clis: ['codex'] }, h.deps)
  assert.deepEqual(h.runs, ['codex'])

  h.runs.length = 0
  h.clock.now = T0 + 23 * 60 * 60 * 1000
  h.availability.grok = { ...h.availability.grok, version: 'grok 1.0.26' }
  await discoverCliModels({}, h.deps)
  assert.deepEqual(h.runs, ['grok'], 'an updated CLI is asked again at once')

  h.runs.length = 0
  // Codex was last asked (forced) at +23 h.
  h.clock.now = T0 + 47 * 60 * 60 * 1000 + 1
  await discoverCliModels({ clis: ['codex'] }, h.deps)
  assert.deepEqual(h.runs, ['codex'], 'a day-old catalog is asked again')
})

test('a fresh catalog main holds is handed to a renderer that does not hold it', async () => {
  const h = harness()
  await discoverCliModels({}, h.deps)
  const result = await discoverCliModels({ clis: ['codex'] }, h.deps)
  assert.equal(entryFor(result, 'codex')?.skipped, 'fresh')
  assert.deepEqual(entryFor(result, 'codex')?.catalog, h.cache.data.codex)
})

test('a failed probe returns words, writes nothing, and leaves the last good catalog', async () => {
  const h = harness()
  await discoverCliModels({}, h.deps)
  const before = structuredClone(h.cache.data)
  const writes = h.cache.writes
  h.lists.codex = new CliModelProbeError('Codex did not print its model list as JSON.')
  h.lists.grok = new Error('spawn EACCES')
  const result = await discoverCliModels({ force: true }, h.deps)
  assert.deepEqual(entryFor(result, 'codex'), {
    cli: 'codex',
    catalog: null,
    error: 'Codex did not print its model list as JSON.',
  })
  assert.deepEqual(entryFor(result, 'grok'), {
    cli: 'grok',
    catalog: null,
    error: 'Grok models could not be listed: spawn EACCES',
  })
  assert.equal(h.cache.writes, writes)
  assert.deepEqual(h.cache.data, before)
})

test('an absent CLI is skipped; one detection could not decide is an error; neither is probed', async () => {
  const h = harness()
  h.availability.codex = { ...h.availability.codex, installed: false, resolvedPath: null, version: null }
  delete (h.availability as Partial<AgentCliAvailabilityMap>).grok
  const result = await discoverCliModels({}, h.deps)
  assert.deepEqual(entryFor(result, 'codex'), { cli: 'codex', catalog: null, skipped: 'not-installed' })
  assert.deepEqual(entryFor(result, 'grok'), {
    cli: 'grok',
    catalog: null,
    error: 'Could not tell whether Grok is installed, so its models were not checked.',
  })
  assert.deepEqual(h.runs, [])
})

test('a probe that never settles is abandoned at the guard; the service never throws', async () => {
  const h = harness()
  h.deps.timeoutMs = 10
  h.deps.probes = { ...h.deps.probes, grok: { source: 'argv-probe', run: () => new Promise(() => {}) } }
  const guarded = discoverCliModels({ clis: ['grok'] }, h.deps)
  const result = await Promise.race([guarded, new Promise((resolve) => setTimeout(() => resolve('hung'), 8_000))])
  assert.notEqual(result, 'hung')
  assert.match(String(entryFor(result as never, 'grok')?.error), /did not list its models/)

  const broken = await discoverCliModels(
    { previous: { codex: { models: 'junk' } as never } },
    { ...harness().deps, detect: async () => Promise.reject(new Error('shell gone')) },
  )
  assert.ok(broken.entries.every((entry) => entry.catalog === null))
})

test('the probe gets the detected path and runs on the machine the CLI runtime names', async () => {
  const h = harness()
  const seen: Array<{ binary: string; hostId?: string; args: string[] }> = []
  h.deps.probes = {
    codex: {
      source: 'argv-probe',
      run: async (context) => {
        await context.runArgv(['debug', 'models'])
        return []
      },
    },
  }
  h.deps.runArgv = async (input) => {
    seen.push({ binary: input.binary, hostId: input.hostId, args: input.args })
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  await discoverCliModels(
    { clis: ['codex'], cliRuntimes: { codex: { command: 'codex', hostId: 'wsl:Ubuntu' } } },
    h.deps,
  )
  assert.deepEqual(seen, [{ binary: '/Users/dev/.local/bin/codex', hostId: 'wsl:Ubuntu', args: ['debug', 'models'] }])
})

test("the Grok probe runs with Grok's self-updater off; another CLI's probe gets nothing set", async () => {
  const h = harness()
  const seen: Record<string, Readonly<Record<string, string>> | undefined> = {}
  const argvProbe = (cli: string): CliModelProbe => ({
    source: 'argv-probe',
    run: async (context) => {
      await context.runArgv(['models'])
      return [{ id: `${cli}-model` }]
    },
  })
  h.deps.probes = { codex: argvProbe('codex'), grok: argvProbe('grok') }
  h.deps.runArgv = async (input) => {
    seen[input.binary] = input.setEnv
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  await discoverCliModels({ clis: ['codex', 'grok'] }, h.deps)
  assert.deepEqual(seen['/Users/dev/.grok/bin/grok'], { GROK_DISABLE_AUTOUPDATER: '1' })
  assert.deepEqual(seen['/Users/dev/.local/bin/codex'], {})
})

test('two overlapping passes share one probe of a CLI', async () => {
  const h = harness()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let starts = 0
  h.deps.probes = {
    codex: {
      source: 'argv-probe',
      run: async () => {
        starts += 1
        await gate
        return [{ id: 'gpt-6-astra' }]
      },
    },
  }
  const a = discoverCliModels({ clis: ['codex'] }, h.deps)
  const b = discoverCliModels({ clis: ['codex'], force: true }, h.deps)
  await new Promise((resolve) => setTimeout(resolve, 0))
  release()
  const [ra, rb] = await Promise.all([a, b])
  assert.equal(starts, 1)
  assert.deepEqual(entryFor(ra, 'codex')?.catalog?.models, [{ id: 'gpt-6-astra' }])
  assert.deepEqual(entryFor(rb, 'codex')?.catalog?.models, [{ id: 'gpt-6-astra' }])
})

test('carryFirstSeenAt drops a firstSeenAt a probe row carried in, and prefers the first baseline', () => {
  const now = iso(T0)
  assert.deepEqual(carryFirstSeenAt([{ id: 'a', firstSeenAt: '2000-01-01T00:00:00.000Z' }], [], now), [{ id: 'a' }])
  const renderer: DiscoveredCliModelCatalog = {
    models: [{ id: 'a', firstSeenAt: '2026-09-01T00:00:00.000Z' }],
    fetchedAt: now,
    source: 'agent-sdk',
  }
  const main: DiscoveredCliModelCatalog = {
    models: [
      { id: 'a', firstSeenAt: '2026-08-01T00:00:00.000Z' },
      { id: 'b', firstSeenAt: '2026-08-02T00:00:00.000Z' },
    ],
    fetchedAt: now,
    source: 'agent-sdk',
  }
  assert.deepEqual(carryFirstSeenAt([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [renderer, main], now), [
    { id: 'a', firstSeenAt: '2026-09-01T00:00:00.000Z' },
    { id: 'b', firstSeenAt: '2026-08-02T00:00:00.000Z' },
    { id: 'c', firstSeenAt: now },
  ])
})

test('the file cache survives a new process, ignores a damaged file, and serializes writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-discovery-cache-'))
  try {
    const path = join(dir, 'nested', 'model-discovery-cache.json')
    const catalog: DiscoveredCliModelCatalog = {
      models: [{ id: 'grok-4.6' }],
      fetchedAt: iso(T0),
      source: 'argv-probe',
    }
    const first = createFileModelDiscoveryCache(() => path)
    assert.deepEqual(await first.read(), {})
    await Promise.all([
      first.update((catalogs) => ({ ...catalogs, grok: catalog })),
      first.update((catalogs) => ({ ...catalogs, codex: { ...catalog, models: [] } })),
    ])
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, 'utf8')).catalogs).sort(), ['codex', 'grok'])
    assert.deepEqual((await createFileModelDiscoveryCache(() => path).read()).grok, catalog)

    writeFileSync(path, '{ not json')
    assert.deepEqual(await createFileModelDiscoveryCache(() => path).read(), {})
    writeFileSync(path, JSON.stringify({ version: 1, catalogs: { grok: catalog, codex: { models: 'x' } } }))
    assert.deepEqual(await createFileModelDiscoveryCache(() => path).read(), { grok: catalog })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty answer is a failure: nothing is stored and the last good list stays', async () => {
  const h = harness()
  await discoverCliModels({ clis: ['codex'] }, h.deps)
  const before = structuredClone(h.cache.data)
  h.lists.codex = []
  const result = await discoverCliModels({ clis: ['codex'], force: true }, h.deps)
  assert.deepEqual(entryFor(result, 'codex'), { cli: 'codex', catalog: null, error: 'Codex listed no models.' })
  assert.deepEqual(h.cache.data, before)
})

test('an empty stored catalog is no baseline, so the next answer dates no row', async () => {
  const empty: DiscoveredCliModelCatalog = {
    models: [],
    fetchedAt: iso(T0 - 2 * DAY),
    source: 'argv-probe',
    cliVersion: 'codex-cli 0.155.1',
  }
  const h = harness({ codex: empty })
  const result = await discoverCliModels({ clis: ['codex'], previous: { codex: empty } }, h.deps)
  assert.deepEqual(entryFor(result, 'codex')?.catalog?.models, [{ id: 'gpt-6-astra' }, { id: 'gpt-6-sol' }])
})
