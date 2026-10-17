import assert from 'node:assert/strict'

import {
  buildAgentCliCatalog,
  buildCliRuntimeOptions,
  cliRuntimeForPlugin,
  conversationCliRuntimesFor,
  filterCatalogByAvailability,
  installableCliSummary,
  isAgentCliAvailable,
  isAgentCliMissing,
  orderInstalledPlugins,
  pluginRegistryIdForCli,
  resolveAvailableAgentCli,
  resolveCliModel,
  resolveLaunchableAgentCli,
  resolveCliReasoning,
  resolveTemplateAgentCli,
  selectAgentCliCatalog,
} from './cliRuntimeOptions'
import type { AgentCliAvailabilityMap, PluginCatalogEntry } from '../../../types/workspace'
import type { DiscoveredCliModel } from '../../../../../shared/cli-model-catalog'
import { test } from 'vitest'

test('cliRuntimeOptions', async () => {
  function availabilityMap(map: Record<string, boolean>): AgentCliAvailabilityMap {
    const out: AgentCliAvailabilityMap = {}
    for (const [cli, installed] of Object.entries(map)) {
      out[cli] = { cli, installed, resolvedPath: installed ? `/bin/${cli}` : null, version: installed ? '1' : null }
    }
    return out
  }

  // Registry entries always carry the resume capabilities and the agent-state
  // eligibility projected from the manifest. Catalog building never reads the
  // resume pair, so fixtures declare it once here; `agentStateCapable` defaults
  // true (an ordinary agent CLI) and is overridden where a test exercises the
  // hooks-only gate.
  const cliEntry = (
    entry: Omit<PluginCatalogEntry, 'resumeSession' | 'sessionIdFromCaller' | 'agentStateCapable'> &
      Partial<Pick<PluginCatalogEntry, 'agentStateCapable'>>,
  ): PluginCatalogEntry => ({ resumeSession: false, sessionIdFromCaller: false, agentStateCapable: true, ...entry })

  const plugins: PluginCatalogEntry[] = [
    cliEntry({ id: 'opencode', displayName: 'OpenCode', source: 'user', version: 1, binary: 'opencode' }),
    cliEntry({ id: 'codex', displayName: 'Codex', source: 'bundled', version: 1, binary: 'codex' }),
    cliEntry({ id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' }),
    cliEntry({ id: 'codex', displayName: 'Codex Duplicate', source: 'user', version: 2, binary: 'codex-next' }),
  ]

  assert.deepEqual(
    buildAgentCliCatalog(plugins).map(({ value, label, source }) => ({ value, label, source })),
    [
      { value: 'codex', label: 'Codex', source: 'bundled' },
      { value: 'claude-code', label: 'Claude Code', source: 'bundled' },
      { value: 'opencode', label: 'OpenCode', source: 'user' },
    ],
    'catalog orders bundled before user entries, labels from displayName, and dedupes ids',
  )
  // Bundled CLIs ship NO seeded model ids (no speculative entitlement guesses):
  // the fallback catalog exposes model UI via allowCustomId with an empty options
  // list, so the bare CLI row is the only default and users add their own ids.
  assert.deepEqual(
    buildAgentCliCatalog(plugins).find((option) => option.value === 'codex')?.modelSelection,
    { options: [], allowCustomId: true },
    'bundled Codex exposes the add-your-own model UI with no seeded options',
  )
  assert.deepEqual(
    buildAgentCliCatalog(plugins).find((option) => option.value === 'claude-code')?.modelSelection,
    { options: [], allowCustomId: true },
    'bundled Claude Code exposes the add-your-own model UI with no seeded options',
  )

  assert.deepEqual(
    buildAgentCliCatalog(null, {
      opencode: { command: 'opencode' },
      codex: { command: 'codex-next' },
    }).map(({ value, label }) => ({ value, label })),
    [
      { value: 'codex', label: 'Codex' },
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
    ],
    'missing registry data falls back to canonical bundled plugins plus configured overrides',
  )
  assert.ok(
    buildAgentCliCatalog(null, {
      codex: { command: 'codex-next', models: ['custom-codex'] },
    })
      .find((option) => option.value === 'codex')
      ?.modelSelection?.options.some((model) => model.id === 'custom-codex'),
    'fallback bundled Codex model metadata includes user-added model ids',
  )
  assert.deepEqual(
    buildCliRuntimeOptions(undefined).map(({ value, label }) => ({ value, label })),
    [
      { value: 'codex', label: 'Codex' },
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
    ],
  )
  assert.deepEqual(buildAgentCliCatalog([]), [], 'loaded empty registry does not invent fallback entries')

  assert.deepEqual(
    buildAgentCliCatalog([
      cliEntry({ id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' }),
      cliEntry({ id: 'generic-shell', displayName: 'Generic Shell', source: 'bundled', version: 1, binary: 'sh' }),
    ]).map(({ value, label, source }) => ({ value, label, source })),
    [{ value: 'claude-code', label: 'Claude Code', source: 'bundled' }],
    'generic-shell is hidden from the agent CLI picker catalog',
  )

  // Hooks-only selectability (decision of record 2026-08-31): the catalog gates
  // on the manifest-projected agentStateCapable flag, so a CLI that cannot
  // report agent state is not offered — by capability, not by name.
  assert.deepEqual(
    buildAgentCliCatalog([
      cliEntry({ id: 'claude-code', displayName: 'Claude Code', source: 'bundled', version: 1, binary: 'claude' }),
      cliEntry({
        id: 'no-hooks-cli',
        displayName: 'No Hooks',
        source: 'user',
        version: 1,
        binary: 'nh',
        agentStateCapable: false,
      }),
      cliEntry({
        id: 'muse',
        displayName: 'Muse Code',
        source: 'bundled',
        version: 1,
        binary: 'muse',
        agentStateCapable: false,
      }),
    ]).map(({ value }) => value),
    ['claude-code'],
    'a CLI without agent-state capability is not offered as an agent',
  )
  // The zero-core-edit proof: a future CLI whose manifest declares an
  // agentStateSpec becomes selectable with no code change anywhere — the
  // projected boolean is the whole gate.
  assert.deepEqual(
    buildAgentCliCatalog([
      cliEntry({ id: 'future-cli', displayName: 'Future CLI', source: 'user', version: 1, binary: 'future' }),
    ]).map(({ value }) => value),
    ['future-cli'],
    'a hook-capable future CLI is selectable purely from its manifest projection',
  )
  // A stale persisted snapshot from an older main process lacks the field
  // entirely; the catalog must keep it (fail-open on skew) until the live
  // registry refreshes, rather than emptying every picker.
  assert.deepEqual(
    buildAgentCliCatalog([
      {
        id: 'codex',
        displayName: 'Codex',
        source: 'bundled',
        version: 1,
        binary: 'codex',
        resumeSession: false,
        sessionIdFromCaller: false,
      } as unknown as PluginCatalogEntry,
    ]).map(({ value }) => value),
    ['codex'],
    'an entry missing the flag (older snapshot) stays offered until refreshed',
  )
  // muse is also pinned in the manifest-less fallback set: a persisted
  // cliRuntimes key cannot leak it into the loading/error fallback catalog.
  assert.deepEqual(
    buildAgentCliCatalog(null, {
      muse: { command: 'muse' },
      'generic-shell': { command: 'sh' },
    }).map(({ value }) => value),
    ['codex', 'claude-code', 'opencode'],
    'hidden ids never leak into the legacy fallback catalog via cliRuntimes keys',
  )

  const catalog = buildAgentCliCatalog(plugins)
  assert.equal(pluginRegistryIdForCli('claude-code'), 'claude-code')
  assert.equal(pluginRegistryIdForCli('aider'), 'aider')
  assert.equal(isAgentCliAvailable('claude', catalog), false, 'legacy Claude CLI id is not available')
  assert.equal(isAgentCliAvailable('opencode', catalog), true)
  assert.equal(isAgentCliAvailable('aider', catalog), false)
  assert.equal(resolveAvailableAgentCli('claude', catalog), 'claude-code')
  assert.equal(resolveAvailableAgentCli('missing-cli', catalog, 'codex'), 'codex')
  assert.equal(resolveAvailableAgentCli('missing-cli', catalog, 'aider'), 'codex')
  assert.equal(isAgentCliMissing('claude', catalog), true)
  assert.equal(isAgentCliMissing('aider', catalog), true)

  // selectAgentCliCatalog: status gates whether registry entries are trusted.
  assert.deepEqual(
    selectAgentCliCatalog('ready', plugins).map((option) => option.value),
    ['codex', 'claude-code', 'opencode'],
    'ready status surfaces installed plugins (incl. opencode) before user entries',
  )
  assert.deepEqual(
    selectAgentCliCatalog('loading', plugins, { opencode: { command: 'opencode' } }).map(({ value, label }) => ({
      value,
      label,
    })),
    [
      { value: 'codex', label: 'Codex' },
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
    ],
    'loading status ignores registry entries and falls back to canonical bundled plugins + configured runtimes',
  )
  assert.deepEqual(
    selectAgentCliCatalog('error', plugins).map(({ value, label }) => ({ value, label })),
    [
      { value: 'codex', label: 'Codex' },
      { value: 'claude-code', label: 'Claude Code' },
      { value: 'opencode', label: 'OpenCode' },
    ],
    'registry error falls back to canonical bundled plugin options',
  )
  assert.deepEqual(
    selectAgentCliCatalog('ready', []),
    [],
    'ready status with no installed plugins returns an empty catalog instead of inventing fallbacks',
  )
  // A persisted `generic-shell` runtime key must not leak the hidden id into the
  // loading/error fallback catalog — both catalog paths apply the picker hidden
  // set, so the automation editor's fail-closed cli check never sees it as valid.
  assert.deepEqual(
    selectAgentCliCatalog('loading', plugins, { 'generic-shell': { command: 'sh' } }).map((option) => option.value),
    ['codex', 'claude-code', 'opencode'],
    'loading fallback drops a configured generic-shell runtime key (hidden id)',
  )
  assert.deepEqual(
    selectAgentCliCatalog('error', null, { 'generic-shell': { command: 'sh' } }).map((option) => option.value),
    ['codex', 'claude-code', 'opencode'],
    'error fallback drops a configured generic-shell runtime key (hidden id)',
  )
  assert.equal(
    isAgentCliAvailable('generic-shell', selectAgentCliCatalog('error', null, { 'generic-shell': { command: 'sh' } })),
    false,
    'generic-shell is unavailable in the fallback catalog even when configured as a runtime',
  )

  // orderInstalledPlugins: bundled-first, deduped, full entries preserved.
  assert.deepEqual(
    orderInstalledPlugins(plugins).map((entry) => `${entry.id}:${entry.source}`),
    ['codex:bundled', 'claude-code:bundled', 'opencode:user'],
    'installed plugin rows order bundled before user and dedupe by id',
  )
  assert.deepEqual(orderInstalledPlugins(null), [], 'null entries yield no rows')
  assert.equal(
    orderInstalledPlugins(plugins)[0].binary,
    'codex',
    'row entries keep the manifest binary for the blank-override placeholder',
  )

  // cliRuntimeForPlugin: direct plugin-id overrides only.
  assert.deepEqual(
    cliRuntimeForPlugin('codex', { codex: { command: 'codex-next' } }),
    { command: 'codex-next' },
    'direct plugin-id override is used as-is',
  )
  assert.deepEqual(
    cliRuntimeForPlugin('claude-code', {
      'claude-code': { command: '' },
    }),
    { command: '' },
    'an explicit blank command on the plugin-id key means manifest binary',
  )
  assert.deepEqual(
    cliRuntimeForPlugin('opencode', undefined),
    { command: '' },
    'unknown plugin with no override reads as blank command',
  )

  // resolveTemplateAgentCli: plain New chat / template-agent fallback.
  assert.equal(
    resolveTemplateAgentCli('opencode', 'codex', catalog),
    'opencode',
    'an explicit picker selection is honored as-is',
  )
  assert.equal(
    resolveTemplateAgentCli(null, 'aider', catalog),
    'codex',
    'a stale lastSelectedCli (uninstalled) falls back to the first available catalog entry',
  )
  assert.equal(
    resolveTemplateAgentCli(undefined, 'claude-code', catalog),
    'claude-code',
    'a canonical lastSelectedCli is preserved',
  )
  assert.equal(
    resolveTemplateAgentCli(null, 'aider', []),
    'aider',
    'an empty catalog returns lastSelectedCli unchanged instead of throwing',
  )

  // Model catalog merging: manifest seeds first, then user-added ids deduped;
  // plugins without modelSelection never grow model UI from user runtimes.
  const modelPlugins: PluginCatalogEntry[] = [
    cliEntry({
      id: 'claude-code',
      displayName: 'Claude Code',
      source: 'bundled',
      version: 1,
      binary: 'claude',
      modelSelection: {
        options: [
          { id: 'opus', label: 'Opus' },
          { id: 'sonnet', label: 'Sonnet' },
        ],
        allowCustomId: true,
      },
    }),
    // `aider` is an unbundled id with no manifest modelSelection and no bundled
    // fallback catalog — the clean "no model UI anywhere" case. (opencode is no
    // longer usable here: it is now a canonical bundled CLI with its own catalog.)
    cliEntry({ id: 'aider', displayName: 'Aider', source: 'user', version: 1, binary: 'aider' }),
  ]
  const modelCatalog = buildAgentCliCatalog(modelPlugins, {
    'claude-code': { command: '', models: [' opus ', 'haiku', 'haiku'] },
    aider: { command: '', models: ['some/model'] },
  })
  assert.deepEqual(
    modelCatalog.find((option) => option.value === 'claude-code')?.modelSelection,
    {
      options: [
        { id: 'opus', label: 'Opus', origin: 'user' },
        { id: 'sonnet', label: 'Sonnet', origin: 'manifest' },
        { id: 'haiku', origin: 'user' },
      ],
      allowCustomId: true,
    },
    'user-added model ids merge after manifest seeds, trimmed and deduped; a seeded id the user also typed reports the stronger claim',
  )
  assert.equal(
    modelCatalog.find((option) => option.value === 'aider')?.modelSelection,
    undefined,
    'user models without a declared modelSelection never surface model UI',
  )

  // resolveCliModel: per-surface override wins only for its own CLI; otherwise
  // undefined means CLI default, no flag.
  assert.equal(
    resolveCliModel('claude-code', { cli: 'claude-code', model: 'opus' }),
    'opus',
    'a matching per-surface override wins',
  )
  assert.equal(
    resolveCliModel('codex', { cli: 'claude-code', model: 'opus' }),
    undefined,
    'an override for a different CLI is ignored and no fallback model is used',
  )
  assert.equal(resolveCliModel('codex', undefined), undefined, 'no selection means the CLI default')
  assert.equal(resolveCliModel('codex', null), undefined, 'null selections mean the CLI default')

  // resolveCliReasoning: the same cli-match guard, because a level is per-CLI
  // manifest knowledge — codex's `ultra` is not a level claude-code accepts.
  assert.equal(
    resolveCliReasoning('codex', { cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'high' }),
    'high',
    'a level picked for this CLI is honored',
  )
  assert.equal(
    resolveCliReasoning('claude-code', { cli: 'codex', model: 'gpt-5.6-sol', reasoning: 'ultra' }),
    undefined,
    'a level picked for another CLI never reaches this launch',
  )
  assert.equal(
    resolveCliReasoning('codex', { cli: 'codex', model: '', reasoning: 'high' }),
    'high',
    'a level survives choosing the CLI default model (empty model id)',
  )
  assert.equal(
    resolveCliReasoning('codex', { cli: 'codex', model: 'gpt-5.6-sol' }),
    undefined,
    'a selection with no level means the CLI default effort, no flag',
  )
  assert.equal(
    resolveCliReasoning('codex', { cli: 'codex', model: 'gpt-5.6-sol', reasoning: '  ' }),
    undefined,
    'a blank level means the CLI default effort, no flag',
  )
  assert.equal(resolveCliReasoning('codex', undefined), undefined, 'no selection means the CLI default effort')
  assert.equal(resolveCliReasoning('codex', null), undefined, 'null selections mean the CLI default effort')
  // Model and level resolve independently from one selection: switching model
  // within a CLI cannot disturb the level, and vice versa.
  assert.equal(
    resolveCliModel('codex', { cli: 'codex', model: 'gpt-5.5', reasoning: 'high' }),
    'gpt-5.5',
    'a stored level does not disturb model resolution',
  )

  // --- availability filtering (deployment gating) --------------------------
  const availCatalog = buildAgentCliCatalog(plugins) // codex, claude-code, opencode
  // Only codex installed -> claude-code + opencode hidden; codex annotated.
  assert.deepEqual(
    filterCatalogByAvailability(
      availCatalog,
      availabilityMap({ codex: true, 'claude-code': false, opencode: false }),
      'ready',
    ).map((option) => option.value),
    ['codex'],
    'ready availability hides CLIs whose binary is not installed',
  )
  assert.equal(
    filterCatalogByAvailability(
      availCatalog,
      availabilityMap({ codex: true, 'claude-code': false, opencode: false }),
      'ready',
    ).find((option) => option.value === 'codex')?.installed,
    true,
    'surviving options are annotated with installed state',
  )
  // Loading status must not filter (never-empty guard) even if map says nothing installed.
  assert.deepEqual(
    filterCatalogByAvailability(
      availCatalog,
      availabilityMap({ codex: false, 'claude-code': false, opencode: false }),
      'loading',
    ).map((option) => option.value),
    ['codex', 'claude-code', 'opencode'],
    'loading status shows all registered CLIs (never an empty picker)',
  )
  // Zero installed while ready IS the answer on a fresh machine: the
  // catalog empties and the surfaces render their install state, instead of the
  // old escape hatch handing back eight uninstalled CLIs that all read launchable.
  assert.deepEqual(
    filterCatalogByAvailability(
      availCatalog,
      availabilityMap({ codex: false, 'claude-code': false, opencode: false }),
      'ready',
    ).map((option) => option.value),
    [],
    'a ready probe with nothing installed yields an empty catalog, not the unfiltered one',
  )
  // The case the escape hatch was written for still degrades gracefully: CLIs
  // exist, the probe did not finish, and the picker keeps the last known list.
  assert.deepEqual(
    filterCatalogByAvailability(
      availCatalog,
      availabilityMap({ codex: false, 'claude-code': false, opencode: false }),
      'error',
    ).map((option) => option.value),
    ['codex', 'claude-code', 'opencode'],
    'a failed probe keeps the annotated catalog — "we do not know" is not "none installed"',
  )
  assert.deepEqual(
    filterCatalogByAvailability(availCatalog, null, 'ready').map((option) => option.value),
    ['codex', 'claude-code', 'opencode'],
    'an absent availability map is undecided and never empties the picker',
  )
  // An option with no availability entry stays visible (unknown != not-installed).
  assert.deepEqual(
    filterCatalogByAvailability(availCatalog, availabilityMap({ codex: true }), 'ready').map((option) => option.value),
    ['codex', 'claude-code', 'opencode'],
    'options without a probe entry are not hidden',
  )
  // selectAgentCliCatalog applies the filter when availability is passed.
  assert.deepEqual(
    selectAgentCliCatalog('ready', plugins, undefined, {
      map: availabilityMap({ codex: true, 'claude-code': false, opencode: false }),
      status: 'ready',
    }).map((option) => option.value),
    ['codex'],
    'selectAgentCliCatalog hides uninstalled CLIs when availability is provided',
  )
  // resolveAvailableAgentCli over the filtered catalog auto-remaps a stale default.
  const codexOnly = selectAgentCliCatalog('ready', plugins, undefined, {
    map: availabilityMap({ codex: true, 'claude-code': false, opencode: false }),
    status: 'ready',
  })
  assert.equal(
    resolveAvailableAgentCli('claude-code', codexOnly),
    'codex',
    'a stale claude-code default remaps to the only installed CLI (codex)',
  )
  assert.equal(
    resolveTemplateAgentCli(null, 'claude-code', codexOnly),
    'codex',
    'a remembered claude-code lastSelectedCli remaps to codex on a codex-only machine',
  )
  // One CLI installed and the rest not: the existing filtering is unchanged.
  assert.deepEqual(
    codexOnly.map((option) => option.value),
    ['codex'],
    'only the installed CLI survives filtering',
  )

  // --- the zero-CLI machine ---------------------------------------
  const nothingInstalled = selectAgentCliCatalog('ready', plugins, undefined, {
    map: availabilityMap({ codex: false, 'claude-code': false, opencode: false }),
    status: 'ready',
  })
  assert.deepEqual(nothingInstalled, [], 'a machine with no agent CLI offers no agent CLI')
  // The stored-agent guard AgentPanel calls (isStoredAgentCliUnavailable) is
  // isAgentCliMissing over exactly this catalog: with nothing installed, a stored
  // CLI reads unavailable, so the agent pane stops spawning against a missing
  // binary instead of reading it as present through catalog membership.
  assert.equal(
    isAgentCliMissing('codex', nothingInstalled),
    true,
    'a stored codex agent reads unavailable when nothing at all is installed',
  )
  assert.equal(
    isAgentCliAvailable('codex', nothingInstalled),
    false,
    'membership can no longer report an uninstalled CLI as available',
  )
  // resolveLaunchableAgentCli expresses "none" where resolveAvailableAgentCli
  // must still answer with something for a picker to render.
  assert.equal(
    resolveLaunchableAgentCli('codex', nothingInstalled),
    null,
    'no installed CLI means no CLI to launch — never a guessed fallback',
  )
  assert.equal(
    resolveAvailableAgentCli('codex', nothingInstalled),
    'claude-code',
    'the display resolver still answers with its fallback — a guess, which is why launches ask the other one',
  )
  assert.equal(
    resolveLaunchableAgentCli('claude-code', codexOnly),
    'codex',
    'a stale remembered CLI remaps to the installed one',
  )
  assert.equal(
    resolveLaunchableAgentCli(null, codexOnly),
    'codex',
    'no remembered CLI resolves to the first installed entry',
  )
  // What the install route names: the registry's own CLIs, never a hardcoded list.
  assert.equal(
    installableCliSummary(buildAgentCliCatalog(plugins).map((option) => option.label)),
    'Codex, Claude Code, OpenCode.',
    'three installable CLIs are named in full',
  )
  assert.equal(
    installableCliSummary(['Codex', 'Claude Code', 'OpenCode', 'Grok', 'Cursor']),
    'Codex, Claude Code, OpenCode, and 2 more.',
    'beyond three, the rest are counted',
  )
  assert.equal(installableCliSummary([]), '', 'nothing to install names nothing')

  console.log('cliRuntimeOptions.test.ts: ok')
})

// --- the model merge: the CLI's list is the list (owner ruling 2026-09-22) ---
// Once a probe has answered for a CLI, its picker shows exactly the rows the
// CLI reported, in the CLI's order, then the person's own ids. The manifest
// seed stands in only until then. Each case below is one half of that rule.

const mergeCliEntry = (
  entry: Omit<PluginCatalogEntry, 'resumeSession' | 'sessionIdFromCaller' | 'agentStateCapable'>,
): PluginCatalogEntry => ({ resumeSession: false, sessionIdFromCaller: false, agentStateCapable: true, ...entry })

const mergePlugins: PluginCatalogEntry[] = [
  mergeCliEntry({
    id: 'claude-code',
    displayName: 'Claude Code',
    source: 'bundled',
    version: 1,
    binary: 'claude',
    modelSelection: {
      options: [
        { id: 'opus[1m]', label: 'Opus (1M context)' },
        { id: 'claude-opus-5', label: 'Opus 5' },
      ],
      allowCustomId: true,
    },
  }),
]
const userClaudeModels = { 'claude-code': { command: '', models: ['claude-opus-5-5'] } }
const MERGE_NOW = Date.parse('2026-09-22T12:00:00Z')
const daysBefore = (days: number): string => new Date(MERGE_NOW - days * 24 * 60 * 60 * 1000).toISOString()

type MergedRow = { id: string; label?: string; origin: string; isNew?: true }
const claudeRows = (
  discovered: Parameters<typeof buildAgentCliCatalog>[2],
  cliRuntimes: Parameters<typeof buildAgentCliCatalog>[1] = userClaudeModels,
): MergedRow[] =>
  buildAgentCliCatalog(mergePlugins, cliRuntimes, discovered, MERGE_NOW).find(
    (option) => option.value === 'claude-code',
  )?.modelSelection?.options ?? []
const probe = (models: DiscoveredCliModel[]) => ({
  'claude-code': { models, fetchedAt: '2026-09-22T10:00:00Z', source: 'agent-sdk' as const, cliVersion: '2.1.280' },
})

test('with no probe answer the picker shows the manifest seed, then the user ids', () => {
  const seedRows: MergedRow[] = [
    { id: 'opus[1m]', label: 'Opus (1M context)', origin: 'manifest' },
    { id: 'claude-opus-5', label: 'Opus 5', origin: 'manifest' },
    { id: 'claude-opus-5-5', origin: 'user' },
  ]
  assert.deepEqual(claudeRows(undefined), seedRows)
  assert.deepEqual(claudeRows({}), seedRows, 'an empty catalog map is no answer')
  assert.deepEqual(claudeRows(probe([])), seedRows, 'a CLI that listed nothing falls back to the seed, not to nothing')
  assert.deepEqual(
    claudeRows({ 'claude-code': { models: undefined, fetchedAt: '', source: 'agent-sdk' } } as never),
    seedRows,
    'a malformed catalog that slipped past the normalizer reads as no answer and never throws',
  )
})

test('discovered rows replace the manifest seed, in the CLI order and with its labels', () => {
  assert.deepEqual(
    claudeRows(
      probe([
        { id: 'default', displayName: 'Default (recommended)' },
        { id: 'opus[1m]', displayName: 'Opus with 1M context', resolvedModel: 'claude-opus-4-8[1m]' },
        { id: 'claude-opus-4-8[1m]' },
        { id: 'sonnet', displayName: 'Sonnet' },
      ]),
    ),
    [
      { id: 'default', label: 'Default (recommended)', origin: 'discovered' },
      { id: 'opus[1m]', label: 'Opus with 1M context', origin: 'discovered' },
      { id: 'claude-opus-4-8[1m]', origin: 'discovered' },
      { id: 'sonnet', label: 'Sonnet', origin: 'discovered' },
      { id: 'claude-opus-5-5', origin: 'user' },
    ],
    'no manifest row survives (not even claude-opus-5, which the CLI did not list); aliases stay ordinary rows and never collapse onto the id resolvedModel names',
  )
})

test('an id the CLI stops listing disappears on the next refresh', () => {
  const before = claudeRows(probe([{ id: 'opus[1m]' }, { id: 'sonnet' }]))
  const after = claudeRows(probe([{ id: 'opus[1m]' }]))
  assert.deepEqual(
    before.map((row) => row.id),
    ['opus[1m]', 'sonnet', 'claude-opus-5-5'],
  )
  assert.deepEqual(
    after.map((row) => row.id),
    ['opus[1m]', 'claude-opus-5-5'],
  )
})

test('a user id survives every refresh and follows the CLI rows once', () => {
  const rows = claudeRows(probe([{ id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { id: 'sonnet' }]), {
    'claude-code': { command: '', models: ['claude-opus-5-5', ' my-model ', 'my-model'] },
  })
  assert.deepEqual(rows, [
    { id: 'claude-opus-5-5', label: 'Opus 5.5', origin: 'user' },
    { id: 'sonnet', origin: 'discovered' },
    { id: 'my-model', origin: 'user' },
  ])
})

test('rows from the first-ever probe are not new', () => {
  const rows = claudeRows(probe([{ id: 'opus[1m]' }, { id: 'sonnet' }]))
  assert.equal(
    rows.some((row) => row.isNew),
    false,
    'the first probe writes no firstSeenAt, so a fresh install lights up nothing',
  )
})

test('a row is new for NEW_FOR_DAYS after a probe on this machine first listed it', () => {
  const rows = claudeRows(
    probe([
      { id: 'fresh', firstSeenAt: daysBefore(3) },
      { id: 'old', firstSeenAt: daysBefore(40) },
      { id: 'clock-moved-back', firstSeenAt: daysBefore(-1) },
      { id: 'garbled', firstSeenAt: 'not a date' },
    ]),
  )
  assert.deepEqual(
    rows.filter((row) => row.origin === 'discovered').map((row) => [row.id, row.isNew === true]),
    [
      ['fresh', true],
      ['old', false],
      ['clock-moved-back', true],
      ['garbled', false],
    ],
  )
  assert.equal(rows.find((row) => row.origin === 'user')?.isNew, undefined, 'a user id is never marked new')
})

test('the merge clock defaults to now and is threaded through the picker entry point', () => {
  const discovered = probe([{ id: 'fresh', firstSeenAt: new Date().toISOString() }])
  const rows = selectAgentCliCatalog('ready', mergePlugins, userClaudeModels, undefined, discovered).find(
    (option) => option.value === 'claude-code',
  )?.modelSelection?.options
  assert.equal(rows?.[0]?.isNew, true)
  const later = selectAgentCliCatalog(
    'ready',
    mergePlugins,
    userClaudeModels,
    undefined,
    discovered,
    Date.now() + 31 * 24 * 60 * 60 * 1000,
  ).find((option) => option.value === 'claude-code')?.modelSelection?.options
  assert.equal(later?.[0]?.isNew, undefined)
})

test('a CLI with no declared modelSelection surfaces no model UI even when discovery reported models', () => {
  assert.deepEqual(
    buildAgentCliCatalog(
      [mergeCliEntry({ id: 'aider', displayName: 'Aider', source: 'user', version: 1, binary: 'aider' })],
      undefined,
      { aider: { models: [{ id: 'some/model' }], fetchedAt: '2026-09-22T10:00:00Z', source: 'argv-probe' } },
    ).find((option) => option.value === 'aider')?.modelSelection,
    undefined,
  )
})

// Every surface that renders a model picker must hand the merge what the CLIs
// reported, or it offers the manifest seed while the others offer the CLI's own
// list: the New chat composer (and the hosts that borrow its catalog) once did
// exactly that. Read from source because the defect is a missing argument,
// invisible to the merge's own tests.
test('every model-picker surface passes the discovered catalog to the merge', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const surfaces = [
    'src/renderer/src/components/workspace/agentComposer/useAgentComposer.ts',
    'src/renderer/src/components/workspace/WorkspaceManager.tsx',
    'src/renderer/src/components/settings/TextGenerationSettingsSection.tsx',
    'src/renderer/src/modules/index.ts',
  ]
  for (const file of surfaces) {
    const source = readFileSync(join(process.cwd(), file), 'utf8')
    const start = source.indexOf('selectAgentCliCatalog(')
    assert.notEqual(start, -1, `${file} builds its catalog through selectAgentCliCatalog`)
    let depth = 0
    let end = start
    for (let i = start + 'selectAgentCliCatalog'.length; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1
      if (source[i] === ')') depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
    assert.match(source.slice(start, end), /cliModelCatalog/, `${file} passes cliModelCatalog to the merge`)
  }
})

test("a chat in a WSL workspace runs that machine's CLI, whichever chat CLI it is", () => {
  const cliRuntimes = {
    'claude-code': { command: 'C:\\tools\\claude.exe', models: ['opus'] },
    codex: { command: 'codex' },
    'kimi-code': { command: 'kimi' },
    'acme-cli': { command: 'acme' },
  }
  const hosts = {
    'wsl:Ubuntu': {
      enabled: true,
      cliCommands: { 'claude-code': '/opt/claude/bin/claude', cursor: '/home/dev/.local/bin/cursor-agent' },
    },
  }
  assert.equal(conversationCliRuntimesFor(cliRuntimes, 'local', hosts as never), cliRuntimes)
  assert.equal(conversationCliRuntimesFor(cliRuntimes, undefined, hosts as never), cliRuntimes)
  assert.deepEqual(conversationCliRuntimesFor(cliRuntimes, 'wsl:Ubuntu', hosts as never), {
    'claude-code': { command: '/opt/claude/bin/claude', models: ['opus'], hostId: 'wsl:Ubuntu' },
    // This PC's command does not go with it: the distribution's PATH finds `codex`.
    codex: { command: '', hostId: 'wsl:Ubuntu' },
    cursor: { command: '/home/dev/.local/bin/cursor-agent', hostId: 'wsl:Ubuntu' },
    opencode: { command: '', hostId: 'wsl:Ubuntu' },
    grok: { command: '', hostId: 'wsl:Ubuntu' },
    'kimi-code': { command: '', hostId: 'wsl:Ubuntu' },
    // A CLI with no chat runtime is a terminal's business, and left alone.
    'acme-cli': { command: 'acme' },
  })
  // No override on that machine: its own PATH finds `claude`.
  assert.deepEqual(conversationCliRuntimesFor(cliRuntimes, 'wsl:Debian', hosts as never)?.['claude-code'], {
    command: '',
    models: ['opus'],
    hostId: 'wsl:Debian',
  })
})
