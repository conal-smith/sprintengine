import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import type { ConversationEvent, ConversationSessionFrame } from '../../../shared/conversation-runtime'
import type { TailnetScope } from '../../../shared/tailnet'
import { ConversationRuntime } from '../../conversation-runtime'
import type { ConversationProviderAdapter } from '../../providers/conversation-provider-adapter'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationGatewayHost } from './tailnet-conversation-host'
import {
  createResyncBackoff,
  createTailnetConversationStream,
  redactHostPaths,
  type ConversationCommandAudit,
} from './tailnet-conversation-stream'
import { createWebSocketFrameDecoder, encodeMaskedTextFrame } from './websocket-frames'
import {
  CONVERSATION_MAX_MESSAGE_CHARS,
  conversationCloseRetryAfterMs,
} from '../../../../packages/conversation-protocol/src'

// Counts the snapshot events the stream redacts, and otherwise is the real one.
const redaction = vi.hoisted(() => ({ events: 0 }))
vi.mock('../../conversation-tool-details', async (original) => {
  const actual = await original<typeof import('../../conversation-tool-details')>()
  return {
    ...actual,
    redactConversationValue: <T>(value: T): T => {
      const events = (value as { page?: { events?: unknown[] } } | null)?.page?.events
      if (Array.isArray(events)) redaction.events += events.length
      return actual.redactConversationValue(value)
    },
  }
})

class Socket extends Duplex {
  // Every write in the order the stream made it: what the peer would read.
  frames: Buffer[] = []
  delayMs = 0
  // A peer that has stopped reading: no write ever completes.
  stalled = false
  _read(): void {}
  override write(chunk: Buffer, encoding?: unknown, callback?: unknown): boolean {
    this.frames.push(chunk)
    return (super.write as (...args: unknown[]) => boolean).call(this, chunk, encoding, callback)
  }
  _write(_chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.stalled) return
    if (this.delayMs) setTimeout(done, this.delayMs)
    else done()
  }
  closeFrame(): { code: number; reason: string } | undefined {
    const decoded = createWebSocketFrameDecoder(256 * 1024, 'client').push(Buffer.concat(this.frames))
    if (decoded.kind !== 'frames') return undefined
    const close = decoded.frames.find((frame) => frame.kind === 'close')
    return close?.kind === 'close' ? { code: close.code, reason: close.reason } : undefined
  }
  receive(frame: unknown): void {
    this.push(encodeMaskedTextFrame(JSON.stringify(frame)))
  }
  output(): unknown[] {
    const decoder = createWebSocketFrameDecoder(256 * 1024, 'client')
    return this.frames.flatMap((bytes) => {
      const read = decoder.push(bytes)
      return read.kind === 'frames'
        ? read.frames
            .filter((frame) => frame.kind === 'text')
            .map((frame) => JSON.parse((frame as { text: string }).text) as unknown)
        : []
    })
  }
}

const key = { workspaceRoot: '/workspace', workspaceId: 'w', agentId: 'a' }
function host(): ConversationGatewayHost {
  return {
    list: async () => [],
    resolveKey: (workspaceId, agentId) => (workspaceId === 'w' && agentId === 'a' ? key : null),
    // A stand-in for transport tests only. What a subscriber is sent on join
    // is the session API's contract, exercised through the real one below.
    subscribe: (_key, _cursor, listener) => {
      const ready = Promise.resolve().then(() => {
        listener({ type: 'snapshot', page: { events: [], hasMore: false, beforeCursor: null }, generation: 'g' })
        listener({ type: 'synchronized', seq: 0, generation: 'g' })
      })
      return { dispose: () => {}, ready }
    },
    loadEarlier: async () => ({ ok: true, page: { events: [], hasMore: false, beforeCursor: null } }),
    getToolDetail: async () => ({ ok: false, code: 'not_found', message: 'Missing.' }),
    getTurnDiff: async () => ({ ok: false, message: 'Missing.' }),
    command: async () => ({ ok: true }),
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('oversized control frames are refused and ping replies respect socket backpressure', async () => {
  const oversized = encodeMaskedTextFrame('x'.repeat(126))
  oversized[0] = 0x89
  const decoder = createWebSocketFrameDecoder(256 * 1024)
  assert.deepEqual(decoder.push(oversized), {
    kind: 'error',
    code: 1002,
    reason: 'Control frame exceeds the 125-byte limit.',
  })
  const socket = new Socket()
  Object.defineProperty(socket, 'writableLength', { get: () => 2 * 1024 * 1024 })
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: host(),
    onClosed: () => {},
    audit: () => {},
  })
  const ping = encodeMaskedTextFrame('ping')
  ping[0] = 0x89
  socket.push(ping)
  await tick()
  assert.equal(stream.isClosed(), true)
  const decoded = createWebSocketFrameDecoder(256 * 1024, 'client').push(Buffer.concat(socket.frames))
  assert.ok(decoded.kind === 'frames' && decoded.frames.some((frame) => frame.kind === 'close' && frame.code === 4409))
  socket.destroy()
})

type Frame = {
  type: string
  seq?: number
  code?: string
  requestId?: string
  retryAfterMs?: number
  event?: ConversationEvent
  page?: { events: ConversationEvent[]; hasMore: boolean; beforeCursor: number | null }
  part?: { index: number; total: number }
  frameId?: string
  index?: number
  total?: number
  json?: string
}

/** Wire frames with every chunked frame reassembled in its place. */
function assemble(frames: unknown[]): Frame[] {
  const assembled: Frame[] = []
  const chunks = new Map<string, string[]>()
  for (const frame of frames as Frame[]) {
    if (frame.type !== 'chunk') {
      assembled.push(frame)
      continue
    }
    const parts = chunks.get(frame.frameId!) ?? []
    parts[frame.index!] = frame.json!
    chunks.set(frame.frameId!, parts)
    if (parts.filter((part) => part !== undefined).length === frame.total)
      assembled.push(JSON.parse(parts.join('')) as Frame)
  }
  return assembled
}

