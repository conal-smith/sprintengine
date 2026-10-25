import { afterEach, expect, test, vi } from 'vitest'
import { Model, TabNode, TabSetNode } from 'flexlayout-react'

import type { ConversationForkInput } from '../../../../../shared/conversation-runtime'
import { defaultAgent } from '../../../../../shared/agent-state'
import type { AgentState, Workspace } from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useToastStore } from '../../../store/toastStore'
import { addAgentTabAfter, registerModel, unregisterModel } from '../../../utils/modelRegistry'
import { composerDraftStore } from './draftStore'
import { forkChat, forkRemoteChat, takeForkedAttachments } from './forkFromHere'
import { forkName, forkedAgentPatch } from '../../../../../shared/conversation/fork'

const WS = 'fork-from-here-ws'
const root = '/Users/dev/app-worktree'

// The chat forked from: a Claude chat in a worktree, with its own engine settings.
const parent: AgentState = {
  ...defaultAgent('parent', 'Atlas'),
  runtimeKind: 'conversation',
  conversation: { providerId: 'claude-agent', modelId: 'opus' },
  cliPermissionPreset: 'auto',
  cliPermissionMode: 'acceptEdits',
  conversationReasoningEffort: 'high',
  conversationSkills: ['review'],
  execution: { mode: 'worktree', worktreeId: null, cwd: root },
}

function setup(answer: { ok: true } | { ok: false; message: string } = { ok: true }) {
  const storage = new Map<string, string>()
  Object.assign(globalThis, {
    window: {
      setTimeout: () => 0,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
    },
  })
  useWorkspaceStore.setState({
    workspaces: [
      { id: WS, name: 'App', agents: { parent, other: defaultAgent('other', 'Iris') } } as unknown as Workspace,
    ],
  })
  const model = Model.fromJson({
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          children: [
            { type: 'tab', name: 'Atlas', component: 'agent', config: { agentId: 'parent' } },
            { type: 'tab', name: 'Iris', component: 'agent', config: { agentId: 'other' } },
          ],
        },
      ],
    },
  })
  registerModel(WS, model)
  const forks: ConversationForkInput[] = []
  const transport = {
    fork: async (input: ConversationForkInput) => {
      forks.push(input)
      return answer
    },
  }
  return { model, forks, transport, key: { workspaceRoot: root, workspaceId: WS, agentId: 'parent' } }
}

afterEach(() => {
  unregisterModel(WS)
  delete (globalThis as { window?: unknown }).window
})

const tabsOf = (model: Model) => {
  const tabset = model.getRootRow()!.getChildren()[0] as TabSetNode
  return {
    agents: tabset.getChildren().map((tab) => ((tab as TabNode).getConfig() as { agentId: string }).agentId),
    selected: tabset.getSelected(),
  }
}

test('a fork opens beside the chat it came from, as its twin, with the message forked before in its composer', async () => {
  const t = setup()
  await forkChat({
    transport: t.transport,
    key: t.key,
    target: {
      side: 'user',
      turnSeq: 4,
      draft: { text: 'try again', skillIds: ['review'], mentions: [], files: ['/Users/dev/Desktop/spec.pdf'] },
    },
  })
  expect(t.forks).toHaveLength(1)
  const [asked] = t.forks
  expect(asked).toMatchObject({ key: t.key, side: 'user', turnSeq: 4, title: 'Atlas (fork)' })
  expect(asked.newAgentId).toMatch(/^conversation-claude-agent-/)

  const fork = useWorkspaceStore.getState().workspaces[0].agents[asked.newAgentId]
  expect(fork).toMatchObject({
    name: 'Atlas (fork)',
    runtimeKind: 'conversation',
    conversation: { providerId: 'claude-agent', modelId: 'opus' },
    cliPermissionPreset: 'auto',
    cliPermissionMode: 'acceptEdits',
    conversationReasoningEffort: 'high',
    conversationSkills: ['review'],
    execution: { mode: 'worktree', cwd: root },
  })
  expect(composerDraftStore().getState().read(WS, asked.newAgentId)).toMatchObject({
    text: 'try again',
    // The files it attached by path come back as the fork composer's cards.
    files: ['/Users/dev/Desktop/spec.pdf'],
  })

  // Right after the parent's tab, in its strip, and in front.
  const tabs = tabsOf(t.model)
  expect(tabs.agents).toEqual(['parent', asked.newAgentId, 'other'])
  expect(tabs.selected).toBe(1)
  expect(useToastStore.getState().toasts.at(-1)?.title).toContain('Both chats work in the same files')
})

