// The breakdown's picture, worked out apart from its drawing: the bar's
// segments as shares of the window, each row's colour fixed by what it is
// rather than where it falls, the rows not in the window kept out of the bar,
// and the one loaded item that weighs most.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationContextBreakdown } from '../../../../../shared/conversation-runtime'
import {
  contextSegments,
  contextShareLabel,
  deferredRows,
  heaviestLoaded,
  memoryFileLabel,
} from './contextBreakdownShape'

function breakdown(overrides: Partial<ConversationContextBreakdown> = {}): ConversationContextBreakdown {
  return {
    model: 'claude-sonnet-4-5',
    usedTokens: 60_000,
    windowTokens: 200_000,
    categories: [
      { name: 'System prompt', tokens: 4_000, kind: 'used' },
      { name: 'System tools', tokens: 12_000, kind: 'used' },
      { name: 'MCP tools', tokens: 14_000, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' },
      { name: 'Messages', tokens: 30_000, kind: 'used' },
      { name: 'Free space', tokens: 107_000, kind: 'free' },
      { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    ],
    mcpServers: [
      { name: 'sprintengine-studio', tokens: 12_000, tools: [] },
      { name: 'linear', tokens: 2_000, tools: [] },
    ],
    skills: [{ name: 'deploy', tokens: 1_200 }],
    memoryFiles: [{ name: '/Users/dev/acme/CLAUDE.md', tokens: 1_900, detail: 'Project' }],
    agents: [],
    autoCompactAt: 167_000,
    estimated: true,
    measuredAt: 0,
    ...overrides,
  }
}

test('segments are shares of the window, deferred rows left out of the bar', () => {
  const segments = contextSegments(breakdown())
  assert.deepEqual(
    segments.map((segment) => [segment.name, segment.share]),
    [
      ['System prompt', 0.02],
      ['System tools', 0.06],
      ['MCP tools', 0.07],
      ['Messages', 0.15],
      ['Free space', 0.535],
      ['Autocompact buffer', 0.165],
    ],
  )
  assert.deepEqual(
    deferredRows(breakdown()).map((row) => row.name),
    ['MCP tools (deferred)'],
  )
})

test('content rows take the chart slots in the order they are drawn; free space and the buffer take none', () => {
  const slots = (b: ConversationContextBreakdown) => contextSegments(b).map((segment) => [segment.name, segment.slot])
  assert.deepEqual(slots(breakdown()), [
    ['System prompt', 1],
    ['System tools', 2],
    ['MCP tools', 3],
    ['Messages', 4],
    ['Free space', null],
    ['Autocompact buffer', null],
  ])
})

test('past the eighth content row the rest fold into the grey', () => {
  const rows = Array.from({ length: 9 }, (_, index) => ({
    name: `Row ${index + 1}`,
    tokens: 10,
    kind: 'used' as const,
  }))
  const segments = contextSegments(breakdown({ categories: rows }))
  assert.deepEqual(
    segments.map((segment) => segment.slot),
    [1, 2, 3, 4, 5, 6, 7, 8, 'other'],
  )
})

test('a window read over its limit is drawn against the rows’ own sum, so the bar never overruns', () => {
  const segments = contextSegments(
    breakdown({
      windowTokens: 100,
      categories: [
        { name: 'Messages', tokens: 150, kind: 'used' },
        { name: 'Free space', tokens: 0, kind: 'free' },
      ],
    }),
  )
  assert.equal(segments[0]!.share, 1)
  assert.equal(
    segments.reduce((sum, segment) => sum + segment.share, 0),
    1,
  )
})

test('the heaviest is the heaviest thing a person loaded, never the conversation itself', () => {
  assert.deepEqual(heaviestLoaded(breakdown()), { group: 'mcp', name: 'sprintengine-studio', tokens: 12_000 })
  assert.deepEqual(heaviestLoaded(breakdown({ mcpServers: [], skills: [{ name: 'deploy', tokens: 2_500 }] })), {
    group: 'skill',
    name: 'deploy',
    tokens: 2_500,
  })
  assert.equal(heaviestLoaded(breakdown({ mcpServers: [], skills: [], memoryFiles: [] })), null)
})

test('shares read in whole percent, with a floor that is not zero', () => {
  assert.equal(contextShareLabel(76_000, 200_000), '38%')
  assert.equal(contextShareLabel(300, 200_000), '<1%')
  assert.equal(contextShareLabel(0, 200_000), '0%')
  assert.equal(contextShareLabel(10, 0), '0%')
})

test('a memory file’s path is cut to what tells two apart', () => {
  assert.equal(memoryFileLabel('/Users/dev/acme/CLAUDE.md'), '…/acme/CLAUDE.md')
  assert.equal(memoryFileLabel('C:\\Users\\dev\\.claude\\CLAUDE.md'), '…/.claude/CLAUDE.md')
  assert.equal(memoryFileLabel('CLAUDE.md'), 'CLAUDE.md')
})
