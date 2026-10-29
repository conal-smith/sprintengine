import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService, scheduledAgentViewOf } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// A paired machine's scheduled agents, driven from here: listed on its
// `schedule.list`, run, paused, resumed and closed on the tool of each name,
// and made there on `schedule.create` only where it says `scheduled-agents`.

type ToolCall = { name: string; arguments: Record<string, unknown> }

async function pairedMachine(
  capabilities: string[] | undefined,
  answer: (call: ToolCall) => Record<string, unknown>,
  scopes: string[] = ['workspace:read', 'workspace:operate'],
) {
  const toolCalls: ToolCall[] = []
  const device = {
    deviceId: 'device-1',
    deviceName: 'dev-macbook-air',
    scopes,
    transportVersion: 2,
    ...(capabilities ? { capabilities } : {}),
  }
  const peer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (path === TAILNET_PAIR_PATH) return json(200, { ...device, deviceToken: 'device-token' })
      if (path === TAILNET_IDENTITY_PATH) return json(200, device)
      if (path === TAILNET_MCP_PATH) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: string
          params: { name: string; arguments: Record<string, unknown> }
        }
        toolCalls.push({ name: body.params.name, arguments: body.params.arguments })
        return json(200, { jsonrpc: '2.0', id: body.id, ...answer(body.params) })
      }
      return json(404, { error: { code: 'not_found', message: `No route for ${path}.` } })
    })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-mesh-scheduled-'))
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, 'pairing-token') })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  await mesh.checkReachability(paired.connection.id)
  return {
    mesh,
    connectionId: paired.connection.id,
    toolCalls,
    async close() {
      mesh.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const success = (structured: Record<string, unknown>) => ({
  result: { content: [{ type: 'text', text: '' }], structuredContent: structured },
})

const listed = {
  id: 'sa-1',
  name: 'Morning triage',
  prompt: 'Triage new issues',
  schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/London' },
  folderPath: '/Users/dev/app',
  hostId: 'wsl:Ubuntu',
  cli: 'claude-code',
  cliModel: null,
  permissionPreset: 'auto',
  skills: [{ id: 'gh-triage', name: 'GitHub triage' }],
  mcpServers: [],
  worktree: { name: '' },
  ownerModuleId: null,
  createdAt: 1_000,
  updatedAt: 2_000,
  lastRun: { at: 3_000, ok: false, message: 'The CLI is not installed.' },
  lastFailureSeenAt: null,
  scheduleWords: 'Every weekday at 9:00 AM',
  paused: true,
  pausedAt: '2026-10-05T08:00:00.000Z',
  nextRunAt: null,
}

test('A paired machine’s schedules read back as this machine’s own list does', async () => {
  const machine = await pairedMachine(['conversations', 'scheduled-agents'], () =>
    success({ scheduledAgents: [listed, { id: 'broken' }], pausedAll: null }),
  )
  try {
    const answer = await machine.mesh.scheduledAgents({ connectionId: machine.connectionId })
    assert.ok(answer.ok)
    assert.equal(answer.canCreate, true)
    assert.equal(answer.pausedAll, null)
    assert.equal(answer.agents.length, 1, 'a row it cannot read is left out')
    const [agent] = answer.agents
    assert.equal(agent!.name, 'Morning triage')
    assert.equal(agent!.pausedAt, Date.parse('2026-10-05T08:00:00.000Z'))
    assert.equal(agent!.nextRunAt, null)
    assert.equal(agent!.hostId, null, 'a machine there names nothing here')
    assert.deepEqual(agent!.lastRun, { at: 3_000, ok: false, message: 'The CLI is not installed.' })
    assert.deepEqual(machine.toolCalls, [{ name: 'schedule.list', arguments: {} }])
  } finally {
    await machine.close()
  }
})

test('Run, pause, resume and close are the machine’s own schedule tools', async () => {
  const machine = await pairedMachine(['conversations', 'scheduled-agents'], (call) =>
    success(call.name === 'schedule.run' ? { workspaceId: 'ws-run' } : { scheduledAgent: listed }),
  )
  try {
    for (const action of ['run', 'pause', 'resume', 'delete'] as const) {
      const answer = await machine.mesh.scheduledAgentAction({ connectionId: machine.connectionId, id: 'sa-1', action })
      assert.deepEqual(answer, { ok: true, id: 'sa-1', action })
    }
    assert.deepEqual(
      machine.toolCalls.map((call) => call.name),
      ['schedule.run', 'schedule.pause', 'schedule.resume', 'schedule.delete'],
    )
    const unknown = await machine.mesh.scheduledAgentAction({
      connectionId: machine.connectionId,
      id: 'sa-1',
      action: 'edit',
    })
    assert.equal(!unknown.ok && unknown.code, 'invalid_arguments')
  } finally {
    await machine.close()
  }
})

test('A schedule is made there with what this door would have scheduled here', async () => {
  const machine = await pairedMachine(['conversations', 'scheduled-agents'], () => success({ scheduledAgent: listed }))
  // An older machine lists its schedules, and is never asked to make one.
  const older = await pairedMachine(['conversations'], (call) => {
    assert.equal(call.name, 'schedule.list')
    return success({ scheduledAgents: [listed], pausedAll: null })
  })
  try {
    const once = Date.parse('2026-11-02T15:30:00.000Z')
    const answer = await machine.mesh.createScheduledAgent({
      connectionId: machine.connectionId,
      workspaceId: 'ws-seat',
      prompt: '  Check the deploy  ',
      cron: '30 15 2 11 *',
      timezone: 'UTC',
      once,
      cli: 'claude-code',
      model: null,
      permissionPreset: 'auto',
      worktreeName: '',
      skills: ['gh-triage'],
      mcpServers: [],
    })
    assert.ok(answer.ok)
    assert.equal(answer.agent.id, 'sa-1')
    assert.deepEqual(machine.toolCalls, [
      {
        name: 'schedule.create',
        arguments: {
          workspaceId: 'ws-seat',
          prompt: 'Check the deploy',
          cron: '30 15 2 11 *',
          timezone: 'UTC',
          once: '2026-11-02T15:30:00.000Z',
          cli: 'claude-code',
          permissionPreset: 'auto',
          worktree: true,
          skills: ['gh-triage'],
        },
      },
    ])
    const refused = await older.mesh.createScheduledAgent({
      connectionId: older.connectionId,
      workspaceId: 'ws-seat',
      prompt: 'x',
      cron: '0 9 * * *',
      timezone: 'UTC',
      cli: 'claude-code',
    })
    assert.equal(!refused.ok && refused.code, 'scheduled_agents_unsupported')
    const listedThere = await older.mesh.scheduledAgents({ connectionId: older.connectionId })
    assert.ok(listedThere.ok)
    assert.equal(listedThere.canCreate, false)
    assert.equal(listedThere.agents.length, 1)
  } finally {
    await machine.close()
    await older.close()
  }
})

test('A row without what it needs is not a schedule', () => {
  assert.equal(scheduledAgentViewOf({ id: 'x', prompt: 'p' }), null)
  assert.equal(scheduledAgentViewOf({ prompt: 'p', schedule: { cron: '* * * * *' } }), null)
  assert.ok(scheduledAgentViewOf({ id: 'x', prompt: 'p', schedule: { cron: '* * * * *' } }))
})
