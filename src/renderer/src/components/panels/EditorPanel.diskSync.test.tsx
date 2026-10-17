// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { FileWatchEvent } from '../../../../shared/ipc/filesystem'
import { fakeMonaco as fake, type FakeMonacoEditor as FakeEditor } from '../../../../../tests/fake-monaco-editor'
import type { LayoutTemplate } from '../../types/workspace'

// The docked editor against a file on disk that something else changes: an
// agent's edit reloads a clean tab, asks before it touches a dirty one, and
// ⌘S never writes back a copy older than what is there.

// Monaco is the jsdom stand-in (tests/fake-monaco-editor.ts): an editor over
// a plain string that answers a new `value` prop the way the wrapper does.
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
    pathExists: async (path: string) => disk.has(path) || [...disk.keys()].some((key) => key.startsWith(`${path}/`)),
    writefile: async (path: string, content: string) => {
      writes.push({ path, content })
      disk.set(path, content)
    },
    watchPath: async (path: string, cb: (event: FileWatchEvent) => void) => {
      const watcher = { path, cb, stopped: false }
      watchers.push(watcher)
      return async () => {
        watcher.stopped = true
      }
    },
    getGitRepoRoot: async () => null,
    workspaceSyncDispatch: async () => ({ ok: true }),
  } as Record<string, unknown>,
  {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => {} : async () => undefined
    },
  },
)

const { default: EditorPanel } = await import('./EditorPanel')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
const { useWorkspaceStore } = await import('../../store/workspaceStore')
const { getEditorBuffer } = await import('../../utils/editorBuffers')

const template: LayoutTemplate = {
  id: 'editor-disk-test',
  name: 'Editor',
  description: 'Editor disk sync test template',
  previewSlots: [],
  layout: {
    global: {},
    borders: [],
    layout: { type: 'row', children: [{ type: 'tabset', weight: 100, children: [] }] },
  },
}

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeEach(() => {
  disk.clear()
  writes.length = 0
  watchers.length = 0
  fake.editors.length = 0
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

async function mountEditor(content: string): Promise<{ workspaceId: string; editor: FakeEditor }> {
  disk.set(FILE, content)
  const store = useWorkspaceStore.getState()
  const workspaceId = store.addWorkspace(template, { name: 'Acme', folderPath: ROOT })
  store.openFile(workspaceId, FILE, 'app.ts', content)

  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <ConfirmDialogProvider>
        <EditorPanel workspaceId={workspaceId} filePath={FILE} />
      </ConfirmDialogProvider>,
    ),
  )
  await settle()
  const editor = fake.editors.at(-1)
  assert.ok(editor, 'the editor mounted')
  return { workspaceId, editor }
}

async function pressSave(editor: FakeEditor): Promise<void> {
  const save = editor.commands.find((command) => command.keybinding === (fake.CTRL_CMD | fake.KEY_S))
  assert.ok(save, 'the editor binds ⌘S')
  await act(async () => {
    await save.run()
  })
  await settle()
}

function isDirty(workspaceId: string): boolean {
  const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspaceId)
  return Boolean(workspace?.editorState?.openFiles.find((file) => file.path === FILE)?.isDirty)
}

test('⌘S on a clean buffer writes nothing, so an agent’s newer copy on disk survives', async () => {
  const { workspaceId, editor } = await mountEditor('export const answer = 41\n')
  // An agent rewrites the file; the person, who has not typed, presses ⌘S.
  disk.set(FILE, 'export const answer = 42\n')
  await pressSave(editor)

  assert.deepEqual(writes, [], 'nothing was written')
  assert.equal(disk.get(FILE), 'export const answer = 42\n', 'the agent’s version is still on disk')
  assert.equal(isDirty(workspaceId), false)
})

test('⌘S on a dirty buffer writes it and marks the tab clean', async () => {
  const { workspaceId, editor } = await mountEditor('export const answer = 41\n')
  await act(async () => editor.type('export const answer = 43\n'))
  assert.equal(isDirty(workspaceId), true)
  await pressSave(editor)

  assert.deepEqual(writes, [{ path: FILE, content: 'export const answer = 43\n' }])
  assert.equal(isDirty(workspaceId), false)
  assert.equal(getEditorBuffer(workspaceId, FILE), 'export const answer = 43\n')
})

const AGENT_EVENT: FileWatchEvent = { eventType: 'change', path: 'app.ts', paths: ['app.ts'] }

/** The folder watch says app.ts changed; long enough for the debounce and the re-read. */
async function agentTouchesFile(): Promise<void> {
  const watcher = watchers.find((candidate) => candidate.path === `${ROOT}/src` && !candidate.stopped)
  assert.ok(watcher, 'the file’s folder is watched')
  await act(async () => watcher.cb(AGENT_EVENT))
  await settle(250)
}

function noticeTitle(): string | null {
  const notice = document.querySelector('[role="status"]')
  return notice?.textContent ?? null
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.textContent === label)
  assert.ok(found, `a "${label}" button`)
  return found as HTMLButtonElement
}

