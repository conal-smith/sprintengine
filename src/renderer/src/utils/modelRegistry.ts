import { Actions, DockLocation, Model, RowNode, TabNode, TabSetNode, type IJsonModel } from 'flexlayout-react'
import { basename, isPathOrChild, pathSeparatorFor } from './paths'

const AGENT_TAB_SPAWN_FLASH_CLASS = 'agent-tab-spawn-flash'
const AGENT_TAB_SPAWN_FLASH_PANEL_CLASS = 'agent-tab-spawn-flash-panel'
// Outlasts the 12800ms CSS animation so the classes are stripped only after the
// green border has fully faded (see assets/index.css).
const AGENT_TAB_SPAWN_FLASH_CLEAR_MS = 13200

export type AgentTerminalRevealPolicy = 'background' | 'focus-if-open' | 'reveal'
export type AgentTabRevealTarget = {
  workspaceId: string
  agentId: string
  name?: string
  // Tab config to write alongside the reveal (the live `sessionId` a caller
  // already resolved). Only the mounted-model path carries it; the fallback
  // through the persisted layout seeds a plain tab, which reattaches from the
  // AgentState instead.
  config?: Record<string, unknown>
}
export type AgentTabRevealWorkspace = {
  id: string
  layoutModel: IJsonModel
  agents: Record<string, { name?: string }>
}
export type AgentTabRevealPorts = {
  getWorkspace(workspaceId: string): AgentTabRevealWorkspace | null
  setActiveWorkspace(workspaceId: string): void
  updateLayout(workspaceId: string, layoutModel: IJsonModel): void
}

// Ephemeral registry of live flexlayout Model instances, keyed by workspace id.
// Lets components outside of WorkspaceLayout (e.g. the workspace action bar)
// dispatch actions to the active workspace's layout without prop-drilling.
const models = new Map<string, Model>()

// The main layout's root row. flexlayout keeps one row per layout (the main one
// plus any sublayouts); every workspace model has the main one, so its absence
// is a corrupt model rather than a state to handle.
function rootRowId(model: Model): string {
  const row = model.getRootRow()
  if (!row) throw new Error('The layout model has no root row.')
  return row.getId()
}

export function registerModel(workspaceId: string, model: Model): void {
  models.set(workspaceId, model)
}

export function unregisterModel(workspaceId: string): void {
  models.delete(workspaceId)
}

export function getModel(workspaceId: string): Model | undefined {
  return models.get(workspaceId)
}

export function focusAgentTab(workspaceId: string, agentId: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId) return
    if (!(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId) {
      targetTabId = node.getId()
    }
  })

  if (!targetTabId) return false
  model.doAction(Actions.selectTab(targetTabId))
  return true
}

function updateAgentTabConfig(model: Model, agentId: string, config: Record<string, unknown> | undefined): void {
  if (!config) return

  let targetTabId: string | null = null
  let nextConfig: Record<string, unknown> | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const existingConfig = (node.getConfig() as Record<string, unknown> | undefined) ?? {}
    if (existingConfig.agentId !== agentId) return

    targetTabId = node.getId()
    nextConfig = { ...existingConfig, ...config, agentId }
  })

  if (targetTabId && nextConfig) {
    model.doAction(Actions.updateNodeAttributes(targetTabId, { config: nextConfig }))
  }
}

function renameAgentTab(model: Model, agentId: string, name: string): void {
  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId && node.getName() !== name) {
      targetTabId = node.getId()
    }
  })

  if (targetTabId) model.doAction(Actions.renameTab(targetTabId, name))
}

function firstTabset(model: Model): TabSetNode | null {
  let targetTabset: TabSetNode | null = null
  model.visitNodes((node) => {
    if (!targetTabset && node instanceof TabSetNode) targetTabset = node
  })
  return targetTabset
}

// True when the tabset is one of the docked rails (see RAILS): a strip-less pane
// holding only that edge's switches. Content tabs (terminals, agents, editors)
// must never dock into either one.
function isRailTabset(tabset: TabSetNode): boolean {
  return railSideOfTabset(tabset) !== null
}

function firstNonRailTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found || !(node instanceof TabSetNode)) return
    if (!isRailTabset(node)) found = node
  })
  return found
}

// Resolves the tabset that should host a new content tab (terminal, agent,
// editor): the active tabset when it is real content, otherwise the first
// non-rail tabset. Never a strip-less rail pane — docking content there buries
// it under the open Backlog panel. Returns null when the only tabsets are
// rails, so callers dock a fresh column on the right edge.
function activeContentTabset(model: Model): TabSetNode | null {
  const active = model.getActiveTabset()
  if (active && !isRailTabset(active)) return active
  return firstNonRailTabset(model)
}

function agentTileLocation(targetTabset: TabSetNode): DockLocation {
  const rect = targetTabset.getRect()
  if (rect.width > 0 && rect.height > 0 && rect.height > rect.width) {
    return DockLocation.BOTTOM
  }
  return DockLocation.RIGHT
}

function agentTabNode(agentId: string, name: string, config?: Record<string, unknown>, options?: { flash?: boolean }) {
  const flash = options?.flash ?? true
  return {
    type: 'tab',
    name,
    component: 'agent',
    ...(flash
      ? {
          className: AGENT_TAB_SPAWN_FLASH_CLASS,
          contentClassName: AGENT_TAB_SPAWN_FLASH_PANEL_CLASS,
        }
      : {}),
    config: { agentId, ...config },
  }
}

// Resolves the live tab id hosting `agentId`, or null when the agent has no tab
// in this model. The shared lookup behind every per-agent tab mutation.
function findAgentTabId(model: Model, agentId: string): string | null {
  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId) targetTabId = node.getId()
  })
  return targetTabId
}

function withoutClass(className: string | undefined, target: string): string {
  return (className ?? '')
    .split(/\s+/u)
    .filter((entry) => entry && entry !== target)
    .join(' ')
}

function withClass(className: string | undefined, target: string): string {
  const kept = (className ?? '').split(/\s+/u).filter((entry) => entry && entry !== target)
  kept.push(target)
  return kept.join(' ')
}

function clearAgentSpawnFlash(model: Model, agentId: string): void {
  const targetTabId = findAgentTabId(model, agentId)
  if (!targetTabId) return
  const node = model.getNodeById(targetTabId)
  if (!(node instanceof TabNode)) return

  model.doAction(
    Actions.updateNodeAttributes(targetTabId, {
      className: withoutClass(node.getClassName(), AGENT_TAB_SPAWN_FLASH_CLASS) || undefined,
      contentClassName: withoutClass(node.getContentClassName(), AGENT_TAB_SPAWN_FLASH_PANEL_CLASS) || undefined,
    }),
  )
}

