import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'

import type { ConversationContextBreakdown } from '../../../shared/conversation-runtime'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost } from './tailnet-conversation-host'
import { createTailnetConversationStream } from './tailnet-conversation-stream'
import { createWebSocketFrameDecoder, encodeMaskedTextFrame } from './websocket-frames'

// A side question and the window's breakdown asked from a paired device
// (`conversation-side-questions`, `conversation-context-breakdown`): each
// reaches the chat's agent as the chat view's own does, and its answer comes
// back under the request that asked.

class Socket extends Duplex {
  frames: Buffer[] = []
  _read(): void {}
  override write(chunk: Buffer, encoding?: unknown, callback?: unknown): boolean {
    this.frames.push(chunk)
    return (super.write as (...args: unknown[]) => boolean).call(this, chunk, encoding, callback)
  }
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    done()
  }
  receive(frame: unknown): void {
    this.push(encodeMaskedTextFrame(JSON.stringify(frame)))
  }
  output(): Array<Record<string, unknown>> {
    const decoder = createWebSocketFrameDecoder(256 * 1024, 'client')
    return this.frames.flatMap((bytes) => {
      const read = decoder.push(bytes)
      return read.kind === 'frames'
        ? read.frames
            .filter((frame) => frame.kind === 'text')
            .map((frame) => JSON.parse((frame as { text: string }).text) as Record<string, unknown>)
        : []
    })
  }
  result(requestId: string): Record<string, unknown> | undefined {
    return this.output().find((frame) => frame.type === 'result' && frame.requestId === requestId)
  }
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate(), what)
}

const breakdown: ConversationContextBreakdown = {
  model: 'mock-model',
  usedTokens: 12_000,
  windowTokens: 200_000,
  categories: [{ name: 'Messages', tokens: 12_000, kind: 'used' }],
  mcpServers: [],
  skills: [],
  memoryFiles: [],
  agents: [],
  autoCompactAt: null,
  estimated: true,
  measuredAt: 1_700_000_000_000,
}

