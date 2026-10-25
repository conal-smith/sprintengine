import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGatewayAuditStore, STUDIO_GATEWAY_AUDIT_FILENAME, type GatewayAuditRecord } from './gateway-audit'
import { createTailnetDeviceStore, TAILNET_DEVICES_FILENAME, type TailnetDeviceStore } from './tailnet/tailnet-devices'
import { hashSecret } from './tailnet/secret-hash'
import {
  createTailnetGatewayServer,
  TAILNET_CAPABILITIES,
  TAILNET_HEALTH_PATH,
  TAILNET_IDENTITY_PATH,
  TAILNET_MCP_PATH,
  TAILNET_PAIR_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_TRANSPORT_VERSION,
  TAILNET_WS_TICKET_PATH,
  type TailnetGatewayServer,
} from './tailnet/tailnet-gateway-server'
import { TAILNET_EVENTS_PATH, TAILNET_UPLOAD_PATH } from './tailnet/tailnet-routes'
import { isAllowedTailnetBindAddress, isTailnetAddress, resolveTailnetInterface } from './tailnet/tailnet-interface'
import {
  createTailnetPeerResolver,
  normalizeAddress,
  peerNameFromWhois,
  type TailnetPeerIdentity,
} from './tailnet/tailnet-peer-identity'
import { localOnlyGatewayToolReason, requiredScopeForTool } from './tailnet/tailnet-scopes'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { createTailnetTools, type TailnetToolsFrontDoor } from './tailnet/tailnet-tools'
import { createTailnetRemoteService, formatEndpoint, pairingUrl } from './tailnet/tailnet-service'
import { DEFAULT_TAILNET_LISTENER_PORT, readTailnetSettings } from './tailnet/tailnet-settings'
import {
  computeWebSocketAcceptKey,
  createWebSocketFrameDecoder,
  encodeMaskedTextFrame,
  encodeTextFrame,
  WEBSOCKET_CLOSE_REVOKED,
} from './tailnet/websocket-frames'
import { SUPPORTED_MCP_PROTOCOL_VERSIONS } from '../../shared/mcp/protocol'
import { STUDIO_MCP_SERVER_NAME } from '../../shared/product-identity'
import { TAILNET_SCOPES, type TailnetRemoteStatus, type TailnetScope } from '../../shared/tailnet'
import type { ConversationGatewayHost } from './tailnet/tailnet-conversation-host'
import { TAILNET_CONVERSATION_PATH } from './tailnet/tailnet-routes'
import { toolSuccess, type McpToolRegistration, type McpToolResult } from '../../shared/modules/mcp-tools'
import { test, vi } from 'vitest'