function wireEvent(seq: number, type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent {
  return {
    id: `e${seq}`,
    seq,
    sessionId: 's',
    workspaceId: 'w',
    agentId: 'a',
    providerId: 'p',
    modelId: 'm',
    type,
    createdAt: seq,
    payload,
  }
}

/** A subscribed socket whose join the test drives frame by frame. */
async function joinedSocket(configure: (gateway: ConversationGatewayHost) => void = () => {}) {
  const socket = new Socket()
  const gateway = host()
  let listener!: (frame: ConversationSessionFrame) => void
  let disposed = 0
  gateway.subscribe = (_key, _cursor, receive) => {
    listener = receive
    return {
      ready: Promise.resolve(),
      dispose: () => {
        disposed++
      },
    }
  }
  configure(gateway)
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
    resyncRetryAfterMs: () => 4_000,
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  return { socket, stream, emit: (frame: ConversationSessionFrame) => listener(frame), disposed: () => disposed }
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    assert.ok(Date.now() - started < 10_000, what)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('a slow reader gets a streaming reply merged into waiting frames instead of a resync', async () => {
  const { socket, stream, emit } = await joinedSocket()
  emit({ type: 'synchronized', seq: 0 })
  socket.delayMs = 1
  let seq = 0
  const expected: string[] = []
  for (let index = 0; index < 3_000; index++) {
    const text = `word-${index} `
    expected.push(text)
    emit({ type: 'event', event: wireEvent(++seq, 'content_delta', { turnId: 't', text }) })
    // A tool's partial output streams alongside; only its newest one matters.
    if (index % 10 === 0)
      emit({
        type: 'event',
        event: wireEvent(++seq, 'tool_output', { toolUseId: 'tool', partial: true, preview: `line ${index}` }),
      })
  }
  emit({ type: 'event', event: wireEvent(++seq, 'turn_completed', { turnId: 't' }) })
  await until(() => assemble(socket.output()).some((frame) => frame.event?.type === 'turn_completed'), 'turn ends')
  assert.equal(stream.isClosed(), false)
  const frames = assemble(socket.output()).filter((frame) => frame.type === 'event')
  assert.ok(frames.length < 100, `a stalled reply is a handful of frames, not ${frames.length}`)
  const seqs = frames.map((frame) => frame.event!.seq!)
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  )
  assert.equal(seqs.at(-1), seq)
  const text = frames
    .filter((frame) => frame.event!.type === 'content_delta')
    .map((frame) => frame.event!.payload!.text)
    .join('')
  assert.equal(text, expected.join(''), 'merging never loses or reorders text')
  const outputs = frames.filter((frame) => frame.event!.type === 'tool_output')
  assert.equal(outputs.at(-1)!.event!.payload!.preview, 'line 2990')
  stream.close(1000, '')
})

test('a reader that stops reading is closed once with a resync and an advised retry delay', async () => {
  const joined = await joinedSocket()
  joined.socket.stalled = true
  joined.emit({ type: 'synchronized', seq: 0 })
  for (let seq = 1; seq <= 400; seq++)
    joined.emit({ type: 'event', event: wireEvent(seq, 'tool_started', { toolUseId: `tool-${seq}` }) })
  assert.equal(joined.stream.isClosed(), true)
  assert.equal(joined.disposed(), 1)
  const frames = joined.socket.output() as Frame[]
  assert.deepEqual(
    frames.filter((frame) => frame.type === 'error').map((frame) => [frame.code, frame.retryAfterMs]),
    [['resync_required', 4_000]],
  )
  assert.deepEqual(joined.socket.closeFrame(), { code: 4409, reason: 'resync_required;retryAfterMs=4000' })
  assert.equal(conversationCloseRetryAfterMs(joined.socket.closeFrame()!.reason), 4_000)
})

test('a read flood is answered busy while the socket stays open', async () => {
  const { socket, stream } = await joinedSocket((gateway) => {
    gateway.list = () => new Promise(() => {})
  })
  for (let index = 0; index < 20; index++) socket.receive({ type: 'list', requestId: `list-${index}` })
  await tick()
  assert.equal(stream.isClosed(), false)
  const busy = (socket.output() as Frame[]).filter((frame) => frame.code === 'busy')
  // The subscribe finished; four lists hold every read slot.
  assert.deepEqual(
    busy.map((frame) => frame.requestId),
    Array.from({ length: 16 }, (_, index) => `list-${index + 4}`),
  )
  assert.ok(busy.every((frame) => frame.type === 'result' && (frame.retryAfterMs ?? 0) > 0))
  stream.close(1000, '')
})

test('a large snapshot streams in parts while live events keep arriving, without a resync', async () => {
  const { socket, stream, emit } = await joinedSocket()
  socket.delayMs = 1
  const events = Array.from({ length: 400 }, (_, index) =>
    wireEvent(index + 1, 'tool_output', { toolUseId: `t${index}`, preview: 'x'.repeat(20_000) }),
  )
  emit({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: 1 }, generation: 'g' })
  emit({ type: 'synchronized', seq: 400, generation: 'g' })
  let seq = 400
  for (let index = 0; index < 2_000; index++)
    emit({ type: 'event', event: wireEvent(++seq, 'content_delta', { turnId: 't', text: `${index},` }) })
  for (let index = 0; index < 100; index++)
    emit({ type: 'event', event: wireEvent(++seq, 'tool_started', { toolUseId: `live-${index}` }) })
  await until(() => assemble(socket.output()).some((frame) => frame.event?.seq === seq), 'live events drain')
  assert.equal(stream.isClosed(), false)
  const frames = assemble(socket.output())
  const parts = frames.filter((frame) => frame.type === 'snapshot')
  assert.ok(parts.length > 1, 'a snapshot bigger than a frame arrives in parts')
  assert.deepEqual(
    parts.map((frame) => frame.part),
    parts.map((_, index) => ({ index, total: parts.length })),
  )
  assert.deepEqual(
    parts.flatMap((frame) => frame.page!.events.map((event) => event.seq)),
    events.map((event) => event.seq),
  )
  const fence = frames.findIndex((frame) => frame.type === 'synchronized')
  assert.ok(fence > frames.indexOf(parts.at(-1)!), 'the fence follows the whole snapshot')
  assert.ok(frames.slice(0, fence).every((frame) => frame.type === 'snapshot'))
  const live = frames.slice(fence + 1)
  assert.equal(
    live
      .filter((frame) => frame.event?.type === 'content_delta')
      .map((frame) => frame.event!.payload!.text)
      .join(''),
    Array.from({ length: 2_000 }, (_, index) => `${index},`).join(''),
  )
  stream.close(1000, '')
})

