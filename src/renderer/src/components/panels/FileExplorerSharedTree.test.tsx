// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import type { LayoutTemplate } from '../../types/workspace'

// One Files tree, three hosts. The editor window's column is the workspace's
// Files tree with a different host around it, so right-clicking a file there
// offers what right-clicking it in the pane's Files tab offers, and an agent
// at work on a file marks its row in both.

const ROOT = '/Users/dev/app'
const DISK: Record<string, { name: string; isDir: boolean }[]> = {
  [ROOT]: [
    { name: 'src', isDir: true },
    { name: 'README.md', isDir: false },
  ],
  [`${ROOT}/src`]: [{ name: 'index.ts', isDir: false }],
}

let sessions: unknown[] = []

;(window as unknown as { api: unknown }).api = new Proxy(
  {
    platform: 'darwin',
    readdir: async (path: string) => {
      const listing = DISK[path]
      if (!listing) throw new Error(`ENOENT: ${path}`)
      return listing
    },
    watchPath: async () => async () => {},
    checkWorkspaceFolder: async (path: string) => ({ ok: true, status: 'ready', path, checkedPath: path }),
    getGitRepoRoot: async () => null,
    checkIgnored: async () => [],
    deletePath: async () => {},
    workspaceSyncDispatch: async () => ({ ok: true }),
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

const { default: FileExplorer } = await import('./FileExplorer')
const { EditorFileTree } = await import('../auxWindows/EditorFileTree')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
const { useWorkspaceStore } = await import('../../store/workspaceStore')

const template: LayoutTemplate = {
  id: 'files-shared-test',
  name: 'Files',
  description: 'Shared file tree test template',
  previewSlots: [],
  layout: {
    global: {},
    borders: [],
    layout: { type: 'row', children: [{ type: 'tabset', weight: 100, children: [] }] },
  },
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  sessions = []
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

function row(name: string): HTMLElement | null {
  return (
    Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]')).find((item) =>
      item.textContent?.includes(name),
    ) ?? null
  )
}

async function menuFor(name: string): Promise<string[]> {
  const target = row(name)
  assert.ok(target, `${name} has a row`)
  await act(async () => {
    target?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
  })
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
    (item) => item.textContent?.trim() ?? '',
  )
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  return items
}

function newWorkspace(): string {
  return useWorkspaceStore.getState().addWorkspace(template, { name: 'App', folderPath: ROOT })
}

function editorTree(workspaceId: string, activePath: string): React.JSX.Element {
  return (
    <ConfirmDialogProvider>
      <EditorFileTree
        rootPath={ROOT}
        workspaceId={workspaceId}
        activePath={activePath}
        onOpenFile={() => {}}
        onReturnFocus={() => {}}
      />
    </ConfirmDialogProvider>
  )
}

test("the editor window's tree right-clicks into the Files tab's menu", async () => {
  const workspaceId = newWorkspace()
  useWorkspaceStore.getState().setActiveFile(workspaceId, `${ROOT}/src/index.ts`)

  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <FileExplorer workspaceId={workspaceId} />
      </ConfirmDialogProvider>,
    ),
  )
  await settle()
  const paneFileMenu = await menuFor('index.ts')
  const paneFolderMenu = await menuFor('src')

  await act(async () => root.render(editorTree(workspaceId, `${ROOT}/src/index.ts`)))
  await settle()
  const editorFileMenu = await menuFor('index.ts')
  const editorFolderMenu = await menuFor('src')

  assert.ok(paneFileMenu.includes('Rename') && paneFileMenu.includes('Delete'), 'the pane menu is the full one')
  assert.deepEqual(editorFileMenu, paneFileMenu, 'a file: the same items, in the same order')
  // A folder's role is the workspace's to remember, and the editor window may
  // not write the workspace: that one item is the whole difference.
  assert.deepEqual(
    editorFolderMenu,
    paneFolderMenu.filter((item) => item !== 'Mark directory as'),
    'a folder: the same, less marking it',
  )
  assert.ok(paneFolderMenu.includes('Mark directory as'), 'which the pane does offer')
})

test("an agent at work marks the file's row in the editor window's tree", async () => {
  const workspaceId = newWorkspace()
  sessions = [
    {
      sessionId: 'session-1',
      workspaceId,
      agentId: 'chat-1',
      status: 'active',
      phase: 'running',
      fileActivity: [{ path: `${ROOT}/src/index.ts`, verb: 'editing', toolUseId: 'edit-1', startedAt: Date.now() }],
    },
  ]

  await act(async () => root.render(editorTree(workspaceId, `${ROOT}/src/index.ts`)))
  await settle()

  const marked = row('index.ts')?.querySelector('[data-agent-trail]')
  assert.equal(marked?.getAttribute('data-agent-trail'), 'editing', 'the file being edited says so')
  assert.ok(row('index.ts')?.textContent?.includes('an agent is editing this'), 'in words, too')
  assert.equal(row('README.md')?.querySelector('[data-agent-trail]'), null, 'and a file nobody touches does not')
})
