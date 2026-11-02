import { JSDOM } from 'jsdom'
import { expect, test, vi } from 'vitest'

// A chat that throws while rendering stops in its own pane: the rest of the
// window stays drawn, the pane says what happened, and Reload chat draws it
// again. Moving the pane to another chat starts clean.

test('a chat that throws stops in its pane, says so, and draws again on Reload chat', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { ChatViewErrorBoundary } = await import('./ChatViewErrorBoundary')
    let broken = true
    function Chat({ name }: { name: string }) {
      if (broken) throw new Error(`a reply nobody expected\nat ${name}`)
      return createElement('p', null, `chat ${name}`)
    }
    function Window({ chat }: { chat: string }) {
      return createElement(
        'main',
        null,
        createElement('nav', null, 'sidebar'),
        createElement(ChatViewErrorBoundary, { chatKey: chat, children: createElement(Chat, { name: chat }) }),
      )
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(Window, { chat: 'one' })))
    expect(host.textContent).toContain('sidebar')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('This chat hit a problem and stopped.')
    expect(host.textContent).toContain('a reply nobody expected')
    expect(host.textContent).not.toContain('at one')
    broken = false
    const reload = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Reload chat')!
    await act(async () => reload.click())
    expect(host.textContent).toContain('chat one')
    // A failure in one chat does not follow the pane to the next.
    broken = true
    await act(async () => root.render(createElement(Window, { chat: 'two' })))
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    broken = false
    await act(async () => root.render(createElement(Window, { chat: 'three' })))
    expect(host.textContent).toContain('chat three')
    await act(async () => root.unmount())
  } finally {
    quiet.mockRestore()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a chat whose code failed to load loads it again on Reload chat, and offers to reload the window', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const { act, createElement, Suspense } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { ChatViewErrorBoundary, reloadableLazy, isChunkLoadFailure } = await import('./ChatViewErrorBoundary')
    let loads = 0
    const Chat = reloadableLazy<{ name: string }>(async () => {
      loads++
      if (loads === 1)
        throw new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/AgentChatView.js')
      return { default: ({ name }: { name: string }) => createElement('p', null, `chat ${name}`) }
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(
        createElement(ChatViewErrorBoundary, {
          chatKey: 'one',
          children: createElement(Suspense, { fallback: null }, createElement(Chat, { name: 'one' })),
        }),
      ),
    )
    // The import is refused a turn later: wait for the pane to say so.
    for (let tries = 0; !host.querySelector('[role="alert"]') && tries < 50; tries++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('This chat could not load its code.')
    const buttons = () => [...host.querySelectorAll('button')].map((button) => button.textContent)
    expect(buttons()).toEqual(['Reload chat', 'Reload window'])
    expect(loads, 'a failed chunk is not fetched again by itself').toBe(1)
    // React keeps a lazy component's failed import for good; this one starts it again.
    const reload = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Reload chat')!
    await act(async () => reload.click())
    for (let tries = 0; host.textContent !== 'chat one' && tries < 50; tries++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    expect(loads).toBe(2)
    expect(host.textContent).toBe('chat one')
    // Only a chunk that did not load is told this way.
    expect(isChunkLoadFailure(new Error('a reply nobody expected'))).toBe(false)
    expect(isChunkLoadFailure(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isChunkLoadFailure(Object.assign(new Error('Loading chunk 7 failed.'), { name: 'ChunkLoadError' }))).toBe(
      true,
    )
    await act(async () => root.unmount())
  } finally {
    quiet.mockRestore()
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test('a chat whose code was fetched ahead draws without its fallback', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  try {
    const { act, createElement, Suspense } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { reloadableLazy } = await import('./ChatViewErrorBoundary')
    let loads = 0
    const Chat = reloadableLazy<{ name: string }>(async () => {
      loads++
      return { default: ({ name }: { name: string }) => createElement('p', null, `chat ${name}`) }
    })
    // New chat fetches it while the person types; it lands before Enter.
    Chat.preload()
    await new Promise((resolve) => setTimeout(resolve, 0))
    let fallbacks = 0
    function Fallback(): null {
      fallbacks++
      return null
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () =>
      root.render(createElement(Suspense, { fallback: createElement(Fallback) }, createElement(Chat, { name: 'one' }))),
    )
    expect(host.textContent).toBe('chat one')
    expect(fallbacks, 'a fallback commits a frame React then holds for 300 ms').toBe(0)
    expect(loads, 'the chunk is fetched once').toBe(1)
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
