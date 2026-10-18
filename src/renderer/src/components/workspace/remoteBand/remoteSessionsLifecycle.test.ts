import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { MeshBrowse, MeshConnection, MeshConversation } from '../../../../../shared/tailnet-mesh'
import type { Workspace } from '../../../types/workspace'
import {
  buildRemoteBand,
  conversationsOf,
  followedRemoteRestsToKeep,
  readFollowedRemoteRests,
  remoteLifecycleWritable,
  remoteRestToFollow,
  remoteRowRecency,
  chatRecencyOf,
  interleaveChats,
  unattachedConversations,
  type RemoteBrowseEntry,
} from './remoteSessionsModel'

// The remote rows as a machine that owns its chats' rest and read state
// lists them (`conversation-lifecycle`): titled with the chat, in the order
// the person last wrote to each, with the resting ones left out.

const connection = (id: string, machineName: string): MeshConnection => ({
  id,
  machineName,
  endpoint: '100.64.0.5:8471',
  deviceId: `device-${id}`,
  deviceName: 'dev-macbook-air',
  scopes: ['workspace:read', 'conversation:operate'],
  pairedAt: '2026-10-01T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'request',
})

const chat = (workspaceId: string, over: Partial<MeshConversation> = {}): MeshConversation => ({
  workspaceId,
  agentId: 'agent-1',
  title: 'Gael Corry',
  phase: 'completed',
  updatedAt: 1_000,
  createdAt: 500,
  providerId: 'claude-agent',
  modelId: 'opus',
  turnCount: 1,
  lastSeq: 4,
  ...over,
})

const browse = (workspaces: MeshBrowse['workspaces'] = []): MeshBrowse => ({
  connectionId: 'c1',
  reachable: true,
  unreachableReason: null,
  unauthorized: false,
  scopes: ['workspace:read', 'conversation:operate'],
  workspaces,
  gaps: [],
})

const remoteWorkspace = (id: string, name: string, settledAt: number | null = null) => ({
  id,
  name,
  mode: 'standard',
  folderPath: '/Users/dev/app',
  repository: null,
  settledAt,
})

function band(entries: Array<[MeshConnection, Partial<RemoteBrowseEntry> & { conversations: MeshConversation[] }]>) {
  return buildRemoteBand({
    connections: entries.map(([machine]) => machine),
    browses: new Map(
      entries.map(([machine, entry]) => [
        machine.id,
        { browse: browse(), loading: false, error: null, at: 1, lifecycle: true, access: 'operate' as const, ...entry },
      ]),
    ),
    reachability: new Map(),
    workspaces: [],
  })
}

const mini = connection('c1', 'mac-mini')
const box = connection('c2', 'build-box')

test('a machine that keeps its chats’ rest is drawn in the order it listed them, its sidebar’s', () => {
  // Its key for a chat never written to is its creation there, not when it
  // last moved: re-sorted here by `updatedAt`, 'never-written' would jump
  // above 'written' though that machine's own sidebar draws it below.
  const [group] = band([
    [
      mini,
      {
        conversations: [
          chat('working', { phase: 'running', updatedAt: 9_000, lastUserMessageAt: 3_000 }),
          chat('written', { phase: 'completed', updatedAt: 50, lastUserMessageAt: 2_000 }),
          chat('never-written', { phase: 'completed', updatedAt: 8_000 }),
        ],
      },
    ],
  ])
  assert.deepEqual(
    group!.rows.map((row) => row.workspaceId),
    ['working', 'written', 'never-written'],
  )
})

test('a machine from before that is ordered here by when the person last wrote, never by what the agent is doing', () => {
  const [group] = band([
    [
      mini,
      {
        lifecycle: false,
        conversations: [
          chat('working', { phase: 'running', updatedAt: 9_000, lastUserMessageAt: 100 }),
          chat('waiting', { phase: 'waiting_for_approval', updatedAt: 8_000, lastUserMessageAt: 200 }),
          chat('quiet', { phase: 'completed', updatedAt: 50, lastUserMessageAt: 3_000 }),
          // A machine that names no message clock is ordered by `updatedAt`.
          chat('older-build', { phase: 'completed', updatedAt: 1_500 }),
        ],
      },
    ],
  ])
  assert.deepEqual(
    group!.rows.map((row) => row.workspaceId),
    ['quiet', 'older-build', 'waiting', 'working'],
  )
})

