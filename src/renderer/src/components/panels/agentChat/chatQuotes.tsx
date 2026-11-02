import { createContext, useContext, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import { parseQuoteHref, quoteAsReadableMarkdown, quoteLabel, type ChatQuote } from '../../../../../shared/chat-quotes'
import { renderMarkdown } from '../../../utils/markdown'
import { CheckIcon } from '../../AppIcons'
import { IconButton, Textarea, Tooltip } from '../../ui'
import { EditChangelistGlyph } from '../../ui/GitActionGlyphs'
import { LinkButton, QuoteLinkButton } from '../../ui/LinkButton'
import { PointerPopover } from '../../ui/PointerPopover'
import { QuoteGlyph } from '../../ui/QuoteGlyph'

// The pieces a quote is drawn with (shared/chat-quotes.ts is what it is):
//
// - the chip, in the composer and in the sent message alike — its number, the
//   quote mark and a label (the comment, or the start of the passage), in the
//   quote's gold, reading as words in the sentence rather than as a control
//   set into it. A click shows the quote; in the composer a pencil after it
//   edits the comment;
// - the popover a click on the chip opens: the passage, muted, the comment,
//   and "Go to source", which takes the transcript to the reply;
// - the comment editor, opened under the cited words as a quote is made and
//   again from the pencil: one borderless field and a check.

/** Gap between what an overlay is opened from and the overlay. */
const OVERLAY_GAP = 6

/** What a sent message's chips may ask of the chat they are drawn in. */
type ChatQuoteActions = {
  /** Take the transcript to the reply a quote came from, and light the passage. */
  goToSource: (quote: ChatQuote) => void
}

const ChatQuoteActionsContext = createContext<ChatQuoteActions | null>(null)
export const ChatQuoteActionsProvider = ChatQuoteActionsContext.Provider

/**
 * A quote as a chip. `onEdit` adds the pencil, which only the composer's chips
 * carry: what was sent is not edited.
 */
export function QuoteChip({
  quote,
  onEdit,
  onGoToSource,
}: {
  quote: ChatQuote
  onEdit?: (anchor: HTMLElement) => void
  onGoToSource?: (quote: ChatQuote) => void
}): JSX.Element {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null)
  const label = quoteLabel(quote)
  return (
    <span
      data-quote-chip={quote.n}
      // Copied out of a sent message, the chip is the quote as words.
      data-copy-markdown={quoteAsReadableMarkdown(quote)}
      className="whitespace-nowrap text-[color:var(--sem-color-quote-ink)]"
    >
      <QuoteLinkButton
        size="inherit"
        aria-label={`Quote ${quote.n}: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setOpen({ x: rect.left, y: rect.bottom + OVERLAY_GAP })
        }}
      >
        <span
          aria-hidden="true"
          className="mr-1 inline-block rounded-xs bg-[color:var(--sem-color-quote-tint)] px-0.5 align-[0.1em] text-micro font-medium leading-none tabular-nums"
        >
          {quote.n}
        </span>
        <QuoteGlyph className="icon-xs mr-0.5 inline-block align-[-0.1em]" />
        <span className="inline-block max-w-[16em] truncate align-bottom">{label}</span>
      </QuoteLinkButton>
      {onEdit ? (
        <Tooltip content="Edit comment">
          <IconButton
            size="inline"
            aria-label={`Edit comment on quote ${quote.n}`}
            className="ml-0.5 align-[-0.15em]"
            onClick={(event) => onEdit(event.currentTarget)}
          >
            <EditChangelistGlyph className="icon-xs" />
          </IconButton>
        </Tooltip>
      ) : null}
      {open ? (
        <QuotePopover
          quote={quote}
          x={open.x}
          y={open.y}
          onClose={() => setOpen(null)}
          {...(onGoToSource
            ? {
                onGoToSource: () => {
                  setOpen(null)
                  onGoToSource(quote)
                },
              }
            : {})}
        />
      ) : null}
    </span>
  )
}

/**
 * A chip as a sent message draws one, from the address of the link the
 * message's markdown holds. Null for an address that is not a readable quote,
 * which the message then shows as the link's words.
 */
export function SentQuoteChip({ href }: { href: string }): JSX.Element | null {
  const actions = useContext(ChatQuoteActionsContext)
  const quote = parseQuoteHref(href)
  if (!quote) return null
  return <QuoteChip quote={quote} {...(actions ? { onGoToSource: actions.goToSource } : {})} />
}

/** What a click on a chip shows: the passage, the comment, and the way back to the reply. */
export function QuotePopover({
  quote,
  x,
  y,
  onClose,
  onGoToSource,
}: {
  quote: ChatQuote
  x: number
  y: number
  onClose: () => void
  onGoToSource?: () => void
}): JSX.Element {
  const comment = quote.comment.trim()
  return (
    <PointerPopover x={x} y={y} ariaLabel={`Quote ${quote.n}`} popupRole="dialog" onClose={onClose}>
      <div data-quote-popover={quote.n} className="flex w-[24rem] max-w-[calc(100vw-2rem)] flex-col gap-2 p-3">
        <blockquote className="max-h-48 overflow-y-auto border-l-2 border-[color:var(--border-default)] pl-2.5">
          {renderMarkdown(quote.quote, { density: 'chat-compact', tone: 'muted', userText: true })}
        </blockquote>
        {comment ? (
          <p className="whitespace-pre-wrap break-words text-body text-[color:var(--text-default)]">{comment}</p>
        ) : null}
        {onGoToSource ? (
          <div className="flex justify-end">
            <LinkButton onClick={onGoToSource}>Go to source</LinkButton>
          </div>
        ) : null}
      </div>
    </PointerPopover>
  )
}

/**
 * The comment on a quote, being written: under the cited words, or under its
 * chip when the reply is not drawn. Enter saves, ⌘/Ctrl+Enter saves and sends
 * the message, Shift+Enter is a new line, Escape lets it go — and a quote
 * just made goes with it, since Escape on the editor that opened with it is
 * changing one's mind about the quote. A click anywhere else keeps what was
 * typed.
 */
export function QuoteCommentEditor({
  n,
  initial,
  anchor,
  onSave,
  onCancel,
}: {
  n: number
  initial: string
  anchor: { left: number; bottom: number }
  onSave: (comment: string, send: boolean) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState(initial)
  const valueRef = useRef(initial)
  valueRef.current = value
  // One answer per editor: a save that unmounts it must not be followed by
  // the outside press its own button counted as.
  const doneRef = useRef(false)
  const finish = (action: () => void) => {
    if (doneRef.current) return
    doneRef.current = true
    action()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      finish(onCancel)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return
    event.preventDefault()
    const send = event.metaKey || event.ctrlKey
    finish(() => onSave(valueRef.current, send))
  }
  return (
    <PointerPopover
      x={anchor.left}
      y={anchor.bottom + OVERLAY_GAP}
      ariaLabel={`Comment on quote ${n}`}
      popupRole="dialog"
      onClose={() => finish(() => onSave(valueRef.current, false))}
    >
      <div data-quote-editor={n} className="flex w-[20rem] max-w-[calc(100vw-2rem)] flex-col gap-1 p-2">
        <Textarea
          variant="composer"
          resize="none"
          rows={1}
          autoFocus
          aria-label={`Comment on quote ${n}`}
          placeholder="Add an optional comment…"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-40 overflow-y-auto px-1 text-body"
        />
        <div className="flex justify-end">
          <Tooltip content="Save">
            <IconButton size="2xs" aria-label="Save" onClick={() => finish(() => onSave(valueRef.current, false))}>
              <CheckIcon className="icon-sm" />
            </IconButton>
          </Tooltip>
        </div>
      </div>
    </PointerPopover>
  )
}
