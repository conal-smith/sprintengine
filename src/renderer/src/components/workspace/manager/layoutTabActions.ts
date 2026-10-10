// Actions on the active layout tab: close, cycle, stop, kill its terminal,
// and where a tab dropped outside the window opens.

import { convertNewAgentTabToAgent, addAgentTabAfter, addAgentTabTiled, getModel } from '../../../utils/modelRegistry'
import type { Workspace } from '../../../types/workspace'
import { TabNode, Actions, type Model, TabSetNode } from 'flexlayout-react'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { rememberClosedLayoutTab } from '../../../utils/recentlyClosedTabs'

// Where a spawn should land, and what it should start with. From the tab
// strip's "+", `tabId` names that tab's node and `prompt` is what was typed on
// the launch surface inside it. A chat forked from another names that chat in
// `afterAgentId`, and opens right after its tab.
export type AgentSpawnPlacement = {
  tabId?: string
  afterAgentId?: string
  prompt?: string
  /** A chat's staged images, sent as images with `prompt`. */
  images?: string[]
  /** A chat's files attached by path, sent as the `files` of its first message. */
  files?: string[]
  /**
   * The name the tab already wears. The new-agent tab is named when it opens,
   * like every other terminal in the strip, so the agent adopts that name
   * rather than drawing a second one and renaming the tab under the reader.
   */
  agentName?: string
}

/**
 * Put a freshly spawned agent in its tab. From a new-agent tab that means
 * retyping the SAME node — the launch surface becomes the terminal, in place,
 * with no pane moving under the person who just pressed Start. A fork opens
 * beside the chat it came from. Everywhere else, and whenever that tab is gone
 * (closed while the composer was open), it falls back to the ordinary tiled
 * dock rather than losing the agent.
 */
export function placeSpawnedAgentTab(
  workspaceId: string,
  agentId: string,
  tabName: string,
  placement?: AgentSpawnPlacement,
): void {
  if (placement?.tabId && convertNewAgentTabToAgent(workspaceId, placement.tabId, agentId, tabName)) {
    return
  }
  if (placement?.afterAgentId && addAgentTabAfter(workspaceId, agentId, tabName, placement.afterAgentId)) return
  addAgentTabTiled(workspaceId, agentId, tabName)
}

export function getNextWorkspaceId(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  step: 1 | -1,
): string | null {
  if (workspaces.length < 2) return null

  const activeIndex = workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId)
  if (activeIndex === -1) return workspaces[0].id

  const nextIndex = (activeIndex + step + workspaces.length) % workspaces.length
  return workspaces[nextIndex].id
}

export function workspaceWindowBoundsForDrop(
  placement: { screenX: number; screenY: number },
  currentBounds: { width: number; height: number } | null | undefined,
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(800, Math.round(currentBounds?.width ?? 1400))
  const height = Math.max(600, Math.round(currentBounds?.height ?? 900))
  return {
    x: Math.round(placement.screenX - width / 2),
    y: Math.round(placement.screenY - 24),
    width,
    height,
  }
}

export function killTerminalForLayoutTab(
  workspaceId: string,
  node: TabNode,
  terminalSessions: TerminalSessionSnapshot[],
): void {
  const state = useWorkspaceStore.getState()
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId)
  if (!workspace) return

  const config = node.getConfig() as { agentId?: string; sessionId?: string; terminalId?: string } | undefined
  if (node.getComponent() === 'agent') {
    const agentId = config?.agentId ?? node.getId()
    const agent = workspace.agents[agentId]
    const sessionIds = new Set<string>()
    if (config?.sessionId) sessionIds.add(config.sessionId)
    if (agent?.cliSessionId) sessionIds.add(agent.cliSessionId)
    terminalSessions
      .filter(
        (session) => session.kind === 'agent' && session.workspaceId === workspaceId && session.agentId === agentId,
      )
      .forEach((session) => sessionIds.add(session.sessionId))
    sessionIds.forEach((sessionId) => {
      void window.api.terminalKill(sessionId).catch(() => {})
    })
    state.updateAgent(workspaceId, agentId, {
      cliStartRequested: false,
      cliHasLaunched: false,
      cliOnboardingPromptSent: false,
      cliResumeAvailable: false,
      cliSessionId: undefined,
    })
    return
  }

  if (node.getComponent() === 'terminal') {
    const terminalId = config?.terminalId ?? node.getId()
    const sessionIds = new Set<string>([`terminal-${terminalId}`])
    terminalSessions
      .filter(
        (session) =>
          session.kind === 'terminal' && session.workspaceId === workspaceId && session.terminalId === terminalId,
      )
      .forEach((session) => sessionIds.add(session.sessionId))
    sessionIds.forEach((sessionId) => {
      void window.api.terminalKill(sessionId).catch(() => {})
    })
  }
}

