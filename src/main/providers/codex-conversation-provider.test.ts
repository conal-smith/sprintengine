import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, test, vi } from 'vitest'
import {
  CODEX_GOAL_TURN_WAIT_MS,
  CODEX_INTERRUPT_GRACE_MS,
  createCodexConversationProvider,
  codexPermissionPolicy,
  codexChildEnv,
  codexMcpServerArgs,
  probeCodexConversationCommands,
  type CodexConversationProviderOptions,
} from './codex-conversation-provider'
import { CodexRpcError, createCodexRpcTransport, type CodexRpcOptions, type RpcMessage } from './codex-json-rpc'
import type {
  ConversationEvent,
  ConversationMcpServer,
  ConversationPermissionPreset,
} from '../../shared/conversation-runtime'
import { resolveGatewayLaunchToken } from '../../server/core/gateway-launch-tokens'
import { conversationCommandsFor } from '../conversation-commands/registry'
import { onUsageLimitHit, usageLimitsStore, usageRateLimit } from '../usage-limits/store'
import type { UsageLimitHit } from '../../shared/usage-limits'

function fixture(
  setup: {
    env?: NodeJS.ProcessEnv
    account?: unknown
    resume?: (params: unknown) => unknown
    unarchive?: (params: unknown) => unknown
    fork?: (params: unknown) => unknown
    // Codex refuses `turn/start` while this answers true.
    refuseTurn?: () => boolean
    skills?: unknown
    saveGeneratedImage?: (input: { sessionId: string; itemId: string; base64: string }) => Promise<string>
    // Codex accepts `turn/interrupt` but never sends the turn's `turn/completed`.
    silentInterrupt?: boolean
    resolveStudioMcpServer?: CodexConversationProviderOptions['resolveStudioMcpServer']
    // Codex never answers `initialize`.
    initializeTimesOut?: boolean
    // Codex exits before it answers `initialize`, with this error.
    initializeError?: string
    // The machine the chat's `codex` runs on, and the folder it runs in.
    platform?: NodeJS.Platform
    homeDir?: string
    workspaceRoot?: string
    readCodexLogBytes?: CodexConversationProviderOptions['readCodexLogBytes']
    // The answer to `account/rateLimits/read`.
    rateLimits?: () => unknown
    // The answer to `config/read`.
    configRead?: () => unknown
    // The answer to `thread/goal/set`, `get` and `clear`.
    goal?: (method: string, params: unknown) => unknown
  } = {},
) {
  let connection!: CodexRpcOptions
  const calls: { method: string; params: unknown }[] = []
  const replies: { id: string | number; result: unknown }[] = []
  let resolveStarted!: () => void
  let started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  const transports = { created: 0, closed: 0 }
  const adapter = createCodexConversationProvider({
    resolveExecutable: async () => '/usr/bin/codex',
    buildEnv: async () => setup.env ?? {},
    saveGeneratedImage: setup.saveGeneratedImage,
    ...(setup.resolveStudioMcpServer ? { resolveStudioMcpServer: setup.resolveStudioMcpServer } : {}),
    ...(setup.readCodexLogBytes ? { readCodexLogBytes: setup.readCodexLogBytes } : {}),
    ...(setup.platform ? { platform: setup.platform } : {}),
    ...(setup.homeDir ? { homeDir: setup.homeDir } : {}),
    createTransport(options) {
      connection = options
      transports.created++
      return {
        pid: 123,
        async request(method, params) {
          calls.push({ method, params })
          if (method === 'initialize' && setup.initializeTimesOut) throw new Error('Codex initialize timed out.')
          if (method === 'initialize' && setup.initializeError) throw new Error(setup.initializeError)
          if (method === 'account/read')
            return setup.account ?? { requiresOpenaiAuth: true, account: { type: 'chatgpt' } }
          if (method === 'thread/resume' && setup.resume) return setup.resume(params)
          if (method === 'thread/unarchive' && setup.unarchive) return setup.unarchive(params)
          if (method === 'thread/fork') return setup.fork ? setup.fork(params) : { thread: { id: 'forked-thread' } }
          if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'native-thread' } }
          if (method === 'turn/start') {
            resolveStarted()
            if (setup.refuseTurn?.()) throw new CodexRpcError('The turn could not be started.')
            return { turn: { id: 'native-turn' } }
          }
          if (method === 'skills/list') return setup.skills ?? { data: [] }
          if (method === 'account/rateLimits/read' && setup.rateLimits) return setup.rateLimits()
          if (method === 'config/read' && setup.configRead) return setup.configRead()
          if (method === 'thread/compact/start') {
            resolveStarted()
            return {}
          }
          if (method.startsWith('thread/goal/')) {
            if (method === 'thread/goal/set') resolveStarted()
            return setup.goal ? setup.goal(method, params) : method === 'thread/goal/get' ? { goal: null } : {}
          }
          if (method === 'turn/interrupt' && !setup.silentInterrupt)
            await options.onMessage({
              method: 'turn/completed',
              params: { threadId: 'native-thread', turn: { status: 'interrupted' } },
            })
          return {}
        },
        notify: (method, params) => calls.push({ method, params }),
        respond: (id, result) => replies.push({ id, result }),
        reject: (id, message) => replies.push({ id, result: { error: message } }),
        close() {
          transports.closed++
        },
      }
    },
  })
  const input = {
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'codex-agent',
    modelId: 'gpt-6-sol',
    workspaceRoot: setup.workspaceRoot ?? '/workspace/app',
    permissionPreset: 'none' as ConversationPermissionPreset,
  }
  const events: ConversationEvent[] = []
  // What reaches the chat outside a send: the turns Codex starts by itself.
  const sessionEvents: ConversationEvent[] = []
  Object.assign(input, { onSessionEvent: (event: ConversationEvent) => sessionEvents.push(event) })
  const send = async (reasoningEffort?: string, mode?: 'default' | 'ask' | 'plan', message = 'Make a change.') => {
    for await (const event of (await adapter.sendTurn({
      ...input,
      turnId: 'turn',
      requestId: 'request',
      message,
      reasoningEffort,
      mode,
    })) as AsyncIterable<ConversationEvent>)
      events.push(event)
  }
  const message = (value: RpcMessage) => connection.onMessage(value)
  return {
    adapter,
    input,
    events,
    sessionEvents,
    send,
    get started() {
      return started
    },
    // Re-arms `started` for a later turn.
    nextTurn() {
      started = new Promise<void>((resolve) => {
        resolveStarted = resolve
      })
    },
    transports,
    message,
    calls,
    replies,
    crash: () => connection.onClose(new Error('Child process exited.')),
    get connection() {
      return connection
    },
  }
}

test('command output streams only its new text and closes without repeating it', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  const item = { id: 'command', type: 'commandExecution', command: 'build' }
  await f.message({ method: 'item/started', params: { item } })
  const chunks = ['first-line\n', 'x'.repeat(1024 * 1024), '\nlast-line']
  for (const delta of chunks)
    await f.message({ method: 'item/commandExecution/outputDelta', params: { itemId: 'command', delta } })
  await f.message({ method: 'item/completed', params: { item: { ...item, status: 'completed', exitCode: 0 } } })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const outputs = f.events.filter((event) => event.type === 'tool_output').map((event) => event.payload!)
  expect(outputs.slice(0, 3).map((payload) => payload.output)).toEqual(chunks)
  expect(outputs.slice(0, 3).every((payload) => payload.outputMode === 'append' && payload.partial === true)).toBe(true)
  expect(outputs.at(-1)).toMatchObject({
    output: '',
    outputMode: 'append',
    totalBytes: Buffer.byteLength(chunks.join('')),
    exitCode: 0,
  })
  expect(outputs.at(-1)!.partial).toBeUndefined()
})

test('streams text and command output, preserves nonzero exit as an ordinary tool result', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send('high')
  await f.started
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({ effort: 'high' })
  await f.message({
    method: 'item/agentMessage/delta',
    params: { threadId: 'native-thread', itemId: 'text', delta: 'Hello' },
  })
  await f.message({ method: 'item/completed', params: { item: { id: 'text', type: 'agentMessage', text: 'Hello' } } })
  await f.message({
    method: 'item/started',
    params: { item: { id: 'command', type: 'commandExecution', command: 'rg missing', cwd: '/workspace/app' } },
  })
  await f.message({ method: 'item/commandExecution/outputDelta', params: { itemId: 'command', delta: 'No matches' } })
  await f.message({
    method: 'item/completed',
    params: {
      item: {
        id: 'command',
        type: 'commandExecution',
        command: 'rg missing',
        status: 'completed',
        exitCode: 1,
        aggregatedOutput: 'No matches',
      },
    },
  })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.events.filter((event) => event.type === 'content_delta')).toHaveLength(1)
  expect(f.events.filter((event) => event.type === 'tool_output').map((event) => event.payload)).toMatchObject([
    { partial: true },
    { status: 'ok', exitCode: 1 },
  ])
  // The subscription's limits are asked for as the app-server starts, and the
  // thread is started without waiting for the answer.
  expect(f.calls.map((call) => call.method).slice(0, 5)).toEqual([
    'initialize',
    'initialized',
    'account/read',
    'account/rateLimits/read',
    'thread/start',
  ])
  // `none` sends no override anywhere: Codex runs on its own configured default.
  for (const call of f.calls.filter((entry) => ['thread/start', 'turn/start'].includes(entry.method))) {
    expect(call.params).not.toHaveProperty('approvalPolicy')
    expect(call.params).not.toHaveProperty('approvalsReviewer')
    expect(call.params).not.toHaveProperty('sandbox')
    expect(call.params).not.toHaveProperty('sandboxPolicy')
  }
})

test('each message of a turn starts a paragraph, and a tool between them already separates them', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  const say = async (id: string, text: string, phase: string) => {
    await f.message({ method: 'item/started', params: { item: { id, type: 'agentMessage', text: '', phase } } })
    await f.message({ method: 'item/agentMessage/delta', params: { itemId: id, delta: text } })
    await f.message({ method: 'item/completed', params: { item: { id, type: 'agentMessage', text, phase } } })
  }
  await say('plan', 'I’ll check the branch.', 'commentary')
  await f.message({
    method: 'item/completed',
    params: { item: { id: 'retry', type: 'agentMessage', text: 'Retrying.' } },
  })
  const sleep = { id: 'sleep', type: 'sleep', durationMs: 10_000 }
  await f.message({ method: 'item/started', params: { item: sleep } })
  await f.message({ method: 'item/completed', params: { item: sleep } })
  await say('still', 'Still unavailable.', 'commentary')
  await say('answer', 'I couldn’t put up the PR.', 'final_answer')
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.events.filter((event) => event.type === 'content_delta').map((event) => event.payload!.text)).toEqual([
    'I’ll check the branch.',
    '\n\nRetrying.',
    'Still unavailable.',
    '\n\nI couldn’t put up the PR.',
  ])
  expect(f.events.find((event) => event.type === 'tool_started')?.payload).toMatchObject({
    toolUseId: 'sleep',
    name: 'Sleep',
    kind: 'other',
    input: { durationMs: 10_000 },
  })
})

test('an image Codex looks at is shown as a read of that file', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  const item = { id: 'view', type: 'imageView', path: '/workspace/app/shot.png' }
  await f.message({ method: 'item/started', params: { item } })
  await f.message({ method: 'item/completed', params: { item } })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.events.find((event) => event.type === 'tool_started')?.payload).toMatchObject({
    name: 'Read',
    kind: 'file_read',
    input: { path: '/workspace/app/shot.png' },
  })
})

