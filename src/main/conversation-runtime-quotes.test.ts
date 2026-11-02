import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { quoteToken } from '../shared/chat-quotes'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider, type MockAdapterTurnInput } from './providers/mock-conversation-provider'

// A message quoting an earlier reply carries its quotes as tokens in its text
// (shared/chat-quotes.ts). The agent reads them expanded; the transcript keeps
// the tokens, so the message is drawn with its chips again.

const token = quoteToken({
  turnId: 'turn_earlier',
  n: 1,
  quote: 'Keep the cache warm.',
  exact: 'Keep the cache warm.',
  prefix: '',
  suffix: '',
  comment: 'Why (exactly)?',
})
const message = `Is this right? ${token} thanks`

function runtimeRecording(turns: MockAdapterTurnInput[]) {
  const mock = createMockConversationProvider()
  return new ConversationRuntime({
    adapters: [
      {
        ...mock,
        sendTurn(input) {
          turns.push(input)
          // The mock's `/tools` turn completes on its own; its plain turn
          // waits on an approval, and a turn that never completes is not
          // history.
          return mock.sendTurn({ ...input, message: '/tools' })
        },
      },
    ],
    getProviderById: () => undefined,
  })
}

test('the agent reads a quote expanded while the transcript keeps its token', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-quotes-'))
  const turns: MockAdapterTurnInput[] = []
  const runtime = runtimeRecording(turns)
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    if (!started.ok) throw new Error(started.message)
    expect((await runtime.sendTurn({ sessionId: started.session.sessionId, message })).ok).toBe(true)
    const sent = turns[0]!
    expect(sent.message).not.toContain('sprintengine-quote:')
    expect(sent.message).toContain('Is this right? [quote 1] thanks')
    expect(sent.message).toContain('[quote 1]\n> Keep the cache warm.\nComment: Why (exactly)?\n</quotes>')
    expect(sent.messages?.at(-1)?.content).toContain('<quotes>')
    expect(sent.messages?.at(-1)?.content).not.toContain('sprintengine-quote:')
    const transcript = await runtime.readTranscript(key)
    if (!transcript.ok) throw new Error(transcript.message)
    expect(transcript.events.find((event) => event.type === 'user_message')?.payload?.text).toBe(message)
    // The next turn's history holds the earlier message as the agent read it.
    expect((await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'And now?' })).ok).toBe(true)
    const history = turns[1]!.messages ?? []
    expect(history.some((entry) => entry.role === 'user' && entry.content.includes('[quote 1]'))).toBe(true)
    expect(history.some((entry) => entry.content.includes('sprintengine-quote:'))).toBe(false)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('history read back from the transcript expands the quotes it holds', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-quotes-history-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const first = runtimeRecording([])
  try {
    const started = await first.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    if (!started.ok) throw new Error(started.message)
    expect((await first.sendTurn({ sessionId: started.session.sessionId, message })).ok).toBe(true)
  } finally {
    await first.shutdown()
  }
  const turns: MockAdapterTurnInput[] = []
  const second = runtimeRecording(turns)
  try {
    const started = await second.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    if (!started.ok) throw new Error(started.message)
    expect((await second.sendTurn({ sessionId: started.session.sessionId, message: 'Again?' })).ok).toBe(true)
    const history = turns[0]!.messages ?? []
    const earlier = history.find((entry) => entry.role === 'user' && entry.content.startsWith('Is this right?'))
    expect(earlier?.content).toContain('Is this right? [quote 1] thanks')
    expect(earlier?.content).toContain('Comment: Why (exactly)?')
    expect(history.some((entry) => entry.content.includes('sprintengine-quote:'))).toBe(false)
  } finally {
    await second.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
