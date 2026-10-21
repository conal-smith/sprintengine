import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('WorkspaceLayout.remoteTab', async () => {
  // The tab of a pane open on a paired machine's chat reads as a local chat's
  // tab does (owner, 2026-10-17: "I shouldn't be able to notice any difference
  // other than the fact that I have the icon of the remote machine"): the
  // CLI's mark before its name and how long since its agent finished after
  // it, from what that machine listed. It used to wear the bare chat glyph and
  // no time at all.

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

  const hour = 60 * 60_000
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { default: WorkspaceLayout } = await import('./WorkspaceLayout')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  const { publishRemoteConversationList, resetRemoteConversationFacts } =
    await import('./remoteBand/remoteConversationFacts')
  const { MESH_CONVERSATION_COMPONENT, meshConversationSessionId } = await import('../../../../shared/tailnet-mesh')

  const remoteTab = {
    type: 'tab',
    id: 'mesh-conversation:c1:rw1:agent-1',
    name: 'How is this project?',
    component: MESH_CONVERSATION_COMPONENT,
    config: {
      connectionId: 'c1',
      machineName: 'mac-mini',
      remoteWorkspaceId: 'rw1',
      remoteAgentId: 'agent-1',
      remoteSessionId: meshConversationSessionId('rw1', 'agent-1'),
      title: 'How is this project?',
    },
  }
  // Selected elsewhere, so the pane itself never mounts: this is about the tab.
  const otherTab = { type: 'tab', id: 'notes', name: 'Notes', component: 'not-a-panel' }
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
            children: [{ type: 'tabset', id: 'ts1', selected: 1, children: [remoteTab, otherTab] }],
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
  const tabButton = (): Element => {
    const button = [...container.querySelectorAll('.flexlayout__tab_button')].find((candidate) =>
      (candidate.textContent ?? '').includes('How is this project?'),
    )
    assert.ok(button, `the remote chat has a tab: ${container.innerHTML.slice(0, 400)}`)
    return button
  }

  try {
    resetRemoteConversationFacts()
    act(() => {
      root.render(React.createElement(WorkspaceLayout, { workspaceId: 'w1' }))
    })
    await settle()

    // Before the machine's list is read there is nothing to say but "a chat".
    assert.ok(tabButton().querySelector('[aria-label="Chat"]'), 'an unread chat wears the chat glyph')
    assert.ok(tabButton().querySelector('[aria-label="Remote: mac-mini"], [aria-label*="mac-mini"]'), 'and the machine')

    act(() => {
      publishRemoteConversationList('c1', [
        {
          workspaceId: 'rw1',
          agentId: 'agent-1',
          title: 'Agent one',
          phase: 'completed',
          updatedAt: Date.now() - 2 * hour,
          createdAt: Date.now() - 5 * hour,
          lastTurnEndedAt: Date.now() - 3 * hour,
          providerId: 'claude-agent',
          modelId: 'opus',
          turnCount: 2,
          lastSeq: 8,
        } as never,
      ])
    })
    await settle()

    const listed = tabButton()
    assert.ok(
      listed.querySelector('[aria-label="Claude Code chat"]'),
      `the CLI's mark, as a local chat's tab: ${listed.innerHTML}`,
    )
    assert.equal(listed.querySelector('[aria-label="Chat"]'), null, 'not the bare chat glyph')
    assert.ok((listed.textContent ?? '').includes('3h'), `how long since its agent finished: ${listed.textContent}`)
    assert.ok(listed.querySelector('[aria-label*="mac-mini"]'), 'and still the machine it runs on')

    // A turn running over there is the working mark, and no clock.
    act(() => {
      publishRemoteConversationList('c1', [
        {
          workspaceId: 'rw1',
          agentId: 'agent-1',
          title: 'Agent one',
          phase: 'running',
          sessionId: 's1',
          updatedAt: Date.now(),
          createdAt: Date.now() - 5 * hour,
          lastTurnEndedAt: Date.now() - 3 * hour,
          providerId: 'claude-agent',
          modelId: 'opus',
          turnCount: 3,
          lastSeq: 9,
        } as never,
      ])
    })
    await settle()
    const running = tabButton()
    assert.ok(
      running.querySelector('[aria-label="Working"]'),
      `a running turn wears the working mark: ${running.innerHTML}`,
    )
    assert.ok(!(running.textContent ?? '').includes('3h'), 'and no idle clock')
  } finally {
    act(() => root.unmount())
    resetRemoteConversationFacts()
  }
})
