import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  CONVERSATION_MAX_PULL_REQUESTS,
  parseConversationServerFrame,
} from '../../../../packages/conversation-protocol/src/serverFrames'
import type { StudioPullRequest } from '../../../../packages/studio-protocol/src/pull-requests'
import { defaultMachineColour } from '../../../shared/machine-identity'
import { ConversationRuntime } from '../../conversation-runtime'
import { createMockConversationProvider } from '../../providers/mock-conversation-provider'
import { createConversationGatewayHost, type ConversationListMarks } from './tailnet-conversation-host'
import {
  conversationBranchesOf,
  conversationHostOf,
  conversationLocalServersOf,
  conversationPullRequestsOf,
  tailnetSelfMachine,
  type ConversationMachineContext,
} from './tailnet-conversation-machine'
import { createTailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer } from './tailnet-gateway-server'
import { createTailnetPeerResolver } from './tailnet-peer-identity'
import { TAILNET_IDENTITY_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// What a paired phone's conversation list and identity read say about
// machines and pull requests: the machine each chat runs on, this desktop's
// own kind and colour, and the pull requests each chat opened.

const windows: ConversationMachineContext = { hostName: 'build-box', platform: 'win32', marks: {} }

test('a chat on this machine names it `local`, in the kind and colour another desktop gives it', () => {
  const host = conversationHostOf({ folderPath: 'C:\\Users\\dev\\notes' }, windows)
  assert.deepEqual(host, {
    id: 'local',
    kind: 'desktop',
    label: 'build-box',
    color: defaultMachineColour('tailnet:build-box'),
  })
  // A Mac by its tailnet name: what a second desktop pairing with it would draw.
  const mac = conversationHostOf(null, { hostName: 'mac-mini.example.ts.net', platform: 'darwin', marks: {} })
  assert.equal(mac?.id, 'local')
  assert.equal(mac?.kind, 'mini')
  assert.equal(mac?.label, 'mac-mini')
  assert.equal(mac?.color, defaultMachineColour('tailnet:mac-mini'))
})

test("this machine's own mark is the person's, when they set one", () => {
  const marks = { local: { kind: 'tower' as const, colour: 'violet' as const } }
  assert.deepEqual(tailnetSelfMachine({ hostName: 'build-box', marks }), { kind: 'tower', color: 'violet' })
  assert.deepEqual(tailnetSelfMachine({ hostName: 'build-box', marks: {} }), {
    kind: 'desktop',
    color: defaultMachineColour('tailnet:build-box'),
  })
  // A chat on this machine wears the same mark the identity read gives it.
  assert.equal(conversationHostOf(null, { ...windows, marks })?.color, 'violet')
})

test('a chat in a WSL distribution names the distribution, with the override applied', () => {
  const record = { hostId: 'wsl:Ubuntu', folderPath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app' }
  assert.deepEqual(conversationHostOf(record, windows), {
    id: 'wsl:Ubuntu',
    kind: 'wsl',
    label: 'WSL: Ubuntu',
    color: defaultMachineColour('wsl:Ubuntu'),
  })
  const marked = conversationHostOf(record, { ...windows, marks: { 'wsl:Ubuntu': { colour: 'red' } } })
  assert.equal(marked?.color, 'red')
  assert.equal(marked?.kind, 'wsl')
  // A folder inside a distribution the person chose to run on This PC runs here.
  assert.equal(conversationHostOf({ hostId: 'local', folderPath: record.folderPath }, windows)?.id, 'local')
  // A recorded WSL id means nothing off Windows.
  assert.equal(conversationHostOf(record, { ...windows, platform: 'linux' })?.id, 'local')
})

test('a chat on an SSH machine is keyed by its host, and is left unmarked while the host is unknown', () => {
  const record = { environment: { kind: 'ssh' as const, id: 'saved-1', label: 'Build box' } }
  const known = conversationHostOf(record, {
    ...windows,
    sshMachineOf: (id) => (id === 'saved-1' ? { host: 'build-box.example.ts.net', port: 22 } : null),
    marks: { 'ssh:build-box.example.ts.net': { kind: 'cloud' } },
  })
  assert.deepEqual(known, {
    id: 'ssh:build-box.example.ts.net',
    kind: 'cloud',
    label: 'Build box',
    color: defaultMachineColour('ssh:build-box.example.ts.net'),
  })
  // The id the desktop's own rows use: no `user@`, and a port only when it is not 22.
  assert.equal(
    conversationHostOf(record, { ...windows, sshMachineOf: () => ({ host: 'build-box', port: 2222 }) })?.id,
    'ssh:build-box:2222',
  )
  assert.equal(
    conversationHostOf(record, { ...windows, sshMachineOf: () => ({ host: 'dev@build-box' }) })?.id,
    'ssh:build-box',
  )
  // Never a guess that would recolour the row once the host is known.
  assert.equal(conversationHostOf(record, windows), null)
  assert.equal(conversationHostOf(record, { ...windows, sshMachineOf: () => null }), null)
})

test('a chat born on a paired machine reached by its address keeps the address whole', () => {
  assert.equal(conversationHostOf({ remoteOrigin: { machineName: '100.64.0.7' } }, windows)?.id, 'tailnet:100.64.0.7')
  // A desktop named by its address is drawn the way a second desktop draws it.
  const self = conversationHostOf(null, { hostName: '100.64.0.7', platform: 'linux', marks: {} })
  assert.equal(self?.color, defaultMachineColour('tailnet:100.64.0.7'))
  // Words, not substrings: a runner whose name begins `macro` is no Mac.
  assert.equal(conversationHostOf(null, { hostName: 'macro-runner', platform: 'linux', marks: {} })?.kind, 'desktop')
})

test('a chat born on a paired machine is keyed by its short tailnet name', () => {
  const host = conversationHostOf({ remoteOrigin: { machineName: 'dev-macbook-air.example.ts.net' } }, windows)
  assert.deepEqual(host, {
    id: 'tailnet:dev-macbook-air',
    kind: 'laptop',
    label: 'dev-macbook-air.example.ts.net',
    color: defaultMachineColour('tailnet:dev-macbook-air'),
  })
})

function pullRequest(number: number, state: StudioPullRequest['state'] = 'open'): StudioPullRequest {
  return {
    url: `https://github.com/acme/app/pull/${number}`,
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    number,
    title: `Change ${number}`,
    state,
    isDraft: false,
    openedAt: 1,
    stateAt: 2,
  }
}

test("a chat's pull requests carry the number, state, link and title, and no more than the cap", () => {
  assert.deepEqual(conversationPullRequestsOf([pullRequest(7, 'merged')]), [
    { number: 7, state: 'merged', url: 'https://github.com/acme/app/pull/7', title: 'Change 7' },
  ])
  const many = Array.from({ length: CONVERSATION_MAX_PULL_REQUESTS + 5 }, (_, index) => pullRequest(index + 1))
  assert.equal(conversationPullRequestsOf(many).length, CONVERSATION_MAX_PULL_REQUESTS)
})

async function listFixture(marks: ConversationListMarks) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'conversation-machine-'))
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const host = createConversationGatewayHost(
    runtime,
    (id) => (id === 'workspace' ? workspaceRoot : null),
    () => [{ workspaceRoot, workspaceId: 'workspace' }],
    () => 'bypass',
    () => null,
    async () => null,
    marks,
  )
  for (const agentId of ['agent', 'other']) {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId,
      providerId: adapter.id,
      modelId: adapter.listModels()[0],
      permissionPreset: 'bypass',
    })
    assert.ok(started.ok)
  }
  return {
    host,
    cleanup: async () => {
      await runtime.shutdown()
      rmSync(workspaceRoot, { recursive: true, force: true })
    },
  }
}

