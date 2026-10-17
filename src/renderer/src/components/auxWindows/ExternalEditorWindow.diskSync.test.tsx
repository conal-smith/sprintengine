// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { FileWatchEvent } from '../../../../shared/ipc/filesystem'
import { fakeMonaco, type FakeMonacoEditor } from '../../../../../tests/fake-monaco-editor'

// The pop-out editor window — where files open by default — against a file an
// agent changes on disk: a clean tab takes the change, a dirty one asks, the
// window's own save is not mistaken for someone else's, and ⌘S on a clean tab
// writes nothing.

vi.mock('@monaco-editor/react', () => import('../../../../../tests/fake-monaco-editor'))

const ROOT = '/Users/dev/acme'
const FILE = `${ROOT}/src/app.ts`

const disk = new Map<string, string>()
const writes: Array<{ path: string; content: string }> = []
const watchers: Array<{ path: string; cb: (event: FileWatchEvent) => void; stopped: boolean }> = []

;(window as unknown as { api: unknown }).api = new Proxy(
  {
    platform: 'darwin',
    readfile: async (path: string) => {
      const content = disk.get(path)
      if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`)
      return content
    },
    pathExists: async (path: string) => disk.has(path),
    writefile: async (path: string, content: string) => {
      writes.push({ path, content })
      disk.set(path, content)
    },
    readdir: async () => [],
    watchPath: async (path: string, cb: (event: FileWatchEvent) => void) => {
      const watcher = { path, cb, stopped: false }
      watchers.push(watcher)
      return async () => {
        watcher.stopped = true
      }
    },
    getGitRepoRoot: async () => null,
    checkIgnored: async () => [],
  } as Record<string, unknown>,
  {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => {} : async () => undefined
    },
  },
)

const { default: ExternalEditorWindow } = await import('./ExternalEditorWindow')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  disk.clear()
  writes.length = 0
  watchers.length = 0
  fakeMonaco.editors.length = 0
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  host?.remove()
  host = null
})

async function settle(ms = 30): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function openWindow(content: string): Promise<FakeMonacoEditor> {
  disk.set(FILE, content)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <ConfirmDialogProvider>
        <ExternalEditorWindow
          incoming={{ filePath: FILE, fileName: 'app.ts', workspaceId: 'ws-1', rootPath: ROOT }}
          nonce={1}
        />
      </ConfirmDialogProvider>,
    ),
  )
  await settle()
  const editor = fakeMonaco.editors.at(-1)
  assert.ok(editor, 'the editor mounted')
  return editor
}

async function agentTouchesFile(): Promise<void> {
  const watcher = watchers.find((candidate) => candidate.path === `${ROOT}/src` && !candidate.stopped)
  assert.ok(watcher, 'the file’s folder is watched')
  await act(async () => watcher.cb({ eventType: 'change', path: 'app.ts', paths: ['app.ts'] }))
  await settle(250)
}

async function pressSave(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', code: 'KeyS', metaKey: true }))
  })
  await settle()
}

function notice(): string | null {
  return document.querySelector('[role="status"]')?.textContent ?? null
}

function unsavedMark(): boolean {
  return document.querySelector('[aria-label="Unsaved changes"]') !== null
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent === label)
  assert.ok(found, `a "${label}" button`)
  return found as HTMLButtonElement
}

test('a clean tab takes an agent’s edit over the changed lines', async () => {
  const editor = await openWindow('alpha\nbeta\ngamma\n')
  disk.set(FILE, 'alpha\nBETA\ngamma\n')
  await agentTouchesFile()

  assert.equal(editor.text, 'alpha\nBETA\ngamma\n')
  assert.deepEqual(editor.edits, [[6, 10, 'BETA']])
  assert.equal(editor.fullReplaces, 0, 'never a whole-text replace')
  assert.equal(unsavedMark(), false)
  assert.equal(notice(), null)
})

test('a dirty tab asks; Keep mine, then ⌘S, writes the person’s version on purpose', async () => {
  const editor = await openWindow('a = 1\n')
  await act(async () => editor.type('a = 1 // mine\n'))
  disk.set(FILE, 'a = 2\n')
  await agentTouchesFile()

  assert.match(notice() ?? '', /Changed on disk/u)
  assert.equal(editor.text, 'a = 1 // mine\n')

  await act(async () => button('Keep mine').click())
  await settle()
  assert.equal(notice(), null)
  assert.equal(unsavedMark(), true, 'still unsaved')

  await pressSave()
  assert.deepEqual(writes, [{ path: FILE, content: 'a = 1 // mine\n' }])
  assert.equal(unsavedMark(), false)
})

test('Reload takes the version on disk over unsaved edits', async () => {
  const editor = await openWindow('a = 1\n')
  await act(async () => editor.type('a = 1 // mine\n'))
  disk.set(FILE, 'a = 2\n')
  await agentTouchesFile()

  await act(async () => button('Reload').click())
  await settle()
  assert.equal(editor.text, 'a = 2\n')
  assert.equal(unsavedMark(), false)
  assert.equal(notice(), null)
})

test('the window’s own save is not taken for an agent’s edit', async () => {
  const editor = await openWindow('n = 0\n')
  await act(async () => editor.type('n = 1\n'))
  await pressSave()
  await act(async () => editor.type('n = 1\nn += 1\n'))
  await agentTouchesFile()

  assert.equal(notice(), null)
  assert.equal(editor.text, 'n = 1\nn += 1\n')
  assert.equal(unsavedMark(), true)
})

test('⌘S on a clean tab writes nothing', async () => {
  await openWindow('n = 0\n')
  disk.set(FILE, 'n = 9\n')
  await pressSave()
  assert.deepEqual(writes, [])
  assert.equal(disk.get(FILE), 'n = 9\n')
})
