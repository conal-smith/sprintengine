import { expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// What fills a chat's context window, as Claude Code's /context reads it over
// the SDK (`getContextUsage`): asked of the live child in summary detail, so
// no token-count calls are made; never a reason to start a child; and the
// last reading answered, marked old, once the child is gone.

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

const READING = {
  model: 'claude-sonnet-4-5',
  totalTokens: 41_000,
  maxTokens: 167_000,
  rawMaxTokens: 200_000,
  percentage: 21,
  categories: [
    { name: 'System prompt', tokens: 3_000, color: 'promptBorder', kind: 'used' },
    { name: 'MCP tools', tokens: 8_000, color: 'cyan', kind: 'used' },
    { name: 'Messages', tokens: 30_000, color: 'purple', kind: 'used' },
    { name: 'Free space', tokens: 126_000, color: 'promptBorder', kind: 'free' },
    { name: 'Autocompact buffer', tokens: 33_000, color: 'inactive', kind: 'buffer' },
  ],
  gridRows: [],
  memoryFiles: [],
  mcpTools: [{ name: 'mcp__linear__create_issue', serverName: 'linear', tokens: 8_000, isLoaded: true }],
  agents: [],
  isAutoCompactEnabled: true,
  autoCompactThreshold: 167_000,
  apiUsage: null,
}

function harness(read: ((options: unknown) => Promise<unknown>) | 'absent' = async () => READING) {
  const children: Child[] = []
  const asked: unknown[] = []
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
      ...(read === 'absent'
        ? {}
        : {
            getContextUsage: (options: unknown) => {
              asked.push(options)
              return read(options)
            },
          }),
    }
  }
  let clock = 1_000
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    childAnswerTimeoutMs: 20,
    now: () => clock,
  })
  return { adapter, children, asked, tick: (ms: number) => (clock += ms) }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2000 && !check(); attempt++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}

async function startTurn(h: ReturnType<typeof harness>): Promise<{ finish: () => Promise<ConversationEvent[]> }> {
  await h.adapter.startSession(TURN)
  const stream = (await h.adapter.sendTurn(TURN)) as AsyncIterable<ConversationEvent>
  const events: ConversationEvent[] = []
  const done = (async () => {
    for await (const event of stream) events.push(event)
  })()
  await waitFor(() => h.children[0]?.prompts.length === 1)
  return {
    finish: async () => {
      h.children[0]!.emit({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'n-1' })
      await done
      return events
    },
  }
}

test('the live child is asked in summary detail, mid-turn, and sent nothing for it', async () => {
  const h = harness()
  expect(h.adapter.capabilities?.contextBreakdown).toBe(true)
  try {
    const turn = await startTurn(h)
    const result = await h.adapter.readContextBreakdown('conv_1')
    expect(h.asked).toEqual([{ detail: 'summary' }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stale).toBeUndefined()
    expect(result.breakdown).toMatchObject({
      usedTokens: 41_000,
      windowTokens: 200_000,
      estimated: true,
      measuredAt: 1_000,
      mcpServers: [{ name: 'linear', tokens: 8_000, tools: [{ name: 'create_issue', tokens: 8_000, loaded: true }] }],
    })
    expect(h.children).toHaveLength(1)
    expect(h.children[0]!.prompts).toHaveLength(1)
    const events = await turn.finish()
    expect(events.at(-1)?.type).toBe('turn_completed')
  } finally {
    await h.adapter.disposeAll()
  }
})

test('with no child running nothing is started, and the last reading is answered as old', async () => {
  const h = harness()
  try {
    await h.adapter.startSession({ ...TURN, resumeSessionId: 'native-1' })
    expect(await h.adapter.readContextBreakdown('conv_1')).toMatchObject({ ok: false, reason: 'not-running' })
    expect(h.children).toHaveLength(0)

    const turn = await startTurn(h)
    await turn.finish()
    const live = await h.adapter.readContextBreakdown('conv_1')
    expect(live.ok).toBe(true)
    h.adapter.disposeChildProcess('conv_1')
    h.tick(60_000)
    const old = await h.adapter.readContextBreakdown('conv_1')
    expect(old).toMatchObject({ ok: true, stale: true, breakdown: { measuredAt: 1_000 } })
    expect(h.asked).toHaveLength(1)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Claude Code that cannot say what fills its window says so, and a failed read says why', async () => {
  const old = harness('absent')
  try {
    await startTurn(old)
    expect(await old.adapter.readContextBreakdown('conv_1')).toMatchObject({ ok: false, reason: 'unsupported' })
  } finally {
    await old.adapter.disposeAll()
  }

  const refusing = harness(async () => {
    throw new Error('Unsupported control request subtype: get_context_usage')
  })
  try {
    await startTurn(refusing)
    expect(await refusing.adapter.readContextBreakdown('conv_1')).toMatchObject({ ok: false, reason: 'unsupported' })
  } finally {
    await refusing.adapter.disposeAll()
  }

  const failing = harness(async () => {
    throw new Error('stream closed')
  })
  try {
    await startTurn(failing)
    const result = await failing.adapter.readContextBreakdown('conv_1')
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    expect(!result.ok && result.message).toContain('stream closed')
  } finally {
    await failing.adapter.disposeAll()
  }

  const garbled = harness(async () => ({ categories: 'none' }))
  try {
    await startTurn(garbled)
    expect(await garbled.adapter.readContextBreakdown('conv_1')).toMatchObject({ ok: false, reason: 'failed' })
  } finally {
    await garbled.adapter.disposeAll()
  }
})

test('an unknown session is refused in words', async () => {
  const h = harness()
  expect(await h.adapter.readContextBreakdown('nope')).toMatchObject({ ok: false, reason: 'failed' })
})