test('a large snapshot is redacted a part at a time as it is written, not all at once on join', async () => {
  const { socket, stream, emit } = await joinedSocket()
  // A reader that has not taken anything yet: the first part is written and
  // waits there.
  socket.stalled = true
  const events = Array.from({ length: 200 }, (_, index) =>
    wireEvent(index + 1, 'tool_output', {
      toolUseId: `t${index}`,
      preview: `${homedir()}/project/file-${index} ${'x'.repeat(20_000)}`,
    }),
  )
  const before = redaction.events
  emit({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: 1 }, generation: 'g' })
  emit({ type: 'synchronized', seq: 200, generation: 'g' })
  await tick()
  const partsOut = assemble(socket.output()).filter((frame) => frame.type === 'snapshot')
  assert.equal(partsOut.length, 1, 'one part is on the wire')
  const total = partsOut[0].part?.total ?? 1
  assert.ok(total > 3, `the snapshot is several parts (${total})`)
  // Only the part being written has been redacted, not the whole snapshot.
  const redacted = redaction.events - before
  assert.ok(redacted < events.length / 2, `redacted ${redacted} of ${events.length} events up front`)
  const written = JSON.stringify(socket.output())
  assert.equal(written.includes(homedir()), false, 'what is written is redacted')
  stream.close(1000, '')
})

test('a snapshot beyond the frame budget keeps its newest events and pages the rest', async () => {
  const { socket, stream, emit } = await joinedSocket()
  const events = Array.from({ length: 40 }, (_, index) =>
    wireEvent((index + 1) * 10, 'user_message', { text: 'y'.repeat(1024 * 1024) }),
  )
  emit({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: 10 }, reset: true, generation: 'g' })
  emit({ type: 'synchronized', seq: 400, generation: 'g' })
  await until(() => assemble(socket.output()).some((frame) => frame.type === 'synchronized'), 'snapshot drains')
  assert.equal(stream.isClosed(), false)
  const parts = assemble(socket.output()).filter((frame) => frame.type === 'snapshot')
  const kept = parts.flatMap((frame) => frame.page!.events.map((event) => event.seq!))
  assert.ok(kept.length > 0 && kept.length < events.length)
  assert.deepEqual(
    kept,
    events.slice(events.length - kept.length).map((event) => event.seq),
  )
  for (const part of parts) {
    assert.equal(part.page!.hasMore, true)
    assert.equal(part.page!.beforeCursor, kept[0], 'the rest is one loadEarlier away')
  }
  stream.close(1000, '')
})

test('resync delays double for a device that keeps falling behind and reset after a quiet spell', () => {
  let clock = 0
  const backoff = createResyncBackoff(() => clock)
  assert.deepEqual(
    Array.from({ length: 8 }, () => backoff('phone')),
    [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000],
  )
  assert.equal(backoff('tablet'), 1_000, 'per device')
  clock += 10 * 60_000
  assert.equal(backoff('phone'), 1_000)
})

test('replacing or closing a subscription suppresses stale replay and redacts outbound data', async () => {
  const socket = new Socket()
  const gateway = host()
  const listeners: Array<(frame: ConversationSessionFrame) => void> = []
  let disposed = 0
  gateway.subscribe = (_key, _cursor, receive) => {
    listeners.push(receive)
    return {
      ready: Promise.resolve(),
      dispose: () => {
        disposed++
      },
    }
  }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  listeners[0]({ type: 'synchronized', seq: 1 })
  listeners[1]({ type: 'synchronized', seq: 1 })
  listeners[1]({
    type: 'event',
    event: {
      id: 'e',
      seq: 2,
      sessionId: 's',
      workspaceId: 'w',
      agentId: 'a',
      providerId: 'p',
      modelId: 'm',
      type: 'tool_started',
      createdAt: 1,
      payload: { input: { path: `${homedir()}/project/file`, apiKey: 'test-secret' } },
    },
  })
  await tick()
  assert.deepEqual(
    socket.output().map((frame) => (frame as { type: string }).type),
    ['synchronized', 'event'],
  )
  const output = JSON.stringify(socket.output())
  assert.equal(output.includes(homedir()), false)
  assert.equal(output.includes('test-secret'), false)
  assert.ok(output.includes('[home]/project/file'))
  stream.close(1000, 'device_revoked')
  listeners[1]({ type: 'synchronized', seq: 3 })
  assert.equal(socket.output().length, 2)
  assert.equal(disposed, 2)
})

test('a grant narrowed mid-stream refuses commands, and one without read closes the socket', async () => {
  const socket = new Socket()
  let scopes: TailnetScope[] | null = ['conversation:operate']
  let commands = 0
  const gateway = host()
  gateway.command = async () => {
    commands++
    return { ok: true }
  }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: () => scopes,
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'command', commandId: 'before', command: { kind: 'interrupt' } })
  await tick()
  // Narrowed without a notification: the next frame is still judged by the grant as it is now.
  scopes = ['conversation:read']
  socket.receive({ type: 'command', commandId: 'after', command: { kind: 'interrupt' } })
  await tick()
  assert.equal(commands, 1)
  const results = (socket.output() as Array<Frame & { commandId?: string; ok?: boolean }>)
    .filter((frame) => frame.type === 'commandResult')
    .map((frame) => [frame.commandId, frame.ok, frame.code ?? null])
  assert.deepEqual(results, [
    ['before', true, null],
    ['after', false, 'conversation_operate_required'],
  ])
  assert.equal(stream.isClosed(), false)
  scopes = ['workspace:read']
  stream.refreshScopes()
  assert.equal(stream.isClosed(), true)
  assert.equal((socket.output().at(-1) as Frame).code, 'conversation_scope_required')
  assert.deepEqual(socket.closeFrame(), { code: 4403, reason: 'conversation_scope_required' })
})

test('a device removed while its socket is open is closed as revoked', async () => {
  const socket = new Socket()
  let scopes: TailnetScope[] | null = ['conversation:read']
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: () => scopes,
    host: host(),
    onClosed: () => {},
    audit: () => {},
  })
  scopes = null
  socket.receive({ type: 'list', requestId: 'list' })
  await tick()
  assert.equal(stream.isClosed(), true)
  assert.equal(socket.closeFrame()?.code, 4401)
  assert.equal(
    (socket.output() as Frame[]).some((frame) => frame.type === 'sessions'),
    false,
  )
})

