import { test, expect } from 'vitest'
import {
  deriveTurnFold,
  latestReplyTurnId,
  proseShownToUser,
  stepShownToUser,
  turnAgentLanes,
  turnFoldedProse,
  turnFoldedSteps,
  turnFoldFailures,
  turnShownWork,
} from '../src/turnFolds.js'
import type { TranscriptEntry, TranscriptToolEntry } from '../src/conversationProjection.js'
const tools: TranscriptToolEntry[] = ['one', 'two'].map((id) => ({
  kind: 'tool',
  id,
  turnId: 'turn',
  name: 'Read',
  status: 'done',
}))
const entry: Extract<TranscriptEntry, { kind: 'assistant' }> = {
  kind: 'assistant',
  turnId: 'turn',
  text: 'Answer',
  reasoning: '',
  status: 'complete',
  startedAt: 1000,
  completedAt: 81000,
}
test('every turn with steps folds, the one still running included', () => {
  expect(deriveTurnFold(entry, tools)).toMatchObject({ label: 'Worked for 1m 20s · 2 steps' })
  expect(deriveTurnFold(entry, tools.slice(0, 1))?.label).toBe('Worked for 1m 20s · 1 step')
  const running: TranscriptToolEntry[] = [tools[0], { ...tools[1], status: 'running' }]
  expect(deriveTurnFold({ ...entry, status: 'streaming' }, running)?.label).toBe('Working · 2 steps')
  // Thinking alone is its own disclosure already.
  expect(deriveTurnFold({ ...entry, reasoning: 'Thinking' }, [])).toBeNull()
  expect(deriveTurnFold(entry, [])).toBeNull()
})

test('failed and interrupted folds keep their outcome', () => {
  expect(deriveTurnFold({ ...entry, status: 'failed' }, tools)?.label).toContain('Failed after')
  expect(deriveTurnFold({ ...entry, status: 'interrupted' }, tools)?.label).toContain('You stopped after')
})

test('the agents a turn spawned stay outside its fold', () => {
  const lane: TranscriptToolEntry = { ...tools[0], id: 'lane', status: 'running', subagentLane: true }
  expect(turnAgentLanes([lane, ...tools])).toEqual([lane])
  expect(turnFoldedSteps([lane, ...tools])).toEqual(tools)
  // The steps are counted without it, and a turn that only spawned agents has
  // nothing to fold.
  expect(deriveTurnFold(entry, [lane, ...tools])?.label).toBe('Worked for 1m 20s · 2 steps')
  expect(deriveTurnFold(entry, [lane])).toBeNull()
  // A failed agent says so on its card, not on the fold.
  expect(turnFoldFailures([{ ...lane, status: 'done', outputStatus: 'error' }, ...tools])).toBe(0)
})

test('intermediate prose folds with the steps while final prose remains separate', () => {
  const withProse = { ...entry, intermediateText: [{ text: 'I will inspect the file.', beforeToolUseId: 'one' }] }
  expect(deriveTurnFold(withProse, tools.slice(0, 1))).not.toBeNull()
  expect(withProse.text).toBe('Answer')
})

test('a turn without a known start reports no duration instead of time since the epoch', () => {
  expect(deriveTurnFold({ ...entry, startedAt: undefined }, tools)?.label).toBe('Worked · 2 steps')
  expect(deriveTurnFold({ ...entry, startedAt: undefined, durationMs: 4000 }, tools)?.label).toBe(
    'Worked for 4s · 2 steps',
  )
  expect(deriveTurnFold({ ...entry, status: 'failed', startedAt: undefined }, tools)?.label).toBe('Failed · 2 steps')
  const withReasoning = { ...entry, reasoning: 'Thinking' }
  expect(deriveTurnFold(withReasoning, tools.slice(0, 1))?.label).toBe('Worked for 1m 20s · 1 step')
})

