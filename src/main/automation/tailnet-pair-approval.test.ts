import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hashSecret } from './tailnet/secret-hash'
import { toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../shared/mcp/protocol'
import { TAILNET_PAIR_REQUEST_PATH } from './tailnet/tailnet-routes'
import { createTailnetDeviceStore, DEFAULT_PAIR_REQUEST_TTL_MS } from './tailnet/tailnet-devices'
import { createTailnetRemoteService } from './tailnet/tailnet-service'
import { writeTailnetSettings } from './tailnet/tailnet-settings'
import { test } from 'vitest'

test('tailnet-pair-approval', async () => {
  // Pairing by approval on the machine being driven.
  //
  // The half that runs over the wire is exercised against a REAL listener on a
  // real socket with a real device store, exactly as the carried-code round trip
  // is: the point of the feature is that a stranger can ask and a person can
  // answer, and a mocked listener would only prove the mock says yes.
  //
  // The rules that depend on the clock and on counting — expiry, the caps, the
  // post-denial cooldown — are driven at the store, where `now` can be injected.
  // Wiring a fake clock through a live HTTP server would test the harness.

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
        name: 'workspace.list',
        description: 'Test tool',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => toolSuccess({ workspaces: [] }),
      },
    ]
  }

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

  type HttpAnswer = { status: number; body: Record<string, unknown> }

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
            let body: unknown = {}
            try {
              body = JSON.parse(raw)
            } catch {
              body = { raw }
            }
            resolve({ status: response.statusCode ?? 0, body: (body ?? {}) as Record<string, unknown> })
          })
        },
      )
      request.on('error', reject)
      if (payload) request.write(payload)
      request.end()
    })
  }

  async function startListener(): Promise<{
    service: ReturnType<typeof createTailnetRemoteService>
    port: number
    close: () => Promise<void>
  }> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-approve-'))
    const port = await freePort()
    writeTailnetSettings(userDataDir, { enabled: true, port, notifications: true })
    const service = createTailnetRemoteService({
      resolveUserDataDir: () => userDataDir,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: testTools,
      isMutation: () => false,
      // Loopback is on the bind allowlist precisely so tests drive the real server.
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

  /** What a client keeps to itself, and what it is willing to send. */
  function askingCredential(): { secret: string; hash: string } {
    const secret = 'test-collect-secret-not-a-real-one'
    return { secret, hash: hashSecret(secret) }
  }

  check('a machine asks, a person allows it with the scopes they chose, and the token drives the gateway', async () => {
    const harness = await startListener()
    try {
      const credential = askingCredential()
      const asked = await call(harness.port, 'POST', TAILNET_PAIR_REQUEST_PATH, {
        body: { deviceName: 'Sam’s MacBook Air', collectHash: credential.hash },
      })
      assert.equal(asked.status, 200, 'the ask is accepted')
      const requestId = asked.body.requestId as string
      assert.ok(requestId, 'the ask is answered with a request id')
      assert.match(
        String(asked.body.comparisonCode),
        /^\d{6}$/u,
        'six digits come back to show beside the other screen',
      )

      // The person at this machine sees it waiting, without the digits: they
      // are read off the asking machine's screen, and nothing here reports them.
      const waiting = harness.service.getStatus().pairRequests
      assert.equal(waiting.length, 1, 'the request is waiting to be answered here')
      assert.equal(waiting[0].deviceName, 'Sam’s MacBook Air')
      assert.equal('comparisonCode' in waiting[0], false, 'the status never carries the code')
      assert.doesNotMatch(
        JSON.stringify(harness.service.getStatus()),
        new RegExp(String(asked.body.comparisonCode), 'u'),
        'nor anything else in it',
      )

      // Nothing is collectable until someone answers.
      const early = await call(
        harness.port,
        'GET',
        `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=${credential.secret}`,
      )
      assert.equal(early.body.status, 'pending', 'before the answer, the asker is told to keep waiting')

      const approved = harness.service.approvePairRequest({
        id: requestId,
        scopes: ['workspace:read', 'conversation:operate'],
        // Typed from the asker's screen (phase 2): the digits the ask answered with.
        code: asked.body.comparisonCode as string,
      })
      assert.equal(approved.ok, true, 'approving succeeds')

      const collected = await call(
        harness.port,
        'GET',
        `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=${credential.secret}`,
      )
      assert.equal(collected.body.status, 'approved')
      const deviceToken = collected.body.deviceToken as string
      assert.ok(deviceToken, 'the device token comes back to the asker')
      assert.deepEqual(
        collected.body.scopes,
        ['workspace:read', 'conversation:operate'],
        'the grant is the one the approver chose',
      )

      // And it actually works: the whole point is a device that can now drive this machine.
      const call1 = await call(harness.port, 'POST', '/tailnet/v1/mcp', {
        token: deviceToken,
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: SUPPORTED_MCP_PROTOCOL_VERSIONS[0],
            capabilities: {},
            clientInfo: { name: 't', version: '1' },
          },
        },
      })
      assert.equal(call1.status, 200, 'the minted token authenticates against the gateway')
    } finally {
      await harness.close()
    }
  })

  check('the token can only be collected by the machine that asked', async () => {
    const harness = await startListener()
    try {
      const credential = askingCredential()
      const asked = await call(harness.port, 'POST', TAILNET_PAIR_REQUEST_PATH, {
        body: { deviceName: 'Laptop', collectHash: credential.hash },
      })
      const requestId = asked.body.requestId as string
      harness.service.approvePairRequest({
        id: requestId,
        scopes: ['workspace:read'],
        code: asked.body.comparisonCode as string,
      })

      // Someone who learned the id but not the secret is told exactly what a
      // caller with an invented id is told — so they cannot even confirm it is real.
      const stolen = await call(harness.port, 'GET', `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=wrong-secret`)
      assert.equal(stolen.body.status, 'expired', 'a wrong secret learns nothing')
      assert.equal(stolen.body.deviceToken, undefined, 'and takes no token')

      // A wrong guess must not burn the request, exactly as a wrong pairing code does not.
      const rightful = await call(
        harness.port,
        'GET',
        `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=${credential.secret}`,
      )
      assert.equal(rightful.body.status, 'approved', 'the machine that asked still collects')
      assert.ok(rightful.body.deviceToken, 'and gets its token')
    } finally {
      await harness.close()
    }
  })

  check('the token is handed over exactly once', async () => {
    const harness = await startListener()
    try {
      const credential = askingCredential()
      const asked = await call(harness.port, 'POST', TAILNET_PAIR_REQUEST_PATH, {
        body: { deviceName: 'Laptop', collectHash: credential.hash },
      })
      const requestId = asked.body.requestId as string
      harness.service.approvePairRequest({
        id: requestId,
        scopes: ['workspace:read'],
        code: asked.body.comparisonCode as string,
      })

      const first = await call(
        harness.port,
        'GET',
        `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=${credential.secret}`,
      )
      assert.equal(first.body.status, 'approved')
      const second = await call(
        harness.port,
        'GET',
        `${TAILNET_PAIR_REQUEST_PATH}?id=${requestId}&secret=${credential.secret}`,
      )
      assert.equal(second.body.status, 'expired', 'a replay of the collect gets nothing')
    } finally {
      await harness.close()
    }
  })

  check('a request with no collect hash is refused rather than left unbound', async () => {
    const harness = await startListener()
    try {
      const asked = await call(harness.port, 'POST', TAILNET_PAIR_REQUEST_PATH, {
        body: { deviceName: 'Laptop' },
      })
      assert.equal(asked.status, 400, 'a request that cannot be bound is refused')
      assert.equal(harness.service.getStatus().pairRequests.length, 0, 'and nothing is put in front of a person')
    } finally {
      await harness.close()
    }
  })

  check('declining is an answer, and the declined peer waits before asking again', async () => {
    const store = createTailnetDeviceStore({ resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'tnd-')) })
    const asked = store.requestPairing({
      deviceName: 'Laptop',
      peerNode: 'laptop.example.ts.net',
      peerAddress: '100.64.0.9',
      collectHash: hashSecret('s'),
    })
    assert.equal(asked.ok, true)
    const requestId = asked.ok ? asked.request.id : ''

    assert.equal(store.denyPairRequest(requestId), true, 'the decline lands')
    assert.equal(store.collectPairRequest(requestId, 's').status, 'denied', 'the asker is told it was declined')

    const again = store.requestPairing({
      deviceName: 'Laptop',
      peerNode: 'laptop.example.ts.net',
      peerAddress: '100.64.0.9',
      collectHash: hashSecret('s'),
    })
    assert.equal(again.ok, false, 'the same peer cannot immediately ask again')
    assert.equal(again.ok === false ? again.code : '', 'denied_recently')
  })

  check('one waiting request per peer, so a prompt cannot be spammed', async () => {
    const store = createTailnetDeviceStore({ resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'tnd-')) })
    const first = store.requestPairing({
      deviceName: 'Laptop',
      peerNode: null,
      peerAddress: '100.64.0.9',
      collectHash: hashSecret('s'),
    })
    assert.equal(first.ok, true)
    const second = store.requestPairing({
      deviceName: 'Laptop again',
      peerNode: null,
      peerAddress: '100.64.0.9',
      collectHash: hashSecret('s'),
    })
    assert.equal(second.ok, false, 'the second is refused')
    assert.equal(second.ok === false ? second.code : '', 'too_many_requests')
    assert.equal(store.listPairRequests().length, 1, 'and only one is in front of the person')
  })

  check('a request nobody answered lapses, and cannot be approved afterwards', async () => {
    let clock = Date.parse('2026-09-02T21:00:00.000Z')
    const store = createTailnetDeviceStore({
      resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'tnd-')),
      now: () => new Date(clock),
    })
    const asked = store.requestPairing({
      deviceName: 'Laptop',
      peerNode: null,
      peerAddress: '100.64.0.9',
      collectHash: hashSecret('s'),
    })
    const requestId = asked.ok ? asked.request.id : ''
    clock += DEFAULT_PAIR_REQUEST_TTL_MS + 1000

    assert.equal(store.listPairRequests().length, 0, 'it is no longer in front of anyone')
    const approved = store.approvePairRequest({ id: requestId, scopes: ['workspace:read'], code: '000000' })
    assert.equal(approved.ok, false, 'and approving it does not mint a device')
    assert.equal(store.listDevices().length, 0, 'nothing was granted')
    assert.equal(store.collectPairRequest(requestId, 's').status, 'expired', 'the asker is told it lapsed')
  })

  check('the asker cannot influence what approving it grants', async () => {
    const store = createTailnetDeviceStore({ resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'tnd-')) })
    const asked = store.requestPairing({
      // Whatever a client puts in its body, the grant comes from the approver.
      deviceName: 'Laptop',
      peerNode: null,
      peerAddress: '100.64.0.9',
      collectHash: hashSecret('s'),
    })
    const requestId = asked.ok ? asked.request.id : ''
    const code = asked.ok ? asked.request.comparisonCode : ''
    const approved = store.approvePairRequest({ id: requestId, scopes: ['backlog:read'], code })
    assert.equal(approved.ok, true)
    assert.deepEqual(approved.ok ? approved.device.scopes : [], ['backlog:read'], 'exactly what was ticked')
    assert.deepEqual(
      approved.ok ? approved.device.origin : null,
      { kind: 'approval', by: '100.64.0.9' },
      'the device records that a person here approved it, and from where',
    )
  })

  // ── Confirm by typing the code (pair-from-the-scan-and-stay-paired, phase 2) ──

  check('approving needs the code from the asker’s screen, and three wrong codes decline the request', async () => {
    const store = createTailnetDeviceStore({ resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'tnd-')) })
    const asked = store.requestPairing({
      deviceName: 'Laptop',
      peerNode: 'laptop.example.ts.net',
      peerAddress: '100.64.0.9',
      collectHash: hashSecret('s'),
    })
    assert.equal(asked.ok, true)
    const requestId = asked.ok ? asked.request.id : ''
    const code = asked.ok ? asked.request.comparisonCode : ''

    const blank = store.approvePairRequest({ id: requestId, scopes: ['workspace:read'], code: '' })
    assert.equal(blank.ok === false ? blank.code : '', 'code_required', 'no code is not an approval')
    assert.equal(store.listDevices().length, 0, 'nothing was granted')

    const wrong = (value: string) =>
      store.approvePairRequest({ id: requestId, scopes: ['workspace:read'], code: value })
    const first = wrong(code === '000000' ? '000001' : '000000')
    assert.equal(first.ok === false ? first.code : '', 'code_mismatch')
    assert.equal(first.ok === false && first.code === 'code_mismatch' ? first.attemptsLeft : -1, 2, 'two tries left')
    assert.equal(store.listPairRequests().length, 1, 'the request is still waiting after one typo')

    // The right code, with a space the way a person reads it, still approves.
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`
    const approved = store.approvePairRequest({ id: requestId, scopes: ['workspace:read'], code: spaced })
    assert.equal(approved.ok, true, 'digits are what count; a space read off the screen is not a typo')
    assert.equal(store.collectPairRequest(requestId, 's').status, 'approved', 'and the asker collects')
  })

  check('the third wrong code declines the request and starts the cooldown', async () => {
    const store = createTailnetDeviceStore({ resolveUserDataDir: () => mkdtempSync(join(tmpdir(), 'tnd-')) })
    const asked = store.requestPairing({
      deviceName: 'Laptop',
      peerNode: null,
      peerAddress: '100.64.0.9',
      collectHash: hashSecret('s'),
    })
    const requestId = asked.ok ? asked.request.id : ''
    const code = asked.ok ? asked.request.comparisonCode : ''
    const bad = code === '999999' ? '999998' : '999999'
    const wrong = () => store.approvePairRequest({ id: requestId, scopes: ['workspace:read'], code: bad })
    wrong()
    const second = wrong()
    assert.equal(second.ok === false && second.code === 'code_mismatch' ? second.attemptsLeft : -1, 1)
    const third = wrong()
    assert.equal(
      third.ok === false && third.code === 'code_mismatch' ? third.declined : false,
      true,
      'the third declines',
    )
    assert.equal(store.listPairRequests().length, 0, 'nothing is left waiting')
    assert.equal(store.collectPairRequest(requestId, 's').status, 'denied', 'the asker is told it was declined')
    assert.equal(store.listDevices().length, 0, 'and nothing was granted')
    const again = store.requestPairing({
      deviceName: 'Laptop',
      peerNode: null,
      peerAddress: '100.64.0.9',
      collectHash: hashSecret('s'),
    })
    assert.equal(again.ok === false ? again.code : '', 'denied_recently', 'the same cooldown a pressed Decline gives')
    // The right code, after the decline, is too late.
    const late = store.approvePairRequest({ id: requestId, scopes: ['workspace:read'], code })
    assert.equal(late.ok === false ? late.code : '', 'request_not_found')
  })

  check(
    'a device says where it came from: a code, an approval, an agent, or the reverse half of a pairing',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tnd-'))
      const store = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
      const byCode = store.offerPairing({ scopes: ['workspace:read'] })
      const redeemed = store.redeemPairing({ token: byCode.token, deviceName: 'Phone' })
      assert.deepEqual(redeemed.ok ? redeemed.device.origin : null, { kind: 'code', by: null })

      const byAgent = store.offerPairing({ scopes: ['workspace:read'], origin: { kind: 'agent', by: 'Niamh Mann' } })
      const agentDevice = store.redeemPairing({ token: byAgent.token, deviceName: 'claude-diagnostic' })
      assert.deepEqual(agentDevice.ok ? agentDevice.device.origin : null, { kind: 'agent', by: 'Niamh Mann' })

      const reverse = store.mintDevice({
        name: 'Mac mini',
        scopes: ['backlog:read'],
        origin: { kind: 'reverse', by: 'Mac mini' },
      })
      assert.deepEqual(reverse.device.origin, { kind: 'reverse', by: 'Mac mini' })
      assert.ok(store.authenticate(reverse.deviceToken), 'a reverse device authenticates like any other')

      // Persisted, and a record from before origins were kept reads as unknown.
      const reread = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
      assert.deepEqual(
        reread
          .listDevices()
          .map((device) => device.origin.kind)
          .sort(),
        ['agent', 'code', 'reverse'],
      )
      const legacy = JSON.parse(readFileSync(join(dir, 'tailnet-remote-devices.json'), 'utf8')) as {
        devices: Array<Record<string, unknown>>
      }
      for (const device of legacy.devices) delete device.origin
      writeFileSync(join(dir, 'tailnet-remote-devices.json'), JSON.stringify(legacy))
      const older = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
      assert.ok(
        older.listDevices().every((device) => device.origin.kind === 'unknown'),
        'no origin guessed for an older record',
      )
    },
  )

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('all pair-approval tests passed')
  })

  await suiteRun
})
