import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AssistantTurnBlock,
  describeToolGroup,
  partitionWorkTimeline,
  SubagentLane,
  type TimelineChrome,
  WorkTimeline,
} from './timelineRows'
import { formatStepDuration } from './stepDuration'
import type { TranscriptEntry, TranscriptToolEntry } from './conversationProjection'

const tool = (id: string, name = 'Read'): TranscriptToolEntry => ({
  kind: 'tool',
  id,
  turnId: 'turn',
  name,
  status: 'done',
  input: { path: id },
  summary: id,
})

test('prose splits consecutive tool groups and stays outside their disclosures', () => {
  const tools = [tool('a'), tool('b'), tool('c'), tool('d', 'Bash'), tool('e', 'Bash')]
  expect(partitionWorkTimeline(tools)).toEqual([{ text: [], tools }])
  const intermediateText = [{ beforeToolUseId: 'd', text: 'Now checking the tests.' }]
  expect(partitionWorkTimeline(tools, intermediateText)).toEqual([
    { text: [], tools: tools.slice(0, 3) },
    { text: ['Now checking the tests.'], tools: tools.slice(3) },
  ])
  const html = renderToStaticMarkup(<WorkTimeline tools={tools} live={false} intermediateText={intermediateText} />)
  expect(html).toContain('Read 3 files')
  expect(html).toContain('Ran 2 commands')
  expect(html.indexOf('Now checking the tests.')).toBeGreaterThan(html.indexOf('Read 3 files'))
  expect(html.indexOf('Now checking the tests.')).toBeLessThan(html.indexOf('Ran 2 commands'))
  const singles = renderToStaticMarkup(
    <WorkTimeline tools={[tools[0], tools[3]]} live={false} intermediateText={intermediateText} />,
  )
  expect(singles).not.toContain(' steps')
  expect(singles).toContain('Now checking the tests.')
})

test('a settled group rests folded, names its failures, and does not count flat steps', () => {
  const failed: TranscriptToolEntry = { ...tool('c', 'Bash'), toolKind: 'command', outputStatus: 'error' }
  const html = renderToStaticMarkup(<WorkTimeline tools={[tool('a'), tool('b'), failed]} live={false} />)
  expect(html).toContain('aria-expanded="false"')
  expect(html).not.toContain('data-tool-kind')
  expect(html).toContain('1 failed')
  expect(html).toContain('aria-label="Read 2 files and ran 1 command, 1 failed"')
  expect(html).not.toContain(' steps')
})

test('the step running now stays outside the fold', () => {
  const live: TranscriptToolEntry = { ...tool('c', 'Bash'), status: 'running', input: { command: 'npm test' } }
  const html = renderToStaticMarkup(<WorkTimeline tools={[tool('a'), tool('b'), live]} live />)
  expect(html).toContain('Read 2 files')
  expect(html.match(/data-tool-kind=/g)).toHaveLength(1)
  expect(html).toContain('>running<')
})

test('a step duration rounds once, so it never reads "1m 60s"', () => {
  expect(formatStepDuration(119_700)).toBe('2m 0s')
  expect(formatStepDuration(59_600)).toBe('1m 0s')
  expect(formatStepDuration(83_000)).toBe('1m 23s')
  expect(formatStepDuration(59_400)).toBe('59s')
  expect(formatStepDuration(3_599_400)).toBe('59m 59s')
  expect(formatStepDuration(3_599_600)).toBe('1h 0m 0s')
  expect(formatStepDuration(25_190_000)).toBe('6h 59m 50s')
})

test('a command that exited non-zero counts on the closed group header', () => {
  const exited: TranscriptToolEntry = {
    ...tool('c', 'Bash'),
    toolKind: 'command',
    input: { command: 'npm test' },
    exitCode: 1,
  }
  expect(describeToolGroup([tool('a'), tool('b'), exited])).toEqual({ kind: 'file_read', failed: 1 })
  const html = renderToStaticMarkup(<WorkTimeline tools={[tool('a'), tool('b'), exited]} live={false} />)
  expect(html).toContain('aria-label="Read 2 files and ran 1 command, 1 failed"')
  expect(html).toContain('--tone-error)]">· 1 failed')
  // A lane's own steps count too.
  const lane: TranscriptToolEntry = {
    ...tool('lane', 'Task'),
    toolKind: 'subagent',
    subagentLane: true,
    children: [exited],
  }
  expect(describeToolGroup([lane]).failed).toBe(1)
  expect(describeToolGroup([tool('a'), { ...exited, exitCode: 0 }]).failed).toBe(0)
})

test('a settled lane label sinks to the quiet ink; a running one stays strong', () => {
  const lane = (status: 'done' | 'running'): TranscriptToolEntry => ({
    ...tool('lane', 'Task'),
    toolKind: 'subagent',
    subagentLane: true,
    subagentType: 'Explore',
    input: { description: 'Find the cache' },
    status,
  })
  const settled = renderToStaticMarkup(<SubagentLane tool={lane('done')} />)
  expect(settled).toContain('text-[color:var(--text-subtle)]">Explore agent<')
  expect(settled).not.toContain('font-medium text-[color:var(--text-default)]')
  expect(renderToStaticMarkup(<SubagentLane tool={lane('running')} />)).toContain(
    'font-medium text-[color:var(--text-default)]">Explore agent<',
  )
})

const chrome: TimelineChrome = { assistantName: 'Claude', onRetry: () => {}, retryDisabled: false }
const assistant = (
  values: Partial<Extract<TranscriptEntry, { kind: 'assistant' }>>,
): Extract<TranscriptEntry, { kind: 'assistant' }> => ({
  kind: 'assistant',
  turnId: 'turn',
  text: '',
  reasoning: '',
  status: 'streaming',
  ...values,
})

test('thinking again after prose reads "Thinking", not the first stretch’s duration', () => {
  const second = renderToStaticMarkup(
    <AssistantTurnBlock
      entry={assistant({
        text: 'Here is the plan.',
        reasoning: 'First pass.\n\nNow the edge cases.',
        reasoningDurationMs: 4000,
        reasoningLive: true,
      })}
      tools={[]}
      decisions={[]}
      chrome={chrome}
    />,
  )
  expect(second).toContain('Thinking')
  expect(second).not.toContain('Thought for')
  const closed = renderToStaticMarkup(
    <AssistantTurnBlock
      entry={assistant({ text: 'Here is the plan.', reasoning: 'First pass.', reasoningDurationMs: 4000 })}
      tools={[]}
      decisions={[]}
      chrome={chrome}
    />,
  )
  expect(closed).toContain('Thought for 4s')
})

test('a folded older turn says when steps inside it went wrong', () => {
  const failed: TranscriptToolEntry = { ...tool('c', 'Bash'), toolKind: 'command', exitCode: 1 }
  const html = renderToStaticMarkup(
    <AssistantTurnBlock
      entry={assistant({ status: 'complete', text: 'Done.', startedAt: 0, completedAt: 5000 })}
      tools={[tool('a'), failed]}
      decisions={[]}
      chrome={{ ...chrome, latestTurnId: 'later' }}
    />,
  )
  expect(html).toContain('aria-label="Worked for 5s · 2 steps, 1 failed"')
  expect(html).toContain('--tone-error)]">· 1 failed')
})
