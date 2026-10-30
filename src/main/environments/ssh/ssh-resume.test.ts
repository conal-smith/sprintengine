// An open chat on an SSH machine catches up after its connection drops: a
// subscription (the chat view's, through ConversationSessionApi) on the
// router, the router on a real SshEnvironment (a plain `sh` standing in for
// ssh, the real server tree and relay). While this desktop's session is
// down, another client answers the turn's approval on the machine, so the
// turn ends where nobody here sees it; when the session comes back, the
// subscription is handed exactly the events it missed, by its cursor, with
// no reload and nothing twice.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import type { ConversationEvent, ConversationSessionFrame } from '../../../shared/conversation-runtime'
import { DEFAULT_SSH_ENVIRONMENT_SETTINGS } from '../../../shared/ssh-environments'
import type { ConversationBackend } from '../../../server/core/conversation-backend'
import { createRoutedConversationBackend } from '../../../server/core/routed-conversation-backend'
import { BACKEND_WIRE_VERSION } from '../../../server/wsl/backend-wire'
import { ConversationSessionApi } from '../../conversation-session-api'
import { WSL_NODE_VERSION } from '../../hosts/wsl-node-runtime'
import { SshEnvironment } from './ssh-environment'
import { serverTreeDigest } from './ssh-install'
import type { SessionProcess } from './ssh-session'

const ROOT = join(__dirname, '..', '..', '..', '..')
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
let scratch = ''
let tree = ''
let digest = ''
const pids: number[] = []

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'se-ssh-resume-'))
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

const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (Date.now() < end && !check()) await new Promise((resolve) => setTimeout(resolve, 50))
  return check()
}

/** `sessions` collects every ssh the machine spawns, so a test can drop one. */
function machine(home: string, id: string, sessions: SessionProcess[] = []): SshEnvironment {
  const fakeNode = Buffer.from(
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${WSL_NODE_VERSION}; exit 0; fi\nexec '${process.execPath}' "$@"\n`,
  )
  return new SshEnvironment({
    id,
    label: () => 'build-box',
    settings: () => ({ ...DEFAULT_SSH_ENVIRONMENT_SETTINGS, keepRunning: true }),
    spawn: () => {
      const child = spawn('sh', ['-s'], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, SHELL: '/bin/sh' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as unknown as SessionProcess
      sessions.push(child)
      return child
    },
    app: { version: VERSION, channel: 'latest', backendWire: BACKEND_WIRE_VERSION },
    dataName: 'data',
    startedBy: 'Studio on dev-macbook-air',
    serverTree: () => ({ dir: tree, digest }),
    nodeBinary: async () => ({ binary: fakeNode }),
    onChange: () => undefined,
    timing: { backoffMs: [100, 200, 400] },
  })
}

test('a chat open through a dropped session is handed what it missed, by its cursor', async () => {
  const home = join(scratch, 'home')
  mkdirSync(join(home, 'repo'), { recursive: true })
  const repo = join(home, 'repo')
  const ourSessions: SessionProcess[] = []
  const ours = machine(home, 'ours', ourSessions)
  const local = new Proxy(
    {},
    {
      get: (_t, member) =>
        member === 'onEvent'
          ? () => () => undefined
          : member === 'listSessions'
            ? () => ({ ok: true, sessions: [] })
            : undefined,
    },
  ) as ConversationBackend
  const router = createRoutedConversationBackend({
    local,
    workspace: () => ({ folderPath: repo, environment: { kind: 'ssh', id: 'ours' } }),
    chatServerOn: () => false,
    ssh: {
      connect: () => ours.connect({ interactive: false }),
      current: () => ours.current(),
      touch: () => undefined,
    },
    platform: 'darwin',
  })
  // As main wires it: every new connection, the first and each reconnect, is attached.
  const env = ours as unknown as { deps: { onConnected?: (c: unknown) => void } }
  env.deps.onConnected = (connection) => router.attach(connection as never)

  const key = { workspaceId: 'w1', agentId: 'a1', workspaceRoot: repo }
  const started = (await router.startSession({
    ...key,
    providerId: 'mock-provider',
    modelId: 'mock-model',
  } as never)) as {
    ok: boolean
    session: { sessionId: string }
  }
  assert.ok(started.ok)
  const sessionId = started.session.sessionId
  const serverPid = (
    JSON.parse(
      readFileSync(join(home, '.local', 'share', 'sprintengine-studio', 'data', 'run', 'server.json'), 'utf8'),
    ) as {
      pid: number
    }
  ).pid
  pids.push(serverPid)

  // The chat view's subscription.
  const frames: ConversationSessionFrame[] = []
  const api = new ConversationSessionApi(router)
  const subscription = api.subscribe({ key, turnLimit: 50 }, (frame) => frames.push(frame))
  await subscription.ready
  const asking = new Promise<ConversationEvent>((resolve) => {
    const stop = router.onEvent((event) => {
      if (event.type !== 'approval_requested') return
      stop()
      resolve(event)
    })
  })
  await router.sendTurn({ sessionId, message: 'hello', commandId: 'c1' } as never)
  const approval = await asking
  assert.ok(
    await until(
      () => frames.some((frame) => frame.type === 'event' && frame.event.type === 'approval_requested'),
      5_000,
    ),
  )

  // This desktop's session drops.
  ourSessions.at(-1)!.kill()
  // Another client of the same machine answers the approval meanwhile.
  const other = machine(home, 'other')
  const theirs = await other.connect({ interactive: false })
  const answered = (await theirs.backend.respondToRequest({
    sessionId,
    requestId: (approval.payload as { requestId: string }).requestId,
    approved: true,
  } as never)) as { ok: boolean }
  assert.ok(answered.ok)
  other.disconnect()

  // Ours comes back; the subscription catches up without being asked.
  const caughtUp = () =>
    frames.some(
      (frame) => frame.type === 'event' && frame.event.type === 'turn_completed' && frame.event.sessionId === sessionId,
    )
  assert.ok(
    await until(caughtUp, 30_000),
    JSON.stringify(frames.map((frame) => (frame.type === 'event' ? frame.event.type : frame.type))),
  )
  const seqs = frames.flatMap((frame) =>
    frame.type === 'event' && frame.event.seq !== undefined ? [frame.event.seq] : [],
  )
  assert.equal(new Set(seqs).size, seqs.length, 'nothing handed over twice')
  assert.deepEqual(
    [...seqs].sort((a, b) => a - b),
    seqs,
    'in order',
  )
  assert.ok(frames.filter((frame) => frame.type === 'synchronized').length >= 2, 'a second fence after the catch-up')
  assert.ok(!frames.some((frame) => frame.type === 'error'), 'no error, no reload')
  subscription.dispose()
  ours.disconnect()
})
