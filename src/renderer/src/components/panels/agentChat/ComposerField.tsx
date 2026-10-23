import React, { forwardRef, useImperativeHandle, useLayoutEffect, useReducer, useRef } from 'react'
import { history, historyKeymap, insertNewline, isolateHistory, standardKeymap } from '@codemirror/commands'
import {
  deleteMarkupBackward,
  insertNewlineContinueMarkup,
  markdown,
  markdownLanguage,
} from '@codemirror/lang-markdown'
import { Annotation, Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state'
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import { composerTextDirection } from './composerTextDirection'
import { markdownLivePreview } from './markdownLivePreview'

/**
 * The composer's field: a CodeMirror editor drawing its markdown in place (see
 * ./markdownLivePreview), in place of the `<textarea>` it used to be. The draft
 * is still one string — the editor changes how it is drawn and nothing else —
 * and the handle below is the slice of a textarea's surface the chat reads
 * (value, selection, focus), so the caret and selection arithmetic around the
 * composer did not have to learn a second shape.
 */
export type ComposerFieldHandle = {
  readonly value: string
  readonly selectionStart: number
  readonly selectionEnd: number
  focus(): void
  setSelectionRange(start: number, end: number): void
  getBoundingClientRect(): DOMRect
  /** Whether the caret sits on the field's first and last visual line, wraps
   *  included — where ArrowUp and ArrowDown leave the text for prompt recall. */
  visualEdges(): { firstLine: boolean; lastLine: boolean }
}

/**
 * A key pressed in the field, in the shape the composer's key handlers read.
 * It is what a React keyboard event on the old textarea carried, so the
 * handlers kept their bodies; `currentTarget` is the field's handle. `code`
 * is the physical key, which a rebindable chord matches on: with Alt held, or
 * on a layout that is not Latin, `key` names a character no binding spells.
 */
export type ComposerKeyEvent = {
  key: string
  code: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  repeat: boolean
  nativeEvent: KeyboardEvent
  currentTarget: ComposerFieldHandle
  preventDefault(): void
  stopPropagation(): void
}

type Props = {
  value: string
  /** The draft after an edit, and the caret after it. */
  onChange: (value: string, caret: number) => void
  onSelectionChange?: (caret: number) => void
  /** Runs before the editor's own keys; `preventDefault` keeps the key from it. */
  onKeyDown?: (event: ComposerKeyEvent) => void
  /** Runs before the editor pastes; `preventDefault` keeps the paste from it. */
  onPaste?: (event: ClipboardEvent, field: ComposerFieldHandle) => void
  onContextMenu?: (event: MouseEvent, field: ComposerFieldHandle) => void
  onBlur?: () => void
  /** A drop the field leaves to its host — files the composer types as paths or
   *  attaches. Left to the editor, a dropped file is read and typed as its text. */
  leavesDrop?: (dataTransfer: DataTransfer) => boolean
  placeholder?: string
  disabled?: boolean
  /** Attributes on the editable element: its accessible name, and the combobox
   *  wiring when a menu is open off the field. */
  contentAttributes?: Record<string, string | boolean | undefined>
  className?: string
  /** Whose draft the field holds (a conversation). A change starts the undo history again. */
  historyScope?: string
  /**
   * Read once, as the editor is made: words typed somewhere that stood in for
   * this field before it existed, with their caret and focus, which the editor
   * starts from instead of `value` and reports back through `onChange`.
   */
  adoptInput?: () => AdoptedComposerInput | null
}

/** What a stand-in field held when this one took its place. */
export type AdoptedComposerInput = {
  text: string
  selectionStart: number
  selectionEnd: number
  focused: boolean
}

// An edit that came in through `value` rather than from typing; the update
// listener must not hand it back as a change.
const fromProps = Annotation.define<boolean>()

// The field takes the composer's type and ink rather than an editor's: the
// body face at the body size, the textarea's 20px line, no gutters, no padding,
// and the native caret and selection. The markdown classes are index.css's.
// The host's `max-h-`/`min-h-` are the caller's; the editor takes them on
// itself, so the editor's own scroller is the one that scrolls and the editor
// keeps drawing only the lines in view. The floor is carried down to the
// editable element too: an editor's scroller is only as tall as its lines, so a
// three-row box with one line typed was the field for its first row alone, and
// a click below it put no caret anywhere.
const composerTheme = EditorView.theme({
  '&': {
    color: 'inherit',
    backgroundColor: 'transparent',
    fontSize: 'inherit',
    maxHeight: 'inherit',
    minHeight: 'inherit',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '20px',
    overflowX: 'hidden',
    overflowY: 'auto',
    minHeight: 'inherit',
  },
  '.cm-content': { padding: '0', caretColor: 'currentColor', minHeight: 'inherit' },
  '.cm-line': { padding: '0' },
  '.cm-placeholder': { color: 'var(--text-disabled)' },
})

function attributesOf(attributes: Props['contentAttributes']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(attributes ?? {})) if (value !== undefined) out[name] = String(value)
  return out
}