test('across machines the rows interleave by the same clock, each machine’s in its own order', () => {
  const groups = band([
    [
      mini,
      {
        conversations: [
          chat('mini-new', { lastUserMessageAt: 900 }),
          // Listed below 'mini-new' by its machine, whatever its clock here says.
          chat('mini-unwritten', { updatedAt: 950 }),
          chat('mini-old', { lastUserMessageAt: 100 }),
        ],
      },
    ],
    [box, { conversations: [chat('box-mid', { lastUserMessageAt: 500 })] }],
  ])
  assert.deepEqual(
    unattachedConversations(groups, true, []).map((conversation) => conversation.workspaceId),
    ['mini-new', 'mini-unwritten', 'box-mid', 'mini-old'],
  )
})

test("a row is titled with the chat, then the browse's name for it, then its agent", () => {
  const [group] = band([
    [
      mini,
      {
        browse: browse([remoteWorkspace('named-by-browse', 'Ship the docs')]),
        conversations: [
          chat('named', { chatTitle: 'Fix the login', lastUserMessageAt: 4 }),
          chat('named-by-browse', { lastUserMessageAt: 3 }),
          chat('agent-only', { lastUserMessageAt: 2 }),
          chat('untitled', { title: '', lastUserMessageAt: 1 }),
        ],
      },
    ],
  ])
  assert.deepEqual(
    conversationsOf(group!).map((conversation) => conversation.title),
    ['Fix the login', 'Ship the docs', 'Gael Corry', 'Conversation'],
  )
  // The agent's name stays its line's name.
  assert.equal(group!.rows[0]!.title, 'Gael Corry')
})

test('a chat whose workspace the browse says is settled has no row', () => {
  const [group] = band([
    [
      mini,
      {
        browse: browse([remoteWorkspace('resting', 'Done', 1_234), remoteWorkspace('open', 'Going')]),
        conversations: [chat('resting'), chat('open')],
      },
    ],
  ])
  assert.deepEqual(
    group!.rows.map((row) => row.workspaceId),
    ['open'],
  )
})

test('a row carries its clocks and whether its machine keeps its rest', () => {
  const [kept] = band([
    [mini, { conversations: [chat('a', { lastTurnEndedAt: 700, lastVisitedAt: 650, lastUserMessageAt: 600 })] }],
  ])
  const row = kept!.rows[0]!
  assert.equal(row.lifecycle, true)
  assert.equal(row.lastTurnEndedAt, 700)
  assert.equal(row.lastVisitedAt, 650)
  assert.equal(row.recencyAt, 600)
  const [older] = band([[mini, { lifecycle: false, conversations: [chat('a')] }]])
  assert.equal(older!.rows[0]!.lifecycle, false)
  assert.equal(older!.rows[0]!.lastTurnEndedAt, null)
})

test('a pairing that may only follow a machine’s chats offers no Settle and says no visit there', () => {
  const [readOnly] = band([[mini, { access: 'read', conversations: [chat('a')] }]])
  assert.equal(readOnly!.rows[0]!.lifecycle, false, 'the machine would refuse every one')
  assert.equal(remoteLifecycleWritable({ browse: null, loading: false, error: null, at: 1, lifecycle: true }), false)
  assert.equal(
    remoteLifecycleWritable({ browse: null, loading: false, error: null, at: 1, lifecycle: true, access: 'operate' }),
    true,
  )
})

// A row here opened from a paired machine's chat, by the remote workspace it follows.
const opened = (id: string, connectionId: string, remoteWorkspaceId: string): Workspace =>
  ({
    id,
    name: id,
    folderPath: null,
    remoteOrigin: {
      connectionId,
      machineName: 'mac-mini',
      workspaceId: remoteWorkspaceId,
      workspaceName: remoteWorkspaceId,
      workspaceRoot: null,
    },
  }) as unknown as Workspace

const entry = (workspaces: MeshBrowse['workspaces'], lifecycle = true): RemoteBrowseEntry => ({
  browse: browse(workspaces),
  loading: false,
  error: null,
  at: 1,
  lifecycle,
})

