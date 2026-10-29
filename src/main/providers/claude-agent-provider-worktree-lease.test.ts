import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import type {
  ConversationEvent,
  ConversationMcpServer,
  ConversationPermissionPreset,
} from '../../shared/conversation-runtime'
import { VISUALS_INSTRUCTION } from './visuals-guidance'
import { CLAUDE_AGENT_PROVIDER_ID, createClaudeAgentProvider } from './claude-agent-provider'
import type { MockAdapterTurnInput } from './conversation-provider-adapter'

// A chat that has the gateway is told to lease a worktree from the pool rather
// than run `git worktree add`, and its first `git worktree add` is turned back
// with the same pointer. The stand-in child below does what Claude Code does
// with a Bash call: it asks the PreToolUse hook, then answers the call with
// the hook's refusal or with the command's output.

const GATEWAY: ConversationMcpServer = {
  id: 'sprintengine-studio',
  name: 'SprintEngine Studio',
  transport: 'stdio',
  command: '/Applications/Studio.app/launcher',
  args: ['mcp'],
}

type HookAnswer = { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
type Hook = (input: Record<string, unknown>, toolUseId: string, context: { signal: AbortSignal }) => Promise<HookAnswer>

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function folder(options: { git: boolean; claudeMd?: string }) {
  const root = await mkdtemp(join(tmpdir(), 'claude-lease-'))
  roots.push(root)
  if (options.git) await mkdir(join(root, '.git'))
  if (options.claudeMd) await writeFile(join(root, 'CLAUDE.md'), options.claudeMd)
  return root
}

function harness(gateway: ConversationMcpServer | null, workspaceRoot: string) {
  const options: Record<string, unknown>[] = []
  const answers: HookAnswer[] = []
  let calls = 0
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    options.push(params.options)
    const hook = (params.options.hooks as { PreToolUse: { hooks: Hook[] }[] }).PreToolUse[0]!.hooks[0]!
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    let ended = false
    void (async () => {
      for await (const message of params.prompt) {
        // Each message is a command the agent runs.
        const command = String((message.message as { content: unknown }).content)
        const id = `toolu_${++calls}`
        pending.push({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
          parent_tool_use_id: null,
        })
        const answer = await hook(
          { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id },
          id,
          { signal: new AbortController().signal },
        )
        answers.push(answer)
        const denied = answer.hookSpecificOutput?.permissionDecision === 'deny'
        pending.push({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: id,
                content: denied ? answer.hookSpecificOutput!.permissionDecisionReason : 'Preparing worktree',
                ...(denied ? { is_error: true } : {}),
              },
            ],
          },
          parent_tool_use_id: null,
        })
        pending.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'lease' })
        wake?.()
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => {
        ended = true
        wake?.()
      },
      setPermissionMode: async () => undefined,
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      mcpServerStatus: async () => [],
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    resolveStudioMcpServer: async () => gateway,
  })
  let turns = 0
  const turn = (message: string, permissionPreset?: ConversationPermissionPreset): MockAdapterTurnInput => ({
    sessionId: 'conv_1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot,
    turnId: `turn_${++turns}`,
    requestId: `approval_${turns}`,
    message,
    ...(permissionPreset ? { permissionPreset } : {}),
  })
  const run = async (message: string, permissionPreset?: ConversationPermissionPreset) => {
    const input = turn(message, permissionPreset)
    if (turns === 1) await adapter.startSession(input)
    const events: ConversationEvent[] = []
    for await (const event of (await adapter.sendTurn(input)) as AsyncIterable<ConversationEvent>) events.push(event)
    return events
  }
  const systemPrompt = () => options.at(-1)?.systemPrompt as { append?: string }
  return { adapter, run, answers, systemPrompt }
}

const outputStatus = (events: ConversationEvent[]) =>
  events.find((event) => event.type === 'tool_output')?.payload?.status

test('a chat with the gateway in a git checkout is told to lease, before the project instructions', async () => {
  const root = await folder({ git: true, claudeMd: 'Run npm test before you commit.' })
  const { adapter, run, systemPrompt } = harness(GATEWAY, root)
  await run('ls')
  const append = systemPrompt().append ?? ''
  expect(append).toMatch(
    /^To work in a separate git worktree, call the SprintEngine Studio tool `mcp__sprintengine-studio__worktree_lease`/u,
  )
  expect(append).toContain(`\n\n${VISUALS_INSTRUCTION}\n\n`)
  expect(append).toContain('(project instructions):\n\nRun npm test before you commit.')
  await adapter.disposeAll()
})

test('a chat without the gateway, or outside a git checkout, is told nothing of worktrees and runs git worktree add', async () => {
  for (const [gateway, git] of [
    [null, true],
    [GATEWAY, false],
  ] as const) {
    const root = await folder({ git })
    const { adapter, run, systemPrompt, answers } = harness(gateway, root)
    const events = await run('git worktree add ../app-fix')
    // Only how to show a chart, which every chat is told.
    expect(systemPrompt().append).toBe(VISUALS_INSTRUCTION)
    expect(answers[0]?.hookSpecificOutput?.permissionDecision).toBeUndefined()
    expect(outputStatus(events)).toBe('ok')
    await adapter.disposeAll()
  }
})

test('the first git worktree add is turned back quietly with a pointer to the pool, and a repeat goes through', async () => {
  const root = await folder({ git: true })
  const { adapter, run, answers } = harness(GATEWAY, root)
  const first = await run(`cd ${root} && git -C ${root} worktree add ../app-fix -b fix`)
  expect(answers[0]?.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' })
  expect(answers[0]?.hookSpecificOutput?.permissionDecisionReason).toContain(
    '`mcp__sprintengine-studio__worktree_lease`',
  )
  // Declined, not failed: the row reads as a step Studio held back, with no error tone.
  expect(outputStatus(first)).toBe('declined')
  const again = await run(`git -C ${root} worktree add ../app-fix -b fix`)
  expect(answers[1]?.hookSpecificOutput?.permissionDecision).toBeUndefined()
  expect(outputStatus(again)).toBe('ok')
  await adapter.disposeAll()
})

test('bypass is redirected once too, since the pointer is guidance and the repeat still runs unasked', async () => {
  const root = await folder({ git: true })
  const { adapter, run, answers } = harness(GATEWAY, root)
  await run('git worktree add ../x', 'bypass')
  await run('git worktree add ../x', 'bypass')
  expect(answers.map((answer) => answer.hookSpecificOutput?.permissionDecision)).toEqual(['deny', undefined])
  await adapter.disposeAll()
})

test('under Manual the repeat goes on to the approval Manual asks for', async () => {
  const root = await folder({ git: true })
  const { adapter, run, answers } = harness(GATEWAY, root)
  await run('git worktree add ../x', 'manual')
  await run('git worktree add ../x', 'manual')
  expect(answers.map((answer) => answer.hookSpecificOutput?.permissionDecision)).toEqual(['deny', 'ask'])
  await adapter.disposeAll()
})

test('other commands are never redirected', async () => {
  const root = await folder({ git: true })
  const { adapter, run, answers } = harness(GATEWAY, root)
  await run('git worktree list')
  await run('git status')
  expect(answers.map((answer) => answer.hookSpecificOutput?.permissionDecision)).toEqual([undefined, undefined])
  await adapter.disposeAll()
})
