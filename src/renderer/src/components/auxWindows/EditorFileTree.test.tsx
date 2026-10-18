// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

// The editor window's file tree, mounted: it follows the open file by reading
// only that file's folders, pins a file that lives outside the root, and —
// because it runs in a window that must not write the shared settings — writes
// nothing to the store or to the settings key however it is used.

const ROOT = '/Users/dev/app'
const DISK: Record<string, { name: string; isDir: boolean }[]> = {
  [ROOT]: [
    { name: 'src', isDir: true },
    { name: 'docs', isDir: true },
    { name: 'package.json', isDir: false },
  ],
  [`${ROOT}/src`]: [
    { name: 'main', isDir: true },
    { name: 'renderer', isDir: true },
  ],
  [`${ROOT}/src/main`]: [{ name: 'index.ts', isDir: false }],
  [`${ROOT}/src/renderer`]: [{ name: 'App.tsx', isDir: false }],
  [`${ROOT}/docs`]: [{ name: 'guide.md', isDir: false }],
}

const reads: string[] = []
const revealed: string[] = []
const copied: string[] = []

function stubApi(): void {
  const named: Record<string, unknown> = {
    platform: 'darwin',
    readdir: async (path: string) => {
      reads.push(path)
      const listing = DISK[path]
      if (!listing) throw new Error(`ENOENT: ${path}`)
      return listing
    },
    watchPath: async () => async () => {},
    getGitRepoRoot: async () => null,
    checkIgnored: async () => [],
    showItemInFolder: async (path: string) => {
      revealed.push(path)
    },
    clipboardWriteText: async (text: string) => {
      copied.push(text)
    },
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(named, {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => {} : async () => undefined
    },
  })
}

stubApi()
const { EditorFileTree, EDITOR_TREE_FOLLOW_DELAY_MS } = await import('./EditorFileTree')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
const { useWorkspaceStore } = await import('../../store/workspaceStore')
const { APP_SETTINGS_STORAGE_KEY } = await import('../../store/slices/persistenceSlice')

let root: Root
let host: HTMLDivElement
const opened: string[] = []
let returned = 0

function Tree({ activePath }: { activePath: string | null }): React.JSX.Element {
  return (
    <ConfirmDialogProvider>
      <EditorFileTree
        rootPath={ROOT}
        activePath={activePath}
        onOpenFile={(path) => opened.push(path)}
        onReturnFocus={() => {
          returned += 1
        }}
      />
    </ConfirmDialogProvider>
  )
}

async function settle(ms = EDITOR_TREE_FOLLOW_DELAY_MS + 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

function row(name: string): HTMLElement | null {
  return (
    Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (item) => item.textContent?.includes(name) && !item.textContent.includes('Outside'),
    ) ?? null
  )
}

beforeEach(() => {
  reads.length = 0
  opened.length = 0
  revealed.length = 0
  copied.length = 0
  returned = 0
  stubApi()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

test('follows the open file by reading only its folders', async () => {
  await act(async () => root.render(<Tree activePath={`${ROOT}/src/main/index.ts`} />))
  await settle()

  assert.deepEqual(reads, [ROOT, `${ROOT}/src`, `${ROOT}/src/main`], 'root and ancestors, nothing else')
  const selected = row('index.ts')
  assert.ok(selected, 'the open file has a row')
  assert.equal(selected?.getAttribute('aria-selected'), 'true', 'and it is the selected one')
  assert.equal(row('src')?.getAttribute('aria-expanded'), 'true', 'its ancestors are open')
  assert.equal(row('docs')?.getAttribute('aria-expanded'), 'false', 'a sibling folder is not')

  // A re-render that does not change the file does not reveal again.
  reads.length = 0
  await act(async () => root.render(<Tree activePath={`${ROOT}/src/main/index.ts`} />))
  await settle()
  assert.deepEqual(reads, [], 'no reveal on an unrelated render')
})

test('a file outside the root is pinned above the tree, with its folder and its two actions', async () => {
  await act(async () => root.render(<Tree activePath="/Users/dev/tmp/agent-patches/fix.patch" />))
  await settle()

  // The caption is drawn over the row; the row itself names the whole thing.
  assert.ok(host.textContent?.includes('Outside this workspace'), 'the caption is shown')
  const pinned = Array.from(host.querySelectorAll<HTMLElement>('[role="group"]')).find((item) =>
    item.getAttribute('aria-label')?.includes('outside this workspace'),
  )
  assert.ok(pinned, 'one pinned row')
  assert.ok(pinned?.textContent?.includes('fix.patch'), 'the file name is the primary text')
  assert.ok(pinned?.textContent?.includes('/Users/dev/tmp/agent-patches'), 'naming the folder the file is in')
  assert.ok(!pinned?.closest('[role="tree"]'), 'outside the tree, which the keyboard walks')
  assert.ok(!reads.includes('/Users/dev/tmp/agent-patches'), 'the outside folder is never listed')

  await act(async () => {
    pinned?.lastElementChild?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }))
  })
  const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((item) =>
    item.textContent?.trim(),
  )
  assert.deepEqual(items, ['Reveal in Finder', 'Copy path'])
  await act(async () => {
    Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.includes('Copy path'))
      ?.click()
  })
  assert.deepEqual(copied, ['/Users/dev/tmp/agent-patches/fix.patch'])

  // Only while it is the open file.
  await act(async () => root.render(<Tree activePath={`${ROOT}/package.json`} />))
  await settle()
  assert.ok(!host.textContent?.includes('Outside this workspace'), 'gone once an inside file is open')
})

test('reading and opening writes nothing to the shared store or the settings key', async () => {
  const before = useWorkspaceStore.getState()
  const settingsBefore = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)
  const setItem = window.localStorage.setItem.bind(window.localStorage)
  const written: string[] = []
  window.localStorage.setItem = (key: string, value: string) => {
    written.push(key)
    setItem(key, value)
  }
  try {
    await act(async () => root.render(<Tree activePath={`${ROOT}/src/main/index.ts`} />))
    await settle()

    const tree = host.querySelector<HTMLElement>('[role="tree"]')
    assert.ok(tree)
    await act(async () => row('docs')?.click())
    await settle(20)
    assert.equal(row('docs')?.getAttribute('aria-expanded'), 'true', 'a folder click opens it')
    await act(async () => row('guide.md')?.click())
    assert.deepEqual(opened, [`${ROOT}/docs/guide.md`], 'a file click opens it as a tab')

    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter']) {
      await act(async () => {
        tree?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }
    await act(async () => {
      tree?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(returned, 1, 'Escape hands the keyboard back to the editor')

    assert.equal(useWorkspaceStore.getState(), before, 'the store was not written')
    assert.equal(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY), settingsBefore, 'nor the settings key')
    assert.deepEqual(written, [], 'nor anything else in storage')
  } finally {
    window.localStorage.setItem = setItem
  }
})
