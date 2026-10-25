import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// Edit from here and Revert in a chat on a paired machine need that machine to
// say it takes each command (`conversation-rewind`,
// `conversation-checkpoint-revert`). One that has not is refused here in
// words, before anything is sent: an older machine answers a kind it does not
// know with nothing a person could act on.

/** A machine that answers pairing and identity with the capabilities given, and counts every other request. */
async function pairedMachine(capabilities: string[]) {
  let asked = 0
  const device = {
    deviceId: 'device-1',
    deviceName: 'mac-mini',
    scopes: ['conversation:read', 'conversation:operate'],
    transportVersion: 2,
    capabilities,
  }
  const peer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    request.resume()
    request.on('end', () => {
      if (path === TAILNET_PAIR_PATH) return json(200, { ...device, deviceToken: 'device-token' })
      if (path === TAILNET_IDENTITY_PATH) return json(200, device)
      asked++
      return json(404, { error: { code: 'not_found', message: `No tailnet gateway route for ${path}.` } })
    })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-remote-rewind-revert-'))
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
    key: { connectionId: paired.connection.id, workspaceId: 'ws-1', agentId: 'agent-1' },
    asked: () => asked,
    async close() {
      mesh.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a machine that has not said it goes back to an earlier message is not asked to', async () => {
  const machine = await pairedMachine(['conversations', 'conversation-checkpoint-revert'])
  try {
    const before = machine.asked()
    const rewound = await machine.mesh.conversationCommand({
      key: machine.key,
      command: { kind: 'rewind', turnSeq: 5 },
    })
    assert.ok(!rewound.ok && rewound.code === 'unsupported_command')
    assert.ok(!rewound.ok && rewound.message.includes('Update SprintEngine Studio there'))
    assert.equal(machine.asked(), before, 'nothing was sent over there')
  } finally {
    await machine.close()
  }
})

test("a machine that has not said it restores a turn's files is not asked to, even for the list", async () => {
  const machine = await pairedMachine(['conversations', 'conversation-rewind'])
  try {
    const before = machine.asked()
    for (const command of [
      { kind: 'revert', turnSeq: 5 },
      { kind: 'revert', turnSeq: 5, confirmed: true, files: ['src/app.ts'] },
    ]) {
      const reverted = await machine.mesh.conversationCommand({ key: machine.key, command })
      assert.ok(!reverted.ok && reverted.code === 'unsupported_command')
      assert.ok(!reverted.ok && reverted.message.includes('Update SprintEngine Studio there'))
    }
    assert.equal(machine.asked(), before, 'nothing was sent over there')
  } finally {
    await machine.close()
  }
})
