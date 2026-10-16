import assert from 'node:assert/strict'

import { Actions, Model, Rect, type IJsonModel } from 'flexlayout-react'
import {
  addAgentTabTiled,
  addNewAgentTab,
  addTerminalTab,
  convertNewAgentTabToAgent,
  removeNewAgentTab,
  NEW_AGENT_TAB_COMPONENT,
  captureRailWidthFraction,
  consumePendingAgentFlash,
  flashAgentTab,
  focusedAgentTabInLayout,
  focusOrAddFileTab,
  registerModel,
  restoreRailWidthFraction,
  revealAgentTab,
  unregisterModel,
  togglePanelRailComponent,
  NAV_RAIL_COMPONENTS,
} from './modelRegistry'
import { test } from 'vitest'

test('modelRegistry', async () => {
  const WS = 'modelregistry-test-ws'

  // addAgentTabTiled schedules its spawn-flash cleanup via window.setTimeout; node
  // has no window, so provide a no-op shim.
  const globalWithWindow = globalThis as unknown as { window?: { setTimeout: () => number } }
  if (!globalWithWindow.window) globalWithWindow.window = { setTimeout: () => 0 }

  // A workspace whose only open panel is the strip-less sidebar nav pane
  // (Knowledge Graph) — the regression case where a terminal/agent used to spawn
  // buried under the sidebar.
  function navOnlyModel(): Model {
    const json: IJsonModel = {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            enableTabStrip: false,
            children: [{ type: 'tab', name: 'Knowledge Graph', component: 'memory-graph' }],
          },
        ],
      },
    }
    return Model.fromJson(json)
  }

  // Minimal layout: a single agent tabset (stands in for the right-hand
  // terminals/agents column the nav pane must never displace).
  function freshModel(): Model {
    const json: IJsonModel = {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [{ type: 'tab', name: 'Agent', component: 'agent', config: { agentId: 'a-1' } }],
          },
        ],
      },
    }
    return Model.fromJson(json)
  }

  type TabsetJson = {
    type?: string
    id?: string
    component?: string
    enableTabStrip?: boolean
    selected?: number
    minWidth?: number
    children?: TabsetJson[]
  }
  type TabJson = TabsetJson & {
    name?: string
    enableClose?: boolean
    className?: string
    contentClassName?: string
    config?: { agentId?: string; filePath?: string }
  }

  function tabsets(model: Model): TabsetJson[] {
    const out: TabsetJson[] = []
    const walk = (node: TabsetJson | undefined) => {
      if (!node) return
      if (node.type === 'tabset') out.push(node)
      node.children?.forEach(walk)
    }
    walk((model.toJson() as unknown as { layout: TabsetJson }).layout)
    return out
  }

  function componentsOf(tabset: TabsetJson): string[] {
    return (tabset.children ?? []).map((child) => child.component ?? '')
  }

  function allComponents(model: Model): string[] {
    const out: string[] = []
    const walk = (node: TabsetJson | undefined) => {
      if (!node) return
      if (node.type === 'tab' && node.component) out.push(node.component)
      node.children?.forEach(walk)
    }
    walk((model.toJson() as unknown as { layout: TabsetJson }).layout)
    return out
  }

  function allTabs(model: Model): TabJson[] {
    const out: TabJson[] = []
    const walk = (node: TabJson | undefined) => {
      if (!node) return
      if (node.type === 'tab') out.push(node)
      node.children?.forEach(walk)
    }
    walk((model.toJson() as unknown as { layout: TabJson }).layout)
    return out
  }

  function tabNames(model: Model): string[] {
    return allTabs(model).map((tab) => tab.name ?? '')
  }

  function navTabsets(model: Model): TabsetJson[] {
    const nav = new Set(['memory-graph'])
    return tabsets(model).filter((tabset) => componentsOf(tabset).some((c) => nav.has(c)))
  }

  // First nav toggle docks a strip-less LEFT pane holding only that switch.
  {
    const model = freshModel()
    registerModel(WS, model)
    togglePanelRailComponent(WS, 'memory-graph', 'Knowledge Graph')
    const nav = navTabsets(model)
    assert.equal(nav.length, 1)
    assert.deepEqual(componentsOf(nav[0]), ['memory-graph'])
    assert.equal(nav[0].enableTabStrip, false)
    unregisterModel(WS)
  }

  // Clicking the open switch again closes the nav pane.
  {
    const model = freshModel()
    registerModel(WS, model)
    togglePanelRailComponent(WS, 'memory-graph', 'Knowledge Graph')
    assert.equal(navTabsets(model).length, 1)
    togglePanelRailComponent(WS, 'memory-graph', 'Knowledge Graph')
    assert.equal(navTabsets(model).length, 0)
    unregisterModel(WS)
  }

  // Backlog is NOT a nav-rail component any more (store v74): it is a workspace
  // pane tab, and the rail refuses it rather than docking a tab the layout can
  // no longer render.
  {
    const model = freshModel()
    registerModel(WS, model)
    // The toggle path refuses it rather than falling through to the Editor's
    // toggle and docking a 'backlog' document tab centre-stage.
    assert.equal(togglePanelRailComponent(WS, 'backlog', 'Backlog'), false)
    assert.ok(!allComponents(model).includes('backlog'))
    unregisterModel(WS)
  }

  // The nav rail holds exactly one component: a door surface is instance-global
  // and lives outside any workspace layout, so it is never one.
  {
    assert.deepEqual([...NAV_RAIL_COMPONENTS], ['memory-graph'])
    assert.equal(NAV_RAIL_COMPONENTS.has('automations'), false)
  }

  // Agent reveal activates the target workspace and focuses the concrete agent
  // tab when the workspace's live FlexLayout model is mounted.
  {
    const model = freshModel()
    const active: string[] = []
    let updatedLayout: IJsonModel | null = null
    registerModel(WS, model)
    assert.equal(
      revealAgentTab(
        {
          workspaceId: WS,
          agentId: 'a-1',
        },
        {
          getWorkspace: () => ({
            id: WS,
            layoutModel: model.toJson(),
            agents: { 'a-1': { name: 'Review agent' } },
          }),
          setActiveWorkspace: (workspaceId) => active.push(workspaceId),
          updateLayout: (_workspaceId, layoutModel) => {
            updatedLayout = layoutModel
          },
        },
      ),
      true,
    )
    assert.deepEqual(active, [WS])
    assert.equal(updatedLayout, null)
    assert.deepEqual(tabNames(model), ['Review agent'])
    unregisterModel(WS)
  }

  // Reveal into the hidden Automations host: "Open agent" activates the host
  // workspace and focuses the run's concrete agent tab, preserving the green-flash
  // reveal. The host is mode-agnostic to the reveal ports (its hidden-ness is
  // enforced at the WorkspaceManager activation layer, T4), so the fixture stands
  // in for the host's own layout — a mounted model whose only content is the run's
  // agent terminal.
  {
    const hostJson: IJsonModel = {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [{ type: 'tab', name: 'agent', component: 'agent', config: { agentId: 'host-run-1' } }],
          },
        ],
      },
    }
    const hostModel = Model.fromJson(hostJson)
    const HOST_WS = 'automations-host-ws'
    const active: string[] = []
    let updatedLayout: IJsonModel | null = null
    registerModel(HOST_WS, hostModel)
    assert.equal(
      revealAgentTab(
        {
          workspaceId: HOST_WS,
          agentId: 'host-run-1',
          name: 'Nightly digest',
        },
        {
          getWorkspace: () => ({
            id: HOST_WS,
            layoutModel: hostModel.toJson(),
            agents: { 'host-run-1': { name: 'Nightly digest' } },
          }),
          setActiveWorkspace: (workspaceId) => active.push(workspaceId),
          updateLayout: (_workspaceId, layoutModel) => {
            updatedLayout = layoutModel
          },
        },
      ),
      true,
    )
    // The host was activated, the live model was used (no persisted-layout fallback),
    // and the agent tab was renamed to the run's display name.
    assert.deepEqual(active, [HOST_WS])
    assert.equal(updatedLayout, null)
    assert.deepEqual(tabNames(hostModel), ['Nightly digest'])
    // The green spawn-flash is re-applied so the revealed run is called out.
    const revealedTab = allTabs(hostModel).find((tab) => tab.config?.agentId === 'host-run-1')
    assert.equal(revealedTab?.className, 'agent-tab-spawn-flash', 'the reveal flashes the host agent tab green')
    unregisterModel(HOST_WS)
  }

  // If activation has not mounted the live model yet, reveal mutates the
  // persisted layout so the concrete agent tab appears and is selected on mount.
  {
    const base = freshModel()
    const active: string[] = []
    let updatedLayout: IJsonModel | null = null
    unregisterModel(WS)
    assert.equal(
      revealAgentTab(
        {
          workspaceId: WS,
          agentId: 'a-2',
        },
        {
          getWorkspace: () => ({
            id: WS,
            layoutModel: base.toJson(),
            agents: { 'a-2': { name: 'Spawned agent' } },
          }),
          setActiveWorkspace: (workspaceId) => active.push(workspaceId),
          updateLayout: (_workspaceId, layoutModel) => {
            updatedLayout = layoutModel
          },
        },
      ),
      true,
    )
    assert.deepEqual(active, [WS])
    assert.ok(updatedLayout)
    const updatedModel = Model.fromJson(updatedLayout)
    assert.deepEqual(
      allTabs(updatedModel)
        .filter((tab) => tab.component === 'agent')
        .map((tab) => tab.config?.agentId),
      ['a-1', 'a-2'],
    )
    assert.deepEqual(tabNames(updatedModel), ['Agent', 'Spawned agent'])
  }

  // The Editor is not a strip-less nav switch: its tabset keeps a tab strip so
  // open files stay switchable.
  {
    const model = freshModel()
    registerModel(WS, model)
    togglePanelRailComponent(WS, 'editor', 'Editor')
    const editorTabset = tabsets(model).find((tabset) => componentsOf(tabset).includes('editor'))
    assert.ok(editorTabset)
    assert.equal(editorTabset.enableTabStrip, undefined)
    assert.deepEqual(tabsets(model).map(componentsOf), [['editor'], ['agent']])
    unregisterModel(WS)
  }

  // Opening a real file while a terminal/agent tabset is active creates a
  // document tabset to its left instead of stacking the editor into the terminal
  // strip.
  {
    const model = freshModel()
    registerModel(WS, model)
    assert.equal(focusOrAddFileTab(WS, '/tmp/app.ts', 'app.ts'), true)
    const orderedTabsets = tabsets(model)
    assert.deepEqual(orderedTabsets.map(componentsOf), [['file-editor'], ['agent']])
    const fileTab = allTabs(model).find((tab) => tab.component === 'file-editor')
    assert.ok(fileTab)
    assert.equal(fileTab.enableClose, true)
    unregisterModel(WS)
  }

  // An agent's reveal while the person is typing (`select: false`): the file
  // tab is added behind the one they are on, and an open one is not brought
  // forward.
  {
    const model = freshModel()
    registerModel(WS, model)
    assert.equal(focusOrAddFileTab(WS, '/tmp/app.ts', 'app.ts'), true)
    const editorSet = () => tabsets(model).find((set) => componentsOf(set).includes('file-editor'))
    const selectedBefore = editorSet()?.selected ?? 0
    assert.equal(focusOrAddFileTab(WS, '/tmp/other.ts', 'other.ts', { select: false }), true)
    const after = editorSet()
    assert.ok(after)
    assert.equal(componentsOf(after).length, 2)
    assert.equal(after.selected ?? 0, selectedBefore)
    unregisterModel(WS)
  }

  // With the nav rail open, file tabs land to its right and still to the left of
  // terminals/agents: Files/Git/Knowledge -> Editor -> terminals/agents.
  {
    const model = freshModel()
    registerModel(WS, model)
    togglePanelRailComponent(WS, 'memory-graph', 'Knowledge Graph')
    assert.equal(focusOrAddFileTab(WS, '/tmp/app.ts', 'app.ts'), true)
    assert.deepEqual(tabsets(model).map(componentsOf), [['memory-graph'], ['file-editor'], ['agent']])
    const nav = navTabsets(model)
    assert.equal(nav.length, 1)
    assert.equal(nav[0].enableTabStrip, false)
    unregisterModel(WS)
  }

  // With a file open, toggling the Editor switch focuses that surface instead of
  // stacking a second 'editor' welcome tab.
  {
    const json: IJsonModel = {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [{ type: 'tab', name: 'app.tsx', component: 'file-editor', config: { filePath: '/app.tsx' } }],
          },
        ],
      },
    }
    const model = Model.fromJson(json)
    registerModel(WS, model)
    togglePanelRailComponent(WS, 'editor', 'Editor')
    assert.equal(allComponents(model).filter((c) => c === 'editor').length, 0)
    assert.equal(allComponents(model).filter((c) => c === 'file-editor').length, 1)
    unregisterModel(WS)
  }

  // A layout may set global tabEnableClose=false to protect a sticky root tab
  // (the retired Guided Brief did). File editor tabs must still be explicitly
  // closeable so their close affordance and close-active-tab command work.
  {
    const json: IJsonModel = {
      global: { tabSetEnableDrop: true, tabEnableClose: false },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            enableTabStrip: false,
            children: [{ type: 'tab', name: 'Board', component: 'notebook', enableClose: false }],
          },
        ],
      },
    }
    const model = Model.fromJson(json)
    registerModel(WS, model)
    assert.equal(focusOrAddFileTab(WS, '/tmp/brief.md', 'brief.md'), true)
    const fileTab = allTabs(model).find((tab) => tab.component === 'file-editor')
    assert.ok(fileTab)
    assert.equal(fileTab.enableClose, true)
    unregisterModel(WS)
  }

  // A terminal spawned when the sidebar nav pane is the only open panel docks as
  // its own column to the RIGHT, never inside the strip-less nav pane.
  {
    const model = navOnlyModel()
    registerModel(WS, model)
    assert.equal(addTerminalTab(WS, 'term-1', 'Terminal'), true)
    assert.deepEqual(tabsets(model).map(componentsOf), [['memory-graph'], ['terminal']])
    // The nav pane stays a clean, strip-less sidebar — the terminal did not land in it.
    const nav = navTabsets(model)
    assert.equal(nav.length, 1)
    assert.deepEqual(componentsOf(nav[0]), ['memory-graph'])
    assert.equal(nav[0].enableTabStrip, false)
    unregisterModel(WS)
  }

  // An agent tiled when the sidebar nav pane is the only open panel docks as its
  // own column to the RIGHT, never inside the nav pane.
  {
    const model = navOnlyModel()
    registerModel(WS, model)
    assert.equal(addAgentTabTiled(WS, 'a-9', 'Spawned agent'), true)
    assert.deepEqual(tabsets(model).map(componentsOf), [['memory-graph'], ['agent']])
    const nav = navTabsets(model)
    assert.equal(nav.length, 1)
    assert.deepEqual(componentsOf(nav[0]), ['memory-graph'])
    unregisterModel(WS)
  }

  // With the sidebar nav pane open AND active over an existing content tabset, a
  // new terminal joins the content tabset rather than the active nav pane.
  {
    const model = freshModel()
    registerModel(WS, model)
    // Opening Git selects the nav pane, making it the active tabset.
    togglePanelRailComponent(WS, 'memory-graph', 'Knowledge Graph')
    assert.equal(addTerminalTab(WS, 'term-2', 'Terminal'), true)
    assert.deepEqual(tabsets(model).map(componentsOf), [['memory-graph'], ['agent', 'terminal']])
    // The git nav pane was not used as the spawn target.
    const nav = navTabsets(model)
    assert.equal(nav.length, 1)
    assert.deepEqual(componentsOf(nav[0]), ['memory-graph'])
    unregisterModel(WS)
  }

  // --- Nav rail width is preserved when a sibling terminal/agent is closed ---

  // solo-dev-shaped layout: strip-less nav rail (Git) + editor + agent, all
  // siblings in the root row. Tabs carry ids so the agent can be deleted by id.
  function navRailDevModel(): Model {
    const json: IJsonModel = {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 18,
            enableTabStrip: false,
            children: [{ type: 'tab', id: 'nav-memory-graph', name: 'Knowledge Graph', component: 'memory-graph' }],
          },
          { type: 'tabset', weight: 52, children: [{ type: 'tab', id: 'ed', name: 'Editor', component: 'editor' }] },
          {
            type: 'tabset',
            weight: 30,
            children: [{ type: 'tab', id: 'agent-x', name: 'Agent', component: 'agent', config: { agentId: 'x' } }],
          },
        ],
      },
    }
    return Model.fromJson(json)
  }

  // Headless models never run the view layout pass, so seed the rects the capture
  // reads: root row 1000px wide, nav rail 180px ⇒ an 18% share.
  function seedNavRailRects(model: Model): void {
    const navTab = model.getNodeById('nav-memory-graph')
    const navTabset = navTab?.getParent()
    const rootRow = navTabset?.getParent()
    assert.ok(navTabset && rootRow, 'expected nav tabset under the root row')
    // `setRect` is internal from flexlayout 0.11 on — still on every node, no
    // longer in the published types — and the view pass that calls it never
    // runs here.
    type Sized = { setRect(rect: Rect): void }
    ;(rootRow as unknown as Sized).setRect(new Rect(0, 0, 1000, 800))
    ;(navTabset as unknown as Sized).setRect(new Rect(0, 0, 180, 800))
  }

  // Reads the live weight of the tabset that holds a tab with the given component.
  // toJson omits an attribute left at its default, so an absent weight is
  // flexlayout's default of 100, not zero.
  function tabsetWeight(model: Model, component: string): number {
    type WeightedTabset = TabsetJson & { weight?: number }
    let weight = 0
    const walk = (node: WeightedTabset | undefined) => {
      if (!node) return
      if (node.type === 'tabset' && (node.children ?? []).some((c) => c.component === component)) {
        weight = node.weight ?? 100
      }
      node.children?.forEach((child) => walk(child as WeightedTabset))
    }
    walk((model.toJson() as unknown as { layout: WeightedTabset }).layout)
    return weight
  }

  // captureRailWidthFraction reports the rail's share of its parent row.
  {
    const model = navRailDevModel()
    seedNavRailRects(model)
    const fraction = captureRailWidthFraction(model, 'left')
    assert.ok(fraction != null && Math.abs(fraction - 0.18) < 0.001, `expected 0.18, got ${fraction}`)
    // A layout with no rail docked has no fraction to report. (The right rail —
    // the Skills aside — was retired with the workspace pane, so 'left' is the
    // only side there is.)
    assert.equal(captureRailWidthFraction(freshModel(), 'left'), null)
  }

  // Regression: closing the agent WITHOUT re-pinning lets flexlayout spread the
  // freed weight into the nav rail — it grows from 18% to ~26% of the row.
  {
    const model = navRailDevModel()
    model.doAction(Actions.deleteTab('agent-x'))
    const navW = tabsetWeight(model, 'memory-graph')
    const edW = tabsetWeight(model, 'editor')
    const fraction = navW / (navW + edW)
    assert.ok(Math.abs(fraction - 18 / 70) < 0.01, `expected the bug's ~0.257, got ${fraction}`)
  }

  // Fix: capture the rail before the close, delete the agent, then restore — the
  // rail holds its 18% and the freed space flows to the editor instead.
  {
    const model = navRailDevModel()
    seedNavRailRects(model)
    const fraction = captureRailWidthFraction(model, 'left')
    assert.ok(fraction != null)
    model.doAction(Actions.deleteTab('agent-x'))
    restoreRailWidthFraction(model, fraction!, 'left')
    const navW = tabsetWeight(model, 'memory-graph')
    const edW = tabsetWeight(model, 'editor')
    const preserved = navW / (navW + edW)
    assert.ok(Math.abs(preserved - 0.18) < 0.005, `expected the rail pinned at 0.18, got ${preserved}`)
    // The editor absorbed the closed agent's space (was 52%, now ~82%).
    assert.ok(edW / (navW + edW) > 0.8, 'editor should absorb the freed space')
  }

  // restoreRailWidthFraction is a no-op when there are no content siblings left
  // (rail alone fills the row) and ignores out-of-range fractions.
  {
    const model = navRailDevModel()
    model.doAction(Actions.deleteTab('agent-x'))
    model.doAction(Actions.deleteTab('ed'))
    const before = tabsetWeight(model, 'memory-graph')
    restoreRailWidthFraction(model, 0.18, 'left')
    assert.equal(tabsetWeight(model, 'memory-graph'), before, 'rail weight unchanged with no siblings')
  }

  // flashAgentTab re-applies the green spawn-flash classes to an agent tab that
  // already exists — the "Open agent" highlight — and reports it flashed live.
  {
    const model = freshModel()
    registerModel(WS, model)
    const agentTab = () => allTabs(model).find((tab) => tab.config?.agentId === 'a-1')
    assert.equal(agentTab()?.className ?? '', '', 'tab starts without the flash class')
    assert.equal(flashAgentTab(WS, 'a-1'), true)
    assert.equal(agentTab()?.className, 'agent-tab-spawn-flash')
    assert.equal(agentTab()?.contentClassName, 'agent-tab-spawn-flash-panel')
    unregisterModel(WS)
  }

  // A user-colored agent tab keeps its existing class; the flash class is added
  // alongside, not in place of it.
  {
    const json: IJsonModel = {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [
              {
                type: 'tab',
                name: 'Agent',
                component: 'agent',
                className: 'tab-color-violet',
                config: { agentId: 'a-1' },
              },
            ],
          },
        ],
      },
    }
    const model = Model.fromJson(json)
    registerModel(WS, model)
    assert.equal(flashAgentTab(WS, 'a-1'), true)
    const className = allTabs(model).find((tab) => tab.config?.agentId === 'a-1')?.className ?? ''
    assert.ok(className.includes('tab-color-violet'), 'keeps the existing color class')
    assert.ok(className.includes('agent-tab-spawn-flash'), 'adds the flash class')
    unregisterModel(WS)
  }

  // With no live model, flashAgentTab latches; consumePendingAgentFlash applies it
  // once the workspace's model registers on mount.
  {
    unregisterModel(WS)
    assert.equal(flashAgentTab(WS, 'a-1'), false, 'no live model: latches instead of flashing')
    const model = freshModel()
    registerModel(WS, model)
    consumePendingAgentFlash(WS)
    const className = allTabs(model).find((tab) => tab.config?.agentId === 'a-1')?.className ?? ''
    assert.equal(className, 'agent-tab-spawn-flash', 'pending flash applied on mount')
    // The latch is one-shot: a second mount must not re-flash.
    unregisterModel(WS)
    const remount = freshModel()
    registerModel(WS, remount)
    consumePendingAgentFlash(WS)
    assert.equal(
      allTabs(remount).find((tab) => tab.config?.agentId === 'a-1')?.className ?? '',
      '',
      'latch is drained after first consume',
    )
    unregisterModel(WS)
  }

  // --- focusedAgentTabInLayout ------------------------------------------------
  // An aside (the workspace pane) asks "which agent am I describing?" of the persisted layout,
  // because that JSON is rewritten on every layout mutation and the live Model has
  // no listener API.
  {
    const tab = (agentId: string, sessionId?: string) => ({
      type: 'tab',
      component: 'agent',
      name: agentId,
      config: sessionId ? { agentId, sessionId } : { agentId },
    })

    const twoTabsets: IJsonModel = {
      global: {},
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', selected: 0, children: [tab('a-left')] },
          { type: 'tabset', active: true, selected: 1, children: [tab('a-1'), tab('a-2', 's-2')] },
        ],
      },
    }
    assert.deepEqual(
      focusedAgentTabInLayout(twoTabsets),
      { agentId: 'a-2', sessionId: 's-2' },
      'the active tabset’s selected tab wins',
    )

    const asideActive: IJsonModel = {
      global: {},
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', selected: 0, children: [tab('a-left')] },
          { type: 'tabset', selected: 0, children: [tab('a-right', 's-right')] },
          {
            type: 'tabset',
            active: true,
            selected: 0,
            children: [{ type: 'tab', component: 'skills', name: 'Skills and MCPs' }],
          },
        ],
      },
    }
    assert.deepEqual(
      focusedAgentTabInLayout(asideActive, { agentId: 'a-right', sessionId: 's-right' }),
      { agentId: 'a-right', sessionId: 's-right' },
      'clicking the aside keeps the last focused agent instead of falling back to the first one',
    )

    const noActive: IJsonModel = {
      global: {},
      borders: [],
      layout: {
        type: 'row',
        children: [{ type: 'tabset', selected: 0, children: [tab('a-only')] }],
      },
    }
    assert.deepEqual(
      focusedAgentTabInLayout(noActive),
      { agentId: 'a-only', sessionId: null },
      'with no active tabset the first agent tab stands in; an unlaunched agent has no session',
    )

    const paneOnly: IJsonModel = {
      global: {},
      borders: [],
      layout: {
        type: 'row',
        children: [
          { type: 'tabset', selected: 0, children: [{ type: 'tab', component: 'skills', name: 'Skills and MCPs' }] },
        ],
      },
    }
    assert.equal(focusedAgentTabInLayout(paneOnly), null, 'a pane-only workspace focuses no agent')

    const selectedIsNotAnAgent: IJsonModel = {
      global: {},
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            active: true,
            selected: 1,
            children: [tab('a-1'), { type: 'tab', component: 'file-editor', name: 'index.ts' }],
          },
        ],
      },
    }
    assert.equal(
      focusedAgentTabInLayout(selectedIsNotAnAgent),
      null,
      'an editor on top of an agent tab means no agent is on screen',
    )

    assert.equal(focusedAgentTabInLayout(undefined), null)
  }

  // The new-agent tab. The "+" opens the tab the terminal will live in,
  // so the two things worth pinning are that it docks where an agent tab docks,
  // and that spawning RETYPES that node instead of replacing it: a remove-and-add
  // would move the pane out from under the person who was just looking at it.
  {
    const model = freshModel()
    registerModel(WS, model)

    const tabId = addNewAgentTab(WS, 'Atlas')
    assert.ok(tabId, 'the + opens a tab')
    assert.ok(
      allComponents(model).includes(NEW_AGENT_TAB_COMPONENT),
      'the tab holds the launch surface, not an agent panel',
    )
    assert.equal(tabsets(model).length, 1, 'the + adds a tab in the existing pane, not a split beside it')
    assert.deepEqual(
      componentsOf(tabsets(model)[0]!),
      ['agent', NEW_AGENT_TAB_COMPONENT],
      'the launch surface sits beside the agent that was already in that strip',
    )

    const placed = allTabs(model).find((tab) => tab.component === NEW_AGENT_TAB_COMPONENT)
    assert.equal(
      placed?.name,
      'Atlas',
      'and it wears the agent’s name from the moment it opens — a tab must not change identity at spawn',
    )
    assert.equal(
      (placed?.config as { agentName?: string } | undefined)?.agentName,
      'Atlas',
      'the name rides the tab config so the launch adopts it rather than drawing another',
    )

    // Retype in place: the node id survives, so the tab keeps its tabset and size.
    const before = model.getNodeById(tabId!)
    assert.ok(before, 'the node exists before the spawn')
    const converted = convertNewAgentTabToAgent(WS, tabId!, 'a-new', 'Atlas')
    assert.equal(converted, true, 'a live new-agent tab converts')

    const after = model.getNodeById(tabId!)
    assert.ok(after, 'the SAME node is still there — not a new tab somewhere else')
    const agentTab = allTabs(model).find((tab) => tab.config?.agentId === 'a-new')
    assert.equal(agentTab?.component, 'agent', 'it is an agent tab now')
    assert.equal(agentTab?.name, 'Atlas', 'wearing the agent’s name')
    assert.ok(
      !allComponents(model).includes(NEW_AGENT_TAB_COMPONENT),
      'and the launch surface is gone — one tab, not two',
    )
    assert.ok(
      (agentTab?.className ?? '').includes('agent-tab-spawn-flash'),
      'a terminal that just came alive flashes, as every other spawn does',
    )

    // Converting something that is not a new-agent tab is a no-op, so a stale tab
    // id from a closed composer can never hijack an agent’s tab.
    assert.equal(
      convertNewAgentTabToAgent(WS, tabId!, 'a-other', 'Wren'),
      false,
      'an already-converted tab does not convert twice',
    )

    unregisterModel(WS)
  }

  // Closing the composer without launching leaves nothing behind.
  {
    const model = freshModel()
    registerModel(WS, model)
    const tabId = addNewAgentTab(WS, 'Wren')
    assert.ok(tabId)
    assert.equal(removeNewAgentTab(WS, tabId!), true, 'the tab closes')
    assert.ok(
      !allComponents(model).includes(NEW_AGENT_TAB_COMPONENT),
      'no residue: closing before launch created nothing',
    )
    assert.equal(removeNewAgentTab(WS, tabId!), false, 'and closing it twice is a no-op')
    unregisterModel(WS)
  }

  // A nav-only workspace (the sidebar panel alone) must not bury the surface
  // inside the strip-less rail — same rule agent and terminal tabs already follow.
  {
    const model = navOnlyModel()
    registerModel(WS, model)
    addNewAgentTab(WS, 'Juno')
    const hosting = tabsets(model).find((tabset) => componentsOf(tabset).includes(NEW_AGENT_TAB_COMPONENT))
    assert.ok(hosting, 'the surface is somewhere')
    assert.notEqual(hosting?.enableTabStrip, false, 'and never inside the strip-less nav pane')
    unregisterModel(WS)
  }

  // Two terminal panes: the + on one strip adds a tab there, and does not split
  // a third pane beside or below the other. This is the click the sticky button
  // actually makes — it knows which tabset it sits on.
  {
    const json: IJsonModel = {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            id: 'pane-a',
            weight: 50,
            children: [{ type: 'tab', name: 'Term A', component: 'terminal', config: { terminalId: 't-1' } }],
          },
          {
            type: 'tabset',
            id: 'pane-b',
            weight: 50,
            children: [{ type: 'tab', name: 'Term B', component: 'terminal', config: { terminalId: 't-2' } }],
          },
        ],
      },
    }
    const model = Model.fromJson(json)
    registerModel(WS, model)
    const tabId = addNewAgentTab(WS, 'Nico', 'pane-b')
    assert.ok(tabId, 'the + on the second pane opens a tab')
    assert.equal(tabsets(model).length, 2, 'no third pane — the + does not tile')
    const paneA = tabsets(model).find((tabset) => tabset.id === 'pane-a')
    const paneB = tabsets(model).find((tabset) => tabset.id === 'pane-b')
    assert.deepEqual(componentsOf(paneA!), ['terminal'], 'the first pane is untouched')
    assert.deepEqual(
      componentsOf(paneB!),
      ['terminal', NEW_AGENT_TAB_COMPONENT],
      'the launch surface is a tab in the pane whose + was clicked',
    )
    unregisterModel(WS)
  }

  console.log('modelRegistry.test.ts: ok')
})
