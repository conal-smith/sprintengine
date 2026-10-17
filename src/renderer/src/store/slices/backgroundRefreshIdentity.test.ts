import assert from 'node:assert/strict'

import { produce } from 'immer'
import { test } from 'vitest'

import type { AgentCliAvailabilityMap } from '../../../../shared/electron-api'
import type { PluginCatalogEntry } from '../../types/workspace'
import { createCliAvailabilitySlice, type CliAvailabilitySliceState } from './cliAvailabilitySlice'
import { createPluginsSlice, type PluginsSliceState } from './pluginsSlice'

// The window's return re-reads the CLI availability map and the plugin
// catalog in the background, and main hands both back whole. Main holds the
// detection until Re-check, so the answer is nearly always the same; each
// re-read used to swap in an equal copy and re-render everything that reads
// either one. Driven through immer, as the store drives the slices.

function availability(versions: Record<string, string | null>): AgentCliAvailabilityMap {
  const out: AgentCliAvailabilityMap = {}
  for (const [cli, version] of Object.entries(versions)) {
    out[cli] = { cli, installed: version !== null, resolvedPath: version ? `/usr/bin/${cli}` : null, version }
  }
  return out
}

test('an unchanged availability re-read keeps the map and its entries', async () => {
  let state: CliAvailabilitySliceState = {
    cliAvailability: {},
    cliAvailabilityStatus: 'loading',
    cliAvailabilityError: null,
    cliAvailabilityCheckedAt: null,
  }
  let answer = availability({ codex: '0.161.0', 'claude-code': '2.1.0' })
  const slice = createCliAvailabilitySlice(
    (mutator) => {
      state = produce(state, mutator)
    },
    {
      getApi: () => ({
        pluginsDetectAvailability: async () => ({ ok: true as const, availability: structuredClone(answer) }),
      }),
    },
  )
  await slice.refreshCliAvailability()
  const first = state.cliAvailability

  await slice.refreshCliAvailability({ background: true })
  assert.equal(state.cliAvailability, first, 'the same answer keeps the map')

  answer = availability({ codex: '0.162.0', 'claude-code': '2.1.0' })
  await slice.refreshCliAvailability({ background: true })
  assert.notEqual(state.cliAvailability, first)
  assert.equal(state.cliAvailability['claude-code'], first['claude-code'], 'the CLI that did not move keeps its entry')
  assert.equal(state.cliAvailability.codex.version, '0.162.0')
})

test('an unchanged catalog re-read keeps the list and its entries', async () => {
  const entry = (id: string, version: number): PluginCatalogEntry =>
    ({
      id,
      displayName: id,
      source: 'bundled',
      version,
      binary: id,
      resumeSession: true,
      sessionIdFromCaller: false,
      agentStateCapable: true,
    }) as PluginCatalogEntry
  let state = {
    pluginCatalogEntries: [],
    pluginCatalogStatus: 'idle',
    pluginCatalogError: null,
  } as unknown as PluginsSliceState
  let plugins = [entry('codex', 1), entry('opencode', 1)]
  const slice = createPluginsSlice(
    (mutator) => {
      state = produce(state, mutator)
    },
    {
      getApi: () => ({ pluginsList: async () => ({ ok: true as const, plugins: structuredClone(plugins) }) }) as never,
    },
  )
  await slice.refreshPluginCatalog()
  const first = state.pluginCatalogEntries

  await slice.refreshPluginCatalog({ background: true })
  assert.equal(state.pluginCatalogEntries, first, 'the same answer keeps the list')

  plugins = [entry('codex', 2), entry('opencode', 1)]
  await slice.refreshPluginCatalog({ background: true })
  assert.notEqual(state.pluginCatalogEntries, first)
  assert.equal(state.pluginCatalogEntries[1], first[1], 'the plugin that did not move keeps its entry')
})
