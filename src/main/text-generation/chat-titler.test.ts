import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import type {
  ChatTitleRequest,
  TextGenerationResult,
  TextGenerationEngineSettings,
} from '../../shared/text-generation/contract'
import { deriveWorkspaceTitle } from '../../shared/workspace-title'
import { createChatTitler } from './chat-titler'

const PROMPT = 'Fix the upload retry on flaky networks'
// The heuristic's own answer, whatever its rules make of the prompt.
const HEURISTIC = deriveWorkspaceTitle(PROMPT)!

type Workspace = { name: string; titleLocked?: boolean }

/**
 * A titler over a registry of plain records, a hand-fed event stream and a
 * generator whose answers the test gives when it chooses.
 */
function harness(
  options: {
    workspaces?: Record<string, Workspace>
    settings?: TextGenerationEngineSettings
    installed?: Record<string, boolean>
    answer?: (request: ChatTitleRequest, call: number) => TextGenerationResult
  } = {},
) {
  const workspaces: Record<string, Workspace> = options.workspaces ?? { 'ws-1': { name: 'Chat 3' } }
  const listeners = new Set<(event: ConversationEvent) => void>()
  const requests: ChatTitleRequest[] = []
  const renames: Array<[string, string]> = []
  const logged: string[] = []
  const pending: Array<() => void> = []
  const titler = createChatTitler(
    {
      onEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      getWorkspace: (id) => (workspaces[id] ? { ...workspaces[id] } : null),
      rename: (id, name) => {
        const workspace = workspaces[id]
        if (!workspace) return false
        workspace.name = name
        workspace.titleLocked = true
        renames.push([id, name])
        return true
      },
      settings: () => options.settings ?? { enabled: true, engine: null },
      candidateClis: () => ['cursor', 'claude-code', 'codex'],
      installed: (cli) => options.installed?.[cli],
      cliRuntimes: () => ({ 'claude-code': { command: 'claude' } }),
      generate: (request) => {
        requests.push(request)
        const call = requests.length
        return new Promise((resolve) => {
          pending.push(() => resolve(options.answer?.(request, call) ?? { ok: true, value: 'Upload retry fix', ms: 1 }))
        })
      },
      log: (message) => logged.push(message),
    },
    { wait: async () => undefined },
  )

  let seq = 0
  const send = (text: string, extra: { workspaceId?: string; origin?: unknown } = {}): void => {
    seq += 1
    const event: ConversationEvent = {
      id: `evt-${seq}`,
      sessionId: 'conv_1',
      workspaceId: extra.workspaceId ?? 'ws-1',
      agentId: 'agent-claude-code-1',
      providerId: 'claude-agent',
      modelId: 'default',
      type: 'user_message',
      createdAt: seq,
      payload: { turnId: `turn-${seq}`, text, ...(extra.origin ? { origin: extra.origin } : {}) },
    }
    for (const listener of listeners) listener(event)
  }
  // Answer every generation asked so far, and let the answers land.
  const answerAll = async (): Promise<void> => {
    for (let round = 0; round < 5; round += 1) {
      for (const resolve of pending.splice(0)) resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  return { titler, workspaces, requests, renames, logged, send, answerAll, listeners }
}

test('a "Chat N" chat takes the heuristic title from its first message at once, locked', () => {
  const { workspaces, send } = harness()
  send(PROMPT)
  assert.equal(workspaces['ws-1']!.name, HEURISTIC)
  assert.equal(workspaces['ws-1']!.titleLocked, true)
})

test("the model's title replaces exactly the heuristic name it was asked to replace", async () => {
  const { workspaces, requests, renames, send, answerAll } = harness()
  send(PROMPT)
  assert.equal(requests.length, 1)
  // The engine the window would pick: the first supported CLI, at its cheap default.
  assert.deepEqual(requests[0], {
    prompt: PROMPT,
    engine: { cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'low' },
    cliRuntimes: { 'claude-code': { command: 'claude' } },
  })
  await answerAll()
  assert.equal(workspaces['ws-1']!.name, 'Upload retry fix')
  assert.equal(workspaces['ws-1']!.titleLocked, true)
  assert.deepEqual(
    renames.map(([, name]) => name),
    [HEURISTIC, 'Upload retry fix'],
  )
})

test('a hand rename while the model writes stands', async () => {
  const { workspaces, send, answerAll } = harness()
  send(PROMPT)
  workspaces['ws-1'] = { name: 'Uploads', titleLocked: true }
  await answerAll()
  assert.equal(workspaces['ws-1']!.name, 'Uploads')
})

test('a locked name is never touched, and no model call is spent on it', async () => {
  const { workspaces, requests, renames, send, answerAll } = harness({
    workspaces: { 'ws-1': { name: 'Billing', titleLocked: true } },
  })
  send(PROMPT)
  await answerAll()
  assert.equal(workspaces['ws-1']!.name, 'Billing')
  assert.deepEqual(requests, [])
  assert.deepEqual(renames, [])
})

test("Studio's own messages title nothing", async () => {
  const { workspaces, requests, send, answerAll } = harness()
  send('The agent you launched has finished: Fix the upload retry', {
    origin: { kind: 'studio', reason: 'agent-notice' },
  })
  send('Continue where you left off', { origin: { kind: 'studio', reason: 'usage-resume' } })
  await answerAll()
  assert.equal(workspaces['ws-1']!.name, 'Chat 3')
  assert.deepEqual(requests, [])
})

test('with model titles off, the heuristic alone names the chat', async () => {
  const { workspaces, requests, send, answerAll } = harness({
    settings: { enabled: false, engine: { cli: 'codex', model: '' } },
  })
  send(PROMPT)
  await answerAll()
  assert.equal(workspaces['ws-1']!.name, HEURISTIC)
  assert.deepEqual(requests, [])
})

test('with no supported CLI installed, the heuristic alone names the chat', async () => {
  const { workspaces, requests, send } = harness({ installed: { 'claude-code': false, codex: false } })
  send(PROMPT)
  assert.equal(workspaces['ws-1']!.name, HEURISTIC)
  assert.deepEqual(requests, [])
})

test('the engine chosen in Settings is the one asked', () => {
  const { requests, send } = harness({
    settings: { enabled: true, engine: { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'medium' } },
  })
  send(PROMPT)
  assert.deepEqual(requests[0]?.engine, { cli: 'codex', model: 'gpt-5.6-luna', reasoning: 'medium' })
})

test('one model call per chat, however many messages follow', async () => {
  const { workspaces, requests, send, answerAll } = harness({
    answer: () => ({ ok: false, code: 'guardrail', message: 'no usable title' }),
  })
  // Neither yields a heuristic title, so the name stays open through both.
  send('hi')
  send('ok')
  assert.equal(workspaces['ws-1']!.titleLocked, undefined)
  await answerAll()
  send(PROMPT)
  await answerAll()
  assert.equal(workspaces['ws-1']!.name, HEURISTIC)
  assert.equal(requests.length, 1)
})

test('a first message the heuristic cannot title leaves the name open for the next one', async () => {
  const { workspaces, requests, send, answerAll } = harness({
    answer: () => ({ ok: false, code: 'unavailable', message: 'claude-code is not installed on this machine.' }),
  })
  send('hi')
  assert.equal(workspaces['ws-1']!.name, 'Chat 3')
  assert.equal(workspaces['ws-1']!.titleLocked, undefined)
  // The model is still asked from the first message, as the window asks it.
  assert.equal(requests[0]?.prompt, 'hi')
  await answerAll()
  send(PROMPT)
  assert.equal(workspaces['ws-1']!.name, HEURISTIC)
})

test("a model title from a message the heuristic passed over lands on the app's name", async () => {
  const { workspaces, send, answerAll } = harness({ answer: () => ({ ok: true, value: 'Greeting', ms: 1 }) })
  send('hi')
  await answerAll()
  assert.equal(workspaces['ws-1']!.name, 'Greeting')
  assert.equal(workspaces['ws-1']!.titleLocked, true)
})

test('pictures first, words later: the words title the chat', () => {
  const { workspaces, requests, send } = harness()
  // A phone's New chat with pictures: the chat is made, then its first turn
  // carries the pictures and, here, no words.
  send('')
  send('   ')
  assert.equal(workspaces['ws-1']!.name, 'Chat 3')
  assert.deepEqual(requests, [])
  send('Why does this screen crop the header?')
  assert.equal(workspaces['ws-1']!.name, deriveWorkspaceTitle('Why does this screen crop the header?'))
  assert.equal(requests.length, 1)
})

test('a chat in a workspace this process does not hold is left alone', async () => {
  const { requests, renames, send, answerAll } = harness()
  send(PROMPT, { workspaceId: 'ws-elsewhere' })
  await answerAll()
  assert.deepEqual(requests, [])
  assert.deepEqual(renames, [])
})

test('a failure about the transport is tried once more, and a failed title is written down', async () => {
  const { workspaces, requests, logged, send, answerAll } = harness({
    answer: (_request, call) =>
      call === 1
        ? { ok: false, code: 'transport', message: 'claude-code exited 1.' }
        : { ok: false, code: 'timeout', message: 'claude-code did not answer in time.' },
  })
  send(PROMPT)
  await answerAll()
  assert.equal(requests.length, 2)
  assert.equal(workspaces['ws-1']!.name, HEURISTIC)
  assert.deepEqual(logged, ['claude-code · claude-haiku-4-5 · low: timeout — claude-code did not answer in time.'])
})

test('after dispose it hears nothing, and a title still being written does not land', async () => {
  const { titler, workspaces, listeners, send, answerAll } = harness()
  send(PROMPT)
  titler.dispose()
  await answerAll()
  assert.equal(workspaces['ws-1']!.name, HEURISTIC)
  assert.equal(listeners.size, 0)
})
