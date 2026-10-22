import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

import type { Workspace } from '../../types/workspace'

// Every item of a chat's right-click menu says what it does, on hover and on
// keyboard focus (owner request 2026-10-21). Held structurally: each menu is
// opened in every shape it takes (a chat here, settled, asleep, a run's chat
// with a watched pull request, a paired machine's chat opened here and not,
// from a machine that keeps the marks and one that does not), its Snooze
// flyout opened too, and every row it draws must carry a tooltip
// (`data-menu-tooltip`). A row added without one fails here.

test('every item of a chat’s menu, here or on a paired machine, has a tooltip', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window as unknown as Record<string, unknown>
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Element = dom.window.Element
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  ;(dom.window as unknown as { api: unknown }).api = { platform: 'darwin' }

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { WorkspaceContextMenu, RemoteConversationContextMenu } = await import('./sidebar/contextMenus')

  const now = Date.now()
  const base = {
    id: 'ws-1',
    name: 'Fix the parser',
    mode: 'standard',
    folderPath: '/Users/dev/parser',
    agents: {},
    createdAt: now - 60_000,
  } as unknown as Workspace
  const origin = {
    connectionId: 'c1',
    machineName: 'mac-mini',
    workspaceId: 'rw1',
    workspaceName: 'parser',
    workspaceRoot: '/Users/dev/parser',
  }
  const noop = () => {}
  const local = (workspace: Partial<Workspace>, extra: Record<string, unknown> = {}) =>
    React.createElement(WorkspaceContextMenu, {
      x: 0,
      y: 0,
      workspace: { ...base, ...workspace } as Workspace,
      moduleOverrides: {},
      isDetachedWindow: false,
      now,
      working: false,
      onClose: noop,
      onSelect: noop,
      onPickColor: noop,
      ...extra,
    })
  const remote = (extra: Record<string, unknown> = {}) =>
    React.createElement(RemoteConversationContextMenu, {
      x: 0,
      y: 0,
      title: 'Review the parser',
      machineName: 'mac-mini',
      canSettle: true,
      marks: true,
      canMarkUnread: true,
      isDetachedWindow: false,
      workspaceId: 'rw1',
      starred: false,
      color: null,
      snoozedUntil: null,
      autoSettle: false,
      now,
      working: false,
      onClose: noop,
      onSelect: noop,
      onPickColor: noop,
      ...extra,
    })

  const shapes: Array<[string, React.ReactElement]> = [
    ['a chat here', local({}, { canMarkUnread: true })],
    [
      'a run’s chat with a watched pull request, starred and coloured',
      local(
        { highlight: { starred: true, color: 'green' }, autoSettleEnabled: true },
        { watchedPullRequestNumber: 12, schedule: { paused: false } },
      ),
    ],
    ['a chat whose agent works', local({}, { working: true, schedule: { paused: true } })],
    ['a settled chat', local({ settledAt: now - 1_000 })],
    ['a snoozed chat', local({ snoozedUntil: now + 3_600_000 })],
    ['a chat whose folder is gone', local({ folderMissing: true })],
    ['a chat in a window of its own', local({}, { isDetachedWindow: true })],
    [
      'a paired machine’s chat opened here, from a machine that keeps the marks',
      local({ folderPath: null, remoteOrigin: origin } as Partial<Workspace>, {
        remoteSettle: true,
        remoteMarks: true,
        canMarkUnread: true,
      }),
    ],
    [
      'a paired machine’s chat opened here, from a machine that does not',
      local({ folderPath: null, remoteOrigin: origin } as Partial<Workspace>),
    ],
    ['a paired machine’s chat', remote()],
    ['a paired machine’s chat, asleep and starred', remote({ snoozedUntil: now + 60_000, starred: true })],
    ['a paired machine’s chat whose agent works', remote({ working: true, isDetachedWindow: true })],
    ['a chat on a machine from before the marks', remote({ marks: false, canMarkUnread: false })],
  ]

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  try {
    for (const [shape, menu] of shapes) {
      // Each shape a menu of its own, as each right-click opens one.
      act(() => {
        root.render(null)
      })
      act(() => {
        root.render(menu)
      })
      const surface = dom.window.document.querySelector<HTMLElement>('[role="menu"]')
      assert.ok(surface, `${shape}: a menu`)
      // Open the Snooze flyout, where there is one, so its rows are held too.
      const flyout = surface.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]:not([disabled])')
      if (flyout)
        await act(async () => {
          flyout.click()
        })
      const items = [...dom.window.document.querySelectorAll<HTMLElement>('[role="menu"] [data-menu-item="true"]')]
      assert.ok(items.length > 4, `${shape}: rows drawn`)
      for (const item of items)
        assert.equal(
          item.getAttribute('data-menu-tooltip'),
          'true',
          `${shape}: "${(item.textContent ?? '').trim() || item.getAttribute('aria-label')}" says what it does`,
        )
      if (flyout)
        assert.ok(
          dom.window.document.querySelectorAll('[aria-label="Snooze chat"] [data-menu-tooltip="true"]').length >= 3,
          `${shape}: the snooze times say when`,
        )
    }

    // A tooltip shows on keyboard focus, beside the row, and says how a
    // paired machine's chat differs.
    act(() => {
      root.render(null)
    })
    act(() => {
      root.render(remote())
    })
    const surface = dom.window.document.querySelector<HTMLElement>('[role="menu"]')!
    // Walked to with the arrow keys, as the keyboard walks a menu. A browser
    // calls a focus the arrow keys moved visible; the test DOM has no notion
    // of how focus arrived, so it is told to answer as a browser does.
    const matches = dom.window.Element.prototype.matches
    Object.defineProperty(dom.window.Element.prototype, 'matches', {
      configurable: true,
      value(this: Element, selector: string): boolean {
        return selector === ':focus-visible' ? this === dom.window.document.activeElement : matches.call(this, selector)
      },
    })
    const walkTo = (label: string) => {
      for (let step = 0; step < 20; step += 1) {
        const focused = dom.window.document.activeElement as HTMLElement | null
        if ((focused?.textContent ?? '').trim().startsWith(label)) return focused!
        act(() => {
          ;(focused ?? surface).dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
          )
        })
      }
      assert.fail(`the arrow keys reach ${label}`)
    }
    const star = walkTo('Star')
    const tip = dom.window.document.querySelector('[role="tooltip"]')
    assert.ok(tip, 'focus shows the row’s tooltip')
    assert.match(tip.textContent ?? '', /Saved on mac-mini/)
    assert.equal(star.getAttribute('aria-describedby'), tip.id)

    // Auto-settle says when it settles a chat.
    walkTo('Auto-settle')
    assert.match(dom.window.document.querySelector('[role="tooltip"]')?.textContent ?? '', /after 3 days/)

    // The Snooze row's tooltip gives way to its flyout, which opens where it stands.
    const snooze = surface.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!
    act(() => {
      snooze.focus()
    })
    assert.equal(dom.window.document.activeElement, snooze)
    assert.match(dom.window.document.querySelector('[role="tooltip"]')?.textContent ?? '', /Hide this chat/)
    await act(async () => {
      snooze.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    assert.ok(dom.window.document.querySelector('[aria-label="Snooze chat"]'), 'the flyout opens')
    const shown = [...dom.window.document.querySelectorAll('[role="tooltip"]')].map((node) => node.textContent ?? '')
    assert.ok(!shown.some((text) => text.includes('Hide this chat')), `the row's tooltip is gone: ${shown.join(' | ')}`)
  } finally {
    act(() => {
      root.unmount()
    })
  }
})
