import type { ConversationImageAttachment } from '../../../../../shared/conversation-runtime'
import { attachmentCountLabel } from '../ComposerAttachmentStrip'
import { MAX_ATTACHMENTS_PER_TURN } from './imageAttachments'
import type { ComposerDraftMetadata } from './useComposerDraft'

// The chat composer's queue and commit rules (AgentChatView): what a message
// committed while the session is busy becomes, and what the send button says.

// Fold a commit made while the turn was locked into the waiting queued turn
// (D6/1776): text appends, images concatenate. Reports how many images the
// per-turn cap left behind so the composer can say so — a queue that quietly
// swallowed the tail of a paste would look like it had taken everything.
export function mergeQueuedTurn(
  previous: { text: string; attachments: ConversationImageAttachment[] } | null,
  text: string,
  attachments: ConversationImageAttachment[],
): { text: string; attachments: ConversationImageAttachment[]; dropped: number } {
  const previousText = previous?.text ?? ''
  const combined = [...(previous?.attachments ?? []), ...attachments]
  return {
    text: previousText && text ? `${previousText}\n${text}` : previousText || text,
    attachments: combined.slice(0, MAX_ATTACHMENTS_PER_TURN),
    dropped: Math.max(0, combined.length - MAX_ATTACHMENTS_PER_TURN),
  }
}

// A message that did not go out (a queued turn whose send was refused) back in
// the composer, ahead of whatever the person has typed since. Left only on the
// error's Retry, it was gone the moment anything cleared that error.
export function restoreRefusedText(current: string, text: string): string {
  if (!current || current === text) return text
  // Already back from an earlier refusal of the same message (a Retry that was
  // refused again): not stacked a second time.
  if (!text || current.startsWith(`${text}\n`)) return current
  return `${text}\n${current}`
}

// The composer once a Retry takes the refused message back out of it: what
// the person typed after it, or null when the message is not at its head.
export function draftAfterRetried(current: string, text: string): string | null {
  return text && current.startsWith(`${text}\n`) ? current.slice(text.length + 1) : null
}

// What the queued-turn row reads as. An image-only queued turn has no text to
// show, so the count is the label rather than an empty row.
export function queuedTurnLabel(text: string, attachmentCount: number): string {
  if (attachmentCount === 0) return text
  const images = attachmentCountLabel(attachmentCount)
  return text ? `${text} · ${images}` : images
}

export type PendingAction = 'starting' | 'sending' | 'stopping' | null

// A message committed while the session was busy, waiting for the turn to
// unlock (D6/1776). Attachments ride along so a queued image is not lost.
export type QueuedTurn = { text: string; attachments: ConversationImageAttachment[]; metadata: ComposerDraftMetadata }

// Fold what the composer holds into the queued turn — the one merge every
// queueing path makes, whether the message then waits or is sent at once.
export function queueComposerDraft(
  previous: QueuedTurn | null,
  text: string,
  attachments: ConversationImageAttachment[],
  metadata: ComposerDraftMetadata,
): { turn: QueuedTurn; dropped: number } {
  const { dropped, ...merged } = mergeQueuedTurn(previous, text, attachments)
  return {
    turn: {
      ...merged,
      metadata: {
        skillIds: [...new Set([...(previous?.metadata.skillIds ?? []), ...metadata.skillIds])],
        mentions: [...(previous?.metadata.mentions ?? []), ...metadata.mentions],
        files: [...new Set([...(previous?.metadata.files ?? []), ...metadata.files])],
      },
    },
    dropped,
  }
}

// The composer's note when the per-turn image cap trimmed a queued message.
export function queuedDropNotice(dropped: number): string | null {
  return dropped > 0
    ? `Only ${MAX_ATTACHMENTS_PER_TURN} images fit in one message — ${attachmentCountLabel(dropped)} were not queued.`
    : null
}

export function stopDisabledForPending(pending: PendingAction): boolean {
  return pending === 'stopping'
}

// Whether the session can accept a live send right now. The runtime rejects a
// new turn while its session is busy — `isSessionBusy` in
// src/main/conversation-runtime.ts, which is an open turn of any kind: the whole
// active turn, its awaiting-approval window, and a continuation turn the
// provider opened outside any send (1798). So a submit made while busy is queued
// and auto-sent on unlock (D6/1776) rather than fired as a live IPC that would
// error. Type-ahead into the textarea is always allowed; only the send/queue
// routing keys off this.
export function isConversationBusy(activeTurn: boolean, awaitingApproval: boolean, pending: PendingAction): boolean {
  return activeTurn || awaitingApproval || pending !== null
}

// The composer's one commit rule, shared by every affordance that can commit a
// turn — Enter, the send button, and the right-click menu's Send item (1793) —
// so the three can never disagree about whether a turn can be committed or
// whether committing sends now, queues or steers (D6/1776). Content is text OR staged
// images (D3/1774): an image-only message is sendable.
export function composerSendAction(options: {
  ready: boolean
  busy: boolean
  sending: boolean
  hasText: boolean
  attachmentCount: number
  /** What a commit does while busy, where the person's choice says (followUpDispatch.ts). */
  busyLabel?: string
}): { label: string; disabled: boolean } {
  return {
    label: options.sending ? 'Sending' : options.busy ? (options.busyLabel ?? 'Queue message') : 'Send message',
    disabled: !options.ready || (!options.hasText && options.attachmentCount === 0),
  }
}
