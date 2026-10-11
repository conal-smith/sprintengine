import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  subagentEffort,
  subagentModel,
  subagentOutcomeWord,
  subagentResultPreview,
  subagentRunsOn,
} from './subagentResult'
import { AgentCardContent } from './subagentStatus'
import { SubagentLane } from './timelineRows'
import { setConversationDisclosures } from './conversationViewState'
import type { TranscriptToolEntry } from './conversationProjection'

const lane = (extra: Partial<TranscriptToolEntry> = {}): TranscriptToolEntry => ({
  kind: 'tool',
  id: 'lane-1',
  turnId: 't1',
  name: 'Task',
  toolKind: 'subagent',
  subagentLane: true,
  subagentType: 'Explore',
  summary: 'Task: Find the cache',
  input: { description: 'Find the cache', prompt: 'Look for it' },
  status: 'done',
  startedAt: 1_000,
  completedAt: 43_000,
  output: '## Findings\n\nThe cache lives in `src/cache.ts`.\n\n- It is keyed by path.',
  outputStatus: 'ok',
  ...extra,
})

test('the preview is the report’s first line of prose', () => {
  expect(subagentResultPreview('\n\n## Findings\nmore')).toBe('Findings')
  expect(subagentResultPreview('- **Found it**')).toBe('Found it')
  expect(subagentResultPreview('**Summary**')).toBe('Summary')
  expect(subagentResultPreview('   ')).toBe('')
  expect(subagentResultPreview(undefined)).toBe('')
})

test('only an unplain ending gets a word, and only a named model is shown', () => {
  expect(subagentOutcomeWord(lane())).toBeUndefined()
  expect(subagentOutcomeWord(lane({ outputStatus: 'error' }))).toBe('failed')
  expect(subagentOutcomeWord(lane({ outputStatus: 'stopped' }))).toBe('stopped')
  expect(subagentOutcomeWord(lane({ status: 'running', outputStatus: 'error' }))).toBeUndefined()
  expect(subagentModel(lane())).toBeUndefined()
  expect(subagentModel(lane({ input: { description: 'x', model: 'haiku' } }))).toBe('haiku')
})

test('a settled lane shows its report’s first line and opens onto the whole report', () => {
  const closed = renderToStaticMarkup(<SubagentLane tool={lane()} />)
  expect(closed).toContain('Explore agent')
  expect(closed).toContain('>Findings<')
  expect(closed).toContain('aria-label="Report: Findings"')
  expect(closed).not.toContain('keyed by path')
  expect(closed).toContain('42s')
  setConversationDisclosures(':', ['lane-report:lane-1'], true)
  try {
    const open = renderToStaticMarkup(<SubagentLane tool={lane()} />)
    expect(open).toContain('keyed by path')
    expect(open).toContain('aria-label="Copy output"')
  } finally {
    setConversationDisclosures(':', ['lane-report:lane-1'], false)
  }
})

test('a failed lane says so in the error ink, with the error as its preview', () => {
  const html = renderToStaticMarkup(
    <SubagentLane
      tool={lane({
        output: 'Agent hit its turn limit.',
        outputStatus: 'error',
        input: { description: 'Find the cache', model: 'haiku' },
      })}
    />,
  )
  expect(html).toMatch(/<span class="text-\[color:var\(--tone-error\)\]">Failed after 42s<\/span> · haiku/)
  expect(html).toContain('agent-glyph--failed')
  expect(html).toContain('aria-label="Error: Agent hit its turn limit."')
})

test('a running lane has no report yet', () => {
  const html = renderToStaticMarkup(<SubagentLane tool={lane({ status: 'running', output: undefined })} />)
  expect(html).not.toContain('Report:')
  expect(html).toContain('Working · ')
  expect(html).toContain('agent-glyph--working')
})

test('only an effort the call set is shown, in the effort picker’s words', () => {
  expect(subagentEffort(lane())).toBeUndefined()
  expect(subagentEffort(lane({ input: { description: 'x', effort: '  ' } }))).toBeUndefined()
  expect(subagentEffort(lane({ input: { description: 'x', effort: 'high' } }))).toBe('High')
  expect(subagentEffort(lane({ input: { description: 'x', effort: 'xhigh' } }))).toBe('Extra high')
  expect(subagentEffort(lane({ input: { description: 'x', effort: 'max' } }))).toBe('Max')
  // A level the picker does not name is said as the call said it.
  expect(subagentEffort(lane({ input: { description: 'x', effort: 'turbo' } }))).toBe('turbo')
})

test('what an agent ran on reads model · effort, either alone, or nothing', () => {
  expect(subagentRunsOn(lane())).toBeUndefined()
  expect(subagentRunsOn(lane({ input: { description: 'x', model: 'haiku' } }))).toBe('haiku')
  expect(subagentRunsOn(lane({ input: { description: 'x', effort: 'low' } }))).toBe('Low effort')
  expect(subagentRunsOn(lane({ input: { description: 'x', model: 'opus', effort: 'xhigh' } }))).toBe(
    'opus · Extra high effort',
  )
})

test('a settled lane’s footer says the model and the effort it ran at', () => {
  const html = renderToStaticMarkup(
    <SubagentLane tool={lane({ input: { description: 'Find the cache', model: 'opus', effort: 'xhigh' } })} />,
  )
  expect(html).toMatch(/Done in 42s<\/span> · opus · Extra high effort<\/span>/)
  const effortOnly = renderToStaticMarkup(
    <SubagentLane tool={lane({ input: { description: 'Find the cache', effort: 'low' } })} />,
  )
  expect(effortOnly).toMatch(/Done in 42s<\/span> · Low effort<\/span>/)
})

test('the agent’s hover card says the model and effort, even while it works', () => {
  const card = renderToStaticMarkup(
    <AgentCardContent
      tool={lane({
        status: 'running',
        input: { description: 'Find the cache', model: 'opus', effort: 'high' },
        agent: { state: 'running', usage: { totalTokens: 18_400, toolUses: 6, durationMs: 9_000 } },
      })}
      running
    />,
  )
  expect(card).toContain('opus · High effort · 6 steps · 18.4k tokens')
  const plain = renderToStaticMarkup(<AgentCardContent tool={lane()} running={false} />)
  expect(plain).not.toContain('effort')
})