test('a row opened from a chat its machine has settled follows that settle', () => {
  const due = remoteRestToFollow({
    workspaces: [opened('here-1', 'c1', 'resting'), opened('here-2', 'c1', 'open'), { id: 'local' } as Workspace],
    browses: new Map([['c1', entry([remoteWorkspace('resting', 'Done', 4_000), remoteWorkspace('open', 'Going')])]]),
    followed: new Map(),
  })
  assert.deepEqual(due, [{ workspaceId: 'here-1', settledAt: 4_000, settled: true }])
})

test('a row started from New chat follows its own chat, not the project chat it was started from', () => {
  // Stored before the fix: `workspaceId` named the project's seat over there
  // (an old chat, resting), and only the session id named the chat started.
  const started = {
    ...opened('here-1', 'c1', 'seat'),
    remoteOrigin: { ...opened('here-1', 'c1', 'seat').remoteOrigin!, sessionId: 'conversation:new-chat:agent-9' },
  } as Workspace
  const browses = new Map([
    ['c1', entry([remoteWorkspace('seat', 'Old chat', 4_000), remoteWorkspace('new-chat', 'New chat')])],
  ])
  assert.deepEqual(remoteRestToFollow({ workspaces: [started], browses, followed: new Map() }), [])
  // One already hidden by the seat's settle comes back: its own chat is not resting.
  assert.deepEqual(remoteRestToFollow({ workspaces: [started], browses, followed: new Map([['here-1', 4_000]]) }), [
    { workspaceId: 'here-1', settledAt: 4_000, settled: false },
  ])
})

test('a settle already followed is not followed again, so a row brought back here stays', () => {
  const input = {
    workspaces: [opened('here-1', 'c1', 'resting')],
    browses: new Map([['c1', entry([remoteWorkspace('resting', 'Done', 4_000)])]]),
  }
  assert.deepEqual(remoteRestToFollow({ ...input, followed: new Map([['here-1', 4_000]]) }), [])
  // Settled over there again, later: followed again.
  assert.deepEqual(remoteRestToFollow({ ...input, followed: new Map([['here-1', 3_000]]) }), [
    { workspaceId: 'here-1', settledAt: 4_000, settled: true },
  ])
})

test('a machine that does not keep its chats’ rest is not followed', () => {
  assert.deepEqual(
    remoteRestToFollow({
      workspaces: [opened('here-1', 'c1', 'resting')],
      browses: new Map([['c1', entry([remoteWorkspace('resting', 'Done', 4_000)], false)]]),
      followed: new Map(),
    }),
    [],
  )
})

test('a settle followed before a restart is not followed again after it, so a row brought back stays', () => {
  const workspaces = [opened('here-1', 'c1', 'resting'), { id: 'local' } as Workspace]
  const browses = new Map([['c1', entry([remoteWorkspace('resting', 'Done', 4_000)])]])
  const followed = new Map<string, number>()
  for (const { workspaceId, settledAt } of remoteRestToFollow({ workspaces, browses, followed }))
    followed.set(workspaceId, settledAt)
  const kept = followedRemoteRestsToKeep(followed, workspaces)

  // The person brought the row back; the app restarts and reads what it kept.
  const afterRestart = readFollowedRemoteRests(kept)
  assert.deepEqual(remoteRestToFollow({ workspaces, browses, followed: afterRestart }), [])
  // Settled over there again, later: followed again.
  const settledAgain = new Map([['c1', entry([remoteWorkspace('resting', 'Done', 9_000)])]])
  assert.deepEqual(remoteRestToFollow({ workspaces, browses: settledAgain, followed: afterRestart }), [
    { workspaceId: 'here-1', settledAt: 9_000, settled: true },
  ])
})

test('a row resting because it followed its machine comes back when that machine brings the chat back', () => {
  const workspaces = [opened('here-1', 'c1', 'chat'), opened('here-2', 'c1', 'other')]
  const back = new Map([['c1', entry([remoteWorkspace('chat', 'Done'), remoteWorkspace('other', 'Going')])]])
  assert.deepEqual(remoteRestToFollow({ workspaces, browses: back, followed: new Map([['here-1', 4_000]]) }), [
    { workspaceId: 'here-1', settledAt: 4_000, settled: false },
  ])
  // A machine that has not answered yet, or no longer lists the chat, says nothing about it.
  const silent = new Map([['c1', entry([remoteWorkspace('other', 'Going')])]])
  assert.deepEqual(remoteRestToFollow({ workspaces, browses: silent, followed: new Map([['here-1', 4_000]]) }), [])
})

