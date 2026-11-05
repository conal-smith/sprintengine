import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'

import type { TranscriptToolEntry } from './conversationProjection'
import { subagentIconCli } from './subagentIcon'
import { isSubagentStart, SubagentStartRow, subagentStartWords } from './subagentStartRow'

const start = (overrides: Partial<TranscriptToolEntry> = {}) =>
  ({
    kind: 'tool',
    id: 'tool-1',
    name: 'mcp__sprintengine-studio__subagent_start',
    status: 'completed',
    input: { cli: 'cursor', cliModel: 'muse-wonder-1.0[context=300k,reasoning_effort=high]', readOnly: true },
    ...overrides,
  }) as TranscriptToolEntry

test('a sub-agent reads as its model’s maker where the id says, else as its CLI', () => {
  expect(subagentIconCli('claude-code', 'sonnet')).toBe('claude-code')
  expect(subagentIconCli('cursor', 'claude-opus-5-5[context=300k,effort=medium,fast=false]')).toBe('claude-code')
  expect(subagentIconCli('cursor', 'gpt-5.6-sol-medium')).toBe('codex')
  expect(subagentIconCli('cursor', 'gpt-5.3-codex')).toBe('codex')
  expect(subagentIconCli('cursor', 'grok-4.7[context=256k,reasoning_effort=high,fast=true]')).toBe('grok')
  expect(subagentIconCli('cursor', 'cursor-grok-4.6-high')).toBe('grok')
  expect(subagentIconCli('cursor', 'muse-wonder-1.0[context=300k,reasoning_effort=high]')).toBe('muse')
  expect(subagentIconCli('opencode', 'kimi-k3')).toBe('kimi-code')
  expect(subagentIconCli('cursor', 'composer-2.5')).toBe('cursor')
  expect(subagentIconCli('cursor', 'default')).toBe('cursor')
  expect(subagentIconCli('codex', null)).toBe('codex')
  expect(subagentIconCli(null, 'something-new')).toBeNull()
})

test('the start of a sub-agent reads as who was started, however the CLI spells the tool', () => {
  expect(isSubagentStart(start())).toBe(true)
  expect(isSubagentStart({ name: 'sprintengine-studio.subagent.start' })).toBe(true)
  expect(isSubagentStart({ name: 'mcp__other__subagent_start' })).toBe(false)
  expect(subagentStartWords(start())).toBe('Started a sub-agent · Cursor · muse-wonder-1.0 · Read-only')
  expect(subagentStartWords(start({ input: {} }))).toBe('Started a sub-agent')
})

test('a finished wait offers the reply, collapsed; a cut answer leaves it to the Agents tab', () => {
  const answered = start({ output: JSON.stringify({ subagentId: 'agent-1', result: 'Verdict: 68/100.' }) })
  const html = renderToStaticMarkup(<SubagentStartRow tool={answered} />)
  expect(html).toContain('Open in Agents')
  expect(html).toContain('Show its reply')
  expect(html).not.toContain('Verdict: 68/100.')
  const cut = start({ output: '{"ok":true,"subagentId":"agent-1","result":"A very long' })
  expect(renderToStaticMarkup(<SubagentStartRow tool={cut} />)).not.toContain('Show its reply')
})
