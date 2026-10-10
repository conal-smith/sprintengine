import { DIFF_TO_CHAT_MAX_CHARS } from '../../../../shared/ipc/window'
import { quoteAsMarkdown } from '../panels/agentChat/quoteSelection'

// "Add to chat" in the diff viewer: lines of a changed file, carried to the
// composer of the workspace's chat as a quote that says where they are from.
//
// The words are made here, in the viewer, and travel as text: the chat sets
// them into its draft exactly as its own quote shortcut sets a passage of the
// transcript (`quoteAsMarkdown`, `insertQuoteIntoDraft`), so a person reading
// the draft sees one kind of quote whichever way it came in. The reference
// leads, as `path:L12-L18`, because it is what the agent acts on; the code
// follows fenced; the person's note, when there is one, sits under the quote
// as their own words.

export type DiffChatSelection = {
  /** The file's path relative to the repository, as the diff lists it. */
  path: string
  /** Which side the lines were selected on: the change, or what it replaced. */
  side: 'modified' | 'original'
  startLine: number
  endLine: number
  code: string
  /** Monaco's language id, written as the fence's info string. */
  language: string
}

/** Where the lines are, as an agent reads a reference: `src/app.ts:L12-L18`. */
export function diffSelectionReference(selection: Pick<DiffChatSelection, 'path' | 'startLine' | 'endLine'>): string {
  const lines =
    selection.startLine === selection.endLine
      ? `L${selection.startLine}`
      : `L${selection.startLine}-L${selection.endLine}`
  return `${selection.path}:${lines}`
}

/** A fence one backtick longer than any run of backticks in the code, so the code cannot close it. */
function fenceFor(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/gu)].map((run) => run[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

export type DiffChatQuote = { kind: 'quote'; text: string } | { kind: 'too-long'; length: number }

/** The quote the composer is handed, or why the selection is too long to carry. */
export function diffSelectionQuote(selection: DiffChatSelection, note = ''): DiffChatQuote {
  const code = selection.code.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
  const fence = fenceFor(code)
  const where =
    selection.side === 'original'
      ? `\`${diffSelectionReference(selection)}\` (before the change)`
      : `\`${diffSelectionReference(selection)}\``
  const quote = quoteAsMarkdown(`${where}\n${fence}${selection.language}\n${code}\n${fence}`)
  const words = note.trim()
  const text = words ? `${quote}\n\n${words}` : quote
  return text.length > DIFF_TO_CHAT_MAX_CHARS ? { kind: 'too-long', length: text.length } : { kind: 'quote', text }
}
