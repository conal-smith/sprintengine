import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('TerminalLinkMenu', async () => {
  // The terminal link chooser. `terminalLinkActions` is unit-tested for
  // WHICH rows appear; this suite stands up the real menu in a DOM and pins what
  // each row DOES — the wiring that a pure test cannot reach. The Electron app
  // cannot be driven headlessly, so this is the closest thing to clicking the row.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  // The jsdom window also carries the preload bridge (`window.api`); assignments go
  // through this typed alias so they stay checked instead of landing on `unknown`.
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
  anyGlobal.CustomEvent = dom.window.CustomEvent
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

  // Every destination the menu can reach, recorded rather than performed.
  const calls: string[] = []
  domWindow.api = {
    platform: 'darwin',
    openExternal: async (url: string) => {
      calls.push(`openExternal:${url}`)
      return { ok: true }
    },
    openHtmlFileInBrowser: async (path: string) => {
      calls.push(`openHtmlFileInBrowser:${path}`)
    },
    clipboardWriteText: async (text: string) => {
      calls.push(`clipboard:${text}`)
    },
    readfile: async (path: string) => {
      calls.push(`readfile:${path}`)
      return 'contents'
    },
    showItemInFolder: async (path: string) => {
      calls.push(`showItemInFolder:${path}`)
    },
  }

  const ROOT = '/repo'
  const WORKSPACE = 'ws-1'

  function run(name: string, body: () => void | Promise<void>): Promise<void> {
    return Promise.resolve(body()).then(
      () => {
        console.log(`ok - ${name}`)
      },
      (error) => {
        console.error(`not ok - ${name}`)
        throw error
      },
    )
  }

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { TerminalLinkMenu } = await import('./TerminalLinkMenu')
    const { consumePendingBacklogReveal } = await import('../../utils/backlogReveal')
    const { consumePendingFileReveal } = await import('../../utils/fileReveal')

    // jsdom ships no types, so annotate the mount point: without it every query
    // off `container` degrades to `unknown` and nothing in this file is checked.
    const container: HTMLDivElement = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)

    type Target = Parameters<typeof TerminalLinkMenu>[0]['target']

    let closed = 0
    const errors: string[] = []

    function mount(target: Target, revealInSystemLabel?: string): { unmount: () => void } {
      const root = createRoot(container)
      act(() => {
        root.render(
          React.createElement(TerminalLinkMenu, {
            workspaceId: WORKSPACE,
            target,
            x: 40,
            y: 40,
            onClose: () => {
              closed += 1
            },
            onError: (message: string) => errors.push(message),
            revealInSystemLabel,
          }),
        )
      })
      return {
        unmount: () => {
          act(() => root.unmount())
        },
      }
    }

    // Queried off the DOCUMENT, not off `container`. `ContextMenu` portals its
    // surface to `document.body` — it has to, because a `position: fixed` menu is
    // clipped by any ancestor carrying a transform, and the panels it opens over
    // carry one permanently. So the rows are a sibling of the mount point, never a
    // descendant, and every query off `container` silently matched nothing: the
    // deep-equal below compared [] against the expected labels and this whole file
    // went red the day the portal landed.
    const rows = (): HTMLElement[] => Array.from(dom.window.document.querySelectorAll('[data-menu-item="true"]'))

    function labels(): string[] {
      return rows().map((node) => node.textContent?.trim() ?? '')
    }

    function click(label: string): void {
      const button = rows().find((node) => node.textContent?.trim() === label)
      assert.ok(button, `menu has a "${label}" row`)
      act(() => {
        button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    const fileTarget = (resolvedPath: string, isDirectory = false): Target => ({
      kind: 'file',
      resolvedPath,
      isDirectory,
      workspaceRoot: ROOT,
    })

    await run('a Backlog item leads with Open in Backlog', () => {
      const view = mount(fileTarget(`${ROOT}/backlog/2026-07-26-thing.md`))
      assert.deepEqual(labels(), [
        'Open in Backlog',
        'Open in editor',
        'Open in pop-out window',
        'Reveal in Files',
        'Copy path',
      ])
      view.unmount()
    })

    await run('Open in Backlog latches the item for the Backlog panel', () => {
      const view = mount(fileTarget(`${ROOT}/backlog/2026-07-26-thing.md`))
      const before = closed
      click('Open in Backlog')
      assert.equal(closed, before + 1, 'the menu closes on activation')
      assert.equal(
        consumePendingBacklogReveal(WORKSPACE),
        'backlog/2026-07-26-thing.md',
        'the project-relative path is latched, not the absolute one',
      )
      view.unmount()
    })

    await run('Reveal in Files latches the absolute path for the Files panel', () => {
      const view = mount(fileTarget(`${ROOT}/src/App.tsx`))
      click('Reveal in Files')
      assert.equal(consumePendingFileReveal(WORKSPACE), `${ROOT}/src/App.tsx`)
      view.unmount()
    })

    await run('an HTML file leads with Open in browser and reaches the browser', async () => {
      const view = mount(fileTarget(`${ROOT}/backlog/mockups/thing.html`))
      assert.equal(labels()[0], 'Open in browser', 'a mockup is not offered as a Backlog item')
      calls.length = 0
      click('Open in browser')
      await act(async () => {})
      assert.deepEqual(calls, [`openHtmlFileInBrowser:${ROOT}/backlog/mockups/thing.html`])
      view.unmount()
    })

    await run('Copy path copies the resolved path', async () => {
      const view = mount(fileTarget(`${ROOT}/src/App.tsx`))
      calls.length = 0
      click('Copy path')
      await act(async () => {})
      assert.deepEqual(calls, [`clipboard:${ROOT}/src/App.tsx`])
      view.unmount()
    })

    await run('Open in editor reads the file rather than routing through the pop-out preference', async () => {
      const view = mount(fileTarget(`${ROOT}/src/App.tsx`))
      calls.length = 0
      click('Open in editor')
      await act(async () => {})
      assert.deepEqual(calls, [`readfile:${ROOT}/src/App.tsx`])
      view.unmount()
    })

    await run('a directory offers only the locate group', () => {
      const view = mount(fileTarget(`${ROOT}/src`, true))
      assert.deepEqual(labels(), ['Reveal in Files', 'Copy path'])
      view.unmount()
    })

    await run('offered a system reveal, the menu shows the file in the file manager', async () => {
      const view = mount(fileTarget(`${ROOT}/src/App.tsx`), 'Reveal in Finder')
      assert.deepEqual(labels(), [
        'Open in editor',
        'Open in pop-out window',
        'Reveal in Files',
        'Reveal in Finder',
        'Copy path',
      ])
      calls.length = 0
      click('Reveal in Finder')
      await act(async () => {})
      assert.deepEqual(calls, [`showItemInFolder:${ROOT}/src/App.tsx`])
      view.unmount()
    })

    await run('not offered one (a terminal link), the menu has no system reveal', () => {
      const view = mount(fileTarget(`${ROOT}/src/App.tsx`))
      assert.equal(labels().includes('Reveal in Finder'), false)
      view.unmount()
    })

    await run('a web link offers open and copy, and opens externally', async () => {
      const view = mount({ kind: 'url', url: 'https://example.com/x' })
      assert.deepEqual(labels(), ['Open in browser', 'Copy link'])
      calls.length = 0
      click('Open in browser')
      await act(async () => {})
      assert.deepEqual(calls, ['openExternal:https://example.com/x'])
      view.unmount()
    })

    await run('the surface is a named menu and Escape closes it', () => {
      const view = mount(fileTarget(`${ROOT}/src/App.tsx`))
      const surface = dom.window.document.querySelector('[role="menu"]')
      assert.ok(surface, 'renders a role="menu" surface')
      assert.equal(
        surface.getAttribute('aria-label'),
        `Open ${ROOT}/src/App.tsx`,
        'the clicked path is the accessible name',
      )
      const before = closed
      act(() => {
        // On `document`, not `window`. ContextMenu moved its Escape listener to
        // document so it runs before a host Modal's window listener and only the
        // topmost surface closes; an event dispatched ON window is already at the
        // top of the propagation path and never reaches a document listener, so
        // the old window dispatch tested nothing. A real keypress targets the
        // focused element and bubbles up through document, which this matches.
        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
      assert.equal(closed, before + 1, 'Escape closes')
      view.unmount()
    })

    assert.deepEqual(errors, [], 'no destination reported an error')
    console.log('TerminalLinkMenu.test.tsx passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
