// A stand-in for `@monaco-editor/react`'s editor, for suites that render an
// editor surface in jsdom. Monaco itself needs a canvas and workers.
//
// The editor is a plain string, and it behaves like the wrapper where an
// editor surface depends on it: a `value` prop that differs from the model
// replaces the whole text and fires no onChange; typing, or an edit pushed
// onto the model, fires onChange. Install it with
// `vi.mock('@monaco-editor/react', () => import('<path>/tests/fake-monaco-editor'))`.
import { createElement, useEffect, useRef } from 'react'

export type FakeMonacoEditor = {
  text: string
  /** Whole-text replacements the wrapper made from the `value` prop. */
  fullReplaces: number
  /** Edits pushed onto the model, as [start offset, end offset, text]. */
  edits: Array<[number, number, string]>
  commands: Array<{ keybinding: number; run: () => unknown }>
  disposed: boolean
  /** The person types: the whole text becomes `next`. */
  type(next: string): void
}

/** Every editor mounted so far, newest last, and the key codes the fake hands `onMount`. */
export const fakeMonaco = {
  editors: [] as FakeMonacoEditor[],
  CTRL_CMD: 2048,
  KEY_S: 49,
}

type Props = {
  value?: string
  onChange?: (value: string | undefined) => void
  onMount?: (editor: unknown, monaco: unknown) => void
}

type EditRange = { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }

const disposable = { dispose() {} }

function offsetAt(text: string, lineNumber: number, column: number): number {
  const lines = text.split('\n')
  let offset = 0
  for (let line = 1; line < lineNumber; line++) offset += lines[line - 1].length + 1
  return offset + column - 1
}

function createEditor(initial: string, onChange: (value: string) => void) {
  const disposeListeners: Array<() => void> = []
  const model = {
    getValue: () => editor.text,
    getPositionAt(offset: number) {
      const before = editor.text.slice(0, offset).split('\n')
      return { lineNumber: before.length, column: before[before.length - 1].length + 1 }
    },
    pushStackElement() {},
    pushEditOperations(_selections: unknown, operations: Array<{ range: EditRange; text: string }>) {
      for (const { range, text } of operations) {
        const start = offsetAt(editor.text, range.startLineNumber, range.startColumn)
        const end = offsetAt(editor.text, range.endLineNumber, range.endColumn)
        editor.edits.push([start, end, text])
        editor.text = editor.text.slice(0, start) + text + editor.text.slice(end)
      }
      // The wrapper calls onChange for any model edit it did not make itself.
      onChange(editor.text)
      return null
    },
  }
  const editor: FakeMonacoEditor & Record<string, unknown> = {
    text: initial,
    fullReplaces: 0,
    edits: [],
    commands: [],
    disposed: false,
    type(next: string) {
      editor.text = next
      onChange(next)
    },
    dispose() {
      editor.disposed = true
      disposeListeners.forEach((listener) => listener())
    },
    getModel: () => (editor.disposed ? null : model),
    getSelections: () => [],
    getScrollTop: () => 0,
    getScrollLeft: () => 0,
    setScrollTop() {},
    setScrollLeft() {},
    focus() {},
    getLayoutInfo: () => ({ height: 0 }),
    onDidLayoutChange: () => disposable,
    onKeyDown: () => disposable,
    onDidFocusEditorText: () => disposable,
    onDidDispose(listener: () => void) {
      disposeListeners.push(listener)
      return disposable
    },
    createDecorationsCollection: () => ({ clear() {}, set() {} }),
    addCommand(keybinding: number, run: () => unknown) {
      editor.commands.push({ keybinding, run })
    },
  }
  return editor
}

export default function FakeMonacoEditorComponent(props: Props) {
  const editorRef = useRef<ReturnType<typeof createEditor> | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  useEffect(() => {
    const editor = createEditor(props.value ?? '', (value) => propsRef.current.onChange?.(value))
    editorRef.current = editor
    fakeMonaco.editors.push(editor)
    props.onMount?.(editor, {
      KeyMod: { CtrlCmd: fakeMonaco.CTRL_CMD },
      KeyCode: { KeyS: fakeMonaco.KEY_S },
      editor: { remeasureFonts() {} },
    })
    return () => (editor.dispose as () => void)()
    // Mount once, like the wrapper: later props reach the editor through propsRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || props.value === undefined || props.value === editor.text) return
    editor.text = props.value
    editor.fullReplaces += 1
  }, [props.value])
  return createElement('div', { 'data-fake-monaco': '' })
}
