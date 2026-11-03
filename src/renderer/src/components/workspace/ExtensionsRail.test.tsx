import assert from 'node:assert/strict'

// The Extensions drawer (Extensions drawer ruling, 2026-09-05): THREE built-in
// rows in a fixed order — Design · Plugins · Skills — where the last two are two
// views of the ONE `extensions` surface (Agent CLIs was a fourth until the owner
// moved them to Settings ▸ Agents, 2026-09-25). This renders the
// real drawer against the real module registry because the contract is the
// WIRING: the ruling's order survives whatever `order` the modules declared, a
// row opens a DOOR (Stage 2 — the rows stopped opening modals) latched to its
// view, exactly the row the open surface is standing on reads selected, and a
// disabled module's row is simply absent.
//
// The drawer STAYING PUT is the other half of the ruling, and it is a property
// of the surfaces the rows open rather than of this column. There are two ways
// a door leaves the sidebar column alone, and both are asserted here against
// the live registry, because a door that got this wrong would delete the very
// drawer that opened it: it declares `railPlacement: 'inline'` (Design, which
// brings a rail of its own and renders it beside its canvas), or it declares no
// rail at all (Extensions, whose rail became the source tabs on 2026-09-05 —
// GlobalSurfaceShell's contract for a surface that brings none is that the host
// keeps its own column).
import { JSDOM } from 'jsdom'

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { ExtensionsRail } from './ExtensionsRail'
import { ACTIVE_RENDERER_MODULE_MANIFESTS, getRendererHost } from '../../modules'
import { useNotificationStore } from '../../store/notificationStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { SidebarNavButton } from './SidebarNavButton'
import { useRailBadges } from './useRailBadges'
import { getSurfaceView, subscribeSurfaceViews } from './surfaceView'
import ExtensionsGlobalSurface from './globalSurface/extensions/ExtensionsGlobalSurface'
import {
  consumePendingExtensionsSurfaceTarget,
  dispatchExtensionsSurfaceTarget,
} from './globalSurface/extensions/extensionsSurfaceTarget'
import { test } from 'vitest'

