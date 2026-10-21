import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// A message steered into a chat on a paired machine needs that machine to say
// it takes one (`conversation-steer-sends`). One that has not is refused here
// in words, before anything is sent: an older machine skips `steer` and
// refuses the send busy, and the follow would send it again until the turn it
// was meant to reach had ended.

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
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-remote-steer-'))
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

test('a machine that has not said it takes a steer is refused one before it is asked', async () => {
  const machine = await pairedMachine(['conversations', 'conversation-queued-sends'])
  try {
    const before = machine.asked()
    const sent = await machine.mesh.conversationSend({ key: machine.key, message: 'Keep it short.', steer: true })
    assert.equal(sent.ok, false)
    assert.ok(!sent.ok && sent.code === 'steer_unsupported')
    assert.ok(!sent.ok && sent.message.includes('Update SprintEngine Studio there'))
    assert.equal(machine.asked(), before, 'nothing was sent over there')
  } finally {
    await machine.close()
  }
})

test('a steer that is not true is refused as an argument', async () => {
  const machine = await pairedMachine(['conversations', 'conversation-steer-sends'])
  try {
    const sent = await machine.mesh.conversationSend({ key: machine.key, message: 'Keep it short.', steer: 'yes' })
    assert.ok(!sent.ok && sent.code === 'invalid_arguments')
  } finally {
    await machine.close()
  }
})
