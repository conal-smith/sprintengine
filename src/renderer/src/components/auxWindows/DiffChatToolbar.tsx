import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type * as Monaco from 'monaco-editor'

import { GhostButton, Input } from '../ui'
import { OVERLAY_SURFACE_CLASS } from '../ui/tokens'
import { placeQuoteToolbar, type SelectionAnchor } from '../panels/agentChat/quoteSelection'
import type { DiffChatSelection } from './diffToChat'

// "Add to chat" over a selection in the diff: lines selected on either side
// raise a small toolbar under them, with a field for what to ask about them
// and the button that sends them to the workspace's chat (diffToChat.ts). The
// chat's own quote toolbar is the model: it follows its selection, goes when
// the selection does, and keeps the selection when pressed.
//
// The diff's Monaco menu is off (diffToolbarModel), so this is how the action
// is found. `Add selection to chat` is also a Monaco action, which the
// editor's own command list (F1) and ⌘⇧A reach: both put the keyboard in the
// field, ready for a note or Enter.

type SideEditor = Monaco.editor.ICodeEditor

export type DiffChatSend = (selection: DiffChatSelection, note: string) => Promise<boolean>

type Shown = { selection: DiffChatSelection; anchor: SelectionAnchor }

/** The selection on one side of the diff, as the lines it covers; null when nothing is selected. */
export function readDiffSelection(
  editor: SideEditor,
  side: DiffChatSelection['side'],
  path: string,
): DiffChatSelection | null {
  const selection = editor.getSelection()
  const model = editor.getModel()
  if (!selection || !model || selection.isEmpty()) return null
  const code = model.getValueInRange(selection)
  if (!code.trim()) return null
  // A selection that ends at the start of a line covers the line above it,
  // which is how a whole-line drag reads.
  const endLine =
    selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? selection.endLineNumber - 1
      : selection.endLineNumber
  return {
    path,
    side,
    startLine: selection.startLineNumber,
    endLine,
    code,
    language: model.getLanguageId(),
  }
}

function anchorOf(editor: SideEditor): SelectionAnchor | null {
  const selection = editor.getSelection()
  const node = editor.getDomNode()
  if (!selection || !node) return null
  const model = editor.getModel()
  // A whole-line selection ends at the start of the next line; the toolbar
  // stands under the last line it covers, at that line's end.
  const last =
    model && selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? { lineNumber: selection.endLineNumber - 1, column: model.getLineMaxColumn(selection.endLineNumber - 1) }
      : selection.getEndPosition()
  const start = editor.getScrolledVisiblePosition(selection.getStartPosition())
  const end = editor.getScrolledVisiblePosition(last)
  if (!start || !end) return null
  const box = node.getBoundingClientRect()
  const top = box.top + start.top
  const bottom = box.top + end.top + end.height
  // Scrolled out of the editor: nothing to stand under.
  if (bottom < box.top || top > box.bottom) return null
  return { left: box.left + start.left, right: box.left + end.left, top, bottom: Math.min(bottom, box.bottom) }
}

export function DiffChatToolbar({
  diffEditor,
  path,
  onSend,
  focusRequest,
}: {
  diffEditor: Monaco.editor.IStandaloneDiffEditor | null
  /** The file on screen, relative to the repository; null with none. */
  path: string | null
  onSend: DiffChatSend
  /** Changes when the Monaco action asks for the field. */
  focusRequest: number
}) {
  const [shown, setShown] = useState<Shown | null>(null)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const read = useCallback((): Shown | null => {
    if (!diffEditor || !path) return null
    const sides: [SideEditor, DiffChatSelection['side']][] = [
      [diffEditor.getModifiedEditor(), 'modified'],
      [diffEditor.getOriginalEditor(), 'original'],
    ]
    // The side that has the keyboard, else the one holding a selection.
    sides.sort(([a], [b]) => Number(b.hasTextFocus()) - Number(a.hasTextFocus()))
    for (const [editor, side] of sides) {
      const selection = readDiffSelection(editor, side, path)
      const anchor = selection ? anchorOf(editor) : null
      if (selection && anchor) return { selection, anchor }
    }
    return null
  }, [diffEditor, path])

  useEffect(() => {
    if (!diffEditor) {
      setShown(null)
      return
    }
    let frame = 0
    const schedule = () => {
      if (!frame)
        frame = window.requestAnimationFrame(() => {
          frame = 0
          setShown(read())
        })
    }
    const editors = [diffEditor.getModifiedEditor(), diffEditor.getOriginalEditor()]
    const subscriptions = editors.flatMap((editor) => [
      editor.onDidChangeCursorSelection(schedule),
      editor.onDidScrollChange(schedule),
      editor.onDidLayoutChange(schedule),
    ])
    schedule()
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      for (const subscription of subscriptions) subscription.dispose()
    }
  }, [diffEditor, read])

  // A new selection starts a new note.
  const selectionKey = shown
    ? `${shown.selection.path}:${shown.selection.side}:${shown.selection.startLine}-${shown.selection.endLine}`
    : ''
  useEffect(() => setNote(''), [selectionKey])

  useEffect(() => {
    if (!focusRequest) return
    const next = read()
    setShown(next)
    if (next) window.requestAnimationFrame(() => inputRef.current?.focus())
  }, [focusRequest, read])

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar || !shown) return
    const rect = toolbar.getBoundingClientRect()
    const place = placeQuoteToolbar(
      shown.anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    )
    toolbar.style.left = `${place.left}px`
    toolbar.style.top = `${place.top}px`
  }, [shown])

  const send = async () => {
    if (!shown || sending) return
    setSending(true)
    try {
      if (await onSend(shown.selection, note)) setNote('')
    } finally {
      setSending(false)
    }
  }

  if (!shown) return null
  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Selected lines"
      data-diff-chat-toolbar=""
      className={`fixed z-[var(--z-popover)] flex items-center gap-1 p-1 ${OVERLAY_SURFACE_CLASS}`}
      style={{ left: shown.anchor.right, top: shown.anchor.bottom }}
    >
      <Input
        ref={inputRef}
        size="xs"
        variant="quiet"
        fullWidth={false}
        className="w-[16rem]"
        aria-label="Ask the agent about these lines"
        placeholder="Ask the agent about this…"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setShown(null)
          }
        }}
      />
      <GhostButton
        size="xs"
        disabled={sending}
        // Keep the selection: a press that took focus would not lose it in
        // Monaco, but the field's focus would.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void send()}
      >
        Add to chat
      </GhostButton>
    </div>,
    document.body,
  )
}
