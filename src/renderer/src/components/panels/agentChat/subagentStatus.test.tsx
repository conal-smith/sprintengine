import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { TranscriptToolEntry } from './conversationProjection'
import {
  AgentCardContent,
  AgentLaneSummary,
  LaneMark,
  SubagentTypesProvider,
  laneAgentState,
  laneOutcomeWords,
  laneTask,
} from './subagentStatus'

const lane = (fields: Partial<TranscriptToolEntry> = {}): TranscriptToolEntry => ({
  kind: 'tool',
  id: 'toolu_lane',
  turnId: 'turn-1',
  name: 'Agent',
  status: 'done',
  subagentLane: true,
  startedAt: 1_000,
  completedAt: 90_000,
  ...fields,
})

test('a settled agent says how it ended and how long it took', () => {
  expect(laneOutcomeWords(lane())).toBe('Done in 1m 29s')
  expect(laneOutcomeWords(lane({ outputStatus: 'error' }))).toBe('Failed after 1m 29s')
  expect(laneOutcomeWords(lane({ agent: { state: 'stopped' } }))).toBe('Stopped after 1m 29s')
  expect(laneOutcomeWords(lane({ outputStatus: 'declined' }))).toBe('Declined')
  expect(laneOutcomeWords(lane({ status: 'running' }))).toBeUndefined()
})

test('an agent whose end was never recorded says only that it ran in the background', () => {
  const legacy = lane({ agent: { state: 'unknown', background: true } })
  expect(laneAgentState(legacy)).toBe('unknown')
  expect(laneOutcomeWords(legacy)).toBe('Ran in the background')
})

test('an agent with no span of its own falls back to the time it reported', () => {
  const reported = lane({
    completedAt: undefined,
    agent: { state: 'completed', usage: { totalTokens: 1, toolUses: 1, durationMs: 7_000 } },
  })
  expect(laneOutcomeWords(reported)).toBe('Done in 7s')
})

test('an agent is a character, or with characters off the working mark and then its kind glyph', () => {
  expect(renderToStaticMarkup(<LaneMark tool={lane({ status: 'running' })} characters />)).toContain(
    'agent-glyph--working',
  )
  expect(renderToStaticMarkup(<LaneMark tool={lane({ status: 'running' })} characters={false} />)).toContain(
    'working-mark',
  )
  const settled = renderToStaticMarkup(<LaneMark tool={lane({ outputStatus: 'error' })} characters={false} />)
  expect(settled).not.toContain('agent-glyph')
  expect(settled).toContain('--tone-error')
})

test('an agent’s card says who it is, how it is doing, and what kind of helper it is', () => {
  const working = renderToStaticMarkup(
    <SubagentTypesProvider
      value={{ Explore: 'Fast agent specialized for exploring codebases. Use it when you need to find files.' }}
    >
      <AgentCardContent
        tool={lane({
          status: 'running',
          subagentType: 'Explore',
          summary: 'Explore: map the router',
          agent: {
            state: 'running',
            background: true,
            progressSummary: 'Reading the route table',
            usage: { totalTokens: 18_400, toolUses: 6, durationMs: 9_000 },
          },
        })}
        running
      />
    </SubagentTypesProvider>,
  )
  expect(working).toContain('Explore agent · Working')
  expect(working).toContain('map the router')
  expect(working).toContain('Fast agent specialized for exploring codebases.')
  // Only the first sentence: the rest is written for the model.
  expect(working).not.toContain('Use it when')
  expect(working).toContain('Now: Reading the route table')
  expect(working).toContain('6 steps · 18.4k tokens')

  const failed = renderToStaticMarkup(
    <AgentCardContent
      tool={lane({
        subagentType: 'Plan',
        outputStatus: 'error',
        agent: { state: 'failed', error: 'Ran out of turns' },
      })}
      running={false}
    />,
  )
  expect(failed).toContain('Plan agent · Failed after 1m 29s')
  // A built-in type is described even when the session has not described it.
  expect(failed).toContain('works out an approach')
  expect(failed).toContain('Ran out of turns')
})

test('an agent at a glance says what it has spent, while it works and once it is done', () => {
  const working = renderToStaticMarkup(
    <AgentLaneSummary
      lane={lane({
        status: 'running',
        agent: {
          state: 'running',
          progressSummary: 'Reading the route table',
          usage: { totalTokens: 18_400, toolUses: 6, durationMs: 9_000 },
        },
      })}
    />,
  )
  expect(working).toContain('Reading the route table')
  expect(working).toContain('18.4k tokens')

  const done = renderToStaticMarkup(
    <AgentLaneSummary
      lane={lane({ agent: { state: 'completed', usage: { totalTokens: 640, toolUses: 2, durationMs: 9_000 } } })}
    />,
  )
  expect(done).toContain('640 tokens')

  // An agent that has reported no usage yet says nothing about tokens.
  expect(renderToStaticMarkup(<AgentLaneSummary lane={lane({ status: 'running' })} />)).not.toContain('tokens')
})

test('an agent at a glance says the model and effort its call set, before what it spent', () => {
  const card = renderToStaticMarkup(
    <AgentLaneSummary
      lane={lane({
        input: { description: 'Find the cache', model: 'opus', effort: 'xhigh' },
        agent: { state: 'completed', usage: { totalTokens: 640, toolUses: 2, durationMs: 9_000 } },
      })}
    />,
  )
  expect(card).toContain('opus · Extra high effort · 640 tokens')

  // Effort alone, with nothing spent reported yet, still gets the line.
  expect(renderToStaticMarkup(<AgentLaneSummary lane={lane({ input: { effort: 'low' } })} />)).toContain('Low effort')

  // A call that left both to the conversation adds nothing.
  expect(
    renderToStaticMarkup(<AgentLaneSummary lane={lane({ input: { description: 'Find the cache' } })} />),
  ).not.toContain('effort')
})

test('an agent’s task is its call’s summary, else the description the call gave it, else its own', () => {
  expect(laneTask(lane({ summary: 'Agent: map the router' }))).toBe('map the router')
  expect(laneTask(lane({ input: { description: 'Read a.txt and b.txt', subagent_type: 'Explore' } }))).toBe(
    'Read a.txt and b.txt',
  )
  expect(laneTask(lane({ agent: { state: 'running', description: 'Count the files' } }))).toBe('Count the files')
  expect(laneTask(lane())).toBe('')
})
