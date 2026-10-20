// @vitest-environment jsdom
//
// The palette's rows for pausing scheduled agents, in the palette itself:
// typed for, they are there, and choosing one pauses. Which rows there are is
// palette/scheduledAgentsCommands.test.ts's; this pins that the palette lists
// them, from the window's own mirror of the schedules.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Workspace, WorkspaceId, WorkspaceWindowId } from '../../types/workspace'
import type { ModuleCommandContext } from '../../commands/types'
import type { CommandAvailabilityContext } from '../../commands/availability'

const fixtures = vi.hoisted(() => ({
  state: {
    activeWorkspaceId: 'ws-1',
    focusedAgentByWorkspaceId: {} as Record<string, string>,
    pluginCatalogEntries: [],
    appSettings: { keybindings: {}, modules: {}, appearance: { usageLimits: false } },
    setActiveWorkspaceForWindow: () => {},
    setActiveFile: () => {},
    openExtensionsSurface: () => {},
  },
}))
vi.mock('../../store/workspaceStore', () => {
  const useWorkspaceStore = (select: (state: typeof fixtures.state) => unknown) => select(fixtures.state)
  useWorkspaceStore.getState = () => fixtures.state
  return { useWorkspaceStore }
})
vi.mock('../../modules', async () => {
  const { createRendererHost } = await import('../../modules/renderer-host')
  const host = createRendererHost()
  return { getRendererHost: () => host, selectModuleEnabled: () => true }
})
vi.mock('../../hooks/useTerminalSessions', () => ({
  useTerminalSessions: () => [],
  isLiveTerminal: () => false,
}))
vi.mock('../workspace/useConversationPullRequests', () => ({ useConversationPullRequests: () => ({}) }))

import CommandPalette from './CommandPalette'
import { resetScheduledAgentsStoreForTests } from '../../store/scheduledAgentsStore'

const workspace = {
  id: 'ws-1',
  name: 'project',
  mode: 'agent',
  folderPath: '/Users/dev/project',
} as unknown as Workspace

let root: Root
let host: HTMLDivElement
const pauseAllScheduledAgents = vi.fn(async (until: number | null) => ({ ok: true, pause: { since: 1, until } }))
const pauseScheduledAgent = vi.fn(async (id: string) => ({ ok: true, agent: { id, nextRunAt: null } }))

beforeEach(() => {
  vi.clearAllMocks()
  resetScheduledAgentsStoreForTests()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  Object.assign(window, {
    api: {
      platform: 'darwin',
      builtinSkillsList: async () => [],
      workspaceSkillsList: async () => ({ ok: true, skills: [] }),
      searchFiles: async () => ({ ok: true, results: [], engine: 'ripgrep' }),
      searchContent: async () => ({ ok: true, results: [], engine: 'ripgrep' }),
      cancelContentSearch: async () => {},
      readfile: async () => '',
      listScheduledAgents: async () => [
        { id: 'sa-1', prompt: 'Fix open GitHub issues', schedule: { cron: '0 9 * * *', timezone: 'UTC' } },
      ],
      onScheduledAgentsChanged: () => () => {},
      getScheduledAgentsPause: async () => null,
      onScheduledAgentsPauseChanged: () => () => {},
      pauseAllScheduledAgents,
      pauseScheduledAgent,
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render() {
  await act(async () =>
    root.render(
      <CommandPalette
        onClose={() => {}}
        onRunCommand={() => false}
        onOpenRemoteConnections={() => {}}
        workspaceWindowId={'window-1' as WorkspaceWindowId}
        workspaces={[workspace]}
        activeWorkspaceId={'ws-1' as WorkspaceId}
        activeScopes={[]}
        commandAvailability={{} as CommandAvailabilityContext}
        moduleCommandContext={{} as ModuleCommandContext}
      />,
    ),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function type(value: string) {
  const field = host.querySelector<HTMLInputElement>('input[role="combobox"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const optionLabels = () =>
  Array.from(host.querySelectorAll('[role="option"]')).map((option) => option.textContent ?? '')

test('typed for, the palette lists pausing them all and pausing each one, and a row pauses', async () => {
  await render()
  await type('pause')
  const labels = optionLabels()
  expect(labels.some((label) => label.includes('Pause all scheduled agents for 1 hour'))).toBe(true)
  expect(labels.some((label) => label.includes('Pause all scheduled agents until tomorrow morning'))).toBe(true)
  expect(labels.some((label) => label.includes('Pause all scheduled agents until I resume them'))).toBe(true)
  expect(labels.some((label) => label.includes('Pause schedule: Fix open GitHub issues'))).toBe(true)

  const untilResumed = Array.from(host.querySelectorAll<HTMLElement>('[role="option"]')).find((option) =>
    option.textContent?.includes('until I resume them'),
  )!
  await act(async () => untilResumed.click())
  expect(pauseAllScheduledAgents).toHaveBeenCalledWith(null)
})
