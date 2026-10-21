import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, test } from 'vitest'

import type { ChatExportInput } from '../../../../shared/chat-export'
import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'

// A chat tab's right-click menu carries Export chat beside Replay
// conversation: a flyout of the two copies and the three files. A terminal's
// menu does not, and a chat with no message yet has it off, saying why. One
// strip is drawn for the file; each test opens the menu it is about.

async function setup() {
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

  // What the menu asks of main: the export, answered as a copy that landed.
  // Everything else the strip asks stays pending.
  const exports: ChatExportInput[] = []
  domWindow.api = new Proxy(
    {
      platform: 'darwin',
      exportChat: async (input: ChatExportInput) => {
        exports.push(input)
        return { ok: true, kind: 'copied' }
      },
    },
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
  const { useToastStore } = await import('../../store/toastStore')

  const chat = (id: string, name: string) => ({
    id,
    name,
    status: 'idle',
    runtimeKind: 'conversation',
    conversation: { providerId: 'claude-agent', modelId: 'default' },
    execution: { mode: 'current_workspace', worktreeId: null, cwd: null },
    messages: [],
    streamBuffer: '',
  })
  const tab = (id: string, name: string, component: string) => ({
    type: 'tab',
    id,
    name,
    component,
    config: { agentId: id },
  })
  useWorkspaceStore.setState((state) => ({
    ...state,
    workspaces: [
      {
        id: 'w1',
        name: 'acme-app',
        mode: 'standard',
        folderPath: '/Users/dev/acme-app',
        agents: { 'chat-1': chat('chat-1', 'Release notes'), 'chat-2': chat('chat-2', 'New chat') },
        layoutModel: {
          global: {},
          borders: [],
          layout: {
            type: 'row',
            children: [
              {
                type: 'tabset',
                id: 'ts1',
                // Selected elsewhere, so no pane mounts: this is about the tabs.
                selected: 3,
                children: [
                  tab('chat-1', 'Release notes', 'agent'),
                  tab('chat-2', 'New chat', 'agent'),
                  { type: 'tab', id: 'term-1', name: 'zsh', component: 'terminal' },
                  { type: 'tab', id: 'notes', name: 'Notes', component: 'not-a-panel' },
                ],
              },
            ],
          },
        },
      },
    ] as never,
  }))
  // Main lists both chats' sessions: the first has been written to, the second not yet.
  const session = (agentId: string, extra: Partial<ConversationSessionSummary>): ConversationSessionSummary => ({
    sessionId: `session-${agentId}`,
    workspaceId: 'w1',
    agentId,
    providerId: 'claude-agent',
    modelId: 'default',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  })
  const sessions = [session('chat-1', { firstUserText: 'Write the release notes' }), session('chat-2', {})]

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
  const tabButton = (name: string): Element => {
    const button = [...container.querySelectorAll('.flexlayout__tab_button')].find((candidate) =>
      (candidate.textContent ?? '').includes(name),
    )
    assert.ok(button, `${name} has a tab`)
    return button
  }
  const openMenu = async (name: string): Promise<HTMLElement> => {
    act(() => {
      tabButton(name).dispatchEvent(
        new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
      )
    })
    await settle()
    const menu = dom.window.document.querySelector<HTMLElement>(`[role="menu"][aria-label="Tab actions: ${name}"]`)
    assert.ok(menu, `${name}'s menu opens`)
    return menu
  }
  const closeMenu = async (): Promise<void> => {
    act(() => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settle()
  }
  const rows = (menu: Element): string[] =>
    [...menu.querySelectorAll('[data-menu-item="true"]')]
      .filter((row) => row.closest('[role="menu"]') === menu)
      .map((row) => (row.textContent ?? '').trim())
  const exportRow = (menu: Element) =>
    [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"][aria-haspopup="menu"]')].find((row) =>
      (row.textContent ?? '').startsWith('Export chat'),
    )

  act(() => {
    root.render(React.createElement(WorkspaceLayout, { workspaceId: 'w1', conversationSessions: sessions }))
  })
  await settle()
  return { dom, act, root, settle, openMenu, closeMenu, rows, exportRow, exports, useToastStore }
}

let strip: Awaited<ReturnType<typeof setup>>

beforeAll(async () => {
  strip = await setup()
})

afterAll(() => {
  strip.act(() => strip.root.unmount())
})

test('a chat’s menu has Export chat right after Replay conversation, and it opens its flyout from the keyboard', async () => {
  const { dom, act, settle, openMenu, closeMenu, rows, exportRow } = strip
  const menu = await openMenu('Release notes')
  const order = rows(menu)
  assert.equal(order[order.indexOf('Replay conversation') + 1], 'Export chat', order.join(' | '))
  const row = exportRow(menu)
  assert.ok(row && !row.disabled, 'Export chat is on for a chat with messages')
  assert.equal(row.getAttribute('aria-expanded'), 'false')
  act(() => {
    row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  })
  await settle()
  const flyout = dom.window.document.querySelector<HTMLElement>('[role="menu"][aria-label="Export chat"]')
  assert.ok(flyout, 'the flyout opens')
  assert.deepEqual(rows(flyout), ['Copy chat', 'Copy chat as Markdown', 'PDF…', 'Word document…', 'Markdown…'])
  assert.equal(flyout.querySelectorAll('[role="separator"]').length, 1, 'the copies and the files are apart')
  await closeMenu()
})

test('choosing a row closes the menu and asks main for that export of that chat', async () => {
  const { dom, act, settle, openMenu, exportRow, exports, useToastStore } = strip
  const menu = await openMenu('Release notes')
  act(() => exportRow(menu)!.click())
  await settle()
  const flyout = dom.window.document.querySelector<HTMLElement>('[role="menu"][aria-label="Export chat"]')!
  const copy = [...flyout.querySelectorAll<HTMLButtonElement>('[data-menu-item="true"]')].find(
    (candidate) => candidate.textContent === 'Copy chat',
  )!
  act(() => copy.click())
  await settle()
  assert.deepEqual(exports, [{ workspaceId: 'w1', agentId: 'chat-1', action: 'copy' }])
  assert.equal(dom.window.document.querySelector('[role="menu"]'), null, 'the menu closed')
  assert.ok(useToastStore.getState().toasts.some((toast) => toast.title === 'Chat copied'))
})

test('a chat with no message yet has the row, off, saying why', async () => {
  const { openMenu, closeMenu, exportRow } = strip
  const menu = await openMenu('New chat')
  const off = exportRow(menu)
  assert.ok(off?.disabled, 'Export chat is off for an empty chat')
  assert.match(off.textContent ?? '', /No messages yet/u)
  await closeMenu()
})

test('a terminal has no conversation to export', async () => {
  const { openMenu, closeMenu, rows, exportRow } = strip
  const menu = await openMenu('zsh')
  assert.equal(exportRow(menu), undefined)
  assert.ok(!rows(menu).some((label) => label.startsWith('Export')))
  await closeMenu()
})
