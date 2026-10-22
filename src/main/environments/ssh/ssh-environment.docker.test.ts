// An SSH machine for real (phase 8 spec, 9.3): the system ssh, a container's
// sshd with forwarding of every kind turned off, the askpass shim answering a
// first-connect host key and a key's passphrase, the pinned Linux Node
// downloaded and checked on this machine and streamed with the server tree,
// a managed server started there, a chat on the mock provider driven through
// the relay, the session dropped mid-turn and resumed, and the remote's own
// `localhost` reached through the relay's tcp streams.
//
// Runs with STUDIO_TEST_DOCKER=1 and a Docker that answers. The Node archive
// is cached in STUDIO_TEST_CACHE (or the system temp directory).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, test } from 'vitest'

import type { ConversationEvent } from '../../../shared/conversation-runtime'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS } from '../../../shared/ssh-environments'
import { BACKEND_WIRE_VERSION } from '../../../server/wsl/backend-wire'
import { createAskpassBroker, type AskpassRequest } from './askpass'
import {
  DOCKER_TESTS,
  prepareSshdImage,
  SSHD_IMAGE_BUILD_MS,
  startSshd,
  type SshdFixture,
} from './__fixtures__/docker-sshd'
import { parseDestination, spawnSshSession } from './ssh-command'
import { SshEnvironment } from './ssh-environment'
import { ensureNodeBinary, serverTreeDigest } from './ssh-install'
import type { SessionProcess } from './ssh-session'

const ROOT = join(__dirname, '..', '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const CACHE = process.env.STUDIO_TEST_CACHE || join(tmpdir(), 'se-ssh-node-cache')

let scratch = ''
let tree = ''
let digest = ''
let sshd: SshdFixture | null = null

beforeAll(async () => {
  if (!DOCKER_TESTS) return
  await prepareSshdImage()
  scratch = mkdtempSync(join(tmpdir(), 'se-sshd-env-'))
  tree = join(scratch, 'tree')
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-server.mjs'), '--wsl', '--out-dir', tree], {
    cwd: ROOT,
    stdio: 'pipe',
  })
  digest = serverTreeDigest(tree)
  sshd = startSshd({
    passphrase: 'correct horse',
    // The relay needs none of these.
    sshdOptions: ['AllowTcpForwarding no', 'AllowStreamLocalForwarding no', 'X11Forwarding no'],
  })
}, SSHD_IMAGE_BUILD_MS)
afterAll(() => {
  sshd?.stop()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 100))
  return check()
}

function nextEvent(
  backend: { onEvent(listener: (event: ConversationEvent) => void): () => void },
  type: string,
): Promise<ConversationEvent> {
  return new Promise((resolve) => {
    const stop = backend.onEvent((event) => {
      if (event.type !== type) return
      stop()
      resolve(event)
    })
  })
}

