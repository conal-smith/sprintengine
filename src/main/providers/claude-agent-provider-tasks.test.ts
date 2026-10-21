import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

import { projectConversation } from '../../../packages/conversation-timeline/src/conversationProjection'
import { deriveTodoProgress } from '../../../packages/conversation-timeline/src/todoProgress'
import type { ConversationEvent, ConversationMcpServer } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider, mapSdkMessage } from './claude-agent-provider'
import type { ClaudeTaskList } from './claude-task-list'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// Claude Code 2.1.294 run headless with CLAUDE_CODE_ENABLE_TODO_TOOLS=1 and
// asked for a three-step plan: what it streamed, cut down to the messages a
// chat reads (thinking and usage left out, its folder renamed).
const CAPTURED = readFileSync(join(__dirname, '../../../tests/fixtures/claude-code/task-tools.stream.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Record<string, unknown>)

function mapper() {
  const state = {
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'haiku',
    providerSessionId: null as string | null,
    turn: { turnId: 'turn_1' },
    claudeTasks: undefined as ClaudeTaskList | undefined,
  }
  const events: ConversationEvent[] = [
    event('user_message', { turnId: 'turn_1', text: 'Plan a tiny 3-step job' }),
    event('turn_started', { turnId: 'turn_1' }),
  ]
  const read = (message: Record<string, unknown>) => {
    for (const mapped of mapSdkMessage(state, message, { saveToolImages: false })) events.push(mapped)
  }
  const progress = () => {
    const shown = events.map((entry, index) => ({ ...entry, id: `evt_${index}`, seq: index + 1 }))
    return deriveTodoProgress(projectConversation(shown).entries, true)
  }
  return { state, events, read, progress }
}

function event(type: ConversationEvent['type'], payload: Record<string, unknown>): ConversationEvent {
  return {
    id: '',
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'haiku',
    type,
    createdAt: 0,
    payload,
  }
}

const toolUse = (id: string, name: string, input: Record<string, unknown>, parentToolUseId: string | null = null) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  parent_tool_use_id: parentToolUseId,
})
const toolResult = (
  id: string,
  text: string,
  result: unknown,
  options: { isError?: boolean; parentToolUseId?: string } = {},
) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(options.isError ? { is_error: true } : {}) }],
  },
  parent_tool_use_id: options.parentToolUseId ?? null,
  tool_use_result: result,
})

test('the plan a real Claude Code keeps with its task tools reaches the todo strip, step by step', () => {
  const { read, progress } = mapper()
  const seen: Array<string | null> = []
  for (const message of CAPTURED) {
    read(message)
    const now = progress()
    const line = now ? `${now.completed}/${now.total} ${now.current}` : null
    if (seen.at(-1) !== line) seen.push(line)
  }
  expect(seen).toEqual([
    null,
    '0/1 Read the brief',
    '0/2 Read the brief',
    '0/3 Read the brief',
    '1/3 Draft the answer',
    '2/3 Check the answer',
    '3/3 Check the answer',
    // The turn's result: a list finished in a turn that ended has nothing
    // left to track.
    null,
  ])
})

test('a task tool row is a todo row, announced again with the list its result left', () => {
  const { read, events } = mapper()
  read(toolUse('toolu_a', 'TaskCreate', { subject: 'Read the brief', description: 'Read it' }))
  read(
    toolResult('toolu_a', 'Task #1 created successfully: Read the brief', {
      task: { id: '1', subject: 'Read the brief' },
    }),
  )
  read(toolUse('toolu_b', 'TaskUpdate', { taskId: '1', status: 'in_progress' }))
  const tools = events.filter((entry) => entry.type === 'tool_started' || entry.type === 'tool_output')
  expect(tools.map((entry) => [entry.type, entry.payload?.toolUseId, entry.payload?.kind])).toEqual([
    ['tool_started', 'toolu_a', 'todo'],
    ['tool_started', 'toolu_a', 'todo'],
    ['tool_output', 'toolu_a', undefined],
    ['tool_started', 'toolu_b', 'todo'],
  ])
  // Made with the list as it stood, announced again with the task in it; the
  // update's row starts from that list.
  expect((tools[0]!.payload?.input as { todos: unknown[] }).todos).toEqual([])
  expect(tools[1]!.payload?.input).toEqual({
    subject: 'Read the brief',
    description: 'Read it',
    todos: [{ content: 'Read the brief', status: 'pending' }],
  })
  expect((tools[3]!.payload?.input as { todos: unknown[] }).todos).toEqual([
    { content: 'Read the brief', status: 'pending' },
  ])
})

test('a task tool that failed leaves the chat’s list as it was', () => {
  const { read, state, events } = mapper()
  read(toolUse('toolu_a', 'TaskCreate', { subject: 'Read the brief' }))
  read(
    toolResult('toolu_a', 'Task #1 created successfully: Read the brief', {
      task: { id: '1', subject: 'Read the brief' },
    }),
  )
  read(toolUse('toolu_b', 'TaskUpdate', { taskId: '1', status: 'completed' }))
  read(toolResult('toolu_b', '<tool_use_error>Task not found</tool_use_error>', undefined, { isError: true }))
  // An agent's results are text alone: an update a hook blocked says so in
  // words, and one that errored is marked so.
  read(toolUse('toolu_c', 'TaskUpdate', { taskId: '1', status: 'completed' }, 'toolu_agent'))
  read(toolResult('toolu_c', 'Tests must pass before completing.', undefined, { parentToolUseId: 'toolu_agent' }))
  read(toolUse('toolu_d', 'TaskUpdate', { taskId: '1', status: 'completed' }, 'toolu_agent'))
  read(toolResult('toolu_d', 'Updated task #1 status', undefined, { isError: true, parentToolUseId: 'toolu_agent' }))
  expect(Array.from(state.claudeTasks?.values() ?? [])).toEqual([{ subject: 'Read the brief', status: 'pending' }])
  for (const id of ['toolu_b', 'toolu_c', 'toolu_d'])
    expect(events.filter((entry) => entry.type === 'tool_started' && entry.payload?.toolUseId === id)).toHaveLength(1)
})

