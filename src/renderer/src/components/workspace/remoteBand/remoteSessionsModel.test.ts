import assert from 'node:assert/strict'

import {
  meshConversationPresence,
  meshConversationSessionId,
  type MeshBrowse,
  type MeshConnection,
  type MeshConversation,
  type MeshMachineReachability,
} from '../../../../../shared/tailnet-mesh'
import type { Workspace } from '../../../types/workspace'
import {
  attachedConversations,
  attachedWorkspaceFor,
  buildRemoteBand,
  conversationsOf,
  openSpecOfConversation,
  remoteConversationTitle,
  remoteOriginChatWorkspaceId,
  remoteLinkStateOf,
  branchPullRequestsOfWire,
  remoteFinishUnseen,
  remotePaneTabLabel,
  remoteWorkspaceName,
  shouldBrowse,
  unattachedConversations,
  interleaveChats,
  chatRecencyOf,
  type RemoteConversation,
} from './remoteSessionsModel'
import { test } from 'vitest'

test('remoteSessionsModel', async () => {
  // The rules behind the sidebar's remote rows, DOM-free.

  const air: MeshConnection = {
    id: 'c1',
    machineName: 'sam-macbook-air',
    endpoint: '100.64.0.5:8471',
    deviceId: 'tnd_1',
    deviceName: 'mini',
    scopes: ['workspace:read', 'conversation:read'],
    pairedAt: '2026-09-05T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'request',
  }
  const studio: MeshConnection = { ...air, id: 'c2', machineName: 'studio', endpoint: '100.64.0.9:8471' }

  const chat = (agentId: string, over: Partial<MeshConversation> = {}): MeshConversation => ({
    workspaceId: 'rw1',
    agentId,
    title: agentId,
    phase: 'running',
    updatedAt: 1_000,
    createdAt: 500,
    providerId: 'claude-agent',
    modelId: 'opus',
    turnCount: 1,
    lastSeq: 4,
    ...over,
  })
  const adaSession = meshConversationSessionId('rw1', 'ada')
  const beaSession = meshConversationSessionId('rw1', 'bea')

  const browse = (over: Partial<MeshBrowse>): MeshBrowse => ({
    connectionId: 'c1',
    reachable: true,
    unreachableReason: null,
    unauthorized: false,
    scopes: air.scopes,
    workspaces: [
      {
        id: 'rw1',
        name: 'relay',
        mode: 'standard',
        folderPath: '/Users/air/relay',
        repository: {
          canonicalKey: 'github.com/acme/relay',
          remoteUrl: 'git@github.com:acme/relay.git',
          name: 'relay',
        },
      },
    ],
    gaps: [],
    ...over,
  })

  const workspace = (id: string, extra: Record<string, unknown>): Workspace =>
    ({ id, name: id, mode: 'standard', folderPath: null, ...extra }) as unknown as Workspace

  const meshLayout = (connectionId: string, remoteAgentId: string) => ({
    layout: {
      type: 'tabset',
      children: [
        {
          type: 'tab',
          component: 'mesh-conversation',
          config: {
            connectionId,
            machineName: 'x',
            remoteWorkspaceId: 'rw1',
            remoteAgentId,
            remoteSessionId: meshConversationSessionId('rw1', remoteAgentId),
            title: remoteAgentId,
          },
        },
      ],
    },
  })

  // ── shouldBrowse ─────────────────────────────────────────────────────────
  const reach = (over: Partial<MeshMachineReachability>): MeshMachineReachability => ({
    connectionId: 'c1',
    machineName: 'air',
    checking: false,
    reachable: false,
    unauthorized: false,
    checkedAt: 1,
    lastReachedAt: null,
    detail: null,
    ...over,
  })
  assert.equal(shouldBrowse(undefined), true, 'a machine main has not reported on gets its one read')
  assert.equal(shouldBrowse(reach({ checkedAt: null, checking: true })), true, 'never checked: read rather than wait')
  assert.equal(shouldBrowse(reach({ reachable: true })), true)
  assert.equal(shouldBrowse(reach({ reachable: false })), false, 'asleep is never dialled')
  assert.equal(shouldBrowse(reach({ reachable: true, unauthorized: true })), false, 'revoked is never dialled')

  // ── attachedWorkspaceFor ─────────────────────────────────────────────────
  const stamped = workspace('w1', {
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'air',
      workspaceId: 'rw1',
      workspaceName: 'relay',
      workspaceRoot: null,
      sessionId: adaSession,
    },
  })
  const legacy = workspace('w2', {
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'air',
      workspaceId: 'rw1',
      workspaceName: 'relay',
      workspaceRoot: null,
    },
    layoutModel: meshLayout('c1', 'bea'),
  })
  const local = workspace('w3', { folderPath: '/proj' })
  assert.equal(
    attachedWorkspaceFor([local, legacy, stamped], 'c1', adaSession)?.id,
    'w1',
    'matched by the stamped session id',
  )
  assert.equal(
    attachedWorkspaceFor([local, legacy, stamped], 'c1', beaSession)?.id,
    'w2',
    'a row born before the stamp is matched by its pane',
  )
  assert.equal(
    attachedWorkspaceFor([local, legacy, stamped], 'c2', adaSession),
    null,
    'the same session id on another machine is not a match',
  )
  // A persisted remote terminal tab is a stale tab, not a remote pane: nothing
  // matches a session through it.
  const staleTab = workspace('w4', {
    layoutModel: {
      layout: {
        type: 'tabset',
        children: [
          {
            type: 'tab',
            component: 'mesh-terminal',
            config: { connectionId: 'c1', machineName: 'x', remoteSessionId: 's-old' },
          },
        ],
      },
    },
  })
  assert.equal(attachedWorkspaceFor([staleTab], 'c1', 's-old'), null, 'a stale mesh-terminal tab is ignored')

  // ── buildRemoteBand ──────────────────────────────────────────────────────
  const reachability = new Map<string, MeshMachineReachability>([['c1', reach({ reachable: true })]])

  const answered = {
    browse: browse({}),
    loading: false,
    error: null,
    at: 1,
    conversations: [
      // A chat of its own over there, so a workspace of its own.
      chat('bea', {
        workspaceId: 'rw2',
        title: 'Bea',
        chatTitle: 'Ship the docs',
        phase: 'completed',
        updatedAt: 2_000,
      }),
      chat('ada', {
        title: 'Ada',
        chatTitle: 'Fix the relay',
        phase: 'running',
        updatedAt: 1_000,
        lastUserMessageAt: 3_000,
      }),
    ],
  }
  const band = buildRemoteBand({
    connections: [studio, air],
    browses: new Map([['c1', answered]]),
    reachability,
    workspaces: [local, stamped],
  })
  assert.deepEqual(
    band.map((group) => group.machineName),
    ['sam-macbook-air', 'studio'],
    'machines in name order',
  )
  const airGroup = band[0]!
  assert.deepEqual(
    airGroup.rows.map((row) => row.sessionId),
    [adaSession, meshConversationSessionId('rw2', 'bea')],
    'chats, the one last written to first',
  )
  const ada = airGroup.rows[0]!
  assert.equal(ada.title, 'Ada')
  assert.equal(ada.remoteAgentId, 'ada')
  assert.equal(ada.workspaceId, 'rw1')
  assert.equal(ada.activity, 'working')
  assert.equal(ada.since, 1_000, 'how long it has been working rides the row')
  assert.equal(airGroup.rows[1]!.activity, 'idle')
  assert.equal(ada.chatTitle, 'Fix the relay', "the chat's own title, as its machine's sidebar shows it")
  assert.equal(ada.workspaceName, 'Fix the relay', "which is its workspace's name over there")
  assert.equal(ada.workspaceRoot, '/Users/air/relay', "the folder comes from the browse's workspace list")
  assert.equal(ada.repository?.name, 'relay')
  assert.equal(ada.attachedWorkspaceId, 'w1', 'the stamped workspace is this row')
  assert.deepEqual(airGroup.parked, [], 'a remote-born row whose session is listed is not parked as well')
  assert.equal(airGroup.stale, false)
  assert.equal(airGroup.phase?.phase, 'reachable')

  const studioGroup = band[1]!
  assert.deepEqual(studioGroup.rows, [], 'a machine not yet read has no rows')
  assert.equal(studioGroup.phase?.phase, 'paired', 'and no check yet: paired is all that is known')

  // A machine that went quiet keeps its rows, dimmed, and a remote-born row
  // whose session it no longer lists is parked under it.
  const quiet = buildRemoteBand({
    connections: [air],
    browses: new Map([
      [
        'c1',
        {
          browse: browse({}),
          loading: false,
          error: 'Not answering.',
          at: 2,
          conversations: [chat('zed', { title: 'Zed' })],
        },
      ],
    ]),
    reachability: new Map([['c1', reach({ reachable: false, detail: 'timed out' })]]),
    workspaces: [stamped],
  })
  assert.equal(quiet[0]!.stale, true, 'rows from an earlier read on a machine that is not answering are stale')
  assert.deepEqual(
    quiet[0]!.rows.map((row) => row.title),
    ['Zed'],
  )
  assert.deepEqual(
    quiet[0]!.parked.map((entry) => entry.id),
    ['w1'],
    'the row born there stays, parked',
  )
  assert.equal(quiet[0]!.phase?.phase, 'unreachable')
  // No notices (owner ruling 2026-09-05): a scope gap or a revocation is not a
  // sidebar sentence. The band lists conversations and nothing else.
  const gapped = buildRemoteBand({
    connections: [air],
    browses: new Map([
      [
        'c1',
        {
          browse: browse({
            gaps: [
              {
                part: 'workspaces',
                code: 'scope_required',
                message: "This pairing may not see that machine's workspaces.",
              },
            ],
          }),
          loading: false,
          error: null,
          at: 3,
        },
      ],
    ]),
    reachability,
    workspaces: [],
  })
  assert.deepEqual(gapped[0]!.rows, [])
  assert.equal(gapped[0]!.stale, false)
  assert.ok(!('notice' in gapped[0]!), 'the band carries no sentence for a machine with nothing to open')

  // Rows born on a machine no longer paired keep a home, with nothing to ask.
  const orphaned = buildRemoteBand({
    connections: [],
    browses: new Map(),
    reachability: new Map(),
    workspaces: [stamped, local],
  })
  assert.equal(orphaned.length, 1)
  assert.equal(orphaned[0]!.connectionId, null)
  assert.equal(orphaned[0]!.machineName, 'air')
  assert.equal(orphaned[0]!.phase, null)
  assert.deepEqual(
    orphaned[0]!.parked.map((entry) => entry.id),
    ['w1'],
  )

  // ── conversationsOf ──────────────────────────────────────────────────────
  // A row is a CONVERSATION (owner, 2026-09-11): each chat is one row titled
  // with its own name, carrying a line per agent in it. A chat over there is
  // its workspace, so two workspaces are two rows.
  const chats = conversationsOf(airGroup)
  assert.deepEqual(
    chats.map((entry) => entry.title),
    ['Fix the relay', 'Ship the docs'],
    'one row per chat, titled with the chat, the one last written to first',
  )
  const relay = chats[0]!
  assert.deepEqual(
    relay.agents.map((row) => row.sessionId),
    [adaSession],
    'a conversation carries its own agent',
  )
  assert.equal(relay.activity, 'working')
  assert.equal(relay.workspaceId, 'rw1')
  assert.equal(relay.workspaceRoot, '/Users/air/relay', 'and carries the folder it files under')
  assert.equal(relay.repository?.canonicalKey, 'github.com/acme/relay')
  assert.equal(relay.attachedWorkspaceId, 'w1')
  assert.notEqual(chats[0]!.key, chats[1]!.key, 'each chat is keyed on its own workspace')

  // Two agents in one chat are one row with two lines, as that machine's own
  // sidebar draws them. A window here following one of them is the chat's
  // window: the other agent is not a second copy of the chat beside it.
  {
    const twoAgents = buildRemoteBand({
      connections: [air],
      browses: new Map([
        [
          'c1',
          {
            ...answered,
            conversations: [
              chat('cal', { title: 'Cal', chatTitle: 'Fix the relay', phase: 'running', lastUserMessageAt: 5_000 }),
              chat('ada', { title: 'Ada', chatTitle: 'Fix the relay', phase: 'completed', lastUserMessageAt: 3_000 }),
            ],
          },
        ],
      ]),
      reachability,
      workspaces: [local, stamped],
    })
    const [one, ...more] = conversationsOf(twoAgents[0]!)
    assert.equal(more.length, 0, 'one chat, one row')
    assert.equal(one!.title, 'Fix the relay')
    assert.deepEqual(
      one!.agents.map((agent) => agent.title),
      ['Ada', 'Cal'],
      'a line per agent, the one w1 follows first',
    )
    assert.equal(one!.attachedWorkspaceId, 'w1', 'the chat is the window one of its agents is open in')
    assert.equal(openSpecOfConversation(one!).attachedWorkspaceId, 'w1', 'so opening it focuses that window')
    assert.equal(one!.activity, 'working', 'its marks say what any agent in it is doing')
    assert.equal(one!.recencyAt, 5_000, 'and it sits by the agent last written to')
    assert.deepEqual(unattachedConversations(twoAgents, true, [local, stamped]), [], 'no second row beside w1')
    assert.deepEqual(
      attachedConversations(twoAgents, [local, stamped])
        .get('w1')!
        .agents.map((agent) => agent.title),
      ['Ada', 'Cal'],
      'w1 draws both agents’ lines instead',
    )
    assert.equal(
      chatRecencyOf(attachedConversations(twoAgents, [local, stamped]))({ ...stamped, createdAt: 0 }),
      5_000,
      'the window here sorts by it too',
    )
  }

  // ── unattachedConversations ──────────────────────────────────────────────
  // A chat a window here is already showing is NOT a row of its own: that window
  // is already a row of its project, and listing both is the same chat twice.
  assert.deepEqual(
    unattachedConversations(band, true, [local, stamped]).map((entry) => entry.title),
    ['Ship the docs'],
    'Ada is attached to w1, so it gets no second row',
  )
  assert.deepEqual(
    unattachedConversations(band, true, [local]).map((entry) => entry.title),
    ['Fix the relay', 'Ship the docs'],
    'with no window holding it, the conversation is a row',
  )
  assert.deepEqual(
    unattachedConversations(band, false, [local]),
    [],
    'off the tailnet, nothing read from over there is drawn',
  )

  // ── attachedConversations ────────────────────────────────────────────────
  // The complement: the conversation each OPEN remote row is, so that row can
  // draw its agent's line from what the browse read.
  const openHere = attachedConversations(band, [local, stamped])
  assert.deepEqual([...openHere.keys()], ['w1'], 'the conversation w1 holds is keyed by w1')
  assert.deepEqual(
    openHere.get('w1')!.agents.map((agent) => agent.title),
    ['Ada'],
  )
  assert.equal(attachedConversations([], [local, stamped]).size, 0)
  // A LOCAL chat that happens to hold a pane onto the other machine is not a
  // remote conversation: it is a local chat with a visitor in it, and its own
  // agents' lines are not the other machine's to replace.
  const visiting = workspace('w9', { folderPath: '/proj', layoutModel: meshLayout('c1', 'ada') })
  const visitedBand = buildRemoteBand({
    connections: [air],
    browses: new Map([['c1', answered]]),
    reachability,
    workspaces: [visiting],
  })
  assert.equal(
    visitedBand.flatMap((group) => conversationsOf(group)).some((entry) => entry.attachedWorkspaceId === 'w9'),
    true,
    'the band still recognises the window showing that session',
  )
  assert.equal(
    attachedConversations(visitedBand, [visiting]).size,
    0,
    '…but it is not handed the lines, because it is not a remote-born row',
  )

  // ── remoteLinkStateOf ────────────────────────────────────────────────────
  // Three answers, not two: "we have not been told" must never read as
  // "disconnected", or a host without the tailnet bridge empties the sidebar.
  assert.equal(remoteLinkStateOf(null), 'unknown')
  assert.equal(remoteLinkStateOf(undefined), 'unknown')
  assert.equal(remoteLinkStateOf({ tailnetAddress: null }), 'down', 'Tailscale is not up on this machine')
  assert.equal(remoteLinkStateOf({ tailnetAddress: '100.64.0.5' }), 'up')

  // ── remotePaneTabLabel ───────────────────────────────────────────────────
  // A remote pane's tab is its agent's name; the machine mark says where it
  // runs (owner, 2026-10-08). A tab saved under the old rule drops the machine.
  assert.equal(remotePaneTabLabel('Aidan Darcy', 'mac-mini.tail1234.ts.net'), 'Aidan Darcy')
  assert.equal(remotePaneTabLabel('Aidan Darcy · mac-mini.tail1234.ts.net', 'mac-mini.tail1234.ts.net'), 'Aidan Darcy')
  assert.equal(
    remotePaneTabLabel('Aidan Darcy · studio', 'mac-mini'),
    'Aidan Darcy · studio',
    'another machine’s name is kept',
  )
  assert.equal(remotePaneTabLabel(' · mac-mini', 'mac-mini'), ' · mac-mini', 'never down to nothing')
  assert.equal(remotePaneTabLabel('Aidan Darcy · mac-mini', undefined), 'Aidan Darcy · mac-mini')

  // ── remoteWorkspaceName / remoteConversationTitle ────────────────────────
  // The CHAT's name, never the agent's (owner, 2026-09-13).
  assert.equal(remoteWorkspaceName('Tara Boyle', 'sprintengine'), 'sprintengine')
  assert.equal(
    remoteWorkspaceName('Tara Boyle', '  '),
    'Tara Boyle',
    'a remote with no name to give falls back to the agent',
  )
  assert.equal(remoteWorkspaceName('Tara Boyle', null), 'Tara Boyle')

  const titled = (name: string, workspaceName: string | undefined) =>
    remoteConversationTitle({ name, remoteOrigin: workspaceName === undefined ? null : ({ workspaceName } as never) })
  assert.equal(
    titled('Tara Boyle · sprintengine', 'sprintengine'),
    'sprintengine',
    'a row stored under the old rule is rescued',
  )
  assert.equal(titled('sprintengine', 'sprintengine'), 'sprintengine', 'a row already named for its chat is left alone')
  assert.equal(titled('Ship the release', 'sprintengine'), 'Ship the release', 'a name a person chose is theirs')
  const listedAs = (name: string, workspaceName: string, listed: string) =>
    remoteConversationTitle({ name, remoteOrigin: { workspaceName } as never }, listed)
  assert.equal(
    listedAs('New chat', 'New chat', 'Fix the release script'),
    'Fix the release script',
    'a row still named as it was born follows the title its machine gives the chat',
  )
  assert.equal(
    listedAs('Ship the release', 'New chat', 'Fix the release script'),
    'Ship the release',
    'a row renamed here keeps the name',
  )
  assert.equal(
    titled(' · sprintengine', 'sprintengine'),
    ' · sprintengine',
    'no agent in front of it: not the old rule, not rewritten',
  )
  assert.equal(
    titled('Tara Boyle · sprintengine', undefined),
    'Tara Boyle · sprintengine',
    'a local row is never touched',
  )
  assert.equal(titled('Tara Boyle', ''), 'Tara Boyle', 'a remote that never named its chat leaves the name as it is')

  console.log('remote sessions model tests passed')
})

