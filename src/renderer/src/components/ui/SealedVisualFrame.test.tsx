// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SEALED_VISUAL_CHANNEL, SEALED_VISUAL_URL_PREFIX } from '../../../../shared/sealed-visual'
import { SEALED_VISUAL_SANDBOX, SealedVisualFrame } from './SealedVisualFrame'
import { VISUAL_FRAME_MAX_HEIGHT } from './VisualFrame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// An observer the test drives: it says when the box is near the view.
const observers: Array<{ callback: IntersectionObserverCallback; disconnected: boolean }> = []
class FakeObserver {
  record: { callback: IntersectionObserverCallback; disconnected: boolean }
  constructor(callback: IntersectionObserverCallback) {
    this.record = { callback, disconnected: false }
    observers.push(this.record)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.record.disconnected = true
  }
}

function scroll(near: boolean) {
  act(() => {
    for (const { callback, disconnected } of observers)
      if (!disconnected) callback([{ isIntersecting: near } as IntersectionObserverEntry], {} as IntersectionObserver)
  })
}

let activation = { isActive: true }
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  observers.length = 0
  activation = { isActive: true }
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => activation })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const url = `${SEALED_VISUAL_URL_PREFIX}${encodeURIComponent('<p>hi</p>')}`
const frame = () => container.querySelector('iframe')
const box = () => container.querySelector<HTMLElement>('[data-sealed-visual]')!

function render(onOpenLink = vi.fn()) {
  act(() => root.render(<SealedVisualFrame url={url} title="Open bugs" appearance="light" onOpenLink={onOpenLink} />))
  return onOpenLink
}

function post(data: unknown, source: Window | null | undefined = frame()?.contentWindow) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source: source ?? null }))
  })
}

test('the frame runs scripts with no origin of its own, and nothing else', () => {
  render()
  scroll(true)
  const drawn = frame()!
  expect(SEALED_VISUAL_SANDBOX).toBe('allow-scripts')
  expect(drawn.getAttribute('sandbox')).toBe('allow-scripts')
  for (const token of ['allow-same-origin', 'allow-popups', 'allow-top-navigation', 'allow-modals', 'allow-forms'])
    expect(drawn.getAttribute('sandbox')).not.toContain(token)
  expect(drawn.getAttribute('src')).toBe(url)
  expect(drawn.hasAttribute('srcdoc')).toBe(false)
  expect(drawn.getAttribute('title')).toBe('Open bugs')
})

test('a frame is made only near the view and taken down when scrolled away, keeping its height', () => {
  render()
  expect(frame()).toBeNull()
  scroll(true)
  expect(frame()).not.toBeNull()
  post({ channel: SEALED_VISUAL_CHANNEL, type: 'height', height: 312 })
  expect(box().style.height).toBe('312px')
  scroll(false)
  expect(frame()).toBeNull()
  // The reply does not move while the frame is gone.
  expect(box().style.height).toBe('312px')
  scroll(true)
  expect(frame()).not.toBeNull()
})

test('a height is taken only from its own frame, in the right shape, and held to the cap', () => {
  render()
  scroll(true)
  const before = box().style.height
  // Another window (another visual, the app itself) is not this frame.
  post({ channel: SEALED_VISUAL_CHANNEL, type: 'height', height: 500 }, window)
  post({ channel: SEALED_VISUAL_CHANNEL, type: 'height', height: 500 }, null)
  post({ channel: SEALED_VISUAL_CHANNEL, type: 'height', height: '500' })
  post({ type: 'height', height: 500 })
  expect(box().style.height).toBe(before)
  post({ channel: SEALED_VISUAL_CHANNEL, type: 'height', height: 1e9 })
  expect(box().style.height).toBe(`${VISUAL_FRAME_MAX_HEIGHT}px`)
})

test('a link opens only after a click in the frame, and only a web address', () => {
  const open = render()
  scroll(true)
  const request = (href: string) => post({ channel: SEALED_VISUAL_CHANNEL, type: 'open-link', href })
  // Asked with no click in the frame: the focus is elsewhere.
  request('https://example.com/a')
  expect(open).not.toHaveBeenCalled()
  // A click inside a frame leaves the app's focus on it.
  frame()!.tabIndex = 0
  frame()!.focus()
  activation = { isActive: false }
  request('https://example.com/a')
  expect(open).not.toHaveBeenCalled()
  activation = { isActive: true }
  request('javascript:void(0)')
  request('file:///Users/dev/notes.txt')
  expect(open).not.toHaveBeenCalled()
  request('https://example.com/a')
  expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/a')
  // The same click does not open a second.
  request('https://example.com/b')
  expect(open).toHaveBeenCalledTimes(1)
  // Nor does a request that claims to be from the frame but is not.
  post({ channel: SEALED_VISUAL_CHANNEL, type: 'open-link', href: 'https://example.com/c' }, window)
  expect(open).toHaveBeenCalledTimes(1)
})

test('the theme is posted to the frame, and a frame taken down hears nothing', () => {
  render()
  scroll(true)
  const target = frame()!.contentWindow!
  const posted = vi.spyOn(target, 'postMessage')
  act(() => root.render(<SealedVisualFrame url={url} title="Open bugs" appearance="dark" />))
  expect(posted).toHaveBeenCalledWith(expect.objectContaining({ channel: SEALED_VISUAL_CHANNEL, type: 'theme' }), '*')
  const listeners = vi.spyOn(window, 'removeEventListener')
  scroll(false)
  expect(listeners).toHaveBeenCalledWith('message', expect.any(Function))
})

test('unmounting, as the virtual list does with a row out of view, leaves no observer behind', () => {
  render()
  scroll(true)
  act(() => root.render(<></>))
  expect(frame()).toBeNull()
  expect(observers.every((observer) => observer.disconnected)).toBe(true)
})
