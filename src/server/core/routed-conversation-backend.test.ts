import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { WslServerConnection } from '../wsl/wsl-environment-manager'
import type { ConversationBackend } from './conversation-backend'
import { createRoutedConversationBackend } from './routed-conversation-backend'

// The router on a Windows front door, with stand-ins for this process's
// runtime and a distribution's server: which side each call reaches, with
// which paths, and what a caller sees when the server cannot be reached.

type Call = { member: string; args: unknown[] }

function summary(
  sessionId: string,
  workspaceId: string,
  agentId: string,
  status = 'ready',
): ConversationSessionSummary {
  return {
    sessionId,
    workspaceId,
    agentId,
    providerId: 'mock',
    modelId: 'model',
    status: status as ConversationSessionSummary['status'],
    createdAt: 0,
    updatedAt: 0,
  }
}

/** A backend that records every call and answers `{ ok: true }`, with sessions it can be told about. */
function recording(name: string) {
  const calls: Call[] = []
  const sessions: ConversationSessionSummary[] = []
  const listeners = new Set<(event: ConversationEvent) => void>()
  const special: Record<string, (...args: unknown[]) => unknown> = {
    onEvent: (listener) => {
      listeners.add(listener as (event: ConversationEvent) => void)
      return () => listeners.delete(listener as (event: ConversationEvent) => void)
    },
    listSessions: (input) => {
      const filter = (input ?? {}) as { workspaceId?: string; agentId?: string }
      return {
        ok: true,
        sessions: sessions.filter(
          (session) =>
            (!filter.workspaceId || session.workspaceId === filter.workspaceId) &&
            (!filter.agentId || session.agentId === filter.agentId),
        ),
      }
    },
    listLiveConversationRoots: () => [{ name }],
    getProviderCapabilities: () => ({ from: name }),
  }
  const backend = new Proxy(
    {},
    {
      get(_target, member: string) {
        if (member === 'then') return undefined
        if (special[member]) return special[member]
        return async (...args: unknown[]) => {
          calls.push({ member, args })
          if (member === 'readAttachment')
            return name === 'wsl' ? { ok: true, from: name } : { ok: false, message: 'no' }
          if (member === 'startSession') {
            const input = args[0] as { workspaceId: string; agentId: string }
            const session = summary(`${name}-1`, input.workspaceId, input.agentId)
            sessions.push(session)
            return { ok: true, session }
          }
          return { ok: true, from: name }
        }
      },
    },
  ) as ConversationBackend
  const emit = (event: ConversationEvent) => {
    for (const listener of listeners) listener(event)
  }
  return { backend, calls, sessions, emit }
}