test('a message forked before goes to the fork’s composer with its images, handed over once', async () => {
  const t = setup()
  const image = { id: 'img-1', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', byteLength: 8, name: 'layout.png' }
  await forkChat({
    transport: t.transport,
    key: t.key,
    target: {
      side: 'user',
      turnSeq: 4,
      draft: { text: 'what is wrong here?', skillIds: [], mentions: [] },
      attachments: [image],
    },
  })
  const forkId = t.forks[0].newAgentId
  expect(takeForkedAttachments(WS, 'parent')).toEqual([])
  expect(takeForkedAttachments(WS, forkId)).toEqual([image])
  expect(takeForkedAttachments(WS, forkId)).toEqual([])
})

test('a fork’s images are let go when nobody takes them: its chat removed, an hour gone, or newer forks past four', async () => {
  const t = setup()
  const image = { id: 'img-1', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', byteLength: 8, name: 'layout.png' }
  const fork = async () => {
    await forkChat({
      transport: t.transport,
      key: t.key,
      target: {
        side: 'user',
        turnSeq: 4,
        draft: { text: 'what is wrong here?', skillIds: [], mentions: [] },
        attachments: [image],
      },
    })
    return t.forks.at(-1)!.newAgentId
  }
  const removeAgent = (agentId: string) =>
    useWorkspaceStore.setState((state) => ({
      workspaces: state.workspaces.map((workspace) => {
        const { [agentId]: _removed, ...agents } = workspace.agents
        return { ...workspace, agents }
      }),
    }))

  // Its chat closed before its view ever mounted.
  const removed = await fork()
  removeAgent(removed)
  const kept = await fork()
  expect(takeForkedAttachments(WS, removed)).toEqual([])
  expect(takeForkedAttachments(WS, kept)).toEqual([image])

  // Left unopened past the hour.
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const late = await fork()
    vi.setSystemTime(Date.now() + 61 * 60 * 1000)
    expect(takeForkedAttachments(WS, late)).toEqual([])
  } finally {
    vi.useRealTimers()
  }

  // Only the newest four wait.
  const forks: string[] = []
  for (let index = 0; index < 5; index++) forks.push(await fork())
  expect(takeForkedAttachments(WS, forks[0]!)).toEqual([])
  for (const id of forks.slice(1)) expect(takeForkedAttachments(WS, id)).toEqual([image])
})

test('a refused fork opens nothing', async () => {
  const t = setup({ ok: false, message: 'Stop the running turn before forking from an earlier message.' })
  await expect(
    forkChat({ transport: t.transport, key: t.key, target: { side: 'assistant', turnId: 'turn_1' } }),
  ).rejects.toThrow('Stop the running turn')
  expect(Object.keys(useWorkspaceStore.getState().workspaces[0].agents)).toEqual(['parent', 'other'])
  expect(tabsOf(t.model).agents).toEqual(['parent', 'other'])
})

test('the fork carries the engine, never the parent’s launch-only state', () => {
  const patch = forkedAgentPatch({ ...parent, chatStartupPrompt: 'hello', ownerModuleId: 'module' }, 'Atlas (fork)')
  expect(patch.chatStartupPrompt).toBeUndefined()
  expect(patch.ownerModuleId).toBeUndefined()
  expect(patch.cli).toBeUndefined()
})

test('beside a chat with no tab here, the fork is left to dock the ordinary way', () => {
  const t = setup()
  expect(addAgentTabAfter(WS, 'fork', 'Atlas (fork)', 'closed-chat')).toBe(false)
  expect(tabsOf(t.model).agents).toEqual(['parent', 'other'])
})

test('a fork is named after the chat it came from, numbered past the forks already open', () => {
  expect(forkName('Atlas', ['Atlas', 'Iris'])).toBe('Atlas (fork)')
  expect(forkName('Atlas', ['Atlas', 'Atlas (fork)'])).toBe('Atlas (fork 2)')
  // A fork of a fork is one more fork of the chat it started from.
  expect(forkName('Atlas (fork)', ['Atlas', 'Atlas (fork)'])).toBe('Atlas (fork 2)')
  expect(forkName('Atlas (fork 2)', ['Atlas', 'Atlas (fork)', 'Atlas (fork 2)'])).toBe('Atlas (fork 3)')
})

test('a side question carried on in a new chat forks at the newest reply, with the question in the fork’s composer', async () => {
  const t = setup()
  await forkChat({
    transport: t.transport,
    key: t.key,
    target: { side: 'assistant', turnId: 'turn_7', draft: { text: 'Which file is the parser in?' } },
  })
  const [asked] = t.forks
  expect(asked).toMatchObject({ side: 'assistant', turnId: 'turn_7' })
  expect(composerDraftStore().getState().read(WS, asked.newAgentId)).toMatchObject({
    text: 'Which file is the parser in?',
    skillIds: [],
    files: [],
  })
})

// A chat followed from a paired machine: the fork is made over there, and a
// pane onto it opens here in the tab after this chat's.
const REMOTE_WS = 'fork-from-here-remote-ws'
const remoteOrigin = {
  connectionId: 'connection',
  machineName: 'mac-mini',
  workspaceId: 'remote-workspace',
  workspaceName: 'studio',
  workspaceRoot: '/Users/other/studio',
  sessionId: 'conversation:remote-workspace:remote-agent',
  repository: null,
  checkout: { mode: 'current' as const, branch: 'main', worktreePath: null },
}
const meshTab = (remoteAgentId: string, name: string) => ({
  type: 'tab',
  id: `mesh-conversation:connection:remote-workspace:${remoteAgentId}`,
  name,
  component: 'mesh-conversation',
  config: { connectionId: 'connection', machineName: 'mac-mini', remoteWorkspaceId: 'remote-workspace', remoteAgentId },
})

function remoteSetup(options: { mounted?: boolean; listedTitle?: string } = {}) {
  const t = setup()
  useWorkspaceStore.setState({
    workspaces: [{ id: REMOTE_WS, name: 'Atlas', agents: {}, remoteOrigin } as unknown as Workspace],
  })
  const model = Model.fromJson({
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [{ type: 'tabset', children: [meshTab('remote-agent', 'Atlas'), meshTab('remote-other', 'Iris')] }],
    },
  })
  if (options.mounted !== false) registerModel(REMOTE_WS, model)
  const listed = vi.fn(async (_connectionId: string) => ({
    ok: true,
    conversations: [
      {
        workspaceId: 'remote-workspace',
        agentId: forks.at(-1)?.newAgentId,
        title: options.listedTitle ?? 'Atlas (fork 2)',
      },
    ],
  }))
  Object.assign(globalThis.window as object, { api: { meshConversationList: listed } })
  const forks: ConversationForkInput[] = []
  const transport = {
    machineName: 'mac-mini',
    remoteExtensions: { connectionId: 'connection', workspaceId: 'remote-workspace' },
    fork: async (input: ConversationForkInput) => {
      forks.push(input)
      return { ok: true as const }
    },
  }
  return { ...t, model, forks, transport, listed }
}