test('each listed chat names its machine and its pull requests, read once for the whole list', async () => {
  const machineReads: string[] = []
  const prReads: number[] = []
  const f = await listFixture({
    machineOf: (workspaceId) => {
      machineReads.push(workspaceId)
      return { id: 'wsl:Ubuntu', kind: 'wsl', label: 'WSL: Ubuntu', color: 'teal' }
    },
    pullRequestsOf: async (keys) => {
      prReads.push(keys.length)
      return new Map([['workspace:agent', conversationPullRequestsOf([pullRequest(12)])]])
    },
    selfMachine: () => ({ kind: 'mini', color: 'blue' }),
  })
  try {
    const listed = await f.host.list()
    assert.equal(listed.length, 2)
    const byAgent = new Map(listed.map((thread) => [thread.agentId, thread]))
    assert.deepEqual(byAgent.get('agent')?.host, { id: 'wsl:Ubuntu', kind: 'wsl', label: 'WSL: Ubuntu', color: 'teal' })
    assert.deepEqual(byAgent.get('agent')?.pullRequests, [
      { number: 12, state: 'open', url: 'https://github.com/acme/app/pull/12', title: 'Change 12' },
    ])
    // A chat with none says so, rather than leaving a phone to wonder.
    assert.deepEqual(byAgent.get('other')?.pullRequests, [])
    assert.deepEqual(machineReads, ['workspace'], 'one machine read per workspace, not per chat')
    assert.deepEqual(prReads, [2], 'one record read for the whole list')
    assert.deepEqual(f.host.machine?.(), { kind: 'mini', color: 'blue' })

    // Every row survives the client's own validator with both fields whole.
    const parsed = parseConversationServerFrame({ type: 'sessions', requestId: 'list', sessions: listed })
    assert.ok(parsed?.type === 'sessions')
    assert.deepEqual(parsed.sessions.find((thread) => thread.agentId === 'agent')?.host, byAgent.get('agent')?.host)
    assert.deepEqual(
      parsed.sessions.find((thread) => thread.agentId === 'agent')?.pullRequests,
      byAgent.get('agent')?.pullRequests,
    )
  } finally {
    await f.cleanup()
  }
})

