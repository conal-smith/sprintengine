import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentLaunchRecord } from '../../shared/agent-launch'
import type { TerminalSessionSnapshot } from '../../shared/electron-api'
import type { McpConnectionMetadata, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import { readTerminalOutputTail } from '../terminal-output-tail'
import { TerminalReplayBuffer } from '../terminal-replay-buffer'
import { createAutomationTools, type AutomationBackends } from './automation-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { localOnlyGatewayToolReason, requiredScopeForTool } from './tailnet/tailnet-scopes'

// `terminal.read` against the real tail reader over real replay buffers: only
// the runtime's session map and its list are stood in for.

type Held = { output: TerminalReplayBuffer; replaySnapshot?: string }

function snapshot(sessionId: string, overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot {
  return {
    sessionId,
    kind: 'terminal',
    workspaceId: 'ws-1',
    processAlive: true,
    suspended: false,
    visible: true,
    startedAt: 1,
    lastOutputAt: 1,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'working', since: 1 },
    // Started by the calling agent's chat: the only terminals it may read.
    agentRecord: { launchedBy: { workspaceId: 'ws-1', agentId: 'agent-1' } },
    ...overrides,
  } as TerminalSessionSnapshot
}

const AGENT_1: McpConnectionMetadata = { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1' }

function harness(options: { listed?: TerminalSessionSnapshot[]; held?: Record<string, Held> } = {}) {
  const held = new Map(Object.entries(options.held ?? {}))
  const reads: string[] = []
  const backends = {
    listTerminalSessions: () => options.listed ?? [],
    getWorkspaceSyncSnapshot: () => ({ state: { workspaces: [], workspaceWindows: [] } }),
    readRepositoryIdentity: async () => null,
    readTerminalOutputTail: (sessionId: string, read: { maxBytes: number; since?: string }) => {
      reads.push(sessionId)
      const session = held.get(sessionId)
      return session ? readTerminalOutputTail(session, read) : undefined
    },
  } as unknown as AutomationBackends
  const tools = createAutomationTools(backends)
  const terminalRead = tools.find((registration) => registration.name === 'terminal.read') as McpToolRegistration
  const terminalList = tools.find((registration) => registration.name === 'terminal.list') as McpToolRegistration
  return {
    read: (args: Record<string, unknown>) => terminalRead.handler(args, { metadata: AGENT_1 }),
    readAs: (metadata: McpConnectionMetadata, args: Record<string, unknown>) =>
      terminalRead.handler(args, { metadata }),
    listAs: async (metadata: McpConnectionMetadata) =>
      (
        (await terminalList.handler({}, { metadata })).structuredContent as { terminals: Array<{ sessionId: string }> }
      ).terminals.map((terminal) => terminal.sessionId),
    reads,
    held,
  }
}

/** The cursor a read of `output` hands out at `units`. */
function cursorOf(output: TerminalReplayBuffer, units: number): string {
  return `${output.generation}:${units}`
}

function bufferOf(...chunks: string[]): TerminalReplayBuffer {
  const output = new TerminalReplayBuffer()
  for (const chunk of chunks) output.append(chunk, 4 * 1024 * 1024)
  return output
}

function answer(result: McpToolResult): Record<string, unknown> {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent))
  return result.structuredContent as Record<string, unknown>
}

function errorCode(result: McpToolResult): string {
  assert.equal(result.isError, true)
  return (result.structuredContent as { error: { code: string } }).error.code
}

test('a dev server terminal reads back as plain text with its status', async () => {
  const output = bufferOf('> vite\r\n', '\x1b[32mready\x1b[39m in 300 ms\r\n')
  const { read } = harness({ listed: [snapshot('term-1', { agentName: undefined })], held: { 'term-1': { output } } })
  const result = answer(await read({ sessionId: 'term-1' }))
  assert.deepEqual(result, {
    sessionId: 'term-1',
    kind: 'terminal',
    workspaceId: 'ws-1',
    agentName: null,
    state: 'running',
    exitCode: null,
    text: '> vite\nready in 300 ms',
    lineCount: 2,
    truncated: false,
    cursor: cursorOf(output, '> vite\r\n\x1b[32mready\x1b[39m in 300 ms\r\n'.length),
  })
})

