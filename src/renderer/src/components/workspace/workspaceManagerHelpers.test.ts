import assert from 'node:assert/strict'
import type { AgentState, SessionActivity, TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import type { Workspace } from '../../types/workspace'
import {
  buildSidebarWorkspaceOrder,
  compareSessionItemsByAttention,
  deriveSessionStatus,
  getSessionItems,
  groupSessionItems,
  newChatProjectOptionsOf,
  sessionsAttentionTone,
} from './workspaceManagerHelpers'
import type { SessionItem } from './WorkspaceActions'
import { test } from 'vitest'

test('workspaceManagerHelpers', async () => {
  void main()

  function main(): void {
    assertHookPhaseDrivesStatus()
    assertOutputRecencyFallback()
    assertFailedRetentionAndPrecedence()

    assertLastActivityIsMaxOfOutputAndInput()
    assertAttentionFirstOrdering()
    assertAttentionToneNeverLies()
    assertConversationSessionsSurfaceInSessionItems()
    assertAgentlessPtySessionsSurfaceWithHumanLabel()
    assertWorkspacelessSessionsStillSurface()
    assertClosedChatSessionsNeverJoinANamesake()
    assertDetachedBucketsTrailRealWorkspaces()
    assertSidebarOrderGroupsWorktreesUnderTheirProject()
    console.log('workspaceManagerHelpers.test.ts: all assertions passed')
  }

  // This dropdown claims to mirror the sidebar, so it groups by the project a
  // workspace files under. A worktree chat belongs inside its parent's group,
  // whether the parent is recorded on the marker or only derivable from the
  // container path — its own folder would open a group named after the slug.
  function assertSidebarOrderGroupsWorktreesUnderTheirProject(): void {
    const ws = (id: string, folderPath: string, repoRoot?: string): Workspace =>
      ({
        id,
        name: id,
        folderPath,
        worktree: folderPath.includes('.sprintengine-worktrees') ? { branch: `agent/${id}`, repoRoot } : null,
        agents: {},
      }) as unknown as Workspace
    const order = buildSidebarWorkspaceOrder([
      ws('parent', '/repo/a'),
      ws('other-project', '/repo/b'),
      ws('worktree', '/repo/.sprintengine-worktrees/a/chat-a1b2', '/repo/a'),
      ws('legacy-worktree', '/repo/.sprintengine-worktrees/a/chat-c3d4'),
    ])
    const at = (id: string): number => order.get(id) ?? -1
    assert.deepEqual(
      [at('parent'), at('worktree'), at('legacy-worktree')].map((index) => index >= 0 && index < 3),
      [true, true, true],
      'both worktree chats sit inside their parent project group, not in groups of their own',
    )
    assert.equal(at('other-project'), 3, 'the next project still trails that whole group')
  }

  // The sessions popover groups by bucket: workspaces in sidebar order, detached
  // buckets after all of them, rows attention-first inside each.
  function assertDetachedBucketsTrailRealWorkspaces(): void {
    const workspaceGroup = (id: string, name: string): SessionItem['group'] => ({
      kind: 'workspace',
      id,
      label: name,
      workspace: { id, name } as unknown as Workspace,
    })
    const notebooks: SessionItem['group'] = { kind: 'detached', id: 'detached:Notebooks', label: 'Notebooks' }
    const other: SessionItem['group'] = { kind: 'detached', id: 'detached:Other sessions', label: 'Other sessions' }
    const rows = [
      { ...item({ status: 'idle', lastActivityAt: 1 }), group: other },
      { ...item({ status: 'working' }), group: workspaceGroup('ws-b', 'Bravo') },
      { ...item({ status: 'needs-input' }), group: notebooks },
      { ...item({ status: 'idle', lastActivityAt: 2 }), group: workspaceGroup('ws-a', 'Alpha') },
      { ...item({ status: 'needs-input' }), group: workspaceGroup('ws-a', 'Alpha') },
    ]
    const grouped = groupSessionItems(
      rows,
      new Map([
        ['ws-a', 0],
        ['ws-b', 1],
      ]),
    )
    assert.deepEqual(
      grouped.map((entry) => entry.group.label),
      ['Alpha', 'Bravo', 'Notebooks', 'Other sessions'],
      'sidebar order for workspaces, detached buckets last and alphabetical',
    )
    assert.deepEqual(
      grouped[0]?.items.map((row) => row.status),
      ['needs-input', 'idle'],
      'rows inside a bucket stay attention-first',
    )
  }

  // The regression this file was missing: a session keyed to an id no
  // workspace row claims — a module's own agent runs under an id of its own —
  // used to be dropped on BOTH branches, so a live agent was invisible in the one
  // surface users audit. Both branches must now yield a row in a labeled detached bucket,
  // with truthful status and its sessionId intact so stop still works.
  function assertWorkspacelessSessionsStillSurface(): void {
    const guideSummary: ConversationSessionSummary = {
      sessionId: 'conv-guide',
      workspaceId: 'notebook-2026-07-22',
      agentId: 'notebook-runner',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      status: 'active',
      createdAt: 10,
      updatedAt: 20,
    }
    const orphanPty = {
      sessionId: 'pty-orphan',
      processAlive: true,
      kind: 'agent',
      workspaceId: 'ws-closed',
      agentId: 'agent-1',
      agentName: 'Implementer',
      cli: 'claude-code',
      activity: { kind: 'idle', since: 10 },
      lastOutputAt: 20,
      lastInputAt: null,
      agentState: { phase: 'awaiting_input', since: 30, source: 'hook' },
    } as unknown as TerminalSessionSnapshot

    const items = getSessionItems([], [orphanPty], [guideSummary])
    assert.equal(items.length, 2, 'conversation AND terminal orphans both yield items')

    const conversationItem = items.find((item) => item.sessionId === 'conv-guide')
    assert.ok(conversationItem, 'the workspace-less conversation session surfaces')
    assert.equal(conversationItem?.status, 'working', 'its status is the truthful mapped one')
    assert.equal(conversationItem?.group.kind, 'detached')
    assert.equal(conversationItem?.group.label, 'Other sessions', 'default bucket label')
    // Stop routes by transport: a conversation agent has no PTY, so the row must
    // say so or the session manager kills the wrong runtime and reports success.
    assert.equal(conversationItem?.transport, 'conversation')
    assert.equal(conversationItem?.sessionId, 'conv-guide', 'the runtime session id survives for stop')

    const terminalItem = items.find((item) => item.sessionId === 'pty-orphan')
    assert.ok(terminalItem, 'the workspace-less terminal session surfaces')
    assert.equal(terminalItem?.status, 'needs-input', 'hook phase still drives status without a workspace')
    assert.equal(terminalItem?.label, 'Implementer', 'labels from the snapshot, not the raw id')
    assert.equal(terminalItem?.group.kind, 'detached')
    assert.equal(terminalItem?.transport, 'terminal')

    // Callers name the bucket; unrecognised ids keep the default. Sessions sharing
    // a label share ONE bucket, so N orphans of one namespace are not N groups.
    const labeled = getSessionItems([], [orphanPty], [guideSummary], {
      resolveDetachedLabel: (workspaceId) => (workspaceId.startsWith('notebook-') ? 'Notebooks' : null),
    })
    const labeledGroups = new Map(labeled.map((item) => [item.group.id, item.group.label]))
    assert.deepEqual(
      [...labeledGroups.values()].sort(),
      ['Notebooks', 'Other sessions'],
      'the resolver names the module bucket and leaves the rest generic',
    )

    const twoNotebooks = getSessionItems(
      [],
      [],
      [guideSummary, { ...guideSummary, sessionId: 'conv-guide-2', workspaceId: 'notebook-other' }],
      { resolveDetachedLabel: () => 'Notebooks' },
    )
    assert.equal(new Set(twoNotebooks.map((item) => item.group.id)).size, 1, 'one bucket per label')

    // A live session with no workspaceId at all is still a live session.
    const idlessPty = {
      sessionId: 'pty-idless',
      processAlive: true,
      kind: 'terminal',
      activity: { kind: 'working', since: 5 },
      lastOutputAt: 10,
      lastInputAt: null,
    } as unknown as TerminalSessionSnapshot
    const idless = getSessionItems([], [idlessPty], [])
    assert.equal(idless.length, 1, 'a session with no workspaceId is not filtered out')
    assert.equal(idless[0]?.group.label, 'Other sessions')
  }

  // Nearly every chat's first agent is `agent-1`. A session from a closed chat
  // must land in the detached bucket, not under the open chat that happens to
  // have an `agent-1` of its own — while an agent the person MOVED to another
  // chat is followed there by the session its record owns.
  function assertClosedChatSessionsNeverJoinANamesake(): void {
    const openChat = {
      id: 'ws-open',
      name: 'Open chat',
      agents: { 'agent-1': { id: 'agent-1', name: 'Open agent', cliSessionId: 'pty-open' } },
    } as unknown as Workspace
    const closedPty = {
      sessionId: 'pty-closed',
      processAlive: true,
      kind: 'agent',
      workspaceId: 'ws-closed',
      agentId: 'agent-1',
      agentName: 'Closed agent',
      cli: 'claude-code',
      activity: { kind: 'working', since: 10 },
      lastOutputAt: 20,
      lastInputAt: null,
    } as unknown as TerminalSessionSnapshot
    // A second closed chat, also with an `agent-1`, running on the conversation
    // transport: the two share the detached bucket but are not twins.
    const closedSummary: ConversationSessionSummary = {
      sessionId: 'conv-closed',
      workspaceId: 'ws-closed-too',
      agentId: 'agent-1',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      status: 'active',
      createdAt: 10,
      updatedAt: 20,
    }

    const items = getSessionItems([openChat], [closedPty], [closedSummary])
    const terminalItem = items.find((item) => item.sessionId === 'pty-closed')
    assert.equal(terminalItem?.group.kind, 'detached', "a closed chat's terminal is detached")
    assert.equal(terminalItem?.label, 'Closed agent', "never labelled with the open chat's agent")
    const conversationItem = items.find((item) => item.sessionId === 'conv-closed')
    assert.equal(conversationItem?.group.kind, 'detached', "a closed chat's conversation is detached")
    assert.equal(conversationItem?.label, 'agent-1', "never labelled with the open chat's agent")

    // Moved: the PTY still says ws-source, but ws-open's record owns its session.
    const movedPty = {
      ...(closedPty as unknown as Record<string, unknown>),
      sessionId: 'pty-open',
      workspaceId: 'ws-source',
    } as unknown as TerminalSessionSnapshot
    const source = { id: 'ws-source', name: 'Source', agents: {} } as unknown as Workspace
    const moved = getSessionItems([source, openChat], [movedPty], [])
    assert.equal(moved[0]?.group.id, 'ws-open', 'a moved agent is grouped where its record now lives')
    assert.equal(moved[0]?.label, 'Open agent')

    // A chat agent moved from ws-source to ws-open: its conversation is still
    // keyed to ws-source. A minted id is followed to ws-open; `agent-1` never
    // is, since the open chat's `agent-1` is its own agent.
    const minted = 'agent-0123456789abcdef'
    const withMinted = {
      ...openChat,
      agents: { ...openChat.agents, [minted]: { id: minted, name: 'Moved chat agent' } },
    } as unknown as Workspace
    const movedSummary = (agentId: string): ConversationSessionSummary => ({
      ...closedSummary,
      sessionId: `conv-${agentId}`,
      workspaceId: 'ws-source',
      agentId,
    })
    const movedChat = getSessionItems([source, withMinted], [], [movedSummary(minted), movedSummary('agent-1')])
    const followed = movedChat.find((item) => item.sessionId === `conv-${minted}`)
    assert.equal(followed?.group.id, 'ws-open', 'a moved chat agent with a minted id is grouped where it now is')
    assert.equal(followed?.label, 'Moved chat agent')
    const shared = movedChat.find((item) => item.sessionId === 'conv-agent-1')
    assert.equal(shared?.group.id, 'ws-source', 'an `agent-1` stays with the chat it was recorded in')
    assert.equal(shared?.label, 'agent-1')
  }

  // An agent spawned outside this window carries workspaceId and agentName in the
  // snapshot but has no workspace.agents record. It must surface as a labeled row,
  // and a conversation session for the same agent id must win over a stale PTY
  // twin instead of duplicating the row.
  function assertAgentlessPtySessionsSurfaceWithHumanLabel(): void {
    const workspace = {
      id: 'ws-detached',
      name: 'Detached Agent Host',
      agents: {},
    } as unknown as Workspace
    const agentlessPtySnap = {
      sessionId: 'pty-detached-1',
      processAlive: true,
      kind: 'agent',
      workspaceId: 'ws-detached',
      agentId: 'agent-no-record',
      agentName: 'Design System Designer',
      cli: 'claude-code',
      activity: { kind: 'working', since: 10 },
      lastOutputAt: 20,
      lastInputAt: null,
    } as unknown as TerminalSessionSnapshot

    const items = getSessionItems([workspace], [agentlessPtySnap], [])
    assert.equal(items.length, 1, 'a PTY session with a workspaceId but no AgentState surfaces')
    assert.equal(items[0]?.label, 'Design System Designer', 'labels from snapshot agentName, not the raw agent id')
    assert.equal(items[0]?.status, 'working')
    assert.equal(items[0]?.agentId, 'agent-no-record')

    // Retained crash: the failed row keeps its human label too.
    const failedSnap = {
      ...(agentlessPtySnap as unknown as Record<string, unknown>),
      processAlive: false,
      activity: { kind: 'failed', at: 30, exitCode: 1 },
    } as unknown as TerminalSessionSnapshot
    const failedItems = getSessionItems([workspace], [failedSnap], [])
    assert.equal(failedItems.length, 1, 'the crashed session is retained')
    assert.equal(failedItems[0]?.status, 'failed')
    assert.equal(failedItems[0]?.label, 'Design System Designer')

    // Same agent id on both transports: the conversation row wins, no duplicate.
    const conversationTwin: ConversationSessionSummary = {
      sessionId: 'conv-detached-1',
      workspaceId: 'ws-detached',
      agentId: 'agent-no-record',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      status: 'active',
      createdAt: 40,
      updatedAt: 50,
    }
    const merged = getSessionItems([workspace], [agentlessPtySnap], [conversationTwin])
    assert.equal(merged.length, 1, 'stale PTY twin is deduplicated against the conversation session')
    assert.equal(merged[0]?.sessionId, 'conv-detached-1', 'the conversation row is the one kept')
    // A conversation summary carries no agentName, and this agent has no
    // workspace.agents record, so its own id is the honest label.
    assert.equal(merged[0]?.label, 'agent-no-record')
  }

  // Conversation (chat) agents have no PTY snapshot; their runtime summaries
  // must still produce session rows with truthful status mapping.
  function assertConversationSessionsSurfaceInSessionItems(): void {
    const workspace = {
      id: 'ws-1',
      name: 'Workspace One',
      agents: {
        'chat-1': { id: 'chat-1', name: 'Sonnet chat', runtimeKind: 'conversation' },
      },
    } as unknown as Workspace
    const summary = (status: ConversationSessionSummary['status']): ConversationSessionSummary => ({
      sessionId: `conv-${status}`,
      workspaceId: 'ws-1',
      agentId: 'chat-1',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      status,
      createdAt: 10,
      updatedAt: 20,
    })

    const awaiting = getSessionItems([workspace], [], [summary('awaiting_approval')])
    assert.equal(awaiting.length, 1)
    assert.equal(awaiting[0]?.status, 'needs-input', 'pending approval/question reads as needs-input')
    assert.equal(awaiting[0]?.agentId, 'chat-1')
    assert.equal(awaiting[0]?.label, 'Sonnet chat')
    assert.equal(awaiting[0]?.cli, 'claude-code', 'claude-agent provider surfaces the Claude icon')

    assert.equal(getSessionItems([workspace], [], [summary('active')])[0]?.status, 'working')
    assert.equal(getSessionItems([workspace], [], [summary('ready')])[0]?.status, 'idle')
    assert.equal(getSessionItems([workspace], [], [summary('failed')])[0]?.status, 'failed')
    assert.equal(getSessionItems([workspace], [], [summary('stopped')]).length, 0, 'stopped sessions drop out')

    // A conversation session with no AgentState entry must stay visible in the
    // session manager; with no name to read, its own agent id is the label.
    const agentlessSummary: ConversationSessionSummary = {
      sessionId: 'conv-agentless',
      workspaceId: 'ws-1',
      agentId: 'conversation-only-agent',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      status: 'awaiting_approval',
      createdAt: 10,
      updatedAt: 20,
    }
    const agentlessItems = getSessionItems([workspace], [], [agentlessSummary])
    assert.equal(agentlessItems.length, 1, 'agent-less conversation session still surfaces')
    assert.equal(agentlessItems[0]?.label, 'conversation-only-agent')
    assert.equal(agentlessItems[0]?.status, 'needs-input')
  }

  function snap(partial: {
    kind?: TerminalSessionSnapshot['kind']
    activity: SessionActivity
    agentState?: AgentState
    lastOutputAt?: number | null
    lastInputAt?: number | null
    processAlive?: boolean
  }): TerminalSessionSnapshot {
    return {
      kind: partial.kind ?? 'agent',
      processAlive: partial.processAlive ?? true,
      activity: partial.activity,
      agentState: partial.agentState,
      lastOutputAt: partial.lastOutputAt ?? null,
      lastInputAt: partial.lastInputAt ?? null,
    } as unknown as TerminalSessionSnapshot
  }

  // The authoritative hook phase wins over output timing, and carries its own
  // `since` and provenance through.
  function assertHookPhaseDrivesStatus(): void {
    const awaiting = deriveSessionStatus(
      snap({
        activity: { kind: 'working', since: 10 },
        agentState: { phase: 'awaiting_input', since: 500, source: 'hook' },
      }),
    )
    assert.equal(awaiting.status, 'needs-input')
    assert.equal(awaiting.source, 'hook')
    assert.equal(awaiting.activitySince, 500, 'needs-input since comes from the hook frame')

    // A dead agent's stale awaiting_input is not a live attention request: the hook
    // disjunct is gated on processAlive, so it falls through to idle.
    const deadAwaiting = deriveSessionStatus(
      snap({
        processAlive: false,
        activity: { kind: 'exited', at: 700, exitCode: 0 },
        agentState: { phase: 'awaiting_input', since: 500, source: 'hook' },
      }),
    )
    assert.notEqual(deadAwaiting.status, 'needs-input', 'dead awaiting_input does not surface as needs-input')

    for (const phase of ['starting', 'thinking', 'tool_use'] as const) {
      const working = deriveSessionStatus(
        snap({ activity: { kind: 'idle', since: 1 }, agentState: { phase, since: 42, source: 'hook' } }),
      )
      assert.equal(working.status, 'working', `${phase} -> working`)
      assert.equal(working.activitySince, 42)
    }

    // `idle` and `stalled` hook phases read as idle, not working.
    for (const phase of ['idle', 'stalled'] as const) {
      const idle = deriveSessionStatus(
        snap({ activity: { kind: 'working', since: 1 }, agentState: { phase, since: 99, source: 'hook' } }),
      )
      assert.equal(idle.status, 'idle', `${phase} -> idle even while bytes are flowing`)
      assert.equal(idle.source, 'hook')
    }
  }

  // Without a hook frame, fall back to the output-timing heuristic, marked inferred.
  function assertOutputRecencyFallback(): void {
    const working = deriveSessionStatus(snap({ activity: { kind: 'working', since: 7 } }))
    assert.equal(working.status, 'working')
    assert.equal(working.source, 'lifecycle')
    assert.equal(working.activitySince, 7)

    const idle = deriveSessionStatus(snap({ activity: { kind: 'idle', since: 8 } }))
    assert.equal(idle.status, 'idle')
    assert.equal(idle.source, 'lifecycle')
  }

  // A retained crash surfaces as failed (with its exit code) and outranks any
  // stale working signal.
  function assertFailedRetentionAndPrecedence(): void {
    const failed = deriveSessionStatus(
      snap({
        activity: { kind: 'failed', at: 1234, exitCode: 137 },
        agentState: { phase: 'thinking', since: 1, source: 'hook' },
      }),
    )
    assert.equal(failed.status, 'failed')
    assert.equal(failed.exitCode, 137)
    assert.equal(failed.activitySince, 1234, 'failed since comes from the exit timestamp')
  }

  function assertLastActivityIsMaxOfOutputAndInput(): void {
    assert.equal(
      deriveSessionStatus(snap({ activity: { kind: 'idle', since: 1 }, lastOutputAt: 100, lastInputAt: 250 }))
        .lastActivityAt,
      250,
    )
    assert.equal(
      deriveSessionStatus(snap({ activity: { kind: 'idle', since: 1 }, lastOutputAt: null, lastInputAt: null }))
        .lastActivityAt,
      null,
    )
  }

  function item(partial: {
    status: SessionItem['status']
    activitySince?: number
    lastActivityAt?: number | null
  }): SessionItem {
    return {
      status: partial.status,
      activitySince: partial.activitySince ?? 0,
      lastActivityAt: partial.lastActivityAt ?? null,
    } as unknown as SessionItem
  }

  // Rows sort attention-first: needs-input -> failed -> working -> idle, then most
  // recently active first within a tier.
  function assertAttentionFirstOrdering(): void {
    const rows = [
      item({ status: 'idle', lastActivityAt: 100 }),
      item({ status: 'working' }),
      item({ status: 'failed' }),
      item({ status: 'needs-input' }),
      item({ status: 'idle', lastActivityAt: 900 }),
    ]
    const sorted = rows
      .slice()
      .sort(compareSessionItemsByAttention)
      .map((row) => row.status)
    assert.deepEqual(sorted, ['needs-input', 'failed', 'working', 'idle', 'idle'])

    const idleByRecency = [item({ status: 'idle', lastActivityAt: 100 }), item({ status: 'idle', lastActivityAt: 900 })]
      .sort(compareSessionItemsByAttention)
      .map((row) => row.lastActivityAt)
    assert.deepEqual(idleByRecency, [900, 100], 'more recent idle first')
  }

  // The trigger badge tone must escalate, never repeat a flat "all good".
  function assertAttentionToneNeverLies(): void {
    assert.equal(sessionsAttentionTone([]), 'good')
    assert.equal(sessionsAttentionTone([item({ status: 'working' }), item({ status: 'idle' })]), 'good')
    assert.equal(sessionsAttentionTone([item({ status: 'failed' }), item({ status: 'working' })]), 'error')
    assert.equal(
      sessionsAttentionTone([item({ status: 'failed' }), item({ status: 'needs-input' })]),
      'warn',
      'needs-input outranks failed for tone',
    )
  }
})

test('New chat offers each project once, never a chat worktree folder, with its last message time', () => {
  const chat = (id: string, folderPath: string, extra: Record<string, unknown> = {}): Workspace =>
    ({ id, name: id, folderPath, createdAt: 1, ...extra }) as unknown as Workspace
  const options = newChatProjectOptionsOf([
    chat('plain', '/Users/dev/app', { lastUserMessageAt: 10 }),
    // A pool slot recorded with its project, and one recorded before the
    // marker carried it: both are the app.
    chat('slot', '/Users/dev/.sprintengine-worktrees/app/pool-06', {
      worktree: { repoRoot: '/Users/dev/app', branch: 'agent/chat-ab' },
      lastUserMessageAt: 50,
    }),
    chat('legacy', '/Users/dev/.sprintengine-worktrees/app/chat-k_iq', { lastUserMessageAt: 30 }),
    chat('other', '/Users/dev/toolbox', { lastUserMessageAt: 40 }),
    chat('pending', '', { worktree: { repoRoot: '/Users/dev/site' } }),
  ])
  assert.deepEqual(options, [
    { path: '/Users/dev/app', label: 'app', lastUsedAt: 50 },
    { path: '/Users/dev/toolbox', label: 'toolbox', lastUsedAt: 40 },
    { path: '/Users/dev/site', label: 'site', lastUsedAt: 1 },
  ])
})

test('New chat never offers the chats started without a project as a project', () => {
  const chat = (id: string, folderPath: string): Workspace =>
    ({ id, name: id, folderPath, createdAt: 1 }) as unknown as Workspace
  const options = newChatProjectOptionsOf([
    chat('loose', '/Users/dev/.sprintengine/chats/2026-10-10-hello-ab12cd34'),
    chat('plain', '/Users/dev/app'),
  ])
  assert.deepEqual(
    options.map((option) => option.path),
    ['/Users/dev/app'],
  )
})