test("each listed chat names its agents' local servers, read once for the whole list, and none for a chat without", async () => {
  const reads: number[] = []
  const f = await listFixture({
    localServersOf: async (keys) => {
      reads.push(keys.length)
      return new Map([
        [
          'workspace:agent',
          conversationLocalServersOf([
            {
              id: 'srv-1',
              agentId: 'agent',
              url: 'http://localhost:5173/',
              title: 'localhost:5173',
              port: 5173,
              state: 'running',
              linkedAt: 1,
              stateAt: 2,
              command: 'npm run dev',
              cwd: '/Users/dev/app',
              startedByStudio: true,
            },
          ]),
        ],
      ])
    },
  })
  try {
    const listed = await f.host.list()
    const byAgent = new Map(listed.map((thread) => [thread.agentId, thread]))
    // What a paired machine draws and opens; never the command or its folder.
    assert.deepEqual(byAgent.get('agent')?.localServers, [
      { id: 'srv-1', url: 'http://localhost:5173/', title: 'localhost:5173', port: 5173, state: 'running' },
    ])
    assert.equal('localServers' in byAgent.get('other')!, false)
    assert.deepEqual(reads, [2], 'one record read for the whole list')
    const parsed = parseConversationServerFrame({ type: 'sessions', requestId: 'list', sessions: listed })
    assert.ok(parsed?.type === 'sessions')
    assert.deepEqual(
      parsed.sessions.find((thread) => thread.agentId === 'agent')?.localServers,
      byAgent.get('agent')?.localServers,
    )
  } finally {
    await f.cleanup()
  }
})

test('each listed chat names the branch its folder is on, read once per workspace', async () => {
  const asked: string[][] = []
  const f = await listFixture({
    branchesOf: async (workspaceIds) => {
      asked.push(workspaceIds)
      return new Map([['workspace', 'agent/fix-upload']])
    },
  })
  try {
    const listed = await f.host.list()
    assert.equal(listed.length, 2)
    for (const thread of listed) assert.equal(thread.branch, 'agent/fix-upload')
    assert.deepEqual(asked, [['workspace']], 'one read for the list, each workspace named once')
    const parsed = parseConversationServerFrame({
      type: 'sessions',
      requestId: 'list',
      sessions: [
        ...listed,
        { ...listed[0], agentId: 'spaced', branch: 'not a branch' },
        { ...listed[0], agentId: 'number', branch: 7 },
      ],
    })
    assert.ok(parsed?.type === 'sessions')
    assert.equal(parsed.sessions[0]?.branch, 'agent/fix-upload', 'the client keeps a branch')
    assert.equal('branch' in parsed.sessions.find((thread) => thread.agentId === 'spaced')!, false)
    assert.equal('branch' in parsed.sessions.find((thread) => thread.agentId === 'number')!, false)
  } finally {
    await f.cleanup()
  }
})