const meshTabsOf = (model: Model) => {
  const tabset = model.getRootRow()!.getChildren()[0] as TabSetNode
  return {
    agents: tabset
      .getChildren()
      .map((tab) => ((tab as TabNode).getConfig() as { remoteAgentId: string }).remoteAgentId),
    names: tabset.getChildren().map((tab) => (tab as TabNode).getName()),
    selected: tabset.getSelected(),
  }
}

test('a chat on a paired machine forks over there, and the fork opens here in the tab after it, named as it is there', async () => {
  const t = remoteSetup()
  try {
    await forkRemoteChat({
      transport: t.transport,
      workspaceId: REMOTE_WS,
      agentId: 'remote-agent',
      providerId: 'claude-agent',
      name: 'Atlas',
      target: {
        side: 'user',
        turnSeq: 4,
        draft: { text: 'try again', skillIds: [], mentions: [], files: ['/Users/other/studio/spec.pdf'] },
      },
    })
    expect(t.forks).toHaveLength(1)
    const [asked] = t.forks
    // Named by the chat's ids over there, and with no title: that machine names it.
    expect(asked).toMatchObject({
      side: 'user',
      turnSeq: 4,
      key: { workspaceId: 'remote-workspace', agentId: 'remote-agent' },
    })
    expect(asked).not.toHaveProperty('title')
    expect(asked.newAgentId).toMatch(/^conversation-claude-agent-/)
    expect(t.listed).toHaveBeenCalledWith('connection')

    const tabs = meshTabsOf(t.model)
    expect(tabs.agents).toEqual(['remote-agent', asked.newAgentId, 'remote-other'])
    expect(tabs.names[1]).toBe('Atlas (fork 2)')
    expect(tabs.selected).toBe(1)
    // No record here: the chat lives over there.
    expect(useWorkspaceStore.getState().workspaces[0]!.agents).toEqual({})
    // The message waits in the fork's composer, without the files: their paths are on that machine.
    const draft = composerDraftStore().getState().read(REMOTE_WS, asked.newAgentId)
    expect(draft?.text).toBe('try again')
    expect(draft?.files ?? []).toEqual([])
    expect(useToastStore.getState().toasts.at(-1)?.title).toContain('on mac-mini')
  } finally {
    unregisterModel(REMOTE_WS)
  }
})

test('a remote fork whose chat has no pane mounted here opens as a chat of its own onto that machine', async () => {
  const t = remoteSetup({ mounted: false })
  const added = vi.fn((_template: unknown, _options: unknown) => 'forked-workspace')
  const addWorkspace = useWorkspaceStore.getState().addWorkspace
  useWorkspaceStore.setState({ addWorkspace: added as never })
  try {
    await forkRemoteChat({
      transport: t.transport,
      workspaceId: REMOTE_WS,
      agentId: 'remote-agent',
      providerId: 'claude-agent',
      name: 'Atlas',
      target: { side: 'assistant', turnId: 'turn_1', draft: { text: 'and the docs?' } },
    })
    const forkId = t.forks[0]!.newAgentId
    expect(added).toHaveBeenCalledOnce()
    expect(added.mock.calls[0]![1]).toMatchObject({
      name: 'Atlas (fork 2)',
      folderPath: null,
      remoteOrigin: { ...remoteOrigin, sessionId: `conversation:remote-workspace:${forkId}` },
      seedAgent: {
        meshConversation: {
          connectionId: 'connection',
          machineName: 'mac-mini',
          remoteWorkspaceId: 'remote-workspace',
          remoteAgentId: forkId,
          title: 'Atlas (fork 2)',
        },
      },
    })
    expect(composerDraftStore().getState().read('forked-workspace', forkId)?.text).toBe('and the docs?')
  } finally {
    useWorkspaceStore.setState({ addWorkspace })
  }
})
