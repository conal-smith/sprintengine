import { RangeSetBuilder, StateField, type EditorState, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { collectQuotes, mayHoldQuotes, QUOTE_SCHEME, type ChatQuoteToken } from '../../../../../shared/chat-quotes'

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
  /** An element to draw `quote` into has been made (or is now another quote's). */
  mount(element: HTMLElement, quote: ChatQuoteToken): void
  /** The element has left the editor. */
  unmount(element: HTMLElement): void
}

class QuoteChipWidget extends WidgetType {
  constructor(
    readonly quote: ChatQuoteToken,
    readonly hosts: () => QuoteChipHosts | null,
  ) {
    super()
  }

  eq(other: QuoteChipWidget): boolean {
    return other.quote.token === this.quote.token
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

type Chips = { decorations: DecorationSet; holdsScheme: boolean }

function chips(state: EditorState, hosts: () => QuoteChipHosts | null): Chips {
  const text = state.doc.toString()
  if (!mayHoldQuotes(text)) return { decorations: Decoration.none, holdsScheme: false }
  const builder = new RangeSetBuilder<Decoration>()
  for (const quote of collectQuotes(text))
    builder.add(quote.from, quote.to, Decoration.replace({ widget: new QuoteChipWidget(quote, hosts) }))
  return { decorations: builder.finish(), holdsScheme: true }
}

// A token never spans a line, so whether an edit can have made, changed or
// broken one is a question about the lines it touched alone.
function linesHoldScheme(doc: Text, from: number, to: number): boolean {
  const last = doc.lineAt(to).number
  for (let line = doc.lineAt(from).number; line <= last; line++)
    if (doc.line(line).text.includes(QUOTE_SCHEME)) return true
  return false
}

/** The extension, reading the host that fills each chip through `hosts` when a chip is drawn. */
export function composerQuoteChips(hosts: () => QuoteChipHosts | null): Extension {
  // Built once and then carried through each keystroke: the chips move with
  // the text around them, and the document is read again only when an edit
  // lands on a line that holds (or held) a quote's address.
  const field = StateField.define<Chips>({
    create: (state) => chips(state, hosts),
    update(value, transaction) {
      if (!transaction.docChanged) return value
      let rebuild = false
      transaction.changes.iterChanges((fromA, toA, fromB, toB) => {
        if (rebuild) return
        if (linesHoldScheme(transaction.state.doc, fromB, toB)) rebuild = true
        else if (value.holdsScheme && linesHoldScheme(transaction.startState.doc, fromA, toA)) rebuild = true
      })
      if (rebuild) return chips(transaction.state, hosts)
      return { ...value, decorations: value.decorations.map(transaction.changes) }
    },
    provide: (self) => [
      EditorView.decorations.from(self, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(self).decorations),
    ],
  })
  return field
}