test('a branch read names only the folders on a branch, and a failed read names none', async () => {
  const folders: Record<string, string | null> = {
    onBranch: '/Users/dev/app',
    detached: '/Users/dev/detached',
    broken: '/Users/dev/broken',
    elsewhere: null,
  }
  const branches = await conversationBranchesOf(
    Object.keys(folders),
    (workspaceId) => folders[workspaceId] ?? null,
    async (cwd) => {
      if (cwd === '/Users/dev/broken') throw new Error('git is not installed')
      return { branch: cwd === '/Users/dev/app' ? 'main' : null }
    },
  )
  assert.deepEqual([...branches], [['onBranch', 'main']])
})

test('a per-list machine reader is made once for each list, and preferred to `machineOf`', async () => {
  let readers = 0
  const f = await listFixture({
    machineReader: () => {
      readers += 1
      return () => ({ id: 'local', kind: 'desktop', label: 'build-box', color: 'orange' })
    },
    machineOf: () => assert.fail('the reader answers'),
  })
  try {
    const listed = await f.host.list()
    assert.equal(listed.length, 2)
    for (const thread of listed) assert.equal(thread.host?.label, 'build-box')
    await f.host.list()
    assert.equal(readers, 2, 'one reader, and so one read of what it names machines against, per list')
  } finally {
    await f.cleanup()
  }
})

test('a failed read leaves the rows without the field, and the list still answers', async () => {
  const f = await listFixture({
    machineOf: () => {
      throw new Error('registry unavailable')
    },
    pullRequestsOf: async () => {
      throw new Error('record unavailable')
    },
  })
  try {
    const listed = await f.host.list()
    assert.equal(listed.length, 2)
    for (const thread of listed) {
      assert.equal('host' in thread, false)
      assert.equal('pullRequests' in thread, false)
    }
    assert.equal(f.host.machine, undefined)
  } finally {
    await f.cleanup()
  }
})

test('the client validator keeps a readable machine and pull request and drops the rest, never the row', () => {
  const row = {
    workspaceId: 'w',
    agentId: 'a',
    title: 'T',
    phase: 'idle',
    updatedAt: 2,
    createdAt: 1,
    providerId: 'p',
    modelId: 'm',
    turnCount: 1,
    lastSeq: 9,
  }
  const parsed = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list',
    sessions: [
      // A kind a newer desktop added passes: the client draws its fallback.
      { ...row, host: { id: 'ssh:build-box', kind: 'rack', label: 'Build box', color: 'teal' } },
      { ...row, agentId: 'b', host: { id: '', kind: 'wsl', label: 'x', color: 'teal' }, pullRequests: 'none' },
      {
        ...row,
        agentId: 'c',
        pullRequests: [
          { number: 3, state: 'open', url: 'https://github.com/acme/app/pull/3', title: 'Three' },
          { number: 4, state: 'draft', url: 'https://github.com/acme/app/pull/4', title: 'Four' },
          { number: 5, state: 'open', url: 'javascript:alert(1)', title: 'Five' },
          { number: -1, state: 'open', url: 'https://github.com/acme/app/pull/6', title: 'Six' },
        ],
      },
    ],
  })
  assert.ok(parsed?.type === 'sessions')
  assert.equal(parsed.sessions.length, 3)
  assert.equal(parsed.sessions[0]?.host?.kind, 'rack')
  assert.equal('host' in parsed.sessions[1]!, false)
  assert.equal('pullRequests' in parsed.sessions[1]!, false)
  assert.deepEqual(
    parsed.sessions[2]?.pullRequests?.map((entry) => entry.number),
    [3],
  )
})

