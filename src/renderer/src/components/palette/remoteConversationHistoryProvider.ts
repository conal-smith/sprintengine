import type { MeshConversationSearchResult } from '../../../../shared/tailnet-mesh'
import {
  openRemoteChatAtMatch,
  remoteSearchMachines,
  type RemoteSearchMachine,
} from '../workspace/remoteBand/remoteChatSearch'
import { CONVERSATION_SEARCH_MIN_QUERY } from './conversationHistoryProvider'
import { bestConversationHit } from './conversationSnippet'
import type { PaletteCommand, PaletteResultProvider } from './paletteProvider'

// What was said in the paired machines' chats, beside this computer's
// (`conversationHistoryProvider.ts`): each machine that takes a search from
// here (`chat-search`) is asked once for the question, and answers as its own
// palette would, one row per chat. A row opens the chat here, following it,
// at the matching message.

const REMOTE_SEARCH_DEBOUNCE_MS = 300

export function remoteConversationMatchRowId(connectionId: string, workspaceId: string): string {
  return `remote-conversation-match:${connectionId}:${workspaceId}`
}

export function createRemoteConversationHistoryProvider(
  options: { getMachines?: () => readonly RemoteSearchMachine[] } = {},
): PaletteResultProvider {
  const getMachines = options.getMachines ?? remoteSearchMachines
  let generation = 0
  return {
    id: 'remote-conversation-history',
    group: 'agents',
    debounceMs: REMOTE_SEARCH_DEBOUNCE_MS,
    minQueryLength: CONVERSATION_SEARCH_MIN_QUERY,
    cancel: () => {
      generation++
    },
    async load(query, context, publish) {
      const epoch = ++generation
      if (typeof window.api.meshConversationSearch !== 'function') return []
      const rows: PaletteCommand[] = []
      let failure: string | null = null
      let answered = false
      for (const machine of getMachines()) {
        const found: MeshConversationSearchResult = await window.api
          .meshConversationSearch({ connectionId: machine.connectionId, query })
          .catch((error: unknown) => ({ ok: false as const, code: 'failed', message: String(error) }))
        if (epoch !== generation) return []
        // A machine that cannot answer costs its own rows, not every other's.
        if (!found.ok) {
          failure ??= found.message
          continue
        }
        answered = true
        for (const chat of found.chats) {
          const best = bestConversationHit(chat.hits)
          if (!best) continue
          rows.push({
            id: remoteConversationMatchRowId(machine.connectionId, chat.workspaceId),
            label: chat.chatTitle,
            keywords: best.snippet,
            group: 'agents',
            mark: { kind: 'remote' },
            badge: machine.machineName,
            conversationMatch: { snippet: best.snippet, ...(best.from ? { from: best.from } : {}), count: chat.count },
            run: () => {
              context.close()
              openRemoteChatAtMatch({
                connectionId: machine.connectionId,
                workspaceId: chat.workspaceId,
                agentId: best.agentId,
                seq: best.seq,
              })
            },
          })
        }
        publish?.([...rows])
      }
      if (!answered && failure) throw new Error(failure)
      return rows
    },
  }
}
