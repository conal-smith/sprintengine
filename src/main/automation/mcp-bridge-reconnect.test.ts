import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, test } from 'vitest'

// The MCP stdio bridge across a restart of the Studio server (phase 6 spec,
// 6.5): the gateway's socket closes under a running agent and comes back with
// a new process behind it. The agent's MCP client must see one session: its
// waiting request answered with an error, `initialize` replayed (the answer
// swallowed), and `tools/list_changed` once the new gateway is there.

const BRIDGE = join(process.cwd(), 'resources', 'automation', 'mcp-stdio-bridge.mjs')
const scratch = mkdtempSync(join(tmpdir(), 'se-bridge-reconnect-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

type Gateway = { server: Server; lines: string[]; sockets: Socket[]; close(): Promise<void> }

/** A gateway stand-in: records each line, answers `initialize` and `tools/list`, leaves `slow` unanswered. */
function startGateway(socketPath: string): Promise<Gateway> {
  const lines: string[] = []
  const sockets: Socket[] = []
  const server = createServer((socket) => {
    sockets.push(socket)
    createInterface({ input: socket }).on('line', (line) => {
      lines.push(line)
      const message = JSON.parse(line) as { id?: unknown; method?: string }
      if (message.method === 'initialize') {
        socket.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'gateway' } } })}\n`,
        )
      }
      if (message.method === 'tools/list') {
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })}\n`)
      }
    })
  })
  return new Promise((resolve) =>
    server.listen(socketPath, () =>
      resolve({
        server,
        lines,
        sockets,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => done())
          }),
      }),
    ),
  )
}

async function waitFor<T>(probe: () => T | undefined | false, what: string): Promise<T> {
  for (let tries = 0; tries < 1_000; tries++) {
    const value = probe()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

test.skipIf(process.platform === 'win32')(
  'a bridge reconnects to a restarted gateway and the client keeps one session',
  async () => {
    const socketPath = join(scratch, 'automation.sock')
    const infoPath = join(scratch, 'sprintengine-studio-mcp-info.json')
    const writeInfo = (pid: number) => writeFileSync(infoPath, JSON.stringify({ socketPath, pid }))
    writeInfo(1001)
    const first = await startGateway(socketPath)

    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('SPRINTENGINE_')) delete env[key]
    // The launch's gateway token (R87): the restarted server is told it again
    // by the shell, so the bridge proves itself with the same one.
    env.SPRINTENGINE_MCP_CHANNEL_TOKEN = 'launch-token-for-the-test'
    const bridge = spawn(process.execPath, [BRIDGE, '--info-path', infoPath], { env, stdio: 'pipe' })
    const out: Array<Record<string, any>> = []
    createInterface({ input: bridge.stdout }).on('line', (line) => out.push(JSON.parse(line)))
    const send = (message: unknown) => bridge.stdin.write(`${JSON.stringify(message)}\n`)

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await waitFor(() => out.find((message) => message.id === 1), 'the first initialize answer')
    send({ jsonrpc: '2.0', id: 2, method: 'slow' })
    await waitFor(() => first.lines.some((line) => line.includes('"slow"')), 'the slow request to arrive')
    // The connect frame went first, before anything the client said.
    assert.match(first.lines[0], /sprintengine\.studio\/connect/)
    const launchTokenOf = (line: string) =>
      (JSON.parse(line) as { params?: { launchToken?: string } }).params?.launchToken
    assert.equal(launchTokenOf(first.lines[0]), 'launch-token-for-the-test')

    // The server restarts: its socket goes, a new process takes the path.
    await first.close()
    rmSync(socketPath, { force: true })
    const failed = await waitFor(() => out.find((message) => message.id === 2), 'the waiting request to fail')
    assert.match(failed.error.message, /restarted; retry/)

    const second = await startGateway(socketPath)
    writeInfo(2002)
    await waitFor(
      () => out.find((message) => message.method === 'notifications/tools/list_changed'),
      'tools/list_changed after the reconnect',
    )
    await waitFor(() => second.lines.length >= 3, 'the replay to arrive')
    assert.match(second.lines[0], /sprintengine\.studio\/connect/)
    assert.equal(launchTokenOf(second.lines[0]), 'launch-token-for-the-test')
    const replayed = JSON.parse(second.lines[1]) as { id: string; method: string; params: unknown }
    assert.equal(replayed.method, 'initialize')
    assert.deepEqual(replayed.params, { protocolVersion: '2025-06-18' })
    assert.equal(JSON.parse(second.lines[2]).method, 'notifications/initialized')
    // The replayed initialize's answer is the bridge's, not the client's.
    assert.equal(out.filter((message) => message.result?.serverInfo).length, 1)

    // The session carries on over the new socket.
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    const listed = await waitFor(() => out.find((message) => message.id === 3), 'tools/list over the new socket')
    assert.deepEqual(listed.result, { tools: [] })

    bridge.stdin.end()
    const code = await new Promise<number | null>((resolve) => bridge.on('exit', (exit) => resolve(exit)))
    assert.equal(code, 0)
    await second.close()
  },
)

test.skipIf(process.platform === 'win32')(
  'a reconnect attempt that finds no socket yet keeps waiting, and reconnects once the gateway listens',
  async () => {
    // Beside the first test's files: a socket path has little room to grow.
    const socketPath = join(scratch, 'late.sock')
    const infoPath = join(scratch, 'late-info.json')
    const writeInfo = (pid: number) => writeFileSync(infoPath, JSON.stringify({ socketPath, pid }))
    writeInfo(1001)
    const first = await startGateway(socketPath)

    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('SPRINTENGINE_')) delete env[key]
    const bridge = spawn(process.execPath, [BRIDGE, '--info-path', infoPath], { env, stdio: 'pipe' })
    const out: Array<Record<string, any>> = []
    let stderr = ''
    bridge.stderr.setEncoding('utf8')
    bridge.stderr.on('data', (chunk: string) => (stderr += chunk))
    createInterface({ input: bridge.stdout }).on('line', (line) => out.push(JSON.parse(line)))
    const send = (message: unknown) => bridge.stdin.write(`${JSON.stringify(message)}\n`)

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    await waitFor(() => out.find((message) => message.id === 1), 'the first initialize answer')

    // The new process names itself before its socket listens: the bridge's
    // first attempt finds nothing there.
    await first.close()
    rmSync(socketPath, { force: true })
    writeInfo(2002)
    await waitFor(() => stderr.includes('not answering yet'), 'a failed reconnect attempt')

    const second = await startGateway(socketPath)
    await waitFor(
      () => out.find((message) => message.method === 'notifications/tools/list_changed'),
      'tools/list_changed after the late socket',
    )
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const listed = await waitFor(() => out.find((message) => message.id === 2), 'tools/list over the new socket')
    assert.deepEqual(listed.result, { tools: [] })

    bridge.stdin.end()
    const code = await new Promise<number | null>((resolve) => bridge.on('exit', (exit) => resolve(exit)))
    assert.equal(code, 0)
    await second.close()
  },
)

