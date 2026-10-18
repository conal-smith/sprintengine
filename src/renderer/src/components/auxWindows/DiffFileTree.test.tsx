// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import type { DiffFileItem } from './diffFileList'

// The diff viewer's file list is the Files tree with a filter applied: it
// lists the viewer's own items (one row per file, however many of the
// viewer's steps that file is), a click moves the viewer, the viewer moving
// moves the tree's cursor, and an agent's mark shows on it as it does in the
// Files tab.

const REPO = '/Users/dev/app'
let sessions: unknown[] = []
const reads: string[] = []

;(window as unknown as { api: unknown }).api = new Proxy(
  {
    platform: 'darwin',
    readdir: async (path: string) => {
      reads.push(path)
      return []
    },
    watchPath: async () => async () => {},
    getGitRepoRoot: async () => null,
    checkIgnored: async () => [],
    deletePath: async () => {},
    conversationSessionsList: async () => ({ ok: true, sessions }),
  } as Record<string, unknown>,
  {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => {} : async () => undefined
    },
  },
)

const { DiffFileTree, diffTreeEntries, diffTreeIndexForPath } = await import('./DiffFileTree')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')

// A partly staged file is two items: its staged diff and its unstaged one.
const ITEMS: DiffFileItem[] = [
  { path: `${REPO}/src/a.ts`, relativePath: 'src/a.ts', status: 'modified', kind: 'staged' },
  { path: `${REPO}/src/b.ts`, relativePath: 'src/b.ts', status: 'new', kind: 'staged' },
  { path: `${REPO}/src/a.ts`, relativePath: 'src/a.ts', status: 'modified', kind: 'unstaged' },
  { path: `${REPO}/docs/old.md`, relativePath: 'docs/old.md', status: 'deleted', kind: 'unstaged' },
]

let root: Root
let host: HTMLDivElement
let selected: number[] = []

beforeEach(() => {
  sessions = []
  selected = []
  reads.length = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function settle(ms = 160): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

function rows(): HTMLElement[] {
  return Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]'))
}

function row(name: string): HTMLElement | null {
  return rows().find((item) => item.textContent?.includes(name)) ?? null
}

function Tree({ currentIndex, items = ITEMS }: { currentIndex: number; items?: DiffFileItem[] }): React.JSX.Element {
  return (
    <ConfirmDialogProvider>
      <DiffFileTree
        items={items}
        currentIndex={currentIndex}
        rootPath={REPO}
        workspaceId="ws-diff"
        workspaceWindow={false}
        gitStatus={null}
        directoryStatus={{}}
        refreshGitStatus={async () => {}}
        onSelectIndex={(index) => selected.push(index)}
        onOpenFile={() => {}}
      />
    </ConfirmDialogProvider>
  )
}

test('one entry per file, and a click lands on the item already on screen when it is that file', () => {
  assert.deepEqual(
    diffTreeEntries(ITEMS).map((entry) => [entry.name, entry.gitDeleted === true]),
    [
      ['a.ts', false],
      ['b.ts', false],
      ['old.md', true],
    ],
  )
  assert.equal(diffTreeIndexForPath(ITEMS, `${REPO}/src/a.ts`, 2), 2, 'stays on the unstaged half')
  assert.equal(diffTreeIndexForPath(ITEMS, `${REPO}/src/a.ts`, 1), 0, 'else the first of the two')
  assert.equal(diffTreeIndexForPath(ITEMS, `${REPO}/nope.ts`, 0), -1)
})

test("the tree lists the viewer's files, a click moves the viewer, and the viewer moves the cursor", async () => {
  await act(async () => root.render(<Tree currentIndex={0} />))
  await settle()

  const names = rows().map((item) => item.querySelector('span.truncate')?.textContent)
  assert.deepEqual(names, ['docs', 'old.md', 'src', 'a.ts', 'b.ts'], 'the files, under their folders, once each')
  assert.equal(row('a.ts')?.getAttribute('aria-selected'), 'true', 'the cursor is on the file on screen')
  assert.ok(row('a.ts')?.textContent?.includes('M'), 'with its status')
  assert.equal(reads.length, 0, 'and nothing was read from disk to show it')

  await act(async () => row('b.ts')?.click())
  assert.deepEqual(selected, [1], 'a click moves the viewer to that file')
  await act(async () => row('old.md')?.click())
  assert.deepEqual(selected, [1, 3], 'a deleted file too: its diff is what there is to see')

  // ⌘↓ in the viewer: its cursor moves, and the tree's follows.
  await act(async () => root.render(<Tree currentIndex={1} />))
  await settle()
  assert.equal(row('b.ts')?.getAttribute('aria-selected'), 'true')
  assert.equal(row('a.ts')?.getAttribute('aria-selected'), 'false')
  // Onto the unstaged half of a.ts: still that one row.
  await act(async () => root.render(<Tree currentIndex={2} />))
  await settle()
  assert.equal(row('a.ts')?.getAttribute('aria-selected'), 'true')
})

test("the diff tree's menu is the Files tree's, with a deleted file's disk actions left off", async () => {
  await act(async () => root.render(<Tree currentIndex={0} />))
  await settle()
  const menuFor = async (name: string) => {
    await act(async () => {
      row(name)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
    })
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
      (item) => item.textContent?.trim() ?? '',
    )
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    return items
  }
  const live = await menuFor('b.ts')
  for (const item of ['Open', 'Reveal in file manager', 'New file', 'Copy', 'Rename', 'Delete', 'Refresh']) {
    assert.ok(live.includes(item), `${item} is offered on a file in the diff`)
  }
  const deleted = await menuFor('old.md')
  assert.ok(!deleted.includes('Open') && !deleted.includes('Rename'), 'nothing on disk to open or rename')
  assert.ok(deleted.includes('Refresh'), 'the rest of the menu is still there')
})

test("an agent's mark shows on the diff tree's row", async () => {
  sessions = [
    {
      sessionId: 'session-1',
      workspaceId: 'ws-diff',
      agentId: 'chat-1',
      status: 'active',
      phase: 'running',
      fileActivity: [{ path: `${REPO}/src/b.ts`, verb: 'reading', toolUseId: 'read-1', startedAt: Date.now() }],
    },
  ]
  await act(async () => root.render(<Tree currentIndex={0} />))
  await settle()
  assert.equal(row('b.ts')?.querySelector('[data-agent-trail]')?.getAttribute('data-agent-trail'), 'reading')
  assert.equal(row('a.ts')?.querySelector('[data-agent-trail]'), null)
})
