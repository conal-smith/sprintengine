import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// Handoff in the Claude provider: the child goes, the next child starts a new
// session, and the next message that is not a command opens with the pointer
// to the file, once, in the words the person chose. The child may read that
// one file unasked.

type Child = { options: Record<string, unknown>; prompts: unknown[]; emit: (message: Record<string, unknown>) => void }

const FILE = '/Users/dev/.sprintengine/workspaces/app/conversations/workspace/handoffs/agent-20261021-0942.md'

const SEED = `You're picking up a conversation from an earlier session, which was handed off to save cost. The text of that conversation (messages only, no tool calls) is at \`${FILE}\`. Read it to see where things stood.`

function harness() {
  const children: Child[] = []
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
    const stop = () => {
      ended = true
      wake?.()
    }
    ;(params.options.abortController as AbortController | undefined)?.signal.addEventListener('abort', stop)
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
      interrupt: async () => stop(),
      setPermissionMode: async () => undefined,
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
  })
  const turn = (turnId: string, overrides: Partial<MockAdapterTurnInput> = {}): MockAdapterTurnInput => ({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot: '/Users/dev/app',
    turnId,
    requestId: `approval_${turnId}`,
    message: 'hello',
    ...overrides,
  })
  const prompts = () => children.flatMap((child) => child.prompts)
  // Send `message`, wait for a child to read it, answer it, and collect the turn's events.
  const run = async (turnId: string, message: string, sessionId = 'native-1'): Promise<ConversationEvent[]> => {
    const count = prompts().length
    const stream = (await adapter.sendTurn(turn(turnId, { message }))) as AsyncIterable<ConversationEvent>
    const events: ConversationEvent[] = []
    const done = (async () => {
      for await (const event of stream) events.push(event)
    })()
    for (let attempt = 0; attempt < 2000; attempt++) {
      if (prompts().length > count) break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const child = children.at(-1)!
    child.emit({ type: 'system', subtype: 'init', session_id: sessionId })
    child.emit({
      type: 'assistant',
      uuid: `${turnId}-entry`,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'ok' }] },
    })
    child.emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId })
    await done
    return events
  }
  // The text of the message the child was handed last.
  const lastPrompt = (): string => {
    const content = (prompts().at(-1) as { message?: { content?: unknown } } | undefined)?.message?.content
    if (typeof content === 'string') return content
    return Array.isArray(content) ? content.map((block) => (block as { text?: string }).text ?? '').join('') : ''
  }
  return { adapter, children, turn, run, lastPrompt }
}

const seeded = (events: ConversationEvent[]) =>
  events.filter((event) => event.type === 'session_updated' && event.payload?.historySeeded === true).length

