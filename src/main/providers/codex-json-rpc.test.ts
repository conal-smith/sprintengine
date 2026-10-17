import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { expect, test } from 'vitest'
import {
  CodexRpcError,
  codexAppServerArgs,
  codexStartupStderrLine,
  codexToolFailure,
  createCodexRpcTransport,
  type CodexRpcOptions,
  type RpcMessage,
} from './codex-json-rpc'

function fixture(timeoutMs = 1000, extra: Partial<CodexRpcOptions> = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 123,
    exitCode: null as number | null,
    kill() {
      this.exitCode = 0
      return true
    },
  })
  const messages: RpcMessage[] = [],
    closed: Error[] = [],
    writes: RpcMessage[] = [],
    spawned: string[][] = []
  child.stdin.on('data', (chunk: Buffer) => writes.push(JSON.parse(chunk.toString())))
  const transport = createCodexRpcTransport({
    command: '/usr/bin/codex',
    cwd: '/workspace/app',
    env: {},
    timeoutMs,
    spawnChild: ((_file: string, args: string[]) => {
      spawned.push(args)
      return child
    }) as unknown as CodexRpcOptions['spawnChild'],
    onMessage: (message) => {
      messages.push(message)
    },
    onClose: (error) => closed.push(error),
    ...extra,
  })
  return { child, transport, messages, closed, writes, spawned }
}

test('correlates requests and preserves split UTF-8 frames while ignoring malformed lines', async () => {
  const f = fixture()
  const request = f.transport.request('initialize', {})
  expect(f.writes[0]).toMatchObject({ id: 1, method: 'initialize' })
  const frame = Buffer.from(
    'not-json\n' + JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'héllo' } }) + '\n',
  )
  const split = frame.indexOf(Buffer.from('é')) + 1
  f.child.stdout.write(frame.subarray(0, split))
  f.child.stdout.write(frame.subarray(split))
  f.child.stdout.write('{"id":1,"result":{"ready":true}}\n')
  expect(await request).toEqual({ ready: true })
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.messages).toEqual([{ method: 'item/agentMessage/delta', params: { delta: 'héllo' } }])
  f.transport.close()
})

test('server requests keep string identities and use a result envelope', async () => {
  const f = fixture()
  f.child.stdout.write('{"id":"permission","method":"approval","params":{}}\n')
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.messages[0]?.id).toBe('permission')
  f.transport.respond('permission', { decision: 'decline' })
  expect(f.writes[0]).toEqual({ id: 'permission', result: { decision: 'decline' } })
  f.transport.close()
})

test('timeouts and process exit reject outstanding calls and close once', async () => {
  const f = fixture(10)
  await expect(f.transport.request('slow', {})).rejects.toThrow('timed out')
  const request = f.transport.request('pending', {})
  f.child.emit('close', 1)
  await expect(request).rejects.toThrow('exited')
  f.child.emit('error', new Error('later'))
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.closed).toHaveLength(1)
  await expect(f.transport.request('after-close', {})).rejects.toThrow('closed')
})

test('an error answer is told apart from a request that was never answered', async () => {
  const f = fixture(10)
  const refused = f.transport.request('thread/resume', {})
  f.child.stdout.write('{"id":1,"error":{"code":-32600,"message":"thread not found"}}\n')
  await expect(refused).rejects.toBeInstanceOf(CodexRpcError)
  await expect(f.transport.request('slow', {})).rejects.not.toBeInstanceOf(CodexRpcError)
  f.transport.close()
})

test('a Windows npm shim is started through the command processor', () => {
  const spawned: unknown[][] = []
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 7,
    exitCode: 0 as number | null,
    kill: () => true,
  })
  const transport = createCodexRpcTransport({
    command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd',
    cwd: 'C:\\Users\\dev\\app',
    env: { ComSpec: 'cmd.exe' },
    platform: 'win32',
    spawnChild: ((...args: unknown[]) => {
      spawned.push(args)
      return child
    }) as unknown as CodexRpcOptions['spawnChild'],
    onMessage: () => undefined,
    onClose: () => undefined,
  })
  expect(spawned[0]?.[0]).toBe('cmd.exe')
  expect(spawned[0]?.[1]).toEqual([
    '/d',
    '/s',
    '/c',
    '""C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd" "app-server" "--listen" "stdio://""',
  ])
  expect(spawned[0]?.[2]).toMatchObject({ windowsVerbatimArguments: true })
  transport.close()
})

test('a CLI that cannot be started says so instead of reporting a closed connection', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    exitCode: null,
    kill: () => false,
  })
  const closed: Error[] = []
  const transport = createCodexRpcTransport({
    command: '/Users/dev/bin/codex',
    cwd: '/Users/dev/app',
    env: {},
    spawnChild: (() => child) as unknown as CodexRpcOptions['spawnChild'],
    onMessage: () => undefined,
    onClose: (error) => closed.push(error),
  })
  const request = transport.request('initialize', {})
  child.emit('error', Object.assign(new Error('spawn /Users/dev/bin/codex ENOENT'), { code: 'ENOENT' }))
  await expect(request).rejects.toThrow('Codex could not be started from /Users/dev/bin/codex')
  await new Promise((resolve) => setImmediate(resolve))
  expect(closed[0]?.message).toContain('ENOENT')
})

