import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import { installRenderCounter } from '../../../../../tests/render-counter'

// The Git panel reads two facts off its workspace — its folder and its
// worktree — and nothing else. The workspace record is replaced by writes
// that touch neither: the visit stamp every few seconds while its chat is on
// screen, terminal input, a layout move. None of them may re-render the panel.

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
Object.assign(anyGlobal, {
  window: domWindow,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
  self: domWindow,
  requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (id: number) => dom.window.clearTimeout(id),
})
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
// Nothing the panel asks of main matters here: subscriptions hand back an
// unsubscribe, every read stays pending.
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

const counter = installRenderCounter()

test('writes to its workspace that it draws nothing from leave the Git panel alone', async () => {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: GitPanel } = await import('./GitPanel')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')

  useWorkspaceStore.setState((state) => ({
    ...state,
    workspaces: [{ id: 'w1', name: 'Alpha', mode: 'standard', folderPath: '/Users/dev/alpha' }] as never,
  }))

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        React.createElement(ConfirmDialogProvider, null, React.createElement(GitPanel, { workspaceId: 'w1' })),
      )
    })
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, 0))
    })
    assert.ok(counter.renders('GitPanel') > 0, 'the panel mounted')

    counter.reset()
    const store = useWorkspaceStore.getState()
    await act(async () => {
      store.recordWorkspaceVisit('w1', Date.now())
      store.recordWorkspaceTerminalActivity('w1', Date.now())
    })
    assert.equal(counter.renders('GitPanel'), 0, `renders: ${JSON.stringify(counter.table().slice(0, 5))}`)

    // Its folder moving is a change it draws, and it does.
    counter.reset()
    await act(async () => {
      useWorkspaceStore.setState((state) => ({
        workspaces: state.workspaces.map((workspace) =>
          workspace.id === 'w1' ? { ...workspace, folderPath: '/Users/dev/beta' } : workspace,
        ),
      }))
    })
    assert.ok(counter.renders('GitPanel') > 0, 'a new folder re-renders it')
  } finally {
    act(() => root.unmount())
  }
})