test('command and patch approvals stay pending until individually answered', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({
    method: 'item/started',
    params: {
      item: { type: 'fileChange', id: 'patch', changes: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }] },
    },
  })
  await f.message({
    id: 21,
    method: 'item/commandExecution/requestApproval',
    params: { itemId: 'command', command: 'npm test' },
  })
  await f.message({ id: 'patch-approval', method: 'item/fileChange/requestApproval', params: { itemId: 'patch' } })
  expect(f.replies).toHaveLength(0)
  await f.adapter.resolveApproval({ ...f.input, turnId: 'turn', requestId: 'turn:patch-approval', approved: true })
  await f.adapter.resolveApproval({ ...f.input, turnId: 'turn', requestId: 'turn:21', approved: false })
  expect(f.replies).toEqual([
    { id: 'patch-approval', result: { decision: 'accept' } },
    { id: 21, result: { decision: 'decline' } },
  ])
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(
    f.events.find((event) => event.type === 'approval_requested' && event.payload?.action === 'Edit')?.payload?.input,
  ).toMatchObject({ edits: [{ path: 'src/a.ts', patch: expect.stringContaining('+new') }] })
})

test('a patch approval that arrives before its item waits for the diff', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({ id: 'early', method: 'item/fileChange/requestApproval', params: { itemId: 'patch' } })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.events.some((event) => event.type === 'approval_requested')).toBe(false)
  await f.message({
    method: 'item/started',
    params: {
      item: { type: 'fileChange', id: 'patch', changes: [{ path: 'src/b.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }] },
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const approval = f.events.find((event) => event.type === 'approval_requested')
  expect(approval?.payload?.input).toMatchObject({
    edits: [{ path: 'src/b.ts', patch: expect.stringContaining('+new') }],
  })
  await f.adapter.resolveApproval({ ...f.input, turnId: 'turn', requestId: 'turn:early', approved: true })
  expect(f.replies).toEqual([{ id: 'early', result: { decision: 'accept' } }])
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
})

test('interrupt uses native turn identity and ends the event stream', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/started', params: { turn: { id: 'native-turn' } } })
  await f.adapter.interrupt(f.input)
  await done
  expect(f.calls.find((call) => call.method === 'turn/interrupt')?.params).toEqual({
    threadId: 'native-thread',
    turnId: 'native-turn',
  })
  expect(f.events.at(-1)?.payload?.interrupted).toBe(true)
})

test('a stop settles only once Codex has ended the turn, after the last change it made', async () => {
  const f = fixture({ silentInterrupt: true })
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/started', params: { turn: { id: 'native-turn' } } })
  let stopped = false
  const stopping = Promise.resolve(f.adapter.interrupt(f.input)).then(() => {
    stopped = true
  })
  await vi.waitFor(() => expect(f.calls.some((call) => call.method === 'turn/interrupt')).toBe(true))
  // Codex has taken the stop but is still applying a patch.
  await f.message({
    method: 'item/completed',
    params: {
      threadId: 'native-thread',
      item: { type: 'fileChange', id: 'patch', changes: [{ path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }] },
    },
  })
  expect(stopped).toBe(false)
  await f.message({
    method: 'turn/completed',
    params: { threadId: 'native-thread', turn: { id: 'native-turn', status: 'interrupted' } },
  })
  await stopping
  await done
  const patchAt = f.events.findIndex((event) => event.type === 'tool_started' || event.type === 'tool_output')
  expect(patchAt).toBeGreaterThan(-1)
  expect(f.events.at(-1)).toMatchObject({ type: 'turn_completed', payload: { interrupted: true } })
})

test('a stopped turn Codex has not confirmed yet does not keep its process from being disposed', async () => {
  const f = fixture({ silentInterrupt: true })
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  const stopping = f.adapter.interrupt(f.input)
  await vi.waitFor(() => expect(f.calls.some((call) => call.method === 'turn/interrupt')).toBe(true))
  expect(f.adapter.listLiveSessions?.()[0]?.turnActive).toBe(true)
  expect(f.adapter.disposeChildProcess?.('session')).toBe(true)
  // Ending the process ends the turn, and with it the stop.
  await stopping
  await done
  expect(f.transports.closed).toBe(1)
  expect(f.events.at(-1)).toMatchObject({ type: 'turn_completed', payload: { interrupted: true } })
  expect(f.adapter.listLiveSessions?.()[0]).toMatchObject({ turnActive: false, hasChildProcess: false })
})

test('a running turn that was not stopped still keeps its process', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  expect(f.adapter.disposeChildProcess?.('session')).toBe(false)
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.adapter.disposeChildProcess?.('session')).toBe(true)
})

test('a stopped turn Codex never confirms is ended and the next message goes through', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture({ silentInterrupt: true })
    await f.adapter.startSession(f.input)
    const done = f.send()
    await vi.waitFor(() => expect(f.calls.some((call) => call.method === 'turn/start')).toBe(true))
    const stopping = f.adapter.interrupt(f.input)
    // Sent straight after the stop: it waits for the old turn rather than refusing.
    f.nextTurn()
    const next = f.send(undefined, undefined, 'Try again.')
    await vi.advanceTimersByTimeAsync(CODEX_INTERRUPT_GRACE_MS)
    await stopping
    await done
    expect(f.transports.closed).toBe(1)
    await vi.waitFor(() => expect(f.calls.filter((call) => call.method === 'turn/start')).toHaveLength(2))
    expect(f.transports.created).toBe(2)
    await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
    await next
    expect(f.events.filter((event) => event.type === 'turn_failed')).toEqual([])
    expect(f.calls.filter((call) => call.method === 'turn/interrupt')).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
})

test('resume uses a stored thread cursor and crash terminates a running turn', async () => {
  const f = fixture()
  await f.adapter.startSession({ ...f.input, resumeSessionId: 'previous-thread' })
  const done = f.send()
  await f.started
  f.crash()
  await done
  expect(f.calls.find((call) => call.method === 'thread/resume')?.params).toMatchObject({
    threadId: 'previous-thread',
    // Only the thread's id is read back, so its history is not asked for.
    excludeTurns: true,
  })
  expect(f.events.at(-1)?.type).toBe('turn_failed')
  expect(f.adapter.listLiveSessions?.()[0]?.hasChildProcess).toBe(false)
})

test('unowned threads and unknown server requests never get an implicit approval', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({
    id: 1,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'other-thread', command: 'danger' },
  })
  await f.message({ id: 2, method: 'item/permissions/requestApproval', params: {} })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.replies).toHaveLength(2)
  expect(f.replies.every((reply) => typeof (reply.result as { error: string }).error === 'string')).toBe(true)
  expect(f.events.some((event) => event.type === 'approval_requested')).toBe(false)
})

test('an MCP server asking consent raises a card the person must answer, and Allow sends its form defaults', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({
    id: 30,
    method: 'mcpServer/elicitation/request',
    params: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      serverName: 'codex_apps',
      message: 'Allow Codex to use Calendar?',
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: { scope: { type: 'string', default: 'read' }, note: { type: 'string' } },
        required: ['scope'],
      },
      _meta: { app_name: 'Calendar' },
    },
  })
  await f.message({
    id: 31,
    method: 'mcpServer/elicitation/request',
    params: { serverName: 'acme', message: 'Post to the acme channel?', mode: 'form', requestedSchema: {} },
  })
  expect(f.replies).toEqual([])
  await f.adapter.resolveApproval({ ...f.input, turnId: 'turn', requestId: 'turn:30', approved: true })
  await f.adapter.resolveApproval({ ...f.input, turnId: 'turn', requestId: 'turn:31', approved: false })
  expect(f.replies).toEqual([
    { id: 30, result: { action: 'accept', content: { scope: 'read' } } },
    { id: 31, result: { action: 'decline' } },
  ])
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const raised = f.events.filter((event) => event.type === 'approval_requested').map((event) => event.payload)
  expect(raised[0]).toMatchObject({
    requestId: 'turn:30',
    kind: 'tool',
    toolKind: 'mcp',
    action: 'Use Calendar',
    summary: 'Allow Codex to use Calendar?',
    mustAsk: true,
    suppressAlwaysAllowRule: true,
  })
  expect(raised[1]).toMatchObject({ requestId: 'turn:31', action: 'Use acme', summary: 'Post to the acme channel?' })
})

test('an MCP consent approving cannot answer is declined without a card', async () => {
  const f = fixture()
  await runTurn(f, [
    {
      id: 'url',
      method: 'mcpServer/elicitation/request',
      params: { serverName: 'acme', message: 'Sign in to acme', mode: 'url', url: 'https://example.com/auth' },
    },
    {
      id: 'form',
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'acme',
        message: 'Which project?',
        mode: 'form',
        requestedSchema: { properties: { project: { type: 'string' } }, required: ['project'] },
      },
    },
  ])
  expect(f.replies).toEqual([
    { id: 'url', result: { action: 'decline' } },
    { id: 'form', result: { action: 'decline' } },
  ])
  expect(payloads(f.events, 'approval_requested')).toEqual([])
})

test('a subagent’s MCP consent is asked in its parent’s chat', async () => {
  const f = fixture()
  const child = 'child-thread'
  const activity = {
    id: 'call_spawn',
    type: 'subAgentActivity',
    kind: 'started',
    agentThreadId: child,
    agentPath: '/root/pong',
  }
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({ method: 'item/started', params: { threadId: 'native-thread', item: activity } })
  await f.message({
    id: 40,
    method: 'mcpServer/elicitation/request',
    params: { threadId: child, serverName: 'acme', message: 'Read the acme wiki?', mode: 'form', requestedSchema: {} },
  })
  await f.adapter.resolveApproval({ ...f.input, turnId: 'turn', requestId: 'turn:40', approved: true })
  expect(f.replies).toEqual([{ id: 40, result: { action: 'accept', content: {} } }])
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(payloads(f.events, 'approval_requested')).toEqual([
    expect.objectContaining({ requestId: 'turn:40', summary: 'Read the acme wiki?' }),
  ])
})

test('bypass is YOLO, auto is the workspace sandbox with auto-review past it, manual asks in a read-only sandbox, none sends nothing', () => {
  expect(codexPermissionPolicy('bypass')).toEqual({
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'danger-full-access',
    sandboxPolicy: { type: 'dangerFullAccess' },
  })
  expect(codexPermissionPolicy('auto')).toMatchObject({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
  })
  expect(codexPermissionPolicy('manual')).toEqual({
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  })
  expect(codexPermissionPolicy('none')).toEqual({})
  expect(codexPermissionPolicy()).toEqual({})
  // Codex's own Default, at Auto: the same sandbox, with the person asked
  // before anything leaves it rather than the reviewer.
  expect(codexPermissionPolicy('auto', 'workspace')).toMatchObject({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'workspaceWrite' },
  })
  expect(codexPermissionPolicy('manual', 'workspace')).toMatchObject({ approvalPolicy: 'untrusted' })
})

test('each preset rides thread start and every turn', async () => {
  for (const [permissionPreset, approvalPolicy, approvalsReviewer, sandbox, type] of [
    ['auto', 'on-request', 'auto_review', 'workspace-write', 'workspaceWrite'],
    ['manual', 'untrusted', 'user', 'read-only', 'readOnly'],
  ] as const) {
    const f = fixture()
    await f.adapter.startSession({ ...f.input, permissionPreset })
    const done = f.send()
    await f.started
    expect(f.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
      approvalPolicy,
      approvalsReviewer,
      sandbox,
    })
    expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
      approvalPolicy,
      approvalsReviewer,
      sandboxPolicy: { type },
    })
    await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
    await done
  }
})