test.skipIf(!DOCKER_TESTS)(
  'build-box for real: first connect asks, installs, starts; a chat survives a dropped session; the relay reaches its localhost',
  async () => {
    const fixture = sshd!
    const asked: AskpassRequest[] = []
    const broker = await createAskpassBroker({
      runAsNode: false,
      ask: async (request) => {
        asked.push(request)
        if (request.kind === 'host-key') return 'yes'
        if (request.kind === 'passphrase') return 'correct horse'
        return null
      },
    })
    const destination = parseDestination('build-box')
    assert.ok(destination.ok)
    const spawned: Array<{ interactive: boolean; child: SessionProcess }> = []
    const changes: string[] = []
    const env: SshEnvironment = new SshEnvironment({
      id: 'docker',
      label: () => 'build-box',
      settings: () => ({ ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true }),
      spawn: ({ interactive }) => {
        const child = spawnSshSession({
          ssh: 'ssh',
          destination: destination.destination,
          label: 'build-box',
          interactive,
          askpass: broker,
          configFile: fixture.configFile,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        }) as unknown as SessionProcess
        spawned.push({ interactive, child })
        return child
      },
      app: { version: VERSION, channel: 'latest', backendWire: BACKEND_WIRE_VERSION },
      dataName: 'data',
      startedBy: 'Studio on dev-macbook-air',
      serverTree: () => ({ dir: tree, digest }),
      nodeBinary: (target) => ensureNodeBinary(target, { cacheDir: CACHE, subject: 'build-box' }),
      onChange: () => changes.push(`${env.summary().state}: ${env.summary().stateText}`),
      timing: { backoffMs: [200, 500, 1_000] },
    })
    try {
      const connection = await env.connect({ interactive: true })
      assert.equal(env.summary().state, 'connected', changes.join('\n'))
      assert.deepEqual(
        asked.map((request) => request.kind),
        ['host-key', 'passphrase', 'passphrase'],
        'the host key once (ssh wrote it), the passphrase once per session',
      )
      assert.ok(changes.some((line) => /^installing: Installing Studio server .* on build-box \(\d+ MB\)/u.test(line)))
      assert.match(env.summary().diagnostics.noise, /Welcome to build-box/u)
      const serverPid = Number(
        fixture.exec(
          'sed -n \'s/.*"pid":\\([0-9]*\\).*/\\1/p\' /home/dev/.local/share/sprintengine-studio/data/run/server.json',
        ),
      )
      assert.ok(serverPid > 0)
      // Private on the remote, and the token in no command line.
      assert.equal(fixture.exec('stat -c %a /home/dev/.local/share/sprintengine-studio/data/run').trim(), '700')
      assert.equal(
        fixture.exec('stat -c %a /home/dev/.local/share/sprintengine-studio/data/run/owner-token').trim(),
        '600',
      )
      const token = fixture.exec('cat /home/dev/.local/share/sprintengine-studio/data/run/owner-token').trim()
      assert.ok(!fixture.exec('ps -eo args').includes(token))
      assert.ok(
        !fixture.exec('ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true').includes(':0 '),
        'no TCP listener',
      )

      // A chat on the mock provider: its turn waits on an approval.
      fixture.exec('mkdir -p /home/dev/repo', 'dev')
      const key = { workspaceRoot: '/home/dev/repo', workspaceId: 'w-docker', agentId: 'a1' }
      const started = (await connection.backend.startSession({
        ...key,
        providerId: 'mock-provider',
        modelId: 'mock-model',
      } as never)) as { ok: boolean; session: { sessionId: string } }
      assert.ok(started.ok)
      const sessionId = started.session.sessionId
      const asking = nextEvent(connection.backend, 'approval_requested')
      const turn = connection.backend.sendTurn({
        sessionId,
        message: 'hello from the desktop',
        commandId: 'c-1',
      } as never)
      const approval = await asking

      // The session drops mid-turn: the call in flight fails with the wire...
      spawned.at(-1)!.child.kill()
      await assert.rejects(Promise.resolve(turn))
      assert.ok(await until(() => env.summary().state === 'reconnecting', 5_000))
      // ...the server keeps the turn, and the background reconnect (BatchMode,
      // no prompt possible) cannot unlock the key: it says so.
      assert.ok(await until(() => env.summary().state !== 'reconnecting', 60_000), changes.join('\n'))
      assert.equal(env.summary().state, 'needs-sign-in', changes.join('\n'))
      assert.equal(env.summary().stateText, 'build-box needs you to sign in.')
      assert.equal(Number(fixture.exec(`kill -0 ${serverPid} && echo 1 || echo 0`)), 1, 'the server kept running')

      // The person connects: the same server, the same chat, the turn still waiting.
      const again = await env.connect({ interactive: true })
      assert.notEqual(again, connection)
      const retried = again.backend.sendTurn({
        sessionId,
        message: 'hello from the desktop',
        commandId: 'c-1',
      } as never)
      const done = nextEvent(again.backend, 'turn_completed')
      const answered = (await again.backend.respondToRequest({
        sessionId,
        requestId: (approval.payload as { requestId: string }).requestId,
        approved: true,
      } as never)) as { ok: boolean }
      assert.ok(answered.ok)
      await done
      assert.equal(((await retried) as { ok: boolean }).ok, true, 'the repeated command joined the one in flight')
      const transcript = JSON.stringify(await again.backend.readTranscript({ ...key } as never))
      assert.equal(transcript.split('hello from the desktop').length - 1 >= 1, true)
      assert.equal(
        (transcript.match(/Mock response for: hello from the desktop/gu) ?? []).length >= 1,
        true,
        'one turn, answered once',
      )

      // The remote's own localhost, through the relay (the pane's path, spec 6.8).
      fixture.exec(
        "mkdir -p /home/dev/site && echo 'build-box dev page' > /home/dev/site/index.html && cd /home/dev/site && (nohup python3 -m http.server 5173 --bind 127.0.0.1 >/dev/null 2>&1 &)",
        'dev',
      )
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const stream: Duplex = await again.openTcp('localhost', 5173)
      const body = await new Promise<string>((resolve) => {
        let text = ''
        stream.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
        stream.on('end', () => resolve(text))
        stream.end('GET / HTTP/1.0\r\nHost: localhost\r\n\r\n')
      })
      assert.match(body, /build-box dev page/u)
      await assert.rejects(again.openTcp('localhost', 5999), { code: 'refused' })
    } finally {
      env.disconnect()
      broker.close()
    }
  },
)

test.skipIf(!DOCKER_TESTS)('a key the remote refuses, and a home mounted noexec, are said in words', async () => {
  const noexec = startSshd({ noexecHome: true })
  try {
    const destination = parseDestination('build-box')
    assert.ok(destination.ok)
    const broker = await createAskpassBroker({ runAsNode: false, ask: async () => 'yes' })
    const env = new SshEnvironment({
      id: 'noexec',
      label: () => 'build-box',
      settings: () => DEFAULT_SSH_ENVIRONMENT_SETTINGS,
      spawn: ({ interactive }) =>
        spawnSshSession({
          ssh: 'ssh',
          destination: destination.destination,
          label: 'build-box',
          interactive,
          askpass: broker,
          configFile: noexec.configFile,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        }) as unknown as SessionProcess,
      app: { version: VERSION, channel: 'latest', backendWire: BACKEND_WIRE_VERSION },
      dataName: 'data',
      startedBy: 'Studio on dev-macbook-air',
      serverTree: () => ({ dir: tree, digest }),
      nodeBinary: (target) => ensureNodeBinary(target, { cacheDir: CACHE }),
      onChange: () => undefined,
    })
    await assert.rejects(env.connect({ interactive: true }))
    assert.equal(env.summary().state, 'unsupported')
    assert.match(env.summary().stateText, /Can't run programs from your home on build-box \(it is mounted noexec\)/u)
    broker.close()
  } finally {
    noexec.stop()
  }
  mkdirSync(scratch, { recursive: true })
})
