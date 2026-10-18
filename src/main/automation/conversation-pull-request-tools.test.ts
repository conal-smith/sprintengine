import assert from 'node:assert/strict'
import { test } from 'vitest'

import { defaultAgent } from '../../shared/agent-state'
import type { McpToolResult } from '../../shared/modules/mcp-tools'
import type { PullRequestTextRequest } from '../../shared/text-generation/contract'
import { DEFAULT_WRITING_STYLE } from '../../shared/text-generation/writing-style'
import type { WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import {
  chatCheckoutFromRegistry,
  createConversationPullRequestTools,
  type ConversationPullRequestToolsDeps,
} from './conversation-pull-request-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { TAILNET_CAPABILITIES } from './tailnet/tailnet-routes'
import { requiredScopeForTool } from './tailnet/tailnet-scopes'

// A paired desktop's Create PR on a chat here: the call names the chat, and
// this machine finds the chat's checkout in its own record, drafts with its
// own settings, and records what it opened as the chat's.

const DEVICE = { metadata: { kind: 'remote-tailnet' as const, deviceId: 'device-1', deviceName: 'dev-macbook-air' } }

function record(overrides: Partial<WorkspaceRegistryRecord> = {}): WorkspaceRegistryRecord {
  const worktreeAgent = defaultAgent('agent-wt')
  worktreeAgent.execution = { mode: 'worktree', worktreeId: 'wt-1', cwd: '/Users/dev/app-worktrees/remote-pr' }
  return {
    id: 'ws-1',
    folderPath: '/Users/dev/app',
    agents: { 'agent-1': defaultAgent('agent-1'), 'agent-wt': worktreeAgent },
    ...overrides,
  } as unknown as WorkspaceRegistryRecord
}

function harness(overrides: Partial<ConversationPullRequestToolsDeps> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const drafts: PullRequestTextRequest[] = []
  const deps: ConversationPullRequestToolsDeps = {
    checkoutOf: chatCheckoutFromRegistry((id) => (id === 'ws-1' ? record() : null)),
    creator: {
      state: async (cwd) => {
        calls.push(['state', cwd])
        return {
          readiness: { ready: true },
          gitRoot: cwd,
          branch: 'agent/remote-pr',
          headSha: 'abc1234def',
          uncommittedChanges: 0,
          base: 'main',
          forge: 'github',
        }
      },
      draftInput: async (cwd) => {
        calls.push(['draftInput', cwd])
        return {
          ok: true,
          input: {
            base: 'main',
            head: 'agent/remote-pr',
            commits: 'feat: x',
            diffStat: '',
            patch: '',
            template: null,
            conventionalCommits: true,
          },
        }
      },
      push: async (cwd, pin) => {
        calls.push(['push', cwd, pin])
        return { ok: true, pushed: true }
      },
      create: async (cwd, text, pin) => {
        calls.push(['create', cwd, text, pin])
        return { ok: true, kind: 'created', url: 'https://github.com/acme/app/pull/7' }
      },
    },
    draftEngine: () => ({
      engine: { cli: 'claude-code', model: 'claude-haiku-5-5' },
      writingStyle: DEFAULT_WRITING_STYLE,
    }),
    generate: async (request) => {
      drafts.push(request)
      return { ok: true, value: { title: 'feat: remote PR', body: 'Body' }, ms: 1 }
    },
    link: async (input) => {
      calls.push(['link', input])
      return { ok: true }
    },
    ...overrides,
  }
  const tools = createConversationPullRequestTools(deps)
  const tool = (name: string) => tools.find((entry) => entry.name === `conversation.pull_request_${name}`)!
  return { tools, tool, calls, drafts }
}

const structured = (result: McpToolResult) => result.structuredContent as Record<string, unknown>
const errorCode = (result: McpToolResult) => (structured(result).error as { code?: string } | undefined)?.code

test("the state is read in the chat's own checkout, and names no path on this machine", async () => {
  const { tool, calls } = harness()
  const result = await tool('state').handler({ workspaceId: 'ws-1', agentId: 'agent-wt' }, DEVICE)
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls, [['state', '/Users/dev/app-worktrees/remote-pr']])
  const state = structured(result).state as Record<string, unknown>
  assert.equal(state.gitRoot, null)
  assert.equal(state.branch, 'agent/remote-pr')
  assert.equal(JSON.stringify(result).includes('/Users/dev'), false)
})

test('a chat this machine does not hold, or whose checkout is on another machine, is refused', async () => {
  const { tool, calls } = harness({
    checkoutOf: chatCheckoutFromRegistry((id) =>
      id === 'ws-ssh' ? record({ environment: { kind: 'ssh' } } as never) : id === 'ws-1' ? record() : null,
    ),
  })
  assert.equal(errorCode(await tool('state').handler({ workspaceId: 'ws-9', agentId: 'agent-1' })), 'unknown_workspace')
  assert.equal(
    errorCode(await tool('push').handler({ workspaceId: 'ws-1', agentId: 'agent-9' })),
    'unknown_conversation',
  )
  assert.equal(
    errorCode(await tool('create').handler({ workspaceId: 'ws-ssh', agentId: 'agent-1', title: 't', body: '' })),
    'checkout_elsewhere',
  )
  // A folder is never taken from the caller.
  assert.equal(
    errorCode(await tool('state').handler({ workspaceId: '', agentId: 'agent-1', cwd: '/etc' })),
    'invalid_arguments',
  )
  assert.deepEqual(calls, [])
})