// Re-applies the spawn flash to an agent tab that already exists. The green
// border flash is born with a freshly-spawned tab (see addAgentTabTiled); this
// lets a navigation action — "Open agent" from a Backlog item — call out *which*
// terminal it revealed when several share a tab strip. Adds the same classes and
// schedules the same cleanup. A tab already mid-flash stays green (re-adding an
// unchanged class is a harmless no-op), so the highlight never double-fires.
function applyAgentSpawnFlash(model: Model, agentId: string): boolean {
  const targetTabId = findAgentTabId(model, agentId)
  if (!targetTabId) return false
  const node = model.getNodeById(targetTabId)
  if (!(node instanceof TabNode)) return false

  model.doAction(
    Actions.updateNodeAttributes(targetTabId, {
      className: withClass(node.getClassName(), AGENT_TAB_SPAWN_FLASH_CLASS),
      contentClassName: withClass(node.getContentClassName(), AGENT_TAB_SPAWN_FLASH_PANEL_CLASS),
    }),
  )
  window.setTimeout(() => clearAgentSpawnFlash(model, agentId), AGENT_TAB_SPAWN_FLASH_CLEAR_MS)
  return true
}

// "Flash this agent's tab when its workspace next mounts." A cold workspace's
// layout Model registers a tick after setActiveWorkspace, so a cross-workspace
// "Open agent" can't flash synchronously. Mirrors backlogReveal's latch: nothing
// populates this on app restart, so a restored workspace never self-flashes.
const pendingAgentFlashes = new Map<string, string>()

// Flash the agent's tab now if its workspace Model is mounted; otherwise latch
// it for consumePendingAgentFlash to apply on mount. Returns whether it flashed
// synchronously.
export function flashAgentTab(workspaceId: string, agentId: string): boolean {
  const model = models.get(workspaceId)
  if (model && applyAgentSpawnFlash(model, agentId)) return true
  pendingAgentFlashes.set(workspaceId, agentId)
  return false
}

// Drain and apply a pending flash for a workspace whose Model just registered.
// Called once on WorkspaceLayout mount.
export function consumePendingAgentFlash(workspaceId: string): void {
  const agentId = pendingAgentFlashes.get(workspaceId)
  if (agentId === undefined) return
  pendingAgentFlashes.delete(workspaceId)
  const model = models.get(workspaceId)
  if (model) applyAgentSpawnFlash(model, agentId)
}

export function addAgentTabTiled(
  workspaceId: string,
  agentId: string,
  name: string,
  config?: Record<string, unknown>,
  // The fifth arg to Actions.addNode is `select`: true foregrounds the new tab,
  // false docks it in place without stealing focus. An automatic launch passes
  // false so a background agent never yanks you off what you were reading.
  select = true,
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  // Tile beside real content, never inside the sidebar's nav pane. With only the
  // nav pane present, dock a fresh agent column on the RIGHT edge of the root so
  // the agent opens to the right of the open Files/Git/Backlog panel.
  const targetTabset = activeContentTabset(model)
  if (!targetTabset) {
    model.doAction(
      Actions.addNode(agentTabNode(agentId, name, config), rootRowId(model), DockLocation.RIGHT, -1, select),
    )
    window.setTimeout(() => clearAgentSpawnFlash(model, agentId), AGENT_TAB_SPAWN_FLASH_CLEAR_MS)
    return true
  }

  model.doAction(
    Actions.addNode(
      agentTabNode(agentId, name, config),
      targetTabset.getId(),
      agentTileLocation(targetTabset),
      -1,
      select,
    ),
  )
  window.setTimeout(() => clearAgentSpawnFlash(model, agentId), AGENT_TAB_SPAWN_FLASH_CLEAR_MS)
  return true
}

/**
 * Open an agent's tab right after another agent's, in that agent's strip, and
 * bring it to the front: a chat forked from another sits next to the one it
 * came from rather than wherever the active strip happens to be. Returns false
 * when that agent has no tab in a strip here; the caller docks the new tab the
 * ordinary way.
 */
export function addAgentTabAfter(
  workspaceId: string,
  agentId: string,
  name: string,
  afterAgentId: string,
  config?: Record<string, unknown>,
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  const afterTabId = findAgentTabId(model, afterAgentId)
  const after = afterTabId ? model.getNodeById(afterTabId) : undefined
  const tabset = after?.getParent()
  if (!(after instanceof TabNode) || !(tabset instanceof TabSetNode)) return false
  const index = tabset.getChildren().indexOf(after)
  model.doAction(
    Actions.addNode(agentTabNode(agentId, name, config), tabset.getId(), DockLocation.CENTER, index + 1, true),
  )
  window.setTimeout(() => clearAgentSpawnFlash(model, agentId), AGENT_TAB_SPAWN_FLASH_CLEAR_MS)
  return true
}

export function focusOrAddAgentTab(
  workspaceId: string,
  agentId: string,
  name: string,
  config?: Record<string, unknown>,
): boolean {
  return applyAgentTerminalRevealPolicy(workspaceId, agentId, name, 'reveal', config)
}

export function revealAgentTab(target: AgentTabRevealTarget, ports: AgentTabRevealPorts): boolean {
  const workspace = ports.getWorkspace(target.workspaceId)
  const agent = workspace?.agents[target.agentId]
  if (!workspace || !agent) return false

  const name = target.name?.trim() || agent.name || target.agentId
  ports.setActiveWorkspace(workspace.id)
  // Flash the revealed tab green so "Open agent" calls out which terminal it
  // surfaced, matching the Backlog "Open agent" action (agent-runtime-module).
  if (focusOrAddAgentTab(workspace.id, target.agentId, name, target.config)) {
    flashAgentTab(workspace.id, target.agentId)
    return true
  }

  try {
    ports.updateLayout(workspace.id, ensureAgentTabInLayoutModel(workspace.layoutModel, target.agentId, name))
    flashAgentTab(workspace.id, target.agentId)
    return true
  } catch {
    return false
  }
}