test('a bypass session sends never and full access on thread start and every turn', async () => {
  const f = fixture()
  await f.adapter.startSession({ ...f.input, permissionPreset: 'bypass' })
  const done = f.send()
  await f.started
  expect(f.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  })
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'dangerFullAccess' },
  })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await done
})

test('interrupt during connection setup cancels before the native turn starts', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const iterator = (
    (await f.adapter.sendTurn({
      ...f.input,
      turnId: 'turn',
      requestId: 'request',
      message: 'hello',
    })) as AsyncIterable<ConversationEvent>
  )[Symbol.asyncIterator]()
  expect((await iterator.next()).value?.type).toBe('turn_started')
  await f.adapter.interrupt(f.input)
  const remaining: ConversationEvent[] = []
  for (;;) {
    const next = await iterator.next()
    if (next.done) break
    remaining.push(next.value)
  }
  expect(remaining.at(-1)?.payload?.interrupted).toBe(true)
  expect(f.calls.some((call) => call.method === 'turn/start')).toBe(false)
  f.adapter.disposeAll?.()
})

test('stopping during executable discovery never spawns a late orphan process', async () => {
  let resolve!: (value: string) => void
  const executable = new Promise<string>((done) => {
    resolve = done
  })
  let spawned = false
  const adapter = createCodexConversationProvider({
    resolveExecutable: () => executable,
    buildEnv: async () => ({}),
    createTransport() {
      spawned = true
      throw new Error('Unexpected spawn')
    },
  })
  const input = {
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'codex-agent',
    modelId: 'gpt-6-sol',
    workspaceRoot: '/workspace/app',
  }
  await adapter.startSession(input)
  const iterator = (
    (await adapter.sendTurn({
      ...input,
      turnId: 'turn',
      requestId: 'request',
      message: 'hello',
    })) as AsyncIterable<ConversationEvent>
  )[Symbol.asyncIterator]()
  await iterator.next()
  await adapter.stopSession(input)
  resolve('/usr/bin/codex')
  await new Promise((done) => setImmediate(done))
  expect(spawned).toBe(false)
  expect(adapter.listLiveSessions?.()).toEqual([])
})

test('leaving bypass reconnects, so the thread resumes with no override instead of keeping full access', async () => {
  const f = fixture()
  f.input.permissionPreset = 'bypass'
  await f.adapter.startSession(f.input)
  const first = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await first
  expect(f.transports).toEqual({ created: 1, closed: 0 })

  expect(await f.adapter.setPermissionPreset?.({ ...f.input, permissionPreset: 'none' })).toEqual({ ok: true })
  expect(f.transports.closed).toBe(1)
  expect(f.adapter.listLiveSessions?.()[0]?.hasChildProcess).toBe(false)

  f.input.permissionPreset = 'none'
  f.calls.length = 0
  f.nextTurn()
  const second = f.send()
  await f.started
  expect(f.transports.created).toBe(2)
  const resume = f.calls.find((call) => call.method === 'thread/resume')
  expect(resume?.params).toMatchObject({ threadId: 'native-thread' })
  expect(resume?.params).not.toHaveProperty('approvalPolicy')
  expect(resume?.params).not.toHaveProperty('sandbox')
  const turn = f.calls.find((call) => call.method === 'turn/start')
  expect(turn?.params).not.toHaveProperty('approvalPolicy')
  expect(turn?.params).not.toHaveProperty('sandboxPolicy')
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await second
})

test('entering bypass keeps the connection: the next turn carries the override itself', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const first = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await first
  expect(await f.adapter.setPermissionPreset?.({ ...f.input, permissionPreset: 'bypass' })).toEqual({ ok: true })
  expect(f.transports).toEqual({ created: 1, closed: 0 })
})

test('a preset change mid-turn is taken, and Codex runs it from the next turn', async () => {
  const f = fixture()
  f.input.permissionPreset = 'bypass'
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  expect(await f.adapter.setPermissionPreset?.({ ...f.input, permissionPreset: 'auto' })).toEqual({
    ok: true,
    notice: 'Codex takes the new permissions from your next message.',
  })
  expect(f.transports.closed).toBe(0)
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await done

  f.input.permissionPreset = 'auto'
  f.calls.length = 0
  f.nextTurn()
  const second = f.send()
  await f.started
  expect(f.transports).toEqual({ created: 1, closed: 0 })
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandboxPolicy: { type: 'workspaceWrite' },
  })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await second
})

test('leaving Auto hands the next turn back to the person, since the reviewer stays with the thread', async () => {
  const f = fixture()
  f.input.permissionPreset = 'auto'
  await f.adapter.startSession(f.input)
  const first = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await first
  expect(await f.adapter.setPermissionPreset?.({ ...f.input, permissionPreset: 'manual' })).toEqual({ ok: true })
  f.input.permissionPreset = 'manual'
  f.calls.length = 0
  f.nextTurn()
  const second = f.send()
  await f.started
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
    approvalPolicy: 'untrusted',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'readOnly' },
  })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await second
})

test('leaving an override for none mid-turn restarts Codex before the next turn, not during this one', async () => {
  const f = fixture()
  f.input.permissionPreset = 'manual'
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  expect(await f.adapter.setPermissionPreset?.({ ...f.input, permissionPreset: 'none' })).toMatchObject({ ok: true })
  expect(f.transports.closed).toBe(0)
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await done

  f.input.permissionPreset = 'none'
  f.calls.length = 0
  f.nextTurn()
  const second = f.send()
  await f.started
  expect(f.transports).toEqual({ created: 2, closed: 1 })
  const resume = f.calls.find((call) => call.method === 'thread/resume')
  expect(resume?.params).not.toHaveProperty('approvalPolicy')
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).not.toHaveProperty('approvalPolicy')
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await second
})

test('on none, an Ask turn does not leave its read-only override on the thread for the turns after it', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const asked = f.send(undefined, 'ask')
  await f.started
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
    sandboxPolicy: { type: 'readOnly' },
  })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await asked

  f.calls.length = 0
  f.nextTurn()
  const next = f.send()
  await f.started
  expect(f.transports).toEqual({ created: 2, closed: 1 })
  expect(f.calls.find((call) => call.method === 'thread/resume')?.params).not.toHaveProperty('sandbox')
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).not.toHaveProperty('sandboxPolicy')
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await next
})

test('Ask is read-only without escalation even when the session preset bypasses approval', async () => {
  const f = fixture()
  await f.adapter.startSession({ ...f.input, permissionPreset: 'bypass' })
  const done = f.send(undefined, 'ask')
  await f.started
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
  })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await done
})

test('OpenAI API keys never reach the Codex child, so a chat cannot bill API usage', async () => {
  expect(
    codexChildEnv(
      {
        OPENAI_API_KEY: 'sk-test',
        CODEX_API_KEY: 'ck-test',
        OPENAI_BASE_URL: 'https://example.com',
        PATH: '/usr/bin',
        ELECTRON_RUN_AS_NODE: '1',
      },
      { sessionId: 'session' },
    ),
  ).toEqual({ PATH: '/usr/bin', SPRINTENGINE_CONVERSATION_SESSION_ID: 'session' })
  // A key alone is not a Codex login: the person is sent to codex login.
  const signedOut = fixture({
    env: { OPENAI_API_KEY: 'sk-test' },
    account: { requiresOpenaiAuth: true, account: null },
  })
  await signedOut.adapter.startSession(signedOut.input)
  await signedOut.send()
  expect(String(signedOut.events.at(-1)?.payload?.message)).toContain('not logged in')
})

test('a thread Codex no longer has continues in a new thread with the conversation replayed', async () => {
  const f = fixture({
    resume: () => {
      throw new CodexRpcError('thread not found')
    },
  })
  await f.adapter.startSession({
    ...f.input,
    resumeSessionId: 'lost-thread',
    fallbackHistory: [
      { role: 'user', content: 'persisted question' },
      { role: 'assistant', content: 'persisted answer' },
    ],
  })
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.calls.map((call) => call.method)).toContain('thread/resume')
  const update = f.events.find((event) => event.type === 'session_updated')
  expect(update?.payload?.providerSessionId).toBe('native-thread')
  expect(String(update?.payload?.notice)).toContain('could not be resumed')
  const prompt = JSON.stringify(f.calls.find((call) => call.method === 'turn/start')?.params)
  expect(prompt).toContain('persisted question')
  expect(prompt).toContain('Make a change.')
  expect(f.events.at(-1)?.type).toBe('turn_completed')
})

test('a turn’s end records the thread and the turn a fork can branch it through', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { id: 'native-turn', status: 'completed' } } })
  await done
  expect(f.events.at(-1)?.payload?.providerCursor).toEqual({ sessionId: 'native-thread', at: 'native-turn' })
})

test('a fork’s first connection branches the parent’s thread through the turn it was made at', async () => {
  const f = fixture()
  // The cursor is the parent's turn; anything else would not be one.
  expect(
    await f.adapter.fork?.({
      ...f.input,
      cursor: { sessionId: 'parent-thread', at: 'turn-7' },
      exact: true,
      latest: false,
    }),
  ).toEqual({ ok: true, cursor: { sessionId: 'parent-thread', at: 'turn-7' } })
  await f.adapter.startSession({
    ...f.input,
    resumeSessionId: 'parent-thread',
    resumeSessionAt: 'turn-7',
    fallbackHistory: [{ role: 'user', content: 'persisted question' }],
  })
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const methods = f.calls.map((call) => call.method)
  expect(methods).not.toContain('thread/resume')
  expect(f.calls.find((call) => call.method === 'thread/fork')?.params).toMatchObject({
    threadId: 'parent-thread',
    lastTurnId: 'turn-7',
    cwd: '/workspace/app',
    excludeTurns: true,
  })
  expect(f.events.find((event) => event.type === 'session_updated')?.payload).toMatchObject({
    providerSessionId: 'forked-thread',
  })
  expect(f.events.find((event) => event.type === 'session_updated')?.payload?.notice).toBeUndefined()
  const turn = f.calls.find((call) => call.method === 'turn/start')?.params as { threadId: string }
  expect(turn.threadId).toBe('forked-thread')
  expect(JSON.stringify(turn)).not.toContain('persisted question')
})

test('a fork Codex cannot branch starts a thread of its own, its first message carrying the conversation', async () => {
  const f = fixture()
  // No turn recorded at the point: nothing for `thread/fork` to name.
  expect(
    await f.adapter.fork?.({ ...f.input, cursor: { sessionId: 'parent-thread', at: null }, exact: true, latest: true }),
  ).toEqual({ ok: true, cursor: null })
  expect(await f.adapter.fork?.({ ...f.input, cursor: null, exact: false, latest: false })).toEqual({
    ok: true,
    cursor: null,
  })
  await f.adapter.startSession({
    ...f.input,
    seedFromHistory: true,
    fallbackHistory: [
      { role: 'user', content: 'persisted question' },
      { role: 'assistant', content: 'persisted answer' },
    ],
  })
  const first = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await first
  expect(f.calls.map((call) => call.method)).toContain('thread/start')
  expect(JSON.stringify(f.calls.find((call) => call.method === 'turn/start')?.params)).toContain('persisted answer')
  // Once.
  f.nextTurn()
  const second = f.send(undefined, undefined, 'Then this.')
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await second
  expect(JSON.stringify(f.calls.filter((call) => call.method === 'turn/start').at(-1)?.params)).not.toContain(
    'persisted answer',
  )
})

