import type { ConversationSearchHit } from '../../../../shared/conversation-index'
import type { Workspace } from '../../types/workspace'
import { workspaceSwitchRowId } from '../commandPaletteSearch'
import { openConversationMatch } from '../../utils/conversationHistoryNavigation'
import { bestConversationHit } from './conversationSnippet'
import type { PaletteCommand, PaletteResultProvider } from './paletteProvider'

/** A chat whose transcripts the palette searches: the sidebar's row, by the store it is kept in. */
export type SearchableChat = {
  workspaceId: string
  workspaceRoot: string
  name: string
  mode: Workspace['mode']
}

// Every row is one chat, however many of its messages matched, so the list
// stops well before it is the sidebar again.
export const CONVERSATION_MATCH_CHAT_LIMIT = 50
// A single letter matches nearly every message ever written, and each search
// reads every transcript the sidebar lists. The titles still answer from the
// first letter; what was said waits for a second.
export const CONVERSATION_SEARCH_MIN_QUERY = 2
const CONVERSATION_SEARCH_DEBOUNCE_MS = 200

/**
 * What was said in the chats the sidebar lists, one row per chat.
 *
 * It used to search the open chat's own transcripts and list every matching
 * message as a row of its own: the chat you were in, four times over, under
 * its first message's title, while the chat you were looking for — in another
 * project — was never read. A chat is one row now, wearing the message that
 * matched (the person's own words first, then the newest) and how many others
 * did; the palette folds it into the chat's switch row when that matched too.
 *
 * The chats are searched one at a time, most recently spoken in first, so the
 * likely answer is on screen while the rest are read, and a superseded run
 * stops at the chat it is in.
 */
export function createConversationHistoryProvider(options: {
  getChats: () => readonly SearchableChat[]
}): PaletteResultProvider {
  let requestId: string | null = null
  let generation = 0
  let stopBatches: (() => void) | undefined
  const cancel = (): void => {
    generation++
    stopBatches?.()
    stopBatches = undefined
    if (requestId) void window.api.conversationCancelSearch({ requestId }).catch(() => undefined)
    requestId = null
  }
  return {
    id: 'conversation-history',
    group: 'agents',
    debounceMs: CONVERSATION_SEARCH_DEBOUNCE_MS,
    minQueryLength: CONVERSATION_SEARCH_MIN_QUERY,
    cancel,
    async load(query, context, publish) {
      cancel()
      if (typeof window.api.conversationSearch !== 'function') return []
      const epoch = generation
      const found = new Map<string, { chat: SearchableChat; hits: ConversationSearchHit[] }>()
      const rows = (): PaletteCommand[] =>
        [...found.values()].flatMap(({ chat, hits }) => {
          const best = bestConversationHit(hits)
          if (!best) return []
          return [
            {
              // The chat's own row id: the palette folds this into the switch
              // row when both are up, and a row that keeps its id as matches
              // stream in keeps the highlight on it.
              id: workspaceSwitchRowId(chat.workspaceId),
              label: chat.name,
              keywords: best.snippet,
              group: 'agents',
              mark: { kind: 'chat', workspaceId: chat.workspaceId, mode: chat.mode },
              conversationMatch: { snippet: best.snippet, from: best.from, count: hits.length },
              run: () => {
                context.close()
                void openConversationMatch({
                  workspaceRoot: chat.workspaceRoot,
                  workspaceId: chat.workspaceId,
                  agentId: best.agentId,
                  seq: best.seq,
                })
              },
            },
          ]
        })
      let searching: SearchableChat | null = null
      stopBatches = window.api.onConversationSearchBatch?.((batch) => {
        if (epoch !== generation || batch.requestId !== requestId || !searching) return
        const entry = found.get(searching.workspaceId)
        if (entry) entry.hits.push(...batch.hits)
        else found.set(searching.workspaceId, { chat: searching, hits: [...batch.hits] })
        publish?.(rows())
      })
      let failure: string | null = null
      let answered = false
      try {
        for (const chat of options.getChats()) {
          if (found.size >= CONVERSATION_MATCH_CHAT_LIMIT) break
          const id = crypto.randomUUID()
          requestId = id
          searching = chat
          const search = await window.api
            .conversationSearch({
              workspaceRoot: chat.workspaceRoot,
              workspaceId: chat.workspaceId,
              query,
              requestId: id,
            })
            .catch((error: unknown) => ({ ok: false as const, message: String(error) }))
          if (epoch !== generation) return []
          // One chat whose history cannot be read costs its own matches, not
          // every other chat's.
          if (!search.ok) {
            failure ??= search.message
            found.delete(chat.workspaceId)
            continue
          }
          answered = true
          // The answer is the whole list; the batches were its first part.
          if (search.hits.length > 0) found.set(chat.workspaceId, { chat, hits: search.hits })
          else found.delete(chat.workspaceId)
          publish?.(rows())
        }
        if (!answered && failure) throw new Error(failure)
        return rows()
      } finally {
        if (epoch === generation) {
          requestId = null
          searching = null
          stopBatches?.()
          stopBatches = undefined
        }
      }
    },
  }
}
