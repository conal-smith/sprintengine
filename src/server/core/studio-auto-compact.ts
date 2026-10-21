import type {
  ConversationEvent,
  ConversationEventType,
  ConversationMessageOrigin,
  ConversationSessionSummary,
} from '../../shared/conversation-runtime'
import { isSettledWorkspace } from '../../shared/workspace-lifecycle'
import type { ConversationGatewayHost } from '../../main/automation/tailnet/tailnet-conversation-host'
import {
  AUTO_COMPACT_CLIENT_ID,
  createAutoCompactScheduler,
  type AutoCompactScheduler,
} from '../../main/conversation-auto-compact'

// The Studio core's auto compaction (main/conversation-auto-compact.ts), wired
// to what the core holds: its chats and their events, the registry's records,
// the app-wide default, and a conversation host whose sends are Studio's own.
// Kept apart from the core's composition so the wiring is tested as the core
// builds it.

/** How a chat records the compaction: Studio's, sent before its cache expired. */
export const AUTO_COMPACT_ORIGIN: ConversationMessageOrigin = { kind: 'studio', reason: 'auto-compact' }

/** What is sent: Claude Code's own compaction, which the chat draws as its divider. */
const COMPACT_COMMAND = '/compact'

// The events that can move what the scheduler decides: a reading, a turn
// starting or ending, the work a chat runs in the background, a session
// coming or going. Streamed text and tool output move nothing it reads.
const RELEVANT_EVENTS: ReadonlySet<ConversationEventType> = new Set<ConversationEventType>([
  'session_started',
  'session_ready',
  'session_updated',
  'session_closed',
  'user_message',
  'turn_started',
  'usage_updated',
  'context_compacted',
  'context_handed_off',
  'approval_requested',
  'approval_resolved',
  'subagent_status',
  'turn_completed',
  'turn_failed',
])

// Events come in bursts; one look after the burst is enough.
const RECOMPUTE_DEBOUNCE_MS = 250

export type StudioAutoCompactDeps = {
  conversations: {
    listSessions(): { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message?: string }
    onEvent(listener: (event: ConversationEvent) => void): () => void
  }
  /** A workspace's record: its chats, whether it is settled, its Auto compact choice, a paired machine's origin. */
  workspaceRecord: (workspaceId: string) => {
    settledAt?: number | null
    autoCompactEnabled?: boolean | null
    remoteOrigin?: unknown
    agents: Record<string, unknown>
  } | null
  enabledByDefault: () => boolean
  /** A conversation host whose sends carry `origin` and stamp no one's message clock. */
  createHost: (options: { origin: ConversationMessageOrigin }) => Pick<ConversationGatewayHost, 'resolveKey' | 'command'>
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  log?: (message: string) => void
}

export function createStudioAutoCompact(deps: StudioAutoCompactDeps): AutoCompactScheduler {
  let host: ReturnType<StudioAutoCompactDeps['createHost']> | null = null
  const setTimer = deps.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const scheduler = createAutoCompactScheduler({
    listSessions: () => {
      const listed = deps.conversations.listSessions()
      return listed.ok ? listed.sessions : []
    },
    chat: (workspaceId, agentId) => {
      const record = deps.workspaceRecord(workspaceId)
      if (!record || !Object.hasOwn(record.agents, agentId)) return null
      return {
        autoCompactEnabled: typeof record.autoCompactEnabled === 'boolean' ? record.autoCompactEnabled : null,
        settled: isSettledWorkspace(record),
        remote: Boolean(record.remoteOrigin),
      }
    },
    enabledByDefault: deps.enabledByDefault,
    // Through the same send a paired device's goes, which resumes a chat
    // whose child the idle sweep ended, marked as Studio's.
    send: async (session, commandId) => {
      host ??= deps.createHost({ origin: AUTO_COMPACT_ORIGIN })
      const key = host.resolveKey(session.workspaceId, session.agentId)
      if (!key) return { ok: false, message: 'The chat has no folder on this machine' }
      const answer = await host.command(key, AUTO_COMPACT_CLIENT_ID, commandId, {
        kind: 'send',
        message: COMPACT_COMMAND,
      })
      return answer.ok ? { ok: true } : { ok: false, message: answer.message }
    },
    ...(deps.now ? { now: deps.now } : {}),
    setTimer,
    clearTimer,
    ...(deps.log ? { log: deps.log } : {}),
  })
  let pending: unknown = null
  const stopListening = deps.conversations.onEvent((event) => {
    if (!RELEVANT_EVENTS.has(event.type) || pending !== null) return
    pending = setTimer(() => {
      pending = null
      scheduler.recompute()
    }, RECOMPUTE_DEBOUNCE_MS)
    ;(pending as { unref?: () => void } | null)?.unref?.()
  })
  return {
    recompute: scheduler.recompute,
    armed: scheduler.armed,
    dispose() {
      stopListening()
      if (pending !== null) clearTimer(pending)
      pending = null
      scheduler.dispose()
    },
  }
}