test('a fork whose parent thread Codex no longer has continues in a new thread with the conversation', async () => {
  const f = fixture({
    fork: () => {
      throw new CodexRpcError('no rollout found for thread id parent-thread')
    },
  })
  await f.adapter.startSession({
    ...f.input,
    resumeSessionId: 'parent-thread',
    resumeSessionAt: 'turn-7',
    fallbackHistory: [{ role: 'user', content: 'persisted question' }],
  })
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(String(f.events.find((event) => event.type === 'session_updated')?.payload?.notice)).toContain(
    'could not branch the thread this chat was forked from',
  )
  expect(JSON.stringify(f.calls.find((call) => call.method === 'turn/start')?.params)).toContain('persisted question')
})

test('a resume Codex refuses for now fails the turn and keeps the thread to resume next time', async () => {
  let busy = true
  const f = fixture({
    resume: () => {
      if (busy) throw new CodexRpcError('thread is busy with another turn; rate limit reached')
      return { thread: { id: 'kept-thread' } }
    },
  })
  await f.adapter.startSession({ ...f.input, resumeSessionId: 'kept-thread' })
  // Falling back to a new thread would start the turn and wait on it.
  expect(await Promise.race([f.send().then(() => 'failed'), f.started.then(() => 'started')])).toBe('failed')
  expect(f.calls.map((call) => call.method)).not.toContain('thread/start')
  expect(f.events.at(-1)).toMatchObject({ type: 'turn_failed' })
  expect(f.events.some((event) => event.type === 'session_updated')).toBe(false)
  busy = false
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const resumes = f.calls.filter((call) => call.method === 'thread/resume')
  expect(resumes.map((call) => (call.params as { threadId?: string }).threadId)).toEqual(['kept-thread', 'kept-thread'])
  expect(f.calls.map((call) => call.method)).not.toContain('thread/start')
})

test('a thread archived in Codex is unarchived and resumed, keeping its id', async () => {
  let archived = true
  const f = fixture({
    resume: () => {
      if (archived)
        throw new CodexRpcError('session archived-thread is archived. Run `codex unarchive archived-thread`')
      return { thread: { id: 'archived-thread' } }
    },
    unarchive: () => {
      archived = false
      return {}
    },
  })
  await f.adapter.startSession({ ...f.input, resumeSessionId: 'archived-thread' })
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const threadCalls = f.calls.filter((call) => call.method.startsWith('thread/'))
  expect(threadCalls.map((call) => call.method)).toEqual([
    'thread/resume',
    'thread/unarchive',
    'thread/resume',
    'thread/goal/get',
  ])
  expect(threadCalls[1]?.params).toEqual({ threadId: 'archived-thread' })
  const update = f.events.find((event) => event.type === 'session_updated')
  expect(update?.payload?.providerSessionId).toBe('archived-thread')
  expect(update?.payload).not.toHaveProperty('notice')
  expect(f.events.at(-1)?.type).toBe('turn_completed')
})

test('an archived thread Codex will not unarchive continues in a new thread with the conversation', async () => {
  const f = fixture({
    resume: () => {
      throw new CodexRpcError('session archived-thread is archived. Run `codex unarchive archived-thread`')
    },
    unarchive: () => {
      throw new CodexRpcError('could not move the rollout file')
    },
  })
  await f.adapter.startSession({
    ...f.input,
    resumeSessionId: 'archived-thread',
    fallbackHistory: [{ role: 'user', content: 'persisted question' }],
  })
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const methods = f.calls.map((call) => call.method).filter((method) => method.startsWith('thread/'))
  expect(methods).toEqual(['thread/resume', 'thread/unarchive', 'thread/start', 'thread/goal/get'])
  const update = f.events.find((event) => event.type === 'session_updated')
  expect(update?.payload?.providerSessionId).toBe('native-thread')
  expect(String(update?.payload?.notice)).toContain('could not be resumed')
  expect(JSON.stringify(f.calls.find((call) => call.method === 'turn/start')?.params)).toContain('persisted question')
})

test('a resume refused for another reason is not unarchived', async () => {
  const f = fixture({
    resume: () => {
      throw new CodexRpcError('thread is busy with another turn')
    },
  })
  await f.adapter.startSession({ ...f.input, resumeSessionId: 'kept-thread' })
  await f.send()
  const methods = f.calls.map((call) => call.method)
  expect(methods).not.toContain('thread/unarchive')
  expect(methods).not.toContain('thread/start')
  expect(f.events.at(-1)).toMatchObject({ type: 'turn_failed' })
})

test('a resume that is never answered fails the turn instead of dropping the thread', async () => {
  const f = fixture({
    resume: () => {
      throw new Error('Codex thread/resume timed out.')
    },
  })
  await f.adapter.startSession({ ...f.input, resumeSessionId: 'slow-thread' })
  await f.send()
  expect(f.calls.map((call) => call.method)).not.toContain('thread/start')
  expect(f.events.at(-1)).toMatchObject({ type: 'turn_failed' })
})

test('a start Codex never answers says what to run, and names a large log database', async () => {
  const asked: Array<string | null> = []
  const f = fixture({
    initializeTimesOut: true,
    readCodexLogBytes: async (distro) => {
      asked.push(distro)
      return 2.5 * 1024 ** 3
    },
  })
  await f.adapter.startSession(f.input)
  await f.send()
  const failed = f.events.at(-1) as ConversationEvent & { payload?: { error?: string; message?: string } }
  expect(failed).toMatchObject({ type: 'turn_failed' })
  const words = JSON.stringify(failed.payload)
  expect(words).toContain("Codex didn't answer in 30 s. Run `codex` in a terminal on")
  expect(words).toContain("Codex's own log database is 2.5 GB, which can make it slow to start.")
  expect(words).toContain('Moving `~/.codex/logs_*.sqlite*` aside fixes it.')
  // Read on the machine the chat ran on: this one, here.
  expect(asked).toEqual([null])
})

const EPERM_EXIT = 'Codex process exited (1): Error: EPERM: operation not permitted, uv_cwd.'

test('a start refused with EPERM in a folder macOS keeps private says where to allow it', async () => {
  const f = fixture({
    initializeError: EPERM_EXIT,
    platform: 'darwin',
    homeDir: '/Users/dev',
    workspaceRoot: '/Users/dev/Documents/app',
  })
  await f.adapter.startSession(f.input)
  await f.send()
  const words = JSON.stringify((f.events.at(-1) as ConversationEvent).payload)
  expect(words).toContain('EPERM: operation not permitted')
  expect(words).toContain('System Settings › Privacy & Security › Files and Folders')
})

test('the same refusal off macOS, or in a folder macOS does not keep, says only what Codex said', async () => {
  for (const setup of [
    { platform: 'linux' as const, homeDir: '/home/dev', workspaceRoot: '/home/dev/Documents/app' },
    { platform: 'darwin' as const, homeDir: '/Users/dev', workspaceRoot: '/Users/dev/code/app' },
  ]) {
    const f = fixture({ initializeError: EPERM_EXIT, ...setup })
    await f.adapter.startSession(f.input)
    await f.send()
    const words = JSON.stringify((f.events.at(-1) as ConversationEvent).payload)
    expect(words).toContain('EPERM')
    expect(words).not.toContain('Privacy & Security')
  }
})

test('a start Codex never answers with a small log database names only what to run', async () => {
  const f = fixture({ initializeTimesOut: true, readCodexLogBytes: async () => 40 * 1024 ** 2 })
  await f.adapter.startSession(f.input)
  await f.send()
  const words = JSON.stringify((f.events.at(-1) as ConversationEvent).payload)
  expect(words).toContain("Codex didn't answer in 30 s.")
  expect(words).not.toContain('log database')
})

test('a model switch rides the next turn without a reconnect, and the running turn keeps its model', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  expect(f.adapter.capabilities?.liveModelSwitch).toBe(true)
  const first = f.send()
  await f.started
  expect(await f.adapter.setModel?.({ ...f.input, nextModelId: 'gpt-6-luna' })).toMatchObject({
    ok: true,
    notice: expect.stringContaining('next message'),
  })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await first

  // The runtime hands every turn the session's current model.
  f.input.modelId = 'gpt-6-luna'
  f.calls.length = 0
  f.nextTurn()
  const second = f.send()
  await f.started
  expect(f.transports).toEqual({ created: 1, closed: 0 })
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).toMatchObject({ model: 'gpt-6-luna' })
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await second

  // The CLI's own default row passes no model at all.
  expect(await f.adapter.setModel?.({ ...f.input, nextModelId: 'default' })).toEqual({ ok: true })
  f.input.modelId = 'default'
  f.calls.length = 0
  f.nextTurn()
  const third = f.send()
  await f.started
  expect(f.calls.find((call) => call.method === 'turn/start')?.params).not.toHaveProperty('model')
  await f.message({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { status: 'completed' } } })
  await third
})

const names = (cwd: string) => conversationCommandsFor('codex', cwd).commands.map((command) => command.name)

test('Codex offers /compact and /goal as soon as a chat starts, and its skills once the app-server connects', async () => {
  const skills = {
    data: [
      { cwd: '/workspace/skills', skills: [{ name: 'release-notes', description: 'Release notes', enabled: true }] },
    ],
  }
  const f = fixture({ skills })
  f.input.workspaceRoot = '/workspace/skills'
  await f.adapter.startSession(f.input)
  expect(names('/workspace/skills')).toEqual(['compact', 'goal'])
  // A stand-in, not an answer: the folder's skills are still due to be asked for.
  expect(conversationCommandsFor('codex', '/workspace/skills').fetchedAt).toBe(0)
  const done = f.send()
  await f.started
  await expect.poll(() => names('/workspace/skills')).toEqual(['compact', 'goal', 'release-notes'])
  expect(conversationCommandsFor('codex', '/workspace/skills').commands[2]).toMatchObject({
    insertText: '$release-notes ',
    source: 'skill',
  })
  expect(f.calls.find((call) => call.method === 'skills/list')?.params).toEqual({ cwds: ['/workspace/skills'] })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  // A change on disk is announced outside any turn, and the list is read again from disk.
  skills.data[0].skills.push({ name: 'changelog', description: 'Changelogs', enabled: true })
  await f.message({ method: 'skills/changed', params: {} })
  await expect.poll(() => names('/workspace/skills')).toEqual(['compact', 'goal', 'release-notes', 'changelog'])
  expect(f.calls.filter((call) => call.method === 'skills/list').at(-1)?.params).toEqual({
    cwds: ['/workspace/skills'],
    forceReload: true,
  })
  expect(f.events.at(-1)?.type).toBe('turn_completed')
})

test('a $skill Codex listed goes to turn/start as the skill itself beside the text, an unknown one as text alone', async () => {
  const path = '/workspace/skills/.codex/skills/release-notes/SKILL.md'
  const f = fixture({
    skills: { data: [{ cwd: '/workspace/skills', skills: [{ name: 'release-notes', path, enabled: true }] }] },
  })
  f.input.workspaceRoot = '/workspace/skills'
  await f.adapter.startSession(f.input)
  const message = 'Use $release-notes and $unknown for v2.'
  const first = f.send(undefined, undefined, message)
  await f.started
  expect((f.calls.find((call) => call.method === 'turn/start')?.params as { input: unknown[] }).input).toEqual([
    { type: 'text', text: message, text_elements: [] },
    { type: 'skill', name: 'release-notes', path },
  ])
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await first

  f.nextTurn()
  const second = f.send(undefined, undefined, 'No skill: $unknown costs $5.')
  await f.started
  expect((f.calls.filter((call) => call.method === 'turn/start').at(-1)?.params as { input: unknown[] }).input).toEqual(
    [{ type: 'text', text: 'No skill: $unknown costs $5.', text_elements: [] }],
  )
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await second
})

