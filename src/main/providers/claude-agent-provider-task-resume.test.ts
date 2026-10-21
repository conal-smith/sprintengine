import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// The chat's task list is held in memory. A chat resumed after the app
// restarted starts it from the list Claude Code left on disk, so the first
// task tool row shows the whole plan, not the one task it touched.

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const TURN: MockAdapterTurnInput = {
  sessionId: 'conv_1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: CLAUDE_AGENT_PROVIDER_ID,
  modelId: 'sonnet',
  workspaceRoot: '/Users/dev/app',
  turnId: 'turn_1',
  requestId: 'approval_1',
  message: 'Carry on',
}

const storedTask = (id: string, subject: string, status: string) =>
  JSON.stringify({ id, subject, description: '', status, blocks: [], blockedBy: [] })

async function configDirWith(listId: string, files: Record<string, string>): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), 'claude-task-resume-'))
  roots.push(configDir)
  await mkdir(join(configDir, 'tasks', listId), { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(join(configDir, 'tasks', listId, name), text)
  return configDir
}

// One turn of a chat whose child calls TaskUpdate on task 2 and is told it
// went through; the todos its row was last announced with.
async function updateRowTodos(env: Record<string, string>, resumeSessionId?: string): Promise<unknown> {
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    void (async () => {
      for await (const _message of params.prompt) {
        pending.push(
          { type: 'system', subtype: 'init', session_id: 'sess_1', permissionMode: 'default' },
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'toolu_b', name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } },
              ],
            },
            parent_tool_use_id: null,
          },
          {
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'Updated task #2 status' }],
            },
            parent_tool_use_id: null,
            tool_use_result: { success: true, taskId: '2', updatedFields: ['status'] },
          },
          { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess_1' },
        )
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
    buildEnv: () => ({ PATH: '/usr/bin', ...env }),
  })
  const turn = { ...TURN, ...(resumeSessionId ? { resumeSessionId } : {}) }
  await adapter.startSession(turn)
  const events: ConversationEvent[] = []
  for await (const event of (await adapter.sendTurn(turn)) as AsyncIterable<ConversationEvent>) events.push(event)
  await adapter.disposeAll()
  const rows = events.filter((event) => event.type === 'tool_started' && event.payload?.toolUseId === 'toolu_b')
  return (rows.at(-1)?.payload?.input as { todos?: unknown } | undefined)?.todos
}

test('a chat resumed after a restart shows its task list as Claude Code left it on disk', async () => {
  const configDir = await configDirWith('sess_1', {
    '1.json': storedTask('1', 'Read the brief', 'completed'),
    '2.json': storedTask('2', 'Draft the answer', 'in_progress'),
    '3.json': storedTask('3', 'Check the answer', 'pending'),
  })
  expect(await updateRowTodos({ CLAUDE_CONFIG_DIR: configDir }, 'sess_1')).toEqual([
    { content: 'Read the brief', status: 'completed' },
    { content: 'Draft the answer', status: 'completed' },
    { content: 'Check the answer', status: 'pending' },
  ])
})

test('the list named by CLAUDE_CODE_TASK_LIST_ID is the one read', async () => {
  const configDir = await configDirWith('acme-plan', {
    '1.json': storedTask('1', 'Read the brief', 'completed'),
    '2.json': storedTask('2', 'Draft the answer', 'pending'),
  })
  expect(
    await updateRowTodos({ CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_TASK_LIST_ID: 'acme-plan' }, 'sess_1'),
  ).toEqual([
    { content: 'Read the brief', status: 'completed' },
    { content: 'Draft the answer', status: 'completed' },
  ])
})

test('a chat that resumes no session reads no stored list', async () => {
  const configDir = await configDirWith('sess_1', { '2.json': storedTask('2', 'Draft the answer', 'pending') })
  expect(await updateRowTodos({ CLAUDE_CONFIG_DIR: configDir })).toEqual([])
})

test('a stored list that cannot be read leaves the chat’s list as it was', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'claude-task-resume-'))
  roots.push(configDir)
  await writeFile(join(configDir, 'tasks'), 'not a folder')
  expect(await updateRowTodos({ CLAUDE_CONFIG_DIR: configDir }, 'sess_1')).toEqual([])
})
