// The composer tray's rows for the messages a person scheduled into this chat:
// when each goes out, and the message on one line. Send now sends it at once,
// Edit takes it back into the composer (still set for its time), Delete lets
// it go. One the chat refused says why, with Retry. Main keeps them and sends
// them (src/main/scheduled-messages/scheduled-messages.ts); this only draws
// one chat's. A chat on a paired machine draws the same rows from what that
// machine says it keeps for the chat (`scheduled` frames), and each button
// asks that machine.

import { memo, useEffect, type JSX } from 'react'

import { useRelativeNow } from '../../../hooks/useRelativeNow'
import {
  retainScheduledMessages,
  updateScheduledMessage,
  useScheduledMessagesStore,
} from '../../../store/scheduledMessagesStore'
import {
  selectChatScheduledMessages,
  type ScheduledMessage,
  type ScheduledMessageCarries,
} from '../../../../../shared/scheduled-messages'
import { ScheduleGlyph } from '../../AppIcons'
import { GhostButton, Tooltip, TruncatedText } from '../../ui'
import { sendTimeFromNow, sendTimeWords } from '../../workspace/agentComposer/schedule/sendTime'
import { ComposerTrayRow } from './composerTray'
import { heldMessageCarries } from './queuedTurnBubble'

/** What a row draws of a scheduled message, wherever it is kept. */
export type ScheduledMessageView = Pick<
  ScheduledMessage,
  'id' | 'text' | 'sendAt' | 'waitingSince' | 'sending' | 'failure'
>

/** What the row says of when the message goes: "Sends Today 3:00 PM", "Sending…". */
export function scheduledMessageStatus(message: ScheduledMessageView, now: number): string {
  if (message.sending) return 'Sending…'
  if (message.failure !== undefined) {
    const reason = message.failure.trim().replace(/\.$/u, '')
    return `Couldn't send: ${reason ? reason.charAt(0).toLowerCase() + reason.slice(1) : 'the chat refused it'}.`
  }
  if (message.waitingSince !== undefined) return 'Sends when this turn ends'
  return `Sends ${sendTimeWords(message.sendAt, now)}`
}

function ScheduledMessageRowsBody({
  workspaceId,
  agentId,
  onEdit,
}: {
  workspaceId: string
  agentId: string
  /** Take the message back into the composer, still set to go at its time. */
  onEdit: (message: ScheduledMessage) => void
}): JSX.Element | null {
  useEffect(() => retainScheduledMessages(), [])
  const state = useScheduledMessagesStore((store) => store.state)
  const messages = selectChatScheduledMessages(state, { workspaceId, agentId })
  return (
    <ScheduledMessageRowList
      messages={messages}
      onSendNow={(message) => void updateScheduledMessage({ kind: 'send-now', id: message.id })}
      onEdit={onEdit}
      onDelete={(message) => void updateScheduledMessage({ kind: 'delete', id: message.id })}
    />
  )
}

/**
 * The rows themselves, for messages kept anywhere: this computer's, or a
 * paired machine's for a chat that runs there. `machineName` names that
 * machine in each row's hint.
 */
export function ScheduledMessageRowList<Message extends ScheduledMessageView>({
  messages,
  onSendNow,
  onEdit,
  onDelete,
  machineName,
}: {
  messages: readonly Message[]
  onSendNow: (message: Message) => void
  onEdit: (message: Message) => void
  onDelete: (message: Message) => void
  machineName?: string
}): JSX.Element | null {
  // A minute's resolution: "Today 3:00 PM" turns into "Tomorrow" at midnight.
  const now = useRelativeNow(30_000, messages.length > 0)
  if (messages.length === 0) return null
  return (
    <>
      {messages.map((message) => {
        const failed = message.failure !== undefined
        const fromNow =
          !failed && !message.sending && !message.waitingSince ? sendTimeFromNow(message.sendAt, now) : null
        return (
          <ComposerTrayRow
            key={message.id}
            tone={failed ? 'warn' : 'neutral'}
            role="group"
            ariaLabel="Scheduled message"
            glyph={failed ? undefined : <ScheduleGlyph className="icon-sm shrink-0 text-[color:var(--text-subtle)]" />}
            actions={
              message.sending ? null : (
                <>
                  <GhostButton size="xs" onClick={() => onSendNow(message)}>
                    {failed ? 'Retry' : 'Send now'}
                  </GhostButton>
                  <Tooltip content="Take it back into the composer" placement="top">
                    <GhostButton size="xs" onClick={() => onEdit(message)}>
                      Edit
                    </GhostButton>
                  </Tooltip>
                  <GhostButton size="xs" onClick={() => onDelete(message)}>
                    Delete
                  </GhostButton>
                </>
              )
            }
          >
            <span className="flex min-w-0 items-center gap-2">
              {fromNow ? (
                <Tooltip
                  content={
                    machineName
                      ? `${new Date(message.sendAt).toLocaleString()}, sent by ${machineName}`
                      : new Date(message.sendAt).toLocaleString()
                  }
                  placement="top"
                >
                  <span className="shrink-0" aria-label={`${scheduledMessageStatus(message, now)}, ${fromNow}`}>
                    {scheduledMessageStatus(message, now)}
                  </span>
                </Tooltip>
              ) : (
                <span className="shrink-0">{scheduledMessageStatus(message, now)}</span>
              )}
              {/* A held message a paired machine handed over says what it
                  carries beside its words, which this machine keeps for it. */}
              {'carries' in message && message.carries ? (
                <span className="shrink-0 text-meta text-[color:var(--text-subtle)]">
                  {heldMessageCarries(message.carries as ScheduledMessageCarries)}
                </span>
              ) : null}
              <TruncatedText
                as="span"
                text={message.text}
                className="min-w-0 text-meta italic text-[color:var(--text-muted)]"
              />
            </span>
          </ComposerTrayRow>
        )
      })}
    </>
  )
}

// Memoised: the chat body commits on every streamed token, and these rows
// change only when main says so, through its store.
export const ScheduledMessageRows = memo(ScheduledMessageRowsBody)

// Memoised for the same reason: a paired machine's rows change only when it
// says so, in a `scheduled` frame.
export const HostScheduledMessageRows = memo(ScheduledMessageRowList) as typeof ScheduledMessageRowList
