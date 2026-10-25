// Reads that ask the chat's agent (`conversation-side-questions`,
// `conversation-context-breakdown`): each frame read as the contract says,
// refused where it must be, and its answer read back off a `result`.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  CONVERSATION_MAX_SIDE_QUESTION_HISTORY,
  parseConversationContextBreakdownAnswer,
  parseConversationSideQuestionAnswer,
} from '../src/agentReads'
import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import {
  CONVERSATION_CAPABILITIES,
  CONVERSATION_CONTEXT_BREAKDOWN_CAPABILITY,
  CONVERSATION_SIDE_QUESTIONS_CAPABILITY,
} from '../src/handshake'
import { CONVERSATION_MAX_MESSAGE_CHARS, parseConversationClientFrame } from '../src/index'
import { parseConversationServerFrame } from '../src/serverFrames'

const ask = (fields: Record<string, unknown>) => ({
  type: 'askSideQuestion',
  requestId: 'r-1',
  questionId: 'q-1',
  question: 'Which file did it change first?',
  ...fields,
})

const breakdown = {
  model: 'claude-opus',
  usedTokens: 41_000,
  windowTokens: 200_000,
  categories: [
    { name: 'System prompt', tokens: 3_000, kind: 'used' },
    { name: 'Free space', tokens: 159_000, kind: 'free' },
  ],
  mcpServers: [{ name: 'studio', tokens: 1_200, tools: [{ name: 'browser_open', tokens: 300, loaded: true }] }],
  skills: [{ name: 'dataviz', tokens: 90, detail: 'project' }],
  memoryFiles: [{ name: 'CLAUDE.md', tokens: 800 }],
  agents: [],
  autoCompactAt: 160_000,
  estimated: false,
  measuredAt: 1_700_000_000_000,
}

test('both capabilities are listed', () => {
  assert.equal(CONVERSATION_SIDE_QUESTIONS_CAPABILITY, 'conversation-side-questions')
  assert.equal(CONVERSATION_CONTEXT_BREAKDOWN_CAPABILITY, 'conversation-context-breakdown')
  for (const capability of [CONVERSATION_SIDE_QUESTIONS_CAPABILITY, CONVERSATION_CONTEXT_BREAKDOWN_CAPABILITY])
    assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(capability))
})

test('a side question keeps its words and the aside before it, and nothing else', () => {
  assert.deepEqual(
    parseConversationClientMessage(
      ask({ history: [{ question: 'And before that?', answer: 'The README.', note: 1 }], extra: true }),
    ),
    {
      type: 'askSideQuestion',
      requestId: 'r-1',
      questionId: 'q-1',
      question: 'Which file did it change first?',
      history: [{ question: 'And before that?', answer: 'The README.' }],
    },
  )
  assert.deepEqual(
    parseConversationClientMessage({ type: 'cancelSideQuestion', requestId: 'r-2', questionId: 'q-1' }),
    {
      type: 'cancelSideQuestion',
      requestId: 'r-2',
      questionId: 'q-1',
    },
  )
})

test('a side question with nothing to ask, no id of its own, or an aside past the limits is refused under its request', () => {
  const tooMany = Array.from({ length: CONVERSATION_MAX_SIDE_QUESTION_HISTORY + 1 }, () => ({
    question: 'q',
    answer: 'a',
  }))
  for (const frame of [
    ask({ question: '   ' }),
    ask({ question: 7 }),
    ask({ questionId: '' }),
    ask({ history: tooMany }),
    ask({ history: [{ question: 'q' }] }),
    ask({ question: 'x'.repeat(CONVERSATION_MAX_MESSAGE_CHARS + 1) }),
    { type: 'cancelSideQuestion', requestId: 'r-2' },
  ]) {
    assert.equal(parseConversationClientMessage(frame), null)
    const rejection = explainRejectedConversationMessage(frame)
    assert.equal(rejection.code, 'invalid_frame')
    assert.equal(rejection.requestId, frame.requestId, 'answered under its request id')
  }
})

test('the breakdown read is a request and nothing more', () => {
  assert.deepEqual(parseConversationClientMessage({ type: 'getContextBreakdown', requestId: 'r-3', key: 'x' }), {
    type: 'getContextBreakdown',
    requestId: 'r-3',
  })
  assert.equal(parseConversationClientMessage({ type: 'getContextBreakdown' }), null)
})

test('a desktop from before them reads neither frame, and refuses each under its request id', () => {
  for (const frame of [
    ask({}),
    { type: 'cancelSideQuestion', requestId: 'r-1', questionId: 'q-1' },
    { type: 'getContextBreakdown', requestId: 'r-1' },
  ])
    assert.equal(parseConversationClientFrame(frame), null)
})

test('an answer is read off its result', () => {
  assert.deepEqual(parseConversationSideQuestionAnswer({ answer: 'src/app.ts', ok: true }), { answer: 'src/app.ts' })
  assert.equal(parseConversationSideQuestionAnswer({ answer: 7 }), null)
  assert.equal(parseConversationSideQuestionAnswer(null), null)
})

test('a breakdown is read off its result whole, or not at all', () => {
  assert.deepEqual(parseConversationContextBreakdownAnswer({ breakdown, stale: true, ok: true }), {
    breakdown,
    stale: true,
  })
  assert.deepEqual(parseConversationContextBreakdownAnswer({ breakdown }), { breakdown })
  // A row of the wrong shape spoils the reading: its totals would not add up.
  assert.equal(
    parseConversationContextBreakdownAnswer({
      breakdown: { ...breakdown, categories: [{ name: 'System prompt', tokens: '3k', kind: 'used' }] },
    }),
    null,
  )
  assert.equal(parseConversationContextBreakdownAnswer({ breakdown: { ...breakdown, autoCompactAt: 'never' } }), null)
  assert.equal(parseConversationContextBreakdownAnswer({}), null)
})

test('a listed chat keeps whether it answers a side question and says what fills its window', () => {
  const frame = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list-1',
    sessions: [
      {
        workspaceId: 'ws',
        agentId: 'agent',
        title: 'Chat',
        phase: 'completed',
        updatedAt: 2,
        createdAt: 1,
        providerId: 'claude-agent',
        modelId: 'default',
        turnCount: 1,
        lastSeq: 4,
        capabilities: {
          images: true,
          approvals: true,
          questions: true,
          planMode: false,
          interrupt: true,
          checkpoints: false,
          sideQuestion: true,
          contextBreakdown: 'maybe',
        },
      },
    ],
  })
  assert.ok(frame?.type === 'sessions')
  const capabilities = frame.sessions[0]!.capabilities
  assert.equal(capabilities?.sideQuestion, true)
  assert.equal('contextBreakdown' in (capabilities ?? {}), false)
})