test('/compact at the start of a message compacts the thread natively instead of sending it as a turn', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const first = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await first
  f.nextTurn()
  f.events.length = 0
  const compacting = f.send(undefined, undefined, '/compact')
  await f.started
  expect(f.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  expect(f.calls.at(-1)).toEqual({ method: 'thread/compact/start', params: { threadId: 'native-thread' } })
  await f.message({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: 'compact-turn' } } })
  await f.message({ method: 'item/started', params: { item: { id: 'summary', type: 'contextCompaction' } } })
  await f.message({ method: 'item/completed', params: { item: { id: 'summary', type: 'contextCompaction' } } })
  await f.message({ method: 'turn/completed', params: { turn: { id: 'compact-turn', status: 'completed' } } })
  await compacting
  expect(f.events.map((event) => [event.type, event.payload?.turnId, event.payload?.trigger])).toEqual([
    ['turn_started', 'turn', undefined],
    ['context_compacting', 'turn', undefined],
    ['context_compacted', 'turn', 'manual'],
    ['turn_completed', 'turn', undefined],
  ])
})

test('Codex marks a compaction it makes on its own mid-turn as automatic', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({ method: 'item/completed', params: { item: { id: 'summary', type: 'contextCompaction' } } })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.events.find((event) => event.type === 'context_compacted')?.payload).toMatchObject({ trigger: 'auto' })
})

test('/compact with instructions, or before anything was said, is refused without reaching Codex', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  await f.send(undefined, undefined, '/compact keep the API notes')
  expect(f.events.at(-1)).toMatchObject({
    type: 'turn_failed',
    payload: { message: 'Send /compact on its own: Codex compacts the conversation without instructions or images.' },
  })
  await f.send(undefined, undefined, '/compact')
  expect(f.events.at(-1)).toMatchObject({
    type: 'turn_failed',
    payload: { message: 'There is no conversation to compact yet.' },
  })
  expect(f.calls.some((call) => call.method === 'turn/start' || call.method === 'thread/compact/start')).toBe(false)
})

test('Codex lists a folder before any chat there has started from an app-server that opens no thread', async () => {
  const calls: string[] = []
  let closed = false
  const commands = await probeCodexConversationCommands(
    { cwd: '/workspace/probe' },
    {
      resolveExecutable: async () => '/usr/bin/codex',
      buildEnv: async () => ({}),
      createTransport: () => ({
        pid: 1,
        async request(method) {
          calls.push(method)
          return method === 'skills/list'
            ? {
                data: [
                  {
                    cwd: '/workspace/probe',
                    skills: [{ name: 'release-notes', description: 'Release notes', enabled: true }],
                  },
                ],
              }
            : {}
        },
        notify: (method) => calls.push(method),
        respond: () => undefined,
        reject: () => undefined,
        close: () => (closed = true),
      }),
    },
  )
  expect(commands.map((command) => command.name)).toEqual(['compact', 'goal', 'release-notes'])
  expect(names('/workspace/probe')).toEqual(['compact', 'goal', 'release-notes'])
  expect(calls).toEqual(['initialize', 'initialized', 'skills/list'])
  expect(closed).toBe(true)
})

async function runTurn(f: ReturnType<typeof fixture>, messages: RpcMessage[], send = f.send()) {
  await f.adapter.startSession(f.input)
  const done = send
  await f.started
  for (const message of messages) await f.message(message)
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  return f.events
}
const payloads = (events: ConversationEvent[], type: ConversationEvent['type']) =>
  events.filter((event) => event.type === type).map((event) => event.payload!)

test('a generated picture is written to disk and its path, never its bytes, goes in the transcript', async () => {
  const saved: { sessionId: string; itemId: string; base64: string }[] = []
  const f = fixture({
    saveGeneratedImage: async (input) => {
      saved.push(input)
      return `/data/conversation-images/${input.sessionId}/${input.itemId}.png`
    },
  })
  const started = {
    id: 'ig_1',
    type: 'imageGeneration',
    status: 'inProgress',
    revisedPrompt: null,
    result: '',
    failure: null,
  }
  const completed = { ...started, status: 'completed', revisedPrompt: 'A flat orange circle', result: 'iVBORw0KGgo=' }
  const events = await runTurn(f, [
    { method: 'item/started', params: { item: started } },
    { method: 'item/completed', params: { item: completed } },
  ])
  expect(saved).toEqual([{ sessionId: 'session', itemId: 'ig_1', base64: 'iVBORw0KGgo=' }])
  expect(payloads(events, 'tool_started').at(-1)).toMatchObject({
    toolUseId: 'ig_1',
    name: 'GenerateImage',
    input: { prompt: 'A flat orange circle', path: '/data/conversation-images/session/ig_1.png' },
  })
  expect(payloads(events, 'tool_output')).toEqual([
    expect.objectContaining({ toolUseId: 'ig_1', output: '', status: 'ok' }),
  ])
  expect(JSON.stringify(events)).not.toContain('iVBORw0KGgo=')
})

test('a picture Codex saved itself is shown from there, and a spent image limit says when it resets', async () => {
  const f = fixture({ saveGeneratedImage: async () => expect.unreachable('Codex already saved it') })
  const events = await runTurn(f, [
    {
      method: 'item/completed',
      params: {
        item: {
          id: 'saved',
          type: 'imageGeneration',
          status: 'completed',
          revisedPrompt: null,
          result: 'AAAA',
          failure: null,
          savedPath: '/Users/me/.codex/generated_images/a.png',
        },
      },
    },
    {
      method: 'item/completed',
      params: {
        item: {
          id: 'limited',
          type: 'imageGeneration',
          status: 'failed',
          revisedPrompt: null,
          result: '',
          failure: { type: 'usageLimitExceeded', limitId: 'images', resetsAt: 1_790_700_000 },
        },
      },
    },
  ])
  expect(payloads(events, 'tool_started').find((payload) => payload.toolUseId === 'saved')).toMatchObject({
    input: { path: '/Users/me/.codex/generated_images/a.png' },
  })
  const limited = payloads(events, 'tool_output').find((payload) => payload.toolUseId === 'limited')
  expect(limited).toMatchObject({ status: 'error' })
  expect(String(limited?.output)).toMatch(/image generation limit\. It resets /)
})

test("Codex's plan updates draw as checklists", async () => {
  const f = fixture()
  const events = await runTurn(f, [
    {
      method: 'turn/plan/updated',
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        explanation: 'Two steps',
        plan: [
          { step: 'Read the diff', status: 'completed' },
          { step: 'Open the PR', status: 'inProgress' },
        ],
      },
    },
    {
      method: 'turn/plan/updated',
      params: { threadId: 'native-thread', turnId: 'native-turn', explanation: null, plan: [] },
    },
  ])
  const plans = payloads(events, 'tool_started')
  expect(plans).toHaveLength(2)
  expect(plans[0]).toMatchObject({
    name: 'TodoWrite',
    kind: 'todo',
    input: {
      explanation: 'Two steps',
      todos: [
        { content: 'Read the diff', status: 'completed' },
        { content: 'Open the PR', status: 'in_progress' },
      ],
    },
  })
  expect(plans[0].toolUseId).not.toBe(plans[1].toolUseId)
})

test('a subagent is a lane: its steps nest under it, its words and end are its own', async () => {
  const f = fixture()
  const child = 'child-thread'
  const activity = {
    id: 'call_spawn',
    type: 'subAgentActivity',
    kind: 'started',
    agentThreadId: child,
    agentPath: '/root/pong',
  }
  const wait = {
    id: 'call_wait',
    type: 'collabAgentToolCall',
    tool: 'wait',
    status: 'completed',
    senderThreadId: 'native-thread',
    receiverThreadIds: [],
    prompt: null,
    model: null,
    reasoningEffort: null,
    agentsStates: {},
  }
  const command = {
    id: 'child_cmd',
    type: 'commandExecution',
    command: 'echo PONG',
    cwd: '/workspace/app',
    status: 'completed',
    aggregatedOutput: 'PONG\n',
    exitCode: 0,
  }
  const events = await runTurn(f, [
    { method: 'item/started', params: { threadId: 'native-thread', item: activity } },
    { method: 'item/completed', params: { threadId: 'native-thread', item: activity } },
    { method: 'turn/started', params: { threadId: child, turn: { id: 'child-turn' } } },
    {
      method: 'item/started',
      params: { threadId: child, item: { ...command, status: 'inProgress', aggregatedOutput: null } },
    },
    { method: 'item/completed', params: { threadId: child, item: command } },
    { method: 'thread/tokenUsage/updated', params: { threadId: child, tokenUsage: { last: { totalTokens: 999 } } } },
    {
      method: 'item/completed',
      params: { threadId: child, item: { id: 'child_msg', type: 'agentMessage', text: 'PONG' } },
    },
    { method: 'item/completed', params: { threadId: 'native-thread', item: wait } },
    { method: 'turn/completed', params: { threadId: child, turn: { status: 'completed' } } },
    {
      method: 'item/completed',
      params: { threadId: 'native-thread', item: { id: 'answer', type: 'agentMessage', text: 'It said PONG.' } },
    },
  ])
  const started = payloads(events, 'tool_started')
  expect(started.map((payload) => payload.toolUseId)).toEqual(['call_spawn', 'child_cmd'])
  expect(started[0]).toMatchObject({
    name: 'Agent',
    kind: 'subagent',
    subagentLane: true,
    input: { description: 'pong' },
  })
  expect(started[1]).toMatchObject({ parentToolUseId: 'call_spawn', input: { command: 'echo PONG' } })
  expect(payloads(events, 'subagent_message')).toEqual([{ parentToolUseId: 'call_spawn', text: 'PONG' }])
  const statuses = payloads(events, 'subagent_status')
  expect(statuses.map((payload) => payload.status)).toEqual(['running', 'completed'])
  // Lane progress is the session's, not a turn's.
  expect(statuses.every((payload) => payload.turnId === undefined)).toBe(true)
  expect(payloads(events, 'tool_output').find((payload) => payload.toolUseId === 'call_spawn')).toMatchObject({
    output: 'PONG',
    status: 'ok',
  })
  // The child's usage is not the conversation's, and its text is not the reply.
  expect(payloads(events, 'usage_updated')).toEqual([])
  expect(payloads(events, 'content_delta').map((payload) => payload.text)).toEqual(['It said PONG.'])
})

test('a usage update says the model’s window and the latest request’s size, never the session’s running sum', async () => {
  const f = fixture()
  const breakdown = (totalTokens: number) => ({
    totalTokens,
    inputTokens: totalTokens - 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 100,
    reasoningOutputTokens: 0,
  })
  const events = await runTurn(f, [
    {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'native-thread',
        tokenUsage: { total: breakdown(900_000), last: breakdown(41_000), modelContextWindow: 272_000 },
      },
    },
    // A model Codex has no size for reports a null window: no reading, not zero.
    {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'native-thread',
        tokenUsage: { total: breakdown(950_000), last: breakdown(43_000), modelContextWindow: null },
      },
    },
  ])
  const usage = payloads(events, 'usage_updated')
  expect(usage[0]).toMatchObject({ contextWindow: 272_000, contextUsed: 41_000, totalTokens: 41_000 })
  expect(usage[1]).toMatchObject({ contextUsed: 43_000 })
  expect(usage[1]).not.toHaveProperty('contextWindow')
})

