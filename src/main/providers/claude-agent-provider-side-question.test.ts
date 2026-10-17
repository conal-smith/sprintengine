import { expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// A side question as Claude Code 2.1.296 answers one over the SDK
// (`askSideQuestion`, its /btw): asked of the child the chat runs, answered in
// one reply, with nothing written into the stream the turn is read from.

type Asked = { question: string; options?: { history?: unknown; signal?: AbortSignal } }
type Child = { options: Record<string, unknown>; prompts: unknown[]; emit: (message: Record<string, unknown>) => void }

const TURN: MockAdapterTurnInput = {
  sessionId: 'conv_1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: CLAUDE_AGENT_PROVIDER_ID,
  modelId: 'sonnet',
  workspaceRoot: '/Users/dev/app',
  turnId: 'turn_1',
  requestId: 'approval_1',
  message: 'Refactor the parser',
}

function harness(
  sideQuestion:
    ((asked: Asked) => Promise<{ response: string | null; synthetic?: boolean } | null>) | 'absent' = async () => ({
    response: 'It is the parser in src/parse.ts.',
    synthetic: false,
  }),
) {
  const children: Child[] = []
  const asked: Asked[] = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    let ended = false
    const child: Child = {
      options: params.options,
      prompts: [],
      emit: (message) => {
        pending.push(message)
        wake?.()
      },
    }
    children.push(child)
    ;(params.options.abortController as AbortController | undefined)?.signal.addEventListener('abort', () => {
      ended = true
      wake?.()
    })
    void (async () => {
      for await (const message of params.prompt) child.prompts.push(message)
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      ...(sideQuestion === 'absent'
        ? {}
        : {
            askSideQuestion: (question: string, options?: Asked['options']) => {
              asked.push({ question, options })
              return sideQuestion({ question, options })
            },
          }),
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    childAnswerTimeoutMs: 20,
  })
  return { adapter, children, asked }
}

const ask = (question: string, signal = new AbortController().signal) => ({ question, history: [], signal })

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

test('a side question asked mid-turn is answered by the live child and leaves the turn as it was', async () => {
  const h = harness()
  expect(h.adapter.capabilities?.sideQuestion).toBe(true)
  try {
    await h.adapter.startSession(TURN)
    const stream = (await h.adapter.sendTurn(TURN)) as AsyncIterable<ConversationEvent>
    const events: ConversationEvent[] = []
    const done = (async () => {
      for await (const event of stream) events.push(event)
    })()
    await waitFor(() => h.children[0]?.prompts.length === 1)
    const answer = await h.adapter.askSideQuestion('conv_1', {
      question: 'Which file is the parser in?',
      history: [{ question: 'What are we doing?', answer: 'Refactoring the parser.' }],
      signal: new AbortController().signal,
    })
    expect(answer).toEqual({ ok: true, answer: 'It is the parser in src/parse.ts.' })
    expect(h.asked[0]?.question).toBe('Which file is the parser in?')
    expect(h.asked[0]?.options?.history).toEqual([
      { question: 'What are we doing?', response: 'Refactoring the parser.' },
    ])
    // Asked of the same child, which was sent nothing for it.
    expect(h.children).toHaveLength(1)
    expect(h.children[0]!.prompts).toHaveLength(1)
    h.children[0]!.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Done.' }] },
    })
    h.children[0]!.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      session_id: 'native-1',
    })
    await done
    expect(events.at(-1)?.type).toBe('turn_completed')
    expect(JSON.stringify(events)).not.toContain('src/parse.ts')
  } finally {
    await h.adapter.disposeAll()
  }
})

test('with no child running, a side question starts one that resumes the session and sends it nothing', async () => {
  const h = harness()
  try {
    await h.adapter.startSession({ ...TURN, resumeSessionId: 'native-1' })
    expect(h.children).toHaveLength(0)
    expect(await h.adapter.askSideQuestion('conv_1', ask('What did we decide?'))).toEqual({
      ok: true,
      answer: 'It is the parser in src/parse.ts.',
    })
    expect(h.children).toHaveLength(1)
    expect(h.children[0]!.options.resume).toBe('native-1')
    expect(h.children[0]!.prompts).toEqual([])
  } finally {
    await h.adapter.disposeAll()
  }
})

test('the signal reaches the child, so a side question called off is called off there', async () => {
  const h = harness(
    ({ options }) =>
      new Promise((_, reject) =>
        options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      ),
  )
  try {
    await h.adapter.startSession(TURN)
    const abort = new AbortController()
    const answering = h.adapter.askSideQuestion('conv_1', ask('Still there?', abort.signal))
    await waitFor(() => h.asked.length === 1)
    abort.abort()
    const answer = await answering
    expect(answer.ok).toBe(false)
    expect(h.asked[0]!.options?.signal?.aborted).toBe(true)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Claude Code that cannot answer side questions says so rather than failing obscurely', async () => {
  const absent = harness('absent')
  const refusing = harness(async () => {
    throw new Error('Unsupported control request subtype: side_question')
  })
  try {
    for (const h of [absent, refusing]) {
      await h.adapter.startSession(TURN)
      const answer = await h.adapter.askSideQuestion('conv_1', ask('Anything?'))
      expect(answer).toEqual({
        ok: false,
        message: 'This version of Claude Code cannot answer side questions. Update it to ask one.',
      })
    }
  } finally {
    await absent.adapter.disposeAll()
    await refusing.adapter.disposeAll()
  }
})

test('an empty answer is not passed off as one', async () => {
  const h = harness(async () => ({ response: null }))
  try {
    await h.adapter.startSession(TURN)
    expect(await h.adapter.askSideQuestion('conv_1', ask('Anything?'))).toEqual({
      ok: false,
      message: 'Claude Code gave no answer to that.',
    })
    expect(await h.adapter.askSideQuestion('conv_missing', ask('Anything?'))).toMatchObject({ ok: false })
  } finally {
    await h.adapter.disposeAll()
  }
})