export function applyAgentTerminalRevealPolicy(
  workspaceId: string,
  agentId: string,
  name: string,
  revealPolicy: AgentTerminalRevealPolicy,
  config?: Record<string, unknown>,
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  if (revealPolicy === 'reveal' && focusAgentTab(workspaceId, agentId)) {
    renameAgentTab(model, agentId, name)
    updateAgentTabConfig(model, agentId, config)
    return true
  }

  let existingTabId: string | null = null
  model.visitNodes((node) => {
    if (existingTabId || !(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const existingConfig = (node.getConfig() as Record<string, unknown> | undefined) ?? {}
    if (existingConfig.agentId === agentId) existingTabId = node.getId()
  })

  if (existingTabId) {
    if (revealPolicy === 'focus-if-open') model.doAction(Actions.selectTab(existingTabId))
    renameAgentTab(model, agentId, name)
    updateAgentTabConfig(model, agentId, config)
    return true
  }

  if (revealPolicy !== 'reveal') return false

  return addAgentTabTiled(workspaceId, agentId, name, config)
}

function collectAgentTabIds(model: Model, agentId: string): string[] {
  const tabIds: string[] = []
  model.visitNodes((node) => {
    if (!(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId) tabIds.push(node.getId())
  })
  return tabIds
}

export function removeAgentTab(workspaceId: string, agentId: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  const tabIds = collectAgentTabIds(model, agentId)
  tabIds.forEach((tabId) => model.doAction(Actions.deleteTab(tabId)))
  return tabIds.length > 0
}

export function ensureAgentTabInLayoutModel(layoutModel: IJsonModel, agentId: string, name: string): IJsonModel {
  const model = Model.fromJson(layoutModel)

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'agent') return

    const config = node.getConfig() as { agentId?: string } | undefined
    if (config?.agentId === agentId) {
      targetTabId = node.getId()
    }
  })

  if (targetTabId) {
    const node = model.getNodeById(targetTabId)
    if (node instanceof TabNode && node.getName() !== name) {
      model.doAction(Actions.renameTab(targetTabId, name))
    }
    model.doAction(Actions.selectTab(targetTabId))
    return model.toJson()
  }

  // Tile beside real content, never inside the sidebar's nav pane; fall back to
  // a fresh column on the RIGHT edge of the root when the nav pane is alone.
  const targetTabset = activeContentTabset(model)
  if (targetTabset) {
    model.doAction(
      Actions.addNode(
        agentTabNode(agentId, name, undefined, { flash: false }),
        targetTabset.getId(),
        agentTileLocation(targetTabset),
        -1,
        true,
      ),
    )
  } else {
    model.doAction(
      Actions.addNode(
        agentTabNode(agentId, name, undefined, { flash: false }),
        rootRowId(model),
        DockLocation.RIGHT,
        -1,
        true,
      ),
    )
  }

  return model.toJson()
}

function firstTerminalTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (!(node instanceof TabNode) || node.getComponent() !== 'terminal') return
    const parent = node.getParent()
    if (parent instanceof TabSetNode) found = parent
  })
  return found
}

// Returns the first tabset hosting an agent or terminal tab.
function firstTerminalLikeTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (!(node instanceof TabNode)) return
    const component = node.getComponent()
    if (component !== 'agent' && component !== 'terminal') return
    const parent = node.getParent()
    if (parent instanceof TabSetNode) found = parent
  })
  return found
}

function firstEditorSurfaceTabset(model: Model): TabSetNode | null {
  const activeTabset = model.getActiveTabset()
  if (activeTabset) {
    const hasEditorSurface = activeTabset
      .getChildren()
      .some(
        (child) =>
          child instanceof TabNode && (child.getComponent() === 'file-editor' || child.getComponent() === 'editor'),
      )
    if (hasEditorSurface) return activeTabset
  }

  let targetTabset: TabSetNode | null = null
  model.visitNodes((node) => {
    if (targetTabset || !(node instanceof TabSetNode)) return
    const hasEditorSurface = node
      .getChildren()
      .some(
        (child) =>
          child instanceof TabNode && (child.getComponent() === 'file-editor' || child.getComponent() === 'editor'),
      )
    if (hasEditorSurface) targetTabset = node
  })
  return targetTabset
}

function addEditorSurfaceNode(model: Model, tabJson: Record<string, unknown>, select = true): boolean {
  const editorTabset = firstEditorSurfaceTabset(model)
  if (editorTabset) {
    model.doAction(Actions.addNode(tabJson, editorTabset.getId(), DockLocation.CENTER, -1, select))
    return true
  }

  const navTabset = findRailTabset(model, 'left')
  if (navTabset) {
    model.doAction(Actions.addNode(tabJson, navTabset.getId(), DockLocation.RIGHT, -1, select))
    return true
  }

  const terminalHost = firstTerminalLikeTabset(model)
  if (terminalHost) {
    model.doAction(Actions.addNode(tabJson, terminalHost.getId(), DockLocation.LEFT, -1, select))
    return true
  }

  const target = model.getActiveTabset() ?? firstTabset(model)
  if (!target) return false
  model.doAction(Actions.addNode(tabJson, target.getId(), DockLocation.CENTER, -1, select))
  return true
}

function terminalTabJson(terminalId: string, name: string) {
  return { type: 'tab', name, component: 'terminal', config: { terminalId } }
}

/** A remote machine's terminal. Its config carries the machine, not just the session. */
// ──────────────────────────────────────────────────────────────────────────
// The new-agent tab. The tab-strip "+" opens the tab an agent will
// run in, holding the launch surface until something spawns; the spawn then
// RETYPES that same node rather than closing it and opening an agent tab. Same
// node means same tabset, same position, same size — the pane the person is
// looking at becomes the terminal instead of one appearing somewhere else.
// ──────────────────────────────────────────────────────────────────────────

export const NEW_AGENT_TAB_COMPONENT = 'new-agent'

/**
 * Open a new-agent tab as a sibling in the strip whose "+" was clicked
 * (`hostTabsetId`). CENTER, not tiled: the "+" sits on a panel and means a
 * new tab in that panel, not a split beside or below it. Without a host (empty
 * workspace floor, or a caller that does not know the strip), the active
 * content tabset is used; a fresh right-hand column is only created when the
 * only tabsets are rails.
 *
 * The tab is named for the agent that will run in it, decided here rather than
 * at spawn: a tab called "New agent" that becomes "Atlas" changes identity
 * under the person reading it, and every other terminal in the strip has had a
 * name from the moment it opened. The name rides the tab's own config so the
 * launch adopts it instead of drawing a second one.
 *
 * Returns the new tab's id, which the caller holds to retype it on spawn.
 */
