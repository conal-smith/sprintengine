import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { collectQuotes, mayHoldQuotes, type ChatQuote } from '../../../../../shared/chat-quotes'

/**
 * A quote's token in the composer's draft drawn as its chip: the token
 * (shared/chat-quotes.ts) is replaced on screen by an element the host fills,
 * and the range is atomic, so the caret steps over it and Backspace or Delete
 * takes it whole. The token is a markdown link, which the live preview
 * (markdownLivePreview.ts) would otherwise draw as one and show raw on the
 * caret's line; it leaves quote links to this, so a chip stays a chip wherever
 * the caret is.
 *
 * The chip's insides are React's (agentChat/chatQuotes.tsx), drawn by the
 * field through a portal into the element each widget makes, so the chip is
 * one component wherever it appears. A field with no host to fill them shows
 * the link's words.
 */
export type QuoteChipHosts = {
  /** An element to draw quote `quote` into has been made (or is now another quote's). */
  mount(element: HTMLElement, quote: ChatQuote): void
  /** The element has left the editor. */
  unmount(element: HTMLElement): void
}

class QuoteChipWidget extends WidgetType {
  constructor(
    readonly quote: ChatQuote,
    readonly token: string,
    readonly hosts: () => QuoteChipHosts | null,
  ) {
    super()
  }

  eq(other: QuoteChipWidget): boolean {
    return other.token === this.token
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'cm-quote-chip'
    this.fill(element)
    return element
  }

  updateDOM(element: HTMLElement): boolean {
    this.fill(element)
    return true
  }

  private fill(element: HTMLElement): void {
    element.dataset.quoteNumber = String(this.quote.n)
    const hosts = this.hosts()
    if (hosts) hosts.mount(element, this.quote)
    else element.textContent = `Quote ${this.quote.n}`
  }

  destroy(element: HTMLElement): void {
    this.hosts()?.unmount(element)
  }

  // The chip's own controls take their clicks; the editor neither moves the
  // caret into it nor starts a selection there.
  ignoreEvent(): boolean {
    return true
  }
}

function chips(state: EditorState, hosts: () => QuoteChipHosts | null): DecorationSet {
  const text = state.doc.toString()
  if (!mayHoldQuotes(text)) return Decoration.none
  const builder = new RangeSetBuilder<Decoration>()
  for (const quote of collectQuotes(text)) {
    const widget = new QuoteChipWidget(quote, text.slice(quote.from, quote.to), hosts)
    builder.add(quote.from, quote.to, Decoration.replace({ widget }))
  }
  return builder.finish()
}

/** The extension, reading the host that fills each chip through `hosts` when a chip is drawn. */
export function composerQuoteChips(hosts: () => QuoteChipHosts | null): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => chips(state, hosts),
    update: (value, transaction) => (transaction.docChanged ? chips(transaction.state, hosts) : value),
    provide: (self) => [
      EditorView.decorations.from(self),
      EditorView.atomicRanges.of((view) => view.state.field(self)),
    ],
  })
  return field
}
