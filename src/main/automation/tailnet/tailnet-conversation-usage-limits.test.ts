import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { studioConversationUsageLimits } from '../../../server/core/studio-usage-limit-resumes'
import type { UsageLimitResumeState, UsageLimitResumeUpdate } from '../../../shared/usage-limit-resume'
import type { UsageLimitsState } from '../../../shared/usage-limits'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import type { UsageLimitResumer } from '../../usage-limits/resume'
import { createConversationGatewayHost, type ConversationUsageLimitsState } from './tailnet-conversation-host'

// A paired device following a chat here hears what this machine's agents
// reported of their plans' limits, and the notice a limit left on the chat's
// turn, and acts on it as this machine's own tray row does
// (`conversation-usage-limits`).

const RESET = Date.UTC(2026, 9, 25, 23, 40)
const CHAT = { workspaceId: 'workspace', agentId: 'agent' }

function resumesStandIn() {
  let state: UsageLimitResumeState = {
    autoResume: false,
    notices: [
      { ...CHAT, provider: 'claude', limit: 'session', resetsAt: RESET, hitAt: 5, resumeAt: null },
      {
        workspaceId: 'workspace',
        agentId: 'other',
        provider: 'codex',
        limit: null,
        resetsAt: null,
        hitAt: 6,
        resumeAt: null,
      },
    ],
  }
  const updates: UsageLimitResumeUpdate[] = []
  const listeners = new Set<() => void>()
  const resumer = {
    state: () => state,
    update(update: UsageLimitResumeUpdate) {
      updates.push(update)
      if (update.kind === 'auto') state = { ...state, autoResume: update.enabled }
      if (update.kind === 'schedule')
        state = {
          ...state,
          notices: state.notices.map((notice) =>
            notice.agentId === update.agentId ? { ...notice, resumeAt: RESET + 60_000 } : notice,
          ),
        }
      for (const listener of listeners) listener()
      return state
    },
    onChanged(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as UsageLimitResumer
  return { resumer, updates }
}

function usageStandIn() {
  const listeners = new Set<() => void>()
  let state: UsageLimitsState = {
    snapshots: [
      {
        provider: 'claude',
        billing: 'subscription',
        plan: 'max',
        observedAt: 10,
        windows: [
          {
            id: 'five_hour',
            label: 'Session (5h)',
            usedPercent: 100,
            resetsAt: RESET,
            status: 'rejected',
            observedAt: 10,
          },
        ],
      },
    ],
  }
  return {
    usage: {
      state: () => state,
      onChanged(listener: (state: UsageLimitsState) => void) {
        const tell = () => listener(state)
        listeners.add(tell)
        return () => listeners.delete(tell)
      },
    },
    report(next: UsageLimitsState) {
      state = next
      for (const listener of listeners) listener()
    },
  }
}

async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-usage-limits-'))
  const key = { workspaceRoot, ...CHAT }
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const resumes = resumesStandIn()
  const usage = usageStandIn()
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === key.workspaceId ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: key.workspaceId }],
    () => 'bypass',
    () => null,
    async () => null,
    {},
    { usageLimits: studioConversationUsageLimits(() => resumes.resumer, usage.usage) },
  )
  return {
    key,
    host,
    resumes,
    usage,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test("a device following a chat is told its notice and every plan's windows, and again when either moves", async () => {
  const f = await fixture()
  try {
    const told: ConversationUsageLimitsState[] = []
    const stop = f.host.watchUsageLimits!(f.key, (state) => told.push(state))
    assert.deepEqual(told, [
      {
        notice: { provider: 'claude', limit: 'session', resetsAt: RESET, hitAt: 5, resumeAt: null },
        autoResume: false,
        limits: [
          {
            provider: 'claude',
            plan: 'max',
            observedAt: 10,
            windows: [
              {
                id: 'five_hour',
                label: 'Session (5h)',
                usedPercent: 100,
                resetsAt: RESET,
                status: 'rejected',
                observedAt: 10,
              },
            ],
          },
        ],
      },
    ])
    f.usage.report({ snapshots: [] })
    assert.deepEqual(told.at(-1)?.limits, [], 'a new reading is told')
    f.usage.report({ snapshots: [] })
    assert.equal(told.length, 2, 'one that reads the same is not')
    stop()
  } finally {
    await f.cleanup()
  }
})

test("Resume at reset reaches this machine's resumes, Always switches it on for every chat, and a repeat is answered as the first", async () => {
  const f = await fixture()
  try {
    const told: ConversationUsageLimitsState[] = []
    f.host.watchUsageLimits!(f.key, (state) => told.push(state))
    const always = { kind: 'usageLimitResume' as const, action: 'schedule' as const, always: true as const }
    assert.deepEqual(await f.host.command(f.key, 'laptop', 'cmd-1', always), { ok: true })
    assert.deepEqual(await f.host.command(f.key, 'laptop', 'cmd-1', always), { ok: true })
    assert.deepEqual(f.resumes.updates, [
      { kind: 'auto', enabled: true },
      { kind: 'schedule', ...CHAT },
    ])
    assert.equal(told.at(-1)?.notice?.resumeAt, RESET + 60_000)
    assert.equal(told.at(-1)?.autoResume, true)
    assert.deepEqual(await f.host.command(f.key, 'laptop', 'cmd-2', { kind: 'usageLimitResume', action: 'dismiss' }), {
      ok: true,
    })
    assert.deepEqual(f.resumes.updates.at(-1), { kind: 'dismiss', ...CHAT })
  } finally {
    await f.cleanup()
  }
})

test('a desktop built without usage limits watches none and refuses the command in words', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-usage-limits-'))
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
  })
  try {
    const host = createConversationGatewayHost(
      runtime,
      () => workspaceRoot,
      () => [{ workspaceRoot, workspaceId: CHAT.workspaceId }],
    )
    assert.equal(host.watchUsageLimits, undefined)
    const refused = await host.command({ workspaceRoot, ...CHAT }, 'laptop', 'cmd-1', {
      kind: 'usageLimitResume',
      action: 'schedule',
    })
    assert.equal(refused.ok, false)
    assert.match(refused.message ?? '', /does not resume chats/)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