export function addNewAgentTab(workspaceId: string, agentName: string, hostTabsetId?: string): string | null {
  const model = models.get(workspaceId)
  if (!model) return null

  const tabId = `new-agent-${Math.random().toString(36).slice(2, 10)}`
  const tabJson = {
    type: 'tab',
    id: tabId,
    name: agentName,
    component: NEW_AGENT_TAB_COMPONENT,
    config: { agentName },
  }

  const targetTabset = resolveNewAgentHostTabset(model, hostTabsetId)
  model.doAction(
    targetTabset
      ? Actions.addNode(tabJson, targetTabset.getId(), DockLocation.CENTER, -1, true)
      : Actions.addNode(tabJson, rootRowId(model), DockLocation.RIGHT, -1, true),
  )
  return tabId
}

// The strip the "+" sits on, when that id still names a content tabset; otherwise
// the active content tabset. Never a rail — docking there buries the surface
// under the open Files/Git/Backlog panel.
function resolveNewAgentHostTabset(model: Model, hostTabsetId?: string): TabSetNode | null {
  if (hostTabsetId) {
    const node = model.getNodeById(hostTabsetId)
    if (node instanceof TabSetNode && !isRailTabset(node)) return node
  }
  return activeContentTabset(model)
}

/**
 * Turn a new-agent tab into the agent's terminal in place: same node, retyped
 * to the `agent` component, renamed, and given the agent id its panel reads.
 * The spawn flash fires here for the same reason it fires on every other spawn
 * — a terminal that just came alive says so.
 *
 * Returns false when the tab is gone (closed while the composer was open) or is
 * not a new-agent tab, which the caller treats as "dock one the ordinary way"
 * rather than as an error.
 */
export function convertNewAgentTabToAgent(
  workspaceId: string,
  tabId: string,
  agentId: string,
  name: string,
  config?: Record<string, unknown>,
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  const node = model.getNodeById(tabId)
  if (!(node instanceof TabNode) || node.getComponent() !== NEW_AGENT_TAB_COMPONENT) return false

  model.doAction(
    Actions.updateNodeAttributes(tabId, {
      name,
      component: 'agent',
      config: { agentId, ...config },
      className: withClass(node.getClassName(), AGENT_TAB_SPAWN_FLASH_CLASS),
      contentClassName: withClass(node.getContentClassName(), AGENT_TAB_SPAWN_FLASH_PANEL_CLASS),
    }),
  )
  model.doAction(Actions.selectTab(tabId))
  window.setTimeout(() => clearAgentSpawnFlash(model, agentId), AGENT_TAB_SPAWN_FLASH_CLEAR_MS)
  return true
}

/**
 * The same conversion for the composer's Terminal row, which opens a shell rather
 * than an agent. Same node, same reason: the pane the person is looking at
 * becomes the thing they asked for.
 */
export function convertNewAgentTabToTerminal(
  workspaceId: string,
  tabId: string,
  terminalId: string,
  name = 'Terminal',
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  const node = model.getNodeById(tabId)
  if (!(node instanceof TabNode) || node.getComponent() !== NEW_AGENT_TAB_COMPONENT) return false

  model.doAction(Actions.updateNodeAttributes(tabId, { name, component: 'terminal', config: { terminalId } }))
  model.doAction(Actions.selectTab(tabId))
  return true
}

/** Close a new-agent tab that was never launched from. Nothing else to undo. */
export function removeNewAgentTab(workspaceId: string, tabId: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  const node = model.getNodeById(tabId)
  if (!(node instanceof TabNode) || node.getComponent() !== NEW_AGENT_TAB_COMPONENT) return false
  deleteTabPreservingRails(model, tabId)
  return true
}

// Places a new terminal tab in the layout. Stacks into an existing terminal
// tabset when one exists so multiple terminals share a tab strip; otherwise the
// active tabset is used.
export function addTerminalTab(workspaceId: string, terminalId: string, name = 'Terminal'): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  const tabJson = terminalTabJson(terminalId, name)

  const existingTerminalTabset = firstTerminalTabset(model)
  if (existingTerminalTabset) {
    model.doAction(Actions.addNode(tabJson, existingTerminalTabset.getId(), DockLocation.CENTER, -1, true))
    return true
  }

  // No terminal tabset yet: dock beside real content, never inside the sidebar's
  // nav pane (Knowledge Graph), which would bury the terminal under
  // the open panel. When the nav pane is the only tabset, dock a fresh column on
  // the RIGHT edge of the root so terminals always open to the right of it.
  const targetTabset = activeContentTabset(model)
  if (targetTabset) {
    model.doAction(Actions.addNode(tabJson, targetTabset.getId(), DockLocation.CENTER, -1, true))
    return true
  }

  model.doAction(Actions.addNode(tabJson, rootRowId(model), DockLocation.RIGHT, -1, true))
  return true
}

export function focusOrAddTerminalTab(workspaceId: string, terminalId: string, name = 'Terminal'): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'terminal') return

    const config = node.getConfig() as { terminalId?: string } | undefined
    if ((config?.terminalId ?? node.getId()) === terminalId) {
      targetTabId = node.getId()
    }
  })

  if (targetTabId) {
    model.doAction(Actions.selectTab(targetTabId))
    return true
  }

  return addTerminalTab(workspaceId, terminalId, name)
}

function fileTabId(filePath: string): string {
  return `file-editor:${encodeURIComponent(filePath)}`
}

function getFileTabPath(node: TabNode): string | null {
  if (node.getComponent() !== 'file-editor') return null
  const config = node.getConfig() as { filePath?: string } | undefined
  return typeof config?.filePath === 'string' ? config.filePath : null
}

function remapPath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath
  const separator = pathSeparatorFor(fromPath)
  const prefix = `${fromPath}${separator}`
  return path.startsWith(prefix) ? `${toPath}${path.slice(fromPath.length)}` : path
}

export function focusFileTab(workspaceId: string, filePath: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode)) return
    if (getFileTabPath(node) === filePath) targetTabId = node.getId()
  })

  if (!targetTabId) return false
  model.doAction(Actions.selectTab(targetTabId))
  return true
}