test('tailnet', async () => {
  // The tailnet listener. Every test here drives the REAL server over a
  // real TCP socket on loopback — the transport, the auth, and the audit are the
  // thing under test, so a fake would prove nothing about any of them.

  // The production classification, never a set of the test's own: the audit
  // decision is part of what these tests cover, and a private list is how a
  // family of remote commands once went unaudited while every test passed.
  const isMutation = (name: string): boolean => isStudioGatewayMutation(name)

  function testTools(calls: string[] = []): McpToolRegistration[] {
    const tool = (name: string): McpToolRegistration => ({
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
      handler: async (args) => {
        calls.push(name)
        return toolSuccess({ ok: true, tool: name, workspaceId: args.workspaceId ?? null })
      },
    })
    return ['backlog.list', 'backlog.update', 'workspace.list', 'workspace.checkout', 'agent.launch'].map(tool)
  }

  type Harness = {
    server: TailnetGatewayServer
    devices: TailnetDeviceStore
    port: number
    userDataDir: string
    calls: string[]
    auditRecords(): Promise<GatewayAuditRecord[]>
    close(): Promise<void>
  }

  function testPeerIdentity(name: string | null): TailnetPeerIdentity | null {
    return name ? { name, stableNodeId: `n-${name}`, loginName: 'dev@example.com' } : null
  }

  async function startHarness(
    options: {
      peerNode?: string | null
      /** Serve a real tool set instead of the named stubs (the whole-flow case). */
      tools?: McpToolRegistration[]
      /** The change feed's push floor; the feed test shortens it. */
      changePushIntervalMs?: number
      conversations?: ConversationGatewayHost
      resolvePeer?: () => Promise<string | null>
    } = {},
  ): Promise<Harness> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-'))
    const calls: string[] = []
    const devices = createTailnetDeviceStore({ resolveUserDataDir: () => userDataDir })
    const audit = createGatewayAuditStore({ resolveUserDataDir: () => userDataDir })
    const server = createTailnetGatewayServer({
      bindAddress: '127.0.0.1',
      port: 0,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: () => options.tools ?? testTools(calls),
      isMutation,
      devices,
      conversations: options.conversations,
      // whois is injected: the tests must not depend on a Tailscale install.
      // A named peer is one node, so the device paired here is bound to it and
      // every later call comes from the same place.
      peers: options.resolvePeer
        ? {
            resolve: options.resolvePeer,
            identify: async () => testPeerIdentity(await options.resolvePeer!()),
          }
        : createTailnetPeerResolver({ runWhois: async () => testPeerIdentity(options.peerNode ?? null) }),
      onToolCall: ({ context, tool, args, durationMs, result, error }) => {
        if (!isMutation(tool)) return
        audit.record({ connection: context.metadata, tool, args, durationMs, result, error })
      },
      ...(options.changePushIntervalMs !== undefined ? { changePushIntervalMs: options.changePushIntervalMs } : {}),
    })
    await server.start()
    const address = server.address()
    assert.ok(address, 'the harness server reports a bound address')
    return {
      server,
      devices,
      port: address.port,
      userDataDir,
      calls,
      auditRecords: async () => {
        await audit.flush()
        const path = join(userDataDir, STUDIO_GATEWAY_AUDIT_FILENAME)
        if (!existsSync(path)) return []
        return readFileSync(path, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as GatewayAuditRecord)
      },
      async close() {
        await server.stop()
        rmSync(userDataDir, { recursive: true, force: true })
      },
    }
  }

  type HttpAnswer = { status: number; headers: Record<string, string | string[] | undefined>; body: unknown }

  function call(
    port: number,
    method: string,
    path: string,
    options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpAnswer> {
    return new Promise((resolve, reject) => {
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          // No connection pooling: a pooled socket from an earlier call would
          // make "is this port still listening" untestable.
          agent: false,
          headers: {
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let body: unknown = text
            try {
              body = text ? JSON.parse(text) : null
            } catch {
              // Left as text; a test asserting on shape will fail loudly.
            }
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
          })
        },
      )
      request.on('error', reject)
      if (payload) request.write(payload)
      request.end()
    })
  }

  /**
   * A raw-body POST, which the upload route needs and `call` cannot express:
   * `call` JSON-encodes whatever it is given, and the upload's whole point is
   * that the body is the file's own bytes.
   */
  function callRaw(
    port: number,
    path: string,
    options: { token?: string; body: Buffer; chunked?: boolean; headers?: Record<string, string> },
  ): Promise<HttpAnswer> {
    return new Promise((resolve, reject) => {
      let answered = false
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path,
          agent: false,
          headers: {
            'Content-Type': 'application/octet-stream',
            // Chunked is the case that matters for the ceiling: a client controls
            // `content-length` and can simply omit it, so the server counts.
            ...(options.chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': options.body.length }),
            ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          answered = true
          const settle = () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let body: unknown = text
            try {
              body = text ? JSON.parse(text) : null
            } catch {
              // Left as text; a test asserting on shape will fail loudly.
            }
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
          }
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', settle)
          // The refusal hangs up, which can close the socket before `end`. The
          // answer is already whole by then, so this settles rather than hangs.
          response.on('close', settle)
          response.on('aborted', settle)
        },
      )
      // The server answers an oversized body before reading all of it and then
      // hangs up, so the write legitimately fails under us. A reset AFTER the
      // answer arrived is the refusal working; a reset BEFORE it must fail loudly
      // rather than hang.
      request.on('error', (error: NodeJS.ErrnoException) => {
        if (answered) return
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
          reject(new Error(`the connection was cut before any answer arrived: ${error.code}`))
          return
        }
        reject(error)
      })
      request.write(options.body)
      request.end()
    })
  }

  function uploadPath(sessionId: string, name: string): string {
    return `${TAILNET_UPLOAD_PATH}?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`
  }

  async function pairDevice(
    harness: Harness,
    options: { scopes?: TailnetScope[]; name?: string } = {},
  ): Promise<{ deviceId: string; deviceToken: string }> {
    const offer = harness.devices.offerPairing({ scopes: options.scopes ?? [...TAILNET_SCOPES] })
    const answer = await call(harness.port, 'POST', TAILNET_PAIR_PATH, {
      body: { pairingToken: offer.token, deviceName: options.name ?? 'laptop' },
    })
    assert.equal(answer.status, 200)
    const body = answer.body as { deviceId: string; deviceToken: string }
    return { deviceId: body.deviceId, deviceToken: body.deviceToken }
  }

  function rpc(id: number, method: string, params?: Record<string, unknown>): Record<string, unknown> {
    return { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
  }

  // ── A minimal client-side WebSocket, enough to prove the server's half ────────

  type TestWebSocket = {
    socket: Socket
    /** The raw HTTP response head — 101 on success, or the refusal that replaced it. */
    handshake: string
    send(payload: Record<string, unknown>): void
    /** Next server text frame, parsed. */
    nextMessage(): Promise<Record<string, unknown>>
    /** Resolves with the close code the server sent, or null if it closed without one. */
    closed: Promise<number | null>
  }

  /** A masked client text frame, in whichever length form the payload needs. */
  function maskedTextFrame(text: string): Buffer {
    const payload = Buffer.from(text, 'utf8')
    assert.ok(payload.length < 65536, 'test frames stay under the 16-bit length form')
    const mask = randomBytes(4)
    const masked = Buffer.from(payload)
    for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4]
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length])
    } else {
      header = Buffer.alloc(4)
      header[0] = 0x81
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    }
    return Buffer.concat([header, mask, masked])
  }

  async function openWebSocket(
    port: number,
    ticket: string,
    route: { path?: string; query?: Record<string, string> } = {},
  ): Promise<TestWebSocket> {
    const key = randomBytes(16).toString('base64')
    const socket = connect({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const extraQuery = Object.entries(route.query ?? {})
      .map(([name, value]) => `&${name}=${encodeURIComponent(value)}`)
      .join('')
    socket.write(
      [
        `GET ${route.path ?? TAILNET_STREAM_PATH}?ticket=${encodeURIComponent(ticket)}${extraQuery} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    )

    const messages: Record<string, unknown>[] = []
    const waiters: Array<(value: Record<string, unknown>) => void> = []
    let closeCode: number | null = null
    let resolveClosed: (code: number | null) => void = () => {}
    const closed = new Promise<number | null>((resolve) => {
      resolveClosed = resolve
    })

    // Declared BEFORE the handshake await: the change feed sends its hello
    // frame immediately after the 101, so `consume` can run from inside the
    // handshake handler — with the declaration below the await that is a
    // temporal-dead-zone crash rather than a decoded frame.
    let buffer = Buffer.alloc(0)

    const handshake = await new Promise<string>((resolve, reject) => {
      let headBuffer = Buffer.alloc(0)
      const onData = (chunk: Buffer): void => {
        headBuffer = Buffer.concat([headBuffer, chunk])
        const end = headBuffer.indexOf('\r\n\r\n')
        if (end === -1) return
        socket.removeListener('data', onData)
        const head = headBuffer.subarray(0, end + 4).toString('utf8')
        const rest = headBuffer.subarray(end + 4)
        socket.on('data', (next: Buffer) => consume(next))
        if (rest.length) consume(rest)
        resolve(head)
      }
      socket.on('data', onData)
      socket.once('error', reject)
      socket.once('close', () => resolve(headBuffer.toString('utf8')))
    })
    if (handshake.startsWith('HTTP/1.1 101')) {
      assert.ok(
        handshake.includes(`Sec-WebSocket-Accept: ${computeWebSocketAcceptKey(key)}`),
        'the server computes the RFC 6455 accept key',
      )
    }

    // Server frames are never masked, so the shared decoder cannot read them;
    // this is the client-side mirror of it, and small enough to keep inline.
    function consume(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 2) return
        const opcode = buffer[0] & 0x0f
        let length = buffer[1] & 0x7f
        let offset = 2
        if (length === 126) {
          if (buffer.length < 4) return
          length = buffer.readUInt16BE(2)
          offset = 4
        }
        if (buffer.length < offset + length) return
        const payload = buffer.subarray(offset, offset + length)
        buffer = buffer.subarray(offset + length)
        if (opcode === 0x8) {
          closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null
          resolveClosed(closeCode)
          return
        }
        if (opcode !== 0x1) continue
        const parsed = JSON.parse(payload.toString('utf8')) as Record<string, unknown>
        const waiter = waiters.shift()
        if (waiter) waiter(parsed)
        else messages.push(parsed)
      }
    }
    socket.on('close', () => resolveClosed(closeCode))

    return {
      socket,
      handshake,
      send: (payload) => socket.write(maskedTextFrame(JSON.stringify(payload))),
      nextMessage: () =>
        new Promise((resolve) => {
          const queued = messages.shift()
          if (queued) resolve(queued)
          else waiters.push(resolve)
        }),
      closed,
    }
  }

  async function waitFor(
    predicate: () => boolean | Promise<boolean>,
    description: string,
    timeoutMs = 2000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for ${description}`)
  }

  // ── Bind policy ──────────────────────────────────────────────────────────────

  async function testBindAddressAllowsOnlyTailnetOrLoopback(): Promise<void> {
    for (const allowed of [
      '100.64.0.1',
      '100.101.102.103',
      '100.127.255.254',
      '127.0.0.1',
      '::1',
      'fd7a:115c:a1e0::1',
    ]) {
      assert.equal(isAllowedTailnetBindAddress(allowed), true, `${allowed} is a legal bind address`)
    }
    for (const refused of [
      '0.0.0.0',
      '::',
      '',
      '192.168.1.20',
      '10.0.0.4',
      '172.16.3.9',
      '100.63.255.255',
      '100.128.0.1',
      '8.8.8.8',
    ]) {
      assert.equal(isAllowedTailnetBindAddress(refused), false, `${refused} must never be bound`)
    }
    // 100.64.0.0/10 boundaries, stated separately from the bind allowlist so a
    // loopback exemption cannot hide a wrong range.
    assert.equal(isTailnetAddress('100.64.0.0'), true)
    assert.equal(isTailnetAddress('100.127.255.255'), true)
    assert.equal(isTailnetAddress('100.63.255.255'), false)
    assert.equal(isTailnetAddress('100.128.0.0'), false)
    assert.equal(isTailnetAddress('127.0.0.1'), false)

    // The server refuses before listen(), so a bad address never opens a port.
    for (const bindAddress of ['0.0.0.0', '192.168.1.20']) {
      const refused = createTailnetGatewayServer({
        bindAddress,
        port: 0,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => [],
        isMutation: () => false,
        devices: createTailnetDeviceStore({ resolveUserDataDir: () => tmpdir() }),
        peers: createTailnetPeerResolver({ runWhois: async () => null }),
      })
      await assert.rejects(() => refused.start(), /Refusing to bind the tailnet gateway/u)
      assert.equal(refused.isRunning(), false)
      assert.equal(refused.address(), null)
    }

    // Whatever this machine reports must itself satisfy the policy — a resolver
    // that handed back a LAN address would defeat every guard above.
    const resolved = resolveTailnetInterface()
    if (resolved) assert.equal(isTailnetAddress(resolved.address), true)
    assert.equal(
      resolveTailnetInterface({ en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false } as never] }),
      null,
      'a LAN-only machine has no tailnet interface',
    )
  }

  async function testDisabledMeansNoListeningTcpSocket(): Promise<void> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-off-'))
    try {
      // Default-off in every build: a profile that has never been configured.
      assert.deepEqual(readTailnetSettings(userDataDir).settings, {
        enabled: false,
        port: DEFAULT_TAILNET_LISTENER_PORT,
        notifications: true,
      })

      const service = createTailnetRemoteService({
        resolveUserDataDir: () => userDataDir,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => testTools(),
        isMutation,
        resolveBindAddress: () => '127.0.0.1',
      })
      const initial = await service.initialize()
      assert.equal(initial.enabled, false)
      assert.equal(initial.running, false)
      assert.equal(initial.endpoint, null)

      // Turn it on to learn a port that is definitely ours, then turn it off and
      // prove the socket is gone rather than merely reported as stopped.
      const enabled = await service.setEnabled(true)
      assert.equal(enabled.running, true)
      assert.ok(enabled.endpoint?.startsWith('127.0.0.1:'), `endpoint is loopback-bound: ${enabled.endpoint}`)
      const port = Number(enabled.endpoint?.split(':').pop())
      assert.equal((await call(port, 'GET', TAILNET_HEALTH_PATH)).status, 200)

      const disabled = await service.setEnabled(false)
      assert.equal(disabled.running, false)
      assert.equal(disabled.endpoint, null)
      await assert.rejects(() => call(port, 'GET', TAILNET_HEALTH_PATH), /ECONNREFUSED/u)
      await service.shutdown()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  async function testEnabledWithoutATailnetRefusesInsteadOfBindingAnythingElse(): Promise<void> {
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-none-'))
    try {
      const service = createTailnetRemoteService({
        resolveUserDataDir: () => userDataDir,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => [],
        isMutation: () => false,
        // Tailscale is not up on this machine.
        resolveBindAddress: () => null,
      })
      const status = await service.setEnabled(true)
      assert.equal(status.enabled, true)
      assert.equal(status.running, false)
      assert.equal(status.endpoint, null)
      assert.match(status.lastError ?? '', /no Tailscale interface was found/u)
      await service.shutdown()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  async function testTheListenerBindsWhenTailscaleComesUpAfterTheApp(): Promise<void> {
    // The boot race the owner hit on 2026-09-05: Studio launched from a login
    // item before Tailscale was up, the listener refused to bind, and nothing
    // ever looked again — the setting read `enabled: true` for hours while the
    // phone got "the desktop did not answer" from a machine that was running
    // fine. The refusal must be a "not yet", not a verdict.
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-late-'))
    try {
      // A port nothing else holds, and loopback as the "interface": the bind
      // guard allows loopback, and a real 100.64/10 address cannot be bound on a
      // machine that does not actually have it (EADDRNOTAVAIL). The setting file
      // is written directly because the port must be free BEFORE the service
      // reads it — `isUsablePort` refuses 0, so there is no ephemeral escape.
      const port = await freePort()
      writeFileSync(
        join(userDataDir, 'tailnet-remote-settings.json'),
        JSON.stringify({ enabled: false, port, notifications: true }),
      )

      let tailscaleIsUp = false
      const service = createTailnetRemoteService({
        resolveUserDataDir: () => userDataDir,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => [],
        isMutation: () => false,
        resolveBindAddress: () => (tailscaleIsUp ? '127.0.0.1' : null),
        interfaceWatchMs: 5,
      })

      const refused = await service.setEnabled(true)
      assert.equal(refused.running, false, 'nothing binds while there is no interface')
      assert.match(refused.lastError ?? '', /no Tailscale interface was found/u)

      tailscaleIsUp = true
      await waitFor(() => service.getStatus().running, 'the listener to bind once an interface appears')
      const bound = service.getStatus()
      assert.equal(bound.running, true, 'the watcher binds once an interface appears')
      assert.equal(bound.endpoint, `127.0.0.1:${port}`, 'bound somewhere unexpected')
      assert.equal(bound.lastError, null, 'the stale refusal is cleared once it stops being true')

      await service.shutdown()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  async function testTheListenerStandsDownWhenTailscaleGoesAway(): Promise<void> {
    // The other half of the late-Tailscale watch. Quitting Tailscale takes the
    // address off the interface, but the socket bound to it stays open as far as
    // Node is concerned — so `isRunning()` kept answering true and every surface
    // said "Serving" against a machine nothing could reach. Reported by the
    // owner on 2026-09-05, having disconnected Tailscale and watched the glyph
    // stay green.
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-away-'))
    try {
      const port = await freePort()
      writeFileSync(
        join(userDataDir, 'tailnet-remote-settings.json'),
        JSON.stringify({ enabled: false, port, notifications: true }),
      )
      let tailscaleIsUp = true
      const events: Array<{ running: boolean; error: string | null }> = []
      const service = createTailnetRemoteService({
        resolveUserDataDir: () => userDataDir,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => [],
        isMutation: () => false,
        resolveBindAddress: () => (tailscaleIsUp ? '127.0.0.1' : null),
        interfaceWatchMs: 5,
        onEvent: (payload) => {
          if (payload.event.kind === 'listener') {
            events.push({ running: payload.event.running, error: payload.event.running ? null : payload.event.error })
          }
        },
      })

      const serving = await service.setEnabled(true)
      assert.equal(serving.running, true, 'bound while Tailscale is up')

      tailscaleIsUp = false
      await waitFor(() => !service.getStatus().running, 'the listener to stand down when the interface goes away')
      const down = service.getStatus()
      assert.equal(down.running, false, 'not serving, because nothing can reach it')
      assert.equal(down.endpoint, null, 'and no endpoint is claimed')
      assert.match(down.lastError ?? '', /Tailscale is no longer up/u, 'the reason is said, not left blank')
      assert.ok(
        events.some((event) => !event.running && /no longer up/u.test(event.error ?? '')),
        'every window is told over the push channel, not on next open',
      )

      // And the same beat brings it back: standing down is not a verdict either.
      tailscaleIsUp = true
      await waitFor(() => service.getStatus().running, 'the listener to bind again when Tailscale returns')
      assert.equal(service.getStatus().lastError, null, 'the stale reason is cleared once it stops being true')

      await service.shutdown()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  /** A port that is free right now, for a test that must really bind one. */
  async function freePort(): Promise<number> {
    const net = await import('node:net')
    return await new Promise<number>((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        const value = typeof address === 'object' && address ? address.port : 0
        probe.close(() => resolve(value))
      })
    })
  }

  async function testTheInterfaceWatchStopsWhenTheListenerIsTurnedOff(): Promise<void> {
    // The watch must not outlive the setting: a machine that never runs
    // Tailscale, with remote turned back off, should be enumerating nothing.
    const userDataDir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-watch-'))
    try {
      let looks = 0
      const service = createTailnetRemoteService({
        resolveUserDataDir: () => userDataDir,
        serverName: 'sprintengine-studio',
        serverVersion: '9.9.9',
        resolveTools: () => [],
        isMutation: () => false,
        resolveBindAddress: () => {
          looks += 1
          return null
        },
        interfaceWatchMs: 5,
      })
      await service.setEnabled(true)
      await new Promise((resolve) => setTimeout(resolve, 40))
      await service.setEnabled(false)
      const afterOff = looks
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.equal(looks, afterOff, 'the watch kept polling after remote control was turned off')
      await service.shutdown()
    } finally {
      rmSync(userDataDir, { recursive: true, force: true })
    }
  }

  // ── Pairing and authentication ───────────────────────────────────────────────

  async function testUnpairedClientsGet401AndPairedClientsDriveTheGateway(): Promise<void> {
    const harness = await startHarness({ peerNode: 'mac-mini.tail1234.ts.net' })
    try {
      const unauthorized = await call(harness.port, 'POST', TAILNET_MCP_PATH, { body: rpc(1, 'tools/list') })
      assert.equal(unauthorized.status, 401)
      assert.equal((unauthorized.body as { error: { code: string } }).error.code, 'unauthorized')
      assert.match(String(unauthorized.headers['www-authenticate']), /^Bearer /u)

      assert.equal(
        (
          await call(harness.port, 'POST', TAILNET_MCP_PATH, {
            token: 'mctn_not-a-real-token',
            body: rpc(1, 'tools/list'),
          })
        ).status,
        401,
        'a fabricated token is not a credential',
      )

      const device = await pairDevice(harness)
      const listed = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(2, 'tools/list'),
      })
      assert.equal(listed.status, 200)
      const tools = (listed.body as { result: { tools: Array<{ name: string }>; ttlMs: number } }).result
      // `agent.launch` is registered but starts an agent in a terminal, so it
      // stays on the local socket whatever the device's scopes.
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        'backlog.list',
        'backlog.update',
        'workspace.checkout',
        'workspace.list',
      ])
      assert.equal(tools.ttlMs, 300_000, 'the tailnet transport carries the same tools/list TTL as the socket')

      const called = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(3, 'tools/call', { name: 'workspace.list', arguments: { workspaceId: 'w1' } }),
      })
      assert.equal(called.status, 200)
      assert.deepEqual(harness.calls, ['workspace.list'])
      assert.equal(
        (called.body as { result: { structuredContent: { workspaceId: string } } }).result.structuredContent
          .workspaceId,
        'w1',
      )

      const identity = await call(harness.port, 'GET', TAILNET_IDENTITY_PATH, { token: device.deviceToken })
      assert.equal(identity.status, 200)
      assert.equal((identity.body as { deviceId: string }).deviceId, device.deviceId)
      // Identity says the same wire facts health does, for a client that paired
      // long ago and is asking again on a Studio that may since have moved on.
      const identityBody = identity.body as Record<string, unknown>
      assert.equal(identityBody.transportVersion, TAILNET_TRANSPORT_VERSION)
      assert.deepEqual(identityBody.capabilities, [
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

      // The pairing code is one-time: replaying it does not mint a second device.
      const replayed = await call(harness.port, 'POST', TAILNET_PAIR_PATH, {
        body: { pairingToken: 'mcpair_whatever', deviceName: 'laptop-2' },
      })
      assert.equal(replayed.status, 401)
      assert.equal(harness.devices.listDevices().length, 1)

      // Only the hash is persisted; the device token itself never reaches disk.
      const stored = readFileSync(join(harness.userDataDir, TAILNET_DEVICES_FILENAME), 'utf8')
      assert.equal(stored.includes(device.deviceToken), false, 'the device token is never written to disk')
      assert.match(stored, /"tokenHash": "[0-9a-f]{64}"/u)
    } finally {
      await harness.close()
    }
  }

  async function testBrowserOriginatedRequestsAreRefused(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness)
      const answer = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/list'),
        headers: { Origin: 'http://evil.example' },
      })
      assert.equal(answer.status, 403)
      assert.equal((answer.body as { error: { code: string } }).error.code, 'origin_not_allowed')
    } finally {
      await harness.close()
    }
  }

  async function testOversizedAndMalformedBodiesAreRefusedExplicitly(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness)
      const oversize = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: { jsonrpc: '2.0', id: 1, method: 'ping', params: { padding: 'x'.repeat(1024 * 1024 + 16) } },
      })
      assert.equal(oversize.status, 413, 'the client learns why, rather than seeing a bare reset')
      assert.equal((oversize.body as { error: { code: string } }).error.code, 'body_too_large')

      const malformed = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        headers: { 'Content-Type': 'application/json' },
        body: 'not-an-object',
      })
      assert.equal(malformed.status, 200)
      assert.equal(
        (malformed.body as { error: { code: number } }).error.code,
        -32600,
        'a non-JSON-RPC body is a JSON-RPC invalid-request, not a transport error',
      )

      // The listener still answers after both refusals.
      assert.equal((await call(harness.port, 'GET', TAILNET_HEALTH_PATH)).status, 200)
    } finally {
      await harness.close()
    }
  }

  async function testHealthEndpointLeaksNothingBeyondProductAndProtocol(): Promise<void> {
    const harness = await startHarness()
    try {
      await pairDevice(harness, { name: 'a-device-nobody-should-learn-about' })
      const answer = await call(harness.port, 'GET', TAILNET_HEALTH_PATH)
      assert.equal(answer.status, 200)
      const body = answer.body as Record<string, unknown>
      assert.deepEqual(Object.keys(body).sort(), ['capabilities', 'product', 'protocolVersions', 'transportVersion'])
      assert.equal(body.product, STUDIO_MCP_SERVER_NAME)
      assert.deepEqual(body.protocolVersions, [...SUPPORTED_MCP_PROTOCOL_VERSIONS])
      // What the wire speaks IS a prospective client's business: it is the whole
      // reason the route is unauthenticated. Version 2 and the feature list say
      // it outright, so a phone need not probe for the change feed.
      assert.equal(body.transportVersion, 2)
      assert.equal(TAILNET_TRANSPORT_VERSION, 2)
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
      // Every one the wire defines but shrinking an upload, which only a
      // machine with an image codec advertises; this harness has none.
      assert.deepEqual(
        TAILNET_CAPABILITIES.filter((capability) => capability !== 'conversation-image-downscale'),
        body.capabilities,
      )
      // Nothing about this machine, its user, its workspaces, or its devices.
      assert.equal(JSON.stringify(body).includes('a-device-nobody-should-learn-about'), false)
    } finally {
      await harness.close()
    }
  }

  // ── Scopes ───────────────────────────────────────────────────────────────────

  async function testScopesNarrowWhatADeviceSeesAndMayCall(): Promise<void> {
    assert.equal(requiredScopeForTool('backlog.update', true), 'backlog:operate')
    assert.equal(requiredScopeForTool('backlog.list', false), 'backlog:read')
    // The catch-all family, including a tool this mapping has never seen.
    assert.equal(requiredScopeForTool('review_submit_brief', true), 'workspace:operate')
    assert.equal(requiredScopeForTool('some.future.tool', true), 'workspace:operate')
    // The mobile companion lane: the snapshot is a plain read; the command
    // envelope is classified a mutation, so a paired phone needs
    // workspace:operate to drive it and every dispatch is audited.
    assert.equal(
      requiredScopeForTool('workspace.snapshot', isStudioGatewayMutation('workspace.snapshot')),
      'workspace:read',
    )
    // checkout-and-branch-on-remote-create: the checkout facts are a plain read.
    assert.equal(
      requiredScopeForTool('workspace.checkout', isStudioGatewayMutation('workspace.checkout')),
      'workspace:read',
    )
    assert.equal(
      requiredScopeForTool('workspace.mobile_command', isStudioGatewayMutation('workspace.mobile_command')),
      'workspace:operate',
    )

    const harness = await startHarness()
    try {
      // Read-only on the backlog, nothing else.
      const device = await pairDevice(harness, { scopes: ['backlog:read'] })
      const listed = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/list'),
      })
      assert.deepEqual(
        (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name),
        ['backlog.list'],
      )

      const refused = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(2, 'tools/call', { name: 'backlog.update', arguments: {} }),
      })
      assert.equal(refused.status, 200, 'an authorization refusal is a tool result, not a transport failure')
      const result = (refused.body as { result: { isError: boolean; structuredContent: { error: { code: string } } } })
        .result
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.error.code, 'tailnet_scope_required')
      assert.deepEqual(harness.calls, [], 'the refused handler never ran')

      // A refused MUTATION is still audited: an attempt is a security event.
      const audited = await harness.auditRecords()
      assert.equal(audited.length, 1)
      assert.equal(audited[0].tool, 'backlog.update')
      assert.equal(audited[0].outcome, 'failure')
      assert.equal(audited[0].errorCode, 'tailnet_scope_required')

      // checkout-and-branch-on-remote-create: the checkout facts a remote chat
      // reads before it starts are served on a read grant, and not audited.
      const checkoutReader = await pairDevice(harness, { scopes: ['workspace:read'], name: 'air' })
      const checkout = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: checkoutReader.deviceToken,
        body: rpc(4, 'tools/call', { name: 'workspace.checkout', arguments: { workspaceId: 'w1' } }),
      })
      assert.equal((checkout.body as { result: { isError?: boolean } }).result.isError, undefined)
      assert.deepEqual(harness.calls, ['workspace.checkout'])
      assert.ok(
        !(await harness.auditRecords()).some((record) => record.tool === 'workspace.checkout'),
        'the checkout read is not a mutation and is not audited',
      )

      // operate implies read within its family, and never across families.
      const operator = await pairDevice(harness, { scopes: ['backlog:operate'], name: 'operator' })
      const operatorTools = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: operator.deviceToken,
        body: rpc(3, 'tools/list'),
      })
      assert.deepEqual(
        (operatorTools.body as { result: { tools: Array<{ name: string }> } }).result.tools
          .map((tool) => tool.name)
          .sort(),
        ['backlog.list', 'backlog.update'],
      )
    } finally {
      await harness.close()
    }
  }

  // ── The tailnet.* configuration family ───────────────────────────────────────

  async function testTailnetConfigurationToolsAreNeverServedOverTheTailnet(): Promise<void> {
    // The prefix rule is the guarantee, so pin that the whole family answers to
    // it — a tool added later that did not would be served remotely by default.
    const names = createTailnetTools({ resolveTailnet: () => null }).map((tool) => tool.name)
    assert.ok(names.length > 0)
    assert.deepEqual(
      names.filter((name) => localOnlyGatewayToolReason(name) === null),
      [],
    )
    // The tools that start an agent in a terminal stay local too: a paired
    // device could not see the terminal it started. What it starts is a chat.
    const launchers = ['agent.launch', 'backlog.work']
    for (const name of [...launchers, 'tailnet.status']) {
      assert.notEqual(localOnlyGatewayToolReason(name), null, `${name} is local-only`)
    }
    // A scheduled agent's run is a chat, which a paired device can follow.
    for (const name of ['conversation.create', 'schedule.run', 'workspace.list', 'backlog.list']) {
      assert.equal(localOnlyGatewayToolReason(name), null, `${name} may be served over the tailnet`)
    }
    assert.match(localOnlyGatewayToolReason('agent.launch') ?? '', /conversation\.create/u)

    const calls: string[] = []
    // `agent.launch` is already one of the named stubs.
    const stubs: McpToolRegistration[] = [...names, 'backlog.work'].map((name) => ({
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        calls.push(name)
        return toolSuccess({ ok: true })
      },
    }))
    const harness = await startHarness({ tools: [...testTools(calls), ...stubs] })
    try {
      // Every scope the vocabulary has — this is the most-trusted device that
      // can exist, and it still may not see the family.
      const device = await pairDevice(harness, { scopes: [...TAILNET_SCOPES] })
      const listed = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/list'),
      })
      const served = (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      )
      assert.deepEqual(
        served.filter((name) => name.startsWith('tailnet.')),
        [],
        'the family is invisible to a paired device',
      )
      assert.deepEqual(
        served.filter((name) => launchers.includes(name)),
        [],
        'and so are the terminal launchers',
      )
      assert.ok(served.includes('backlog.update'), 'everything else a full grant covers is still served')

      const refused = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(2, 'tools/call', { name: 'tailnet.offer_pairing', arguments: {} }),
      })
      assert.equal(refused.status, 200, 'a local-only refusal is a tool result, not a transport failure')
      const result = (refused.body as { result: { isError: boolean; structuredContent: { error: { code: string } } } })
        .result
      assert.equal(result.isError, true)
      assert.equal(result.structuredContent.error.code, 'tailnet_local_only')
      assert.deepEqual(calls, [], 'the refused handler never ran, so no code was minted')

      // A device manufacturing another grant is the attempt this rule exists to
      // stop; it is audited with the device that made it, like any mutation.
      const audited = await harness.auditRecords()
      assert.equal(audited.length, 1)
      assert.equal(audited[0].tool, 'tailnet.offer_pairing')
      assert.equal(audited[0].outcome, 'failure')
      assert.equal(audited[0].errorCode, 'tailnet_local_only')

      // A launcher is refused the same way, and the attempt is audited.
      const launch = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(3, 'tools/call', { name: 'agent.launch', arguments: { workspaceId: 'w1' } }),
      })
      const launchResult = (
        launch.body as { result: { isError: boolean; structuredContent: { error: { code: string } } } }
      ).result
      assert.equal(launchResult.isError, true)
      assert.equal(launchResult.structuredContent.error.code, 'tailnet_local_only')
      assert.deepEqual(calls, [], 'the refused launcher never ran')
      const launchAudit = (await harness.auditRecords()).filter((record) => record.tool === 'agent.launch')
      assert.equal(launchAudit.length, 1)
      assert.equal(launchAudit[0].outcome, 'failure')
      assert.equal(launchAudit[0].errorCode, 'tailnet_local_only')
      assert.equal(launchAudit[0].connection.deviceId, device.deviceId)
    } finally {
      await harness.close()
    }
  }

  // terminal.list, terminal.read and terminal.create serve agents on this
  // machine. A paired device, however wide its grant, neither sees them nor
  // may call them, and a call it makes anyway is refused as local-only; the
  // create, a mutation like agent.launch, lands in the audit with the device
  // that asked. A list and a read of a terminal's output are reads, and reads
  // stay unaudited — and would need only `workspace:read`, never an operate
  // grant, were the family ever served.
  async function testTerminalToolsAreNeverServedOverTheTailnet(): Promise<void> {
    const terminalTools = ['terminal.list', 'terminal.read', 'terminal.create']
    for (const name of terminalTools) {
      assert.notEqual(localOnlyGatewayToolReason(name), null, `${name} is local-only`)
    }
    assert.match(localOnlyGatewayToolReason('terminal.create') ?? '', /conversation\.create/u)
    assert.notEqual(localOnlyGatewayToolReason('terminal.anything_later'), null, 'the family is local by its prefix')
    assert.equal(isMutation('terminal.create'), true, 'creating a terminal is audited like agent.launch')
    assert.equal(isMutation('terminal.list'), false)
    assert.equal(isMutation('terminal.read'), false, 'reading output is a read')
    assert.equal(requiredScopeForTool('terminal.read', isMutation('terminal.read')), 'workspace:read')

    const calls: string[] = []
    const stubs: McpToolRegistration[] = terminalTools.map((name) => ({
      name,
      description: `Test tool ${name}`,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        calls.push(name)
        return toolSuccess({ ok: true })
      },
    }))
    const harness = await startHarness({ tools: [...testTools(calls), ...stubs] })
    try {
      const device = await pairDevice(harness, { scopes: [...TAILNET_SCOPES] })
      const listed = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/list'),
      })
      const served = (listed.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      )
      assert.deepEqual(
        served.filter((name) => name.startsWith('terminal.')),
        [],
        'a paired device is not shown the terminal tools',
      )
      assert.ok(served.includes('workspace.list'), 'the rest of a full grant is still served')

      for (const [index, name] of terminalTools.entries()) {
        const answer = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
          token: device.deviceToken,
          body: rpc(2 + index, 'tools/call', { name, arguments: { workspaceId: 'w1' } }),
        })
        assert.equal(answer.status, 200, 'a local-only refusal is a tool result, not a transport failure')
        const result = (answer.body as { result: { isError: boolean; structuredContent: { error: { code: string } } } })
          .result
        assert.equal(result.isError, true, `${name} is refused`)
        assert.equal(result.structuredContent.error.code, 'tailnet_local_only')
      }
      assert.deepEqual(calls, [], 'neither handler ran')

      const audited = await harness.auditRecords()
      assert.deepEqual(
        audited.map((record) => record.tool),
        ['terminal.create'],
      )
      assert.equal(audited[0].outcome, 'failure')
      assert.equal(audited[0].errorCode, 'tailnet_local_only')
      assert.equal(audited[0].connection.deviceId, device.deviceId)
    } finally {
      await harness.close()
    }
  }

  async function testTailnetToolsRefuseRatherThanMintACodeThatPointsAtNothing(): Promise<void> {
    const base: TailnetRemoteStatus = {
      enabled: false,
      running: false,
      endpoint: null,
      port: 8787,
      tailnetAddress: null,
      lastError: null,
      notifications: true,
      devices: [],
      pairing: null,
      pairRequests: [],
    }
    let status: TailnetRemoteStatus = { ...base }
    const minted: Array<{ scopes?: unknown }> = []
    const front: TailnetToolsFrontDoor = {
      getTailnetStatus: () => status,
      setTailnetEnabled: async (enabled) => {
        status = {
          ...status,
          enabled,
          running: false,
          lastError: enabled ? 'Tailscale is not running on this machine.' : null,
        }
        return status
      },
      offerTailnetPairing: (input) => {
        minted.push(input ?? {})
        return {
          token: 'mcpair_test',
          scopes: [...TAILNET_SCOPES],
          expiresAt: '2026-09-09T00:00:00.000Z',
          pairingUrl: 'sprintengine-tailnet://pair?endpoint=100.64.0.1%3A8787&token=mcpair_test',
        }
      },
      // This test is about refusing to mint a code that points at nothing, not
      // about approvals — the two request handlers exist to satisfy the front-door
      // contract and are never reached here.
      approveTailnetPairRequest: () => ({
        ok: false as const,
        code: 'request_not_found' as const,
        message: 'No such pairing request.',
        status,
      }),
      denyTailnetPairRequest: () => status,
      cancelTailnetPairing: () => status,
      revokeTailnetDevice: () => status,
      listTailnetPeers: async () => ({
        tailscaleAvailable: false,
        unavailableReason: 'The Tailscale CLI was not found on this machine.',
        probedPort: 8787,
        peers: [],
      }),
    }
    const tools = new Map(createTailnetTools({ resolveTailnet: () => front }).map((tool) => [tool.name, tool]))
    const run = (name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> => {
      const tool = tools.get(name)
      assert.ok(tool, `${name} is registered`)
      return tool.handler(args)
    }
    const errorCode = (result: McpToolResult): string =>
      (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code ?? ''
    // Tool content is a union of text and image parts (the browser tools return
    // snapshots); every tailnet tool answers in text, so narrow before reading it.
    const firstText = (result: McpToolResult): string => {
      const part = result.content[0]
      assert.ok(part && part.type === 'text', 'the tool answered with a text part')
      return part.text
    }

    // Nothing listening: a code is a URL pointing at a listener, so minting one
    // here would hand back a credential that cannot be redeemed anywhere. Same
    // rule the Settings panel enforces (tailnetPanelModel).
    const offered = await run('tailnet.offer_pairing')
    assert.equal(offered.isError, true)
    assert.equal(errorCode(offered), 'tailnet_not_running')
    assert.deepEqual(minted, [], 'the refusal is before the mint, not a discarded code')

    // Enabling with no Tailscale is a failed request, not a partial success: the
    // caller must not go on believing there is something to pair against.
    const enabled = await run('tailnet.set_enabled', { enabled: true })
    assert.equal(enabled.isError, true)
    assert.equal(errorCode(enabled), 'tailnet_listener_not_running')
    assert.match(firstText(enabled), /Tailscale is not running/)
    assert.equal(status.enabled, true, 'the setting still persisted, and the message says so')

    assert.equal(errorCode(await run('tailnet.set_enabled', { enabled: 'yes' })), 'invalid_enabled')

    status = { ...status, running: true, endpoint: '100.64.0.1:8787', tailnetAddress: '100.64.0.1', lastError: null }

    // A misspelled scope is refused with the vocabulary rather than silently
    // falling back to the default grant, which is what normalization would do.
    const badScopes = await run('tailnet.offer_pairing', { scopes: ['backlog:read', 'backlog:full'] })
    assert.equal(errorCode(badScopes), 'invalid_scopes')
    assert.match(firstText(badScopes), /backlog:full/)
    assert.match(firstText(badScopes), /backlog:operate/)
    // A retired scope is outside the vocabulary like any misspelling.
    const retired = await run('tailnet.offer_pairing', { scopes: ['terminal:control'] })
    assert.equal(errorCode(retired), 'invalid_scopes')
    assert.doesNotMatch(firstText(retired).split('Valid scopes are:')[1] ?? '', /terminal:/u)
    assert.deepEqual(minted, [])

    const ok = await run('tailnet.offer_pairing', { scopes: ['backlog:read'] })
    assert.notEqual(ok.isError, true)
    assert.deepEqual(minted, [{ scopes: ['backlog:read'], origin: { kind: 'agent', by: null } }])
    const pairing = (ok.structuredContent as { pairing: { token: string; pairingUrl: string } }).pairing
    assert.equal(pairing.token, 'mcpair_test')
    assert.match(pairing.pairingUrl, /^sprintengine-tailnet:\/\/pair\?/)

    // Revoking an id nobody is paired under is reported, not absorbed: the store
    // is idempotent, so a silent success would read as "that device is gone".
    assert.equal(errorCode(await run('tailnet.revoke_device', { deviceId: 'tnd_nope' })), 'unknown_device')
    assert.equal(errorCode(await run('tailnet.revoke_device', { deviceId: '  ' })), 'invalid_device_id')

    // Status carries the offer's scopes and expiry, never anything redeemable.
    status = { ...status, pairing: { scopes: ['backlog:read'], expiresAt: '2026-09-09T00:00:00.000Z' } }
    const read = await run('tailnet.status')
    assert.notEqual(read.isError, true)
    assert.ok(!firstText(read).includes('mcpair_'), 'no pairing code is re-readable from status')

    // Before the service exists the family answers rather than throwing.
    const early = createTailnetTools({ resolveTailnet: () => null })
    assert.equal(errorCode(await early[0].handler({})), 'tailnet_unavailable')
  }

  // ── Audit ────────────────────────────────────────────────────────────────────

  async function testRemoteMutationsAreAuditedWithDeviceAndPeerIdentity(): Promise<void> {
    const harness = await startHarness({ peerNode: 'mac-mini.tail1234.ts.net' })
    try {
      const device = await pairDevice(harness, { name: 'kitchen-laptop' })
      await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/call', { name: 'workspace.list', arguments: { workspaceId: 'w1' } }),
      })
      assert.deepEqual(await harness.auditRecords(), [], 'reads stay unaudited (existing gateway policy)')

      await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(2, 'tools/call', { name: 'backlog.update', arguments: { workspaceId: 'w1', status: 'completed' } }),
      })
      const records = await harness.auditRecords()
      assert.equal(records.length, 1)
      assert.equal(records[0].tool, 'backlog.update')
      assert.equal(records[0].outcome, 'success')
      assert.equal(records[0].connection.kind, 'remote-tailnet')
      assert.equal(records[0].connection.deviceId, device.deviceId)
      assert.equal(records[0].connection.deviceName, 'kitchen-laptop')
      assert.equal(records[0].connection.peerNode, 'mac-mini.tail1234.ts.net')
      assert.equal(records[0].targets.workspaceId, 'w1')

      // The stateless endpoint refuses a connection-scoped declaration outright
      // rather than accepting it and dropping it — otherwise the caller would
      // believe it had declared an identity the audit would never carry.
      const declared = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: { jsonrpc: '2.0', method: 'sprintengine.studio/connect', params: { agentId: 'developer-1' } },
      })
      assert.equal(declared.status, 400)
      assert.equal((declared.body as { error: { code: string } }).error.code, 'stateless_transport')
      assert.match((declared.body as { error: { message: string } }).error.message, /WebSocket/u)
    } finally {
      await harness.close()
    }
  }

  // The change feed (2026-09-05): a paired device opens the events route and
  // hears "changed" once per burst, never per change; a watcher is not a
  // connection; a revocation reaches the feed like every other socket.
  async function testTheChangeFeedPushesOncePerBurstAndFollowsRevocation(): Promise<void> {
    const harness = await startHarness({ changePushIntervalMs: 80 })
    try {
      const device = await pairDevice(harness, { name: 'watcher', scopes: ['workspace:read'] })
      const ticket = (await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken })).body as {
        ticket: string
      }
      const feed = await openWebSocket(harness.port, ticket.ticket, { path: TAILNET_EVENTS_PATH })
      assert.ok(
        feed.handshake.startsWith('HTTP/1.1 101'),
        `the events route upgrades: ${feed.handshake.split('\r\n')[0]}`,
      )
      const hello = await feed.nextMessage()
      assert.equal(hello.type, 'hello')
      assert.deepEqual(hello.revisions, { workspaces: 0, conversations: 0 })
      assert.equal(harness.server.eventStreamCount(), 1)
      assert.equal(harness.server.streamCount(), 0, 'a watcher is not an RPC connection')

      harness.server.notifyWorkspacesChanged()
      assert.deepEqual(await feed.nextMessage(), { type: 'changed', what: 'workspaces', revision: 1 })

      // A burst inside the floor is one push per kind, carrying the last revision.
      harness.server.notifyWorkspacesChanged()
      harness.server.notifyWorkspacesChanged()
      // A conversation starting, finishing or waiting on a person is its own kind.
      harness.server.notifyConversationsChanged()
      const pushed = [await feed.nextMessage(), await feed.nextMessage()]
      assert.deepEqual(pushed.map((frame) => `${frame.what}:${frame.revision}`).sort(), [
        'conversations:1',
        'workspaces:3',
      ])

      assert.equal(harness.devices.revokeDevice(device.deviceId), true)
      assert.equal(await feed.closed, 4401, 'a revocation closes the feed with the revoked code')
      assert.equal(harness.server.eventStreamCount(), 0)
    } finally {
      await harness.close()
    }
  }

  // A machine nobody watches bumps the revision a later `hello` reports and
  // arms nothing: every turn of every chat used to set a timer for a push
  // with no one to receive it. And stopping clears every kind's pending
  // push, the conversation one included.
  async function testTheChangeFeedArmsNothingUnwatchedAndStopClearsEveryPush(): Promise<void> {
    const harness = await startHarness({ changePushIntervalMs: 60_000 })
    let stopped = false
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        harness.server.notifyConversationsChanged()
        harness.server.notifyConversationsChanged()
        harness.server.notifyWorkspacesChanged()
        assert.equal(vi.getTimerCount(), 0, 'no watcher, no timer')
      } finally {
        vi.useRealTimers()
      }
      const device = await pairDevice(harness, { name: 'watcher', scopes: ['workspace:read'] })
      const ticket = (await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken })).body as {
        ticket: string
      }
      const feed = await openWebSocket(harness.port, ticket.ticket, { path: TAILNET_EVENTS_PATH })
      const hello = await feed.nextMessage()
      assert.deepEqual(
        hello.revisions,
        { workspaces: 1, conversations: 2 },
        'the revisions still moved, so a watcher that arrives later sees it',
      )
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        harness.server.notifyConversationsChanged()
        assert.deepEqual(await feed.nextMessage(), { type: 'changed', what: 'conversations', revision: 3 })
        harness.server.notifyConversationsChanged()
        assert.equal(vi.getTimerCount(), 1, 'a push inside the floor waits on a timer')
        await harness.server.stop()
        stopped = true
        assert.equal(vi.getTimerCount(), 0, 'stopping clears the conversation push too')
      } finally {
        vi.useRealTimers()
      }
    } finally {
      if (!stopped) await harness.server.stop()
      rmSync(harness.userDataDir, { recursive: true, force: true })
    }
  }

  async function testADeclaredIdentityCannotOverwriteTheProvenDeviceIdentity(): Promise<void> {
    const harness = await startHarness({ peerNode: 'mac-mini.tail1234.ts.net' })
    try {
      const device = await pairDevice(harness, { name: 'kitchen-laptop' })
      const ticket = (await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken })).body as {
        ticket: string
      }
      const stream = await openWebSocket(harness.port, ticket.ticket)

      // The WebSocket DOES hold connection state, so the declaration is accepted
      // — and this is where the spoof guard has to hold.
      stream.send(
        rpc(1, 'sprintengine.studio/connect', {
          agentId: 'developer-1',
          agentName: 'Trusted Local Agent',
          workspaceId: 'w9',
        }),
      )
      assert.equal((await stream.nextMessage()).id, 1)

      stream.send(rpc(2, 'tools/call', { name: 'backlog.update', arguments: { workspaceId: 'w9' } }))
      assert.equal((await stream.nextMessage()).id, 2)

      const record = (await harness.auditRecords()).at(-1)
      assert.ok(record)
      // The advisory fields it declared are honoured…
      assert.equal(record.connection.workspaceId, 'w9')
      assert.equal(record.connection.agentId, 'developer-1')
      // …but it is still recorded as the remote device it actually is, not as a
      // trusted local Studio agent.
      assert.equal(record.connection.kind, 'remote-tailnet')
      assert.equal(record.connection.deviceId, device.deviceId)
      assert.equal(record.connection.deviceName, 'kitchen-laptop')
      assert.equal(record.connection.peerNode, 'mac-mini.tail1234.ts.net')

      stream.socket.destroy()
    } finally {
      await harness.close()
    }
  }

  async function testPeerIdentityIsNullRatherThanInventedWhenWhoisIsUnavailable(): Promise<void> {
    assert.equal(peerNameFromWhois('{"Node":{"Name":"mac-mini.tail1234.ts.net."}}'), 'mac-mini.tail1234.ts.net')
    assert.equal(peerNameFromWhois('{"UserProfile":{"LoginName":"someone@example.com"}}'), 'someone@example.com')
    assert.equal(peerNameFromWhois('not json'), null)
    assert.equal(peerNameFromWhois('{}'), null)
    assert.equal(normalizeAddress('::ffff:100.101.102.103'), '100.101.102.103')
    assert.equal(normalizeAddress('fd7a:115c:a1e0::1%utun4'), 'fd7a:115c:a1e0::1')

    let whoisCalls = 0
    const resolver = createTailnetPeerResolver({
      runWhois: async () => {
        whoisCalls += 1
        throw new Error('tailscale is not installed')
      },
    })
    assert.equal(await resolver.resolve('100.101.102.103'), null)
    assert.equal(await resolver.resolve('100.101.102.103'), null)
    assert.equal(whoisCalls, 1, 'a failed lookup is cached, so a missing CLI is not spawned per call')

    const harness = await startHarness({ peerNode: null })
    try {
      const device = await pairDevice(harness)
      await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(1, 'tools/call', { name: 'backlog.update', arguments: { workspaceId: 'w1' } }),
      })
      const record = (await harness.auditRecords())[0]
      assert.equal(record.connection.deviceId, device.deviceId)
      assert.equal(record.connection.peerNode, undefined, 'an unresolved peer is absent, never a placeholder name')
    } finally {
      await harness.close()
    }
  }

  // ── WebSocket streams and revocation ─────────────────────────────────────────

  async function testWebSocketTicketsAreSingleUseAndTokensNeverRideTheUrl(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness)
      // The long-lived token is not a ticket: it cannot be used to upgrade.
      const withToken = await openWebSocket(harness.port, device.deviceToken)
      assert.equal(await withToken.closed, null)
      assert.equal(harness.server.streamCount(), 0)

      const ticketed = await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken })
      assert.equal(ticketed.status, 200)
      const ticket = (ticketed.body as { ticket: string }).ticket

      const stream = await openWebSocket(harness.port, ticket)
      stream.send(rpc(1, 'tools/call', { name: 'workspace.list', arguments: { workspaceId: 'ws' } }))
      const answer = await stream.nextMessage()
      assert.equal((answer as { id: number }).id, 1)
      assert.equal(
        (answer as { result: { structuredContent: { workspaceId: string } } }).result.structuredContent.workspaceId,
        'ws',
      )

      // Single use: the same ticket cannot open a second stream.
      const replay = await openWebSocket(harness.port, ticket)
      assert.equal(await replay.closed, null)
      await waitFor(() => harness.server.streamCount() === 1, 'the replayed upgrade to be rejected')

      // A route this listener does not serve is not found, whatever the ticket.
      const retiredRoute = await openWebSocket(harness.port, ticket, { path: '/tailnet/v1/terminal' })
      assert.ok(retiredRoute.handshake.startsWith('HTTP/1.1 404'), retiredRoute.handshake)

      stream.socket.destroy()
    } finally {
      await harness.close()
    }
  }

  async function testRevocationLandsOnTheNextRequestAndKillsLiveStreams(): Promise<void> {
    const harness = await startHarness()
    try {
      const device = await pairDevice(harness)
      const ticket = (await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken })).body as {
        ticket: string
      }
      const stream = await openWebSocket(harness.port, ticket.ticket)
      stream.send(rpc(1, 'ping'))
      assert.equal((await stream.nextMessage()).id, 1)
      await waitFor(() => harness.server.streamCount() === 1, 'the stream to register')

      assert.equal(harness.devices.revokeDevice(device.deviceId), true)

      // The live stream is terminated with the revocation close code…
      assert.equal(await stream.closed, WEBSOCKET_CLOSE_REVOKED)
      await waitFor(() => harness.server.streamCount() === 0, 'the revoked stream to be dropped')

      // …and the next HTTP request is refused.
      const refused = await call(harness.port, 'POST', TAILNET_MCP_PATH, {
        token: device.deviceToken,
        body: rpc(2, 'tools/list'),
      })
      assert.equal(refused.status, 401)

      // A ticket minted before the revoke cannot be spent afterwards.
      const staleTicket = (await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: device.deviceToken }))
        .status
      assert.equal(staleTicket, 401)
      assert.equal(harness.devices.listDevices().length, 0)
    } finally {
      await harness.close()
    }
  }

  // ── Frame codec ──────────────────────────────────────────────────────────────

  async function testWebSocketCodecRefusesWhatItDoesNotImplement(): Promise<void> {
    const decoder = createWebSocketFrameDecoder()
    const decoded = decoder.push(maskedTextFrame('{"hello":"world"}'))
    assert.equal(decoded.kind, 'frames')
    assert.deepEqual(decoded.kind === 'frames' ? decoded.frames : [], [{ kind: 'text', text: '{"hello":"world"}' }])

    // A message split across TCP chunks is buffered, not dropped.
    const whole = maskedTextFrame('{"split":true}')
    const chunked = createWebSocketFrameDecoder()
    assert.deepEqual(chunked.push(whole.subarray(0, 3)), { kind: 'frames', frames: [] })
    const rest = chunked.push(whole.subarray(3))
    assert.deepEqual(rest.kind === 'frames' ? rest.frames : [], [{ kind: 'text', text: '{"split":true}' }])

    // A large message in many small chunks, with the next one behind it in
    // the last chunk, reads whole and in order.
    const large = 'é'.repeat(300_000)
    const pieces = Buffer.concat([encodeMaskedTextFrame(large), maskedTextFrame('{"next":1}')])
    const streamed = createWebSocketFrameDecoder()
    const texts: string[] = []
    for (let start = 0; start < pieces.length; start += 16_384) {
      const step = streamed.push(pieces.subarray(start, start + 16_384))
      if (step.kind === 'frames') for (const got of step.frames) if (got.kind === 'text') texts.push(got.text)
    }
    assert.deepEqual(texts, [large, '{"next":1}'])

    // An unmasked client frame is an RFC 6455 violation the server must fail on.
    const unmasked = createWebSocketFrameDecoder()
    const payload = Buffer.from('hi', 'utf8')
    const bad = unmasked.push(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
    assert.equal(bad.kind, 'error')
    assert.match(bad.kind === 'error' ? bad.reason : '', /must be masked/u)

    // Fragmentation and binary frames are refused rather than half-handled.
    const fragmented = createWebSocketFrameDecoder()
    const frame = maskedTextFrame('x')
    frame[0] = 0x01 // text, FIN clear
    const fragmentResult = fragmented.push(frame)
    assert.equal(fragmentResult.kind, 'error')
    assert.match(fragmentResult.kind === 'error' ? fragmentResult.reason : '', /Fragmented messages are not supported/u)

    const binary = createWebSocketFrameDecoder()
    const binaryFrame = maskedTextFrame('x')
    binaryFrame[0] = 0x82
    const binaryResult = binary.push(binaryFrame)
    assert.equal(binaryResult.kind, 'error')

    // Over-long frames are refused by declared length, before any allocation.
    const tooBig = createWebSocketFrameDecoder(16)
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(4096, 2)
    const oversize = tooBig.push(header)
    assert.equal(oversize.kind, 'error')

    assert.equal(
      computeWebSocketAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
      's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
      'RFC 6455 §1.3 vector',
    )
    assert.ok(encodeTextFrame('a').equals(Buffer.from([0x81, 0x01, 0x61])), 'server frames are unmasked')
  }

  async function testEndpointAndPairingUrlFormatting(): Promise<void> {
    assert.equal(formatEndpoint('100.101.102.103', 8471), '100.101.102.103:8471')
    assert.equal(formatEndpoint('fd7a:115c:a1e0::1', 8471), '[fd7a:115c:a1e0::1]:8471')
    const url = pairingUrl('100.101.102.103', 8471, 'mcpair_abc')
    assert.equal(url, 'sprintengine-tailnet://pair?endpoint=100.101.102.103%3A8471&token=mcpair_abc')
  }

  // ── The stdio bridge in remote mode ────────────────────────────────
  //
  // The bridge is a standalone script, never bundled with the app, so these tests
  // spawn it as a real child process against the real listener above. Anything
  // less would prove nothing about the thing a person actually runs.

  const BRIDGE_SCRIPT = join(process.cwd(), 'resources', 'automation', 'mcp-stdio-bridge.mjs')

  type BridgeRun = { code: number | null; stdout: string; stderr: string }

  /** Run the bridge to completion (the `pair` flow, or a refusal). */
  function runBridge(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<BridgeRun> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BRIDGE_SCRIPT, ...args], { stdio: 'pipe', env })
      const stdout: string[] = []
      const stderr: string[] = []
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => stdout.push(chunk))
      child.stderr.on('data', (chunk: string) => stderr.push(chunk))
      child.once('error', reject)
      child.once('exit', (code) => resolve({ code, stdout: stdout.join(''), stderr: stderr.join('') }))
    })
  }

  type BridgeSession = {
    child: ChildProcessWithoutNullStreams
    send(payload: Record<string, unknown>): void
    responses: Array<Record<string, unknown>>
    stderr(): string
    exited: Promise<BridgeRun>
  }

  /** Start the bridge as an MCP server on stdio and collect its NDJSON answers. */
  function startBridgeSession(args: string[]): BridgeSession {
    const child = spawn(process.execPath, [BRIDGE_SCRIPT, ...args], { stdio: 'pipe', env: process.env })
    const responses: Array<Record<string, unknown>> = []
    const stderrChunks: string[] = []
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) responses.push(JSON.parse(line) as Record<string, unknown>)
        newline = buffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk))
    const exited = new Promise<BridgeRun>((resolve) => {
      child.once('exit', (code) => resolve({ code, stdout: '', stderr: stderrChunks.join('') }))
    })
    return {
      child,
      send: (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`),
      responses,
      stderr: () => stderrChunks.join(''),
      exited,
    }
  }

  /** The command line the OS shows for a pid — what `ps` would leak to any user on the box. */
  function osVisibleCommandLine(pid: number): string | null {
    if (process.platform === 'win32') return null
    try {
      return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
    } catch {
      return null
    }
  }

  async function pairViaBridge(
    harness: Harness,
    tokenFilePath: string,
  ): Promise<{ run: BridgeRun; deviceToken: string }> {
    const offer = harness.devices.offerPairing({ scopes: [...TAILNET_SCOPES] })
    const run = await runBridge([
      'pair',
      '--pairing-url',
      pairingUrl('127.0.0.1', harness.port, offer.token),
      '--token-file',
      tokenFilePath,
      '--device-name',
      'test-laptop',
    ])
    assert.equal(run.code, 0, `bridge pairing exits 0 (stderr: ${run.stderr})`)
    const stored = JSON.parse(readFileSync(tokenFilePath, 'utf8')) as { deviceToken: string; endpoint: string }
    return { run, deviceToken: stored.deviceToken }
  }

  async function testTheBridgePairsThenDrivesTheGatewayFromAnotherMachine(): Promise<void> {
    const harness = await startHarness({ peerNode: 'laptop.tailnet.ts.net' })
    const clientDir = mkdtempSync(join(tmpdir(), 'sprintengine-bridge-client-'))
    const tokenFilePath = join(clientDir, 'nested', 'mac-mini.json')
    try {
      const { run, deviceToken } = await pairViaBridge(harness, tokenFilePath)

      // Pairing landed on the desktop, and the credential landed on the client
      // with the endpoint it belongs to — so the serve command needs no --remote.
      const devices = harness.devices.listDevices()
      assert.equal(devices.length, 1, 'pairing through the bridge creates exactly one device')
      assert.equal(devices[0].name, 'test-laptop')
      const stored = JSON.parse(readFileSync(tokenFilePath, 'utf8')) as { endpoint: string; scopes: string[] }
      assert.equal(stored.endpoint, `127.0.0.1:${harness.port}`)
      assert.deepEqual(stored.scopes, [...TAILNET_SCOPES])
      assert.ok(!run.stdout.includes(deviceToken), 'the pair flow never prints the device token it stored')
      if (process.platform !== 'win32') {
        assert.equal(statSync(tokenFilePath).mode & 0o777, 0o600, 'the stored device token is owner-only')
      }

      const session = startBridgeSession(['--token-file', tokenFilePath])
      try {
        session.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
        session.send(rpc(2, 'tools/list'))
        session.send(rpc(3, 'tools/call', { name: 'backlog.list', arguments: {} }))
        session.send(rpc(4, 'tools/call', { name: 'backlog.update', arguments: { itemId: 'MC-1' } }))
        await waitFor(() => session.responses.length >= 4, 'four bridge responses')

        const byId = new Map(session.responses.map((response) => [response.id, response]))
        const init = byId.get(1) as { result: { serverInfo: { name: string; version: string } } }
        assert.equal(init.result.serverInfo.name, 'sprintengine-studio')
        assert.equal(init.result.serverInfo.version, '9.9.9')
        const listed = byId.get(2) as { result: { tools: Array<{ name: string }> } }
        assert.deepEqual(
          listed.result.tools.map((tool) => tool.name).sort(),
          ['backlog.list', 'backlog.update', 'workspace.checkout', 'workspace.list'],
          'the remote client sees every tool a local one does, less the local-only ones',
        )
        const read = byId.get(3) as { result: { structuredContent: { tool: string } } }
        assert.equal(read.result.structuredContent.tool, 'backlog.list')
        const mutation = byId.get(4) as { result: { structuredContent: { tool: string } } }
        assert.equal(mutation.result.structuredContent.tool, 'backlog.update')

        // The mutation is audited with the transport-proven device identity.
        await waitFor(async () => (await harness.auditRecords()).length >= 1, 'the remote mutation to be audited')
        const audited = await harness.auditRecords()
        assert.equal(audited.length, 1, 'the read is not audited; the mutation is')
        assert.equal(audited[0].tool, 'backlog.update')
        const connection = audited[0].connection as Record<string, unknown>
        assert.equal(connection.kind, 'remote-tailnet')
        assert.equal(connection.deviceId, devices[0].id)
        assert.equal(connection.deviceName, 'test-laptop')
        assert.equal(connection.peerNode, 'laptop.tailnet.ts.net')

        // The token is a file read, never an argument and never a log line.
        const commandLine = osVisibleCommandLine(session.child.pid ?? 0)
        if (commandLine !== null) {
          assert.ok(commandLine.includes('mcp-stdio-bridge.mjs'), 'ps found the bridge process')
          assert.ok(!commandLine.includes(deviceToken), 'the device token never reaches the OS-visible command line')
        }
        assert.ok(!session.stderr().includes(deviceToken), 'the device token never reaches stderr')
      } finally {
        session.child.stdin.end()
      }
      const exit = await session.exited
      assert.equal(exit.code, 0, `closing stdin ends the remote session cleanly (stderr: ${exit.stderr})`)
    } finally {
      rmSync(clientDir, { recursive: true, force: true })
      await harness.close()
    }
  }

  async function testTheBridgeFailsCleanlyWhenTheDeviceIsRevoked(): Promise<void> {
    const harness = await startHarness()
    const clientDir = mkdtempSync(join(tmpdir(), 'sprintengine-bridge-revoke-'))
    const tokenFilePath = join(clientDir, 'mac-mini.json')
    try {
      const { deviceToken } = await pairViaBridge(harness, tokenFilePath)
      const deviceId = harness.devices.listDevices()[0].id

      // Revoked mid-session: the live stream must end, with a message that says why.
      const session = startBridgeSession(['--token-file', tokenFilePath])
      session.send(rpc(1, 'tools/call', { name: 'backlog.list', arguments: {} }))
      await waitFor(() => session.responses.length >= 1, 'the first remote answer')
      harness.devices.revokeDevice(deviceId)
      const midSession = await session.exited
      assert.equal(midSession.code, 1, 'a revoked device is a failure, not a clean shutdown')
      assert.match(midSession.stderr, /revoked/i)
      assert.ok(!midSession.stderr.includes(deviceToken), 'the failure message never echoes the token')

      // And a session started with the same now-dead token never opens at all.
      const afterwards = await runBridge(['--token-file', tokenFilePath])
      assert.equal(afterwards.code, 1)
      assert.match(afterwards.stderr, /rejected this device token/)
      assert.match(afterwards.stderr, /pair again/i)
      assert.ok(!afterwards.stderr.includes(deviceToken))
    } finally {
      rmSync(clientDir, { recursive: true, force: true })
      await harness.close()
    }
  }

  async function testTheBridgeRefusesIncompleteOrConflictingRemoteInvocations(): Promise<void> {
    const harness = await startHarness()
    const clientDir = mkdtempSync(join(tmpdir(), 'sprintengine-bridge-args-'))
    const tokenFilePath = join(clientDir, 'device.json')
    try {
      // An endpoint with no credential: an explicit refusal naming both ways to
      // supply one, never an unauthenticated attempt.
      const noToken = await runBridge(['--remote', `127.0.0.1:${harness.port}`])
      assert.equal(noToken.code, 1)
      assert.match(noToken.stderr, /needs a device token/)
      assert.match(noToken.stderr, /never accepted as a command-line argument/)

      // A token file that was never written.
      const missingFile = await runBridge(['--token-file', tokenFilePath])
      assert.equal(missingFile.code, 1)
      assert.match(missingFile.stderr, /Could not read the device token file/)

      // Local and remote mode are different transports, not a preference order.
      await pairViaBridge(harness, tokenFilePath)
      const conflicting = await runBridge(['--info-path', join(clientDir, 'info.json'), '--token-file', tokenFilePath])
      assert.equal(conflicting.code, 1)
      assert.match(conflicting.stderr, /pass one/)

      // A flag belonging to the other command is refused, never dropped.
      const pairFlagWhileServing = await runBridge(['--token-file', tokenFilePath, '--device-name', 'laptop'])
      assert.equal(pairFlagWhileServing.code, 1)
      assert.match(pairFlagWhileServing.stderr, /--device-name does not apply/)

      // A pairing link that is not one.
      const badUrl = await runBridge([
        'pair',
        '--pairing-url',
        'https://example.invalid/pair',
        '--token-file',
        tokenFilePath,
      ])
      assert.equal(badUrl.code, 1)
      assert.match(badUrl.stderr, /sprintengine-tailnet:/)
    } finally {
      rmSync(clientDir, { recursive: true, force: true })
      await harness.close()
    }
  }

  // ── The upload route ─────────────────────────────────────────────────────────
  async function testConversationRouteScopesRevocationAndOpaqueImages(): Promise<void> {
    const projectDir = mkdtempSync(join(tmpdir(), 'conversation-route-'))
    let registered: Parameters<NonNullable<ConversationGatewayHost['registerUpload']>>[0] | undefined
    let disposed = 0
    const conversations: ConversationGatewayHost = {
      list: async () => [
        {
          workspaceId: 'workspace',
          agentId: 'agent',
          sessionId: 'conversation',
          title: 'Example',
          phase: 'idle',
          createdAt: 1,
          updatedAt: 1,
          providerId: 'mock',
          modelId: 'mock',
          turnCount: 0,
          lastSeq: 0,
          capabilities: {
            images: true,
            approvals: true,
            questions: true,
            planMode: true,
            interrupt: true,
            checkpoints: false,
          },
        },
      ],
      resolveKey: (workspaceId, agentId) => ({ workspaceRoot: projectDir, workspaceId, agentId }),
      subscribe: (_key, _cursor, receive) => {
        receive({ type: 'synchronized', seq: 0 })
        return {
          ready: Promise.resolve(),
          dispose: () => {
            disposed++
          },
        }
      },
      loadEarlier: async () => ({ ok: false, message: 'Unavailable.' }),
      getToolDetail: async () => ({ ok: false, code: 'not_found', message: 'Unavailable.' }),
      getTurnDiff: async () => ({ ok: false, message: 'Unavailable.' }),
      command: async () => ({ ok: true }),
      registerUpload: (input) => {
        registered = input
        return 'opaque-upload'
      },
    }
    let pauseLookup = false
    let releaseLookup!: () => void
    let enteredLookup!: () => void
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    const lookupStarted = new Promise<void>((resolve) => {
      enteredLookup = resolve
    })
    const harness = await startHarness({
      conversations,
      resolvePeer: async () => {
        if (pauseLookup) {
          enteredLookup()
          await lookupGate
        }
        return null
      },
    })
    try {
      const operator = await pairDevice(harness, { scopes: ['conversation:operate'], name: 'phone' })
      const reader = await pairDevice(harness, { scopes: ['conversation:read'], name: 'tablet' })
      const route = `${uploadPath('conversation', '../../image.png')}&kind=conversation`
      const payload = { body: Buffer.from('image'), headers: { 'Content-Type': 'image/png' } }
      const refused = await callRaw(harness.port, route, { ...payload, token: reader.deviceToken })
      assert.equal(refused.status, 403)
      const badMedia = await callRaw(harness.port, route, { body: Buffer.from('image'), token: operator.deviceToken })
      assert.equal(badMedia.status, 415)
      const tooLarge = await callRaw(harness.port, route, {
        ...payload,
        body: Buffer.alloc(5 * 1024 * 1024 + 1),
        token: operator.deviceToken,
      })
      assert.equal(tooLarge.status, 413)
      const tooLargeError = (tooLarge.body as { error: { code: string; message: string } }).error
      assert.equal(tooLargeError.code, 'too_large')
      assert.match(tooLargeError.message, /5MB/u, 'the phone can only say the real reason if the server names it')
      const unknown = await callRaw(harness.port, uploadPath('conversation_missing', 'image.png'), {
        ...payload,
        token: operator.deviceToken,
      })
      assert.equal(unknown.status, 404)
      assert.equal((unknown.body as { error: { code: string } }).error.code, 'unknown_conversation')
      // A staging directory that could not be created is tried again on the next upload.
      const savedTmpdir = process.env.TMPDIR
      process.env.TMPDIR = join(projectDir, 'missing', 'tmp')
      try {
        const unstaged = await callRaw(harness.port, route, { ...payload, token: operator.deviceToken })
        assert.equal(unstaged.status, 500)
      } finally {
        if (savedTmpdir === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = savedTmpdir
      }
      const uploaded = await callRaw(harness.port, route, { ...payload, token: operator.deviceToken })
      assert.equal(uploaded.status, 200)
      assert.deepEqual(uploaded.body, { uploadId: 'opaque-upload', bytes: 5 })
      // `kind` is what older phones send; a conversation image is the only kind there is.
      const withoutKind = await callRaw(harness.port, uploadPath('conversation', 'image.png'), {
        ...payload,
        token: operator.deviceToken,
      })
      assert.deepEqual(withoutKind.body, { uploadId: 'opaque-upload', bytes: 5 })
      assert.ok(registered)
      assert.equal(registered.deviceId, operator.deviceId)
      assert.equal(registered.sessionId, 'conversation')
      assert.equal(readFileSync(registered.path, 'utf8'), 'image')
      assert.equal(
        registered.path.startsWith(projectDir),
        false,
        'opaque image staging does not trust workspace parents',
      )
      assert.equal(existsSync(join(projectDir, '.sprintengine')), false)
      const ticket = await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: reader.deviceToken })
      const socket = await openWebSocket(harness.port, (ticket.body as { ticket: string }).ticket, {
        path: TAILNET_CONVERSATION_PATH,
      })
      assert.ok(socket.handshake.startsWith('HTTP/1.1 101'))
      socket.send({ type: 'subscribe', key: { workspaceId: 'workspace', agentId: 'agent' } })
      assert.deepEqual(await socket.nextMessage(), {
        type: 'synchronized',
        seq: 0,
        key: { workspaceId: 'workspace', agentId: 'agent' },
      })
      socket.send({ type: 'command', commandId: 'deny-read-mutation', command: { kind: 'interrupt' } })
      assert.equal((await socket.nextMessage()).code, 'conversation_operate_required')
      const operatorTicket = await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, { token: operator.deviceToken })
      const operatorSocket = await openWebSocket(harness.port, (operatorTicket.body as { ticket: string }).ticket, {
        path: TAILNET_CONVERSATION_PATH,
      })
      operatorSocket.send({ type: 'subscribe', key: { workspaceId: 'workspace', agentId: 'agent' } })
      assert.deepEqual(await operatorSocket.nextMessage(), {
        type: 'synchronized',
        seq: 0,
        key: { workspaceId: 'workspace', agentId: 'agent' },
      })
      operatorSocket.send({
        type: 'command',
        commandId: 'remote-send',
        command: { kind: 'send', message: 'words only the conversation may keep' },
      })
      assert.deepEqual(await operatorSocket.nextMessage(), {
        type: 'commandResult',
        commandId: 'remote-send',
        ok: true,
      })
      // Every remote command is audited with the device, the conversation and
      // its kind — the refused one too — and never with what was typed.
      const audited = (await harness.auditRecords()).filter((record) => record.tool.startsWith('conversation.'))
      assert.deepEqual(
        audited.map((record) => [record.tool, record.connection.deviceId, record.outcome, record.errorCode ?? null]),
        [
          ['conversation.interrupt', reader.deviceId, 'failure', 'conversation_operate_required'],
          ['conversation.send', operator.deviceId, 'success', null],
        ],
      )
      assert.deepEqual(audited[1].targets, { workspaceId: 'workspace', agentId: 'agent', id: 'remote-send' })
      assert.equal(JSON.stringify(audited).includes('words only'), false)
      // A grant narrowed in Settings reaches the socket that is already open.
      harness.devices.updateDeviceScopes(operator.deviceId, ['conversation:read'])
      operatorSocket.send({ type: 'command', commandId: 'after-narrowing', command: { kind: 'interrupt' } })
      assert.deepEqual(await operatorSocket.nextMessage(), {
        type: 'commandResult',
        commandId: 'after-narrowing',
        ok: false,
        code: 'conversation_operate_required',
      })
      harness.devices.updateDeviceScopes(operator.deviceId, ['workspace:read'])
      assert.equal((await operatorSocket.nextMessage()).code, 'conversation_scope_required')
      assert.equal(await operatorSocket.closed, 4403)
      harness.devices.revokeDevice(reader.deviceId)
      assert.equal(await socket.closed, WEBSOCKET_CLOSE_REVOKED)
      assert.equal(disposed, 2, 'the narrowed socket and the revoked one each ended their subscription')
      operatorSocket.socket.destroy()
      const revokedDuringLookup = await pairDevice(harness, { scopes: ['conversation:read'], name: 'tablet' })
      const staleTicket = await call(harness.port, 'POST', TAILNET_WS_TICKET_PATH, {
        token: revokedDuringLookup.deviceToken,
      })
      pauseLookup = true
      const joining = openWebSocket(harness.port, (staleTicket.body as { ticket: string }).ticket, {
        path: TAILNET_CONVERSATION_PATH,
      })
      await lookupStarted
      harness.devices.revokeDevice(revokedDuringLookup.deviceId)
      releaseLookup()
      const refusedJoin = await joining
      assert.ok(
        refusedJoin.handshake.startsWith('HTTP/1.1 401'),
        'revocation during discovery refuses the late upgrade',
      )
    } finally {
      releaseLookup()
      await harness.close()
      if (registered)
        assert.equal(existsSync(registered.path), false, 'server shutdown removes only its private staging directory')
      rmSync(projectDir, { recursive: true, force: true })
    }
  }

  /**
   * Widening a pairing from this keyboard (remote-settings-rebuild).
   *
   * The one direction the store never had: scopes could be granted at pairing and
   * refreshed from the far end, but never widened here, so a device paired with a
   * narrow grant could only be revoked and paired again. The widen
   * must reach disk — a grant that does not survive a restart silently narrows
   * itself — and an id the store does not hold must be an error rather than a
   * quiet no-op, because a surface acting on a row that is gone has to know.
   */
  async function testWideningADevicesScopesPersistsAndAnUnknownIdThrows(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-scopes-'))
    try {
      const store = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
      const minted = store.mintDevice({
        name: 'mac-mini',
        scopes: ['workspace:read', 'backlog:read'],
        origin: { kind: 'code', by: null },
      })
      assert.deepEqual(minted.device.scopes, ['workspace:read', 'backlog:read'])

      const widened = store.updateDeviceScopes(minted.device.id, [...TAILNET_SCOPES])
      assert.deepEqual(widened.scopes, [...TAILNET_SCOPES])
      assert.equal(widened.scopes.length, TAILNET_SCOPES.length)
      assert.deepEqual(store.listDevices()[0]?.scopes, [...TAILNET_SCOPES])

      // A second store over the same directory is what the next launch sees.
      const reloaded = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
      assert.deepEqual(reloaded.listDevices()[0]?.scopes, [...TAILNET_SCOPES])

      // It replaces rather than merges, so the same call takes access away — and
      // normalises, so a duplicate or a scope outside the vocabulary is dropped
      // rather than stored.
      const narrowed = reloaded.updateDeviceScopes(minted.device.id, [
        'workspace:read',
        'workspace:read',
        'not:a:scope',
      ])
      assert.deepEqual(narrowed.scopes, ['workspace:read'])
      assert.deepEqual(createTailnetDeviceStore({ resolveUserDataDir: () => dir }).listDevices()[0]?.scopes, [
        'workspace:read',
      ])

      assert.throws(() => reloaded.updateDeviceScopes('tnd_never_existed', [...TAILNET_SCOPES]), /tnd_never_existed/)
      // And the throw changed nothing.
      assert.equal(reloaded.listDevices().length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /**
   * A device record written while the terminal scopes existed. It must still
   * load — revoking every phone paired before the retirement would be a worse
   * outcome than the grant it loses — keeping every scope that still means
   * something and nothing else.
   */
  async function testAStoredDeviceLoadsWithoutItsRetiredTerminalScopes(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'sprintengine-tailnet-retired-'))
    try {
      const deviceToken = 'mctn_retired-scopes-fixture'
      writeFileSync(
        join(dir, TAILNET_DEVICES_FILENAME),
        `${JSON.stringify(
          {
            version: 1,
            devices: [
              {
                id: 'tnd_dev_macbook_air',
                name: 'dev-macbook-air',
                scopes: ['workspace:read', 'terminal:observe', 'conversation:operate', 'terminal:control'],
                createdAt: '2026-09-01T00:00:00.000Z',
                lastSeenAt: null,
                lastPeerNode: 'dev-macbook-air.tail1234.ts.net',
                origin: { kind: 'code', by: null },
                tokenHash: hashSecret(deviceToken),
              },
            ],
          },
          null,
          2,
        )}\n`,
      )
      const store = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
      const [loaded] = store.listDevices()
      assert.ok(loaded, 'the record loads rather than being dropped as malformed')
      assert.equal(loaded.id, 'tnd_dev_macbook_air')
      assert.deepEqual(loaded.scopes, ['workspace:read', 'conversation:operate'])
      assert.deepEqual(store.authenticate(deviceToken)?.scopes, ['workspace:read', 'conversation:operate'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const tests = [
    testBindAddressAllowsOnlyTailnetOrLoopback,
    testDisabledMeansNoListeningTcpSocket,
    testEnabledWithoutATailnetRefusesInsteadOfBindingAnythingElse,
    testTheListenerBindsWhenTailscaleComesUpAfterTheApp,
    testTheListenerStandsDownWhenTailscaleGoesAway,
    testTheInterfaceWatchStopsWhenTheListenerIsTurnedOff,
    testUnpairedClientsGet401AndPairedClientsDriveTheGateway,
    testBrowserOriginatedRequestsAreRefused,
    testOversizedAndMalformedBodiesAreRefusedExplicitly,
    testHealthEndpointLeaksNothingBeyondProductAndProtocol,
    testScopesNarrowWhatADeviceSeesAndMayCall,
    testTailnetConfigurationToolsAreNeverServedOverTheTailnet,
    testTerminalToolsAreNeverServedOverTheTailnet,
    testTailnetToolsRefuseRatherThanMintACodeThatPointsAtNothing,
    testRemoteMutationsAreAuditedWithDeviceAndPeerIdentity,
    testADeclaredIdentityCannotOverwriteTheProvenDeviceIdentity,
    testTheChangeFeedPushesOncePerBurstAndFollowsRevocation,
    testTheChangeFeedArmsNothingUnwatchedAndStopClearsEveryPush,
    testPeerIdentityIsNullRatherThanInventedWhenWhoisIsUnavailable,
    testWebSocketTicketsAreSingleUseAndTokensNeverRideTheUrl,
    testRevocationLandsOnTheNextRequestAndKillsLiveStreams,
    testWebSocketCodecRefusesWhatItDoesNotImplement,
    testConversationRouteScopesRevocationAndOpaqueImages,
    testEndpointAndPairingUrlFormatting,
    testWideningADevicesScopesPersistsAndAnUnknownIdThrows,
    testAStoredDeviceLoadsWithoutItsRetiredTerminalScopes,
    testTheBridgePairsThenDrivesTheGatewayFromAnotherMachine,
    testTheBridgeFailsCleanlyWhenTheDeviceIsRevoked,
    testTheBridgeRefusesIncompleteOrConflictingRemoteInvocations,
  ]

  async function main(): Promise<void> {
    let failures = 0
    for (const test of tests) {
      try {
        await test()
        console.log(`ok - ${test.name}`)
      } catch (error) {
        failures += 1
        console.error(`not ok - ${test.name}`)
        console.error(error)
      }
    }
    if (failures > 0) {
      console.error(`\n${failures} test(s) failed`)
      process.exit(1)
    }
    console.log('tailnet.test.ts: ok')
  }

  const suiteRun = main()

  await suiteRun
})