test('turn_completed says the last message as the reply, and what every request of the turn spent', async () => {
  const f = fixture()
  const last = (
    inputTokens: number,
    cachedInputTokens: number,
    cacheWriteInputTokens: number,
    outputTokens: number,
  ) => ({
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
  })
  const usageUpdate = (breakdown: ReturnType<typeof last>) => ({
    method: 'thread/tokenUsage/updated',
    params: { threadId: 'native-thread', tokenUsage: { total: breakdown, last: breakdown, modelContextWindow: null } },
  })
  const events = await runTurn(f, [
    { method: 'item/agentMessage/delta', params: { itemId: 'narration', delta: 'Checking the branch.' } },
    usageUpdate(last(1000, 800, 0, 50)),
    { method: 'item/started', params: { item: { id: 'cmd', type: 'commandExecution', command: 'git status' } } },
    { method: 'item/completed', params: { item: { id: 'cmd', type: 'commandExecution', status: 'completed' } } },
    { method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'The branch ' } },
    { method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'is clean.' } },
    usageUpdate(last(1200, 1000, 100, 20)),
  ])
  const completed = payloads(events, 'turn_completed')[0]
  expect(completed).toMatchObject({
    text: 'The branch is clean.',
    // Fresh input is what the cache's reads and writes leave of Codex's input.
    usage: { inputTokens: 300, cacheReadTokens: 1800, cacheWriteTokens: 100, outputTokens: 70 },
  })
})

test('a thread that is neither this one nor a subagent of it is still refused', async () => {
  const f = fixture()
  await runTurn(f, [
    {
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'stranger', itemId: 'x', command: 'rm -rf /' },
    },
  ])
  expect(f.replies).toEqual([{ id: 7, result: { error: 'This thread is not owned by this session.' } }])
  expect(payloads(f.events, 'approval_requested')).toEqual([])
})

test('the idle reaper leaves a process alone while a subagent in it is working', async () => {
  const f = fixture()
  const activity = {
    id: 'call_spawn',
    type: 'subAgentActivity',
    kind: 'started',
    agentThreadId: 'child-thread',
    agentPath: '/root/slow',
  }
  await runTurn(f, [{ method: 'item/completed', params: { threadId: 'native-thread', item: activity } }])
  expect(f.adapter.disposeChildProcess?.('session')).toBe(false)
  await f.message({ method: 'turn/completed', params: { threadId: 'child-thread', turn: { status: 'completed' } } })
  expect(f.adapter.disposeChildProcess?.('session')).toBe(true)
})

test('a stopped turn Codex never confirms ends the lanes of the subagents its process ran', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture({ silentInterrupt: true })
    await f.adapter.startSession(f.input)
    const done = f.send()
    await vi.waitFor(() => expect(f.calls.some((call) => call.method === 'turn/start')).toBe(true))
    const activity = {
      id: 'call_spawn',
      type: 'subAgentActivity',
      kind: 'started',
      agentThreadId: 'child-thread',
      agentPath: '/root/slow',
    }
    await f.message({ method: 'item/completed', params: { threadId: 'native-thread', item: activity } })
    const stopping = f.adapter.interrupt(f.input)
    await vi.waitFor(() => expect(f.calls.some((call) => call.method === 'turn/interrupt')).toBe(true))
    // A subagent still working keeps the process from the reaper and Settle.
    expect(f.adapter.disposeChildProcess?.('session')).toBe(false)
    await vi.advanceTimersByTimeAsync(CODEX_INTERRUPT_GRACE_MS)
    await stopping
    await done
    expect(f.transports.closed).toBe(1)
    expect(payloads(f.events, 'subagent_status').map((payload) => payload.status)).toEqual(['running', 'stopped'])
    expect(f.adapter.listLiveSessions?.()[0]).toMatchObject({ turnActive: false, hasChildProcess: false })
  } finally {
    vi.useRealTimers()
  }
})

test('Settle ends a Codex process with a subagent still working, and its lane with it', async () => {
  const f = fixture()
  const activity = {
    id: 'call_spawn',
    type: 'subAgentActivity',
    kind: 'started',
    agentThreadId: 'child-thread',
    agentPath: '/root/slow',
  }
  // Between turns, lane progress rides the session channel.
  const between: ConversationEvent[] = []
  const input = { ...f.input, onSessionEvent: (event: ConversationEvent) => between.push(event) }
  await runTurn({ ...f, input }, [{ method: 'item/completed', params: { threadId: 'native-thread', item: activity } }])
  expect(f.adapter.disposeChildProcess?.('session')).toBe(false)
  expect(f.adapter.disposeChildProcess?.('session', { force: true })).toBe(true)
  expect(f.transports.closed).toBe(1)
  expect(payloads(f.events, 'subagent_status').map((payload) => payload.status)).toEqual(['running'])
  expect(payloads(between, 'subagent_status')).toMatchObject([{ toolUseId: 'call_spawn', status: 'stopped' }])
  expect(f.adapter.listLiveSessions?.()[0]?.hasChildProcess).toBe(false)
  expect(f.adapter.disposeChildProcess?.('session', { force: true })).toBe(false)
})

test('forcing disposal ends a Codex turn still running', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  expect(f.adapter.disposeChildProcess?.('session')).toBe(false)
  expect(f.adapter.disposeChildProcess?.('session', { force: true })).toBe(true)
  await done
  expect(f.events.at(-1)).toMatchObject({ type: 'turn_completed', payload: { interrupted: true } })
  expect(f.transports.closed).toBe(1)
})

test('what Codex reports beside the reply is said in the turn, once', async () => {
  const f = fixture()
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  f.connection.onToolFailure?.('timed out negotiating with the code-mode host')
  f.connection.onToolFailure?.('timed out negotiating with the code-mode host')
  for (const message of [
    {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'native-thread',
        name: 'node_repl',
        status: 'failed',
        error: 'MCP client for `node_repl` failed to start: MCP startup failed: No such file or directory (os error 2)',
      },
    },
    {
      method: 'mcpServer/startupStatus/updated',
      params: {
        threadId: 'native-thread',
        name: 'node_repl',
        status: 'failed',
        error: 'MCP client for `node_repl` failed to start: MCP startup failed: No such file or directory (os error 2)',
      },
    },
    {
      method: 'mcpServer/startupStatus/updated',
      params: { threadId: 'native-thread', name: 'docs', status: 'ready', error: null },
    },
    {
      method: 'error',
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        willRetry: true,
        error: { message: 'stream disconnected' },
      },
    },
    {
      method: 'error',
      params: { threadId: 'native-thread', turnId: 'native-turn', willRetry: false, error: { message: 'fatal' } },
    },
    { method: 'warning', params: { threadId: 'native-thread', message: 'Approaching your usage limit.' } },
    {
      method: 'model/rerouted',
      params: {
        threadId: 'native-thread',
        turnId: 'native-turn',
        fromModel: 'gpt-6-sol',
        toModel: 'gpt-6-luna',
        reason: 'highRiskCyberActivity',
      },
    },
  ])
    await f.message(message)
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const notes = payloads(f.events, 'command_output')
  expect(notes.every((payload) => payload.adapterNote === true && payload.turnId === 'turn')).toBe(true)
  expect(notes.map((payload) => payload.output)).toEqual([
    expect.stringMatching(/^Codex could not run its tools: timed out negotiating with the code-mode host\. /),
    "Codex's MCP server “node_repl” did not start: No such file or directory (os error 2)",
    'Codex hit an error and is retrying: stream disconnected',
    'Approaching your usage limit.',
    'Codex answered this turn with gpt-6-luna instead of gpt-6-sol, as the request looked like high-risk security work.',
  ])
})

const GRACE = ['-c', 'mcp_optional_startup_grace_ms=10000']

test('the handshake asks for the experimental API, and extra app-server arguments come from the environment', async () => {
  const f = fixture({ env: { SPRINTENGINE_CODEX_APP_SERVER_ARGS: `-c 'features.code_mode_host=false'` } })
  await runTurn(f, [])
  expect(f.calls.find((call) => call.method === 'initialize')?.params).toMatchObject({
    capabilities: { experimentalApi: true },
  })
  expect(f.connection.args).toEqual(['-c', 'features.code_mode_host=false', ...GRACE])
})

test("Codex waits 10 s, not its own 1 s, for a new thread's MCP servers, so a cold npx server's tools are there from the first turn", async () => {
  const f = fixture()
  await runTurn(f, [])
  expect(f.connection.args).toEqual(['-c', 'mcp_optional_startup_grace_ms=10000'])
})

test("a chat's own MCP servers reach Codex as config overrides for its app-server alone", async () => {
  const f = fixture({ env: { SPRINTENGINE_CODEX_APP_SERVER_ARGS: `-c 'features.code_mode_host=false'` } })
  expect(f.adapter.acceptsMcpServers).toBe(true)
  Object.assign(f.input, {
    mcpServers: [
      {
        id: 'railway',
        name: 'Railway',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@railway/mcp'],
        env: { RAILWAY_ENV: 'prod' },
        envVarNames: ['RAILWAY_TOKEN'],
      },
    ],
  })
  await runTurn(f, [])
  expect(f.connection.args).toEqual([
    '-c',
    'features.code_mode_host=false',
    ...GRACE,
    '-c',
    'mcp_servers.railway={ "command" = "npx", "args" = ["-y", "@railway/mcp"], "env_vars" = ["RAILWAY_TOKEN"], "env" = { "RAILWAY_ENV" = "prod" } }',
  ])

  // HTTP: the bearer token by the variable that holds it, other headers as they are.
  expect(
    codexMcpServerArgs([
      {
        id: 'linear',
        name: 'Linear',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        headers: { Authorization: 'Bearer stale', 'X-Team': 'acme' },
        envVarNames: ['LINEAR_TOKEN'],
      },
    ]),
  ).toEqual([
    '-c',
    'mcp_servers.linear={ "url" = "https://mcp.linear.app/mcp", "bearer_token_env_var" = "LINEAR_TOKEN", "http_headers" = { "X-Team" = "acme" } }',
  ])
  // A dotted id would be read as a deeper config path: refused, never mis-set.
  expect(() => codexMcpServerArgs([{ id: 'acme.tools', name: 'Acme', transport: 'stdio', command: 'x' }])).toThrow(
    /"acme\.tools" is not a Codex config key/,
  )
  expect(codexMcpServerArgs([])).toEqual([])
})

const GATEWAY: ConversationMcpServer = {
  id: 'sprintengine-studio',
  name: 'SprintEngine Studio MCP',
  transport: 'stdio',
  command: '/Users/dev/.sprintengine/bin/studio',
  args: ['mcp'],
  env: { SPRINTENGINE_USER_DATA_DIR: '/Users/dev/Library/Application Support/SprintEngine Studio' },
}