test('host paths are rewritten by whole segments, and workspace paths read relative to the workspace', () => {
  const rewrite = (text: string) => redactHostPaths(text, { home: '/Users/dev', workspaceRoot: '/Users/dev/proj' })
  assert.deepEqual(
    [
      '/Users/dev/proj/src/a.ts',
      'cd /Users/dev/proj && npm test',
      'ls /Users/dev/proj/',
      '/Users/dev/proj-two/z.ts',
      '/Users/dev/other/y.md',
      '/Users/dev',
      '"/Users/dev/.zshrc"',
      'file:///Users/dev/other',
      'file:///Users/dev/proj/a.ts',
      'file:///Users/dev%20old/a.ts',
      '/Users/developer/notes.md',
      '/Users/dev.old/notes.md',
      '/opt/Users/dev/x',
    ].map(rewrite),
    [
      'src/a.ts',
      'cd . && npm test',
      'ls ./',
      '[home]/proj-two/z.ts',
      '[home]/other/y.md',
      '[home]',
      '"[home]/.zshrc"',
      'file:///[home]/other',
      // A file URL stays an absolute URL rather than turning into `file://a.ts`.
      'file:///[home]/proj/a.ts',
      'file:///Users/dev%20old/a.ts',
      '/Users/developer/notes.md',
      '/Users/dev.old/notes.md',
      '/opt/Users/dev/x',
    ],
  )
  assert.deepEqual(
    redactHostPaths(
      { input: { path: '/Users/dev/proj/a' }, list: ['/Users/dev/b'] },
      {
        home: '/Users/dev',
        workspaceRoot: null,
      },
    ),
    { input: { path: '[home]/proj/a' }, list: ['[home]/b'] },
  )
  // A Windows home is matched with either separator, as Windows reads both,
  // and a drive-letter file URL keeps its shape.
  const windows = (text: string) =>
    redactHostPaths(text, { home: 'C:\\Users\\dev', workspaceRoot: 'C:\\Users\\dev\\proj' })
  assert.deepEqual(
    [
      'C:/Users/dev/proj/src/a.ts',
      'C:\\Users\\dev\\proj\\src\\a.ts',
      'C:/Users/dev/notes.md',
      'type C:\\Users\\dev\\notes.md',
      'file:///C:/Users/dev/notes.md',
      'C:/Users/developer/notes.md',
    ].map(windows),
    [
      'src/a.ts',
      'src\\a.ts',
      '[home]/notes.md',
      'type [home]\\notes.md',
      'file:///[home]/notes.md',
      'C:/Users/developer/notes.md',
    ],
  )
  // A home with a space is spelled encoded in a URL.
  assert.equal(
    redactHostPaths('file:///Users/dev%20box/a.md', { home: '/Users/dev box', workspaceRoot: null }),
    'file:///[home]/a.md',
  )
})

test('heartbeat closes a peer that never returns a pong and stops its timer', () => {
  vi.useFakeTimers()
  try {
    const socket = new Socket()
    let closes = 0
    const stream = createTailnetConversationStream({
      socket,
      deviceId: 'device',
      deviceName: 'phone',
      scopes: ['conversation:read'],
      host: host(),
      onClosed: () => {
        closes++
      },
      audit: () => {},
    })
    vi.advanceTimersByTime(50_000)
    assert.equal(stream.isClosed(), false)
    vi.advanceTimersByTime(25_000)
    assert.equal(stream.isClosed(), true)
    vi.advanceTimersByTime(100_000)
    assert.equal(closes, 1)
    assert.equal(vi.getTimerCount(), 0)
  } finally {
    vi.useRealTimers()
  }
})

test('conversation socket refuses a device without read grant', () => {
  const socket = new Socket()
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: [],
    host: host(),
    onClosed: () => {},
    audit: () => {},
  })
  assert.equal(stream.isClosed(), true)
  assert.deepEqual(socket.output()[0], {
    type: 'error',
    code: 'conversation_scope_required',
    message: 'This device has no conversation read grant.',
  })
})

test('a read-only socket is refused commands with the command id', async () => {
  const socket = new Socket()
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: host(),
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'command', commandId: 'c', command: { kind: 'interrupt' } })
  await tick()
  assert.deepEqual(socket.output().at(-1), {
    type: 'commandResult',
    commandId: 'c',
    ok: false,
    code: 'conversation_operate_required',
  })
  stream.close(1000, '')
})

// A provider whose turn streams whatever the test pushes, so a socket can drop
// in the middle of a reply.
function pushProvider() {
  let push: (text: string | null) => void = () => undefined
  let started!: () => void
  const turnStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const base = createMockConversationProvider()
  const adapter: ConversationProviderAdapter = {
    ...base,
    sendTurn: (input) =>
      (async function* () {
        const queue: Array<string | null> = []
        let wake: (() => void) | null = null
        push = (text) => {
          queue.push(text)
          wake?.()
        }
        const event = (type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent => ({
          id: '',
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          providerId: input.providerId,
          modelId: input.modelId,
          createdAt: 1,
          type,
          payload,
        })
        yield event('turn_started', { turnId: input.turnId })
        started()
        for (;;) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve))
          wake = null
          const text = queue.shift()!
          if (text === null) break
          yield event('content_delta', { turnId: input.turnId, text })
        }
        yield event('turn_completed', { turnId: input.turnId })
      })(),
  }
  return { adapter, turnStarted, push: (text: string | null) => push(text) }
}

async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate(), what)
}

type WireFrame = { type: string; seq?: number; generation?: string; event?: ConversationEvent }
const wireSeqs = (frames: WireFrame[]) => frames.flatMap((frame) => (frame.type === 'event' ? [frame.event!.seq!] : []))