/**
 * The row check a phone built before these fields shipped makes: the members
 * it needs, in their types, and nothing said about the rest. Kept here as the
 * contract the fields must not break.
 */
function olderPhoneReadsRow(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  const nonnegative = (member: unknown) => typeof member === 'number' && Number.isFinite(member) && member >= 0
  return (
    typeof row.workspaceId === 'string' &&
    typeof row.agentId === 'string' &&
    typeof row.title === 'string' &&
    typeof row.phase === 'string' &&
    nonnegative(row.createdAt) &&
    nonnegative(row.updatedAt) &&
    nonnegative(row.lastSeq)
  )
}

test('an older phone reads every row of the new list as it read the old one', async () => {
  const f = await listFixture({
    machineOf: () => ({ id: 'local', kind: 'desktop', label: 'build-box', color: 'orange' }),
    pullRequestsOf: async () => new Map([['workspace:agent', conversationPullRequestsOf([pullRequest(1)])]]),
  })
  try {
    const listed = await f.host.list()
    // Over the wire, as JSON: what the phone actually receives.
    const wire = JSON.parse(JSON.stringify({ type: 'sessions', requestId: 'list', sessions: listed })) as {
      sessions: unknown[]
    }
    assert.equal(wire.sessions.length, 2)
    for (const row of wire.sessions) assert.ok(olderPhoneReadsRow(row))
  } finally {
    await f.cleanup()
  }
})

function call(port: number, path: string, options: { method?: string; token?: string; body?: unknown } = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        agent: false,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          }),
        )
      },
    )
    request.on('error', reject)
    if (payload) request.write(payload)
    request.end()
  })
}

async function identityRead(machine: (() => { kind: string; color: string } | null) | undefined) {
  const devicesDir = mkdtempSync(join(tmpdir(), 'conversation-machine-devices-'))
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => devicesDir })
  const conversations = {
    list: async () => [],
    resolveKey: () => null,
    subscribe: () => ({ dispose() {}, ready: Promise.resolve() }),
    loadEarlier: async () => ({ ok: false as const, message: 'none' }),
    getToolDetail: async () => ({ ok: false as const, message: 'none' }),
    getTurnDiff: async () => ({ ok: false as const, message: 'none' }),
    command: async () => ({ ok: false, message: 'none' }),
    ...(machine ? { machine } : {}),
  } as unknown as Parameters<typeof createTailnetGatewayServer>[0]['conversations']
  const server = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [],
    isMutation: () => false,
    devices,
    conversations,
    peers: createTailnetPeerResolver({ runWhois: async () => null }),
  })
  await server.start()
  try {
    const port = server.address()!.port
    const offer = devices.offerPairing({ scopes: ['conversation:read'] })
    const paired = await call(port, TAILNET_PAIR_PATH, {
      method: 'POST',
      body: { pairingToken: offer.token, deviceName: 'android-phone' },
    })
    assert.equal(paired.status, 200)
    const identity = await call(port, TAILNET_IDENTITY_PATH, { token: paired.body.deviceToken as string })
    assert.equal(identity.status, 200)
    return identity.body
  } finally {
    await server.stop()
    rmSync(devicesDir, { recursive: true, force: true })
  }
}

test('the identity read names this desktop’s kind and colour beside what it always said', async () => {
  const identity = await identityRead(() => ({ kind: 'tower', color: 'violet' }))
  assert.deepEqual(identity.machine, { kind: 'tower', color: 'violet' })
  // An older phone reads the members it always read, unchanged.
  assert.equal(typeof identity.deviceId, 'string')
  assert.equal(identity.deviceName, 'android-phone')
  assert.ok(Array.isArray(identity.capabilities))
})

test('a desktop that cannot say what it is leaves `machine` out rather than sending a guess', async () => {
  assert.equal('machine' in (await identityRead(undefined)), false)
  assert.equal(
    'machine' in
      (await identityRead(() => {
        throw new Error('settings unavailable')
      })),
    false,
  )
})
