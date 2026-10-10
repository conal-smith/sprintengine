// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest'

// A quote handed to a workspace's chat from outside it (the diff viewer's
// "Add to chat"): the chat drawn here takes it in its composer; one that is
// not drawn has it set into its saved draft.

const fixtures = vi.hoisted(() => ({
  state: {
    workspaces: [] as unknown[],
    workspaceWindows: [] as { id: string; workspaceIds?: string[] }[],
    active: [] as string[],
    setActiveWorkspaceForWindow: (windowId: string, workspaceId: string) =>
      fixtures.state.active.push(`${windowId}:${workspaceId}`),
  },
  drafts: new Map<string, { text: string; skillIds: string[]; mentions: unknown[]; files: string[] }>(),
}))
vi.mock('../../../store/workspaceStore', () => ({ useWorkspaceStore: { getState: () => fixtures.state } }))
vi.mock('./draftStore', () => ({
  composerDraftStore: () => ({
    getState: () => ({
      read: (workspaceId: string, agentId: string) =>
        fixtures.drafts.get(`${workspaceId}/${agentId}`) ?? { text: '', skillIds: [], mentions: [], files: [] },
      put: (workspaceId: string, agentId: string, draft: { text: string }) =>
        fixtures.drafts.set(`${workspaceId}/${agentId}`, draft as never),
    }),
  }),
}))

const { answerDiffToChat, deliverQuoteToWorkspaceChat } = await import('./composerHandoff')
const { registerMountedChatView } = await import('./mountedChatViews')

const QUOTE = '> `src/a.ts:L3`\n> ```ts\n> const a = 1\n> ```'

function chat(agents: Record<string, unknown>) {
  fixtures.state.workspaces = [{ id: 'ws', agents }]
}

afterEach(() => {
  fixtures.drafts.clear()
  fixtures.state.workspaceWindows = []
  fixtures.state.active = []
})

test('the chat drawn in this window takes the quote in its composer', () => {
  chat({ shell: { cli: 'claude-code' }, agent: { conversation: { providerId: 'claude', modelId: 'x' } } })
  const inserted: string[] = []
  const unregister = registerMountedChatView({
    workspaceId: 'ws',
    agentId: 'agent',
    isFocused: () => false,
    toggleModelPicker: () => undefined,
    insertQuote: (text) => inserted.push(text),
  })
  try {
    expect(deliverQuoteToWorkspaceChat('ws', QUOTE)).toBe('agent')
    expect(inserted).toEqual([QUOTE])
    expect(fixtures.drafts.size, 'not behind its back in the saved draft').toBe(0)
  } finally {
    unregister()
  }
})

test('a chat not drawn here has the quote set into its saved draft, after what is there', () => {
  chat({ agent: { conversation: { providerId: 'claude', modelId: 'x' } } })
  fixtures.drafts.set('ws/agent', { text: 'Look at this:', skillIds: [], mentions: [], files: [] })
  expect(deliverQuoteToWorkspaceChat('ws', QUOTE)).toBe('agent')
  expect(fixtures.drafts.get('ws/agent')?.text).toBe(`Look at this:\n\n${QUOTE}\n\n`)
})

test('a workspace with no chat, only terminals, takes nothing, so the next window is asked', () => {
  chat({ shell: { cli: 'claude-code' } })
  expect(deliverQuoteToWorkspaceChat('ws', QUOTE)).toBeNull()
  expect(deliverQuoteToWorkspaceChat('elsewhere', QUOTE)).toBeNull()
  expect(fixtures.drafts.size).toBe(0)
})

test("a window answers the diff window's hand-off only for a chat it holds, and acks once it is in the composer", () => {
  chat({ agent: { conversation: { providerId: 'claude', modelId: 'x' } } })
  const acks: string[] = []
  const request = { requestId: 'req-1', workspaceId: 'ws', text: QUOTE }
  // Another window holds this workspace: silent, so main asks that one.
  fixtures.state.workspaceWindows = [{ id: 'win-a', workspaceIds: ['other'] }]
  expect(answerDiffToChat(request, 'win-a', (id) => acks.push(id))).toBe(false)
  expect(acks).toEqual([])
  expect(fixtures.drafts.size).toBe(0)
  // This one holds it: the quote is set into the chat, the chat comes forward, and then the ack.
  fixtures.state.workspaceWindows = [{ id: 'win-b', workspaceIds: ['ws'] }]
  expect(answerDiffToChat(request, 'win-b', (id) => acks.push(id))).toBe(true)
  expect(fixtures.drafts.get('ws/agent')?.text).toContain('src/a.ts:L3')
  expect(fixtures.state.active).toEqual(['win-b:ws'])
  expect(acks).toEqual(['req-1'])
})

test('no ack for a workspace without a chat, so the diff window says nobody took it', () => {
  chat({ shell: { cli: 'claude-code' } })
  const acks: string[] = []
  expect(answerDiffToChat({ requestId: 'req-2', workspaceId: 'ws', text: QUOTE }, 'win', (id) => acks.push(id))).toBe(
    false,
  )
  expect(acks).toEqual([])
  expect(fixtures.state.active, 'and the window is not switched to it').toEqual([])
})

test('with several chats, the quote goes to the one with the keyboard, else one drawn, else the last active', () => {
  const conversation = { conversation: { providerId: 'claude', modelId: 'x' } }
  fixtures.state.workspaces = [{ id: 'ws', agents: { first: conversation, second: conversation, third: conversation } }]
  const inserted: string[] = []
  const view = (agentId: string, focused: boolean) =>
    registerMountedChatView({
      workspaceId: 'ws',
      agentId,
      isFocused: () => focused,
      toggleModelPicker: () => undefined,
      insertQuote: () => inserted.push(agentId),
    })
  // Nothing drawn: the one the workspace last worked with.
  fixtures.state.workspaces = [
    {
      id: 'ws',
      lastActiveAgentId: 'third',
      agents: { first: conversation, second: conversation, third: conversation },
    },
  ]
  expect(deliverQuoteToWorkspaceChat('ws', QUOTE)).toBe('third')
  // Drawn beats last active; the one with the keyboard beats drawn.
  const unregisterSecond = view('second', false)
  expect(deliverQuoteToWorkspaceChat('ws', QUOTE)).toBe('second')
  const unregisterFirst = view('first', true)
  try {
    expect(deliverQuoteToWorkspaceChat('ws', QUOTE)).toBe('first')
    expect(inserted).toEqual(['second', 'first'])
  } finally {
    unregisterFirst()
    unregisterSecond()
  }
})
