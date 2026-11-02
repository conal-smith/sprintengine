import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'
import { collectQuotes, quoteToken, type ChatQuote } from '../../../../../shared/chat-quotes'
import type { ConversationTimelineRow } from './conversationTimeline'
import type { QuoteHighlightControl, ShownQuote } from './quoteHighlights'
import type { ChatQuotes } from './useChatQuotes'

// Quotes in a mounted chat: the chip in the composer, the comment editor the
// cite opens, the sent message's chip and what copying it gives, and the card
// a marked passage shows. jsdom lays nothing out and has no Highlight API, so
// rects are stood in for where a test needs them and nothing is painted.

const quote = (overrides: Partial<ChatQuote> = {}): ChatQuote => ({
  turnId: 't1',
  n: 1,
  quote: 'Keep the **cache** warm.',
  exact: 'Keep the cache warm.',
  prefix: '',
  suffix: '',
  comment: '',
  ...overrides,
})

async function inDom<T>(run: (dom: JSDOM) => Promise<T>): Promise<T> {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const keys = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
    'DOMRect',
    'IS_REACT_ACT_ENVIRONMENT',
  ]
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    DOMRect: dom.window.DOMRect,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  try {
    return await run(dom)
  } finally {
    dom.window.close()
    for (const key of keys) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A chat's composer and transcript with its quotes wired as the chat view wires them. */
async function mountChat(dom: JSDOM, initial: string, rows: ConversationTimelineRow[] = []) {
  const { act, createElement, useRef, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { EditorView } = await import('@codemirror/view')
  const { ComposerField } = await import('./ComposerField')
  const { useChatQuotes } = await import('./useChatQuotes')
  const document = dom.window.document
  const state = { draft: initial, sent: [] as string[], quotes: null as ChatQuotes | null }
  function Chat() {
    const [draft, setDraft] = useState(initial)
    state.draft = draft
    const composerRef = useRef(null)
    const pendingCaretRef = useRef<number | null>(null)
    const transcriptRef = useRef<HTMLDivElement | null>(null)
    const listRef = useRef(null)
    const quotes = useChatQuotes({
      draft,
      setDraft: (update) => setDraft(update),
      composerRef,
      pendingCaretRef,
      rows,
      pendingTexts: [],
      transcriptRef,
      listRef,
      scrollToRow: () => undefined,
      pauseFollowing: () => undefined,
      hasMore: false,
      loadingEarlier: false,
      loadEarlier: async () => undefined,
      submit: () => {
        state.sent.push(state.draft)
        return true
      },
    })
    state.quotes = quotes
    return createElement(
      'div',
      null,
      createElement('div', { ref: transcriptRef, id: 'transcript' }, quotes.highlights),
      quotes.editor,
      createElement(ComposerField, {
        ref: composerRef,
        value: draft,
        onChange: (value: string) => setDraft(value),
        renderQuoteChip: quotes.renderQuoteChip,
      }),
    )
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(Chat)))
  const view = () => EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
  const editor = () => document.querySelector<HTMLTextAreaElement>('[data-quote-editor] textarea')
  const typeComment = async (text: string) => {
    const field = editor()!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(field, text)
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  const press = async (key: string, init: KeyboardEventInit = {}) =>
    act(async () => {
      editor()!.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
      )
    })
  return {
    act,
    host,
    state,
    view,
    editor,
    typeComment,
    press,
    cite: async (citation: Partial<ChatQuote> = {}) =>
      act(async () =>
        state.quotes!.cite(
          {
            turnId: 't1',
            quote: 'Keep the **cache** warm.',
            exact: 'Keep the cache warm.',
            prefix: '',
            suffix: '',
            ...citation,
          },
          { left: 10, right: 100, top: 20, bottom: 36 },
        ),
      ),
    unmount: () => act(async () => root.unmount()),
  }
}

test('a cited passage goes in at the caret as one chip, with the next number, and opens its comment editor', async () => {
  await inDom(async (dom) => {
    const sent: ConversationTimelineRow = {
      kind: 'user',
      id: 'u1',
      entry: { kind: 'user', id: 'u1', text: `Earlier ${quoteToken(quote({ n: 4 }))}` },
    }
    const chat = await mountChat(dom, 'Before after', [sent])
    try {
      chat.view().dispatch({ selection: { anchor: 'Before'.length } })
      await chat.cite()
      const [inserted] = collectQuotes(chat.state.draft)
      expect(inserted?.n).toBe(5)
      expect(chat.state.draft).toBe(`Before ${quoteToken(quote({ n: 5 }))}  after`)
      // Drawn as a chip: the number and the start of the passage, never the address.
      const chip = chat.host.querySelector('[data-quote-chip="5"]')!
      expect(chip.textContent).toContain('Keep the cache warm.')
      expect(chat.host.querySelector('.cm-content')!.textContent).not.toContain('sprintengine-quote')
      expect(chat.editor()?.getAttribute('placeholder')).toBe('Add an optional comment…')
    } finally {
      await chat.unmount()
    }
  })
})

test('Enter saves the comment into the token; ⌘Enter saves and sends', async () => {
  await inDom(async (dom) => {
    const chat = await mountChat(dom, '')
    try {
      await chat.cite()
      await chat.typeComment('Why (warm)?')
      await chat.press('Enter')
      expect(chat.editor()).toBeNull()
      expect(collectQuotes(chat.state.draft)[0]?.comment).toBe('Why (warm)?')
      expect(chat.host.querySelector('[data-quote-chip="1"]')!.textContent).toContain('Why (warm)?')
      expect(chat.state.sent).toEqual([])
      // The pencil opens it again with the comment, and ⌘Enter sends the draft it wrote.
      await chat.act(async () =>
        chat.host.querySelector<HTMLElement>('[aria-label="Edit comment on quote 1"]')!.click(),
      )
      expect(chat.editor()?.value).toBe('Why (warm)?')
      await chat.typeComment('Changed')
      await chat.press('Enter', { metaKey: true })
      expect(chat.state.sent).toHaveLength(1)
      expect(collectQuotes(chat.state.sent[0]!)[0]?.comment).toBe('Changed')
    } finally {
      await chat.unmount()
    }
  })
})

test('Escape on a new quote takes the chip back out; on an existing one it keeps it', async () => {
  await inDom(async (dom) => {
    const chat = await mountChat(dom, 'Hi ')
    try {
      await chat.cite()
      await chat.press('Escape')
      expect(chat.editor()).toBeNull()
      expect(chat.state.draft).toBe('Hi ')
      await chat.cite()
      await chat.press('Enter')
      await chat.act(async () =>
        chat.host.querySelector<HTMLElement>('[aria-label="Edit comment on quote 1"]')!.click(),
      )
      await chat.typeComment('never mind')
      await chat.press('Escape')
      expect(collectQuotes(chat.state.draft)).toHaveLength(1)
      expect(collectQuotes(chat.state.draft)[0]?.comment).toBe('')
    } finally {
      await chat.unmount()
    }
  })
})

test('a chip is one unit to the caret and to Backspace, on the line the caret is on', async () => {
  await inDom(async (dom) => {
    const { deleteCharBackward, cursorCharLeft } = await import('@codemirror/commands')
    const { livePreviewDecorations } = await import('./markdownLivePreview')
    const token = quoteToken(quote())
    const chat = await mountChat(dom, `Hi ${token}`)
    try {
      const view = chat.view()
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      cursorCharLeft(view)
      expect(view.state.selection.main.head).toBe(3)
      view.dispatch({ selection: { anchor: view.state.doc.length } })
      // The live preview leaves the token to the chip even with its line shown raw.
      const marks = livePreviewDecorations(view.state, [{ from: 0, to: view.state.doc.length }], new Set([1]))
      let inside = 0
      marks.between(3, view.state.doc.length, () => {
        inside++
      })
      expect(inside).toBe(0)
      await chat.act(async () => {
        deleteCharBackward(view)
      })
      expect(chat.state.draft).toBe('Hi ')
    } finally {
      await chat.unmount()
    }
  })
})

test('a sent message draws its quote as a chip and copies it as the passage and comment', async () => {
  await inDom(async (dom) => {
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    const { UserTimelineRow } = await import('./timelineRows')
    const { selectionClipboard } = await import('../../../utils/selectionToMarkdown')
    const text = `About ${quoteToken(quote({ n: 2, comment: 'Is this still true?' }))} thanks`
    const html = renderToStaticMarkup(
      createElement(UserTimelineRow, { entry: { kind: 'user', id: 'u1', seq: 1, text } }),
    )
    const document = dom.window.document
    document.body.innerHTML = `<div id="log">${html}</div>`
    const chip = document.querySelector('[data-quote-chip="2"]')!
    expect(chip.textContent).toContain('Is this still true?')
    expect(chip.querySelector('button[aria-label^="Edit comment"]')).toBeNull()
    expect(document.body.textContent).not.toContain('sprintengine-quote')
    const range = document.createRange()
    range.selectNodeContents(document.getElementById('log')!)
    const selection = dom.window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    expect(selectionClipboard(selection, document.getElementById('log')!)?.text).toBe(
      // The word after the chip keeps the space typed before it, which a
      // paragraph's first line drops when it is read as markdown.
      'About\n\n> Keep the **cache** warm.\n\nIs this still true?\n\n thanks',
    )
  })
})

test("a marked passage's card offers edit and remove for a draft quote and nothing for a sent one", async () => {
  await inDom(async (dom) => {
    const { act, createElement, createRef } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { QuoteHighlights } = await import('./quoteHighlights')
    const document = dom.window.document
    document.body.innerHTML =
      '<div id="transcript"><div data-quote-source="t1"><p>Alpha beta gamma.</p></div>' +
      '<div data-quote-source="t2"><p>Delta epsilon.</p></div></div><div id="host"></div>'
    const transcript = document.getElementById('transcript')!
    transcript.getBoundingClientRect = () => new dom.window.DOMRect(0, 0, 800, 600)
    const rectFor: Record<string, DOMRect> = {
      beta: new dom.window.DOMRect(10, 10, 40, 16),
      epsilon: new dom.window.DOMRect(10, 50, 50, 16),
    }
    dom.window.Range.prototype.getClientRects = function (this: Range) {
      const rect = rectFor[this.toString()]
      return Object.assign(rect ? [rect] : [], { item: () => rect ?? null }) as unknown as DOMRectList
    }
    dom.window.Range.prototype.getBoundingClientRect = function (this: Range) {
      return rectFor[this.toString()] ?? new dom.window.DOMRect()
    }
    const quotes: ShownQuote[] = [
      { ...quote({ turnId: 't1', n: 1, exact: 'beta', comment: 'Why beta?' }), sent: false },
      { ...quote({ turnId: 't2', n: 2, exact: 'epsilon' }), sent: true },
    ]
    const removed: number[] = []
    const root = createRoot(document.getElementById('host')!)
    const move = async (x: number, y: number) => {
      await act(async () => {
        transcript.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
        await sleep(500)
      })
    }
    try {
      await act(async () => {
        root.render(
          createElement(QuoteHighlights, {
            transcriptRef: { current: transcript },
            quotes,
            controlRef: createRef<QuoteHighlightControl>(),
            onEdit: () => undefined,
            onRemove: (n: number) => removed.push(n),
            onLanding: () => undefined,
          }),
        )
      })
      // The paint waits for a frame.
      await act(async () => sleep(50))
      expect(document.querySelector('[data-quote-badge="1"]')?.textContent).toBe('1')
      expect(document.querySelector('[data-quote-badge="2"]')).not.toBeNull()
      await move(20, 15)
      const draftCard = document.querySelector('[data-quote-card="1"]')!
      expect(draftCard.textContent).toContain('Why beta?')
      expect(draftCard.querySelector('[aria-label="Edit comment"]')).not.toBeNull()
      expect(draftCard.querySelector('[aria-label="Remove quote"]')).not.toBeNull()
      await move(20, 55)
      const sentCard = document.querySelector('[data-quote-card="2"]')!
      // No comment: the quoted words, and no buttons.
      expect(sentCard.textContent).toContain('epsilon')
      expect(sentCard.querySelectorAll('button')).toHaveLength(0)
      // Off both: the card goes.
      await move(500, 500)
      expect(document.querySelector('[data-quote-card]')).toBeNull()
      // Remove from a draft quote's card.
      await move(20, 15)
      await act(async () => document.querySelector<HTMLElement>('[aria-label="Remove quote"]')!.click())
      expect(removed).toEqual([1])
    } finally {
      await act(async () => root.unmount())
    }
  })
})
