import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// A Claude chat whose turn runs a slow Bash command. Claude Code's stream says
// nothing about it until its result; the output it writes to its task file is
// shown on the step meanwhile, and the result replaces it.

const TURN: MockAdapterTurnInput = {
  sessionId: 'conv_1',
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  providerId: CLAUDE_AGENT_PROVIDER_ID,
  modelId: 'sonnet',
  workspaceRoot: '/Users/dev/app',
  turnId: 'turn_1',
  requestId: 'approval_1',
  message: 'Run the tests',
}

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'claude-provider-command-output-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

function harness(taskOutputRoot: string | null) {
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>> }) => {
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    const push = (...messages: Record<string, unknown>[]) => {
      pending.push(...messages)
      wake?.()
    }
    void (async () => {
      for await (const _message of params.prompt) {
        void _message
        push(
          {
            type: 'assistant',
            parent_tool_use_id: null,
            session_id: 'sess-1',
            message: {
              content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'npm test' } }],
            },
          },
          {
            type: 'system',
            subtype: 'task_started',
            task_id: 'bt1',
            tool_use_id: 'toolu_bash',
            task_type: 'local_bash',
            is_backgrounded: false,
            session_id: 'sess-1',
          },
        )
        const file = join(root, '-Users-dev-app', 'sess-1', 'tasks', 'bt1.output')
        await mkdir(join(root, '-Users-dev-app', 'sess-1', 'tasks'), { recursive: true })
        await writeFile(file, 'PASS a.test.ts\n')
        await settle()
        await appendFile(file, 'PASS b.test.ts\n')
        await settle()
        push(
          {
            type: 'system',
            subtype: 'task_notification',
            task_id: 'bt1',
            tool_use_id: 'toolu_bash',
            status: 'completed',
            session_id: 'sess-1',
          },
          {
            type: 'user',
            parent_tool_use_id: null,
            session_id: 'sess-1',
            message: {
              content: [
                { type: 'tool_result', tool_use_id: 'toolu_bash', content: 'PASS a.test.ts\nPASS b.test.ts\n' },
              ],
            },
            tool_use_result: { stdout: 'PASS a.test.ts\nPASS b.test.ts\n', stderr: '', interrupted: false },
          },
          { type: 'result', subtype: 'success', is_error: false, result: 'Both pass.', session_id: 'sess-1' },
        )
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
      stopTask: async () => undefined,
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    childAnswerTimeoutMs: 20,
    claudeTaskOutputRoot: () => taskOutputRoot,
    commandOutputPollMs: 5,
  })
  const run = async (): Promise<ConversationEvent[]> => {
    await adapter.startSession(TURN)
    const events: ConversationEvent[] = []
    for await (const event of (await adapter.sendTurn(TURN)) as AsyncIterable<ConversationEvent>) events.push(event)
    await adapter.disposeAll()
    return events
  }
  return { run }
}

const outputs = (events: ConversationEvent[]) => events.filter((event) => event.type === 'tool_output')

test("a running command's output reaches its step as appended partial output, and its result replaces it", async () => {
  const events = await harness(root).run()
  const steps = outputs(events)
  const partial = steps.filter((event) => event.payload?.partial === true)
  const final = steps.at(-1)
  expect(partial.length).toBeGreaterThan(0)
  for (const event of partial) {
    expect(event.payload).toMatchObject({
      turnId: 'turn_1',
      toolUseId: 'toolu_bash',
      outputMode: 'append',
      partial: true,
      status: 'ok',
    })
  }
  expect(partial.map((event) => event.payload?.output).join('')).toBe('PASS a.test.ts\nPASS b.test.ts\n')
  expect(partial.at(-1)?.payload?.totalBytes).toBe(30)
  expect(final?.payload?.partial, 'the result is last, and whole').toBeUndefined()
  expect(final?.payload?.outputMode).toBeUndefined()
  expect(final?.payload).toMatchObject({ toolUseId: 'toolu_bash', output: 'PASS a.test.ts\nPASS b.test.ts\n' })
  expect(events.at(-1)?.type).toBe('turn_completed')
})

test('a child whose files cannot be read here shows the step as before', async () => {
  const events = await harness(null).run()
  const steps = outputs(events)
  expect(steps).toHaveLength(1)
  expect(steps[0]?.payload?.partial).toBeUndefined()
})