// Claude Code keeps one task list per session, and an agent's TaskCreate and
// TaskUpdate write that same list (2.1.299 names the list for the session,
// whoever calls). An agent's results reach the stream as their text alone.
test('an agent’s task creates and updates reach the chat’s list, and its todo strip, from its own lane', () => {
  const { read, state, events, progress } = mapper()
  read(toolUse('toolu_a', 'TaskCreate', { subject: 'Read the brief' }))
  read(
    toolResult('toolu_a', 'Task #1 created successfully: Read the brief', {
      task: { id: '1', subject: 'Read the brief' },
    }),
  )
  read(toolUse('toolu_agent', 'Agent', { description: 'Work the plan', prompt: 'Do the tasks' }))
  read(toolUse('toolu_c', 'TaskUpdate', { taskId: '1', status: 'completed' }, 'toolu_agent'))
  read(toolResult('toolu_c', 'Updated task #1 status', undefined, { parentToolUseId: 'toolu_agent' }))
  read(toolUse('toolu_d', 'TaskCreate', { subject: 'Check the answer' }, 'toolu_agent'))
  read(
    toolResult('toolu_d', 'Task #2 created successfully: Check the answer', undefined, {
      parentToolUseId: 'toolu_agent',
    }),
  )
  expect(Array.from(state.claudeTasks?.values() ?? [])).toEqual([
    { subject: 'Read the brief', status: 'completed' },
    { subject: 'Check the answer', status: 'pending' },
  ])
  expect(progress()).toMatchObject({ completed: 1, total: 2, current: 'Check the answer' })
  // The agent's calls are drawn as the tools they are, in its lane.
  const agentRows = events.filter(
    (entry) => entry.type === 'tool_started' && ['toolu_c', 'toolu_d'].includes(String(entry.payload?.toolUseId)),
  )
  expect(agentRows.map((entry) => [entry.payload?.kind, entry.payload?.parentToolUseId])).toEqual([
    ['other', 'toolu_agent'],
    ['other', 'toolu_agent'],
  ])
  // The chat's own row, announced again, is still finished.
  const shown = events.map((entry, index) => ({ ...entry, id: `evt_${index}`, seq: index + 1 }))
  const row = projectConversation(shown).entries.find((entry) => entry.kind === 'tool' && entry.id === 'toolu_a')
  expect(row).toMatchObject({ status: 'done', output: 'Task #1 created successfully: Read the brief' })
})

test('the list carries over from one turn to the next', () => {
  const { read, state } = mapper()
  read(toolUse('toolu_a', 'TaskCreate', { subject: 'Read the brief' }))
  read(
    toolResult('toolu_a', 'Task #1 created successfully: Read the brief', {
      task: { id: '1', subject: 'Read the brief' },
    }),
  )
  state.turn = { turnId: 'turn_2' }
  read(toolUse('toolu_b', 'TaskUpdate', { taskId: '1', status: 'completed' }))
  read(toolResult('toolu_b', 'Updated task #1 status', { success: true, taskId: '1', updatedFields: ['status'] }))
  expect(Array.from(state.claudeTasks?.values() ?? [])).toEqual([{ subject: 'Read the brief', status: 'completed' }])
})

// A Claude chat's child as the provider starts it, with the options it was
// started with kept for the test to read.
function harness(baseEnv: Record<string, string> = { PATH: '/usr/bin' }) {
  const options: Record<string, unknown>[] = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    options.push(params.options)
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    void (async () => {
      for await (const _message of params.prompt) {
        pending.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'tasks' })
        wake?.()
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ ...baseEnv }),
    resolveStudioMcpServer: async () => null as ConversationMcpServer | null,
  })
  const turn: MockAdapterTurnInput = {
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot: '/Users/dev/app',
    turnId: 'turn_1',
    requestId: 'approval_1',
    message: 'hello',
    permissionPreset: 'manual',
  }
  const firstTurn = async () => {
    await adapter.startSession(turn)
    for await (const _event of (await adapter.sendTurn(turn)) as AsyncIterable<ConversationEvent>) {
      // Drained to the result.
    }
    await adapter.disposeAll()
    return options.at(-1)!
  }
  return { firstTurn }
}

test('a Claude chat starts its child with the task tools on', async () => {
  const options = await harness().firstTurn()
  expect((options.env as Record<string, string>).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1')
  expect((options.env as Record<string, string>).PATH).toBe('/usr/bin')
})

test('a value the person’s environment sets for the task tools stands, off included', async () => {
  const options = await harness({ PATH: '/usr/bin', CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }).firstTurn()
  expect((options.env as Record<string, string>).CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('0')
})

test('Manual asks before no task tool call, as it asks before no todo write, nor before loading the tools', async () => {
  const options = await harness().firstTurn()
  const [preToolUse] = (
    options.hooks as { PreToolUse: Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }> }
  ).PreToolUse[0]!.hooks
  for (const tool_name of ['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite', 'ToolSearch'])
    expect(await preToolUse!({ hook_event_name: 'PreToolUse', tool_name, tool_use_id: 'toolu_1' })).toEqual({})
  expect(await preToolUse!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_2' })).toMatchObject(
    {
      hookSpecificOutput: { permissionDecision: 'ask' },
    },
  )
})