async function fixture(
  options: { start?: boolean; scopes?: Array<'conversation:read' | 'conversation:operate'> } = {},
) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-agent-reads-'))
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = createMockConversationProvider({ sideQuestion: true, contextBreakdown: true })
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
  )
  const started =
    options.start === false
      ? null
      : await runtime.startSession({
          ...key,
          providerId: adapter.id,
          modelId: adapter.listModels()[0]!,
          permissionPreset: 'bypass',
        })
  if (started) assert.ok(started.ok)
  const socket = new Socket()
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'laptop',
    deviceName: 'laptop',
    scopes: options.scopes ?? ['conversation:operate'],
    host,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: key.workspaceId, agentId: key.agentId } })
  await waitFor(() => socket.output().some((frame) => frame.type === 'synchronized'), 'following the chat')
  return {
    key,
    host,
    runtime,
    socket,
    stream,
    session: started?.ok ? started.session : null,
    cleanup: async () => {
      stream.close(1000, '')
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('a listed chat says whether it answers a side question and says what fills its window', async () => {
  const f = await fixture()
  try {
    const listed = (await f.host.list())[0]!.capabilities
    assert.equal(listed?.sideQuestion, true)
    assert.equal(listed?.contextBreakdown, true)
  } finally {
    await f.cleanup()
  }
})

test("a device's side question is asked of the chat's session, and its answer comes back under the request", async () => {
  const f = await fixture()
  try {
    const asked = vi.spyOn(f.runtime, 'askSideQuestion').mockResolvedValue({ ok: true, answer: 'src/app.ts first.' })
    f.socket.receive({
      type: 'askSideQuestion',
      requestId: 'r-1',
      questionId: 'q-1',
      question: 'Which file did it change first?',
      history: [{ question: 'Did it run the tests?', answer: 'Yes.' }],
    })
    await waitFor(() => f.socket.result('r-1') !== undefined, 'answered')
    assert.deepEqual(f.socket.result('r-1'), {
      type: 'result',
      requestId: 'r-1',
      ok: true,
      data: { answer: 'src/app.ts first.' },
    })
    const input = asked.mock.calls[0]![0]
    assert.equal(input.sessionId, f.session!.sessionId)
    assert.equal(input.question, 'Which file did it change first?')
    assert.deepEqual(input.history, [{ question: 'Did it run the tests?', answer: 'Yes.' }])
  } finally {
    await f.cleanup()
  }
})

test('a side question called off is called off where it went, and is refused rather than answered', async () => {
  const f = await fixture()
  try {
    let settle: (value: { ok: false; cancelled: true; message: string }) => void = () => undefined
    const asked = vi.spyOn(f.runtime, 'askSideQuestion').mockReturnValue(new Promise((resolve) => (settle = resolve)))
    const cancel = vi.spyOn(f.runtime, 'cancelSideQuestion').mockImplementation(async () => {
      settle({ ok: false, cancelled: true, message: 'The side question was called off.' })
      return { ok: true }
    })
    f.socket.receive({ type: 'askSideQuestion', requestId: 'r-1', questionId: 'q-1', question: 'Why?' })
    await waitFor(() => asked.mock.calls.length === 1, 'asked')
    f.socket.receive({ type: 'cancelSideQuestion', requestId: 'r-2', questionId: 'q-1' })
    await waitFor(() => f.socket.result('r-1') !== undefined, 'the question settled')
    assert.deepEqual(cancel.mock.calls, [
      [{ sessionId: f.session!.sessionId, requestId: asked.mock.calls[0]![0].requestId }],
    ])
    assert.equal(f.socket.result('r-1')?.ok, false)
    assert.equal(f.socket.result('r-2')?.ok, true)
  } finally {
    await f.cleanup()
  }
})

test('a side question still out when the socket goes is called off: nobody is left to read it', async () => {
  const f = await fixture()
  try {
    const asked = vi.spyOn(f.runtime, 'askSideQuestion').mockReturnValue(new Promise(() => undefined))
    const cancel = vi.spyOn(f.runtime, 'cancelSideQuestion').mockResolvedValue({ ok: true })
    f.socket.receive({ type: 'askSideQuestion', requestId: 'r-1', questionId: 'q-1', question: 'Why?' })
    await waitFor(() => asked.mock.calls.length === 1, 'asked')
    f.stream.close(1000, '')
    await waitFor(() => cancel.mock.calls.length === 1, 'called off')
  } finally {
    await f.cleanup()
  }
})

test('a pairing that may only follow cannot ask one: it runs the agent', async () => {
  const f = await fixture({ scopes: ['conversation:read'] })
  try {
    const asked = vi.spyOn(f.runtime, 'askSideQuestion')
    f.socket.receive({ type: 'askSideQuestion', requestId: 'r-1', questionId: 'q-1', question: 'Why?' })
    await waitFor(() => f.socket.result('r-1') !== undefined, 'answered')
    assert.equal(f.socket.result('r-1')?.code, 'conversation_operate_required')
    assert.equal(asked.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})

test("the window's breakdown is read from the live session's agent, and needs only a read grant", async () => {
  const f = await fixture({ scopes: ['conversation:read'] })
  try {
    const read = vi.spyOn(f.runtime, 'readContextBreakdown').mockResolvedValue({ ok: true, breakdown, stale: true })
    f.socket.receive({ type: 'getContextBreakdown', requestId: 'r-1' })
    await waitFor(() => f.socket.result('r-1') !== undefined, 'answered')
    assert.deepEqual(f.socket.result('r-1'), {
      type: 'result',
      requestId: 'r-1',
      ok: true,
      data: { breakdown, stale: true },
    })
    assert.deepEqual(read.mock.calls, [[{ sessionId: f.session!.sessionId }]])
  } finally {
    await f.cleanup()
  }
})

test('a chat at rest is not started to read its window: there is no agent to ask yet', async () => {
  const f = await fixture({ start: false })
  try {
    const start = vi.spyOn(f.runtime, 'startSession')
    const read = await f.host.contextBreakdown!(f.key)
    assert.equal(read.ok, false)
    assert.equal(!read.ok && read.reason, 'not-running')
    assert.equal(start.mock.calls.length, 0)
  } finally {
    await f.cleanup()
  }
})