export function remapFileTabsForPath(workspaceId: string, fromPath: string, toPath: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  const updates: Array<{ tabId: string; name: string; config: Record<string, unknown> }> = []
  model.visitNodes((node) => {
    if (!(node instanceof TabNode)) return
    const filePath = getFileTabPath(node)
    if (!filePath || !isPathOrChild(filePath, fromPath)) return

    const nextPath = remapPath(filePath, fromPath, toPath)
    updates.push({
      tabId: node.getId(),
      name: basename(nextPath),
      config: {
        ...(node.getConfig() as Record<string, unknown> | undefined),
        filePath: nextPath,
      },
    })
  })

  updates.forEach((update) => {
    model.doAction(Actions.updateNodeAttributes(update.tabId, { config: update.config }))
    model.doAction(Actions.renameTab(update.tabId, update.name))
  })

  return updates.length > 0
}

export function removeFileTabsForPath(workspaceId: string, path: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  const tabIds: string[] = []
  model.visitNodes((node) => {
    if (!(node instanceof TabNode)) return
    const filePath = getFileTabPath(node)
    if (filePath && isPathOrChild(filePath, path)) tabIds.push(node.getId())
  })

  tabIds.forEach((tabId) => model.doAction(Actions.deleteTab(tabId)))
  return tabIds.length > 0
}

export function focusOrAddFileTab(
  workspaceId: string,
  filePath: string,
  name: string,
  // `select: false` adds (or leaves) the tab behind the current one: an agent's
  // reveal while the person is typing must not swap the file under the cursor.
  options: { select?: boolean } = {},
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  const select = options.select !== false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode)) return
    if (getFileTabPath(node) === filePath) targetTabId = node.getId()
  })

  if (targetTabId) {
    const node = model.getNodeById(targetTabId)
    if (node instanceof TabNode && node.getName() !== name) {
      model.doAction(Actions.renameTab(targetTabId, name))
    }
    if (select) model.doAction(Actions.selectTab(targetTabId))
    return true
  }

  return addEditorSurfaceNode(
    model,
    {
      type: 'tab',
      id: fileTabId(filePath),
      name,
      component: 'file-editor',
      enableClose: true,
      config: { filePath },
    },
    select,
  )
}

function gitConflictTabId(repoRoot: string, filePath: string): string {
  return `git-conflict:${encodeURIComponent(repoRoot)}:${encodeURIComponent(filePath)}`
}

export function focusOrAddGitConflictTab(
  workspaceId: string,
  repoRoot: string,
  filePath: string,
  name: string,
): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId || !(node instanceof TabNode) || node.getComponent() !== 'git-conflict') return

    const config = node.getConfig() as { repoRoot?: string; filePath?: string } | undefined
    if (config?.repoRoot === repoRoot && config.filePath === filePath) {
      targetTabId = node.getId()
    }
  })

  if (targetTabId) {
    model.doAction(Actions.selectTab(targetTabId))
    return true
  }

  let targetTabset: TabSetNode | null = model.getActiveTabset() ?? null
  if (!targetTabset) {
    model.visitNodes((node) => {
      if (!targetTabset && node instanceof TabSetNode) targetTabset = node
    })
  }
  if (!targetTabset) return false

  model.doAction(
    Actions.addNode(
      {
        type: 'tab',
        id: gitConflictTabId(repoRoot, filePath),
        name,
        component: 'git-conflict',
        config: { repoRoot, filePath },
      },
      targetTabset.getId(),
      DockLocation.CENTER,
      -1,
      true,
    ),
  )
  return true
}

export function focusComponentTab(workspaceId: string, component: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  let targetTabId: string | null = null
  model.visitNodes((node) => {
    if (targetTabId) return
    if (node instanceof TabNode && node.getComponent() === component) {
      targetTabId = node.getId()
    }
  })

  if (!targetTabId) return false
  model.doAction(Actions.selectTab(targetTabId))
  return true
}

export function hasComponentTab(workspaceId: string, component: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  let found = false
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabNode && node.getComponent() === component) {
      found = true
    }
  })
  return found
}

type JsonLayoutNode = {
  type?: string
  component?: string
  children?: JsonLayoutNode[]
  // Tabset-only: `selected` is the index of the visible tab, `active` marks the
  // one tabset the user is driving (flexlayout allows exactly one).
  selected?: number
  active?: boolean
  config?: { agentId?: string; sessionId?: string; terminalId?: string }
}

/** The agent whose terminal is on screen, and the live session behind it. */
export type FocusedAgentTab = {
  agentId: string
  /** The tab's own session id; null when the agent has not launched one yet. */
  sessionId: string | null
}

/**
 * Which agent a workspace-scoped surface is talking about.
 *
 * Derived from the persisted `workspace.layoutModel` rather than the live Model
 * so it is reactive: `onModelChange` writes the JSON on every layout mutation,
 * selecting a tab included, and the live Model exposes no listener API. A pane
 * that read the Model directly would answer once and then go stale the moment
 * the user switched tabs.
 *
 * The active agent tabset wins. When an auxiliary pane is active, a still-
 * visible previous agent wins; this is what lets an aside keep acting on the
 * content beside it after the user clicks inside the aside. With neither, the
 * first visible agent tab in document order stands in.
 */
export function focusedAgentTabInLayout(
  model: IJsonModel | undefined | null,
  previous: FocusedAgentTab | null = null,
): FocusedAgentTab | null {
  if (!model) return null

  const selectedAgentOf = (tabset: JsonLayoutNode): FocusedAgentTab | null => {
    const children = tabset.children ?? []
    const tab = children[tabset.selected ?? 0]
    if (!tab || tab.type !== 'tab' || tab.component !== 'agent') return null
    const agentId = tab.config?.agentId
    if (!agentId) return null
    return { agentId, sessionId: tab.config?.sessionId ?? null }
  }

  const visible: FocusedAgentTab[] = []
  let active: FocusedAgentTab | null = null

  const visit = (node: JsonLayoutNode | undefined): void => {
    if (!node || active) return
    if (node.type === 'tabset') {
      const focused = selectedAgentOf(node)
      if (focused) {
        visible.push(focused)
        if (node.active) active = focused
      }
      return
    }
    for (const child of node.children ?? []) visit(child)
  }

  visit((model as unknown as { layout?: JsonLayoutNode }).layout)
  if (active) return active
  if (previous) {
    const remembered = visible.find((candidate) => candidate.agentId === previous.agentId)
    if (remembered) return remembered
  }
  return visible[0] ?? null
}

/** A terminal-bearing tab that is actually on screen: an agent pane or a plain terminal. */
export type VisibleTerminalTab = { kind: 'agent'; agentId: string } | { kind: 'terminal'; terminalId: string }