test('ExtensionsRail', async () => {
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
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.CustomEvent = dom.window.CustomEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.localStorage = dom.window.localStorage
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
  class FakeResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  anyGlobal.ResizeObserver = FakeResizeObserver
  domWindow.ResizeObserver = FakeResizeObserver
  dom.window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof dom.window.matchMedia
  // The run index store subscribes to main as soon as anything reads it — the
  // drawer does now, for the counts its run-door rows wear — so the stubs answer
  // with no runs rather than throwing on a missing bridge.
  domWindow.api = {}

  // Every root, so the end of the file can unmount them all: the drawer's rows
  // now subscribe to the run index and the design arrivals store, whose hourly
  // refresh would otherwise keep this process alive after the last assertion.
  const roots: Array<ReturnType<typeof createRoot>> = []
  function render(): HTMLElement {
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host as unknown as Element)
    roots.push(root)
    act(() => {
      root.render(React.createElement(ExtensionsRail, { collapsed: false }))
    })
    return host
  }

  const rows = () => [...dom.window.document.querySelectorAll('[role="listitem"] button')] as HTMLElement[]
  // The label span, not the whole row: a row wearing its unread count has the
  // number in its text too, and "Plugins" must still be found as Plugins.
  const labelOf = (row: HTMLElement) => (row.querySelector('span.truncate') ?? row).textContent?.trim() ?? ''
  const rowLabels = () => rows().map(labelOf)
  const row = (label: string) => rows().find((candidate) => labelOf(candidate) === label)
  const badgeOf = (label: string) => row(label)?.querySelector('[role="status"]') ?? null

  // A door row, as a module registers one — on the HOST, which is where the
  // drawer reads them from (it stopped taking them as a prop: the sidebar's memo
  // missed a module that registered late, so the row appeared on the Extensions
  // home and not in the column beside it). The declared `order` is deliberately
  // absurd: the drawer's order is the ruling's, not the registry's.
  const registerDoorEntry = (id: string, order: number, label: string): void => {
    getRendererHost()
      .hostFor('scheduled-agents')
      .registerSidebarNavEntry({
        id,
        order,
        Component: ({ collapsed }: { collapsed: boolean }) =>
          React.createElement(SidebarNavButton, {
            collapsed,
            label,
            ariaLabel: label,
            tooltip: label,
            icon: React.createElement('svg'),
            onClick: () => {},
          }),
      })
  }
  // A decoy nav entry with no surface behind it. Its `order` of 1 would put it
  // first if the drawer took the registry's order — it does not, and a nav entry
  // with no destination is not a row at all.
  registerDoorEntry('roadmap', 1, 'Roadmap')

  // ── The registry says what a view row IS ─────────────────────────────────────
  // The shell holds the ORDER; the agent-runtime module holds what its two rows
  // are called, what they look like and how the surface lands on each.
  const extensions = getRendererHost().getGlobalSurface('extensions')
  assert.ok(extensions, 'the always-on core registers the extensions surface as a DOOR')
  assert.equal(extensions?.label, 'Plugins', 'named by the module, not by its id')
  assert.deepEqual(
    extensions?.views?.map((view) => [view.id, view.label]),
    [
      ['plugins', 'Plugins'],
      ['skills', 'Skills'],
    ],
    'one surface, two drawer rows, each named by the module',
  )

  // ── The drawer stays put ─────────────────────────────────────────────────────
  // A drawer door must not take the sidebar column: the drawer is the navigation
  // that reached it, and the host reads this declaration to decide whether to
  // offer the context-rail slot at all.
  assert.equal(
    getRendererHost().getGlobalSurface('design')?.railPlacement,
    'inline',
    'the design door renders its rail beside its canvas, so the drawer survives it',
  )
  assert.equal(
    getRendererHost().getGlobalSurface('extensions')?.railPlacement,
    undefined,
    'the extensions door declares no rail at all, so the host keeps the drawer',
  )

  // ── The three rows, in the ruled order ───────────────────────────────────────
  // Every module on, explicitly: the resolver filters nav entries by live
  // enablement, and a test store that has never been written to is not the same
  // thing as a machine with the modules turned on.
  const allModulesOn = Object.fromEntries(ACTIVE_RENDERER_MODULE_MANIFESTS.map((manifest) => [manifest.id, true]))
  act(() => {
    useWorkspaceStore.setState((state) => ({
      appSettings: { ...state.appSettings, modules: { ...state.appSettings.modules, ...allModulesOn } },
    }))
  })
  render()
  const addButton = [...dom.window.document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Add extension'),
  ) as HTMLElement | undefined
  assert.ok(addButton, 'the Extensions drawer leads with the add-extension affordance')

  // ── "Add extension" asks where from: a folder, or a GitHub repository ────────
  act(() => {
    addButton.click()
  })
  const addMenu = dom.window.document.querySelector('[role="menu"][aria-label="Add extension"]')
  assert.deepEqual(
    [...(addMenu?.querySelectorAll('button') ?? [])].map((item) => item.textContent?.trim()),
    ['From a folder…', 'From GitHub…'],
  )
  act(() => {
    ;([...(addMenu?.querySelectorAll('button') ?? [])].at(-1) as HTMLElement).click()
  })
  assert.equal(dom.window.document.querySelector('[role="menu"][aria-label="Add extension"]'), null)
  const githubDialog = dom.window.document.querySelector('[role="dialog"]')
  assert.ok(githubDialog?.textContent?.includes('Install extension from GitHub'), 'GitHub opens the install dialog')
  act(() => {
    ;(githubDialog?.querySelector('button[aria-label="Close"]') as HTMLElement).click()
  })
  assert.equal(dom.window.document.querySelector('[role="dialog"]'), null)
  assert.equal(
    dom.window.document.querySelectorAll('[role="listitem"]').length,
    3,
    'the drawer starts with the ruling’s three rows — a nav entry without a surface is not a destination',
  )
  assert.deepEqual(
    rowLabels(),
    ['Design', 'Plugins', 'Skills'],
    'the ruling’s order survives whatever `order` the modules declared',
  )
  assert.ok(!rowLabels().includes('Automations'), 'Automations stands on the app rail, not in the drawer')

  // ── A view row opens its surface latched to that view ────────────────────────
  consumePendingExtensionsSurfaceTarget()
  act(() => {
    row('Skills')?.click()
  })
  assert.equal(
    useWorkspaceStore.getState().activeModalSurface,
    'extensions',
    'a view row opens the Extensions modal that owns it (owner ruling 2026-11-03)',
  )
  assert.equal(useWorkspaceStore.getState().activeGlobalSurface, null, 'and routes no door into the card region')
  assert.deepEqual(
    consumePendingExtensionsSurfaceTarget(),
    { view: 'skills' },
    'and latches the view first, so a surface that mounts a tick later still lands on the clicked row',
  )

  act(() => {
    row('Plugins')?.click()
  })
  assert.deepEqual(
    consumePendingExtensionsSurfaceTarget(),
    { view: 'plugins' },
    'the Plugins row latches the Plugins view itself — `browse` used to stand in for it and stopped reaching it',
  )

  // ── Exactly the row the surface stands on reads selected ─────────────────────
  // The REAL surface, mounted: the selected row is a contract between the surface
  // and this column, and hand-publishing the channel would only prove the column
  // reads what it is told. Every publish is recorded, because the sequence
  // matters as much as the endpoints — a cleanup that fired on each in-surface
  // move published `null` before the new view and the lit row blinked.
  const publishes: Array<string | null> = []
  const stopWatching = subscribeSurfaceViews(() => publishes.push(getSurfaceView('extensions')))
  const surfaceHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(surfaceHost)
  const surfaceRoot = createRoot(surfaceHost as unknown as Element)
  act(() => {
    row('Skills')?.click()
  })
  act(() => {
    surfaceRoot.render(React.createElement(ExtensionsGlobalSurface))
  })
  assert.equal(row('Skills')?.getAttribute('aria-current'), 'true', 'the row the surface is standing on reads selected')
  assert.equal(
    row('Plugins')?.getAttribute('aria-current'),
    null,
    'and its siblings do not — one open surface lights one row',
  )
  assert.equal(row('Agent CLIs'), undefined, 'Agent CLIs is not a drawer row (Settings ▸ Agents lists them)')

  // Moving WITH THE SURFACE (a live deep-link, the same seam its own rail uses)
  // moves the selection, and never through nothing on the way.
  act(() => {
    dispatchExtensionsSurfaceTarget({ view: 'plugins' })
  })
  assert.equal(row('Plugins')?.getAttribute('aria-current'), 'true', 'moving the surface moves the selection')
  assert.equal(row('Skills')?.getAttribute('aria-current'), null)
  assert.ok(
    publishes.length > 0 && !publishes.slice(0, -1).includes(null),
    `an in-surface move never publishes null on the way (saw ${JSON.stringify(publishes)})`,
  )

  // Closing takes the selection with it: no row may stay lit over a card region
  // the surface no longer owns.
  act(() => {
    surfaceRoot.unmount()
    useWorkspaceStore.getState().closeGlobalSurface()
  })
  assert.equal(publishes.at(-1), null, 'the surface publishes null as it leaves')
  assert.ok(
    rows().every((r) => r.getAttribute('aria-current') === null),
    'a closed surface lights nothing',
  )
  stopWatching()

  // ── A whole-surface row still opens plainly ──────────────────────────────────
  act(() => {
    row('Design')?.click()
  })
  assert.equal(
    useWorkspaceStore.getState().activeGlobalSurface,
    'design',
    'the Design row opens the design module’s door',
  )
  assert.equal(row('Design')?.getAttribute('aria-current'), 'true', 'and reads selected while it is open')
  act(() => {
    useWorkspaceStore.getState().closeGlobalSurface()
  })

  // ── A row wears the news that belongs to it ──────────────────────────────────
  // Owner, 2026-09-08: "put the notification on whatever row it came from". The
  // square used to read everything under it as the section opened, and the rows
  // said nothing; now the count sits on the row, and opening THAT row reads it.
  // The rail hook is the reader, so it is mounted beside the drawer the way
  // WorkspaceManager mounts it, reporting the square's count for the sum.
  function RailProbe(): React.ReactElement {
    const activeGlobalSurface = useWorkspaceStore((s) => s.activeGlobalSurface)
    const badges = useRailBadges({
      workspaces: [],
      activityByWorkspaceId: {},
      unseenDoneIds: new Set(),
      snoozedWorkspaceIds: new Set(),
      onScreenWorkspaceId: null,
      activeGlobalSurface,
    })
    return React.createElement('output', { 'data-extensions': String(badges.extensions?.count ?? 0) })
  }
  const probeHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(probeHost)
  const probeRoot = createRoot(probeHost as unknown as Element)
  act(() => {
    probeRoot.render(React.createElement(RailProbe))
  })
  const squareCount = () => Number(probeHost.querySelector('output')?.getAttribute('data-extensions'))

  const notice = (id: string, over: Record<string, unknown>) => ({
    id,
    timestamp: '2026-09-08T21:41:34.767Z',
    level: 'info' as const,
    title: 't',
    message: 'm',
    source: 'marketplace' as const,
    ...over,
  })
  act(() => {
    useNotificationStore
      .getState()
      .addNotification(notice('drift', { source: 'marketplace', extensionsRow: 'plugins' }))
    useNotificationStore
      .getState()
      .addNotification(notice('skill-news', { source: 'marketplace', extensionsRow: 'skills' }))
    useNotificationStore.getState().addNotification(notice('crash', { source: 'terminal', level: 'error' }))
  })
  assert.equal(badgeOf('Plugins')?.textContent, '1', 'the drift notice counts on the Plugins row')
  assert.equal(
    badgeOf('Plugins')?.getAttribute('aria-label'),
    '1 new',
    'what is counted; the row beside it already names the place',
  )
  assert.equal(
    badgeOf('Skills')?.textContent,
    '1',
    'and the skill notice counts on its own row, not on the one beside it',
  )
  assert.equal(badgeOf('Design'), null, 'a row with no news wears no count')
  assert.equal(squareCount(), 2, 'the square is the sum of its rows — the terminal crash counts nowhere')

  // Opening the SECTION does not read a row: the drawer is on screen and the
  // counts are still there to be found.
  act(() => {
    useWorkspaceStore.getState().openGlobalSurface('extensions-home')
  })
  assert.equal(badgeOf('Plugins')?.textContent, '1', 'the drawer opening reads nothing')
  assert.equal(squareCount(), 2)

  // Opening the ROW reads it — once its page is actually on screen, standing on
  // that view, so Plugins opening does not read the Skills news beside it.
  act(() => {
    row('Plugins')?.click()
  })
  // A fresh root: the earlier one was unmounted, and an unmounted root is done.
  const readingHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(readingHost)
  const readingRoot = createRoot(readingHost as unknown as Element)
  act(() => {
    readingRoot.render(React.createElement(ExtensionsGlobalSurface))
  })
  assert.equal(badgeOf('Plugins'), null, 'the row on screen has read its news')
  assert.equal(useNotificationStore.getState().notifications.find((n) => n.id === 'drift')?.read, true)
  assert.equal(
    useNotificationStore.getState().notifications.find((n) => n.id === 'skill-news')?.read,
    false,
    'another row’s news is untouched',
  )
  assert.equal(squareCount(), 1, 'the square drops by exactly what was read')
  act(() => {
    readingRoot.unmount()
    useWorkspaceStore.getState().closeGlobalSurface()
    useNotificationStore.getState().clearAll()
  })

  // The row that is NOT the surface's default view. The surface used to seed
  // its state on Plugins and publish that for a frame before the deep link
  // landed, so a click on Skills read the Plugins news on that frame (review,
  // 2026-09-09). Two notices, one per row; opening Skills reads only its own.
  act(() => {
    useNotificationStore
      .getState()
      .addNotification(notice('drift2', { source: 'marketplace', extensionsRow: 'plugins' }))
    useNotificationStore.getState().addNotification(notice('skill', { source: 'marketplace', extensionsRow: 'skills' }))
  })
  assert.equal(badgeOf('Plugins')?.textContent, '1')
  assert.equal(badgeOf('Skills')?.textContent, '1')
  assert.equal(
    badgeOf('Skills')?.getAttribute('aria-label'),
    '1 new',
    'the row names the place; its badge says only what is counted',
  )
  act(() => {
    row('Skills')?.click()
  })
  const skillsHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(skillsHost)
  const skillsRoot = createRoot(skillsHost as unknown as Element)
  act(() => {
    skillsRoot.render(React.createElement(ExtensionsGlobalSurface))
  })
  assert.equal(getSurfaceView('extensions'), 'skills', 'the surface stands on Skills from its first publish')
  assert.equal(badgeOf('Skills'), null, 'Skills read its own news')
  assert.equal(badgeOf('Plugins')?.textContent, '1', 'and not the Plugins news beside it')
  assert.equal(useNotificationStore.getState().notifications.find((n) => n.id === 'drift2')?.read, false)
  assert.equal(useNotificationStore.getState().notifications.find((n) => n.id === 'skill')?.read, true)
  act(() => {
    skillsRoot.unmount()
    useWorkspaceStore.getState().closeGlobalSurface()
    useNotificationStore.getState().clearAll()
  })

  // Collapsed, the count docks on the row's corner rather than trailing a label
  // the column no longer shows.
  act(() => {
    useNotificationStore
      .getState()
      .addNotification(notice('drift3', { source: 'marketplace', extensionsRow: 'plugins' }))
  })
  const collapsedHost = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(collapsedHost)
  const collapsedRoot = createRoot(collapsedHost as unknown as Element)
  act(() => {
    collapsedRoot.render(React.createElement(ExtensionsRail, { collapsed: true }))
  })
  // Collapsed, the count rides in the button's own name — the badge's live
  // region speaks only on change, and a person arriving at the row must still
  // hear the number — and the badge itself is decorative.
  const collapsedButton = collapsedHost.querySelector('button[aria-label="Plugins, 1 new"]')
  assert.ok(collapsedButton, 'the collapsed row is named with its count')
  // The glyph is hidden from AT too, so pick the hidden element that carries the number.
  const collapsedBadge = [...(collapsedButton?.querySelectorAll('[aria-hidden="true"]') ?? [])].find(
    (element) => element.textContent === '1',
  )
  assert.ok(collapsedBadge, 'a drift notice counts on Plugins, collapsed too')
  assert.ok(collapsedBadge?.className.includes('absolute'), 'docked on the corner, as the rail’s squares wear theirs')
  act(() => {
    collapsedRoot.unmount()
    probeRoot.unmount()
    useNotificationStore.getState().clearAll()
  })

  // ── A disabled module takes its row with it ──────────────────────────────────
  dom.window.document.body.innerHTML = ''
  act(() => {
    useWorkspaceStore.setState((state) => ({
      appSettings: { ...state.appSettings, modules: { ...state.appSettings.modules, design: false } },
    }))
  })
  render()
  assert.deepEqual(
    rowLabels(),
    ['Plugins', 'Skills'],
    'rows for modules that are off are absent rather than dead, and the rest keep their order',
  )

  act(() => {
    for (const root of roots) root.unmount()
  })

  console.log('ExtensionsRail.test.tsx: ok')
})
