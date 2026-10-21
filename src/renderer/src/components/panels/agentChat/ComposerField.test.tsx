import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

// A draft the chat clears (sends) starts the undo history again: ⌘Z must not
// bring back a message that was already sent. Any other draft set from
// outside (a menu's Paste, an @ pick) is one step to undo, and another
// conversation's draft starts the history again whatever it holds.

test('a cleared draft starts the undo history again; a draft set from outside undoes as one step', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  try {
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { undo, undoDepth } = await import('@codemirror/commands')
    const { EditorView } = await import('@codemirror/view')
    const { ComposerField } = await import('./ComposerField')

    let draft = ''
    let scope = 'chat-a'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const render = () =>
      root.render(
        createElement(ComposerField, {
          value: draft,
          historyScope: scope,
          onChange: (value: string) => {
            draft = value
          },
        }),
      )
    await act(async () => render())
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
    const type = (text: string) =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: text },
        selection: { anchor: view.state.doc.length + text.length },
        userEvent: 'input.type',
      })

    type('ship the fix')
    await act(async () => render())
    expect(draft).toBe('ship the fix')
    expect(undoDepth(view.state)).toBeGreaterThan(0)

    // Sent: the chat clears the draft. Nothing is left to undo.
    draft = ''
    await act(async () => render())
    expect(view.state.doc.toString()).toBe('')
    expect(undoDepth(view.state)).toBe(0)
    expect(undo(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('')

    // A restored draft is one step: what is typed after it undoes back to it,
    // and the restore itself undoes to the cleared field, never past it.
    draft = 'restored'
    await act(async () => render())
    type(' and more')
    await act(async () => render())
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('restored')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('')
    expect(undo(view)).toBe(false)

    // Typing, then a menu's Paste replacing the draft: ⌘Z takes the paste back
    // and keeps what was typed.
    type('draft')
    await act(async () => render())
    draft = 'draft pasted'
    await act(async () => render())
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('draft')

    // Another conversation, with the same draft text: nothing of this one's
    // edits is there to undo.
    scope = 'chat-b'
    await act(async () => render())
    expect(undoDepth(view.state)).toBe(0)

    await act(async () => root.unmount())
  } finally {
    for (const key of Object.keys(Object.getOwnPropertyDescriptors(globalThis)))
      if (!(key in previous)) delete (globalThis as Record<string, unknown>)[key]
    Object.defineProperties(globalThis, previous)
    dom.window.close()
  }
})

test('a key is the input method’s while it composes, and as the keyCode 229 that commits it', async () => {
  const { isImeKey } = await import('../../../utils/imeKey')
  const key = (init: { isComposing?: boolean; keyCode?: number }) =>
    ({ isComposing: init.isComposing ?? false, keyCode: init.keyCode ?? 13 }) as KeyboardEvent
  expect(isImeKey(key({}))).toBe(false)
  expect(isImeKey(key({ isComposing: true }))).toBe(true)
  // WebKit's committing Enter: composition already over, the key still 229.
  expect(isImeKey(key({ keyCode: 229 }))).toBe(true)
  // The composer's own key events carry the native one.
  expect(isImeKey({ nativeEvent: key({ keyCode: 229 }) })).toBe(true)
  expect(isImeKey({ nativeEvent: key({}) })).toBe(false)
})

test('a host that keeps less than was typed is what the field shows, caret where it stood', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  try {
    const { act, createElement, useState } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { undo } = await import('@codemirror/commands')
    const { EditorView } = await import('@codemirror/view')
    const { ComposerField } = await import('./ComposerField')

    // The chat's draft keeps at most so many characters, as `useComposerDraft`
    // does at its cap.
    const CAP = 10
    function Host() {
      const [draft, setDraft] = useState('')
      return createElement(ComposerField, {
        value: draft,
        onChange: (value: string) => setDraft(value.slice(0, CAP)),
      })
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(Host)))
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
    const typeAt = (at: number, text: string) =>
      act(async () => {
        view.dispatch({
          changes: { from: at, insert: text },
          selection: { anchor: at + text.length },
          userEvent: 'input.type',
        })
      })

    await typeAt(0, 'fix the bug')
    expect(view.state.doc.toString()).toBe('fix the bu')
    // At the cap already: the draft hands back the value it had.
    await typeAt(view.state.doc.length, 'g')
    expect(view.state.doc.toString()).toBe('fix the bu')
    // A word typed in the middle pushes the tail off; the caret stays after it.
    await typeAt(4, 'a ')
    expect(view.state.doc.toString()).toBe('fix a the ')
    expect(view.state.selection.main.head).toBe(6)
    // What the draft refused is not something ⌘Z brings back.
    await act(async () => {
      undo(view)
    })
    expect(view.state.doc.toString().length).toBeLessThanOrEqual(CAP)

    await act(async () => root.unmount())
  } finally {
    for (const key of Object.keys(Object.getOwnPropertyDescriptors(globalThis)))
      if (!(key in previous)) delete (globalThis as Record<string, unknown>)[key]
    Object.defineProperties(globalThis, previous)
    dom.window.close()
  }
})