// Stop the process behind a live terminal without closing its tab. The focused
// terminal tab wins; otherwise the workspace's first live terminal session is
// stopped. This succeeds whenever the workspace has a live terminal, so it
// matches the command's `terminalActive` availability exactly (no
// available-but-no-op gap). Returns false only when no live terminal exists.
export function stopActiveTerminal(workspaceId: string, terminalSessions: TerminalSessionSnapshot[]): boolean {
  const model = getModel(workspaceId)
  const tabset = model?.getActiveTabset() ?? (model ? firstTabset(model) : null)
  const selectedNode = tabset?.getChildren()[tabset.getSelected()]
  if (selectedNode instanceof TabNode && selectedNode.getComponent() === 'terminal') {
    killTerminalForLayoutTab(workspaceId, selectedNode, terminalSessions)
    return true
  }
  const session = terminalSessions.find(
    (item) => item.kind === 'terminal' && item.workspaceId === workspaceId && item.terminalId,
  )
  if (!session?.terminalId) return false
  const sessionIds = new Set<string>([`terminal-${session.terminalId}`])
  terminalSessions
    .filter(
      (item) => item.kind === 'terminal' && item.workspaceId === workspaceId && item.terminalId === session.terminalId,
    )
    .forEach((item) => sessionIds.add(item.sessionId))
  sessionIds.forEach((sessionId) => {
    void window.api.terminalKill(sessionId).catch(() => {})
  })
  return true
}

export function closeActiveLayoutTab(workspaceId: string, terminalSessions: TerminalSessionSnapshot[]): boolean {
  const model = getModel(workspaceId)
  const tabset = model?.getActiveTabset() ?? (model ? firstTabset(model) : null)
  if (!model || !tabset) return false

  const selectedIndex = tabset.getSelected()
  const selectedNode = tabset.getChildren()[selectedIndex]
  if (!(selectedNode instanceof TabNode) || !selectedNode.isEnableClose()) return false

  killTerminalForLayoutTab(workspaceId, selectedNode, terminalSessions)
  rememberClosedLayoutTab(workspaceId, {
    component: selectedNode.getComponent(),
    config: selectedNode.getConfig(),
    name: selectedNode.getName(),
  })
  model.doAction(Actions.deleteTab(selectedNode.getId()))
  return true
}

export function cycleActiveLayoutTab(workspaceId: string, step: 1 | -1): boolean {
  const model = getModel(workspaceId)
  const tabset = model?.getActiveTabset() ?? (model ? firstTabset(model) : null)
  if (!model || !tabset) return false

  const tabs = tabset.getChildren().filter((node): node is TabNode => node instanceof TabNode)
  if (tabs.length < 2) return false

  const selectedNode = tabset.getSelectedNode()
  const selectedIndex =
    selectedNode instanceof TabNode ? tabs.findIndex((tab) => tab.getId() === selectedNode.getId()) : -1
  const nextIndex = ((selectedIndex === -1 ? 0 : selectedIndex) + step + tabs.length) % tabs.length
  const nextTab = tabs[nextIndex]
  model.doAction(Actions.selectTab(nextTab.getId()))
  if (nextTab.getComponent() === 'editor') {
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('sprintengine:focus-editor', { detail: { workspaceId } }))
    })
  }
  return true
}

export function firstTabset(model: Model): TabSetNode | null {
  let found: TabSetNode | null = null
  model.visitNodes((node) => {
    if (found) return
    if (node instanceof TabSetNode) found = node
  })
  return found
}
