// The working line from the moment a turn is asked for. The runtime draws its
// own once the turn starts, which for a chat's first message is after its CLI
// has started: until then the person's message stood alone, as if nothing
// had heard it. And a New chat's first message has been "Thinking…" since the
// chat opened, through its setup, so the turn's line counts on from there
// rather than starting again at nought.

import type { ConversationTimelineRow } from './conversationTimeline'
import { STARTING_WORKING_LABEL } from './pendingFirstMessage'

type WorkingRow = Extract<ConversationTimelineRow, { kind: 'working' }>

/** The last row this made, with what it was made from, so a re-derive with nothing new keeps its identity. */
export type RequestedTurnRowCache = { from: ConversationTimelineRow | null; at: number; row: WorkingRow } | null

/**
 * `rows` with the turn asked for at `requestedAt` drawn as working: under the
 * person's message while it is being sent (`sending`) and nothing answers it
 * yet, and on the runtime's own line, from `requestedAt`, once it does. Rows
 * are left as they are when no turn is asked for, or when what ends them is
 * neither.
 */
export function withRequestedTurn(
  rows: readonly ConversationTimelineRow[],
  requestedAt: number | null,
  sending: boolean,
  cache: { current: RequestedTurnRowCache },
): ConversationTimelineRow[] {
  const last = rows.at(-1)
  if (requestedAt === null || !last) return rows as ConversationTimelineRow[]
  const cached = cache.current
  if (last.kind === 'user' && sending) {
    const row =
      cached && cached.from === null && cached.at === requestedAt
        ? cached.row
        : ({
            kind: 'working',
            // The runtime's own line's id: when it comes, it takes this one's place.
            id: 'working-indicator-row',
            stage: 'thinking',
            label: STARTING_WORKING_LABEL,
            startedAt: requestedAt,
          } satisfies WorkingRow)
    cache.current = { from: null, at: requestedAt, row }
    return [...rows, row]
  }
  if (last.kind === 'working' && last.startedAt !== undefined && last.startedAt > requestedAt) {
    const row =
      cached && cached.from === last && cached.at === requestedAt ? cached.row : { ...last, startedAt: requestedAt }
    cache.current = { from: last, at: requestedAt, row }
    return [...rows.slice(0, -1), row]
  }
  return rows as ConversationTimelineRow[]
}
