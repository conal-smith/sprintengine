// One SSH machine's state machine, with a plain `sh -s` in a home of its own
// standing in for `ssh build-box sh -s`: the real connect script, the real
// server tree and the real relay. ssh's own failures are played by a stand-in
// that prints what ssh prints and exits 255. The same against a container's
// sshd is in ssh-environment.docker.test.ts.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { WSL_NODE_VERSION } from '../../hosts/wsl-node-runtime'
import { BACKEND_WIRE_VERSION } from '../../../server/wsl/backend-wire'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS, type SshEnvironmentSettings } from '../../../shared/ssh-environments'
import { installFailureWords, SshEnvironment, type SshEnvironmentDeps } from './ssh-environment'
import { serverTreeDigest } from './ssh-install'
import type { SessionProcess } from './ssh-session'

const ROOT = join(__dirname, '..', '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

let scratch = ''
let tree = ''
let digest = ''
const pids = new Set<number>()
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'se-sshe-'))
  tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  digest = serverTreeDigest(tree)
})
afterAll(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Gone.
    }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

const fakeNode = Buffer.from(
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${WSL_NODE_VERSION}; exit 0; fi\nexec '${process.execPath}' "$@"\n`,
)

type Harness = {
  env: SshEnvironment
  spawned: Array<{ interactive: boolean; child: SessionProcess }>
  changes: string[]
  environmentIds: string[]
  settings: SshEnvironmentSettings
}

function harness(
  home: string,
  overrides: Partial<SshEnvironmentDeps> & { spawnWith?: (interactive: boolean) => SessionProcess | undefined } = {},
): Harness {
  const spawned: Harness['spawned'] = []
  const changes: string[] = []
  const environmentIds: string[] = []
  const settings: SshEnvironmentSettings = { ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true }
  const env: SshEnvironment = new SshEnvironment({
    id: 'e1',
    label: () => 'build-box',
    settings: () => settings,
    spawn: ({ interactive }) => {
      const child =
        overrides.spawnWith?.(interactive) ??
        (spawn('sh', ['-c', 'echo "Welcome to build-box"; exec sh -s'], {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' },
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as unknown as SessionProcess)
      spawned.push({ interactive, child })
      return child
    },
    app: { version: VERSION, channel: 'latest', backendWire: BACKEND_WIRE_VERSION },
    dataName: 'data',
    startedBy: 'Studio on dev-macbook-air',
    serverTree: () => ({ dir: tree, digest }),
    nodeBinary: async () => ({ binary: fakeNode }),
    onChange: () => changes.push(`${env.summary().state}: ${env.summary().stateText}`),
    onEnvironmentId: (id) => environmentIds.push(id),
    timing: { backoffMs: [50, 100, 200], giveUpMs: 60_000, livenessMs: 500 },
    ...overrides,
  })
  return { env, spawned, changes, environmentIds, settings }
}

const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 50))
  return check()
}

test('connect: installed, started, connected; a second client attaches; a lost session comes back on its own', async () => {
  const home = join(scratch, 'one')
  mkdirSync(home)
  const first = harness(home)
  // Two triggers at once run one bootstrap.
  const [a, b] = await Promise.all([
    first.env.connect({ interactive: true }),
    first.env.connect({ interactive: false }),
  ])
  assert.equal(a, b)
  assert.equal(first.env.summary().state, 'connected')
  assert.equal(first.env.summary().stateText, 'Connected')
  assert.equal(first.env.summary().server?.version, VERSION)
  assert.ok(first.changes.some((line) => line.startsWith('installing: Installing Studio server')))
  assert.ok(first.changes.some((line) => line.startsWith('starting: Starting the Studio server on build-box')))
  assert.equal(first.spawned.length, 2, 'an install is one session, the start another')
  assert.ok(
    first.spawned.every((entry) => entry.interactive),
    'the person asked: ssh may ask them',
  )
  assert.equal(first.environmentIds.length, 1)
  assert.ok((await a.backend.listThreads({ workspaceId: 'w', workspaceRoot: home } as never)) !== undefined)
  const record = JSON.parse(
    readFileSync(join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run', 'server.json'), 'utf8'),
  ) as { pid: number }
  pids.add(record.pid)

  // Another desktop of the same version attaches to the same server.
  const second = harness(home)
  await second.env.connect({ interactive: true })
  assert.ok(!second.changes.some((line) => line.startsWith('starting:')))
  assert.equal(second.spawned.length, 1)

  // The session dies (a dropped network): reconnects in the background, BatchMode, same server.
  const beforeDrop = first.spawned.length
  first.spawned.at(-1)!.child.kill()
  assert.ok(await until(() => first.env.summary().state === 'reconnecting', 5_000))
  assert.match(first.env.summary().stateText, /Reconnecting to build-box — last reached/u)
  // A chat asking meanwhile joins the reconnect rather than starting its own.
  const joined = await Promise.all([
    first.env.connect({ interactive: false }),
    first.env.connect({ interactive: false }),
  ])
  assert.equal(joined[0], joined[1])
  assert.equal(first.env.summary().state, 'connected', first.changes.join('\n'))
  assert.equal(first.spawned.length, beforeDrop + 1, 'one session for the reconnect, however many asked')
  assert.equal(first.spawned.at(-1)!.interactive, false, 'a background reconnect never prompts')
  const after = JSON.parse(
    readFileSync(join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run', 'server.json'), 'utf8'),
  ) as { pid: number }
  assert.equal(after.pid, record.pid, 'the server outlived the session')

  // Wake with a session that answers (a screen unlocked): it is kept, and no ssh runs.
  const sessions = first.spawned.length
  first.env.wake()
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  assert.equal(first.spawned.length, sessions, 'a session that answers is not restarted')
  assert.equal(first.env.summary().state, 'connected')
  // Wake with a session that stopped answering (a socket that died asleep): it is restarted.
  first.spawned.at(-1)!.child.stdout.pause()
  first.env.wake()
  assert.ok(await until(() => first.spawned.length > sessions && first.env.summary().state === 'connected', 30_000))

  // Disconnect leaves the server running; stop drains it.
  second.env.disconnect()
  assert.ok(await until(() => second.env.summary().state === 'idle', 5_000))
  first.env.disconnect()
  await first.env.stopServer()
  assert.match(first.env.summary().stateText, /The Studio server on build-box is stopped/u)
  assert.ok(
    await until(() => {
      try {
        process.kill(record.pid, 0)
        return false
      } catch {
        return true
      }
    }, 20_000),
  )
})

test('a newer server on the machine is left alone: version-blocked, in words', async () => {
  const home = join(scratch, 'newer')
  const run = join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run')
  mkdirSync(run, { recursive: true, mode: 0o700 })
  // A live holder of the run lock (this test process) with a newer record.
  writeFileSync(
    join(run, 'studio.lock'),
    JSON.stringify({ role: 'server', pid: process.pid, hostname: hostname(), startedAt: '', token: 't' }),
  )
  writeFileSync(
    join(run, 'server.json'),
    JSON.stringify({
      v: 1,
      pid: process.pid,
      version: '99.0.0',
      origin: 'bootstrap',
      backendWire: 9,
      hostId: 'x',
      socketPath: '/nowhere.sock',
    }),
  )
  const machine = harness(home)
  await assert.rejects(machine.env.connect({ interactive: true }))
  assert.equal(machine.env.summary().state, 'version-blocked')
  assert.match(
    machine.env.summary().stateText,
    /build-box runs Studio server 99\.0\.0; this app is .* Update this app/u,
  )
  assert.equal(machine.env.summary().action, null)
  assert.equal(readFileSync(join(run, 'server.json'), 'utf8').includes('99.0.0'), true, 'never replaced')
})

test('Disconnect and Stop server hold until the person connects again; nothing in the background undoes them', async () => {
  const home = join(scratch, 'held')
  mkdirSync(home)
  const machine = harness(home)
  await machine.env.connect({ interactive: true })
  const serverJson = join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run', 'server.json')
  const record = JSON.parse(readFileSync(serverJson, 'utf8')) as { pid: number }
  pids.add(record.pid)
  machine.env.disconnect()
  assert.ok(await until(() => machine.env.summary().state === 'idle', 5_000))
  const sessions = machine.spawned.length
  // A chat asking in the background is told, and no ssh runs.
  await assert.rejects(machine.env.connect({ interactive: false }), /was disconnected in Settings/u)
  assert.equal(machine.spawned.length, sessions)
  // The person connects: background callers may use it again.
  await machine.env.connect({ interactive: true })
  await machine.env.connect({ interactive: false })

  // Stop server, with a chat asking while it runs: the stop is not undone.
  const stopping = machine.env.stopServer()
  const meanwhile = assert.rejects(machine.env.connect({ interactive: false }), /was disconnected in Settings/u)
  await stopping
  await meanwhile
  await assert.rejects(machine.env.connect({ interactive: false }), /was disconnected in Settings/u)
  assert.ok(
    await until(() => {
      try {
        process.kill(record.pid, 0)
        return false
      } catch {
        return true
      }
    }, 20_000),
    'the server stayed stopped',
  )
  assert.match(machine.env.summary().stateText, /is stopped/u)
}, 120_000)

test('Stop server never signals the pid in a lock another machine holds', async () => {
  const home = join(scratch, 'shared-home')
  const run = join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run')
  mkdirSync(run, { recursive: true, mode: 0o700 })
  // A home shared over NFS: the lock is another machine's, and its pid here is someone else's process.
  const bystander = spawn('sleep', ['30'], { stdio: 'ignore' })
  pids.add(bystander.pid!)
  writeFileSync(
    join(run, 'studio.lock'),
    JSON.stringify({ role: 'server', pid: bystander.pid, hostname: 'other-box', startedAt: '', token: 't' }),
  )
  writeFileSync(
    join(run, 'server.json'),
    JSON.stringify({ v: 1, pid: bystander.pid, version: VERSION, origin: 'bootstrap', hostId: 'x' }),
  )
  const machine = harness(home)
  await assert.rejects(machine.env.stopServer(), /runs on other-box, not build-box/u)
  assert.equal(machine.env.summary().state, 'failed')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(bystander.exitCode, null, 'still running')
  assert.equal(bystander.signalCode, null)
  bystander.kill('SIGKILL')
})

/** A stand-in for ssh that fails as ssh does: its words on stderr, exit 255. */
function failingSsh(stderr: string): (interactive: boolean) => SessionProcess {
  return () =>
    spawn('sh', ['-c', `cat >/dev/null & printf '%s\\n' '${stderr}' >&2; exit 255`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as unknown as SessionProcess
}

test("ssh's failures become the machine's state in words; a reconnect that needs a prompt stops and says so", async () => {
  const refused = harness(scratch, {
    spawnWith: failingSsh('ssh: connect to host 127.0.0.1 port 2222: Connection refused'),
  })
  await assert.rejects(refused.env.connect({ interactive: true }))
  assert.equal(refused.env.summary().state, 'failed')
  assert.match(refused.env.summary().stateText, /build-box refused the connection/u)
  assert.equal(refused.env.summary().action, 'connect')

  const changed = harness(scratch, {
    spawnWith: failingSsh(
      '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nOffending ED25519 key in /Users/dev/.ssh/known_hosts:3\nHost key for build-box has changed and you have requested strict checking.\nHost key verification failed.',
    ),
  })
  await assert.rejects(changed.env.connect({ interactive: true }))
  assert.match(changed.env.summary().stateText, /host key has changed .* ssh-keygen -R build-box/u)

  const batch = harness(scratch, { spawnWith: failingSsh('dev@build-box: Permission denied (publickey,password).') })
  await assert.rejects(batch.env.connect({ interactive: false }))
  assert.equal(batch.env.summary().state, 'needs-sign-in')
  assert.equal(batch.env.summary().stateText, 'build-box needs you to sign in.')
  // Nothing in the background tries again until the person connects.
  const spawnedBefore = batch.spawned.length
  await assert.rejects(batch.env.connect({ interactive: false }), /needs you to sign in/u)
  assert.equal(batch.spawned.length, spawnedBefore)

  // A failure the person saw is not retried by every background caller (a view polling git).
  const refusedBefore = refused.spawned.length
  for (let poll = 0; poll < 3; poll++)
    await assert.rejects(refused.env.connect({ interactive: false }), /build-box refused the connection/u)
  assert.equal(refused.spawned.length, refusedBefore, 'no ssh ran for them')
  await assert.rejects(refused.env.connect({ interactive: true }))
  assert.equal(refused.spawned.length, refusedBefore + 1, 'Connect in Settings still tries')
})

test('a machine Studio cannot run on is named, and nothing is installed there', async () => {
  const probe = [
    '@@SPRINTENGINE_PROBE proto=1',
    '@@SPRINTENGINE_PROBE os=Linux',
    '@@SPRINTENGINE_PROBE machine=x86_64',
    '@@SPRINTENGINE_PROBE libc=musl',
    '@@SPRINTENGINE_PROBE writable=1',
    '@@SPRINTENGINE_PROBE exec=1',
    '@@SPRINTENGINE_PROBE end=1',
    '@@SPRINTENGINE_SEND',
  ].join('\\n')
  const alpine = harness(scratch, {
    spawnWith: () =>
      spawn('sh', ['-c', `cat >/dev/null & printf '${probe}\\n'; sleep 5`], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as unknown as SessionProcess,
  })
  await assert.rejects(alpine.env.connect({ interactive: true }))
  assert.equal(alpine.env.summary().state, 'unsupported')
  assert.match(alpine.env.summary().stateText, /uses musl \(as Alpine does\)/u)
})

test('a wake tries again: time asleep is not counted, a machine that gave up reconnects, what the person holds stays held', async () => {
  const home = join(scratch, 'woke')
  mkdirSync(home)
  let skew = 0
  let refuse = false
  const refusing = failingSsh('ssh: connect to host 127.0.0.1 port 2222: Connection refused')
  const machine = harness(home, {
    now: () => Date.now() + skew,
    spawnWith: (interactive) => (refuse ? refusing(interactive) : undefined),
    timing: { backoffMs: [50, 100, 200], giveUpMs: 2_000, livenessMs: 500 },
  })
  await machine.env.connect({ interactive: true })
  const record = JSON.parse(
    readFileSync(join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run', 'server.json'), 'utf8'),
  ) as { pid: number }
  pids.add(record.pid)

  // The network drops, then the lid closes for longer than the give-up window.
  refuse = true
  machine.spawned.at(-1)!.child.kill()
  assert.ok(await until(() => machine.env.summary().state === 'reconnecting', 5_000))
  skew += 10 * 60_000
  machine.env.wake()
  // The wake's first try fails (the Wi-Fi is not back yet): the machine keeps trying.
  const tried = machine.spawned.length
  assert.ok(await until(() => machine.spawned.length > tried + 1, 5_000))
  assert.equal(machine.env.summary().state, 'reconnecting', machine.changes.join('\n'))

  // Ten minutes awake and failing: it gives up, and background callers are told.
  assert.ok(await until(() => machine.env.summary().state === 'disconnected', 10_000))
  await assert.rejects(machine.env.connect({ interactive: false }), /Disconnected from build-box/u)
  // The network comes back: the online check wakes it, and it reconnects on its own.
  refuse = false
  machine.env.wake()
  assert.ok(await until(() => machine.env.summary().state === 'connected', 30_000), machine.changes.join('\n'))
  assert.equal(machine.spawned.at(-1)!.interactive, false, 'a reconnect after a wake never prompts')

  // The person's Disconnect is not undone by a wake.
  machine.env.disconnect()
  assert.ok(await until(() => machine.env.summary().state === 'idle', 5_000))
  const afterDisconnect = machine.spawned.length
  machine.env.wake()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(machine.spawned.length, afterDisconnect)
  assert.equal(machine.env.summary().state, 'idle')

  // A reconnect that needs a sign-in waits for the person, wake or no wake.
  const batch = harness(scratch, { spawnWith: failingSsh('dev@build-box: Permission denied (publickey,password).') })
  await assert.rejects(batch.env.connect({ interactive: false }))
  assert.equal(batch.env.summary().state, 'needs-sign-in')
  const signInBefore = batch.spawned.length
  batch.env.wake()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(batch.spawned.length, signInBefore)
  assert.equal(batch.env.summary().state, 'needs-sign-in')
}, 120_000)

test('install failures read as sentences', () => {
  assert.match(installFailureWords('unpack tar: Disk quota exceeded', 'build-box'), /your disk quota is full/u)
  assert.match(installFailureWords('node-run sh: Permission denied', 'build-box'), /mounted noexec/u)
  assert.match(
    installFailureWords(`digest ${'a'.repeat(64)} ${'b'.repeat(64)}`, 'build-box'),
    /did not match its checksum/u,
  )
  assert.match(installFailureWords('fetch-tool', 'build-box'), /neither curl nor wget/u)
})
