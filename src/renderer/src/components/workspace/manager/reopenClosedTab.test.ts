import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../../../store/workspaceStore', () => ({ useWorkspaceStore: { getState: () => ({}) } }))
vi.mock('../../../utils/modelRegistry', () => ({ addTerminalTab: () => false, focusOrAddFileTab: () => false }))

const { reopenLastClosedTab } = await import('./reopenClosedTab')
const { rememberClosedLayoutTab, rememberClosedPaneTab, resetClosedTabs, takeLastClosedTab } =
  await import('../../../utils/recentlyClosedTabs')

afterEach(() => resetClosedTabs())

function host(answers: { pane?: string | null; file?: boolean; shell?: boolean } = {}) {
  const calls: string[] = []
  return {
    calls,
    host: {
      openPaneTab: (workspaceId: string, open: { kind: string; url?: string }) => {
        calls.push(`pane:${workspaceId}:${open.kind}:${open.url ?? ''}`)
        return answers.pane === undefined ? 'new-tab' : answers.pane
      },
      openFile: (workspaceId: string, filePath: string) => {
        calls.push(`file:${workspaceId}:${filePath}`)
        return answers.file ?? true
      },
      openShell: (workspaceId: string, name: string) => {
        calls.push(`shell:${workspaceId}:${name}`)
        return answers.shell ?? true
      },
    },
  }
}

test('⌘⇧T opens the last closed tab of this workspace, then the one before it', () => {
  rememberClosedLayoutTab('ws', { component: 'file-editor', config: { filePath: '/Users/dev/app/a.ts' }, name: 'a.ts' })
  rememberClosedPaneTab('ws', { id: 'b', kind: 'browser', url: 'http://localhost:3000' })
  rememberClosedLayoutTab('ws', { component: 'terminal', config: {}, name: 'Terminal' })
  const { calls, host: reopen } = host()
  expect(reopenLastClosedTab('ws', reopen)).toBe(true)
  expect(reopenLastClosedTab('ws', reopen)).toBe(true)
  expect(reopenLastClosedTab('ws', reopen)).toBe(true)
  expect(reopenLastClosedTab('ws', reopen), 'nothing left').toBe(false)
  expect(calls).toEqual(['shell:ws:Terminal', 'pane:ws:browser:http://localhost:3000', 'file:ws:/Users/dev/app/a.ts'])
})

test('a tab that cannot come back (a full pane) stays for the next press', () => {
  rememberClosedPaneTab('ws', { id: 'g', kind: 'git' })
  expect(reopenLastClosedTab('ws', host({ pane: null }).host)).toBe(false)
  expect(takeLastClosedTab('ws')).toEqual({ where: 'pane', workspaceId: 'ws', open: { kind: 'git' } })
})
