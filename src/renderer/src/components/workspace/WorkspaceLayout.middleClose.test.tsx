import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceLayout.middleClose: closing a tab with a middle-click does not paste the primary selection', async () => {
  // A middle-click on a tab closes it, on the auxclick that follows the
  // release. Chromium on Linux pastes the primary selection into the focused
  // field on a middle release nobody cancelled, so closing a tab this way could
  // type the last highlighted text into the composer.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  const domWindow = dom.window as unknown as Record<string, unknown>
  anyGlobal.window = domWindow
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Element = dom.window.Element
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  anyGlobal.requestAnimationFrame = (callback: FrameRequestCallback) =>
    dom.window.setTimeout(() => callback(Date.now()), 0)
  anyGlobal.cancelAnimationFrame = (id: number) => dom.window.clearTimeout(id)
  dom.window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  anyGlobal.ResizeObserver = NoopResizeObserver
  dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

  // Nothing the tab strip asks of main matters here: subscriptions hand back
  // an unsubscribe, every read stays pending.
  domWindow.api = new Proxy(
    { platform: 'darwin' },
    {
      get: (target, name) =>
        name in target
          ? (target as Record<string | symbol, unknown>)[name]
          : typeof name === 'string' && name.startsWith('on')
            ? () => () => {}
            : () => new Promise(() => {}),
    },
  )

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceLayout } = await import('./WorkspaceLayout')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')

  // Neither tab is a real panel: this is about the strip, not what it shows.
  const tab = (id: string, name: string) => ({ type: 'tab', id, name, component: 'not-a-panel' })
  useWorkspaceStore.setState((state) => ({
    ...state,
    workspaces: [
      {
        id: 'w1',
        name: 'Alpha',
        mode: 'standard',
        folderPath: '/Users/dev/alpha',
        layoutModel: {
          global: {},
          borders: [],
          layout: {
            type: 'row',
            children: [{ type: 'tabset', id: 'ts1', selected: 0, children: [tab('a', 'Notes'), tab('b', 'Draft')] }],
          },
        },
      },
    ] as never,
  }))

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
      })
    }
  }
  const tabButton = (name: string): Element | undefined =>
    [...container.querySelectorAll('.flexlayout__tab_button')].find((candidate) =>
      (candidate.textContent ?? '').includes(name),
    )
  const mouse = (target: Element, type: string, button: number): MouseEvent => {
    const event = new dom.window.MouseEvent(type, { button, bubbles: true, cancelable: true })
    act(() => {
      target.dispatchEvent(event)
    })
    return event
  }

  try {
    act(() => {
      root.render(React.createElement(WorkspaceLayout, { workspaceId: 'w1' }))
    })
    await settle()
    const draft = tabButton('Draft')
    assert.ok(draft, `the strip has the tab: ${container.innerHTML.slice(0, 400)}`)

    assert.equal(mouse(draft, 'mouseup', 0).defaultPrevented, false, 'a left release on a tab is left alone')
    assert.equal(mouse(draft, 'mouseup', 2).defaultPrevented, false, 'and a right one')

    assert.equal(mouse(draft, 'mouseup', 1).defaultPrevented, true, 'a middle release on a tab does not paste')
    mouse(draft, 'auxclick', 1)
    await settle()
    assert.equal(Boolean(tabButton('Draft')), false, 'and the middle-click still closes the tab')

    const outside = container.querySelector('.flexlayout__tabset_content') ?? container
    assert.equal(mouse(outside, 'mouseup', 1).defaultPrevented, false, 'a middle release off the strip can paste')
  } finally {
    act(() => root.unmount())
  }
})