test('a clean tab takes an agent’s edit as an edit over the changed lines, not a whole-file replace', async () => {
  const { workspaceId, editor } = await mountEditor('line one\nline two\nline three\n')
  disk.set(FILE, 'line one\nline 2\nline three\n')
  await agentTouchesFile()

  assert.equal(editor.text, 'line one\nline 2\nline three\n', 'the editor shows the new text')
  assert.equal(getEditorBuffer(workspaceId, FILE), 'line one\nline 2\nline three\n')
  assert.deepEqual(editor.edits, [[14, 17, '2']], 'one edit, over the word that changed')
  assert.equal(editor.fullReplaces, 0, 'the wrapper never replaced the whole text, so the caret did not jump')
  assert.equal(isDirty(workspaceId), false, 'a reload is not an unsaved edit')
  assert.equal(noticeTitle(), null, 'and nothing to ask about')
  assert.deepEqual(writes, [])
})

test('a dirty tab asks: Changed on disk, and Reload takes the version on disk', async () => {
  const { workspaceId, editor } = await mountEditor('const a = 1\n')
  await act(async () => editor.type('const a = 1 // mine\n'))
  disk.set(FILE, 'const a = 2\n')
  await agentTouchesFile()

  assert.match(noticeTitle() ?? '', /Changed on disk/u)
  assert.equal(editor.text, 'const a = 1 // mine\n', 'the person’s edits are untouched until they choose')
  assert.equal(isDirty(workspaceId), true)

  await act(async () => button('Reload').click())
  await settle()
  assert.equal(editor.text, 'const a = 2\n')
  assert.equal(getEditorBuffer(workspaceId, FILE), 'const a = 2\n')
  assert.equal(isDirty(workspaceId), false)
  assert.equal(noticeTitle(), null)
})

test('Keep mine leaves the edits, and the next save writes them over the agent’s', async () => {
  const { workspaceId, editor } = await mountEditor('const a = 1\n')
  await act(async () => editor.type('const a = 1 // mine\n'))
  disk.set(FILE, 'const a = 2\n')
  await agentTouchesFile()

  await act(async () => button('Keep mine').click())
  await settle()
  assert.equal(noticeTitle(), null, 'the notice goes')
  assert.equal(editor.text, 'const a = 1 // mine\n')
  assert.equal(isDirty(workspaceId), true, 'still unsaved')

  await pressSave(editor)
  assert.deepEqual(writes, [{ path: FILE, content: 'const a = 1 // mine\n' }])
  assert.equal(isDirty(workspaceId), false)
})

test('the watch event a save causes is the tab’s own, even when typing went on after it', async () => {
  const { workspaceId, editor } = await mountEditor('let n = 0\n')
  await act(async () => editor.type('let n = 1\n'))
  await pressSave(editor)
  await act(async () => editor.type('let n = 1\nn++\n'))
  await agentTouchesFile()

  assert.equal(noticeTitle(), null, 'no notice for Studio’s own write')
  assert.equal(editor.text, 'let n = 1\nn++\n', 'and nothing typed since is taken away')
  assert.equal(isDirty(workspaceId), true)
})

test('a file deleted on disk says so and keeps the text', async () => {
  const { workspaceId, editor } = await mountEditor('keep me\n')
  disk.delete(FILE)
  await agentTouchesFile()

  assert.match(noticeTitle() ?? '', /Deleted on disk/u)
  assert.equal(editor.text, 'keep me\n')
  assert.equal(getEditorBuffer(workspaceId, FILE), 'keep me\n')
})

test('closing the tab closes the folder watch', async () => {
  await mountEditor('x\n')
  const watcher = watchers.find((candidate) => candidate.path === `${ROOT}/src`)
  assert.ok(watcher && !watcher.stopped)
  await act(async () => root?.unmount())
  root = null
  await settle()
  assert.equal(watcher.stopped, true)
})

test('a save over a version on disk the tab never showed asks first', async () => {
  const { workspaceId, editor } = await mountEditor('v1\n')
  await act(async () => editor.type('v1 mine\n'))
  // Changed on disk with no watch event to say so — as in an SSH machine's
  // folder, which main does not watch.
  disk.set(FILE, 'v2 agent\n')
  const save = editor.commands.find((command) => command.keybinding === (fake.CTRL_CMD | fake.KEY_S))
  assert.ok(save)

  await act(async () => {
    void save.run()
  })
  await settle()
  assert.ok(button('Overwrite'), 'the save asks')
  await act(async () => button('Cancel').click())
  await settle()
  assert.deepEqual(writes, [], 'cancelled: nothing written')
  assert.equal(disk.get(FILE), 'v2 agent\n')
  assert.match(noticeTitle() ?? '', /Changed on disk/u, 'and the tab says why')
  assert.equal(isDirty(workspaceId), true)

  await act(async () => {
    void save.run()
  })
  await settle()
  await act(async () => button('Overwrite').click())
  await settle()
  assert.deepEqual(writes, [{ path: FILE, content: 'v1 mine\n' }], 'confirmed: written on purpose')
  assert.equal(isDirty(workspaceId), false)
})