test('a socket dropped mid-turn resumes from its cursor with no gap, duplicate or reset', async () => {
  const provider = pushProvider()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-socket-'))
  const conversation = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const runtime = new ConversationRuntime({ adapters: [provider.adapter], getProviderById: () => undefined })
  const gateway = createConversationGatewayHost(
    runtime,
    (id) => (id === conversation.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: conversation.workspaceId }],
  )
  const open = () => {
    const socket = new Socket()
    const stream = createTailnetConversationStream({
      socket,
      deviceId: 'device',
      deviceName: 'phone',
      scopes: ['conversation:read'],
      host: gateway,
      onClosed: () => {},
      audit: () => {},
    })
    return { socket, stream, frames: () => socket.output() as WireFrame[] }
  }
  try {
    const started = await runtime.startSession({
      ...conversation,
      providerId: provider.adapter.id,
      modelId: provider.adapter.listModels()[0],
      permissionPreset: 'none',
    })
    assert.ok(started.ok)
    const first = open()
    first.socket.receive({ type: 'subscribe', key: { workspaceId: 'workspace', agentId: 'agent' } })
    await waitFor(() => first.frames().some((frame) => frame.type === 'synchronized'), 'first join synchronizes')
    const sending = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'stream' })
    await provider.turnStarted
    for (let index = 0; index < 5; index++) provider.push(`before-${index} `)
    // Deltas published together may arrive merged into one; only the text counts.
    const received = (frames: WireFrame[]) =>
      frames
        .flatMap((frame) => (frame.event?.type === 'content_delta' ? [String(frame.event.payload?.text)] : []))
        .join('')
    await waitFor(() => received(first.frames()).endsWith('before-4 '), 'live deltas reach the first socket')
    const generation = first.frames().find((frame) => frame.type === 'synchronized')?.generation
    assert.ok(generation, 'the fence names the log generation over the wire')
    const cursor = Math.max(...wireSeqs(first.frames()))
    first.stream.close(1001, '')
    first.socket.destroy()

    // Offline: more of the reply lands and reaches nobody.
    for (let index = 0; index < 5; index++) provider.push(`missed-${index} `)
    const published: number[] = []
    const stopWatching = runtime.onEvent((event) => published.push(event.seq!))
    await waitFor(() => published.length >= 5, 'offline deltas are published')

    const second = open()
    second.socket.receive({
      type: 'subscribe',
      key: { workspaceId: 'workspace', agentId: 'agent' },
      afterSeq: cursor,
      generation,
    })
    // The reply keeps streaming while the reconnect reads its catch-up.
    for (let index = 0; index < 5; index++) provider.push(`during-${index} `)
    await waitFor(() => second.frames().some((frame) => frame.type === 'synchronized'), 'the reconnect synchronizes')
    for (let index = 0; index < 3; index++) provider.push(`after-${index} `)
    provider.push(null)
    await sending
    await waitFor(
      () => second.frames().some((frame) => frame.event?.type === 'turn_completed'),
      'the rest of the turn arrives live',
    )
    stopWatching()

    const frames = second.frames()
    assert.equal(
      frames.some((frame) => frame.type === 'snapshot'),
      false,
      'a cursor the log can vouch for is not answered with a reset',
    )
    assert.equal(frames.find((frame) => frame.type === 'synchronized')?.generation, generation)
    const seqs = wireSeqs(frames)
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
      'in order',
    )
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicates')
    assert.ok(seqs[0] > cursor, 'nothing from before the cursor')
    const text = received(frames)
    const expected = ['missed', 'during', 'after']
      .flatMap((phase) => Array.from({ length: phase === 'after' ? 3 : 5 }, (_, index) => `${phase}-${index} `))
      .join('')
    assert.equal(text, expected, 'every missed and later delta exactly once')
    const transcript = await runtime.readTranscript(conversation, { all: true, closeOpenTurns: false })
    assert.ok(transcript.ok)
    assert.equal(seqs.at(-1), transcript.events.at(-1)!.seq, 'caught up to the end of the log')
    second.stream.close(1000, '')
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('remote always is refused before host execution, while a preset switch reaches the host', async () => {
  const socket = new Socket()
  const executed: unknown[] = []
  const audited: ConversationCommandAudit[] = []
  const gateway = host()
  gateway.command = async (_key, _device, _id, command) => {
    executed.push(command)
    return { ok: true }
  }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:operate'],
    host: gateway,
    onClosed: () => {},
    audit: (entry) => audited.push(entry),
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({
    type: 'command',
    commandId: 'c1',
    command: { kind: 'resolveApproval', requestId: 'r', decision: 'always' },
  })
  socket.receive({ type: 'command', commandId: 'c2', command: { kind: 'setPermissionPreset', preset: 'bypass' } })
  // Manual reaches the host as itself.
  socket.receive({ type: 'command', commandId: 'c3', command: { kind: 'setPermissionPreset', preset: 'manual' } })
  await waitFor(() => executed.length === 2, 'both switches reach the host')
  assert.deepEqual(executed, [
    { kind: 'setPermissionPreset', preset: 'bypass' },
    { kind: 'setPermissionPreset', preset: 'manual' },
  ])
  const results = (socket.output() as Frame[])
    .filter((frame) => frame.type === 'commandResult')
    .map((frame) => [(frame as { commandId?: string }).commandId, frame.code])
  assert.deepEqual(results[0], ['c1', 'unsafe_remote_decision'])
  assert.deepEqual(
    audited.map((entry) => [entry.tool, entry.commandId, entry.ok, entry.code]),
    [
      ['conversation.resolveApproval', 'c1', false, 'unsafe_remote_decision'],
      ['conversation.setPermissionPreset', 'c2', true, undefined],
      ['conversation.setPermissionPreset', 'c3', true, undefined],
    ],
  )
  stream.close(1000, '')
})

test('hello names the protocol and the conversation capabilities, and the full contract’s commands reach the host', async () => {
  const socket = new Socket()
  const executed: unknown[] = []
  const audited: ConversationCommandAudit[] = []
  const gateway = host()
  gateway.command = async (_key, _device, _id, command) => {
    executed.push(command)
    return { ok: true }
  }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:operate'],
    host: gateway,
    capabilities: ['events', 'upload', 'conversations', 'conversation-plans', 'conversation-hello'],
    onClosed: () => {},
    audit: (entry) => audited.push(entry),
  })
  socket.receive({ type: 'hello', requestId: 'h-1', protocolVersion: 1 })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({
    type: 'command',
    commandId: 'c1',
    command: { kind: 'resolvePlan', requestId: 'r', decision: 'reject' },
  })
  socket.receive({
    type: 'command',
    commandId: 'c2',
    command: { kind: 'setPermissionPreset', preset: 'auto', permissionMode: 'acceptEdits' },
  })
  socket.receive({
    type: 'command',
    commandId: 'c3',
    command: { kind: 'resolvePlan', requestId: 'r', decision: 'once' },
  })
  await waitFor(() => executed.length === 2, 'both commands reach the host')
  assert.deepEqual(executed, [
    { kind: 'resolvePlan', requestId: 'r', decision: 'reject' },
    { kind: 'setPermissionPreset', preset: 'auto', permissionMode: 'acceptEdits' },
  ])
  const output = socket.output() as Frame[]
  // Only the conversation capabilities, and nothing about the transport.
  assert.deepEqual(
    output.find((frame) => frame.type === 'result' && (frame as { requestId?: string }).requestId === 'h-1'),
    {
      type: 'result',
      requestId: 'h-1',
      ok: true,
      data: {
        protocolVersion: 1,
        minProtocolVersion: 1,
        capabilities: ['conversations', 'conversation-plans', 'conversation-hello'],
      },
    },
  )
  // A plan answer in the wrong vocabulary is a bad frame, settled under its id and audited.
  const refused = output.find(
    (frame) => frame.type === 'commandResult' && (frame as { commandId?: string }).commandId === 'c3',
  )
  assert.equal(refused?.code, 'invalid_frame')
  assert.deepEqual(
    audited.map((entry) => [entry.tool, entry.commandId, entry.ok]),
    [
      ['conversation.resolvePlan', 'c3', false],
      ['conversation.resolvePlan', 'c1', true],
      ['conversation.setPermissionPreset', 'c2', true],
    ],
  )
  stream.close(1000, '')
})