test('a handoff drops the child, and the next message starts a new session opening with the pointer, once', async () => {
  const h = harness()
  try {
    await h.adapter.startSession(h.turn('turn_1'))
    await h.run('turn_1', 'make it check the tag')
    assert.deepEqual(await h.adapter.handoff!({ ...h.turn('x'), handoffPath: FILE }), { ok: true })
    assert.equal(h.adapter.listLiveSessions()[0]?.hasChildProcess, false)

    const first = await h.run('turn_2', 'where were we?', 'native-2')
    assert.equal(h.children.length, 2)
    // A new session: nothing resumed.
    assert.equal(h.children[1].options.resume, undefined)
    assert.equal(h.lastPrompt(), `${SEED}\n\nwhere were we?`)
    assert.equal(seeded(first), 1)

    const second = await h.run('turn_3', 'and then?', 'native-2')
    assert.equal(h.lastPrompt(), 'and then?')
    assert.equal(seeded(second), 0)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a command after a handoff goes as it is, and the pointer waits for the next message', async () => {
  const h = harness()
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), handoffPath: FILE })
    const command = await h.run('turn_1', '/context', 'native-2')
    assert.equal(h.lastPrompt(), '/context')
    assert.equal(seeded(command), 0)
    const prose = await h.run('turn_2', 'now the real question', 'native-2')
    assert.equal(h.lastPrompt(), `${SEED}\n\nnow the real question`)
    assert.equal(seeded(prose), 1)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a handed-off session may read its file unasked, in every child it spawns', async () => {
  const h = harness()
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), allowedTools: ['Grep'], handoffPath: FILE })
    await h.run('turn_1', 'hello', 'native-2')
    assert.deepEqual(h.children[0].options.allowedTools, ['Grep', `Read(/${FILE})`])
    h.adapter.disposeChildProcess('conv_1')
    await h.run('turn_2', 'again', 'native-2')
    assert.deepEqual(h.children[1].options.allowedTools, ['Grep', `Read(/${FILE})`])
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a handoff path that would read as a pattern gets no allow rule, so its read asks', async () => {
  for (const path of [
    '/Users/dev/.sprintengine/workspaces/app/conversations/a*b/handoffs/agent-20261021-0942.md',
    '/Users/dev (work)/.sprintengine/workspaces/app/conversations/c/handoffs/agent-20261021-0942.md',
    '/Users/dev/.sprintengine/workspaces/app/conversations/[x]/handoffs/agent-20261021-0942.md',
    '/Users/dev/.sprintengine/workspaces/app/conversations/{a,b}/handoffs/agent?.md',
  ]) {
    const h = harness()
    try {
      await h.adapter.startSession({ ...h.turn('turn_1'), allowedTools: ['Grep'], handoffPath: path })
      await h.run('turn_1', 'hello', 'native-2')
      assert.deepEqual(h.children[0].options.allowedTools, ['Grep'], path)
    } finally {
      await h.adapter.disposeAll()
    }
  }
})

test('a rewind before the handoff forgets the pointer; one back to its start owes it again', async () => {
  const h = harness()
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), handoffPath: FILE })
    await h.adapter.rewind({ ...h.turn('x'), cursor: { sessionId: 'native-1', at: 'entry-1' } })
    await h.run('turn_1', 'back before it')
    assert.equal(h.lastPrompt(), 'back before it')
    assert.equal(h.children[0].options.allowedTools, undefined)

    await h.adapter.rewind({ ...h.turn('x'), cursor: null, handoffPath: FILE })
    await h.run('turn_2', 'from the top of the new one', 'native-3')
    assert.equal(h.lastPrompt(), `${SEED}\n\nfrom the top of the new one`)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a handoff is refused while a turn runs', async () => {
  const h = harness()
  try {
    await h.adapter.startSession(h.turn('turn_1'))
    const stream = (await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>
    const done = (async () => {
      for await (const _event of stream) void _event
    })()
    for (let attempt = 0; attempt < 2000 && !h.children[0]?.prompts.length; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    const refused = await h.adapter.handoff!({ ...h.turn('x'), handoffPath: FILE })
    assert.deepEqual(refused, { ok: false, message: 'Stop the running turn before handing the chat off.' })
    h.children[0]!.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-1' })
    await done
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a folder the session is handed files in may be read unasked, with everything in it', async () => {
  const h = harness()
  const folder = '/Users/dev/Library/Application Support/SprintEngine/conversation-attachments/0123abcd'
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), allowedTools: ['Grep'], readableDirectories: [folder] })
    await h.run('turn_1', 'hello', 'native-2')
    assert.deepEqual(h.children[0].options.allowedTools, ['Grep', `Read(/${folder}/**)`])
  } finally {
    await h.adapter.disposeAll()
  }
  const patterned = harness()
  try {
    await patterned.adapter.startSession({
      ...patterned.turn('turn_1'),
      allowedTools: ['Grep'],
      readableDirectories: ['/Users/dev (work)/attachments'],
    })
    await patterned.run('turn_1', 'hello', 'native-2')
    assert.deepEqual(patterned.children[0].options.allowedTools, ['Grep'], 'a path that reads as a pattern asks')
  } finally {
    await patterned.adapter.disposeAll()
  }
})
