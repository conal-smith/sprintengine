import { afterEach, expect, test } from 'vitest'

import type { Workspace, WorkspacePaneTab } from '../types/workspace'
import { createWorkspacePaneSlice } from '../store/slices/workspacePaneSlice'
import {
  MAX_CLOSED_TABS,
  closedPaneTabSpec,
  rememberClosedLayoutTab,
  rememberClosedPaneTab,
  resetClosedTabs,
  takeLastClosedTab,
} from './recentlyClosedTabs'

afterEach(() => resetClosedTabs())

const tab = (fields: Partial<WorkspacePaneTab> & Pick<WorkspacePaneTab, 'kind'>): WorkspacePaneTab => ({
  id: 'tab',
  ...fields,
})

test('a browser tab comes back at its URL, a terminal as a new shell, a surface on what it showed', () => {
  expect(closedPaneTabSpec(tab({ kind: 'browser', url: 'http://localhost:5173/health', title: 'Health' }))).toEqual({
    kind: 'browser',
    url: 'http://localhost:5173/health',
    title: 'Health',
  })
  // No terminal id: the pane mints a new one, so nothing the old shell ran runs again.
  expect(closedPaneTabSpec(tab({ kind: 'terminal', terminalId: 'abc', title: 'npm test' }))).toEqual({
    kind: 'terminal',
  })
  expect(closedPaneTabSpec(tab({ kind: 'git' }))).toEqual({ kind: 'git' })
  expect(closedPaneTabSpec(tab({ kind: 'canvas', canvas: { path: 'boards/plan.canvas' } }))).toEqual({
    kind: 'canvas',
    canvas: { path: 'boards/plan.canvas' },
  })
})

test("a diff comes back where it was looking, without an agent's reveal or a tour", () => {
  const spec = closedPaneTabSpec(
    tab({
      kind: 'diff',
      diff: {
        repoRoot: '/Users/dev/app',
        focusPath: '/Users/dev/app/src/a.ts',
        focusKind: 'unstaged',
        changelistId: 'agent-1',
        reveal: { key: 'r1', paths: ['src/a.ts'] },
        tour: { id: 't1', playing: true },
        tourOffer: 't2',
      },
    }),
  )
  expect(spec).toEqual({
    kind: 'diff',
    diff: {
      repoRoot: '/Users/dev/app',
      focusPath: '/Users/dev/app/src/a.ts',
      focusKind: 'unstaged',
      changelistId: 'agent-1',
    },
  })
})

test('a document tab with no file is not remembered, since there is nothing to open', () => {
  expect(closedPaneTabSpec(tab({ kind: 'document' }))).toBeNull()
  rememberClosedPaneTab('ws', tab({ kind: 'document' }))
  expect(takeLastClosedTab('ws')).toBeNull()
})

test('layout file and shell tabs are remembered; an agent tab never is', () => {
  rememberClosedLayoutTab('ws', { component: 'agent', config: { agentId: 'a1' }, name: 'Scout' })
  rememberClosedLayoutTab('ws', { component: 'file-editor', config: { filePath: '/Users/dev/app/a.ts' }, name: 'a.ts' })
  rememberClosedLayoutTab('ws', { component: 'terminal', config: { terminalId: 't1' }, name: 'Terminal' })
  expect(takeLastClosedTab('ws')).toEqual({ where: 'layout', workspaceId: 'ws', kind: 'terminal', name: 'Terminal' })
  expect(takeLastClosedTab('ws')).toEqual({
    where: 'layout',
    workspaceId: 'ws',
    kind: 'file',
    filePath: '/Users/dev/app/a.ts',
    name: 'a.ts',
  })
  expect(takeLastClosedTab('ws'), 'the agent was never there').toBeNull()
})

test('each workspace reopens its own last closed tab, and the stack keeps the newest', () => {
  rememberClosedPaneTab('one', tab({ kind: 'git' }))
  rememberClosedPaneTab('two', tab({ kind: 'files' }))
  expect(takeLastClosedTab('one')?.workspaceId).toBe('one')
  expect(takeLastClosedTab('one')).toBeNull()
  for (let index = 0; index < MAX_CLOSED_TABS + 5; index++)
    rememberClosedPaneTab('three', tab({ kind: 'browser', url: `http://localhost/${index}` }))
  const first = takeLastClosedTab('three')
  expect(first?.where === 'pane' && first.open.url).toBe(`http://localhost/${MAX_CLOSED_TABS + 4}`)
})

test("the pane's own close is what fills the stack", () => {
  const workspace = {
    id: 'ws',
    paneState: { open: true, activeTabId: 'b', tabs: [{ id: 'b', kind: 'browser', url: 'http://localhost/a' }] },
  } as unknown as Workspace
  const carrier = { workspaces: [workspace] }
  const slice = createWorkspacePaneSlice((mutator) => mutator(carrier))
  slice.closePaneTab('ws', 'b')
  expect(carrier.workspaces[0]!.paneState!.tabs).toEqual([])
  expect(takeLastClosedTab('ws')).toEqual({
    where: 'pane',
    workspaceId: 'ws',
    open: { kind: 'browser', url: 'http://localhost/a' },
  })
})
