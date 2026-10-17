import type * as Monaco from 'monaco-editor'

/**
 * What an editor tab does when the file under it changes on disk, shared by
 * the docked editor and the pop-out editor window.
 *
 * Every decision is made on content, not on timestamps: the text last read
 * from or written to disk (the baseline), the text in the buffer, and the text
 * on disk now. That is what lets a tab tell its own save apart from an agent's
 * edit without asking main for an mtime — the file holds exactly what the tab
 * wrote — and it works the same for a remote folder, whose files are read
 * through the same `readfile`.
 */

export type DiskRead =
  | { kind: 'content'; content: string }
  /** Gone from disk: deleted, or renamed away. */
  | { kind: 'missing' }
  /** There, but could not be read just now (mid-write, permissions). Not a reason to say anything. */
  | { kind: 'unreadable' }

export type DiskReadApi = {
  readfile(path: string): Promise<string>
  pathExists?(path: string): Promise<boolean>
}

export async function readFileOnDisk(api: DiskReadApi, path: string): Promise<DiskRead> {
  try {
    return { kind: 'content', content: await api.readfile(path) }
  } catch {
    try {
      if (typeof api.pathExists === 'function' && !(await api.pathExists(path))) return { kind: 'missing' }
    } catch {
      // Asking failed as well: say nothing rather than guess.
    }
    return { kind: 'unreadable' }
  }
}

export type DiskChange =
  /** Disk holds what the buffer holds: the tab's own save, or the same edit made twice. */
  | 'in-sync'
  /** Disk still holds the baseline; whatever fired the watch did not change this file. */
  | 'unchanged'
  /** The buffer has no edits of its own: take what is on disk. */
  | 'reload'
  /** Disk moved and so did the buffer: ask the person which to keep. */
  | 'conflict'

export function classifyDiskChange(input: {
  disk: string
  buffer: string
  /** What the tab last read from or wrote to disk; undefined when it never recorded one. */
  baseline: string | undefined
  dirty: boolean
}): DiskChange {
  if (input.disk === input.buffer) return 'in-sync'
  if (!input.dirty) return 'reload'
  if (input.baseline !== undefined && input.disk === input.baseline) return 'unchanged'
  return 'conflict'
}

/**
 * The one stretch where `current` and `next` differ, as offsets into each.
 * Never splits a surrogate pair or a CRLF, so the offsets are always ones a
 * Monaco model can land on.
 */
export function changedSpan(
  current: string,
  next: string,
): { start: number; currentEnd: number; nextEnd: number } | null {
  if (current === next) return null
  const shorter = Math.min(current.length, next.length)
  let start = 0
  while (start < shorter && current.charCodeAt(start) === next.charCodeAt(start)) start++
  while (start > 0 && splitsPair(current, start)) start--
  let suffix = 0
  while (
    suffix < shorter - start &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix++
  }
  while (suffix > 0 && splitsPair(current, current.length - suffix)) suffix--
  return { start, currentEnd: current.length - suffix, nextEnd: next.length - suffix }
}

/** Whether a cut at `offset` would fall inside a surrogate pair or a CRLF. */
function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  const highSurrogate = before >= 0xd800 && before <= 0xdbff
  const lowSurrogate = after >= 0xdc00 && after <= 0xdfff
  return (highSurrogate && lowSurrogate) || (before === 13 && after === 10)
}

type DiskReloadModel = Pick<Monaco.editor.ITextModel, 'getValue' | 'getPositionAt' | 'pushEditOperations'> & {
  pushStackElement(): void
}

export type DiskReloadEditor = {
  getModel(): DiskReloadModel | null
  getSelections(): Monaco.Selection[] | null
  getScrollTop(): number
  getScrollLeft(): number
  setScrollTop(value: number): void
  setScrollLeft(value: number): void
}

/**
 * Puts `next` into the editor as one undoable edit over only the lines that
 * changed. The wrapper's own route for a new `value` replaces the whole text,
 * which drops the caret at the end of the file and the scroll with it; an edit
 * over the changed stretch leaves a caret outside it where it was, moves one
 * below it with the lines, and keeps the person's undo history — ⌘Z takes the
 * reload back. Answers whether it edited anything.
 */
export function applyDiskContentToEditor(editor: DiskReloadEditor, next: string): boolean {
  const model = editor.getModel()
  if (!model) return false
  const current = model.getValue()
  const span = changedSpan(current, next)
  if (!span) return false
  const from = model.getPositionAt(span.start)
  const to = model.getPositionAt(span.currentEnd)
  const scrollTop = editor.getScrollTop()
  const scrollLeft = editor.getScrollLeft()
  model.pushStackElement()
  model.pushEditOperations(
    editor.getSelections(),
    [
      {
        range: {
          startLineNumber: from.lineNumber,
          startColumn: from.column,
          endLineNumber: to.lineNumber,
          endColumn: to.column,
        },
        text: next.slice(span.start, span.nextEnd),
      },
    ],
    () => null,
  )
  model.pushStackElement()
  editor.setScrollTop(scrollTop)
  editor.setScrollLeft(scrollLeft)
  return true
}

/**
 * `check`, run one at a time: a call while one is in flight runs it once more
 * after, never alongside, so two reads of the same file cannot land out of
 * order.
 */
export function oneAtATime(check: () => Promise<void>): () => void {
  let running = false
  let again = false
  const run = async (): Promise<void> => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        await check()
      } while (again)
    } finally {
      running = false
    }
  }
  return () => void run().catch(() => {})
}
