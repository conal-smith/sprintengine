import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

// A popover's surface is portaled to <body>, so hiding the trigger's layer does
// not hide the surface with it. Switching workspace makes the old layer
// `invisible` and aria-hidden; a door paints over the canvas inert. Either way
// an open menu must close rather than float over the next view.
test('an open popover closes when its trigger is hidden, and stays open while it is not', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  // Records what the popover watches: the trigger's own chain, never a subtree.
  const watched: Array<{ target: Node; options?: MutationObserverInit }> = []
  class RecordingMutationObserver extends dom.window.MutationObserver {
    override observe(target: Node, options?: MutationObserverInit): void {
      watched.push({ target, options })
      super.observe(target, options)
    }
  }
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: RecordingMutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  try {
    const { act, createElement, useState } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Popover } = await import('./Popover')
    const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(() => resolve(undefined)))

    for (const hide of [
      (layer: HTMLElement) => layer.setAttribute('aria-hidden', 'true'),
      (layer: HTMLElement) => layer.setAttribute('inert', ''),
    ]) {
      const layer = dom.window.document.createElement('div')
      dom.window.document.body.appendChild(layer)
      const root = createRoot(layer)
      let setOpen: (next: boolean) => void = () => undefined
      function Host() {
        const [open, change] = useState(true)
        setOpen = change
        return createElement(Popover, {
          open,
          onOpenChange: change,
          ariaLabel: 'Engine',
          popupRole: 'menu',
          renderTrigger: ({ ref, triggerProps }) =>
            createElement('span', { ref: ref as never, ...triggerProps }, 'Engine'),
          children: createElement('p', null, 'Model list'),
        })
      }
      watched.length = 0
      await act(async () => root.render(createElement(Host)))
      expect(dom.window.document.querySelector('[role="menu"]')).not.toBeNull()
      const trigger = dom.window.document.querySelector('[aria-haspopup]')!
      expect(watched.length, 'the trigger and each ancestor are watched').toBeGreaterThan(0)
      for (const { target, options } of watched) {
        expect(options?.subtree, 'no subtree is watched, so churn elsewhere costs nothing').toBeFalsy()
        expect(target.contains(trigger), 'only the trigger and its ancestors are watched').toBe(true)
      }
      expect(watched.some(({ target }) => target === layer)).toBe(true)

      // An unrelated attribute change elsewhere does not close it.
      await act(async () => {
        dom.window.document.body.setAttribute('data-theme', 'dark')
        await frame()
      })
      expect(dom.window.document.querySelector('[role="menu"]'), 'a visible trigger keeps it open').not.toBeNull()

      await act(async () => {
        hide(layer)
        await frame()
      })
      expect(dom.window.document.querySelector('[role="menu"]'), 'hiding the trigger closes it').toBeNull()
      setOpen(false)
      await act(async () => root.unmount())
      layer.remove()
    }
  } finally {
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

// A surface whose content grows after it opened (a menu stepping into a taller
// view) must be placed again, or it runs off the bottom of the window.
test('a surface that grows after opening is measured again and flips above its trigger', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const observers: Array<() => void> = []
  class FakeResizeObserver {
    constructor(private readonly callback: () => void) {}
    observe(): void {
      observers.push(this.callback)
    }
    disconnect(): void {}
    unobserve(): void {}
  }
  let surfaceHeight = 120
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? surfaceHeight : 0
    },
  })
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  Object.assign(globalThis, globals)
  try {
    const { act, createElement } = await import('react')
    const { createRoot } = await import('react-dom/client')
    const { Popover } = await import('./Popover')
    const layer = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(layer)
    const root = createRoot(layer)
    const vh = dom.window.innerHeight
    await act(async () =>
      root.render(
        createElement(Popover, {
          open: true,
          onOpenChange: () => undefined,
          ariaLabel: 'Project',
          popupRole: 'menu',
          placement: 'bottom-start',
          renderTrigger: ({ ref, triggerProps }) =>
            createElement(
              'span',
              {
                ref: ((node: HTMLElement | null) => {
                  if (node) {
                    // Two thirds of the way down the window.
                    node.getBoundingClientRect = () =>
                      ({
                        top: vh * 0.66,
                        bottom: vh * 0.66 + 20,
                        left: 10,
                        right: 90,
                        width: 80,
                        height: 20,
                      }) as DOMRect
                  }
                  ;(ref as { current: HTMLElement | null }).current = node
                }) as never,
                ...triggerProps,
              },
              'Project',
            ),
          children: createElement('p', null, 'Steps'),
        }),
      ),
    )
    const surface = dom.window.document.querySelector<HTMLElement>('[role="menu"]')!
    expect(surface.style.top, 'it fits below the trigger at first').not.toBe('')
    expect(observers.length, 'the surface is watched for size').toBeGreaterThan(0)

    surfaceHeight = Math.round(vh * 0.5)
    await act(async () => {
      for (const callback of observers) callback()
    })
    expect(surface.style.top, 'no longer pinned below the trigger').toBe('')
    expect(surface.style.bottom, 'anchored above it instead').not.toBe('')
    await act(async () => root.unmount())
  } finally {
    Reflect.deleteProperty(dom.window.HTMLElement.prototype, 'offsetHeight')
    dom.window.close()
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