/**
 * The terminal a workspace is showing right now, or null when none is visible.
 *
 * Only ever reports a tab the user can SEE: a tabset's `selected` index, never a
 * buried sibling. That distinction is the whole point — every mounted xterm calls
 * `term.focus()` when it opens, including the ones stacked behind the visible tab,
 * and focusing a hidden textarea is a no-op that drops focus to `<body>`. So the
 * last terminal to mount wins the race and usually loses the focus. A caller that
 * wants focus to land has to name the visible one.
 *
 * Prefers the tabset flexlayout marks `active` (the one the user is driving), then
 * falls back to the first visible terminal in document order — which is what makes
 * a freshly-opened workspace, where no tabset is active yet, still answer.
 */
export function visibleTerminalTabInLayout(model: IJsonModel | undefined | null): VisibleTerminalTab | null {
  if (!model) return null

  const selectedTerminalOf = (tabset: JsonLayoutNode): VisibleTerminalTab | null => {
    const children = tabset.children ?? []
    const tab = children[tabset.selected ?? 0]
    if (!tab || tab.type !== 'tab') return null
    if (tab.component === 'agent' && tab.config?.agentId) {
      return { kind: 'agent', agentId: tab.config.agentId }
    }
    if (tab.component === 'terminal' && tab.config?.terminalId) {
      return { kind: 'terminal', terminalId: tab.config.terminalId }
    }
    return null
  }

  let active: VisibleTerminalTab | null = null
  let first: VisibleTerminalTab | null = null

  const visit = (node: JsonLayoutNode | undefined): void => {
    if (!node || active) return
    if (node.type === 'tabset') {
      const visible = selectedTerminalOf(node)
      if (!visible) return
      if (node.active) active = visible
      else if (!first) first = visible
      return
    }
    for (const child of node.children ?? []) visit(child)
  }

  visit((model as unknown as { layout?: JsonLayoutNode }).layout)
  return active ?? first
}

export function removeComponentTab(workspaceId: string, component: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  const tabIds: string[] = []
  model.visitNodes((node) => {
    if (node instanceof TabNode && node.getComponent() === component) {
      tabIds.push(node.getId())
    }
  })
  if (tabIds.length === 0) return false
  tabIds.forEach((tabId) => model.doAction(Actions.deleteTab(tabId)))
  return true
}

export function toggleComponentTab(workspaceId: string, component: string, name: string): boolean {
  if (hasComponentTab(workspaceId, component)) {
    return removeComponentTab(workspaceId, component)
  }
  return focusOrAddComponentTab(workspaceId, component, name)
}

// One edge today. The right rail (the Skills aside) was retired by the
// browser-pane epic: Files, Git and the browser live in the workspace pane
// column outside this layout model (store `workspace.paneState`). The
// side-keyed machinery below stays generic so a second edge can come back
// without a second copy of the width capture/restore pair.
export type RailSide = 'left'

// Strip-less navigational rail components: a single-instance navigational
// surface docked in ONE left pane whose FlexLayout tab strip is hidden.
// Knowledge Graph is the one left; it is reached through the command palette /
// View menu. Files, Git and Backlog are NOT here any more — they are
// workspace-pane tabs (browser-pane epic; store v73 strips the Files/Git rail
// tabs, v74 the Backlog one) and the header's Backlog switch toggles the pane
// tab. The Editor is deliberately excluded: it owns a
// document tab strip so multiple open files stay switchable (see
// toggleEditorRailComponent). The side-keyed machinery below stays generic so
// a second nav component can come back without a rewrite.
export const NAV_RAIL_COMPONENTS = new Set<string>(['memory-graph'])

const RAILS: Record<
  RailSide,
  {
    components: Set<string>
    dock: DockLocation
    // Width in px the rail takes the first time it docks, and the floor the
    // splitter will not cross. The left rail deliberately has neither: it has
    // shipped on flexlayout's default sizing, and pinning it here would silently
    // resize the Backlog pane in every existing workspace.
    defaultWidthPx?: number
    minWidthPx?: number
  }
> = {
  left: { components: NAV_RAIL_COMPONENTS, dock: DockLocation.LEFT },
}

const RAIL_SIDES = Object.keys(RAILS) as RailSide[]

// The rail a component docks into, or null when it is ordinary content.
function railSideOfComponent(component: string): RailSide | null {
  return RAIL_SIDES.find((side) => RAILS[side].components.has(component)) ?? null
}

// The rail a tabset IS, from its tab components — null when they are mixed, or
// content. Every tab must belong to the same side, so a legacy layout that
// stacked a nav tab beside the editor never gets its strip hidden (which would
// hide the editor's file tabs); those legacy tabs are pulled into a clean pane
// on the next toggle instead. Exported for the persisted-layout migration in
// layoutSlice, which answers the same question against raw JSON.
export function railSideOfComponents(components: readonly string[]): RailSide | null {
  if (components.length === 0) return null
  const side = railSideOfComponent(components[0])
  if (!side) return null
  return components.every((component) => RAILS[side].components.has(component)) ? side : null
}

function railSideOfTabset(tabset: TabSetNode): RailSide | null {
  const tabs = tabset.getChildren().filter((child): child is TabNode => child instanceof TabNode)
  return railSideOfComponents(tabs.map((tab) => tab.getComponent() ?? ''))
}

// PanelSwitches click handler (also the command-palette/menu toggle route). Rail
// switches route to their edge's exclusive strip-less pane; the Editor keeps
// standard document-tab semantics so its open files stay switchable.
export function togglePanelRailComponent(workspaceId: string, component: string, name: string): boolean {
  const side = railSideOfComponent(component)
  if (side) return toggleRailComponent(workspaceId, component, name, side)
  // Only the Editor has a non-rail toggle. A retired rail component (or any
  // other) is refused rather than docked centre-stage as a document tab.
  if (component !== 'editor') return false
  return toggleEditorRailComponent(workspaceId, component, name)
}

// The single docked pane on one edge. Matches only a tabset whose every tab
// belongs to that side's component set.
export function findRailTabset(model: Model, side: RailSide): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found || !(node instanceof TabSetNode)) return
    if (railSideOfTabset(node) === side) found = node
  })
  return found
}