test('chats on a paired machine are rows of their own, with the presence their phase says, and open in the chat view', () => {
  const mini: MeshConnection = {
    id: 'c-mini',
    machineName: 'mac-mini',
    endpoint: 'mac-mini.tail1234.ts.net:8471',
    deviceId: 'tnd_mini',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read', 'conversation:operate'],
    pairedAt: '2026-09-05T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'request',
  }
  const chat = (
    agentId: string,
    phase: MeshConversation['phase'],
    title: string,
    workspaceId = 'rw1',
  ): MeshConversation => ({
    workspaceId,
    agentId,
    title,
    phase,
    updatedAt: 2_000,
    createdAt: 1_000,
    providerId: 'claude-agent',
    modelId: 'opus',
    turnCount: 3,
    lastSeq: 40,
  })
  const entry = {
    browse: null,
    loading: false,
    error: null,
    at: 1,
    conversations: [
      chat('a-running', 'running', 'Profile the importer'),
      chat('a-waiting', 'waiting_for_approval', 'Rename the store', 'rw2'),
      chat('a-done', 'completed', 'Write the changelog', 'rw3'),
    ],
  }
  const opened = {
    id: 'local-1',
    remoteOrigin: {
      connectionId: 'c-other',
      machineName: 'build-box',
      workspaceId: 'rw1',
      workspaceName: '',
      sessionId: 'unrelated',
    },
    layoutModel: {
      layout: {
        type: 'row',
        children: [
          {
            type: 'tab',
            component: 'mesh-conversation',
            config: { connectionId: 'c-mini', remoteSessionId: meshConversationSessionId('rw3', 'a-done') },
          },
        ],
      },
    },
  } as unknown as Workspace
  const [group] = buildRemoteBand({
    connections: [mini],
    browses: new Map([[mini.id, entry]]),
    reachability: new Map(),
    workspaces: [opened],
  })
  assert.deepEqual(
    group.rows.map((row) => [row.title, row.activity, row.status.label]),
    [
      ['Profile the importer', 'working', 'Running'],
      ['Rename the store', 'needs-input', 'Needs approval'],
      ['Write the changelog', 'idle', 'Done'],
    ],
  )
  // A pane already following a chat here is the window a click focuses.
  assert.equal(group.rows[2].attachedWorkspaceId, 'local-1')
  // Each chat is a conversation of its own, titled with its own name.
  const conversations = conversationsOf(group)
  assert.deepEqual(
    conversations.map((conversation) => conversation.title),
    ['Profile the importer', 'Rename the store', 'Write the changelog'],
  )
  assert.deepEqual(openSpecOfConversation(conversations[1]).conversation, { workspaceId: 'rw2', agentId: 'a-waiting' })
  assert.equal(meshConversationPresence('waiting_for_input'), 'needs-input')
  assert.equal(meshConversationPresence('starting'), 'running')
  assert.equal(meshConversationPresence('failed'), 'idle')

  // A listed chat's phase and reply preview ride its row, which words its line.
  {
    const [row] = buildRemoteBand({
      connections: [mini],
      browses: new Map([
        [
          'c-mini',
          {
            ...entry,
            conversations: [
              {
                ...chat('a-asked', 'waiting_for_input', 'Pick a branch'),
                lastAssistantText: 'Which branch?',
                branch: 'agent/pick',
                pullRequests: [
                  { number: 7, state: 'merged', url: 'https://github.com/acme/app/pull/7', title: 'Pick it' },
                ],
              },
            ],
          },
        ],
      ]),
      reachability: new Map(),
      workspaces: [],
    })[0]!.rows
    assert.equal(row!.phase, 'waiting_for_input')
    assert.equal(row!.replyPreview, 'Which branch?')
    assert.equal(row!.branch, 'agent/pick')
    assert.deepEqual(
      row!.pullRequests.map((pr) => [pr.number, pr.state, pr.repoKey, pr.repoName]),
      [[7, 'merged', 'github.com/acme/app', 'app']],
    )
  }

  // A listed pull request is read for its repository off its address, as the
  // local record reads it; an address that names none is left out, and one on
  // another forge says which.
  {
    const read = branchPullRequestsOfWire([
      { number: 1, state: 'open', url: 'https://github.com/acme/app/pull/1', title: 'GitHub' },
      { number: 2, state: 'open', url: 'https://gitlab.com/acme/app/-/merge_requests/2', title: 'GitLab' },
      { number: 3, state: 'open', url: 'https://example.com/not-a-pull-request', title: 'Nothing' },
    ])
    assert.deepEqual(
      read.map((pr) => [pr.number, pr.forge ?? 'github']),
      [
        [1, 'github'],
        [2, 'gitlab'],
      ],
    )
  }

  // The green "finished while you were away" row: a finish after the last
  // visit on any device. A chat with no visit recorded reads as seen, and one
  // still working or waiting has not finished.
  const finish = { activity: 'idle' as const, lastTurnEndedAt: 2_000, lastVisitedAt: 1_000 }
  assert.equal(remoteFinishUnseen(finish), true)
  assert.equal(remoteFinishUnseen({ ...finish, lastVisitedAt: 2_500 }), false, 'seen since')
  assert.equal(remoteFinishUnseen({ ...finish, lastVisitedAt: null }), false, 'no visit recorded reads as seen')
  assert.equal(remoteFinishUnseen({ ...finish, lastTurnEndedAt: null }), false, 'never finished a turn')
  assert.equal(remoteFinishUnseen({ ...finish, activity: 'working' }), false)
  assert.equal(remoteFinishUnseen({ ...finish, activity: 'needs-input' }), false)
})