test.skipIf(process.platform === 'win32')(
  'a bridge outlives a Studio that is gone for longer than a quick restart, and reconnects when it is started again',
  async () => {
    const socketPath = join(scratch, 'away.sock')
    const infoPath = join(scratch, 'away-info.json')
    const writeInfo = (pid: number) => writeFileSync(infoPath, JSON.stringify({ socketPath, pid }))
    writeInfo(1001)
    const first = await startGateway(socketPath)

    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('SPRINTENGINE_')) delete env[key]
    const bridge = spawn(process.execPath, [BRIDGE, '--info-path', infoPath], { env, stdio: 'pipe' })
    let exited: number | null | undefined
    bridge.on('exit', (code) => (exited = code))
    const out: Array<Record<string, any>> = []
    createInterface({ input: bridge.stdout }).on('line', (line) => out.push(JSON.parse(line)))
    const send = (message: unknown) => bridge.stdin.write(`${JSON.stringify(message)}\n`)

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    await waitFor(() => out.find((message) => message.id === 1), 'the first initialize answer')
    send({ jsonrpc: '2.0', id: 2, method: 'slow' })
    await waitFor(() => first.lines.some((line) => line.includes('"slow"')), 'the slow request to arrive')

    // The app goes (it crashed, or was quit) and nothing comes back for a
    // while: the socket and the discovery file are both gone.
    await first.close()
    rmSync(socketPath, { force: true })
    rmSync(infoPath, { force: true })
    const failed = await waitFor(() => out.find((message) => message.id === 2), 'the waiting request to fail')
    assert.match(failed.error.message, /retry/)

    // Longer than a supervised restart ever takes. An MCP client marks a
    // stdio server that exits "not connected" for good, so the bridge stays.
    await new Promise((resolve) => setTimeout(resolve, 32_000))
    assert.equal(exited, undefined, 'the bridge is still running while its client is')

    // A request made while Studio is away is answered at once, retryably.
    send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    const away = await waitFor(() => out.find((message) => message.id === 3), 'an answer while Studio is away')
    assert.equal(away.error.code, -32000)
    assert.match(away.error.message, /retry/)

    // The app is started again: a new process, a new gateway.
    const second = await startGateway(socketPath)
    writeInfo(2002)
    await waitFor(
      () => out.find((message) => message.method === 'notifications/tools/list_changed'),
      'tools/list_changed after Studio is back',
    )
    send({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
    const listed = await waitFor(() => out.find((message) => message.id === 4), 'tools/list over the new socket')
    assert.deepEqual(listed.result, { tools: [] })

    bridge.stdin.end()
    const code = await new Promise<number | null>((resolve) =>
      exited !== undefined ? resolve(exited) : bridge.on('exit', (exit) => resolve(exit)),
    )
    assert.equal(code, 0)
    await second.close()
  },
)

test.skipIf(process.platform === 'win32')(
  'a bridge whose client closes stdin while Studio is away leaves',
  async () => {
    const socketPath = join(scratch, 'gone.sock')
    const infoPath = join(scratch, 'gone-info.json')
    writeFileSync(infoPath, JSON.stringify({ socketPath, pid: 1001 }))
    const first = await startGateway(socketPath)

    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('SPRINTENGINE_')) delete env[key]
    const bridge = spawn(process.execPath, [BRIDGE, '--info-path', infoPath], { env, stdio: 'pipe' })
    const out: Array<Record<string, any>> = []
    createInterface({ input: bridge.stdout }).on('line', (line) => out.push(JSON.parse(line)))
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
    await waitFor(() => out.find((message) => message.id === 1), 'the first initialize answer')

    await first.close()
    rmSync(socketPath, { force: true })
    rmSync(infoPath, { force: true })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const exit = new Promise<number | null>((resolve) => bridge.on('exit', (code) => resolve(code)))
    bridge.stdin.end()
    assert.equal(await exit, 0)
  },
)