test('escape sequences never reach the caller', async () => {
  const { read } = harness({
    listed: [snapshot('term-1')],
    held: {
      'term-1': {
        output: bufferOf('\x1b]0;title\x07\x1b[?25l\x1b[1;31mError:\x1b[0m boom\x1b[K\r\n\x1b[?25h'),
      },
    },
  })
  const text = answer(await read({ sessionId: 'term-1' })).text as string
  assert.equal(text, 'Error: boom')
  assert.doesNotMatch(text, /\x1b|\[\d/u)
})

test('only the newest lines come back by default, marked truncated', async () => {
  const log = Array.from({ length: 500 }, (_, index) => `request ${index}`).join('\n')
  const { read } = harness({ listed: [snapshot('term-1')], held: { 'term-1': { output: bufferOf(log) } } })
  const result = answer(await read({ sessionId: 'term-1' }))
  assert.equal(result.lineCount, 200)
  assert.equal(result.truncated, true)
  assert.ok((result.text as string).endsWith('request 499'))
  assert.ok((result.text as string).startsWith('request 300\n'))
})

test('"lines" narrows the read', async () => {
  const { read } = harness({
    listed: [snapshot('term-1')],
    held: { 'term-1': { output: bufferOf('a\nb\nc\nd\n') } },
  })
  const result = answer(await read({ sessionId: 'term-1', lines: 2 }))
  assert.equal(result.text, 'c\nd')
  assert.equal(result.truncated, true)
})

test('a scrollback far larger than the read is cut to a bounded answer', async () => {
  const line = `${'z'.repeat(99)}\n`
  const { read } = harness({
    listed: [snapshot('term-1')],
    held: { 'term-1': { output: bufferOf(line.repeat(30_000)) } },
  })
  const result = answer(await read({ sessionId: 'term-1', lines: 2_000 }))
  assert.equal(result.truncated, true)
  assert.ok((result.text as string).length <= 64 * 1024)
  assert.match(result.text as string, /^z{99}\n/u, 'it starts at a whole line')
})

test('the cursor makes the next read only what the terminal printed since', async () => {
  const output = bufferOf('compiled\n')
  const { read } = harness({ listed: [snapshot('term-1')], held: { 'term-1': { output } } })
  const first = answer(await read({ sessionId: 'term-1' }))
  assert.equal(first.text, 'compiled')

  const quiet = answer(await read({ sessionId: 'term-1', since: first.cursor }))
  assert.equal(quiet.text, '')
  assert.equal(quiet.lineCount, 0)
  assert.equal(quiet.cursor, first.cursor)

  output.append('\x1b[31merror\x1b[0m TS2304: Cannot find name "foo"\n', 4 * 1024 * 1024)
  const next = answer(await read({ sessionId: 'term-1', since: first.cursor }))
  assert.equal(next.text, 'error TS2304: Cannot find name "foo"')
  assert.equal(next.truncated, false)
  assert.equal(next.cursor, cursorOf(output, output.appendedUnits))
})

test('a cursor from before the session was resumed reads the new stream from its start, marked truncated', async () => {
  const { read, held } = harness({
    listed: [snapshot('agent-1', { kind: 'agent' })],
    held: { 'agent-1': { output: bufferOf('before the pause\n') } },
  })
  const before = answer(await read({ sessionId: 'agent-1' }))
  // Resumed under the same id: a fresh buffer, its count started again.
  held.set('agent-1', { output: bufferOf('after\n', 'the resume\n') })
  const after = answer(await read({ sessionId: 'agent-1', since: before.cursor }))
  assert.equal(after.text, 'after\nthe resume')
  assert.equal(after.truncated, true)
  assert.notEqual(after.cursor, before.cursor)
})

test('an exited terminal still reads, and says how it ended', async () => {
  const { read } = harness({
    listed: [snapshot('term-1', { processAlive: false, activity: { kind: 'exited', at: 5, exitCode: 1 } })],
    held: { 'term-1': { output: bufferOf('npm ERR! missing script: dev\n') } },
  })
  const result = answer(await read({ sessionId: 'term-1' }))
  assert.equal(result.state, 'exited')
  assert.equal(result.exitCode, 1)
  assert.equal(result.text, 'npm ERR! missing script: dev')
})

test('a paused agent reads its last screen and is not reported as ended', async () => {
  const output = bufferOf('raw\n')
  output.clear()
  const { read } = harness({
    listed: [
      snapshot('agent-1', {
        kind: 'agent',
        agentName: 'Ada',
        processAlive: false,
        suspended: true,
        activity: { kind: 'idle', since: 3 },
      }),
    ],
    held: { 'agent-1': { output, replaySnapshot: '\x1b[1mAll tests pass.\x1b[0m\r\n' } },
  })
  const result = answer(await read({ sessionId: 'agent-1' }))
  assert.equal(result.state, 'paused')
  assert.equal(result.exitCode, null)
  assert.equal(result.agentName, 'Ada')
  assert.equal(result.text, 'All tests pass.')
})

test('an unknown session id is refused by name', async () => {
  const { read, reads } = harness({ listed: [snapshot('term-1')], held: { 'term-1': { output: bufferOf('x') } } })
  const result = await read({ sessionId: 'nope' })
  assert.equal(errorCode(result), 'unknown_terminal')
  assert.match((result.structuredContent as { error: { message: string } }).error.message, /terminal\.list/u)
  assert.deepEqual(reads, [], 'the runtime is not asked about a session the list does not show')
})

test('a session terminal.list does not show is not read, even when the runtime holds it', async () => {
  const { read, reads } = harness({ listed: [], held: { hidden: { output: bufferOf('secret\n') } } })
  assert.equal(errorCode(await read({ sessionId: 'hidden' })), 'unknown_terminal')
  assert.deepEqual(reads, [])
})

test('a session that closes between the list and the read is refused, not read as empty', async () => {
  const { read } = harness({ listed: [snapshot('term-1')] })
  assert.equal(errorCode(await read({ sessionId: 'term-1' })), 'unknown_terminal')
})

test('bad arguments are refused before anything is read', async () => {
  const { read, reads } = harness({ listed: [snapshot('term-1')], held: { 'term-1': { output: bufferOf('x') } } })
  assert.equal(errorCode(await read({})), 'invalid_arguments')
  assert.equal(errorCode(await read({ sessionId: 'term-1', lines: 0 })), 'invalid_arguments')
  assert.equal(errorCode(await read({ sessionId: 'term-1', lines: 2_001 })), 'invalid_arguments')
  assert.equal(errorCode(await read({ sessionId: 'term-1', lines: 2.5 })), 'invalid_arguments')
  assert.equal(errorCode(await read({ sessionId: 'term-1', since: 10 })), 'invalid_arguments')
  assert.equal(errorCode(await read({ sessionId: 'term-1', since: '' })), 'invalid_arguments')
  assert.deepEqual(reads, [])
})

test('a gateway with no terminal runtime says so', async () => {
  const tools = createAutomationTools({
    listTerminalSessions: () => [snapshot('term-1')],
  } as unknown as AutomationBackends)
  const terminalRead = tools.find((registration) => registration.name === 'terminal.read') as McpToolRegistration
  assert.equal(
    errorCode(
      await terminalRead.handler(
        { sessionId: 'term-1' },
        { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1' } },
      ),
    ),
    'unavailable',
  )
})

test('a paired device is refused it whatever its grant, and it would need only a read scope', () => {
  assert.match(localOnlyGatewayToolReason('terminal.read') ?? '', /not served over the tailnet/u)
  assert.equal(isStudioGatewayMutation('terminal.read'), false)
  assert.equal(requiredScopeForTool('terminal.read', isStudioGatewayMutation('terminal.read')), 'workspace:read')
})

test("an agent sees only the terminals it or its chat started, never the person's or another chat's", async () => {
  const output = { output: bufferOf('secret\n') }
  const listed = [
    snapshot('mine', { kind: 'agent', agentId: 'agent-1', agentRecord: undefined }),
    snapshot('launched', { kind: 'agent', workspaceId: 'ws-9', agentId: 'agent-7' }),
    snapshot('shell', { agentRecord: undefined }),
    snapshot('person-agent', { kind: 'agent', agentId: 'agent-2', agentRecord: undefined }),
    snapshot('other-chat', {
      kind: 'agent',
      workspaceId: 'ws-2',
      agentId: 'agent-3',
      agentRecord: { launchedBy: { workspaceId: 'ws-2', agentId: 'agent-4' } } as AgentLaunchRecord,
    }),
  ] as TerminalSessionSnapshot[]
  const held = Object.fromEntries(listed.map((session) => [session.sessionId, output]))
  const { readAs, listAs, reads } = harness({ listed, held })

  assert.deepEqual(await listAs(AGENT_1), ['mine', 'launched'])
  assert.equal(answer(await readAs(AGENT_1, { sessionId: 'mine' })).text, 'secret')
  assert.equal(answer(await readAs(AGENT_1, { sessionId: 'launched' })).text, 'secret')
  // Another agent of the same chat sees what the chat launched, not agent-1's own terminal.
  const sibling: McpConnectionMetadata = { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-5' }
  assert.deepEqual(await listAs(sibling), ['launched'])
  reads.length = 0
  for (const sessionId of ['shell', 'person-agent', 'other-chat']) {
    const refused = await readAs(AGENT_1, { sessionId })
    assert.equal(errorCode(refused), 'terminal_not_yours', sessionId)
    assert.match(refused.content[0]?.type === 'text' ? refused.content[0].text : '', /not started by this agent/u)
  }
  // A caller with no identity of this app's gets nothing.
  for (const metadata of [{ kind: 'external-local' }, { kind: 'studio-agent' }] as McpConnectionMetadata[]) {
    assert.deepEqual(await listAs(metadata), [])
    assert.equal(errorCode(await readAs(metadata, { sessionId: 'mine' })), 'terminal_not_yours')
  }
  assert.deepEqual(reads, [], 'no refused terminal was read')
})