test('interleaveChats: a paired machine’s chats sit among the local ones by when each was last written to', () => {
  const local = (id: string, lastUserMessageAt: number) =>
    ({ id, createdAt: 0, lastUserMessageAt }) as unknown as Workspace
  const remote = (key: string, recencyAt: number) => ({ key, recencyAt }) as unknown as RemoteConversation
  const order = (entries: ReturnType<typeof interleaveChats>) =>
    entries.map((entry) => (entry.kind === 'local' ? entry.workspace.id : entry.conversation.key))

  assert.deepEqual(
    order(interleaveChats([local('hour', 9_000), local('days', 1_000)], [remote('now', 10_000), remote('mid', 5_000)])),
    ['now', 'hour', 'mid', 'days'],
    'a remote chat written to just now leads a local one two days quiet',
  )
  assert.deepEqual(
    order(interleaveChats([local('a', 5_000)], [remote('b', 9_000), remote('c', 10_000)])),
    ['b', 'c', 'a'],
    'the machine’s own order is kept, not re-sorted here',
  )
  assert.deepEqual(order(interleaveChats([local('a', 5_000)], [remote('b', 5_000)])), ['a', 'b'], 'a tie goes local')

  // A chat opened here from a paired machine, then written to on that machine:
  // its own clock here never heard, but the machine's did.
  const opened = local('opened', 1_000)
  const attached = new Map([['opened', { agents: [{ lastUserMessageAt: 20_000 }] } as unknown as RemoteConversation]])
  assert.deepEqual(
    order(interleaveChats([local('hour', 9_000), opened], [remote('now', 10_000)], chatRecencyOf(attached))),
    ['opened', 'now', 'hour'],
    'an opened remote chat is as recent as its machine says it was written to',
  )
})

test('a remote-born row names its chat by the session it was stamped with', () => {
  assert.equal(
    remoteOriginChatWorkspaceId({ workspaceId: 'seat', sessionId: 'conversation:new-chat:agent-9' }),
    'new-chat',
  )
  assert.equal(remoteOriginChatWorkspaceId({ workspaceId: 'ws:1', sessionId: 'conversation:ws:1:agent-9' }), 'ws:1')
  assert.equal(remoteOriginChatWorkspaceId({ workspaceId: 'seat' }), 'seat', 'a row born before the stamp')
})
