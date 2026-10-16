import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  composerRosterRows,
  engineNames,
  resolveInitialSelection,
  type AgentComposerSelection,
  type ComposerRow,
} from './useAgentComposer'
import { test } from 'vitest'

test('agentComposerSelection', async () => {
  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // resolveInitialSelection is the pure seam behind every composer surface's
  // preselected row: given the live roster and the remembered agent, it returns
  // the remembered selection when its row exists, else falls back to the agent
  // row. Exercising it directly (no store, no DOM) covers the
  // restore-from-lastSelected contract and the cold-install fallback the pickers
  // rely on.
  const fullRoster: ComposerRow[] = [
    { key: 'terminal', kind: 'terminal' },
    { key: 'general', kind: 'general' },
    { key: 'conversation', kind: 'conversation' },
  ]

  run('restores the remembered row when it is present', () => {
    assert.deepEqual(
      resolveInitialSelection(fullRoster, { kind: 'conversation' }),
      { kind: 'conversation' },
      'the remembered Conversation row is preselected',
    )
    assert.deepEqual(
      resolveInitialSelection(fullRoster, { kind: 'terminal' }),
      { kind: 'terminal' },
      'and so is a remembered Terminal',
    )
  })

  run('falls back to the agent row when the remembered one is absent', () => {
    const noConversation: ComposerRow[] = [
      { key: 'terminal', kind: 'terminal' },
      { key: 'general', kind: 'general' },
    ]
    assert.deepEqual(
      resolveInitialSelection(noConversation, { kind: 'conversation' }),
      { kind: 'general' },
      'a remembered row that no longer exists falls back to the agent row, never an unselectable phantom',
    )
  })

  run('falls back to the first row when the agent row is missing too', () => {
    const cliLessRoster: ComposerRow[] = [{ key: 'terminal', kind: 'terminal' }]
    assert.deepEqual(
      resolveInitialSelection(cliLessRoster, { kind: 'conversation' }),
      { kind: 'terminal' },
      'with no agent row the fallback is the first row that is actually there',
    )
  })

  run('returns the preferred selection unchanged for an empty roster', () => {
    const preferred: AgentComposerSelection = { kind: 'general' }
    assert.deepEqual(
      resolveInitialSelection([], preferred),
      preferred,
      'an empty roster never yields an out-of-range fallback',
    )
  })

  // Source-contract: the pure helper above is only meaningful if the hook actually
  // seeds its selection through it (lazily, so reopening returns to the last pick
  // with no first-row flash). Mirrors the source-regex style of the debug-toggle
  // test.
  const hookSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/workspace/agentComposer/useAgentComposer.ts'),
    'utf8',
  )

  run('the composer hook seeds its selection via resolveInitialSelection in a lazy initializer', () => {
    assert.match(
      hookSource,
      /useState<AgentComposerSelection>\(\(\) =>\s*\n?\s*resolveInitialSelection\(allRows, initialSelection\)/,
      'selection uses a lazy useState initializer running resolveInitialSelection, not a constant',
    )
  })

  // Source-contract for the other half of the New-chat seed: the
  // The launch panel follows the saved interface choice. Explicit commands
  // may override it for one opening without changing the saved preference.
  const managerSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/workspace/WorkspaceManager.tsx'),
    'utf8',
  )

  run('New chat opens on the remembered interface choice', () => {
    assert.match(
      managerSource,
      /initialSelection=\{newChatPanelState\.forcedSelection \?\? lastNewChatAgent\}/,
      'a forced command wins for one opening, then the saved choice applies',
    )
    assert.match(
      managerSource,
      /initialSelection=\{lastNewChatAgent\}/,
      'the in-workspace launcher also reads the saved choice',
    )
  })

  // ---------------------------------------------------------------------------
  // A machine with no agent CLI: the roster stops offering rows that
  // launch one. The old catalog escape hatch made every picker offer all eight
  // uninstalled CLIs, each of which spawned a bare shell.
  // ---------------------------------------------------------------------------

  run('with no CLI installed the roster keeps only what needs no CLI', () => {
    const rows = composerRosterRows({
      showTerminal: true,
      conversationAvailable: true,
      noAgentCliInstalled: true,
    })
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['terminal', 'conversation'],
      'Terminal (a plain shell) and Conversation (provider-backed) stay; the agent row goes',
    )
    assert.equal(
      rows.some((row) => row.kind === 'general'),
      false,
      'no row that launches a CLI is reachable by click, Enter, or search',
    )
  })

  run('a select-mode picker with no CLI installed offers no agent at all', () => {
    assert.deepEqual(
      composerRosterRows({
        showTerminal: false,
        conversationAvailable: false,
        noAgentCliInstalled: true,
      }),
      [],
      'the picker empties rather than persisting an agent that cannot run',
    )
  })

  run('an installed CLI leaves the roster exactly as it was', () => {
    assert.deepEqual(
      composerRosterRows({
        showTerminal: true,
        conversationAvailable: true,
        noAgentCliInstalled: false,
      }).map((row) => row.key),
      ['terminal', 'general', 'conversation'],
      'the normal roster, in order',
    )
  })

  // ---------------------------------------------------------------------------
  // The agent row is named by its bound engine: the model it launches —
  // or the CLI, when no model is picked — is the only honest name for it. It used
  // to read the constant "General agent", which never changed when the owner
  // picked Fable 5 on it.
  // ---------------------------------------------------------------------------

  const CATALOG = [
    {
      value: 'claude-code' as const,
      label: 'Claude Code',
      modelSelection: {
        options: [
          { id: 'claude-fable-5', label: 'Fable 5' },
          { id: 'claude-opus-5[1m]', label: 'Opus (latest, 1M context)' },
        ],
        allowCustomId: true,
      },
    },
    { value: 'codex' as const, label: 'Codex' },
  ] as unknown as Parameters<typeof engineNames>[0]

  run('a picked model names the agent', () => {
    assert.deepEqual(
      engineNames(CATALOG, 'claude-code', 'claude-fable-5'),
      { cliLabel: 'Claude Code', modelLabel: 'Fable 5' },
      'the row reads back the model that was picked on it',
    )
    assert.equal(
      engineNames(CATALOG, 'claude-code', 'claude-opus-5[1m]').modelLabel,
      'Opus (latest, 1M context)',
      'including a model whose label carries its context window',
    )
  })

  run('no model means the CLI names the agent', () => {
    assert.deepEqual(
      engineNames(CATALOG, 'codex', undefined),
      { cliLabel: 'Codex', modelLabel: null },
      'a CLI running its own default model is named by the CLI',
    )
  })

  run('an unlabelled model keeps its id, and an unknown CLI keeps its own', () => {
    assert.equal(
      engineNames(CATALOG, 'claude-code', 'claude-haiku-4-5-20251001').modelLabel,
      'claude-haiku-4-5-20251001',
      'a user-added model id is shown as itself, never renamed to a catalog neighbour',
    )
    assert.deepEqual(
      engineNames([], 'claude-code', undefined),
      { cliLabel: 'claude-code', modelLabel: null },
      'an empty catalog (registry still loading) falls back to the id, not to a blank row',
    )
  })

  // Source-contract for the wiring the pure roster cannot reach: the hook only
  // calls a machine CLI-less once the plugin registry is READY (a pending or
  // failed probe leaves the annotated catalog in place, which is what keeps a
  // transient failure from emptying the picker).
  run('the zero-CLI state is derived from a ready catalog', () => {
    assert.match(
      hookSource,
      /noAgentCliInstalled\s*=\s*pluginCatalogStatus === 'ready' && agentCliOptions\.length === 0/,
      'the flag is "ready and nothing installed", never "the list looks empty"',
    )
  })

  if (failures > 0) {
    console.error(`agentComposerSelection.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('agentComposerSelection.test.tsx: ok')
})
