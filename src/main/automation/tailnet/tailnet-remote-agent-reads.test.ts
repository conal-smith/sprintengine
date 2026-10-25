import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// Fork from here, a side question and the window's breakdown, for a chat on a
// paired machine, each need that machine to say it takes them
// (`conversation-fork`, `conversation-side-questions`,
// `conversation-context-breakdown`). One that has not is refused here in
// words, before anything is sent: an older machine answers a command or a
// frame it does not know with nothing a person could act on.

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
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-remote-agent-reads-'))
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

test('a machine that has not said it forks, answers side questions or reads the window is not asked to', async () => {
  const machine = await pairedMachine(['conversations', 'conversation-stop-subagent'])
  try {
    const before = machine.asked()
    const forked = await machine.mesh.conversationCommand({
      key: machine.key,
      command: { kind: 'fork', newAgentId: 'conversation-claude-agent-fork', side: 'assistant', turnId: 'turn-1' },
    })
    assert.ok(!forked.ok && forked.code === 'unsupported_command')
    assert.ok(!forked.ok && forked.message.includes('Update SprintEngine Studio there'))
    const asked = await machine.mesh.conversationSideQuestion({
      key: machine.key,
      requestId: 'q-1',
      question: 'Which file first?',
    })
    assert.ok(!asked.ok && asked.message.includes('Update SprintEngine Studio there'))
    const read = await machine.mesh.conversationContextBreakdown({ key: machine.key })
    assert.ok(!read.ok && read.reason === 'unsupported')
    assert.ok(!read.ok && read.message.includes('Update SprintEngine Studio there'))
    assert.equal(machine.asked(), before, 'nothing was sent over there')
  } finally {
    await machine.close()
  }
})

test('a machine that says it answers them is not refused here for its build', async () => {
  const machine = await pairedMachine([
    'conversations',
    'conversation-fork',
    'conversation-side-questions',
    'conversation-context-breakdown',
  ])
  try {
    // Not followed, so the side question is refused here for that, not for
    // the machine: the capability let it through.
    const asked = await machine.mesh.conversationSideQuestion({ key: machine.key, requestId: 'q-1', question: 'Why?' })
    assert.ok(!asked.ok && !asked.message.includes('Update SprintEngine Studio there'))
  } finally {
    await machine.close()
  }
})