test("a Codex chat is handed the app's gateway once, with its identity, and its token only by name", async () => {
  const asked: unknown[] = []
  const f = fixture({
    resolveStudioMcpServer: async (input) => {
      asked.push(input)
      return GATEWAY
    },
  })
  Object.assign(f.input, {
    mcpServers: [
      { id: 'railway', name: 'Railway', transport: 'stdio', command: 'npx', args: ['-y', '@railway/mcp'] },
      // A server of the session's own under the gateway's id would be a second gateway.
      { id: 'sprintengine-studio', name: 'Stale', transport: 'stdio', command: '/stale/studio' },
    ],
  })
  await runTurn(f, [])
  expect(asked).toEqual([{}])
  const overrides = f.connection.args!.filter((arg) => arg.startsWith('mcp_servers.'))
  // One override under the name a terminal launch pins the gateway into
  // `.codex/config.toml` with: Codex merges it into that entry rather than
  // starting a second server. The person's own servers stay as they were.
  expect(overrides).toEqual([
    'mcp_servers.sprintengine-studio={ "command" = "/Users/dev/.sprintengine/bin/studio", "args" = ["mcp"], "env_vars" = ["SPRINTENGINE_MCP_CHANNEL_TOKEN"], "env" = { "SPRINTENGINE_USER_DATA_DIR" = "/Users/dev/Library/Application Support/SprintEngine Studio", "SPRINTENGINE_WORKSPACE_ID" = "workspace", "SPRINTENGINE_AGENT_ID" = "agent", "SPRINTENGINE_AGENT_CLI" = "codex" } }',
    'mcp_servers.railway={ "command" = "npx", "args" = ["-y", "@railway/mcp"] }',
  ])
})

test('a Codex chat whose gateway cannot be resolved still starts, with only its own servers', async () => {
  const f = fixture({
    resolveStudioMcpServer: async () => {
      throw new Error('The launcher could not be written.')
    },
  })
  await runTurn(f, [])
  expect(f.connection.args).toEqual(GRACE)
})

// A chat with the gateway is told to lease a worktree from the pool rather than
// run `git worktree add`, as the thread's developer instructions.
async function gitCheckout() {
  const root = await mkdtemp(join(tmpdir(), 'codex-lease-'))
  await mkdir(join(root, '.git'))
  return root
}
const LEASE_LINE =
  'To work in a separate git worktree, call the SprintEngine Studio tool `worktree.lease` from its ' +
  '`sprintengine-studio` MCP server (and `worktree.release` when done) instead of running `git worktree add`: it ' +
  'gives you a pooled worktree on a fresh branch off the default branch, with dependencies installed when the ' +
  'project has turned that on.'

test('a Codex chat with the gateway in a git checkout starts its thread told to lease worktrees', async () => {
  const root = await gitCheckout()
  try {
    const f = fixture({ resolveStudioMcpServer: async () => GATEWAY })
    f.input.workspaceRoot = root
    await runTurn(f, [])
    expect(f.calls.find((call) => call.method === 'config/read')?.params).toEqual({ cwd: root })
    expect(f.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
      developerInstructions: LEASE_LINE,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a Codex chat keeps the person's own developer instructions ahead of Studio's line", async () => {
  const root = await gitCheckout()
  try {
    const f = fixture({
      resolveStudioMcpServer: async () => GATEWAY,
      configRead: () => ({ config: { developer_instructions: 'Answer in British English.' } }),
    })
    f.input.workspaceRoot = root
    await runTurn(f, [])
    expect(f.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({
      developerInstructions: `Answer in British English.\n\n${LEASE_LINE}`,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a Codex that cannot read its config is told nothing, rather than having its instructions overwritten', async () => {
  const root = await gitCheckout()
  try {
    const f = fixture({
      resolveStudioMcpServer: async () => GATEWAY,
      configRead: () => {
        throw new CodexRpcError('Method not found')
      },
    })
    f.input.workspaceRoot = root
    await runTurn(f, [])
    expect(f.calls.find((call) => call.method === 'thread/start')?.params).not.toHaveProperty('developerInstructions')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a Codex chat without the gateway, or outside a git checkout, is told nothing about worktrees', async () => {
  const root = await gitCheckout()
  try {
    const withoutGateway = fixture()
    withoutGateway.input.workspaceRoot = root
    await runTurn(withoutGateway, [])
    const outside = fixture({ resolveStudioMcpServer: async () => GATEWAY })
    await runTurn(outside, [])
    for (const f of [withoutGateway, outside]) {
      expect(f.calls.map((call) => call.method)).not.toContain('config/read')
      expect(f.calls.find((call) => call.method === 'thread/start')?.params).not.toHaveProperty('developerInstructions')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('each Codex app-server holds its own gateway token for its chat, off its command line, until it ends', async () => {
  // A resumed chat, a fork and a restart after a preset change are each a new
  // app-server, so each is a new launch with a token of its own.
  const started = () => {
    const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 7,
      exitCode: null as number | null,
      kill: () => true,
    })
    const transport = createCodexRpcTransport({
      command: '/usr/local/bin/codex',
      cwd: '/Users/dev/repo',
      env: codexChildEnv(
        { PATH: '/usr/bin', SPRINTENGINE_WORKSPACE_ID: 'workspace', SPRINTENGINE_AGENT_ID: 'agent' },
        { sessionId: 'session' },
      ),
      args: codexMcpServerArgs([{ ...GATEWAY, envVarNames: ['SPRINTENGINE_MCP_CHANNEL_TOKEN'] }]),
      spawnChild: ((_file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        spawned.push({ args, env: options.env })
        return child
      }) as unknown as CodexRpcOptions['spawnChild'],
      onMessage: () => undefined,
      onClose: () => undefined,
    })
    const token = spawned[0]!.env.SPRINTENGINE_MCP_CHANNEL_TOKEN!
    expect(spawned[0]!.args.join(' ')).not.toContain(token)
    return {
      token,
      end: () => {
        transport.close()
        child.exitCode = 0
        child.emit('close', 0)
      },
    }
  }
  const first = started()
  expect(resolveGatewayLaunchToken(first.token)).toEqual({ workspaceId: 'workspace', agentId: 'agent' })
  first.end()
  expect(resolveGatewayLaunchToken(first.token)).toBeNull()
  const second = started()
  expect(second.token).not.toBe(first.token)
  expect(resolveGatewayLaunchToken(second.token)).toEqual({ workspaceId: 'workspace', agentId: 'agent' })
  second.end()
})

test('a fork Codex refuses to branch at its turn starts a new thread with the conversation, not a dead end', async () => {
  const f = fixture({
    fork: () => {
      throw new CodexRpcError('turn turn-7 not found in thread parent-thread')
    },
  })
  await f.adapter.startSession({
    ...f.input,
    resumeSessionId: 'parent-thread',
    resumeSessionAt: 'turn-7',
    fallbackHistory: [{ role: 'user', content: 'persisted question' }],
  })
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.calls.map((call) => call.method)).toContain('thread/start')
  expect(JSON.stringify(f.calls.find((call) => call.method === 'turn/start')?.params)).toContain('persisted question')
})

test('a seeded Codex fork says when Codex took its conversation, and a refused start owes it still', async () => {
  let refuse = true
  const f = fixture({ refuseTurn: () => refuse })
  await f.adapter.startSession({
    ...f.input,
    seedFromHistory: true,
    fallbackHistory: [{ role: 'user', content: 'persisted question' }],
  })
  await f.send()
  expect(f.events.at(-1)?.type).toBe('turn_failed')
  expect(f.events.some((event) => event.payload?.historySeeded === true)).toBe(false)
  refuse = false
  f.nextTurn()
  const done = f.send(undefined, undefined, 'Again.')
  await f.started
  // Codex answers `turn/start` before the turn can end.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  const starts = f.calls.filter((call) => call.method === 'turn/start')
  expect(JSON.stringify(starts.at(-1)?.params)).toContain('persisted question')
  expect(f.events.filter((event) => event.payload?.historySeeded === true)).toHaveLength(1)
})

// Epoch seconds, as Codex sends them.
const LIMIT_RESET_S = Math.floor(Date.now() / 1000) + 2 * 60 * 60
const PLUS_ACCOUNT = { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: null, planType: 'plus' } }
const codexWindows = () =>
  usageLimitsStore()
    .state()
    .snapshots.find((snapshot) => snapshot.provider === 'codex')

test("a ChatGPT sign-in's limits are read once as the app-server starts, and every push after merges in", async () => {
  const f = fixture({
    account: PLUS_ACCOUNT,
    rateLimits: () => ({
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: LIMIT_RESET_S },
        secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: LIMIT_RESET_S + 86_400 },
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
    }),
  })
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  expect(f.calls.filter((call) => call.method === 'account/rateLimits/read')).toEqual([
    { method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } },
  ])
  await vi.waitFor(() => expect(codexWindows()?.windows).toHaveLength(2))
  expect(codexWindows()).toMatchObject({ billing: 'subscription', plan: 'plus' })
  // A sparse push: the weekly window it leaves null keeps its reading.
  await f.message({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: LIMIT_RESET_S },
        secondary: null,
      },
    },
  })
  expect(codexWindows()?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
    ['codex:primary', 15],
    ['codex:secondary', 37],
  ])
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
})

test('the read of the limits never holds a turn up', async () => {
  const f = fixture({ account: PLUS_ACCOUNT, rateLimits: () => new Promise(() => undefined) })
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.events.at(-1)?.type).toBe('turn_completed')
})

test('an API-key sign-in has no plan limits: none are read, and none are shown', async () => {
  const f = fixture({ account: { requiresOpenaiAuth: true, account: { type: 'apiKey' } }, rateLimits: () => ({}) })
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: LIMIT_RESET_S } } },
  })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  await done
  expect(f.calls.some((call) => call.method === 'account/rateLimits/read')).toBe(false)
  expect(codexWindows()).toBeUndefined()
})

test('a turn Codex fails on a usage limit is told as a limit hit, with when the full window resets', async () => {
  const hits: UsageLimitHit[] = []
  const stop = onUsageLimitHit((hit) => hits.push(hit))
  const f = fixture({ account: PLUS_ACCOUNT })
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: LIMIT_RESET_S },
        rateLimitReachedType: 'rate_limit_reached',
      },
    },
  })
  const error = {
    message: "You've hit your usage limit. Try again later.",
    codexErrorInfo: 'usageLimitExceeded',
    additionalDetails: null,
    misalignment: null,
  }
  await f.message({
    method: 'error',
    params: { error, willRetry: false, threadId: 'native-thread', turnId: 'native-turn' },
  })
  await f.message({ method: 'turn/completed', params: { turn: { status: 'failed', error } } })
  await done
  stop()
  expect(f.events.at(-1)?.type).toBe('turn_failed')
  expect(hits).toEqual([
    { provider: 'codex', sessionId: 'session', resetsAt: LIMIT_RESET_S * 1000, windowId: null, at: expect.any(Number) },
  ])
  expect(usageRateLimit('codex')).toEqual({ limited: true, resetsAt: LIMIT_RESET_S * 1000, windowId: 'codex:primary' })
})

test('a turn that fails for another reason is no limit hit', async () => {
  const hits: UsageLimitHit[] = []
  const stop = onUsageLimitHit((hit) => hits.push(hit))
  const f = fixture({ account: PLUS_ACCOUNT })
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await f.message({
    method: 'turn/completed',
    params: { turn: { status: 'failed', error: { message: 'Overloaded', codexErrorInfo: 'serverOverloaded' } } },
  })
  await done
  stop()
  expect(hits).toEqual([])
})

// A thread goal as Codex reports it.
const codexGoal = (objective: string, status = 'active') => ({
  threadId: 'native-thread',
  objective,
  status,
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
})

