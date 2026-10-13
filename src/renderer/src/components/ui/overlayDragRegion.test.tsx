import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

// Every floating surface is portaled to <body>, so it is drawn over whatever
// sits under it — often the app rail, a pane's tab strip or the title bar,
// which are window-drag regions. Electron hit-tests drag regions without
// regard to stacking: unless the surface declares itself `app-no-drag`, a press
// on the part of it over such a strip drags the window and the item under the
// pointer is never chosen.
async function mounted(render: (modules: SurfaceModules) => React.ReactElement): Promise<Element[]> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const modules: SurfaceModules = {
    ...(await import('./Popover')),
    ...(await import('./ContextMenu')),
    ...(await import('./PointerPopover')),
  }
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  act(() => root.render(render(modules)))
  const surfaces = Array.from(dom.window.document.querySelectorAll('[aria-label="Surface"]'))
  act(() => root.unmount())
  return surfaces
}

type SurfaceModules = typeof import('./Popover') & typeof import('./ContextMenu') & typeof import('./PointerPopover')

const noop = () => undefined

test('an anchored popover is not a window-drag region', async () => {
  for (const material of ['raised', 'glass'] as const) {
    const [surface] = await mounted(({ Popover }) => (
      <Popover
        open
        onOpenChange={noop}
        ariaLabel="Surface"
        popupRole="menu"
        material={material}
        renderTrigger={({ ref }) => <span ref={ref as never}>Trigger</span>}
      >
        <button type="button">Item</button>
      </Popover>
    ))
    expect(surface?.classList.contains('app-no-drag'), material).toBe(true)
  }
})

test('a context menu is not a window-drag region', async () => {
  const [surface] = await mounted(({ ContextMenu }) => (
    <ContextMenu x={10} y={10} ariaLabel="Surface" onClose={noop}>
      <button type="button">Item</button>
    </ContextMenu>
  ))
  expect(surface?.classList.contains('app-no-drag')).toBe(true)
})

test('a pointer popover is not a window-drag region', async () => {
  for (const material of ['raised', 'glass'] as const) {
    const [surface] = await mounted(({ PointerPopover }) => (
      <PointerPopover x={10} y={10} ariaLabel="Surface" onClose={noop} material={material}>
        <button type="button">Item</button>
      </PointerPopover>
    ))
    expect(surface?.classList.contains('app-no-drag'), material).toBe(true)
  }
})