test("a model switch needs operate, and reaches the client with the host's own refusal code or notice, audited", async () => {
  const run = async (scopes: TailnetScope[]) => {
    const socket = new Socket()
    const executed: unknown[] = []
    const audited: ConversationCommandAudit[] = []
    const gateway = host()
    gateway.command = async (_key, _device, _id, command) => {
      executed.push(command)
      if (command.kind === 'setModel' && command.modelId === 'other')
        return { ok: false, code: 'unsupported_model', message: 'Mock CLI does not offer that model.' }
      return { ok: true, notice: 'The new model starts with your next message.' }
    }
    const stream = createTailnetConversationStream({
      socket,
      deviceId: 'device',
      deviceName: 'phone',
      scopes,
      host: gateway,
      onClosed: () => {},
      audit: (entry) => audited.push(entry),
    })
    socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
    await tick()
    socket.receive({ type: 'command', commandId: 'm1', command: { kind: 'setModel', modelId: 'large' } })
    socket.receive({ type: 'command', commandId: 'm2', command: { kind: 'setModel', modelId: 'other' } })
    const settled = () =>
      (socket.output() as Array<Frame & { commandId?: string; notice?: string; ok?: boolean }>)
        .filter((frame) => frame.type === 'commandResult')
        .map((frame) => [frame.commandId, frame.ok, frame.code, frame.notice])
    await waitFor(() => audited.length === 2 && settled().length === 2, 'both switches settle')
    const results = settled()
    stream.close(1000, '')
    return { executed, audited, results }
  }

  // Read alone may follow the chat but not change its model.
  const reader = await run(['conversation:read'])
  assert.deepEqual(reader.executed, [])
  assert.deepEqual(reader.results, [
    ['m1', false, 'conversation_operate_required', undefined],
    ['m2', false, 'conversation_operate_required', undefined],
  ])
  assert.deepEqual(
    reader.audited.map((entry) => [entry.tool, entry.commandId, entry.ok, entry.code]),
    [
      ['conversation.setModel', 'm1', false, 'conversation_operate_required'],
      ['conversation.setModel', 'm2', false, 'conversation_operate_required'],
    ],
  )

  const operator = await run(['conversation:operate'])
  assert.deepEqual(operator.executed, [
    { kind: 'setModel', modelId: 'large' },
    { kind: 'setModel', modelId: 'other' },
  ])
  assert.deepEqual(operator.results, [
    ['m1', true, undefined, 'The new model starts with your next message.'],
    ['m2', false, 'unsupported_model', undefined],
  ])
  assert.deepEqual(
    operator.audited.map((entry) => [entry.tool, entry.commandId, entry.ok, entry.code]),
    [
      ['conversation.setModel', 'm1', true, undefined],
      ['conversation.setModel', 'm2', false, 'unsupported_model'],
    ],
  )
})

test("a revert's files reach the client on its result, accepted or refused", async () => {
  const socket = new Socket()
  const gateway = host()
  gateway.command = async (_key, _device, _id, command) =>
    command.kind === 'revert' && command.confirmed
      ? { ok: false, message: 'The files to restore changed since they were shown.', data: { changed: true } }
      : {
          ok: true,
          data: {
            files: [{ path: 'src/app.ts', status: 'modified', addedLines: 1, removedLines: 2, binary: false }],
            reverted: false,
          },
        }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:operate'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'command', commandId: 'r1', command: { kind: 'revert', turnSeq: 3 } })
  socket.receive({
    type: 'command',
    commandId: 'r2',
    command: { kind: 'revert', turnSeq: 3, confirmed: true, files: ['src/app.ts'] },
  })
  const settled = () =>
    (socket.output() as Array<Frame & { commandId?: string; ok?: boolean; data?: unknown }>)
      .filter((frame) => frame.type === 'commandResult')
      .map((frame) => [frame.commandId, frame.ok, frame.data])
  await waitFor(() => settled().length === 2, 'both reverts settle')
  assert.deepEqual(settled(), [
    [
      'r1',
      true,
      {
        files: [{ path: 'src/app.ts', status: 'modified', addedLines: 1, removedLines: 2, binary: false }],
        reverted: false,
      },
    ],
    ['r2', false, { changed: true }],
  ])
  stream.close(1000, '')
})

test('a message at the protocol limit is accepted and one over it is refused under its command id', async () => {
  const socket = new Socket()
  const sent: string[] = []
  const gateway = host()
  gateway.command = async (_key, _device, _id, command) => {
    if (command.kind === 'send') sent.push(command.message)
    return { ok: true }
  }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:operate'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  // Every unit escaped: the worst case a valid message can encode to.
  const longest = '\u0001'.repeat(CONVERSATION_MAX_MESSAGE_CHARS)
  socket.receive({ type: 'command', commandId: 'fits', command: { kind: 'send', message: longest } })
  socket.receive({ type: 'command', commandId: 'over', command: { kind: 'send', message: `${longest}x` } })
  // Past the frame cap entirely: skipped as it arrives, still answered.
  socket.receive({ type: 'command', commandId: 'huge', command: { kind: 'send', message: 'x'.repeat(2_000_000) } })
  socket.receive({ type: 'list', requestId: 'still-open' })
  await until(() => (socket.output() as Frame[]).some((frame) => frame.requestId === 'still-open'), 'socket answers')
  assert.equal(stream.isClosed(), false)
  assert.deepEqual(sent, [longest])
  const results = (socket.output() as Array<Frame & { commandId?: string; ok?: boolean }>).filter(
    (frame) => frame.type === 'commandResult',
  )
  assert.deepEqual(
    results.map((frame) => [frame.commandId, frame.ok, frame.code ?? null]),
    [
      ['over', false, 'too_large'],
      ['huge', false, 'too_large'],
      ['fits', true, null],
    ],
  )
  stream.close(1000, '')
})

