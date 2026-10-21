import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import { createCodexConversationProvider } from './providers/codex-conversation-provider'
import type { CodexRpcOptions } from './providers/codex-json-rpc'
import type { ConversationEvent } from '../shared/conversation-runtime'

const runtimes = new Set<ConversationRuntime>()
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all(Array.from(runtimes, (runtime) => runtime.shutdown().catch(() => undefined)))
  runtimes.clear()
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

/**
 * A chat on the Codex adapter, over a stand-in for Codex's app-server that
 * keeps a goal and lets the test say what Codex sends.
 */
async function codexChat() {
  let connection: CodexRpcOptions | undefined
  const calls: Array<{ method: string; params: unknown }> = []
  let goal: { objective: string; status: string } | null = null
  const adapter = createCodexConversationProvider({
    resolveExecutable: async () => '/usr/bin/codex',
    buildEnv: async () => ({}),
    createTransport(options) {
      connection = options
      return {
        pid: 123,
        async request(method, params) {
          calls.push({ method, params })
          const asked = (params ?? {}) as { objective?: string; status?: string }
          if (method === 'account/read') return { requiresOpenaiAuth: true, account: { type: 'chatgpt' } }
          if (method === 'thread/start') return { thread: { id: 'native-thread' } }
          if (method === 'turn/start') return { turn: { id: 'native-turn' } }
          if (method === 'skills/list') return { data: [] }
          if (method === 'thread/goal/get') return { goal }
          if (method === 'thread/goal/set') {
            goal = { objective: asked.objective ?? goal?.objective ?? '', status: asked.status ?? 'active' }
            return { goal: { threadId: 'native-thread', ...goal } }
          }
          if (method === 'turn/interrupt') {
            const turnId = (params as { turnId: string }).turnId
            await connection!.onMessage({
              method: 'turn/completed',
              params: { threadId: 'native-thread', turn: { id: turnId, status: 'interrupted' } },
            })
          }
          return {}
        },
        notify: () => undefined,
        respond: () => undefined,
        reject: () => undefined,
        close: () => undefined,
      }
    },
  })
  const runtime = new ConversationRuntime({
    adapters: [adapter],
    getProviderById: () => undefined,
    secretStore: {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    },
  })
  runtimes.add(runtime)
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-codex-goal-'))
  roots.add(workspaceRoot)
  const events: ConversationEvent[] = []
  runtime.onEvent((event) => events.push(event))
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'codex-agent',
    modelId: 'gpt-6-sol',
  })
  if (!started.ok) throw new Error(started.message)
  const sessionId = started.session.sessionId
  const send = (message: string) => runtime.sendTurn({ sessionId, message })
  const status = () => {
    const listed = runtime.listSessions()
    return listed.ok ? listed.sessions.find((session) => session.sessionId === sessionId)?.status : undefined
  }
  // What Codex sends: several lines are read off one chunk, one after another.
  const codex = async (...messages: Array<{ method: string; params: Record<string, unknown> }>) => {
    for (const message of messages) await connection!.onMessage(message)
  }
  const turnStarted = (id: string) => ({ method: 'turn/started', params: { threadId: 'native-thread', turn: { id } } })
  const said = (id: string, delta: string) => ({
    method: 'item/agentMessage/delta',
    params: { threadId: 'native-thread', itemId: `${id}-msg`, delta },
  })
  const turnCompleted = (id: string) => ({
    method: 'turn/completed',
    params: { threadId: 'native-thread', turn: { id, status: 'completed' } },
  })
  return { runtime, sessionId, calls, events, send, status, codex, turnStarted, said, turnCompleted }
}

async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await new Promise((r) => setTimeout(r, 5))
  expect(condition()).toBe(true)
}

test('a turn Codex starts toward its goal as the last one ends keeps the chat working, as a turn of its own', async () => {
  const chat = await codexChat()
  const setting = chat.send('/goal make the parser tests pass')
  await until(() => chat.calls.some((call) => call.method === 'thread/goal/set'))
  await chat.codex(chat.turnStarted('goal-1'), chat.said('goal-1', 'Running the tests.'))
  // Codex starts its next turn the moment it ends this one.
  await chat.codex(chat.turnCompleted('goal-1'), chat.turnStarted('goal-2'), chat.said('goal-2', 'Two still fail.'))
  expect((await setting).ok).toBe(true)
  await until(() =>
    chat.events.some((event) => event.type === 'content_delta' && event.payload?.text === 'Two still fail.'),
  )
  expect(chat.status()).toBe('active')
  const turns = chat.events.filter((event) => event.type === 'turn_started').map((event) => event.payload?.turnId)
  expect(turns).toHaveLength(2)
  expect(chat.events.filter((event) => event.type === 'user_message')).toHaveLength(1)
  await chat.codex(chat.turnCompleted('goal-2'))
  await until(() => chat.status() === 'ready')
  // The sidebar's preview is the newest turn's reply, not the two run together.
  const listed = chat.runtime.listSessions()
  expect(listed.ok ? listed.sessions[0]?.lastAssistantText : undefined).toBe('Two still fail.')
  expect(
    chat.events
      .filter((event) => event.type === 'turn_completed')
      .map((event) => [event.payload?.turnId === turns[1], event.payload?.text]),
  ).toEqual([
    [false, 'Running the tests.'],
    [true, 'Two still fail.'],
  ])
})

test('a message sent while Codex works toward its goal by itself waits, and goes once that turn ends', async () => {
  const chat = await codexChat()
  const setting = chat.send('/goal make the parser tests pass')
  await until(() => chat.calls.some((call) => call.method === 'thread/goal/set'))
  await chat.codex(chat.turnStarted('goal-1'), chat.turnCompleted('goal-1'), chat.turnStarted('goal-2'))
  await setting
  await until(() => chat.events.filter((event) => event.type === 'turn_started').length === 2)
  const refused = await chat.send('Also check the lexer.')
  expect(refused).toMatchObject({ ok: false, code: 'busy' })
  expect(chat.calls.filter((call) => call.method === 'turn/start')).toHaveLength(0)
  await chat.codex(chat.turnCompleted('goal-2'))
  await until(() => chat.status() === 'ready')
  const sending = chat.send('Also check the lexer.')
  await until(() => chat.calls.some((call) => call.method === 'turn/start'))
  await chat.codex(chat.turnCompleted('native-turn'))
  expect((await sending).ok).toBe(true)
})

test('Stop on a turn Codex started toward its goal pauses the goal, then ends the turn', async () => {
  const chat = await codexChat()
  const setting = chat.send('/goal make the parser tests pass')
  await until(() => chat.calls.some((call) => call.method === 'thread/goal/set'))
  await chat.codex(chat.turnStarted('goal-1'), chat.turnCompleted('goal-1'), chat.turnStarted('goal-2'))
  await setting
  await until(() => chat.status() === 'active' && chat.events.filter((e) => e.type === 'turn_started').length === 2)
  expect((await chat.runtime.interrupt({ sessionId: chat.sessionId })).ok).toBe(true)
  expect(
    chat.calls
      .filter((call) => call.method === 'turn/interrupt' || call.method === 'thread/goal/set')
      .map((call) => [call.method, (call.params as { status?: string; turnId?: string }).status ?? null]),
  ).toEqual([
    ['thread/goal/set', 'active'],
    ['thread/goal/set', 'paused'],
    ['turn/interrupt', null],
  ])
  expect((chat.calls.at(-1)?.params as { turnId?: string }).turnId).toBe('goal-2')
  expect(chat.status()).toBe('ready')
})