// A Codex that keeps one goal, and answers the goal requests as Codex does.
function goalCodex(initial: ReturnType<typeof codexGoal> | null = null) {
  let goal = initial
  return {
    get goal() {
      return goal
    },
    answer(method: string, params: unknown) {
      const asked = params as { objective?: string; status?: string }
      if (method === 'thread/goal/get') return { goal }
      if (method === 'thread/goal/clear') {
        const cleared = goal !== null
        goal = null
        return { cleared }
      }
      goal = { ...(goal ?? codexGoal('')), ...(asked.objective ? { objective: asked.objective } : {}) }
      if (asked.status) goal.status = asked.status
      return { goal }
    },
  }
}

// Connects the chat with one ordinary turn, so later turns find the thread.
async function connected(f: ReturnType<typeof fixture>) {
  await f.adapter.startSession(f.input)
  const first = f.send()
  await f.started
  await f.message({ method: 'turn/completed', params: { turn: { id: 'native-turn', status: 'completed' } } })
  await first
  f.nextTurn()
  f.events.length = 0
  f.sessionEvents.length = 0
}

// Codex starting a turn of its own toward the goal, and saying something in it.
async function codexCarriesOn(f: ReturnType<typeof fixture>, nativeId: string, said: string) {
  await f.message({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id: nativeId } } })
  await f.message({
    method: 'item/agentMessage/delta',
    params: { threadId: 'native-thread', itemId: `${nativeId}-msg`, delta: said },
  })
}

test('/goal and an objective sets the goal Codex works toward, and the turn shows its first turn on it', async () => {
  const codex = goalCodex()
  const f = fixture({ goal: (method, params) => codex.answer(method, params) })
  await connected(f)
  const done = f.send(undefined, undefined, '/goal make the parser tests pass')
  await f.started
  expect(f.calls.find((call) => call.method === 'thread/goal/set')?.params).toEqual({
    threadId: 'native-thread',
    origin: 'user',
    objective: 'make the parser tests pass',
    status: 'active',
  })
  await codexCarriesOn(f, 'goal-turn-1', 'Running the parser tests.')
  await f.message({ method: 'turn/completed', params: { turn: { id: 'goal-turn-1', status: 'completed' } } })
  await done
  expect(f.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  expect(f.events.map((event) => [event.type, event.payload?.turnId])).toEqual([
    ['turn_started', 'turn'],
    ['session_updated', undefined],
    ['content_delta', 'turn'],
    ['turn_completed', 'turn'],
  ])
  expect(f.events[1]?.payload).toEqual({ goal: { objective: 'make the parser tests pass', status: 'active' } })
  expect(f.events.at(-1)?.payload).toMatchObject({ text: 'Running the parser tests.' })
})

test('the turns Codex starts by itself toward the goal reach the chat as turns of their own', async () => {
  const codex = goalCodex(codexGoal('make the parser tests pass'))
  const f = fixture({ goal: (method, params) => codex.answer(method, params) })
  await connected(f)
  await codexCarriesOn(f, 'goal-turn-2', 'Two tests still fail.')
  await f.message({ method: 'turn/completed', params: { turn: { id: 'goal-turn-2', status: 'completed' } } })
  await codexCarriesOn(f, 'goal-turn-3', 'All pass now.')
  await f.message({ method: 'turn/completed', params: { turn: { id: 'goal-turn-3', status: 'completed' } } })
  const turns = f.sessionEvents.filter((event) => event.type === 'turn_started')
  expect(turns).toHaveLength(2)
  const [second, third] = turns.map((event) => event.payload?.turnId as string)
  expect(second).not.toBe(third)
  // Each names the turn it follows, which the runtime may still be closing.
  expect(turns[0]?.payload?.follows).toBe('turn')
  expect(turns[1]?.payload?.follows).toBe(second)
  expect(
    f.sessionEvents
      .filter((event) => event.type !== 'session_updated')
      .map((event) => [event.type, event.payload?.turnId === second ? 'second' : 'third', event.payload?.text]),
  ).toEqual([
    ['turn_started', 'second', undefined],
    ['content_delta', 'second', 'Two tests still fail.'],
    ['turn_completed', 'second', 'Two tests still fail.'],
    ['turn_started', 'third', undefined],
    ['content_delta', 'third', 'All pass now.'],
    ['turn_completed', 'third', 'All pass now.'],
  ])
  expect(f.events).toEqual([])
  expect(f.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
})

test('Stop on a turn toward the goal pauses the goal before it interrupts, so Codex starts no next turn', async () => {
  const codex = goalCodex(codexGoal('make the parser tests pass'))
  const f = fixture({ goal: (method, params) => codex.answer(method, params) })
  await connected(f)
  await codexCarriesOn(f, 'goal-turn-2', 'Working on it.')
  await f.adapter.interrupt(f.input)
  const asked = f.calls.filter((call) => call.method === 'thread/goal/set' || call.method === 'turn/interrupt')
  expect(asked).toEqual([
    { method: 'thread/goal/set', params: { threadId: 'native-thread', origin: 'user', status: 'paused' } },
    { method: 'turn/interrupt', params: { threadId: 'native-thread', turnId: 'goal-turn-2' } },
  ])
  expect(codex.goal?.status).toBe('paused')
  expect(f.sessionEvents.at(-1)).toMatchObject({ type: 'turn_completed', payload: { interrupted: true } })
  expect(f.sessionEvents.find((event) => event.type === 'session_updated' && event.payload?.goal)?.payload).toEqual({
    goal: { objective: 'make the parser tests pass', status: 'paused' },
  })
})

test('Stop on a message turn pauses a running goal too, and with no goal only interrupts', async () => {
  const codex = goalCodex(codexGoal('keep the docs current'))
  const f = fixture({ goal: (method, params) => codex.answer(method, params) })
  await connected(f)
  const done = f.send(undefined, undefined, 'Also fix the typo.')
  await f.started
  await f.adapter.interrupt(f.input)
  await done
  expect(f.calls.filter((call) => call.method === 'thread/goal/set').map((call) => call.params)).toEqual([
    { threadId: 'native-thread', origin: 'user', status: 'paused' },
  ])

  const plain = fixture()
  await connected(plain)
  const sent = plain.send()
  await plain.started
  await plain.adapter.interrupt(plain.input)
  await sent
  expect(plain.calls.some((call) => call.method === 'thread/goal/set')).toBe(false)
  expect(plain.calls.at(-1)?.method).toBe('turn/interrupt')
})

test('a goal Codex clears tells the chat there is none any more', async () => {
  const codex = goalCodex(codexGoal('make the parser tests pass'))
  const f = fixture({ goal: (method, params) => codex.answer(method, params) })
  await connected(f)
  await f.message({ method: 'thread/goal/cleared', params: { threadId: 'native-thread' } })
  expect(f.sessionEvents.filter((event) => event.type === 'session_updated').map((event) => event.payload)).toEqual([
    { goal: null },
  ])
})

test('a resumed thread with a goal shows it, and Codex marking it met says so in the turn', async () => {
  const codex = goalCodex(codexGoal('make the parser tests pass'))
  const f = fixture({ goal: (method, params) => codex.answer(method, params) })
  await f.adapter.startSession(f.input)
  const done = f.send()
  await f.started
  await expect
    .poll(() => f.events.find((event) => event.type === 'session_updated' && event.payload?.goal)?.payload)
    .toEqual({ goal: { objective: 'make the parser tests pass', status: 'active' } })
  await f.message({
    method: 'thread/goal/updated',
    params: {
      threadId: 'native-thread',
      turnId: 'native-turn',
      goal: codexGoal('make the parser tests pass', 'complete'),
    },
  })
  await f.message({ method: 'turn/completed', params: { turn: { id: 'native-turn', status: 'completed' } } })
  await done
  expect(f.events.find((event) => event.type === 'command_output')?.payload).toMatchObject({
    output: 'Codex met the goal and stopped working toward it.',
    adapterNote: true,
  })
  expect(f.events.filter((event) => event.type === 'session_updated' && event.payload?.goal).at(-1)?.payload).toEqual({
    goal: { objective: 'make the parser tests pass', status: 'complete' },
  })
})

test('/goal alone says the goal, /goal pause pauses it and /goal clear clears it, each without a prompt', async () => {
  const codex = goalCodex(codexGoal('make the parser tests pass'))
  const f = fixture({ goal: (method, params) => codex.answer(method, params) })
  await connected(f)
  const said = async (message: string) => {
    f.events.length = 0
    await f.send(undefined, undefined, message)
    expect(f.events.at(-1)?.type).toBe('turn_completed')
    return f.events.find((event) => event.type === 'command_output')?.payload?.output
  }
  expect(await said('/goal')).toBe('Goal: make the parser tests pass (working)')
  expect(await said('/goal pause')).toBe('Goal paused. Send /goal resume to carry on.')
  expect(codex.goal?.status).toBe('paused')
  expect(await said('/goal pause')).toBe('The goal is not running (paused), so there is nothing to pause.')
  expect(await said('/goal clear')).toBe('Goal cleared. Codex no longer works toward it.')
  expect(codex.goal).toBeNull()
  expect(await said('/goal')).toBe(
    'There is no goal in this chat. Send /goal and what Codex should achieve to set one.',
  )
  expect(f.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
})

test('a Codex without goals answers /goal with a message and is not sent it as text', async () => {
  const f = fixture({
    goal: () => {
      throw new CodexRpcError('Invalid request: unknown variant `thread/goal/set`, expected one of `initialize`')
    },
  })
  await connected(f)
  await f.send(undefined, undefined, '/goal make the parser tests pass')
  expect(f.events.at(-1)).toMatchObject({
    type: 'turn_failed',
    payload: { message: 'This version of Codex has no goals. Update Codex to use /goal.', refused: true },
  })
  expect(f.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
})

test('a goal Codex does not start on at once ends the /goal turn, and its turn comes on its own later', async () => {
  vi.useFakeTimers()
  try {
    const codex = goalCodex()
    const f = fixture({ goal: (method, params) => codex.answer(method, params) })
    await connected(f)
    const done = f.send(undefined, undefined, '/goal make the parser tests pass')
    await vi.advanceTimersByTimeAsync(CODEX_GOAL_TURN_WAIT_MS)
    await done
    expect(f.events.at(-1)?.type).toBe('turn_completed')
    expect(f.events.find((event) => event.type === 'command_output')?.payload?.output).toBe(
      'Codex has the goal and starts on it as soon as it is free.',
    )
    await codexCarriesOn(f, 'goal-turn-1', 'Starting.')
    expect(f.sessionEvents.find((event) => event.type === 'turn_started')?.payload?.follows).toBe('turn')
  } finally {
    vi.useRealTimers()
  }
})

test('a message sent before the chat took up a turn Codex started by itself joins that turn', async () => {
  const codex = goalCodex(codexGoal('make the parser tests pass'))
  const f = fixture({ goal: (method, params) => codex.answer(method, params) })
  await connected(f)
  await codexCarriesOn(f, 'goal-turn-2', 'Looking.')
  const done = f.send(undefined, undefined, 'Also check the lexer.')
  await f.started
  // Its own turn is over here; the message's turn carries Codex's from now on.
  expect(f.sessionEvents.at(-1)?.type).toBe('turn_completed')
  await f.message({
    method: 'item/agentMessage/delta',
    params: { threadId: 'native-thread', itemId: 'goal-turn-2-msg-2', delta: 'The lexer is fine.' },
  })
  await f.message({ method: 'turn/completed', params: { turn: { id: 'goal-turn-2', status: 'completed' } } })
  await done
  expect(f.events.map((event) => [event.type, event.payload?.turnId])).toEqual([
    ['turn_started', 'turn'],
    ['content_delta', 'turn'],
    ['turn_completed', 'turn'],
  ])
})