export const ComposerField = forwardRef<ComposerFieldHandle, Props>(function ComposerField(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [, recheck] = useReducer((count: number) => count + 1, 0)
  // Set from an edit reported through `onChange` until the next render: the
  // `value` that render carries is the host's answer to that edit.
  const answeringRef = useRef(false)
  const viewRef = useRef<EditorView | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props
  // The value the editor last held, so a render that passes the same draft
  // back does not read the document out to compare.
  const heldRef = useRef(props.value)
  // The `value` an adopted text replaced, until the host has re-rendered with
  // the adopted text: in the mount's own commit the prop still says the old
  // draft, and syncing to it would wipe the words and drop the caret.
  const supersededRef = useRef<string | null>(null)
  const compartments = useRef({
    placeholder: new Compartment(),
    editable: new Compartment(),
    attributes: new Compartment(),
    history: new Compartment(),
  })

  const handleRef = useRef<ComposerFieldHandle | null>(null)
  if (!handleRef.current) {
    const view = () => viewRef.current
    handleRef.current = {
      get value() {
        return view()?.state.doc.toString() ?? heldRef.current
      },
      get selectionStart() {
        return view()?.state.selection.main.from ?? 0
      },
      get selectionEnd() {
        return view()?.state.selection.main.to ?? 0
      },
      focus: () => view()?.focus(),
      setSelectionRange(start, end) {
        const editor = view()
        if (!editor) return
        const length = editor.state.doc.length
        const clamp = (pos: number) => Math.max(0, Math.min(length, pos))
        editor.dispatch({ selection: EditorSelection.single(clamp(start), clamp(end)), scrollIntoView: true })
      },
      getBoundingClientRect: () => view()?.dom.getBoundingClientRect() ?? new DOMRect(),
      visualEdges() {
        const editor = view()
        if (!editor) return { firstLine: true, lastLine: true }
        const { state } = editor
        const caret = state.selection.main
        if (!caret.empty) return { firstLine: false, lastLine: false }
        if (state.doc.length === 0) return { firstLine: true, lastLine: true }
        const at = editor.coordsAtPos(caret.head)
        const first = editor.coordsAtPos(0)
        const last = editor.coordsAtPos(state.doc.length)
        if (!at || !first || !last) {
          // Not laid out: the logical lines are the closest answer.
          const line = state.doc.lineAt(caret.head).number
          return { firstLine: line === 1, lastLine: line === state.doc.lines }
        }
        // Compared at the caret's middle, not its top: a line holding inline
        // code or a heading mixes glyph heights, and visual lines never overlap.
        const middle = (at.top + at.bottom) / 2
        return { firstLine: middle < first.bottom, lastLine: middle > last.top }
      },
    }
  }
  useImperativeHandle(ref, () => handleRef.current!, [])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const field = handleRef.current!
    const { placeholder, editable, attributes, history: undoHistory } = compartments.current
    const initial = propsRef.current
    // Taken in this same commit, so the stand-in goes as the editor arrives.
    const adopted = initial.adoptInput?.() ?? null
    const doc = adopted ? adopted.text : initial.value
    const clamp = (pos: number) => Math.max(0, Math.min(doc.length, pos))
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: adopted
          ? EditorSelection.single(clamp(adopted.selectionStart), clamp(adopted.selectionEnd))
          : EditorSelection.cursor(doc.length),
        extensions: [
          Prec.highest(
            EditorView.domEventHandlers({
              keydown(event) {
                const onKeyDown = propsRef.current.onKeyDown
                if (!onKeyDown) return false
                onKeyDown({
                  key: event.key,
                  code: event.code,
                  altKey: event.altKey,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  shiftKey: event.shiftKey,
                  repeat: event.repeat,
                  nativeEvent: event,
                  currentTarget: field,
                  preventDefault: () => event.preventDefault(),
                  stopPropagation: () => event.stopPropagation(),
                })
                return event.defaultPrevented
              },
              paste(event) {
                propsRef.current.onPaste?.(event, field)
                return event.defaultPrevented
              },
              contextmenu(event) {
                const onContextMenu = propsRef.current.onContextMenu
                if (!onContextMenu) return false
                onContextMenu(event, field)
                return true
              },
              drop(event) {
                const transfer = event.dataTransfer
                return Boolean(transfer && propsRef.current.leavesDrop?.(transfer))
              },
              blur() {
                propsRef.current.onBlur?.()
                return false
              },
            }),
          ),
          undoHistory.of(history()),
          // Enter is the composer's (send); Shift+Enter is the newline, and it
          // carries a list or quote on to the next line the way a markdown
          // editor does. Backspace at a bare list marker takes the marker.
          keymap.of([
            { key: 'Shift-Enter', run: (editor) => insertNewlineContinueMarkup(editor) || insertNewline(editor) },
            { key: 'Backspace', run: deleteMarkupBackward },
            ...historyKeymap,
            ...standardKeymap,
          ]),
          markdown({ base: markdownLanguage, addKeymap: false, completeHTMLTags: false }),
          EditorView.lineWrapping,
          markdownLivePreview,
          composerTextDirection,
          composerTheme,
          EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'on' }),
          placeholder.of(placeholderExtension(initial.placeholder ?? '')),
          editable.of([EditorView.editable.of(!initial.disabled), EditorState.readOnly.of(Boolean(initial.disabled))]),
          attributes.of(EditorView.contentAttributes.of(attributesOf(initial.contentAttributes))),
          EditorView.updateListener.of((update) => {
            const caret = update.state.selection.main.head
            if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromProps))) {
              const value = update.state.doc.toString()
              heldRef.current = value
              answeringRef.current = true
              propsRef.current.onChange(value, caret)
              // Rendered again whatever the host does, so the check below
              // sees a host that kept less and handed back the value it had —
              // which, set into state, renders nothing.
              recheck()
            } else if (update.selectionSet) propsRef.current.onSelectionChange?.(caret)
          }),
        ],
      }),
    })
    viewRef.current = view
    heldRef.current = doc
    if (adopted) {
      if (adopted.focused) view.focus()
      if (doc !== initial.value) {
        supersededRef.current = initial.value
        initial.onChange(doc, view.state.selection.main.head)
      }
    }
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // A draft set from outside — sent and cleared, recalled, restored, rewritten
  // by a pick from the @ or / menu — replaces the document. The caret goes to
  // its end, where a textarea given a new value puts it; a caller that wants it
  // elsewhere sets it after.
  //
  // A replacement is one step to undo, so ⌘Z takes back a menu's Paste or an @
  // pick as it would a keystroke. A draft cleared (sent) starts the history
  // again: ⌘Z must not bring back a message that was already sent. The history
  // is taken out for the clearing and put back fresh after it, so neither the
  // edits before nor the clearing itself is there to undo.
  //
  // Checked on every render, not only when `value` changes: a host may keep
  // less than was typed (a draft at its length cap), even handing back the
  // value it already had, and the field must not go on showing words the
  // draft does not hold. A host's answer to an edit is put right where it
  // stands — the tail cut, the caret left where it was — and is no step of
  // its own to undo back into.
  const { value, historyScope } = props
  useLayoutEffect(() => {
    const view = viewRef.current
    const superseded = supersededRef.current
    supersededRef.current = null
    const answering = answeringRef.current
    answeringRef.current = false
    if (!view || value === heldRef.current || value === superseded) return
    heldRef.current = value
    const doc = view.state.doc.toString()
    if (doc === value) return
    if (answering) {
      const length = value.length
      const kept = doc.startsWith(value)
      view.dispatch({
        changes: kept ? { from: length, to: doc.length } : { from: 0, to: doc.length, insert: value },
        ...(kept
          ? {}
          : {
              selection: EditorSelection.single(
                Math.min(view.state.selection.main.anchor, length),
                Math.min(view.state.selection.main.head, length),
              ),
            }),
        annotations: [fromProps.of(true), Transaction.addToHistory.of(false)],
      })
      return
    }
    const cleared = value === ''
    const { history: undoHistory } = compartments.current
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: EditorSelection.cursor(value.length),
      // A step of its own: typing straight after it is not merged into it.
      annotations: [fromProps.of(true), isolateHistory.of('full')],
      ...(cleared ? { effects: undoHistory.reconfigure([]) } : {}),
    })
    if (cleared) view.dispatch({ effects: undoHistory.reconfigure(history()) })
  })

  // Another conversation's draft in the same field starts the history again
  // too, whatever the two drafts hold: one chat's edits are not the next's to
  // undo. Runs after the draft above has been swapped in.
  const scopeRef = useRef(historyScope)
  useLayoutEffect(() => {
    const view = viewRef.current
    if (!view || scopeRef.current === historyScope) return
    scopeRef.current = historyScope
    const { history: undoHistory } = compartments.current
    view.dispatch({ effects: undoHistory.reconfigure([]) })
    view.dispatch({ effects: undoHistory.reconfigure(history()) })
  }, [historyScope])

  const { placeholder, disabled, contentAttributes } = props
  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.placeholder.reconfigure(placeholderExtension(placeholder ?? '')),
    })
  }, [placeholder])
  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.editable.reconfigure([
        EditorView.editable.of(!disabled),
        EditorState.readOnly.of(Boolean(disabled)),
      ]),
    })
  }, [disabled])
  const attributeKey = JSON.stringify(attributesOf(contentAttributes))
  useLayoutEffect(() => {
    viewRef.current?.dispatch({
      effects: compartments.current.attributes.reconfigure(
        EditorView.contentAttributes.of(JSON.parse(attributeKey) as Record<string, string>),
      ),
    })
  }, [attributeKey])

  return (
    <div
      ref={hostRef}
      data-composer-field=""
      aria-disabled={disabled || undefined}
      className={`composer-markdown ${disabled ? 'cursor-not-allowed opacity-45' : ''} ${props.className ?? ''}`}
    />
  )
})
