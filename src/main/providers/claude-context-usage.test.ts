// Claude Code's `/context` reading, as the SDK's `getContextUsage` answers it,
// mapped to the breakdown the composer strip's ring opens: rows classified by
// their kind, MCP tools grouped under their server with only the loaded ones
// counted, every list heaviest first, and an answer that is not a reading at
// all refused rather than drawn as an empty window.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { contextBreakdownFromSdk, mcpToolShortName } from './claude-context-usage'

const AT = { estimated: true, measuredAt: 1_000 }

function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'claude-opus-4-1',
    totalTokens: 61_000,
    maxTokens: 167_000,
    rawMaxTokens: 200_000,
    percentage: 31,
    categories: [
      { name: 'System prompt', tokens: 3_100, color: 'promptBorder', kind: 'used' },
      { name: 'System tools', tokens: 11_800, color: 'inactive', kind: 'used' },
      { name: 'MCP tools', tokens: 14_200, color: 'cyan_FOR_SUBAGENTS_ONLY', kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 9_000, color: 'inactive', isDeferred: true, kind: 'deferred' },
      { name: 'Custom agents', tokens: 0, color: 'permission', kind: 'used' },
      { name: 'Memory files', tokens: 2_400, color: 'claude', kind: 'used' },
      { name: 'Skills', tokens: 1_500, color: 'warning', kind: 'used' },
      { name: 'Messages', tokens: 28_000, color: 'purple', kind: 'used' },
      { name: 'Free space', tokens: 106_000, color: 'promptBorder', kind: 'free' },
      { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', kind: 'buffer' },
    ],
    gridRows: [],
    memoryFiles: [
      { path: '/Users/dev/acme/CLAUDE.md', type: 'Project', tokens: 1_900 },
      { path: '/Users/dev/.claude/CLAUDE.md', type: 'User', tokens: 500 },
    ],
    mcpTools: [
      { name: 'mcp__linear__create_issue', serverName: 'linear', tokens: 1_200, isLoaded: true },
      { name: 'mcp__linear__list_issues', serverName: 'linear', tokens: 900, isLoaded: true },
      { name: 'mcp__sprintengine-studio__browser_open', serverName: 'sprintengine-studio', tokens: 7_000 },
      { name: 'mcp__sprintengine-studio__canvas_edit', serverName: 'sprintengine-studio', tokens: 5_100 },
      {
        name: 'mcp__sprintengine-studio__tour_create',
        serverName: 'sprintengine-studio',
        tokens: 9_000,
        isLoaded: false,
      },
    ],
    agents: [],
    skills: {
      totalSkills: 3,
      includedSkills: 3,
      tokens: 1_500,
      skillFrontmatter: [
        { name: 'review', source: 'projectSettings', tokens: 300 },
        { name: 'deploy', source: 'plugin', tokens: 1_200 },
      ],
    },
    isAutoCompactEnabled: true,
    autoCompactThreshold: 167_000,
    apiUsage: null,
    ...overrides,
  }
}

test('the totals are the reading’s own, against the window it measures', () => {
  const breakdown = contextBreakdownFromSdk(answer(), AT)!
  assert.equal(breakdown.usedTokens, 61_000)
  assert.equal(breakdown.windowTokens, 200_000, 'the raw window, which the free and buffer rows add up to')
  assert.equal(breakdown.autoCompactAt, 167_000)
  assert.equal(breakdown.model, 'claude-opus-4-1')
  assert.equal(breakdown.estimated, true)
  assert.equal(breakdown.measuredAt, 1_000)
})

test('rows keep the CLI’s order and kind, and a zero row is dropped', () => {
  const breakdown = contextBreakdownFromSdk(answer(), AT)!
  assert.deepEqual(
    breakdown.categories.map((row) => [row.name, row.kind]),
    [
      ['System prompt', 'used'],
      ['System tools', 'used'],
      ['MCP tools', 'used'],
      ['MCP tools (deferred)', 'deferred'],
      ['Memory files', 'used'],
      ['Skills', 'used'],
      ['Messages', 'used'],
      ['Free space', 'free'],
      ['Autocompact buffer', 'buffer'],
    ],
  )
})

