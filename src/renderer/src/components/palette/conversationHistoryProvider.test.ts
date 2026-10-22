import { afterEach, expect, test, vi } from 'vitest'
import type { ConversationSearchHit } from '../../../../shared/conversation-index'
import { createConversationHistoryProvider, type SearchableChat } from './conversationHistoryProvider'
import { openConversationMatch } from '../../utils/conversationHistoryNavigation'

vi.mock('../../utils/conversationHistoryNavigation', () => ({ openConversationMatch: vi.fn(async () => true) }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const chat = (id: string, root = '/Users/dev/app'): SearchableChat => ({
  workspaceId: id,
  workspaceRoot: root,
  name: `Chat ${id}`,
  mode: 'standard' as SearchableChat['mode'],
})
const context = { workspaceRoot: '/Users/dev/app', workspaceId: 'one', scope: 'conversations' as const, close: vi.fn() }
const hit = (seq: number, snippet: string, from: ConversationSearchHit['from'] = 'agent'): ConversationSearchHit => ({
  agentId: 'agent',
  seq,
  snippet,
  from,
})

test('every chat the sidebar lists is searched, and a chat is one row however many of its messages match', async () => {
  const search = vi.fn(async ({ workspaceId }: { workspaceId: string; workspaceRoot: string }) => ({
    ok: true as const,
    hits:
      workspaceId === 'one'
        ? [hit(3, 'the wave model'), hit(9, 'is the wave model right?', 'person'), hit(12, 'wave again')]
        : workspaceId === 'two'
          ? [hit(5, 'a wave forecast')]
          : [],
  }))
  vi.stubGlobal('window', { api: { conversationSearch: search, conversationCancelSearch: vi.fn(async () => {}) } })
  const rows = await createConversationHistoryProvider({
    getChats: () => [chat('one'), chat('two', '/Users/dev/other'), chat('three')],
  }).load('wave', context)

  expect(search.mock.calls.map(([input]) => [input.workspaceId, input.workspaceRoot])).toEqual([
    ['one', '/Users/dev/app'],
    ['two', '/Users/dev/other'],
    ['three', '/Users/dev/app'],
  ])
  expect(rows.map((row) => row.id)).toEqual(['switch-one', 'switch-two'])
  // The person's own words outrank the agent's, then the newest.
  expect(rows[0].conversationMatch).toEqual({ snippet: 'is the wave model right?', from: 'person', count: 3 })
  expect(rows[0].mark).toEqual({ kind: 'chat', workspaceId: 'one', mode: 'standard' })

  rows[0].run()
  expect(context.close).toHaveBeenCalledOnce()
  expect(openConversationMatch).toHaveBeenCalledWith({
    workspaceRoot: '/Users/dev/app',
    workspaceId: 'one',
    agentId: 'agent',
    seq: 9,
  })
})

test('a chat whose history cannot be read costs its own matches, not the others', async () => {
  vi.stubGlobal('window', {
    api: {
      conversationSearch: async ({ workspaceId }: { workspaceId: string }) =>
        workspaceId === 'broken'
          ? { ok: false as const, message: 'Conversation storage must be a real directory.' }
          : { ok: true as const, hits: [hit(1, 'wave')] },
      conversationCancelSearch: vi.fn(async () => {}),
    },
  })
  const rows = await createConversationHistoryProvider({ getChats: () => [chat('broken'), chat('fine')] }).load(
    'wave',
    context,
  )
  expect(rows.map((row) => row.id)).toEqual(['switch-fine'])

  // Every chat failing is a failure, not "no matches".
  await expect(
    createConversationHistoryProvider({ getChats: () => [chat('broken')] }).load('wave', context),
  ).rejects.toThrow('real directory')
})

test('superseding a search cancels the chat in flight and searches no further', async () => {
  let resolve!: (value: unknown) => void
  const cancel = vi.fn(async () => undefined)
  const search = vi.fn(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  vi.stubGlobal('window', { api: { conversationSearch: search, conversationCancelSearch: cancel } })
  const provider = createConversationHistoryProvider({ getChats: () => [chat('one'), chat('two')] })
  const pending = provider.load('wave', context)
  await vi.waitFor(() => expect(resolve).toBeDefined())
  provider.cancel?.()
  expect(cancel).toHaveBeenCalledWith({ requestId: expect.any(String) })
  resolve({ ok: true, hits: [hit(1, 'wave')] })
  expect(await pending).toEqual([])
  expect(search).toHaveBeenCalledOnce()
})

test('batches publish rows as a chat is read, and only the batches of the search in flight count', async () => {
  let receive!: (batch: { requestId: string; hits: ConversationSearchHit[] }) => void
  const stop = vi.fn()
  const publish = vi.fn()
  vi.stubGlobal('window', {
    api: {
      onConversationSearchBatch: (callback: typeof receive) => {
        receive = callback
        return stop
      },
      conversationSearch: async ({ requestId }: { requestId: string }) => {
        receive({ requestId: 'another-window', hits: [hit(1, 'wave elsewhere')] })
        receive({ requestId, hits: [hit(2, 'first wave')] })
        expect(publish).toHaveBeenCalledTimes(1)
        expect(publish.mock.calls[0][0][0].conversationMatch.count).toBe(1)
        // The final answer is the whole list, batches included.
        return { ok: true as const, hits: [hit(2, 'first wave'), hit(4, 'second wave')] }
      },
    },
  })
  const rows = await createConversationHistoryProvider({ getChats: () => [chat('one')] }).load('wave', context, publish)
  expect(rows).toHaveLength(1)
  expect(rows[0].conversationMatch?.count).toBe(2)
  expect(stop).toHaveBeenCalledOnce()
})

test('it waits for a second character and for a pause in typing', () => {
  const provider = createConversationHistoryProvider({ getChats: () => [] })
  expect(provider.minQueryLength).toBe(2)
  expect(provider.respondsToEmptyQuery).toBeFalsy()
  expect(provider.debounceMs).toBeGreaterThan(0)
})
