// The message a person committed while the agent was working, as a row in the
// composer tray: "Queued", then the message on one line. It waits for the turn
// to end on its own; "Send now" hands it to the running turn instead (a
// steer), and Edit takes it back into the composer. A chat on another machine
// that holds its own queue has its rows drawn here too, from what that machine
// says it holds.

import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'
import { AttachmentThumbnail } from '../ComposerAttachmentStrip'
import { GhostButton, Tooltip, TruncatedText } from '../../ui'
import { ComposerTrayRow } from './composerTray'

export type QueuedTurnSendNow = {
  // `steer` delivers into the running turn; `interrupt` stops it, and the queue
  // sends the message the moment the session is free, as it always does.
  kind: 'steer' | 'interrupt'
  label: string
  disabled: boolean
  // Why the action is unavailable, for its tooltip; absent while it is.
  reason?: string
}

// What "send it now" can do for the queued message at this moment. A provider
// that takes a message mid-turn gets a steer; any other has only Stop, so the
// action says so rather than promising a delivery it cannot make. A card the
// agent is blocked on holds the message either way: the agent reads nothing
// until it is answered.
export function queuedTurnSendNow(options: {
  canSteer: boolean
  activeTurn: boolean
  awaitingApproval: boolean
  stopping: boolean
  steering: boolean
}): QueuedTurnSendNow {
  const kind = options.canSteer ? 'steer' : 'interrupt'
  const label = options.canSteer ? 'Send now' : 'Stop and send'
  const refuse = (reason: string): QueuedTurnSendNow => ({ kind, label, disabled: true, reason })
  if (options.awaitingApproval) return refuse('Answer the open request first — the agent is waiting on it.')
  if (options.steering) return refuse('The last message is still being delivered.')
  if (options.stopping) return refuse('The turn is stopping.')
  if (!options.activeTurn) return refuse('The turn is still starting.')
  return { kind, label, disabled: false }
}

// A dashed ring round a clock hand: something waiting its turn, on the
// lifecycle glyphs' 16-grid.
function QueuedGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="icon-sm shrink-0 text-[color:var(--text-subtle)]"
    >
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2.2 1.6" />
      <path d="M8 5.5v2.75l1.75 1.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

const counted = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * What a message the machine running the chat holds carries beside its words,
 * in a few words ("2 pictures, 1 file"), or null for one of words alone. Its
 * pictures and files are on that machine, so they are counted, not drawn.
 */
export function heldMessageCarries(message: {
  images?: readonly string[]
  files?: readonly string[]
  skills?: readonly string[]
  mentions?: readonly unknown[]
}): string | null {
  const parts = [
    message.images?.length ? counted(message.images.length, 'picture', 'pictures') : null,
    message.files?.length ? counted(message.files.length, 'file', 'files') : null,
    message.skills?.length ? counted(message.skills.length, 'skill', 'skills') : null,
    message.mentions?.length ? counted(message.mentions.length, 'mention', 'mentions') : null,
  ].filter((part): part is string => part !== null)
  return parts.length ? parts.join(', ') : null
}

export function QueuedTurnRow({
  text,
  attachments,
  carries,
  sendNow,
  shortcutLabel,
  onSendNow,
  onEdit,
  editHint = 'Take it back into the composer',
  status = 'Queued',
  statusHint = 'Sends when this turn ends',
  failed = false,
}: {
  text: string
  attachments: ConversationImageAttachment[]
  // What a held message carries that is not drawn here, in a few words.
  carries?: string | null
  // Null where the message cannot be sent sooner from here (one on its way
  // to the machine that will hold it, or one that machine could not send).
  sendNow: QueuedTurnSendNow | null
  // The chord that sends now from the composer, for the action's tooltip.
  shortcutLabel: string
  onSendNow: () => void
  // Absent where the message cannot be taken back from here.
  onEdit?: () => void
  // What Edit brings back, where that is less than the whole message.
  editHint?: string
  // What the row says of the message, and its tooltip. A message the machine
  // running the chat holds says so: it is that machine that sends it.
  status?: string
  statusHint?: string
  // The chat refused it when its turn came: said in the warning tone.
  failed?: boolean
}) {
  const sendNowHint = sendNow
    ? (sendNow.reason ??
      (sendNow.kind === 'steer'
        ? `Give this to the agent while it works (${shortcutLabel})`
        : `Stop the reply and send this instead (${shortcutLabel})`))
    : null
  return (
    <ComposerTrayRow
      role="group"
      ariaLabel="Queued message"
      tone={failed ? 'warn' : 'neutral'}
      glyph={failed ? undefined : <QueuedGlyph />}
      actions={
        sendNow || onEdit ? (
          <>
            {sendNow ? (
              <Tooltip content={sendNowHint ?? sendNow.label} placement="top">
                <GhostButton size="xs" disabled={sendNow.disabled} onClick={onSendNow}>
                  {sendNow.label}
                </GhostButton>
              </Tooltip>
            ) : null}
            {onEdit ? (
              <Tooltip content={editHint} placement="top">
                <GhostButton size="xs" onClick={onEdit}>
                  Edit
                </GhostButton>
              </Tooltip>
            ) : null}
          </>
        ) : null
      }
    >
      <span className="flex min-w-0 items-center gap-2">
        <Tooltip content={statusHint} placement="top">
          <span className="shrink-0">{status}</span>
        </Tooltip>
        {attachments.map((attachment) => (
          <AttachmentThumbnail key={attachment.id} attachment={attachment} className="size-icon-md shrink-0" />
        ))}
        {carries ? <span className="shrink-0 text-meta text-[color:var(--text-subtle)]">{carries}</span> : null}
        {text ? (
          <TruncatedText as="span" text={text} className="min-w-0 text-meta italic text-[color:var(--text-muted)]" />
        ) : null}
      </span>
    </ComposerTrayRow>
  )
}
