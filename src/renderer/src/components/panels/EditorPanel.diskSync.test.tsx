// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { FileWatchEvent } from '../../../../shared/ipc/filesystem'
import type { LayoutTemplate } from '../../types/workspace'

// The docked editor against a file on disk that something else changes: an
// agent's edit reloads a clean tab, asks before it touches a dirty one, and
// ⌘S never writes back a copy older than what is there.
//
// Monaco needs a canvas and workers, so the wrapper is stood in for by an
// editor over a plain string. It behaves like `@monaco-editor/react` where
// that matters here: a `value` prop that differs from the model replaces the
// whole text (and fires no onChange), a person typing fires onChange.

type Listener = () => void
type FakeEditor = {
  text: string
  /** Whole-text replacements the wrapper made from the `value` prop. */
  fullReplaces: number
  /** Edits pushed onto the model, as [start offset, end offset, text]. */
  edits: Array<[number, number, string]>
  commands: Array<{ keybinding: number; run: () => unknown }>
  type(next: string): void
}

const fake = vi.hoisted(() => ({
  editors: [] as FakeEditor[],
  KEY_S: 49,
  CTRL_CMD: 2048,
}))

vi.mock('@monaco-editor/react', async () => {
  const ReactModule = await import('react')
  type Props = {
    value?: string
    onChange?: (value: string | undefined) => void
    onMount?: (editor: unknown, monaco: unknown) => void
  }
  const disposable = { dispose() {} }
  function createEditor(initial: string, onUserChange: (value: string) => void) {
    const contentListeners = new Set<Listener>()
    const fire = () => contentListeners.forEach((listener) => listener())
    const offsetAt = (text: string, lineNumber: number, column: number): number => {
      const lines = text.split('\n')
      let offset = 0
      for (let line = 1; line < lineNumber; line++) offset += lines[line - 1].length + 1
      return offset + column - 1
    }
    const editor: FakeEditor & Record<string, unknown> = {
      text: initial,
      fullReplaces: 0,
      edits: [],
      commands: [],
      type(next: string) {
        editor.text = next
        fire()
        onUserChange(next)
      },
      getModel: () => model,
      getSelections: () => [],
      getScrollTop: () => 0,
      getScrollLeft: () => 0,
      setScrollTop() {},
      setScrollLeft() {},
      getLayoutInfo: () => ({ height: 0 }),
      onDidLayoutChange: () => disposable,
      onKeyDown: () => disposable,
      onDidFocusEditorText: () => disposable,
      onDidDispose: () => disposable,
      createDecorationsCollection: () => ({ clear() {}, set() {} }),
      addCommand(keybinding: number, run: () => unknown) {
        editor.commands.push({ keybinding, run })
      },
    }
    const model = {
      getValue: () => editor.text,
      getPositionAt(offset: number) {
        const before = editor.text.slice(0, offset).split('\n')
        return { lineNumber: before.length, column: before[before.length - 1].length + 1 }
      },
      pushStackElement() {},
      pushEditOperations(
        _selections: unknown,
        operations: Array<{
          range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
          text: string
        }>,
      ) {
        for (const { range, text } of operations) {
          const start = offsetAt(editor.text, range.startLineNumber, range.startColumn)
          const end = offsetAt(editor.text, range.endLineNumber, range.endColumn)
          editor.edits.push([start, end, text])
          editor.text = editor.text.slice(0, start) + text + editor.text.slice(end)
        }
        // The real wrapper calls onChange for any model edit it did not make.
        fire()
        onUserChange(editor.text)
        return null
      },
    }
    return editor
  }

  function FakeMonacoEditor(props: Props) {
    const editorRef = ReactModule.useRef<FakeEditor | null>(null)
    const propsRef = ReactModule.useRef(props)
    propsRef.current = props
    ReactModule.useEffect(() => {
      const editor = createEditor(props.value ?? '', (value) => propsRef.current.onChange?.(value))
      editorRef.current = editor
      fake.editors.push(editor)
      props.onMount?.(editor, {
        KeyMod: { CtrlCmd: fake.CTRL_CMD },
        KeyCode: { KeyS: fake.KEY_S },
        editor: { remeasureFonts() {} },
      })
    }, [])
    ReactModule.useEffect(() => {
      const editor = editorRef.current
      if (!editor || props.value === undefined || props.value === editor.text) return
      editor.text = props.value
      editor.fullReplaces += 1
    }, [props.value])
    return ReactModule.createElement('div', { 'data-fake-monaco': '' })
  }
  return { default: FakeMonacoEditor }
})

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