test('the push and the creation run in the chat checkout with the pin, and what is created is the chat’s', async () => {
  const { tool, calls } = harness()
  const pin = { branch: 'agent/remote-pr', headSha: 'abc1234def' }
  const pushed = await tool('push').handler({ workspaceId: 'ws-1', agentId: 'agent-1', pin }, DEVICE)
  assert.deepEqual(structured(pushed), { ok: true, pushed: true })
  const created = await tool('create').handler(
    { workspaceId: 'ws-1', agentId: 'agent-1', title: '  feat: remote PR ', body: 'Body', pin },
    DEVICE,
  )
  assert.deepEqual(structured(created), {
    ok: true,
    kind: 'created',
    url: 'https://github.com/acme/app/pull/7',
    recorded: true,
  })
  assert.deepEqual(calls, [
    ['push', '/Users/dev/app', pin],
    ['create', '/Users/dev/app', { title: 'feat: remote PR', body: 'Body' }, pin],
    [
      'link',
      {
        conversation: { workspaceId: 'ws-1', agentId: 'agent-1' },
        url: 'https://github.com/acme/app/pull/7',
        title: 'feat: remote PR',
      },
    ],
  ])
})

test('a pin that is not one is refused rather than dropped, and a record that fails is said with the address', async () => {
  const { tool, calls } = harness({ link: async () => ({ ok: false, message: 'Opened by another conversation.' }) })
  const refused = await tool('push').handler({ workspaceId: 'ws-1', agentId: 'agent-1', pin: { branch: 'x' } })
  assert.equal(errorCode(refused), 'invalid_arguments')
  assert.deepEqual(calls, [])
  const created = await tool('create').handler({ workspaceId: 'ws-1', agentId: 'agent-1', title: 'feat', body: '' })
  assert.equal(structured(created).recorded, false)
  assert.match(
    String(structured(created).recordMessage),
    /^The pull request is open \(https:\/\/github.com\/acme\/app\/pull\/7\), but it could not be recorded: Opened by another conversation\.$/,
  )
})

test("the draft is written with this machine's settings, and refused in words where they are off", async () => {
  const { tool, drafts } = harness()
  const drafted = await tool('draft').handler({ workspaceId: 'ws-1', agentId: 'agent-1', draftId: 'd-1' }, DEVICE)
  assert.deepEqual(structured(drafted), { ok: true, title: 'feat: remote PR', body: 'Body' })
  assert.equal(drafts[0]?.engine.cli, 'claude-code')
  assert.deepEqual(drafts[0]?.input.style, DEFAULT_WRITING_STYLE)

  const off = harness({ draftEngine: () => null })
  const refused = await off.tool('draft').handler({ workspaceId: 'ws-1', agentId: 'agent-1' }, DEVICE)
  assert.equal(errorCode(refused), 'text_generation_off')
  assert.deepEqual(off.drafts, [])
})

test('a draft is stopped by its caller, by the id it gave', async () => {
  let release: () => void = () => undefined
  const { tool } = harness({
    generate: (request) =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true, value: { title: 'late', body: '' }, ms: 1 })
        request.signal?.addEventListener('abort', () => resolve({ ok: false, code: 'cancelled', message: 'stopped' }))
      }),
  })
  const running = tool('draft').handler({ workspaceId: 'ws-1', agentId: 'agent-1', draftId: 'd-1' }, DEVICE)
  await new Promise((resolve) => setTimeout(resolve, 0))
  // Another device naming the same id stops nothing.
  const other = { metadata: { ...DEVICE.metadata, deviceId: 'device-2' } }
  await tool('draft_cancel').handler({ workspaceId: 'ws-1', agentId: 'agent-1', draftId: 'd-1' }, other)
  await tool('draft_cancel').handler({ workspaceId: 'ws-1', agentId: 'agent-1', draftId: 'd-1' }, DEVICE)
  assert.equal(errorCode(await running), 'cancelled')
  release()
})

test('reading whether the button may show is a read; every other step needs the operate grant', () => {
  const { tools } = harness()
  const scopes = Object.fromEntries(
    tools.map((tool) => [tool.name, requiredScopeForTool(tool.name, isStudioGatewayMutation(tool.name))]),
  )
  assert.deepEqual(scopes, {
    'conversation.pull_request_state': 'conversation:read',
    'conversation.pull_request_draft': 'conversation:operate',
    'conversation.pull_request_draft_cancel': 'conversation:operate',
    'conversation.pull_request_push': 'conversation:operate',
    'conversation.pull_request_create': 'conversation:operate',
  })
  assert.ok((TAILNET_CAPABILITIES as readonly string[]).includes('chat-create-pull-request'))
})