test('a response too large for a remote device is refused as too_large and the socket stays open', async () => {
  const socket = new Socket()
  const gateway = host()
  gateway.getTurnDiff = async () => ({
    ok: true,
    diff: { files: [], submodulesExcluded: true },
    patch: 'z'.repeat(33 * 1024 * 1024),
  })
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'getTurnDiff', requestId: 'diff', turnSeq: 4 })
  await until(() => (socket.output() as Frame[]).some((frame) => frame.requestId === 'diff'), 'diff answered')
  const answer = (socket.output() as Array<Frame & { ok?: boolean }>).find((frame) => frame.requestId === 'diff')
  assert.equal(answer?.ok, false)
  assert.equal(answer?.code, 'too_large')
  assert.equal(stream.isClosed(), false)
  stream.close(1000, '')
})

test('a subscription that cannot start says so under its key, and whether a retry can help', async () => {
  const socket = new Socket()
  const gateway = host()
  let commands = 0
  gateway.command = async () => {
    commands++
    return { ok: true }
  }
  gateway.subscribe = (_key, _cursor, listener) => {
    const ready = Promise.resolve().then(() => listener({ type: 'error', message: 'Conversation is being deleted.' }))
    return { dispose: () => {}, ready }
  }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:operate'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'missing' } })
  await tick()
  socket.receive({ type: 'command', commandId: 'after-failure', command: { kind: 'interrupt' } })
  await tick()
  const frames = socket.output() as Array<Frame & { key?: unknown; retryable?: boolean; commandId?: string }>
  const failures = frames.filter((frame) => frame.type === 'subscribeFailed')
  assert.deepEqual(
    failures.map((frame) => [frame.key, frame.code, frame.retryable, frame.retryAfterMs ?? null]),
    [
      [{ workspaceId: 'w', agentId: 'missing' }, 'not_found', false, null],
      [{ workspaceId: 'w', agentId: 'a' }, 'unavailable', true, 2_000],
    ],
  )
  assert.equal(commands, 0, 'no command lands on a conversation the socket never synchronized with')
  assert.equal(frames.at(-1)?.code, 'not_found')
  stream.close(1000, '')
})

test('a command after a subscription that could not start does not land on the conversation followed before', async () => {
  const socket = new Socket()
  const gateway = host()
  const commanded: string[] = []
  gateway.command = async (key) => {
    commanded.push(key.agentId)
    return { ok: true }
  }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:operate'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'command', commandId: 'on-a', command: { kind: 'interrupt' } })
  await tick()
  // The phone moves to a chat that is not here, then sends at once.
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'missing' } })
  socket.receive({ type: 'command', commandId: 'meant-for-missing', command: { kind: 'interrupt' } })
  await tick()
  assert.deepEqual(commanded, ['a'])
  const result = (socket.output() as Array<Frame & { commandId?: string }>).find(
    (frame) => frame.commandId === 'meant-for-missing',
  )
  assert.equal(result?.code, 'not_found')
  stream.close(1000, '')
})

test('a large escaped tool detail is paced and reassembles without a resync close', async () => {
  const socket = new Socket()
  socket.delayMs = 1
  const gateway = host()
  const detail = '😀"\n'.repeat(1_100_000)
  gateway.getToolDetail = async () => ({
    ok: true,
    detail: { input: null, output: detail, status: 'ok', clipped: false },
  })
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'getToolDetail', requestId: 'detail-1', toolUseId: 'tool-1' })
  const started = Date.now()
  while (
    !socket
      .output()
      .some(
        (frame) =>
          (frame as { type: string; index?: number; total?: number }).type === 'chunk' &&
          (frame as { index?: number; total?: number }).index === (frame as { total?: number }).total! - 1,
      )
  ) {
    assert.ok(Date.now() - started < 5_000, 'paced detail completes without stalling')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  const chunks = socket
    .output()
    .filter(
      (frame): frame is { type: 'chunk'; index: number; total: number; json: string } =>
        (frame as { type: string }).type === 'chunk',
    )
  assert.ok(chunks.length > 64, 'detail requires more chunks than the bounded pending-frame queue')
  assert.equal(stream.isClosed(), false)
  const reassembled = JSON.parse(
    chunks
      .sort((a, b) => a.index - b.index)
      .map((chunk) => chunk.json)
      .join(''),
  ) as { data: { detail: { output: string } } }
  assert.equal(reassembled.data.detail.output, detail)
  stream.close(1000, '')
})

test('a busy turn during a large catch-up is queued behind it, not resynced before the fence', async () => {
  const { socket, stream, emit } = await joinedSocket()
  socket.delayMs = 1
  const events = Array.from({ length: 200 }, (_, index) =>
    wireEvent(index + 1, 'tool_output', { toolUseId: `t${index}`, preview: 'x'.repeat(20_000) }),
  )
  emit({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: 1 }, generation: 'g' })
  emit({ type: 'synchronized', seq: 200, generation: 'g' })
  // More than the live bound of frames that cannot merge, all while the
  // snapshot is still being paced out.
  for (let seq = 201; seq <= 600; seq++)
    emit({ type: 'event', event: wireEvent(seq, 'tool_started', { toolUseId: `live-${seq}` }) })
  await until(() => assemble(socket.output()).some((frame) => frame.event?.seq === 600), 'every live frame drains')
  assert.equal(stream.isClosed(), false, 'no resync while the replay was still going out')
  const frames = assemble(socket.output())
  assert.equal(
    frames.some((frame) => frame.type === 'error'),
    false,
  )
  const fence = frames.findIndex((frame) => frame.type === 'synchronized')
  assert.deepEqual(
    frames.slice(fence + 1).map((frame) => frame.event?.seq),
    Array.from({ length: 400 }, (_, index) => 201 + index),
  )
  stream.close(1000, '')
})

