import { expect, test, vi } from 'vitest'
import { foldConversationMatches, orderPaletteCommands, workspaceSwitchRowId } from './commandPaletteSearch'
import type { PaletteCommand } from './palette/paletteProvider'

// The rows a chat can answer a query with — its switch row, and the transcript
// search's row for what was said in it — and the one row the palette shows.

function switchRow(workspaceId: string, label: string, keywords = 'switch to Chat'): PaletteCommand {
  return {
    id: workspaceSwitchRowId(workspaceId),
    label,
    keywords,
    group: 'agents',
    mark: { kind: 'chat', workspaceId, mode: 'standard' as never },
    run: vi.fn(),
  }
}
function saidRow(workspaceId: string, label: string, snippet: string, count = 1): PaletteCommand {
  return {
    ...switchRow(workspaceId, label, snippet),
    conversationMatch: { snippet, from: 'person', count },
    run: vi.fn(),
  }
}

test('a chat found only by what was said in it is one row, wearing the message', () => {
  const rows = foldConversationMatches([], [saidRow('a', 'Pull requests', 'the wave model', 4)], 'wave')
  expect(rows).toHaveLength(1)
  expect(rows[0].conversationMatch).toMatchObject({ snippet: 'the wave model', count: 4 })
})

test('a message row left from an earlier keystroke is dropped once it no longer holds the query', () => {
  // "w" found every message with a w in it; the scan for "wave" is still out.
  const left = [
    saidRow('a', 'Pull requests', 'You can use subagents for this work.'),
    saidRow('b', 'Forecast', 'wave height'),
  ]
  expect(foldConversationMatches([], left, 'wave').map((row) => row.id)).toEqual([workspaceSwitchRowId('b')])
})

test('a chat whose title matched keeps its switch row and the switch that row runs', () => {
  const title = switchRow('a', 'Wave forecast')
  const rows = foldConversationMatches([title], [saidRow('a', 'Wave forecast', 'more wave talk')], 'wave')
  expect(rows).toEqual([title])
})

test('a chat that matched on a hidden field and in its messages is one row that opens at the message', () => {
  const hidden = switchRow('a', 'Fix open issues', 'switch to Chat #79 Read wave directions')
  const said = saidRow('a', 'Fix open issues', 'did the wave fix land?')
  const rows = foldConversationMatches([hidden], [said], 'wave')
  expect(rows).toHaveLength(1)
  expect(rows[0].id).toBe(hidden.id)
  expect(rows[0].conversationMatch?.snippet).toBe('did the wave fix land?')
  rows[0].run()
  expect(said.run).toHaveBeenCalled()
  expect(hidden.run).not.toHaveBeenCalled()
})

test('other rows pass through, and a title match still ranks above a message match', () => {
  const file: PaletteCommand = { id: 'file', label: 'wave.ts', group: 'files', run: vi.fn() }
  const rows = orderPaletteCommands(
    foldConversationMatches([switchRow('a', 'Wave forecast')], [file, saidRow('b', 'Other', 'a wave')], 'wave'),
    'wave',
  )
  expect(rows.map((row) => row.id)).toEqual([workspaceSwitchRowId('a'), 'file', workspaceSwitchRowId('b')])
})
