import type { JSX } from 'react'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('contextRail', async () => {
  // Item 1993 — drill-in REPLACES the rail. Three claims this suite holds to,
  // because each of them is silent when it breaks:
  //
  //   1. A surface's rail lifts OUT of the shell into the host's column, and the
  //      shell stops rendering its inline aside. Miss that and the app is back to
  //      two navigation columns. The bar's back chevron survives the lift — it is
  //      the door's ONE way out, on either host, and it used to be suppressed
  //      here in favour of a row pinned to the column's bottom.
  //   2. The app sidebar hides its own rail while a surface owns the column, and
  //      the row that opened the surface stays in the DOM so leaving can hand
  //      focus back to it. Unmounting it instead reads identical on screen and
  //      quietly loses the keyboard.
  //   3. Escape leaves the SURFACE, not whatever is open on top of it. A dialog, a
  //      menu and a listbox each close themselves first; a keystroke from the
  //      door's own rail or canvas is the door's.

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
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
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
  domWindow.api = { platform: 'darwin' }

  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { ContextRailColumn, ContextRailSlotContext, escapeLeavesSurface } = await import('./contextRail')
    const { GlobalSurfaceShell } = await import('./GlobalSurfaceShell')
    const { SurfaceExitContext, useSurfaceBackNav } = await import('./surfaceBackNav')
    const { SIDEBAR_DEFAULT_WIDTH } = await import('../sidebarWidth')
    const { default: WorkspaceSidebar } = await import('../WorkspaceSidebar')

    const document = dom.window.document

    function mount(node: React.ReactNode): { container: HTMLElement; unmount: () => void } {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => {
        root.render(node)
      })
      return {
        container: container as unknown as HTMLElement,
        unmount: () => {
          act(() => root.unmount())
          container.remove()
        },
      }
    }

    // ── 1. the shell lifts its rail, and keeps its back chevron either way ──────

    run('with no host column the shell keeps its inline aside, at the ONE rail width', () => {
      const view = mount(
        <GlobalSurfaceShell
          ariaLabel="Backlog"
          bar={{ title: 'summer26' }}
          rail={
            <button type="button" data-testid="rail-row">
              summer26
            </button>
          }
          onBack={() => undefined}
          canGoBack
        >
          <div>canvas</div>
        </GlobalSurfaceShell>,
      )
      const aside = view.container.querySelector('aside')
      assert.ok(aside, 'the fallback host still gets a rail')
      assert.equal(
        (aside as HTMLElement).style.width,
        `${SIDEBAR_DEFAULT_WIDTH}px`,
        'and it is the app sidebar width, not a second rail width of its own',
      )
      assert.ok(aside!.querySelector('[data-testid="rail-row"]'), 'the rail content is inside it')
      assert.ok(view.container.querySelector('button[aria-label="Back"]'), 'and the bar chevron is the way out')
      view.unmount()
    })

    run('given a host column the rail moves into it and the bar chevron stays', () => {
      const slot = document.createElement('div')
      document.body.appendChild(slot)
      const view = mount(
        <ContextRailSlotContext.Provider value={{ el: slot as unknown as HTMLElement }}>
          <GlobalSurfaceShell
            ariaLabel="Backlog"
            bar={{ title: 'summer26' }}
            rail={
              <button type="button" data-testid="rail-row">
                summer26
              </button>
            }
            onBack={() => undefined}
            canGoBack
          >
            <div>canvas</div>
          </GlobalSurfaceShell>
        </ContextRailSlotContext.Provider>,
      )
      assert.equal(view.container.querySelector('aside'), null, 'no second navigation column beside the host’s')
      assert.ok(slot.querySelector('[data-testid="rail-row"]'), 'the rail rendered into the host’s column')
      // The rail taking the sidebar over used to SUPPRESS this chevron, on the
      // grounds that the rail's own pinned row was the way out. Every door hands
      // over a rail, so that suppression was total — the chevron never rendered in
      // the product, and the only exit sat at the bottom of a scrolling column.
      // Still one affordance; it is this one now, beside the door's name.
      assert.ok(
        view.container.querySelector('button[aria-label="Back"]'),
        'and the bar chevron stays — the exit belongs beside the door’s name, not below its rail',
      )
      view.unmount()
      slot.remove()
    })

    // Rail presence is the SURFACE's to declare, and every door on the substrate
    // declares one in every load state (globalDoorsIntegration §8 holds them to
    // it). This is the other half of that contract: a surface that genuinely brings
    // none must still have a way out, or withholding a rail would be a way to build
    // a page with no exit.
    run('a surface with no rail replaces nothing, and keeps its one way back', () => {
      const slot = document.createElement('div')
      document.body.appendChild(slot)
      const presence: boolean[] = []
      const view = mount(
        <ContextRailSlotContext.Provider
          value={{ el: slot as unknown as HTMLElement, onRailPresence: (present) => presence.push(present) }}
        >
          <GlobalSurfaceShell ariaLabel="Settings" bar={{ title: 'Settings' }} onBack={() => undefined} canGoBack>
            <div>a canvas-only tenant</div>
          </GlobalSurfaceShell>
        </ContextRailSlotContext.Provider>,
      )
      assert.deepEqual(presence, [false], 'the host is told there is no rail to take')
      assert.ok(
        view.container.querySelector('button[aria-label="Back"]'),
        'so the bar chevron stays — otherwise this door would have no way out at all',
      )
      view.unmount()
      slot.remove()
    })

    // The chevron is rendered inside the SURFACE's tree, but leaving a door is the
    // host's business: only the host captured the row that opened it, and only the
    // host can refocus that row in the commit its rail comes back. The rail row this
    // replaces was the host's own element and got that for free; the chevron has to
    // route through the host explicitly, or it closes the door and drops the
    // keyboard on `<body>`.
    run('the bar chevron leaves through the host, so the keyboard goes back with it', () => {
      const order: string[] = []
      // A door exactly as the real ones are built: its back comes from the hook,
      // not from a handler the test invented.
      function Door({ close }: { close: () => void }): JSX.Element {
        const back = useSurfaceBackNav(close)
        return (
          <GlobalSurfaceShell
            ariaLabel="Extensions"
            bar={{ title: 'Extensions' }}
            onBack={back.onBack}
            canGoBack={back.canGoBack}
          >
            <div>canvas</div>
          </GlobalSurfaceShell>
        )
      }
      const view = mount(
        <SurfaceExitContext.Provider
          value={{
            leave: (close) => {
              order.push('host-leave')
              // The door passed an explicit close override here; a host still
              // supplies its own default for a surface that passes none
              // (doors→modals, 2026-09-01).
              close?.()
            },
          }}
        >
          <Door close={() => order.push('close')} />
        </SurfaceExitContext.Provider>,
      )
      const chevron = view.container.querySelector('button[aria-label="Back"]') as HTMLElement | null
      assert.ok(chevron, 'the door has a bar chevron')
      act(() => {
        chevron!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.deepEqual(
        order,
        ['host-leave', 'close'],
        'the host’s leave wraps the door’s close — arming the focus restore BEFORE the door goes',
      )
      view.unmount()
    })

    // Tests and storybook have no host. The door must still close there, or the
    // hook would make the exit depend on a provider the surface cannot see.
    run('with no host in scope the chevron still closes the door', () => {
      let closed = 0
      function Door(): JSX.Element {
        const back = useSurfaceBackNav(() => {
          closed += 1
        })
        return (
          <GlobalSurfaceShell ariaLabel="Extensions" bar={{ title: 'Extensions' }} onBack={back.onBack} canGoBack>
            <div>canvas</div>
          </GlobalSurfaceShell>
        )
      }
      const view = mount(<Door />)
      const chevron = view.container.querySelector('button[aria-label="Back"]') as HTMLElement
      act(() => {
        chevron.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      assert.equal(closed, 1, 'closed, just with no trigger to hand the keyboard back to')
      view.unmount()
    })

    // ── 2. the rail column, and the sidebar it replaces ─────────────────────────

    run('the host column is the rail scrollport and nothing else', () => {
      const view = mount(
        <ContextRailColumn surfaceKey="backlog" ariaLabel="Backlog rail" active railRef={() => undefined} />,
      )
      const column = view.container.querySelector('[data-context-rail]')
      assert.ok(column, 'the column is findable by the marker Escape resolution uses')
      const children = [...column!.children] as HTMLElement[]
      assert.equal(children.length, 1, 'the scrollport, and nothing pinned under it')
      assert.equal(children[0].getAttribute('aria-label'), 'Backlog rail', 'the scrollport is the named rail')
      // The column carries navigation only. Back used to be a row pinned here,
      // below the scrollport — reaching it meant travelling past every row the
      // door brought, so it moved to the bar beside the door's name.
      assert.equal(
        column!.querySelector('button'),
        null,
        'no control of the column’s own — the way out is the door’s bar chevron',
      )
      view.unmount()
    })

    run('the sidebar hides its own rail for a surface, keeping the trigger reachable', () => {
      type SidebarProps = Parameters<typeof WorkspaceSidebar>[0]
      const noop = (): void => {}
      const baseProps = {
        workspaces: [{ id: 'w1', name: 'Alpha', mode: 'standard', folderPath: '/projA' }],
        activeWorkspaceId: 'w1',
        workspaceWindowId: 'win1',
        isDetachedWindow: false,
        sidebarCollapsed: false,
        chromeSlot: <div data-testid="chrome">chrome</div>,
        activityByWorkspaceId: {},
        residentWorkspaceIds: new Set<string>(),
        terminalRecencyByWorkspaceId: {},
        onSelectWorkspace: noop,
        onMoveWorkspaceToNewWindow: noop,
        onMoveWorkspaceToMainWindow: noop,
        onForgetFolder: noop,
        onNewChat: noop,
        onNewChatInFolder: noop,
        onRevealFolder: noop,
        onSetSidebarCollapsed: noop,
        sidebarWidth: 260,
        onSetSidebarWidth: noop,
        authState: { authenticated: false },
        authMessage: null,
        accountOpen: false,
        setAccountOpen: noop,
        startLogin: noop,
        refreshAuthState: noop,
        logout: noop,
        openSettings: noop,
        settingsOpen: false,
      } as unknown as SidebarProps

      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => {
        root.render(<WorkspaceSidebar {...baseProps} />)
      })
      const tree = container.querySelector('nav[role="tree"]') as HTMLElement | null
      assert.ok(tree, 'the workspaces rail is there to begin with')
      assert.equal(tree!.className.includes('hidden'), false, 'and visible')

      act(() => {
        root.render(
          <WorkspaceSidebar
            {...baseProps}
            contextRail={<div data-testid="surface-rail">surface rail</div>}
            contextRailActive
          />,
        )
      })
      assert.ok(container.querySelector('[data-testid="surface-rail"]'), 'the surface’s rail took the column')
      assert.ok(container.querySelector('[data-testid="chrome"]'), 'the chrome strip above does NOT swap')
      const hiddenTree = container.querySelector('nav[role="tree"]') as HTMLElement | null
      assert.ok(hiddenTree, 'the workspaces rail stays MOUNTED — the door’s trigger has to survive')
      assert.ok(hiddenTree!.className.includes('hidden'), 'and hidden, so it is neither seen nor tabbable')

      act(() => {
        root.render(<WorkspaceSidebar {...baseProps} />)
      })
      const restored = container.querySelector('nav[role="tree"]') as HTMLElement | null
      assert.equal(restored!.className.includes('hidden'), false, 'leaving the door restores the rail it replaced')
      act(() => root.unmount())
      container.remove()
    })

    // ── 3. whose Escape is it ───────────────────────────────────────────────────

    run('Escape belongs to the surface only when nothing is open on top of it', () => {
      const region = document.createElement('div')
      region.innerHTML = `
      <button id="canvas-control" type="button">Approve</button>
      <div role="dialog"><button id="in-dialog" type="button">Confirm</button></div>
      <div role="menu"><button id="in-menu" type="button">Remove step</button></div>
      <div role="listbox"><div id="in-listbox" tabindex="-1">Opus</div></div>
    `
      const railColumn = document.createElement('div')
      railColumn.setAttribute('data-context-rail', '')
      railColumn.innerHTML = '<button id="rail-row" type="button">summer26</button>'
      const outside = document.createElement('button')
      document.body.append(region, railColumn, outside)
      const at = (id: string): HTMLElement => region.querySelector(`#${id}`) as HTMLElement
      const asRegion = region as unknown as HTMLElement

      assert.equal(escapeLeavesSurface(at('canvas-control'), asRegion), true, 'from the canvas: leave the door')
      assert.equal(
        escapeLeavesSurface(railColumn.querySelector('#rail-row') as HTMLElement, asRegion),
        true,
        'from the rail column: leave the door, even though the rail is not inside the canvas region',
      )
      assert.equal(escapeLeavesSurface(at('in-dialog'), asRegion), false, 'a dialog closes itself first')
      assert.equal(escapeLeavesSurface(at('in-menu'), asRegion), false, 'so does a menu')
      assert.equal(escapeLeavesSurface(at('in-listbox'), asRegion), false, 'so does a listbox')
      assert.equal(
        escapeLeavesSurface(outside as unknown as HTMLElement, asRegion),
        false,
        'and a keystroke from outside the surface is not the surface’s to act on',
      )
      assert.equal(escapeLeavesSurface(null, asRegion), false, 'nothing focused, nothing to leave')
      assert.equal(
        escapeLeavesSurface(at('canvas-control'), null),
        false,
        'no surface region mounted yet: the canvas cannot claim the key',
      )
      region.remove()
      railColumn.remove()
      outside.remove()
    })

    // The rail's New/search head paints NO ground, in either host column (owner,
    // 2026-07-30). It used to be `sticky` INSIDE the scrolling column, so it had to
    // paint an opaque material to occlude the rows sliding under it — and an opaque
    // material is a different colour from the chrome around it, which is what made
    // the head read as a solid slab dropped into the bar. Under the glass window
    // material the column goes transparent for the OS frost and the slab stayed
    // opaque on top of it, so the seam was at its worst exactly where the material
    // is meant to be continuous.
    //
    // The head is now a SIBLING of the scrollport (the app sidebar's own shape), so
    // no row can reach it and it inherits the column — transparent included. These
    // assert the structure that makes a ground unnecessary; reintroducing one, or
    // moving the scrollport back onto a host column, brings the slab back.
    // Asserted on source because jsdom resolves neither custom properties nor
    // scroll geometry.
    {
      const railSource = readFileSync(
        join(process.cwd(), 'src/renderer/src/components/workspace/globalSurface/contextRail.tsx'),
        'utf8',
      )
      // The declaration form (`[--rail-ground:…]`), not the bare name — the comment
      // above the column explains why the property is gone and must stay sayable.
      assert.ok(
        !/\[--rail-ground:/.test(railSource),
        'the rail column declares no --rail-ground: the head it grounded is no longer sticky',
      )
      assert.ok(
        !/overflow-y-auto/.test(railSource),
        'and the column is not the scrollport — the rail owns that, so its head can sit outside it',
      )

      const substrateSource = readFileSync(
        join(process.cwd(), 'src/renderer/src/components/workspace/globalSurface/surfaceSubstrate.tsx'),
        'utf8',
      )
      // The head element's own class list — read from the `className` attribute
      // rather than the surrounding source, so the comment explaining why the head
      // is no longer sticky does not satisfy (or fail) its own assertion.
      const head = substrateSource.slice(substrateSource.indexOf('export function SurfaceRailHeader'))
      const headClasses = head.slice(0, head.indexOf('<button')).match(/className="([^"]*)"/)?.[1]
      assert.ok(headClasses, 'the rail head renders an element with a class list')
      assert.ok(
        !/\bsticky\b/.test(headClasses ?? ''),
        'the head is not sticky: nothing scrolls under it, so nothing has to be occluded',
      )
      assert.ok(
        !/\bbg-\[/.test(headClasses ?? ''),
        'and it paints no background of its own — it is the colour of the column it sits in',
      )
      console.log('ok - the rail head paints no ground and sits outside the scrollport')
    }

    console.log('context rail: all checks passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})