test('a tool Codex could not run is read from stderr, and nothing else there is', async () => {
  const failures: string[] = []
  const f = fixture(1000, { onToolFailure: (reason) => failures.push(reason) })
  const line =
    '\u001b[2m2026-09-29T14:14:20.361376Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::tools::router\u001b[0m\u001b[2m:\u001b[0m \u001b[3merror\u001b[0m\u001b[2m=\u001b[0mtimed out negotiating with the code-mode host\n'
  // Split mid-line: a reason is read only once its line is whole.
  f.child.stderr.write(line.slice(0, 40))
  expect(failures).toEqual([])
  f.child.stderr.write(line.slice(40))
  f.child.stderr.write('2026-09-29T14:14:21Z  WARN codex_core::client: token=secret request failed\n')
  await new Promise((resolve) => setImmediate(resolve))
  expect(failures).toEqual(['timed out negotiating with the code-mode host'])
  f.transport.close()
})

test('stderr parsing ignores other targets and levels', () => {
  expect(
    codexToolFailure('2026-09-29T14:18:01Z ERROR codex_core::tools::router: error=code-mode host is disabled'),
  ).toBe('code-mode host is disabled')
  expect(codexToolFailure('2026-09-29T14:18:01Z ERROR codex_core::client: error=bad key sk-123')).toBeNull()
  expect(codexToolFailure('2026-09-29T14:18:01Z WARN codex_core::tools::router: error=slow')).toBeNull()
  expect(codexToolFailure(`x ERROR codex_core::tools::router: error=${'a'.repeat(900)}`)).toHaveLength(500)
})

test('extra app-server arguments follow its own and split as a shell would', () => {
  expect(codexAppServerArgs(`-c 'model_reasoning_summary="auto"' --disable  "code mode"`)).toEqual([
    '-c',
    'model_reasoning_summary="auto"',
    '--disable',
    'code mode',
  ])
  expect(codexAppServerArgs(undefined)).toEqual([])
  expect(codexAppServerArgs(`--enable ''`)).toEqual(['--enable', ''])
  const f = fixture(1000, { args: ['--enable', 'feature'] })
  expect(f.spawned[0]?.slice(-5)).toEqual(['app-server', '--listen', 'stdio://', '--enable', 'feature'])
  f.transport.close()
})

test('a frame split over many chunks and several frames in one chunk are each delivered once', async () => {
  const f = fixture()
  const big = JSON.stringify({ method: 'item/completed', params: { output: 'x'.repeat(200_000) } })
  const bytes = Buffer.from(`${big}\n{"method":"a"}\n{"method":"b"}\n{"meth`)
  for (let at = 0; at < bytes.length; at += 4096) f.child.stdout.write(bytes.subarray(at, at + 4096))
  f.child.stdout.write('od":"c"}\n')
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.messages.map((message) => message.method)).toEqual(['item/completed', 'a', 'b', 'c'])
  expect((f.messages[0]?.params as { output: string }).output).toHaveLength(200_000)
  f.transport.close()
})

test('an unterminated frame over the size limit closes the connection', async () => {
  const f = fixture()
  const chunk = Buffer.alloc(1024 * 1024, 0x61)
  for (let i = 0; i < 17; i++) f.child.stdout.write(chunk)
  await new Promise((resolve) => setImmediate(resolve))
  expect(f.closed[0]?.message).toContain('size limit')
  expect(f.child.exitCode).toBe(0)
})

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('an exit before Codex answers carries the last line it wrote on stderr', async () => {
  const f = fixture()
  const request = f.transport.request('initialize', {})
  f.child.stderr.write('starting up\n')
  f.child.stderr.write('\u001b[31mError:\u001b[0m EPERM: operation not permitted, uv_cwd\n')
  await tick()
  f.child.emit('close', 1)
  await expect(request).rejects.toThrow('Codex process exited (1): Error: EPERM: operation not permitted, uv_cwd.')
  await tick()
  expect(f.closed[0]?.message).toBe('Codex process exited (1): Error: EPERM: operation not permitted, uv_cwd.')
})

test('an exit once Codex has answered keeps stderr out of the reason', async () => {
  const f = fixture()
  const request = f.transport.request('initialize', {})
  f.child.stdout.write('{"id":1,"result":{}}\n')
  await request
  f.child.stderr.write('Error: something it logged later\n')
  await tick()
  f.child.emit('close', 1)
  await tick()
  expect(f.closed[0]?.message).toBe('Codex process exited (1).')
})

test('a startup line that names a credential is never repeated', async () => {
  const f = fixture()
  const request = f.transport.request('initialize', {})
  f.child.stderr.write('Error: could not read config\n')
  f.child.stderr.write('Authorization: Bearer sk-live-123 refused\n')
  await tick()
  f.child.emit('close', 1)
  await expect(request).rejects.toThrow('Codex process exited (1): Error: could not read config.')
})

test('a startup stderr line is cleaned and clipped', () => {
  expect(codexStartupStderrLine('\u001b[2m  plain words  \u001b[0m')).toBe('plain words')
  expect(codexStartupStderrLine('   ')).toBeNull()
  expect(codexStartupStderrLine('api_key=abc')).toBeNull()
  expect(codexStartupStderrLine('x'.repeat(400))).toHaveLength(300)
})