// Records a rail's share of its parent row, as a width fraction, so it can
// survive a sibling tabset being removed. Returns null when that rail is not
// open, it isn't in a horizontal split (fraction would be ~1), or its rect
// hasn't been laid out yet. Read this BEFORE applying a tab/tabset deletion.
export function captureRailWidthFraction(model: Model, side: RailSide): number | null {
  const rail = findRailTabset(model, side)
  if (!rail) return null
  const parent = rail.getParent()
  if (!(parent instanceof RowNode)) return null
  const parentWidth = parent.getRect().width
  const railWidth = rail.getRect().width
  if (!(parentWidth > 0) || !(railWidth > 0)) return null
  const fraction = railWidth / parentWidth
  return fraction > 0 && fraction < 1 ? fraction : null
}

export type RailWidthFractions = Partial<Record<RailSide, number>>

// Both edges at once — what the delete paths capture, since a closed terminal's
// weight is handed to every sibling and either rail can be one of them.
export function captureRailWidthFractions(model: Model): RailWidthFractions | null {
  const fractions: RailWidthFractions = {}
  for (const side of RAIL_SIDES) {
    const fraction = captureRailWidthFraction(model, side)
    if (fraction != null) fractions[side] = fraction
  }
  return Object.keys(fractions).length > 0 ? fractions : null
}

// Re-pins each open rail to a previously captured width fraction. flexlayout
// redistributes a removed tabset's weight across ALL remaining siblings in
// proportion to their weight — including a strip-less rail, which then visibly
// grows when a terminal beside it is closed. Re-pinning keeps each rail's pixel
// width and lets the freed space flow to the editor / terminal siblings instead.
// Call this AFTER the deletion has been applied (the sibling weights it reads
// must already reflect the removed tabset).
export function restoreRailWidthFractions(model: Model, fractions: RailWidthFractions): void {
  // Grouped by parent row: both rails normally dock into the root row, and their
  // weights only make sense solved together — pinning them one after the other
  // makes each restore perturb the other's share.
  const byParent = new Map<RowNode, { node: TabSetNode; fraction: number }[]>()
  for (const side of RAIL_SIDES) {
    const fraction = fractions[side]
    if (fraction == null || !(fraction > 0) || !(fraction < 1)) continue
    const rail = findRailTabset(model, side)
    if (!rail) continue
    const parent = rail.getParent()
    if (!(parent instanceof RowNode)) continue
    const group = byParent.get(parent) ?? []
    group.push({ node: rail, fraction })
    byParent.set(parent, group)
  }

  for (const [parent, rails] of byParent) {
    const railNodes = new Set(rails.map((rail) => rail.node))
    const otherWeight = parent.getChildren().reduce((sum, child) => {
      if (child instanceof TabSetNode && railNodes.has(child)) return sum
      const weight = child instanceof TabSetNode || child instanceof RowNode ? child.getWeight() : 0
      return sum + (weight > 0 ? weight : 0)
    }, 0)
    if (!(otherWeight > 0)) continue
    // railWeight / (allRailWeights + otherWeight) === fraction, for every rail in
    // the row at once ⇒ solve the system rather than one rail at a time.
    const railShare = rails.reduce((sum, rail) => sum + rail.fraction, 0)
    if (!(railShare > 0) || !(railShare < 1)) continue
    for (const rail of rails) {
      const targetWeight = (rail.fraction * otherWeight) / (1 - railShare)
      if (!Number.isFinite(targetWeight) || targetWeight <= 0) continue
      if (Math.abs(rail.node.getWeight() - targetWeight) < 0.01) continue
      model.doAction(Actions.updateNodeAttributes(rail.node.getId(), { weight: targetWeight }))
    }
  }
}

export function restoreRailWidthFraction(model: Model, fraction: number, side: RailSide): void {
  restoreRailWidthFractions(model, { [side]: fraction })
}

// Drop-in for `model.doAction(Actions.deleteTab(id))` that keeps both strip-less
// rails at their current width. App-initiated closes (the tab context menu,
// middle-click, a panel's own close button) dispatch straight to the model and
// so never reach the Layout's onAction hook; routing them through here gives
// them the same width-preserving behaviour as flexlayout's built-in close
// button. Runs synchronously: the deletion settles the sibling weights before
// the rails are re-pinned.
export function deleteTabPreservingRails(model: Model, tabId: string): void {
  const fractions = captureRailWidthFractions(model)
  model.doAction(Actions.deleteTab(tabId))
  if (fractions) restoreRailWidthFractions(model, fractions)
}

// Drops every tab on THIS rail except the one just selected, anywhere in the
// model, so the rail stays single-select even when an older layout left a stray
// tab of its own in another tabset. Scoped to one edge so a second rail could
// stay open beside it.
function removeRailTabsExcept(model: Model, keepComponent: string, side: RailSide): void {
  const tabIds: string[] = []
  model.visitNodes((node) => {
    if (!(node instanceof TabNode)) return
    const component = node.getComponent()
    if (component && RAILS[side].components.has(component) && component !== keepComponent) {
      tabIds.push(node.getId())
    }
  })
  tabIds.forEach((tabId) => model.doAction(Actions.deleteTab(tabId)))
}

// A freshly docked tabset takes flexlayout's default weight of 100 — half the
// row on a single-terminal workspace. Pin the rail to its intended pixel width
// the first time it docks (the same weight solve the width-preserving restore
// uses) and stamp the splitter's floor. Sides without widths configured keep
// flexlayout's default. Headless/not-yet-laid-out models report a 0-width row;
// those skip the pin rather than divide by it.
function applyRailDefaultWidth(model: Model, rail: TabSetNode, side: RailSide): void {
  const { defaultWidthPx, minWidthPx } = RAILS[side]
  if (minWidthPx != null) {
    model.doAction(Actions.updateNodeAttributes(rail.getId(), { minWidth: minWidthPx }))
  }
  if (defaultWidthPx == null) return
  const parent = rail.getParent()
  if (!(parent instanceof RowNode)) return
  const rowWidth = parent.getRect().width
  if (!(rowWidth > defaultWidthPx)) return
  restoreRailWidthFraction(model, defaultWidthPx / rowWidth, side)
}

