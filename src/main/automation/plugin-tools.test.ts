// `plugin.search` and `plugin.offer`: what an agent is told about the plugins
// the Extensions door lists, and the refusals that keep an offer to plugins
// that are really there.

import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { SkillScanOutcome } from '../../shared/ipc/skills'
import type { McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import type { ScanResult, ScannedPlugin, ScannedSkill, SkillSource } from '../../shared/skills'
import { SHELL_TOOLSETS } from '../../server/desktop/shell-toolsets'
import { gatewayToolDefinitions } from './offer-gateway-tools'
import { createPluginTools, PLUGIN_OFFER_TOOL, PLUGIN_SEARCH_TOOL } from './plugin-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { localOnlyGatewayToolReason } from './tailnet/tailnet-scopes'

function source(id: string, name: string): SkillSource {
  return { id, kind: 'github', name, repo: `acme/${id}`, monogram: 'AC', blurb: '', commitSha: '', scannedAt: '' }
}

function skill(id: string): ScannedSkill {
  return { id, name: id, description: '', group: '', files: [], allowedTools: [], hasExecutables: false }
}

function plugin(id: string, overrides: Partial<ScannedPlugin> = {}): ScannedPlugin {
  return {
    id,
    name: id,
    description: '',
    version: '',
    category: '',
    author: '',
    homepage: '',
    origin: { kind: 'in-tree', path: `plugins/${id}` },
    strict: true,
    tags: [],
    keywords: [],
    componentsKnown: true,
    components: {
      skills: [],
      commands: [],
      agents: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
      missingSkills: [],
    },
    ...overrides,
  }
}

function scan(plugins: ScannedPlugin[]): ScanResult {
  return { skills: [], groups: [], groupingSignal: 'none', fileCount: 0, commitSha: '', plugins } as ScanResult
}

const official = source('official', 'Claude plugins')
const team = source('team', 'Team plugins')
const broken = source('broken', 'Broken source')

const scans: Record<string, SkillScanOutcome> = {
  official: {
    ok: true,
    source: official,
    scan: scan([
      plugin('sentry', {
        name: 'Sentry',
        description: 'Read issues and stack traces from Sentry.',
        components: { ...plugin('x').components, skills: [skill('a'), skill('b')] },
      }),
      plugin('linked', { componentsKnown: false, description: 'Not read yet.' }),
    ]),
  },
  team: { ok: true, source: team, scan: scan([plugin('postgres', { tags: ['database'] })]) },
  broken: { ok: false, message: 'Could not reach GitHub.' },
}

function tools(): Record<'search' | 'offer', McpToolRegistration> {
  const [search, offer] = createPluginTools({
    listSources: async () => ({ ok: true, sources: [official, team, broken], transport: 'git' }),
    getScan: async ({ sourceId }) => scans[sourceId] ?? { ok: false, message: 'That source is not in your list.' },
  })
  return { search: search!, offer: offer! }
}

function body(result: McpToolResult): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>
}

test('search lists every source’s plugins, says which sources could not be read, and counts only what was read', async () => {
  const result = body(await tools().search.handler({}))
  assert.equal(result.total, 3)
  assert.deepEqual(result.unreadableSources, ['Broken source'])
  const plugins = result.plugins as Array<Record<string, unknown>>
  assert.deepEqual(plugins[0], {
    sourceId: 'official',
    source: 'Claude plugins',
    pluginId: 'sentry',
    name: 'Sentry',
    description: 'Read issues and stack traces from Sentry.',
    skills: 2,
    mcpServers: 0,
  })
  // Listed but not read: no counts, rather than a "0 skills" that is wrong.
  assert.equal('skills' in plugins[1]!, false)
})

test('search matches every word against the name, description and tags', async () => {
  const byTag = body(await tools().search.handler({ query: 'Database' }))
  assert.deepEqual(
    (byTag.plugins as Array<Record<string, unknown>>).map((found) => found.pluginId),
    ['postgres'],
  )
  const both = body(await tools().search.handler({ query: 'sentry traces' }))
  assert.equal(both.total, 1)
  const neither = body(await tools().search.handler({ query: 'sentry database' }))
  assert.equal(neither.total, 0)
})

test('offer answers the plugin as the catalogue has it, and refuses one that is not there', async () => {
  const offered = body(await tools().offer.handler({ sourceId: 'official', pluginId: 'sentry' }))
  assert.equal(offered.ok, true)
  assert.equal(offered.name, 'Sentry')

  const unknownPlugin = await tools().offer.handler({ sourceId: 'official', pluginId: 'gmail' })
  assert.equal(unknownPlugin.isError, true)
  assert.match(String(unknownPlugin.content[0]?.type === 'text' && unknownPlugin.content[0].text), /unknown_plugin/u)

  const unknownSource = await tools().offer.handler({ sourceId: 'nowhere', pluginId: 'sentry' })
  assert.equal(unknownSource.isError, true)

  const noIds = await tools().offer.handler({ sourceId: 'official' })
  assert.equal(noIds.isError, true)
})

test('neither tool changes anything, and both stay with agents on this machine', () => {
  for (const name of [PLUGIN_SEARCH_TOOL, PLUGIN_OFFER_TOOL]) {
    assert.equal(isStudioGatewayMutation(name), false, name)
    assert.notEqual(localOnlyGatewayToolReason(name), null, name)
  }
  assert.equal(tools().search.mutates, false)
  assert.equal(tools().offer.mutates, false)
})

test('out of process the shell offers them as its own `plugin` toolset', () => {
  assert.ok((SHELL_TOOLSETS as readonly string[]).includes('plugin'))
  assert.deepEqual(
    gatewayToolDefinitions('plugin', Object.values(tools())).map((tool) => tool.name),
    ['search', 'offer'],
  )
})

test('a source too slow to answer is named unreadable, and Studio’s own plugin is never offered', async () => {
  const [search, offer] = createPluginTools({
    listSources: async () => ({ ok: true, sources: [official, team], transport: 'git' }),
    getScan: ({ sourceId }) =>
      sourceId === 'team'
        ? new Promise<SkillScanOutcome>(() => {})
        : Promise.resolve({
            ok: true,
            source: official,
            scan: scan([plugin('sprintengine-studio'), plugin('sentry')]),
          }),
    sourceReadMs: 10,
  })
  const result = body(await search!.handler({}))
  assert.deepEqual(result.unreadableSources, ['Team plugins'])
  assert.deepEqual(
    (result.plugins as Array<Record<string, unknown>>).map((found) => found.pluginId),
    ['sentry'],
  )
  assert.equal((await offer!.handler({ sourceId: 'official', pluginId: 'sprintengine-studio' })).isError, true)
})
