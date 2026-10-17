// @vitest-environment jsdom
//
// The highlight across a result list that changes under it. Disk search keeps
// the previous query's rows on screen while it waits out its pause, so the
// arrow keys can walk far down a long list that a short one then replaces.
// That is a render-loop and clock interaction, so the palette is mounted for
// real on its Files tab, where disk search is the only source of rows.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { FileSearchResult } from '../../../../shared/electron-api'
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
// An empty kernel rather than the app's, which wires itself to the real store
// as it loads.
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

const workspace = {
  id: 'ws-1',
  name: 'project',
  mode: 'agent',
  folderPath: '/Users/dev/project',
} as unknown as Workspace

let root: Root
let host: HTMLDivElement
const searchFiles = vi.fn<(root: string, query: string) => Promise<FileSearchResult>>()
const readfile = vi.fn<(path: string) => Promise<string>>()
const onClose = vi.fn()

function files(names: string[]): FileSearchResult {
  return {
    ok: true,
    engine: 'ripgrep',
    results: names.map((name) => ({ name, path: `/Users/dev/project/${name}` })),
  } as unknown as FileSearchResult
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  HTMLElement.prototype.scrollIntoView = vi.fn()
  readfile.mockResolvedValue('')
  Object.assign(window, {
    api: {
      platform: 'darwin',
      builtinSkillsList: async () => [],
      workspaceSkillsList: async () => ({ ok: true, skills: [] }),
      searchFiles,
      searchContent: async () => ({ ok: true, results: [], engine: 'ripgrep' }),
      cancelContentSearch: async () => {},
      readfile,
    },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
})

async function render() {
  await act(async () =>
    root.render(
      <CommandPalette
        onClose={onClose}
        onRunCommand={() => false}
        onOpenRemoteConnections={() => {}}
        workspaceWindowId={'window-1' as WorkspaceWindowId}
        workspaces={[workspace]}
        activeWorkspaceId={'ws-1' as WorkspaceId}
        activeScopes={[]}
        commandAvailability={{} as CommandAvailabilityContext}
        moduleCommandContext={{} as ModuleCommandContext}
        initialScope="files"
      />,
    ),
  )
}
const field = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!
const options = () => Array.from(host.querySelectorAll('[role="option"]'))
const highlighted = () => options().filter((option) => option.getAttribute('aria-selected') === 'true')
async function type(value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(field(), value)
    field().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function key(value: string, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
    })
  }
}
// Past disk search's pause, with its answer settled.
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500)
  })
}

test('a shorter result set arriving under a far-down highlight highlights its last row, and Enter runs it', async () => {
  await render()
  searchFiles.mockResolvedValueOnce(files(Array.from({ length: 12 }, (_, index) => `long-${index}.ts`)))
  await type('a')
  await settle()
  expect(options()).toHaveLength(12)

  // The next query's pause: the twelve rows are still up, and the person
  // arrows down them before the three that match arrive.
  searchFiles.mockResolvedValueOnce(files(['short-0.ts', 'short-1.ts', 'short-2.ts']))
  await type('ab')
  await key('ArrowDown', 10)
  expect(highlighted()[0]?.textContent).toContain('long-10.ts')
  await settle()

  expect(options()).toHaveLength(3)
  expect(highlighted()).toHaveLength(1)
  expect(highlighted()[0].textContent).toContain('short-2.ts')
  expect(field().getAttribute('aria-activedescendant')).toBe(highlighted()[0].id)

  await key('Enter')
  expect(readfile).toHaveBeenCalledWith('/Users/dev/project/short-2.ts')
  expect(onClose).toHaveBeenCalled()
})

test('ArrowUp after the list shrinks moves from the highlighted row, not from the one that went', async () => {
  await render()
  searchFiles.mockResolvedValueOnce(files(Array.from({ length: 12 }, (_, index) => `long-${index}.ts`)))
  await type('a')
  await settle()
  searchFiles.mockResolvedValueOnce(files(['short-0.ts', 'short-1.ts', 'short-2.ts']))
  await type('ab')
  await key('ArrowDown', 10)
  await settle()

  await key('ArrowUp')
  expect(highlighted()[0]?.textContent).toContain('short-1.ts')
})

test('ArrowDown with nothing on screen still highlights the first row to arrive', async () => {
  await render()
  searchFiles.mockResolvedValueOnce(files([]))
  await type('a')
  await settle()
  expect(options()).toHaveLength(0)

  // Pressed during the next query's pause, while the empty list is still up.
  searchFiles.mockResolvedValueOnce(files(['first.ts', 'second.ts']))
  await type('ab')
  await key('ArrowDown')
  await settle()
  expect(options()).toHaveLength(2)
  expect(highlighted()[0]?.textContent).toContain('first.ts')
})
