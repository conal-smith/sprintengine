import { expect, test, vi } from 'vitest'
import type { ConversationThread } from '../../../shared/conversation-index'
import { layoutHasConversation, openConversationHistory, openConversationMatch } from './conversationHistoryNavigation'
import { useWorkspaceStore } from '../store/workspaceStore'
import { revealAgentTerminalTab } from './agentTabReveal'

vi.mock('../store/workspaceStore', () => ({ useWorkspaceStore: { getState: vi.fn() } }))
vi.mock('./agentTabReveal', () => ({ revealAgentTerminalTab: vi.fn(() => true) }))

test('reopening history seeds the original identity and does not launch a terminal', () => {
  const updateAgent = vi.fn()
  vi.mocked(useWorkspaceStore.getState).mockReturnValue({
    workspaces: [{ id: 'workspace' }],
    updateAgent,
  } as unknown as ReturnType<typeof useWorkspaceStore.getState>)
  const thread: ConversationThread = {
    agentId: 'existing-agent',
    title: 'Saved chat',
    titleSource: 'user',
    providerId: 'provider',
    model: 'model',
    createdAt: 1,
    updatedAt: 2,
    turnCount: 1,
    lastSeq: 3,
    firstUserText: 'Hello',
  }
  expect(openConversationHistory('workspace', thread, 2)).toBe(true)
  expect(updateAgent).toHaveBeenCalledWith(
    'workspace',
    'existing-agent',
    expect.objectContaining({
      name: 'Saved chat',
      runtimeKind: 'conversation',
      conversation: { providerId: 'provider', modelId: 'model' },
      cliStartRequested: false,
    }),
  )
  expect(revealAgentTerminalTab).toHaveBeenCalledWith({
    workspaceId: 'workspace',
    agentId: 'existing-agent',
    name: 'Saved chat',
  })
  expect(openConversationHistory('missing', thread)).toBe(false)
})

test('an open agent tab is excluded from the closed-history stream', () => {
  const layout = {
    layout: {
      type: 'row',
      children: [
        { type: 'tabset', children: [{ type: 'tab', component: 'agent', config: { agentId: 'existing-agent' } }] },
      ],
    },
  }
  expect(layoutHasConversation(layout, 'existing-agent')).toBe(true)
  expect(layoutHasConversation(layout, 'another-agent')).toBe(false)
  expect(layoutHasConversation(undefined, 'existing-agent')).toBe(false)
})

test('a search match in an agent the chat still has jumps to it without renaming it', async () => {
  const updateAgent = vi.fn()
  vi.mocked(useWorkspaceStore.getState).mockReturnValue({
    workspaces: [{ id: 'workspace', agents: { agent: { name: 'Art Shea' } } }],
    updateAgent,
  } as unknown as ReturnType<typeof useWorkspaceStore.getState>)
  vi.mocked(revealAgentTerminalTab).mockClear()
  expect(
    await openConversationMatch({
      workspaceRoot: '/Users/dev/app',
      workspaceId: 'workspace',
      agentId: 'agent',
      seq: 9,
    }),
  ).toBe(true)
  expect(updateAgent).not.toHaveBeenCalled()
  expect(revealAgentTerminalTab).toHaveBeenCalledWith({ workspaceId: 'workspace', agentId: 'agent', name: 'Art Shea' })
})

test('a search match in an agent the chat no longer has is restored from its saved thread', async () => {
  const updateAgent = vi.fn()
  const setActiveWorkspace = vi.fn()
  vi.mocked(useWorkspaceStore.getState).mockReturnValue({
    workspaces: [{ id: 'workspace', agents: {} }],
    updateAgent,
    setActiveWorkspace,
  } as unknown as ReturnType<typeof useWorkspaceStore.getState>)
  const thread = { agentId: 'gone', title: 'Old chat', providerId: 'provider', model: 'model' }
  vi.stubGlobal('window', { api: { conversationThreads: async () => ({ ok: true, threads: [thread] }) } })
  expect(
    await openConversationMatch({ workspaceRoot: '/Users/dev/app', workspaceId: 'workspace', agentId: 'gone', seq: 4 }),
  ).toBe(true)
  expect(updateAgent).toHaveBeenCalledWith('workspace', 'gone', expect.objectContaining({ name: 'Old chat' }))

  // Gone from the saved threads too: the chat is still the answer.
  vi.stubGlobal('window', { api: { conversationThreads: async () => ({ ok: true, threads: [] }) } })
  expect(
    await openConversationMatch({ workspaceRoot: '/Users/dev/app', workspaceId: 'workspace', agentId: 'gone', seq: 4 }),
  ).toBe(false)
  expect(setActiveWorkspace).toHaveBeenCalledWith('workspace')
  vi.unstubAllGlobals()
})
