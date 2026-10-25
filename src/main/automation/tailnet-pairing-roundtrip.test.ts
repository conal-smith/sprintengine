import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { encodeQrCode } from '../../shared/qr-code'
import { toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../shared/mcp/protocol'
import { createTailnetRemoteService } from './tailnet/tailnet-service'
import { writeTailnetSettings } from './tailnet/tailnet-settings'
import { test } from 'vitest'

test('tailnet-pairing-roundtrip', async () => {
  // The pairing round-trip, end to end.
  //
  // Everything below the QR is REAL: the real remote service, the real listener
  // on a real TCP socket, the real device store on a real temp directory, and
  // real HTTP from a client that knows only what the square carries. Nothing is
  // stubbed, because the point of the test is that the pairing moment actually
  // works — a mocked listener would prove only that the mock accepts tokens.
  //
  // The one link this file does not walk is camera → pixels → string. That link
  // is proven in `src/shared/qr-code.test.ts`, where a decoder written from the
  // format's description reads a pairing URL back out of the encoded symbol and
  // checks its Reed-Solomon blocks. So this file starts where a scanner's app
  // starts: with the decoded string, parsed the way a client must parse it.

  let failures = 0
  let queue: Promise<void> = Promise.resolve()

  function check(name: string, run: () => Promise<void>): void {
    queue = queue.then(async () => {
      try {
        await run()
        console.log(`ok - ${name}`)
      } catch (error) {
        failures++
        console.error(`not ok - ${name}`)
        console.error(error)
      }
    })
  }

  function testTools(): McpToolRegistration[] {
    return [
      {
        name: 'backlog.list',
        description: 'Test tool',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => toolSuccess({ ok: true }),
      },
    ]
  }

  /** A port the OS just told us is free. */
  async function freePort(): Promise<number> {
    const probe = createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const address = probe.address()
    const port = typeof address === 'object' && address ? address.port : 0
    probe.close()
    await once(probe, 'close')
    return port
  }

  type HttpAnswer = { status: number; body: unknown }

  function call(
    port: number,
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<HttpAnswer> {
    return new Promise((resolve, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          agent: false,
          headers: {
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          },
        },
        (response) => {
          let raw = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            raw += chunk
          })
          response.on('end', () => {
            let body: unknown = raw
            try {
              body = JSON.parse(raw)
            } catch {
              // Leave it as text; a caller asserting on a status does not need it parsed.
            }
            resolve({ status: response.statusCode ?? 0, body })
          })
        },
      )
      request.on('error', reject)
      if (payload) request.write(payload)
      request.end()
    })
  }

  /**
   * Parse the pairing URL exactly as a client scanning the square must.
   *
   * Written against the string alone, with no reference to how it was built: if
   * the producer changed shape, this is what would notice.
   */
  function parsePairingUrl(url: string): { host: string; port: number; token: string } {
    assert.ok(url.startsWith('sprintengine-tailnet://pair?'), `unexpected scheme in ${url}`)
    const params = new URLSearchParams(url.slice('sprintengine-tailnet://pair?'.length))
    const endpoint = params.get('endpoint')
    const token = params.get('token')
    assert.ok(endpoint, 'the pairing URL carries an endpoint')
    assert.ok(token, 'the pairing URL carries a one-time token')
    // IPv6 endpoints are bracketed; IPv4 is not.
    const match = endpoint.startsWith('[')
      ? /^\[(?<host>.+)\]:(?<port>\d+)$/u.exec(endpoint)
      : /^(?<host>[^:]+):(?<port>\d+)$/u.exec(endpoint)
    assert.ok(match?.groups, `unreadable endpoint ${endpoint}`)
    return { host: match.groups.host, port: Number(match.groups.port), token }
  }

  type Harness = {
    service: ReturnType<typeof createTailnetRemoteService>
    port: number
    close(): Promise<void>
  }

  async function startHarness(): Promise<Harness> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-pairing-'))
    const port = await freePort()
    // The persisted setting is the only thing that turns the listener on, so the
    // test turns it on the way a person does rather than by reaching past it.
    writeTailnetSettings(userDataDir, { enabled: true, port, notifications: true })
    const service = createTailnetRemoteService({
      resolveUserDataDir: () => userDataDir,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: testTools,
      isMutation: () => false,
      // Loopback is on the bind allowlist precisely so tests drive the real
      // server; no Tailscale install is involved.
      resolveBindAddress: () => '127.0.0.1',
    })
    const status = await service.initialize()
    assert.equal(status.running, true, `the listener started: ${status.lastError ?? ''}`)
    return {
      service,
      port,
      async close() {
        await service.shutdown()
        rmSync(userDataDir, { recursive: true, force: true })
      },
    }
  }

  check('a device pairs from the square and can then drive the gateway', async () => {
    const harness = await startHarness()
    try {
      const offer = harness.service.offerPairing()
      assert.ok(offer.pairingUrl, 'a running listener mints a pairing URL')

      // The square a person points a camera at. It has to exist and it has to
      // carry this exact string — an unencodable URL is a broken pairing moment.
      const square = encodeQrCode(offer.pairingUrl)
      assert.ok(square, 'the pairing URL encodes as a QR symbol')
      assert.ok(square.size >= 21 && square.size === square.version * 4 + 17)

      // From here on, the client knows only what the square said.
      const scanned = parsePairingUrl(offer.pairingUrl)
      assert.equal(scanned.host, '127.0.0.1')
      assert.equal(scanned.port, harness.port)

      const paired = await call(scanned.port, 'POST', '/tailnet/v1/pair', {
        body: { pairingToken: scanned.token, deviceName: 'a-scanned-laptop' },
      })
      assert.equal(paired.status, 200)
      const device = paired.body as {
        deviceId: string
        deviceToken: string
        scopes: string[]
        transportVersion: number
        capabilities: string[]
      }
      assert.ok(device.deviceToken, 'pairing returns a device token')
      assert.ok(device.scopes.includes('backlog:read'), 'the default grant is the structured set')
      // A scanned client has made exactly one call at this point. It should not
      // have to make a second one to learn which wire it just joined.
      assert.equal(device.transportVersion, 2)
      assert.deepEqual(device.capabilities, [
        'events',
        'upload',
        'conversations',
        'conversation-models',
        'conversation-images',
        'conversation-permission-modes',
        'conversation-hello',
        'conversation-plans',
        'conversation-cli-permission-modes',
        'conversation-lifecycle',
        'conversation-queued-sends',
        'conversation-send-skills',
        'conversation-steer-sends',
        'conversation-message-images',
        'conversation-message-files',
        'conversation-stop-subagent',
        'conversation-handoff',
        'conversation-rewind',
        'conversation-checkpoint-revert',
        'new-chat-worktree',
        'new-chat-effort',
        'cli-runtime-catalog',
        'chat-mark-unread',
        'new-chat-worktree-name',
        'new-chat-in-worktree',
        'workspace-extensions',
        'new-chat-skills',
        'chat-create-pull-request',
        'chat-row-menu',
        'usage-report',
      ])

      // The pairing is real only if the token it produced actually drives tools.
      const called = await call(scanned.port, 'POST', '/tailnet/v1/mcp', {
        token: device.deviceToken,
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'backlog.list', arguments: {} },
        },
      })
      assert.equal(called.status, 200)
      const answer = called.body as { result?: { isError?: boolean } }
      assert.ok(answer.result, 'the remote tool call answered')
      assert.notEqual(answer.result.isError, true)

      // And the device shows up in the panel's list, which is where a person
      // revokes it.
      const listed = harness.service.getStatus().devices
      assert.equal(listed.length, 1)
      assert.equal(listed[0].name, 'a-scanned-laptop')
      assert.equal(listed[0].id, device.deviceId)
    } finally {
      await harness.close()
    }
  })

  check('the code works exactly once, and only for the listener it named', async () => {
    const harness = await startHarness()
    try {
      const offer = harness.service.offerPairing()
      assert.ok(offer.pairingUrl)
      const scanned = parsePairingUrl(offer.pairingUrl)

      const first = await call(scanned.port, 'POST', '/tailnet/v1/pair', {
        body: { pairingToken: scanned.token, deviceName: 'first' },
      })
      assert.equal(first.status, 200)

      // A screenshot of the square is not a second device.
      const second = await call(scanned.port, 'POST', '/tailnet/v1/pair', {
        body: { pairingToken: scanned.token, deviceName: 'second' },
      })
      assert.equal(second.status, 401)
      assert.equal(harness.service.getStatus().devices.length, 1)
    } finally {
      await harness.close()
    }
  })

  check('regenerating a code invalidates the square already on screen', async () => {
    const harness = await startHarness()
    try {
      const stale = parsePairingUrl(harness.service.offerPairing().pairingUrl ?? '')
      const fresh = parsePairingUrl(harness.service.offerPairing().pairingUrl ?? '')
      assert.notEqual(stale.token, fresh.token)

      const withStale = await call(harness.port, 'POST', '/tailnet/v1/pair', {
        body: { pairingToken: stale.token, deviceName: 'stale' },
      })
      assert.equal(withStale.status, 401, 'the replaced code is dead')

      const withFresh = await call(harness.port, 'POST', '/tailnet/v1/pair', {
        body: { pairingToken: fresh.token, deviceName: 'fresh' },
      })
      assert.equal(withFresh.status, 200)
    } finally {
      await harness.close()
    }
  })

  check('revoking from the panel takes effect on the very next request', async () => {
    const harness = await startHarness()
    try {
      const scanned = parsePairingUrl(harness.service.offerPairing().pairingUrl ?? '')
      const paired = await call(scanned.port, 'POST', '/tailnet/v1/pair', {
        body: { pairingToken: scanned.token, deviceName: 'laptop' },
      })
      const device = paired.body as { deviceId: string; deviceToken: string }

      const mcpCall = (): Promise<HttpAnswer> =>
        call(harness.port, 'POST', '/tailnet/v1/mcp', {
          token: device.deviceToken,
          body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        })

      assert.equal((await mcpCall()).status, 200, 'the device works before the revoke')

      // Exactly what the Revoke button calls.
      const after = harness.service.revokeDevice(device.deviceId)
      assert.deepEqual(after.devices, [], 'the panel list empties immediately')

      // No grace period, no cached session: the next request is already refused.
      assert.equal((await mcpCall()).status, 401)
    } finally {
      await harness.close()
    }
  })

  check('turning remote control off drops the outstanding code and closes the port', async () => {
    const harness = await startHarness()
    try {
      const scanned = parsePairingUrl(harness.service.offerPairing().pairingUrl ?? '')
      const stopped = await harness.service.setEnabled(false)
      assert.equal(stopped.running, false)
      assert.equal(stopped.pairing, null, 'a code for a listener that no longer answers is not kept')

      // The port is closed, so the square now points at nothing at all.
      await assert.rejects(
        () =>
          call(harness.port, 'POST', '/tailnet/v1/pair', { body: { pairingToken: scanned.token, deviceName: 'x' } }),
        /ECONNREFUSED/u,
      )

      // And re-enabling does not resurrect it.
      const restarted = await harness.service.setEnabled(true)
      assert.equal(restarted.running, true)
      const answer = await call(harness.port, 'POST', '/tailnet/v1/pair', {
        body: { pairingToken: scanned.token, deviceName: 'x' },
      })
      assert.equal(answer.status, 401)
    } finally {
      await harness.close()
    }
  })

  check('the listener a peer probe would find is the one that pairs', async () => {
    // Discovery and pairing must agree about what "there is a Studio here" means:
    // the health endpoint the probe reads is served by the same listener the
    // pairing URL points at, on the same port.
    const harness = await startHarness()
    try {
      const health = await call(harness.port, 'GET', '/tailnet/v1/health')
      assert.equal(health.status, 200)
      const body = health.body as Record<string, unknown>
      assert.deepEqual(Object.keys(body).sort(), ['capabilities', 'product', 'protocolVersions', 'transportVersion'])
      assert.deepEqual(body.protocolVersions, [...SUPPORTED_MCP_PROTOCOL_VERSIONS])
      assert.equal(body.transportVersion, 2)
      assert.deepEqual(body.capabilities, [
        'events',
        'upload',
        'conversations',
        'conversation-models',
        'conversation-images',
        'conversation-permission-modes',
        'conversation-hello',
        'conversation-plans',
        'conversation-cli-permission-modes',
        'conversation-lifecycle',
        'conversation-queued-sends',
        'conversation-send-skills',
        'conversation-steer-sends',
        'conversation-message-images',
        'conversation-message-files',
        'conversation-stop-subagent',
        'conversation-handoff',
        'conversation-rewind',
        'conversation-checkpoint-revert',
        'new-chat-worktree',
        'new-chat-effort',
        'cli-runtime-catalog',
        'chat-mark-unread',
        'new-chat-worktree-name',
        'new-chat-in-worktree',
        'workspace-extensions',
        'new-chat-skills',
        'chat-create-pull-request',
        'chat-row-menu',
        'usage-report',
      ])

      const scanned = parsePairingUrl(harness.service.offerPairing().pairingUrl ?? '')
      assert.equal(scanned.port, harness.port, 'the probed port and the pairing port are one port')
    } finally {
      await harness.close()
    }
  })

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('tailnet pairing round-trip tests passed')
  })

  await suiteRun
})