test('a CLI that gives no kind is read by its flags, then its names', () => {
  const breakdown = contextBreakdownFromSdk(
    answer({
      categories: [
        { name: 'Messages', tokens: 10 },
        { name: 'MCP tools (deferred)', tokens: 5, isDeferred: true },
        { name: 'Free space', tokens: 0 },
        { name: 'Autocompact buffer', tokens: 7 },
      ],
    }),
    AT,
  )!
  assert.deepEqual(
    breakdown.categories.map((row) => [row.name, row.kind]),
    [
      ['Messages', 'used'],
      ['MCP tools (deferred)', 'deferred'],
      ['Free space', 'free'],
      ['Autocompact buffer', 'buffer'],
    ],
    'free space is kept at zero: without it the window reads as full',
  )
})

test('MCP tools group under their server, heaviest first, counting only what is loaded', () => {
  const { mcpServers } = contextBreakdownFromSdk(answer(), AT)!
  assert.deepEqual(
    mcpServers.map((server) => [server.name, server.tokens]),
    [
      ['sprintengine-studio', 12_100],
      ['linear', 2_100],
    ],
  )
  assert.deepEqual(mcpServers[0]!.tools, [
    { name: 'tour_create', tokens: 9_000, loaded: false },
    { name: 'browser_open', tokens: 7_000, loaded: true },
    { name: 'canvas_edit', tokens: 5_100, loaded: true },
  ])
})

test('skills, memory files and agents come heaviest first with where they are from', () => {
  const breakdown = contextBreakdownFromSdk(
    answer({ agents: [{ agentType: 'reviewer', source: 'projectSettings', tokens: 400 }] }),
    AT,
  )!
  assert.deepEqual(breakdown.skills, [
    { name: 'deploy', tokens: 1_200, detail: 'plugin' },
    { name: 'review', tokens: 300, detail: 'projectSettings' },
  ])
  assert.deepEqual(breakdown.memoryFiles[0], { name: '/Users/dev/acme/CLAUDE.md', tokens: 1_900, detail: 'Project' })
  assert.deepEqual(breakdown.agents, [{ name: 'reviewer', tokens: 400, detail: 'projectSettings' }])
})

test('auto-compact off says no threshold', () => {
  assert.equal(contextBreakdownFromSdk(answer({ isAutoCompactEnabled: false }), AT)!.autoCompactAt, null)
})

test('an answer without totals is not a reading, and malformed rows are dropped', () => {
  assert.equal(contextBreakdownFromSdk(null, AT), null)
  assert.equal(contextBreakdownFromSdk('nope', AT), null)
  assert.equal(contextBreakdownFromSdk(answer({ totalTokens: undefined }), AT), null)
  assert.equal(contextBreakdownFromSdk(answer({ rawMaxTokens: 0, maxTokens: 0 }), AT), null)
  assert.equal(contextBreakdownFromSdk(answer({ rawMaxTokens: undefined }), AT)!.windowTokens, 167_000)
  const breakdown = contextBreakdownFromSdk(
    answer({
      categories: [{ name: 'Messages', tokens: 'many' }, { tokens: 4 }, 'row', { name: 'Skills', tokens: 4 }],
      mcpTools: [{ name: 'mcp__x__y', tokens: 3 }],
      memoryFiles: 'none',
      skills: null,
    }),
    AT,
  )!
  assert.deepEqual(breakdown.categories, [{ name: 'Skills', tokens: 4, kind: 'used' }])
  assert.deepEqual(breakdown.mcpServers, [])
  assert.deepEqual(breakdown.memoryFiles, [])
  assert.deepEqual(breakdown.skills, [])
})

test('a tool’s wire name loses the server prefix its row already says', () => {
  assert.equal(mcpToolShortName('mcp__linear__create_issue', 'linear'), 'create_issue')
  assert.equal(mcpToolShortName('mcp__claude_ai_Gmail__send', 'claude.ai Gmail'), 'send')
  assert.equal(mcpToolShortName('plain', 'linear'), 'plain')
})