// Reveals a rail switch in its edge's exclusive strip-less pane: focuses it when
// it's already open, swaps it in when another switch on the SAME edge is
// showing, or docks a fresh column on that edge when none is.
function revealRailComponent(workspaceId: string, component: string, name: string, side: RailSide): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  // Already open — just make sure it's the visible switch.
  if (focusComponentTab(workspaceId, component)) return true

  // Stack into this edge's existing pane when one is open, else dock a fresh
  // column on that edge of the root so terminals/agents keep the middle. The
  // pane appears at full width with no entrance animation, deliberately:
  // animating a docked pane's width reflows the whole workspace card, terminals
  // included, every frame and reads as lag (the call workspaceAsideColumn.tsx
  // already made for the pane column).
  const railTabset = findRailTabset(model, side)
  const targetId = railTabset ? railTabset.getId() : rootRowId(model)
  const location = railTabset ? DockLocation.CENTER : RAILS[side].dock
  model.doAction(Actions.addNode({ type: 'tab', name, component }, targetId, location, -1, true))

  // Enforce single-select on this edge, then hide the strip on whichever tabset
  // now holds the lone switch.
  removeRailTabsExcept(model, component, side)
  const pane = findRailTabset(model, side)
  if (pane) {
    model.doAction(Actions.updateNodeAttributes(pane.getId(), { enableTabStrip: false }))
    if (!railTabset) applyRailDefaultWidth(model, pane, side)
  }
  return true
}

// Exclusive toggle into one edge's strip-less pane. Clicking the open switch
// closes it (the pane collapses when it empties); clicking another switch on the
// same edge swaps it in.
function toggleRailComponent(workspaceId: string, component: string, name: string, side: RailSide): boolean {
  if (hasComponentTab(workspaceId, component)) {
    return removeComponentTab(workspaceId, component)
  }
  return revealRailComponent(workspaceId, component, name, side)
}

// The Editor keeps its document tab strip. Toggling removes the standalone
// 'editor' welcome tab (open files — the 'file-editor' tabs — are closed from
// their own strip); when no welcome tab is open it reveals the editor surface
// without stacking a second one: it focuses an existing open file, else docks a
// fresh welcome editor center-stage, to the RIGHT of the nav pane.
function toggleEditorRailComponent(workspaceId: string, component: string, name: string): boolean {
  if (hasComponentTab(workspaceId, component)) {
    return removeComponentTab(workspaceId, component)
  }

  // Files already open — reveal that surface rather than adding a 2nd welcome
  // tab the user would then have to close.
  if (focusComponentTab(workspaceId, 'file-editor')) return true

  const model = models.get(workspaceId)
  if (!model) return false

  // No editor surface at all. Sit the document area between the nav pane (left)
  // and terminals/agents (right) instead of stacking into the currently active
  // terminal tabset.
  return addEditorSurfaceNode(model, { type: 'tab', name, component })
}

export function focusOrAddComponentTab(workspaceId: string, component: string, name: string): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  if (focusComponentTab(workspaceId, component)) return true

  let targetTabset: TabSetNode | null = model.getActiveTabset() ?? null
  if (!targetTabset) {
    model.visitNodes((node) => {
      if (!targetTabset && node instanceof TabSetNode) {
        targetTabset = node
      }
    })
  }
  if (!targetTabset) return false

  model.doAction(Actions.addNode({ type: 'tab', name, component }, targetTabset.getId(), DockLocation.CENTER, -1, true))
  return true
}

export type CrossWorkspaceTabSpec = {
  component: string
  name: string
  config: Record<string, unknown> | null
  className: string | null
}

export function extractTabSpec(workspaceId: string, tabId: string): CrossWorkspaceTabSpec | null {
  const model = models.get(workspaceId)
  if (!model) return null
  const node = model.getNodeById(tabId)
  if (!(node instanceof TabNode)) return null

  const rawConfig = node.getConfig()
  return {
    component: node.getComponent() ?? '',
    name: node.getName(),
    config: rawConfig && typeof rawConfig === 'object' ? (rawConfig as Record<string, unknown>) : null,
    className: node.getClassName() ?? null,
  }
}

export function removeTab(workspaceId: string, tabId: string, options?: { preserveRuntime?: boolean }): boolean {
  const model = models.get(workspaceId)
  if (!model) return false
  const node = model.getNodeById(tabId)
  if (!(node instanceof TabNode)) return false
  const action = Actions.deleteTab(tabId)
  if (options?.preserveRuntime) {
    const actionData = action.data as Record<string, unknown>
    actionData.__sprintenginePreserveRuntime = true
  }
  model.doAction(action)
  return true
}

function buildTabJson(spec: CrossWorkspaceTabSpec): Record<string, unknown> {
  const tabJson: Record<string, unknown> = {
    type: 'tab',
    name: spec.name,
    component: spec.component,
  }
  if (spec.config) tabJson.config = spec.config
  if (spec.className) tabJson.className = spec.className
  return tabJson
}

// Adds a tab as a new tabset docked on the right edge of the workspace's root,
// producing a side-by-side tile. Used for cross-workspace tab moves where the
// caller has chosen "tile, don't stack" semantics.
export function addTabAsNewColumn(workspaceId: string, spec: CrossWorkspaceTabSpec): boolean {
  const model = models.get(workspaceId)
  if (!model) return false

  model.doAction(
    Actions.addNode(
      buildTabJson(spec) as Parameters<typeof Actions.addNode>[0],
      rootRowId(model),
      DockLocation.RIGHT,
      -1,
      true,
    ),
  )
  return true
}

// Mutates a persisted IJsonModel to append a new tabset (containing the given
// tab) as a sibling of the existing root layout, producing a side-by-side
// tile. Used when the destination workspace's live flexlayout Model is not
// mounted (so we cannot dispatch addNode); the next mount will pick up the
// new tab from this JSON.
export function appendTabAsNewColumnInJson(layoutModel: IJsonModel, spec: CrossWorkspaceTabSpec): IJsonModel {
  const tabJson = buildTabJson(spec)
  const root = layoutModel.layout
  const newTabset = { type: 'tabset', weight: 50, children: [tabJson] }

  if (root && root.type === 'row') {
    const existingChildren = Array.isArray(root.children) ? root.children : []
    return {
      ...layoutModel,
      layout: {
        ...root,
        children: [...existingChildren, newTabset],
      } as IJsonModel['layout'],
    }
  }

  return {
    ...layoutModel,
    layout: {
      type: 'row',
      children: [root, newTabset],
    } as IJsonModel['layout'],
  }
}

export function buildSingleTabLayoutModel(spec: CrossWorkspaceTabSpec): IJsonModel {
  return {
    global: { tabSetEnableDrop: true, tabEnableClose: true },
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          weight: 100,
          children: [buildTabJson(spec)],
        },
      ],
    } as IJsonModel['layout'],
  }
}
