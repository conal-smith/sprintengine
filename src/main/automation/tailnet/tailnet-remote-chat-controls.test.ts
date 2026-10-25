import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// The chat controls a desktop following a paired machine's chat offers as a
// chat here does, each behind the capability that machine advertises for it.
// A machine that has not said it takes one is refused here in words, before
// anything is sent: one from before it drops what it does not know, or
// answers an unknown kind with nothing a person could act on.

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
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-remote-chat-controls-'))
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

test("a machine that runs no CLI's own modes is not asked to switch a chat to one", async () => {
  const machine = await pairedMachine(['conversations', 'conversation-permission-modes'])
  try {
    const before = machine.asked()
    const switched = await machine.mesh.conversationCommand({
      key: machine.key,
      command: { kind: 'setPermissionPreset', preset: 'auto', permissionMode: 'acceptEdits' },
    })
    assert.ok(!switched.ok && switched.code === 'unsupported_permission_preset')
    assert.ok(!switched.ok && switched.message.includes('Update SprintEngine Studio there'))
    assert.equal(machine.asked(), before, 'nothing was sent over there')
  } finally {
    await machine.close()
  }
})

test('a machine that does not take the mode a turn runs in is not sent one, and a default send goes as before', async () => {
  const machine = await pairedMachine(['conversations'])
  try {
    const before = machine.asked()
    for (const mode of ['ask', 'plan']) {
      const sent = await machine.mesh.conversationSend({ key: machine.key, message: 'Only look', mode })
      assert.ok(!sent.ok && sent.code === 'mode_unsupported')
      assert.ok(!sent.ok && sent.message.includes('Update SprintEngine Studio there'))
    }
    assert.equal(machine.asked(), before, 'nothing was sent over there')
    // A queued message is its words alone, and goes in the default mode.
    const queued = await machine.mesh.conversationSend({ key: machine.key, message: 'Later', mode: 'ask', queue: true })
    assert.ok(!queued.ok && queued.code === 'invalid_arguments')
    const odd = await machine.mesh.conversationSend({ key: machine.key, message: 'Hm', mode: 'yolo' })
    assert.ok(!odd.ok && odd.code === 'invalid_arguments')
  } finally {
    await machine.close()
  }
})