test('a late continuation turn does not take over as the latest reply', () => {
  const user = (id: string): TranscriptEntry => ({ kind: 'user', id, text: id })
  const reply = (turnId: string): TranscriptEntry => ({ ...entry, turnId })
  expect(latestReplyTurnId([user('a'), reply('a'), user('b'), reply('b')])).toBe('b')
  // A background agent's report after the turn ended arrives as its own turn.
  expect(latestReplyTurnId([user('a'), reply('a'), user('b'), reply('b'), reply('continuation')])).toBe('b')
  // A message still waiting for its reply leaves the previous one open.
  expect(latestReplyTurnId([user('a'), reply('a'), user('b')])).toBe('a')
  expect(latestReplyTurnId([reply('legacy')])).toBe('legacy')
  expect(latestReplyTurnId([])).toBeUndefined()
})

test('a fold counts the steps inside it that went wrong', () => {
  expect(turnFoldFailures(tools)).toBe(0)
  const failed: TranscriptToolEntry[] = [
    { ...tools[0], toolKind: 'command', exitCode: 2 },
    { ...tools[1], outputStatus: 'error' },
  ]
  expect(turnFoldFailures(failed)).toBe(2)
})

test('what the agent made for the person to see is never folded', () => {
  const picture: TranscriptToolEntry = { ...tools[0], id: 'picture', name: 'GenerateImage' }
  expect(stepShownToUser(picture)).toBe(true)
  // A picture that failed to generate is one more step that went wrong.
  expect(stepShownToUser({ ...picture, outputStatus: 'error' })).toBe(false)
  expect(stepShownToUser(tools[0])).toBe(false)
  expect(turnFoldedSteps([...tools, picture])).toEqual(tools)
  expect(deriveTurnFold(entry, [...tools, picture])?.label).toBe('Worked for 1m 20s · 2 steps')

  expect(proseShownToUser('The chart: ![Revenue](/Users/dev/project/chart.png)')).toBe(true)
  expect(proseShownToUser('<img src="https://example.com/map.png">')).toBe(true)
  expect(proseShownToUser('I will read [the config](config.ts) next.')).toBe(false)
  const prose = [
    { text: 'Checking the file.', beforeToolUseId: 'one' },
    { text: '![Before](/Users/dev/project/before.png)', beforeToolUseId: 'two' },
  ]
  expect(turnFoldedProse(prose)).toEqual([prose[0]])
  // In the order it came: the prose written before a step comes before it.
  expect(turnShownWork([...tools, picture], prose).map((item) => item.id)).toEqual(['prose:two:1', 'picture'])
})

test('a plugin Studio offered stands outside the fold, under any runtime’s name for the tool', () => {
  const offer = (name: string, serverName?: string): TranscriptToolEntry => ({
    ...tools[0],
    id: name,
    name,
    ...(serverName ? { serverName } : {}),
  })
  expect(stepShownToUser(offer('mcp__sprintengine-studio__plugin_offer'))).toBe(true)
  expect(stepShownToUser(offer('sprintengine-studio.plugin_offer'))).toBe(true)
  expect(stepShownToUser(offer('plugin_offer', 'sprintengine-studio'))).toBe(true)
  // Another server's tool of the same name is not ours to draw.
  expect(stepShownToUser(offer('mcp__other__plugin_offer'))).toBe(false)
  expect(stepShownToUser(offer('plugin_offer', 'other'))).toBe(false)
  // Nor is the search, or an offer the gateway refused.
  expect(stepShownToUser(offer('mcp__sprintengine-studio__plugin_search'))).toBe(false)
  expect(stepShownToUser({ ...offer('mcp__sprintengine-studio__plugin_offer'), outputStatus: 'error' })).toBe(false)
  const shown = offer('mcp__sprintengine-studio__plugin_offer')
  expect(turnFoldedSteps([shown, ...tools])).toEqual(tools)
  expect(turnShownWork([shown, ...tools], undefined)).toEqual([{ kind: 'step', id: shown.id, tool: shown }])
})
