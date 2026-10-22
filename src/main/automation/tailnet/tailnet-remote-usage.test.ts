import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { UsageSpeedRow } from '../../usage/usage-aggregate'
import { createUsageFleet } from '../../usage/usage-mesh'
import { createPricing } from '../../usage/usage-pricing'
import { createUsageTools } from '../../usage/usage-tools'
import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import {
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION,
  TAILNET_TRANSPORT_VERSION,
} from './tailnet-routes'

// A paired machine's usage, as the dashboard here asks for it: the handshake
// first, then `usage.report` only of a machine that says it serves it, on a
// pairing that may read its workspaces. A machine on an older Studio, one
// whose pairing may not read, one revoked and one away are each told apart
// before anything is asked of the tool.

const H0 = Date.parse('2026-10-20T09:00:00.000Z')

type Machine = {
  capabilities: string[] | null
  scopes?: string[]
  transportVersion?: number
  /** Answer the handshake 401, as a machine that revoked this pairing does. */
  revoked?: boolean
}

/** A machine that serves `usage.report` with the real tool over a fake usage service. */
async function pairedMachine(machine: Machine) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
  const state = { revoked: false }
  const device = {
    deviceId: 'device-1',
    deviceName: 'mac-mini',
    scopes: machine.scopes ?? ['workspace:read', 'conversation:read'],
    transportVersion: machine.transportVersion ?? TAILNET_TRANSPORT_VERSION,
    ...(machine.capabilities ? { capabilities: machine.capabilities } : {}),
  }
  const rows: UsageSpeedRow[] = [
    {
      day: String(H0),
      providerId: 'claude-agent',
      model: 'm',
      sessionId: 'theirs',
      chatTitle: 'Their chat',
      tokens: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 },
      requests: 1,
      reportedCostUsd: null,
    },
  ]
  const [tool] = createUsageTools({
    usage: () => ({ peerRows: async () => ({ rows, scannedAt: H0, scanning: false, sources: [] }) }),
  })
  const peer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      if (path === TAILNET_PAIR_PATH)
        return json(200, { ...device, transportVersion: TAILNET_TRANSPORT_VERSION, deviceToken: 'device-token' })
      if (path === TAILNET_IDENTITY_PATH) {
        if (state.revoked) return json(401, { error: { code: 'unauthorized', message: 'Unknown device.' } })
        return json(200, device)
      }
      if (path === TAILNET_MCP_PATH) {
        const call = JSON.parse(body) as {
          id?: unknown
          params?: { name?: string; arguments?: Record<string, unknown> }
        }
        const name = call.params?.name ?? ''
        calls.push({ tool: name, args: call.params?.arguments ?? {} })
        if (name !== tool!.name)
          return json(200, { jsonrpc: '2.0', id: call.id, error: { message: `Unknown tool "${name}".` } })
        void tool!
          .handler(call.params?.arguments ?? {})
          .then((result) => json(200, { jsonrpc: '2.0', id: call.id, result }))
        return
      }
      return json(404, { error: { code: 'not_found', message: `No tailnet gateway route for ${path}.` } })
    })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-remote-usage-'))
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, 'pairing-token') })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  state.revoked = machine.revoked === true
  return {
    mesh,
    dir,
    connectionId: paired.connection.id,
    calls,
    read: () =>
      mesh.readUsage({ connectionId: paired.connection.id, args: { from: H0, to: H0 + 3_600_000 }, timeoutMs: 2_000 }),
    async stop() {
      await new Promise<void>((resolve) => peer.close(() => resolve()))
    },
    async close() {
      mesh.shutdown()
      if (peer.listening) await this.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a machine that serves usage is asked, on the oldest wire this build drives as on the newest', async () => {
  for (const transportVersion of [TAILNET_MIN_SUPPORTED_TRANSPORT_VERSION, TAILNET_TRANSPORT_VERSION]) {
    const machine = await pairedMachine({ capabilities: ['usage-report'], transportVersion })
    try {
      const read = await machine.read()
      assert.ok(read.ok, read.ok ? '' : read.message)
      assert.deepEqual(machine.calls, [{ tool: 'usage.report', args: { from: H0, to: H0 + 3_600_000 } }])
    } finally {
      await machine.close()
    }
  }
})

test('a machine that does not say it serves usage, or says nothing, is told to update and is not asked', async () => {
  for (const capabilities of [['conversations', 'workspace-extensions'], [], null]) {
    const machine = await pairedMachine({ capabilities })
    try {
      const read = await machine.read()
      assert.ok(!read.ok && read.status === 'unsupported', JSON.stringify(capabilities))
      assert.ok(!read.ok && read.message.includes('Update Studio on'))
      assert.equal(machine.calls.length, 0)
    } finally {
      await machine.close()
    }
  }
})

test('a machine on a newer wire than this build drives is one to update, not one that is away', async () => {
  const machine = await pairedMachine({
    capabilities: ['usage-report'],
    transportVersion: TAILNET_TRANSPORT_VERSION + 1,
  })
  try {
    const read = await machine.read()
    assert.ok(!read.ok && read.status === 'unsupported')
    assert.equal(machine.calls.length, 0)
  } finally {
    await machine.close()
  }
})

test('a pairing that may not read workspaces, and one revoked, are refused as such', async () => {
  const narrow = await pairedMachine({ capabilities: ['usage-report'], scopes: ['conversation:read'] })
  try {
    const read = await narrow.read()
    assert.ok(!read.ok && read.status === 'unauthorized')
    assert.equal(narrow.calls.length, 0)
  } finally {
    await narrow.close()
  }
  const operate = await pairedMachine({ capabilities: ['usage-report'], scopes: ['workspace:operate'] })
  try {
    assert.equal((await operate.read()).ok, true, 'operate grants read')
  } finally {
    await operate.close()
  }
  const revoked = await pairedMachine({ capabilities: ['usage-report'], revoked: true })
  try {
    const read = await revoked.read()
    assert.ok(!read.ok && read.status === 'unauthorized')
  } finally {
    await revoked.close()
  }
})

test('the dashboard counts a paired machine over the wire, and keeps counting it once it is away', async () => {
  const machine = await pairedMachine({ capabilities: ['usage-report'] })
  try {
    const pricing = createPricing(new Map([['m', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }]]), {
      source: 'live',
      fetchedAt: 1,
    })
    const fleet = createUsageFleet({
      service: { localRows: async () => ({ rows: [], scannedAt: H0, sources: [], pricing }) },
      dataDir: () => machine.dir,
      peers: () => machine.mesh.listConnections(),
      askPeer: (connectionId, args, options) =>
        machine.mesh.readUsage({ connectionId, args, timeoutMs: options.timeoutMs }),
      localMachine: () => ({ label: 'air', kind: 'laptop', color: 'blue' }),
      pairedMachine: () => ({ kind: 'mini', color: 'teal' }),
      now: () => H0 + 3_600_000,
      askTimeoutMs: 2_000,
    })
    const window = { from: H0 - 3_600_000, to: H0 + 3_600_000 }
    const asked = await fleet.report({ ...window, peers: 'ask' })
    assert.ok(asked.ok)
    assert.equal(asked.report.totals.costUsd, 40)
    assert.equal(asked.report.machines[1]?.status, 'ok')

    await machine.stop()
    const away = await fleet.report({ ...window, peers: 'ask' })
    assert.ok(away.ok)
    assert.equal(away.report.machines[1]?.status, 'cached')
    assert.equal(away.report.totals.costUsd, 40)
  } finally {
    await machine.close()
  }
})
