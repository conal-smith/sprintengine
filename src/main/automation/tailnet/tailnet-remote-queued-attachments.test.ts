import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// A queued message carrying pictures, files, skills or mentions needs the
// machine to say it holds them (`conversation-queued-attachments`), and an
// "always allow" rule needs it to say it saves one
// (`conversation-permanent-approvals`). A machine that said neither is refused
// both here in words, before anything is uploaded or sent: it would refuse
// the frame itself, after the pictures had gone up for nothing.

const OLDER = [
  'conversations',
  'upload',
  'conversation-queued-sends',
  'conversation-send-skills',
  'workspace-extensions',
  'conversation-send-mentions',
  'conversation-file-search',
  'conversation-message-files',
]

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
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-remote-queued-attachments-'))
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

const picture = { id: 'a', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', name: 'a.png', byteLength: 8 }

test('a machine that holds words only is sent no queued message carrying more, and says so', async () => {
  const machine = await pairedMachine(OLDER)
  try {
    const before = machine.asked()
    for (const carried of [
      { attachments: [picture] },
      { skills: ['review'] },
      { mentions: [{ path: 'docs/notes.md', kind: 'file' }] },
      { files: [{ path: '/Users/dev/Desktop/notes.txt' }] },
    ]) {
      const sent = await machine.mesh.conversationSend({
        key: machine.key,
        message: 'And this.',
        queue: true,
        ...carried,
      })
      assert.ok(!sent.ok, JSON.stringify(carried))
      assert.match(sent.ok ? '' : sent.message, /holds a queued message's words only/u, JSON.stringify(carried))
    }
    assert.equal(machine.asked(), before, 'nothing was uploaded or sent over there')
  } finally {
    await machine.close()
  }
})

test('a machine that saves no rule from here is refused "always allow" before it is asked', async () => {
  const machine = await pairedMachine(OLDER)
  try {
    const before = machine.asked()
    const answered = await machine.mesh.conversationCommand({
      key: machine.key,
      command: { kind: 'resolveApproval', requestId: 'r-1', decision: 'always' },
    })
    assert.ok(!answered.ok && answered.code === 'unsafe_remote_decision')
    assert.ok(!answered.ok && answered.message.includes('Update SprintEngine Studio there'))
    assert.equal(machine.asked(), before)
  } finally {
    await machine.close()
  }
})