test('what is kept names only rows still here, and anything unreadable reads as nothing followed', () => {
  const followed = new Map([
    ['here-1', 4_000],
    ['closed', 3_000],
  ])
  assert.equal(followedRemoteRestsToKeep(followed, [opened('here-1', 'c1', 'resting')]), '{"here-1":4000}')
  assert.deepEqual([...readFollowedRemoteRests('not json')], [])
  assert.deepEqual([...readFollowedRemoteRests('[4000]')], [])
  assert.deepEqual([...readFollowedRemoteRests(null)], [])
  assert.deepEqual([...readFollowedRemoteRests('{"a":1,"b":"x"}')], [['a', 1]])
})

test('a row sits where its machine’s own sidebar sits it, by the key that machine sends', () => {
  const [group] = band([
    [
      mini,
      {
        conversations: [
          // Written to long ago; busy since. Never written to, made later.
          chat('written', { updatedAt: 99_000, lastUserMessageAt: 1_000, recencyAt: 1_000 }),
          chat('made', { updatedAt: 10, recencyAt: 3_000 }),
        ],
      },
    ],
  ])
  assert.deepEqual(
    group!.rows.map((row) => [row.workspaceId, row.recencyAt]),
    [
      ['written', 1_000],
      ['made', 3_000],
    ],
    'its key, not `updatedAt`, which an agent working moves',
  )
})

test('opening a paired machine’s chat here does not move it: it keeps its machine’s place', () => {
  const [group] = band([[mini, { conversations: [chat('remote-1', { updatedAt: 2_000, recencyAt: 1_000 })] }]])
  // Opened just now: made here at the click, never written to from here.
  const openedNow = { ...opened('here-1', 'c1', 'remote-1'), createdAt: 50_000 } as Workspace
  const listed = conversationsOf(group!).map((conversation) => ({ ...conversation, attachedWorkspaceId: 'here-1' }))
  const recency = chatRecencyOf(new Map([['here-1', listed[0]!]]))
  assert.equal(recency(openedNow), 1_000, 'not 50 000, the moment it was opened')
  const local = { id: 'local', name: 'local', createdAt: 1, lastUserMessageAt: 1_500 } as unknown as Workspace
  assert.deepEqual(
    interleaveChats([openedNow, local], [], recency).map((row) => (row.kind === 'local' ? row.workspace.id : '')),
    ['local', 'here-1'],
    'so a local chat written to since stays above it',
  )
  // Written to here afterwards: that counts, as on a local chat.
  assert.equal(recency({ ...openedNow, lastUserMessageAt: 60_000 } as Workspace), 60_000)
  // Its machine has said nothing yet: the creation here stands in.
  assert.equal(chatRecencyOf(new Map())(openedNow), 50_000)
})

test('a row opened from a paired machine draws that machine’s clocks', () => {
  const [group] = band([
    [
      mini,
      {
        conversations: [
          chat('remote-1', { phase: 'completed', updatedAt: 9_000, lastTurnEndedAt: 4_000, lastUserMessageAt: 3_000 }),
        ],
      },
    ],
  ])
  const [conversation] = conversationsOf(group!)
  assert.deepEqual(remoteRowRecency(undefined, conversation!), {
    hasRunning: false,
    idleSince: 4_000,
    lastInputAt: 3_000,
    workingSince: null,
  })
  const here = { hasRunning: false, idleSince: 6_000, lastInputAt: 5_500, workingSince: null }
  assert.deepEqual(remoteRowRecency(here, conversation!), here, 'the later clock of the two')

  const [busy] = band([
    [mini, { conversations: [chat('remote-2', { phase: 'running', updatedAt: 9_000, turnStartedAt: 7_000 })] }],
  ])
  const [working] = conversationsOf(busy!)
  assert.deepEqual(remoteRowRecency(undefined, working!), {
    hasRunning: true,
    idleSince: null,
    lastInputAt: null,
    workingSince: 7_000,
  })
})
