import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import type { MeshEvent } from '../../shared/tailnet-mesh'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet/tailnet-devices'
import { createTailnetMeshService, type TailnetMeshService } from './tailnet/tailnet-mesh-service'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet/tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet/tailnet-peer-identity'
import { pairingUrl } from './tailnet/tailnet-service'
import { test } from 'vitest'

test('tailnet-mesh-reachability', async () => {
  // Staying paired (pair-from-the-scan-and-stay-paired, phases 3, 4, 6), on a
  // REAL listener over loopback: main owns the wait on a request and announces
  // every phase; a paired machine is checked and its answer broadcast; a lid
  // closing and opening is a machine going quiet and answering again; a
  // revocation over there is told apart from sleep; and a request may carry
  // the reverse half, so approving on one side pairs both.

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

  function tools(): McpToolRegistration[] {
    return [
      {
        name: 'workspace.list',
        description: 'Test tool',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => toolSuccess({ workspaces: [] }),
      },
    ]
  }

  type Machine = {
    dir: string
    devices: TailnetDeviceStore
    server: TailnetGatewayServer
    port: number
    mesh: TailnetMeshService
    events: MeshEvent[]
    /** Bring the listener down (a lid closing) and back on the same port (opening it). */
    stop(): Promise<void>
    restart(): Promise<void>
    close(): Promise<void>
  }

  /** One "machine": a listener with its device store, and a mesh that can ask others. */
  async function startMachine(name: string, options: { reachabilityIntervalMs?: number } = {}): Promise<Machine> {
    const dir = mkdtempSync(join(tmpdir(), `sprintengine-reach-${name}-`))
    const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
    const events: MeshEvent[] = []
    // The mesh is built first so the listener's reverse-grant hook can reach it.
    let mesh: TailnetMeshService
    const build = (port: number): TailnetGatewayServer =>
      createTailnetGatewayServer({
        bindAddress: '127.0.0.1',
        port,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: tools,
        isMutation: () => false,
        devices,
        peers: createTailnetPeerResolver({ runWhois: async () => null }),
        onReverseGrant: (input) => {
          mesh.adoptReverseGrant(input)
        },
      })
    let server = build(0)
    await server.start()
    const port = server.address()?.port ?? 0
    assert.ok(port > 0)
    mesh = createTailnetMeshService({
      resolveUserDataDir: () => dir,
      resolveDeviceName: () => name,
      resolvePeerName: async () => null,
      onEvent: (event) => events.push(event),
      pairPollMs: 60,
      reachabilityIntervalMs: options.reachabilityIntervalMs ?? 60 * 60_000,
      reachabilityTimeoutMs: 800,
      mintReverseDevice: (input) => {
        const bound = server.isRunning() ? server.address() : null
        if (!bound) return null
        const minted = devices.mintDevice({
          name: input.machineName,
          scopes: input.scopes,
          origin: { kind: 'reverse', by: input.machineName },
        })
        return { ...minted, endpoint: `${bound.address}:${bound.port}` }
      },
      revokeReverseDevice: (deviceId) => {
        devices.revokeDevice(deviceId)
      },
    })
    return {
      dir,
      devices,
      get server() {
        return server
      },
      port,
      mesh,
      events,
      async stop() {
        await server.stop()
      },
      async restart() {
        server = build(port)
        await server.start()
      },
      async close() {
        mesh.shutdown()
        await server.stop().catch(() => {})
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  async function waitFor<T>(read: () => T | undefined | false | null, what: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = read()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  const reachabilityOf = (machine: Machine, connectionId: string) =>
    machine.mesh.getLiveState().reachability.find((entry) => entry.connectionId === connectionId)

  check('a paired machine is checked on start and after every change: reachable, asleep, awake, revoked', async () => {
    const laptop = await startMachine('laptop')
    const mini = await startMachine('mini')
    try {
      const offer = mini.devices.offerPairing({ scopes: ['workspace:read'] })
      const paired = await laptop.mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', mini.port, offer.token) })
      assert.ok(paired.ok)
      const connectionId = paired.connection.id
      assert.equal(paired.connection.pairedVia, 'link')
      // Pairing just answered, so the row is reachable without waiting for a timer.
      assert.equal(reachabilityOf(laptop, connectionId)?.reachable, true, 'reachable straight after pairing')

      // Start: one check now. A snapshot read afterwards agrees with the event.
      laptop.mesh.start()
      await waitFor(
        () => laptop.events.filter((event) => event.kind === 'machine-reachability' && !event.checking).length >= 2,
        'the start check',
      )
      assert.equal(reachabilityOf(laptop, connectionId)?.reachable, true)

      // The lid closes: the next check says not answering, with the reason,
      // and keeps the last time it DID answer.
      const before = reachabilityOf(laptop, connectionId)
      await mini.stop()
      await laptop.mesh.checkReachability(connectionId)
      const asleep = reachabilityOf(laptop, connectionId)
      assert.equal(asleep?.reachable, false)
      assert.equal(asleep?.unauthorized, false, 'sleep is not revocation')
      assert.ok(asleep?.detail, 'the failure is named')
      assert.equal(asleep?.lastReachedAt, before?.lastReachedAt, 'last reached is kept from the last answer')

      // The lid opens: wake re-checks everything at once.
      await mini.restart()
      laptop.mesh.onWake()
      await waitFor(() => reachabilityOf(laptop, connectionId)?.reachable === true, 'reachable after wake')

      // Revoked over there: told apart from sleep, so the row can say "pair again".
      mini.devices.revokeDevice(paired.connection.deviceId)
      await laptop.mesh.checkReachability(connectionId)
      const revoked = reachabilityOf(laptop, connectionId)
      assert.equal(revoked?.reachable, false)
      assert.equal(revoked?.unauthorized, true, 'a 401 is a decision someone made')

      // Forgetting drops the record; nothing is probed for a machine no longer paired.
      laptop.mesh.forget(connectionId)
      assert.equal(reachabilityOf(laptop, connectionId), undefined)
      await laptop.mesh.checkReachability(connectionId)
      assert.equal(reachabilityOf(laptop, connectionId), undefined)
    } finally {
      await laptop.close()
      await mini.close()
    }
  })

  check('the interval keeps checking while a window is open, and one probe per machine is ever in flight', async () => {
    const laptop = await startMachine('laptop', { reachabilityIntervalMs: 80 })
    const mini = await startMachine('mini')
    try {
      const offer = mini.devices.offerPairing({ scopes: ['workspace:read'] })
      const paired = await laptop.mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', mini.port, offer.token) })
      assert.ok(paired.ok)
      laptop.mesh.start()
      laptop.mesh.start()
      const completed = () =>
        laptop.events.filter((event) => event.kind === 'machine-reachability' && !event.checking).length
      await waitFor(() => completed() >= 4, 'several interval checks')
      // Hammer the manual check while the interval runs: every completion pairs
      // with exactly one "checking" announcement — never two probes for one machine.
      await Promise.all([
        laptop.mesh.checkReachability(),
        laptop.mesh.checkReachability(),
        laptop.mesh.checkReachability(),
      ])
      const checking = laptop.events.filter((event) => event.kind === 'machine-reachability' && event.checking).length
      assert.ok(checking <= completed(), `at most one checking per completion (${checking} vs ${completed()})`)
    } finally {
      await laptop.close()
      await mini.close()
    }
  })

  check(
    'the scopes an asker asks for reach the machine being asked, and nothing named is the structured set',
    async () => {
      const laptop = await startMachine('laptop')
      const mini = await startMachine('mini')
      try {
        // Both halves of a both-ways pairing, each with its own set: `scopes` is
        // what the laptop asks to do on the mini, `reverseScopes` what the mini may
        // do on the laptop. They are deliberately different here — one field
        // standing in for both is the bug this closes.
        const asked = await laptop.mesh.requestPairing({
          endpoint: `127.0.0.1:${mini.port}`,
          scopes: ['workspace:read', 'conversation:read', 'conversation:operate'],
          reverseScopes: ['workspace:read'],
        })
        assert.ok(asked.ok, asked.ok ? '' : asked.message)
        const pending = mini.devices.listPairRequests()
        assert.equal(pending.length, 1)
        // Normalised into vocabulary order, so the answering card can compare it to
        // a preset without caring what order the asker listed them in.
        assert.deepEqual(pending[0].requestedScopes, ['workspace:read', 'conversation:read', 'conversation:operate'])
        // A request is not a grant: nothing has been given yet.
        assert.equal(mini.devices.listDevices().length, 0)
        laptop.mesh.cancelPairing(asked.request.requestId)
      } finally {
        await laptop.close()
        await mini.close()
      }

      const laptop2 = await startMachine('laptop2')
      const mini2 = await startMachine('mini2')
      try {
        // An asker that names nothing — an older build, or a client with no opinion
        // — is recorded as the set every pairing path defaulted to before askers
        // could ask, not as a request for no access at all.
        const asked = await laptop2.mesh.requestPairing({ endpoint: `127.0.0.1:${mini2.port}` })
        assert.ok(asked.ok, asked.ok ? '' : asked.message)
        const pending = mini2.devices.listPairRequests()
        assert.deepEqual(pending[0]?.requestedScopes, [
          'workspace:read',
          'workspace:operate',
          'backlog:read',
          'backlog:operate',
        ])
        laptop2.mesh.cancelPairing(asked.request.requestId)
      } finally {
        await laptop2.close()
        await mini2.close()
      }
    },
  )

  check(
    'main owns the wait: a request polls on its own, and its phases are broadcast until the answer lands',
    async () => {
      const laptop = await startMachine('laptop')
      const mini = await startMachine('mini')
      try {
        const asked = await laptop.mesh.requestPairing({ endpoint: `127.0.0.1:${mini.port}` })
        assert.ok(asked.ok, asked.ok ? '' : asked.message)
        assert.equal(asked.request.reverseOffered, false)
        const waiting = laptop.events.find((event) => event.kind === 'pair-request' && event.phase === 'waiting')
        assert.ok(waiting, 'waiting is announced the moment the ask is accepted')
        assert.deepEqual(
          laptop.mesh.getLiveState().requests.map((request) => request.requestId),
          [asked.request.requestId],
          'the snapshot lists it',
        )

        // Nobody here is polling. The request is still pending over there.
        await new Promise((resolve) => setTimeout(resolve, 200))
        const pending = mini.devices.listPairRequests()
        assert.equal(pending.length, 1)
        assert.equal('comparisonCode' in pending[0], false, 'the code is shown on the asking machine only')

        // A wrong code over there is refused; the right one approves.
        const wrong = mini.devices.approvePairRequest({ id: pending[0].id, scopes: ['workspace:read'], code: '000000' })
        assert.equal(wrong.ok, false)
        const approved = mini.devices.approvePairRequest({
          id: pending[0].id,
          scopes: ['workspace:read'],
          code: asked.request.comparisonCode,
        })
        assert.ok(approved.ok)

        // The timer collects it with nobody asking.
        const landed = await waitFor(
          () => laptop.events.find((event) => event.kind === 'pair-request' && event.phase === 'approved'),
          'approved',
        )
        assert.ok(landed.kind === 'pair-request' && landed.connection, 'approved carries the connection')
        assert.equal(landed.connection?.pairedVia, 'request')
        assert.ok(
          laptop.events.some((event) => event.kind === 'machine-paired'),
          'and the mesh announces the machine',
        )
        assert.deepEqual(laptop.mesh.getLiveState().requests, [], 'nothing is waiting any more')
        assert.equal(laptop.mesh.listConnections().length, 1)
        assert.equal(
          reachabilityOf(laptop, landed.connection?.id ?? '')?.reachable,
          true,
          'a machine that just approved is reachable',
        )
        // A late collect from a panel reports what landed, not "expired".
        const late = await laptop.mesh.collectPairing(asked.request.requestId)
        assert.equal(late.ok && late.status, 'approved')
      } finally {
        await laptop.close()
        await mini.close()
      }
    },
  )

  check('a declined request, a lapsed one, and a cancelled one each end the wait with their own phase', async () => {
    const laptop = await startMachine('laptop')
    const mini = await startMachine('mini')
    try {
      const asked = await laptop.mesh.requestPairing({ endpoint: `127.0.0.1:${mini.port}` })
      assert.ok(asked.ok)
      mini.devices.denyPairRequest(mini.devices.listPairRequests()[0].id)
      const denied = await waitFor(
        () => laptop.events.find((event) => event.kind === 'pair-request' && event.phase === 'denied'),
        'denied',
      )
      assert.ok(denied.kind === 'pair-request' && /declined/u.test(denied.detail ?? ''))
      assert.deepEqual(laptop.mesh.getLiveState().requests, [])

      // Cancel: the far end's copy is left to lapse; here it is gone at once.
      // (The denial's cooldown is per peer address; wait it out is not an
      // option in a test, so the second ask uses the cooldown-free store path.)
      mini.devices.cancelPairRequests()
      const laptop2 = await startMachine('laptop2')
      try {
        const mini2 = await startMachine('mini2')
        try {
          const asked2 = await laptop2.mesh.requestPairing({ endpoint: `127.0.0.1:${mini2.port}` })
          assert.ok(asked2.ok)
          laptop2.mesh.cancelPairing(asked2.request.requestId)
          assert.ok(laptop2.events.some((event) => event.kind === 'pair-request' && event.phase === 'cancelled'))
          assert.deepEqual(laptop2.mesh.getLiveState().requests, [])
          const afterCancel = await laptop2.mesh.collectPairing(asked2.request.requestId)
          assert.equal(afterCancel.ok && afterCancel.status, 'expired', 'a cancelled request is not waited on')
        } finally {
          await mini2.close()
        }
      } finally {
        await laptop2.close()
      }
    } finally {
      await laptop.close()
      await mini.close()
    }
  })

  check(
    'a request may carry the reverse half: approving on one side pairs both, and cancelling takes the reverse device back',
    async () => {
      const laptop = await startMachine('laptop')
      const mini = await startMachine('mini')
      try {
        const asked = await laptop.mesh.requestPairing({
          endpoint: `127.0.0.1:${mini.port}`,
          reverseScopes: ['workspace:read', 'backlog:read'],
        })
        assert.ok(asked.ok, asked.ok ? '' : asked.message)
        assert.equal(asked.request.reverseOffered, true)
        const reverseDevices = laptop.devices.listDevices()
        assert.equal(reverseDevices.length, 1, 'the reverse device is minted here at the ask')
        assert.deepEqual(reverseDevices[0].origin, { kind: 'reverse', by: '127.0.0.1' })
        assert.deepEqual(
          reverseDevices[0].scopes,
          ['workspace:read', 'backlog:read'],
          'with the scopes the asker chose for its own machine',
        )

        const pending = mini.devices.listPairRequests()[0]
        assert.ok(
          mini.devices.approvePairRequest({
            id: pending.id,
            scopes: ['workspace:read'],
            code: asked.ok ? asked.request.comparisonCode : '',
          }).ok,
        )
        await waitFor(
          () => laptop.events.find((event) => event.kind === 'pair-request' && event.phase === 'approved'),
          'approved',
        )

        // The mini now lists the laptop as a machine it can drive, with the grant
        // the laptop chose — and it answers, so the reverse pairing is live.
        const reverse = await waitFor(() => mini.mesh.listConnections()[0], 'the reverse connection on the mini')
        assert.equal(reverse.pairedVia, 'reverse')
        assert.equal(reverse.endpoint, `127.0.0.1:${laptop.port}`)
        assert.deepEqual(reverse.scopes, ['workspace:read', 'backlog:read'])
        assert.ok(
          mini.events.some((event) => event.kind === 'machine-paired'),
          'the mini announces it without anyone there pressing anything',
        )
        const browse = await mini.mesh.browse(reverse.id)
        assert.equal(browse.reachable, true, 'the mini can drive the laptop with the reverse token')
        assert.equal(browse.unauthorized, false)
        assert.equal(
          laptop.devices.listDevices().length,
          1,
          'the reverse device stays, revocable by name on the laptop',
        )
      } finally {
        await laptop.close()
        await mini.close()
      }

      // Cancelling before an answer takes the reverse device back.
      const laptop2 = await startMachine('laptop2')
      const mini2 = await startMachine('mini2')
      try {
        const asked = await laptop2.mesh.requestPairing({
          endpoint: `127.0.0.1:${mini2.port}`,
          reverseScopes: ['workspace:read'],
        })
        assert.ok(asked.ok)
        assert.equal(laptop2.devices.listDevices().length, 1)
        laptop2.mesh.cancelPairing(asked.request.requestId)
        assert.equal(laptop2.devices.listDevices().length, 0, 'no orphan grant is left on the asker')
      } finally {
        await laptop2.close()
        await mini2.close()
      }
    },
  )

  check(
    'a reverse grant is refused when the asker has no listener, and ignored when its endpoint is not the asker’s own address',
    async () => {
      const laptop = await startMachine('laptop')
      const mini = await startMachine('mini')
      try {
        await laptop.stop()
        const asked = await laptop.mesh.requestPairing({
          endpoint: `127.0.0.1:${mini.port}`,
          reverseScopes: ['workspace:read'],
        })
        assert.equal(asked.ok, false)
        assert.equal(asked.ok === false ? asked.code : '', 'reverse_unavailable')
        assert.equal(mini.devices.listPairRequests().length, 0, 'nothing was asked over there')
        assert.equal(laptop.devices.listDevices().length, 0, 'and nothing was minted here')
        await laptop.restart()

        // A forged grant pointing somewhere else: the approval completes, the
        // grant does not land.
        const { hashSecret } = await import('./tailnet/secret-hash')
        const { requestTailnetJson } = await import('./tailnet/tailnet-remote-client')
        const { TAILNET_PAIR_COLLECT_PATH, TAILNET_PAIR_REQUEST_PATH } = await import('./tailnet/tailnet-routes')
        const secret = 'forged-collect-secret'
        const askedRaw = await requestTailnetJson({
          endpoint: { host: '127.0.0.1', port: mini.port },
          method: 'POST',
          path: TAILNET_PAIR_REQUEST_PATH,
          body: { deviceName: 'forger', collectHash: hashSecret(secret) },
        })
        const requestId = (askedRaw.body as { requestId: string }).requestId
        const pending = mini.devices.listPairRequests().find((request) => request.id === requestId)
        assert.ok(pending)
        assert.ok(
          mini.devices.approvePairRequest({
            id: requestId,
            scopes: ['workspace:read'],
            code: (askedRaw.body as { comparisonCode: string }).comparisonCode,
          }).ok,
        )
        const collected = await requestTailnetJson({
          endpoint: { host: '127.0.0.1', port: mini.port },
          method: 'POST',
          path: TAILNET_PAIR_COLLECT_PATH,
          body: {
            id: requestId,
            secret,
            reverse: {
              endpoint: '100.64.0.99:8471',
              machineName: 'elsewhere',
              deviceId: 'tnd_x',
              deviceName: 'x',
              deviceToken: 'mctn_x',
              scopes: ['workspace:read'],
            },
          },
        })
        assert.equal((collected.body as { status: string }).status, 'approved', 'the approved pairing still completes')
        assert.equal(
          'asker' in (collected.body as Record<string, unknown>),
          false,
          'the store’s bookkeeping never reaches the wire',
        )
        assert.equal(mini.mesh.listConnections().length, 0, 'a grant that does not dial the asker is not kept')
      } finally {
        await laptop.close()
        await mini.close()
      }
    },
  )

  check('waking re-dials a change-feed watch that was waiting out its backoff', async () => {
    const laptop = await startMachine('laptop')
    const mini = await startMachine('mini')
    try {
      const offer = mini.devices.offerPairing({ scopes: ['workspace:read'] })
      const paired = await laptop.mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', mini.port, offer.token) })
      assert.ok(paired.ok)
      await waitFor(() => mini.server.eventStreamCount() === 1, 'pairing opens a watch on the mini')
      // Long enough for the watch to fail a few dials against the dead port, so
      // its next one is seconds away.
      await mini.stop()
      await new Promise((resolve) => setTimeout(resolve, 2000))
      await mini.restart()
      // Wake: the backoff timer is not waited out; a dial happens now.
      laptop.mesh.onWake()
      await waitFor(() => mini.server.eventStreamCount() === 1, 'an immediate re-dial', 800)
    } finally {
      await laptop.close()
      await mini.close()
    }
  })

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('all mesh reachability tests passed')
  })

  await suiteRun
})