test('switching conversations mid-replay stops the old replay and names the conversation on every fence', async () => {
  const socket = new Socket()
  socket.delayMs = 1
  const listeners = new Map<string, (frame: ConversationSessionFrame) => void>()
  const gateway: ConversationGatewayHost = {
    ...host(),
    resolveKey: (workspaceId, agentId) => ({ workspaceRoot: '/workspace', workspaceId, agentId }),
    subscribe: (subscribed, _cursor, receive) => {
      listeners.set(subscribed.agentId, receive)
      return { ready: Promise.resolve(), dispose: () => {} }
    },
  }
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'phone',
    scopes: ['conversation:read'],
    host: gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'first' } })
  await tick()
  const large = Array.from({ length: 200 }, (_, index) =>
    wireEvent(index + 1, 'tool_output', { toolUseId: `t${index}`, preview: 'x'.repeat(20_000) }),
  )
  listeners.get('first')!({
    type: 'snapshot',
    page: { events: large, hasMore: false, beforeCursor: 1 },
    generation: 'g1',
  })
  listeners.get('first')!({ type: 'synchronized', seq: 200, generation: 'g1' })
  await until(() => assemble(socket.output()).some((frame) => frame.type === 'snapshot'), 'the first replay starts')
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'second' } })
  await tick()
  listeners.get('second')!({
    type: 'snapshot',
    page: { events: [], hasMore: false, beforeCursor: null },
    generation: 'g2',
  })
  listeners.get('second')!({ type: 'synchronized', seq: 7, generation: 'g2' })
  await until(
    () => assemble(socket.output()).some((frame) => frame.type === 'synchronized'),
    'the second replay finishes',
  )
  const frames = assemble(socket.output()) as Array<Frame & { key?: { agentId: string }; generation?: string }>
  const fences = frames.filter((frame) => frame.type === 'synchronized')
  assert.deepEqual(
    fences.map((frame) => [frame.key?.agentId, frame.generation]),
    [['second', 'g2']],
    'the replaced conversation never sends its fence, so no client can take its cursor',
  )
  const firstParts = frames.filter((frame) => frame.type === 'snapshot' && frame.key?.agentId === 'first')
  assert.ok(firstParts.length > 0 && firstParts.length < firstParts[0].part!.total, 'the old snapshot stopped part way')
  assert.ok(
    frames.filter((frame) => frame.type === 'snapshot').every((frame) => frame.key !== undefined),
    'every snapshot names its conversation',
  )
  stream.close(1000, '')
})

/** A host holding messages for its chats, which a test changes. */
function holdingHost() {
  const gateway = host()
  const watchers = new Set<{ chat: string; listener: (messages: unknown[]) => void }>()
  const lists = new Map<string, unknown[]>()
  gateway.watchQueued = (chat, listener) => {
    const watcher = { chat: `${chat.workspaceId}/${chat.agentId}`, listener: listener as (messages: unknown[]) => void }
    watchers.add(watcher)
    watcher.listener(lists.get(watcher.chat) ?? [])
    return () => watchers.delete(watcher)
  }
  return {
    gateway,
    watchers,
    set(chat: string, messages: unknown[]) {
      lists.set(chat, messages)
      for (const watcher of watchers) if (watcher.chat === chat) watcher.listener(messages)
    },
  }
}

test('a client that asks is told what the desktop holds for the chat it follows, now and on each change', async () => {
  const socket = new Socket()
  const holding = holdingHost()
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'laptop',
    scopes: ['conversation:operate'],
    host: holding.gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  const held = { id: 'sm-1', text: 'Then the docs.', createdAt: 1_700_000_000_000 }
  holding.set('w/a', [held])
  assert.equal(
    (socket.output() as Frame[]).some((frame) => frame.type === 'queued'),
    false,
    'nothing is said to a client that did not ask: an older one does not know the frame',
  )
  socket.receive({ type: 'watchQueued', requestId: 'queued-1' })
  await waitFor(() => (socket.output() as Frame[]).some((frame) => frame.type === 'queued'), 'told once it asks')
  holding.set('w/a', [])
  await tick()
  const output = socket.output() as Array<Frame & { key?: unknown; messages?: unknown[] }>
  assert.deepEqual(
    output.find((frame) => frame.type === 'result' && frame.requestId === 'queued-1'),
    { type: 'result', requestId: 'queued-1', ok: true, data: { ok: true } },
  )
  assert.deepEqual(
    output.filter((frame) => frame.type === 'queued'),
    [
      { type: 'queued', key: { workspaceId: 'w', agentId: 'a' }, messages: [held] },
      { type: 'queued', key: { workspaceId: 'w', agentId: 'a' }, messages: [] },
    ],
  )
  // Asked again after a fence, the watch begins afresh rather than doubling.
  socket.receive({ type: 'watchQueued', requestId: 'queued-2' })
  await waitFor(() => holding.watchers.size === 1, 'one watch')
  stream.close(1000, '')
  assert.equal(holding.watchers.size, 0, 'the watch ends with the socket')
})

test('the watch ends when the socket follows another chat, and a host that holds nothing refuses it', async () => {
  const socket = new Socket()
  const holding = holdingHost()
  const resolveKey = holding.gateway.resolveKey
  holding.gateway.resolveKey = (workspaceId, agentId) =>
    workspaceId === 'w' && agentId === 'b' ? { ...key, agentId: 'b' } : resolveKey(workspaceId, agentId)
  const stream = createTailnetConversationStream({
    socket,
    deviceId: 'device',
    deviceName: 'laptop',
    scopes: ['conversation:read'],
    host: holding.gateway,
    onClosed: () => {},
    audit: () => {},
  })
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  socket.receive({ type: 'watchQueued', requestId: 'queued-1' })
  await waitFor(() => holding.watchers.size === 1, 'a read grant may watch')
  socket.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'b' } })
  await waitFor(() => holding.watchers.size === 0, 'moving to another chat ends the watch')
  stream.close(1000, '')

  const plain = new Socket()
  const other = createTailnetConversationStream({
    socket: plain,
    deviceId: 'device',
    deviceName: 'laptop',
    scopes: ['conversation:read'],
    host: host(),
    onClosed: () => {},
    audit: () => {},
  })
  plain.receive({ type: 'subscribe', key: { workspaceId: 'w', agentId: 'a' } })
  await tick()
  plain.receive({ type: 'watchQueued', requestId: 'queued-1' })
  await waitFor(
    () => (plain.output() as Frame[]).some((frame) => frame.type === 'result' && frame.requestId === 'queued-1'),
    'answered under its id',
  )
  const answer = (plain.output() as Array<Frame & { ok?: boolean }>).find(
    (frame) => frame.type === 'result' && frame.requestId === 'queued-1',
  )
  assert.equal(answer?.ok, false)
  other.close(1000, '')
})