function setup(options: { platform?: NodeJS.Platform; chatServer?: boolean; reachable?: boolean } = {}) {
  const local = recording('local')
  const remote = recording('wsl')
  const workspaces: Record<string, { hostId?: string; folderPath?: string }> = {
    'ws-linux': { hostId: 'wsl:Ubuntu', folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo' },
    'ws-drive': { hostId: 'wsl:Ubuntu', folderPath: 'C:\\Users\\dev\\repo' },
    'ws-local': { hostId: 'local', folderPath: 'C:\\Users\\dev\\local-repo' },
    'ws-cross': { hostId: 'local', folderPath: '\\\\wsl$\\Ubuntu\\home\\dev\\other' },
    'ws-older': { folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\older' },
  }
  let chatServer = options.chatServer ?? true
  let connected: WslServerConnection | null = null
  const connection: WslServerConnection = {
    distro: 'Ubuntu',
    backend: remote.backend as unknown as WslServerConnection['backend'],
    driveMountRoot: '/mnt/',
    environmentId: 'env',
    open: async () => assert.fail('not used'),
  }
  const connects: string[] = []
  const router = createRoutedConversationBackend({
    local: local.backend,
    workspace: (id) => workspaces[id] ?? null,
    chatServerOn: () => chatServer,
    servers: {
      connect: async (distro) => {
        connects.push(distro)
        if (options.reachable === false) throw new Error(`WSL: ${distro} runs on WSL 1, and chats there need WSL 2.`)
        connected = connection
        return connection
      },
      current: () => connected,
      touch: () => undefined,
    },
    platform: options.platform ?? 'win32',
  })
  return {
    router,
    local,
    remote,
    connection,
    connects,
    flip: (next: boolean) => {
      chatServer = next
    },
  }
}

const start = (workspaceId: string, workspaceRoot: string, agentId = 'agent') => ({
  workspaceRoot,
  workspaceId,
  agentId,
  providerId: 'mock',
  modelId: 'model',
})

test("a WSL workspace's chat starts on its distribution's server, with the root in Linux spelling", async () => {
  const { router, local, remote } = setup()
  const started = await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
  assert.ok(started.ok)
  assert.equal(local.calls.length, 0)
  assert.equal((remote.calls[0].args[0] as { workspaceRoot: string }).workspaceRoot, '/home/dev/repo')

  await router.startSession(start('ws-drive', 'C:\\Users\\dev\\repo', 'drive-agent'))
  assert.equal((remote.calls[1].args[0] as { workspaceRoot: string }).workspaceRoot, '/mnt/c/Users/dev/repo')

  await router.startSession(start('ws-local', 'C:\\Users\\dev\\local-repo'))
  assert.equal(local.calls.length, 1, 'a workspace on this PC stays here')

  await router.startSession(start('ws-older', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\older'))
  assert.equal(remote.calls.length, 3, 'a workspace that names no machine runs in the distribution its folder is in')
})

test('a folder inside a distribution, on This PC, runs its chat here (owner ruling 2026-10-03)', async () => {
  const { router, local, remote, connects } = setup()
  const started = await router.startSession(start('ws-cross', '\\\\wsl$\\Ubuntu\\home\\dev\\other'))
  assert.ok(started.ok)
  assert.equal(remote.calls.length, 0)
  assert.deepEqual(connects, [], 'no server is started for it')
  assert.equal(local.calls.length, 1)
  assert.equal(
    (local.calls[0].args[0] as { workspaceRoot: string }).workspaceRoot,
    '\\\\wsl$\\Ubuntu\\home\\dev\\other',
    'the agents are handed the folder as Windows names it',
  )
})

test('with the switch off, or off Windows, every chat stays in this process', async () => {
  for (const options of [{ chatServer: false }, { platform: 'linux' as const }]) {
    const { router, local, remote, connects } = setup(options)
    await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
    await router.listThreads({ workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', workspaceId: 'ws-linux' })
    assert.equal(local.calls.length, 2)
    assert.equal(remote.calls.length, 0)
    assert.deepEqual(connects, [])
  }
})

test('a call about a session goes where the session runs, so the switch never splits a chat', async () => {
  const { router, local, remote, flip } = setup({ chatServer: false })
  // Started here before the switch moved.
  const here = await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
  assert.ok(here.ok)
  flip(true)
  await router.sendTurn({ sessionId: here.session.sessionId, message: 'go on' })
  assert.equal(local.calls.at(-1)?.member, 'sendTurn')
  // The chat is still live here, so a start for it stays here too.
  await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
  assert.equal(local.calls.at(-1)?.member, 'startSession')
  assert.equal(remote.calls.length, 0)

  const there = await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', 'other'))
  assert.ok(there.ok)
  await router.interrupt({ sessionId: there.session.sessionId })
  assert.equal(remote.calls.at(-1)?.member, 'interrupt')
})

test('turning the switch off under a chat live on the server leaves it there until it stops', async () => {
  const { router, local, remote, flip } = setup()
  const there = await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
  assert.ok(there.ok)
  flip(false)
  await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
  assert.equal(remote.calls.at(-1)?.member, 'startSession', 'the live chat keeps its one writer')
  assert.equal(local.calls.length, 0)

  // Another chat in that workspace, or this one once stopped, starts here.
  await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', 'other'))
  assert.equal(local.calls.at(-1)?.member, 'startSession')
  remote.sessions.splice(0, remote.sessions.length, { ...remote.sessions[0], status: 'stopped' })
  await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
  assert.equal(local.calls.length, 2)
})

test('sessions and events from both sides reach every caller as one list and one stream', async () => {
  const { router, remote, connection } = setup()
  const events: string[] = []
  router.onEvent((event) => events.push(`${event.sessionId}:${event.type}`))
  const started = await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
  assert.ok(started.ok)
  // A reconnect hands the router the connection again: one subscription, not two.
  router.attach(connection)
  remote.emit({
    id: 'e',
    sessionId: 'wsl-1',
    workspaceId: 'ws-linux',
    agentId: 'agent',
    providerId: 'mock',
    modelId: 'model',
    type: 'turn_started',
    createdAt: 0,
  })
  assert.deepEqual(events, ['wsl-1:turn_started'])
  const listed = router.listSessions()
  assert.ok(listed.ok)
  assert.deepEqual(
    listed.sessions.map((session) => session.sessionId),
    ['wsl-1'],
  )
  assert.deepEqual(router.listLiveConversationRoots(), [{ name: 'local' }], 'a pid across the VM means nothing here')
  assert.deepEqual(router.getProviderCapabilities('mock'), { from: 'local' })
})

test('a server that cannot be reached answers in words, the way each call fails', async () => {
  const { router } = setup({ reachable: false })
  const started = await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
  assert.equal(started.ok, false)
  assert.match(started.ok ? '' : started.message, /needs WSL 2|need WSL 2/u)
  const detail = await router.getToolDetail({
    workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
    workspaceId: 'ws-linux',
    agentId: 'a',
    toolUseId: 't',
  })
  assert.deepEqual(detail.ok ? null : detail.code, 'unavailable')
  await assert.rejects(
    router.readPeekTranscript({
      workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
      workspaceId: 'ws-linux',
      agentId: 'a',
    }),
    /WSL 2/u,
  )
})

test('an attachment reference is looked for here first, then on the running servers', async () => {
  const { router } = setup()
  await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
  const found = (await router.readAttachment('conv/abc.png')) as unknown as { ok: boolean; from?: string }
  assert.deepEqual(found, { ok: true, from: 'wsl' })
})

test('a stop for one of a chat’s agents goes to the server the chat runs on', async () => {
  const { router, remote } = setup()
  const there = await router.startSession(start('ws-linux', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'))
  assert.ok(there.ok)
  await router.stopSubagent({ sessionId: there.session.sessionId, toolUseId: 'toolu_agent' })
  assert.equal(remote.calls.at(-1)?.member, 'stopSubagent')
})
