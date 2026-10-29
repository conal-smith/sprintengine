import { CodeBlock, type CodeBlockProps } from '../../ui/CodeBlock'
import { showToast } from '../../../store/toastStore'
import { focusOrAddTerminalTab, getModel } from '../../../utils/modelRegistry'
import { useConversationLinkContext, type ConversationLinkContext } from './conversationLinks'
import { useConversationTransport } from './conversationTransport'
import { clientSupports } from '../../../clientCapabilities'
import { useDiagramDrawing } from './conversationDiagram'
import { useVisualDrawing } from './conversationVisual'

// How long a new terminal's shell gets to show it takes a bracketed paste:
// long enough for rc files that load a prompt framework, short enough that a
// shell which never will is not waited on noticeably.
const BRACKETED_PASTE_WAIT_MS = 4000

const BRACKETED_PASTE_TOGGLE = /\u001b\[\?2004([hl])/gu
// One character short of a whole toggle, so a toggle split across two chunks
// is completed by the next one and a whole one is never counted twice.
const TOGGLE_TAIL = '\u001b[?2004h'.length - 1

/**
 * Follows one terminal's output for the shell turning bracketed paste on
 * (`ESC[?2004h`) or off (`ESC[?2004l`). Each chunk is read with the end of the
 * one before it, as a toggle can arrive split across two; the answer is the
 * state the latest toggle left.
 */
export function bracketedPasteTracker(): (chunk: string) => boolean {
  let tail = ''
  let enabled = false
  return (chunk) => {
    const text = tail + chunk
    for (const match of text.matchAll(BRACKETED_PASTE_TOGGLE)) enabled = match[1] === 'h'
    tail = text.slice(-TOGGLE_TAIL)
    return enabled
  }
}

/**
 * What goes into the terminal. A shell that takes a bracketed paste holds the
 * whole command at its prompt, newlines and all. One that does not — macOS's
 * own bash 3.2, sh and dash, cmd — runs each line as its newline arrives, so
 * there only a single line is typed, and never with a newline of its own; a
 * longer command is left on the clipboard for the person to paste where they
 * choose. Nothing here ever runs the command.
 */
export type TerminalPastePlan = { kind: 'paste'; data: string } | { kind: 'type'; data: string } | { kind: 'copy' }

export function terminalPastePlan(command: string, bracketedPaste: boolean): TerminalPastePlan {
  if (bracketedPaste) return { kind: 'paste', data: `\u001b[200~${command}\u001b[201~` }
  if (/[\n\r]/u.test(command)) return { kind: 'copy' }
  return { kind: 'type', data: command }
}

// Watch a terminal from before it spawns, so the shell's first toggle is not
// missed. Its pane may be sent the output live or as a replay once it mounts;
// either says what the shell asked for, and each is read on its own.
function watchBracketedPaste(sessionId: string) {
  const live = bracketedPasteTracker()
  const replayed = bracketedPasteTracker()
  let enabled = false
  let settle: ((value: boolean) => void) | null = null
  const receive = (track: (chunk: string) => boolean) => (data: string) => {
    enabled = track(data)
    if (enabled) settle?.(true)
  }
  const stops = [
    window.api.onTerminalData(sessionId, receive(live)),
    window.api.onTerminalReplay(sessionId, receive(replayed)),
  ]
  return {
    enabled: (timeoutMs: number): Promise<boolean> =>
      enabled
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), timeoutMs)
            settle = (value) => {
              clearTimeout(timer)
              resolve(value)
            }
          }),
    dispose: () => {
      for (const stop of stops) stop()
    },
  }
}

// A fresh terminal in the conversation's folder with the command waiting at its
// prompt — pasted, never entered. The block is the agent's text, and a reply
// steered by something it read can dress a harmful command as a helpful one; the
// person runs it by pressing Enter once they have read it where it will run. It
// goes in only once the shell is at its prompt and has said it takes a
// bracketed paste, so a multi-line block waits whole rather than each line
// running as its newline arrives (see terminalPastePlan for a shell that never
// says so). A new tab each time rather than a shared one, so it never lands in
// the middle of whatever another terminal is doing.
async function pasteInTerminal(context: ConversationLinkContext, command: string): Promise<void> {
  const report = (title: string, description?: string): void => void showToast({ tone: 'error', title, description })
  if (!getModel(context.workspaceId)) return report('Open the workspace to run this in a terminal')
  const terminalId = `chat-run-${Date.now()}`
  const sessionId = `terminal-${terminalId}`
  const watch = watchBracketedPaste(sessionId)
  try {
    const result = await window.api.terminalSpawn(
      sessionId,
      100,
      30,
      context.cwd,
      false,
      undefined,
      undefined,
      undefined,
      true,
      { kind: 'terminal', workspaceId: context.workspaceId, terminalId },
    )
    if (!result.ok) return report('Could not start a terminal', result.message)
    const firstLine = command.split('\n', 1)[0]
    focusOrAddTerminalTab(
      context.workspaceId,
      terminalId,
      firstLine.length > 32 ? `${firstLine.slice(0, 31)}…` : firstLine,
    )
    const plan = terminalPastePlan(command, await watch.enabled(BRACKETED_PASTE_WAIT_MS))
    if (plan.kind !== 'copy') {
      await window.api.terminalWrite(sessionId, plan.data)
      return
    }
    await window.api.clipboardWriteText(command)
    showToast({
      tone: 'warn',
      title: 'Copied the command instead',
      description:
        "This terminal's shell would run a multi-line paste line by line, so the command is on the clipboard to paste where you want it.",
    })
  } catch (error) {
    report('Could not start a terminal', error instanceof Error ? error.message : String(error))
  } finally {
    watch.dispose()
  }
}

// What every code block in a conversation offers. A shell block written for
// this machine's workspace can be put at a terminal's prompt — the block decides
// whether it is one and hands over the command with its prompts stripped; one
// from a conversation on another machine cannot — its folder is over there.
function usePasteInTerminal(): CodeBlockProps['onPasteInTerminal'] {
  const context = useConversationLinkContext()
  const localFiles = useConversationTransport().capabilities.localFiles
  return context && localFiles && clientSupports('terminals')
    ? (command) => void pasteInTerminal(context, command)
    : undefined
}

// A code block in text a person wrote: shown as it was typed.
export function ConversationCodeBlock(props: CodeBlockProps) {
  return <CodeBlock {...props} onPasteInTerminal={usePasteInTerminal()} />
}

// A code block in an agent's reply, which also draws a ```mermaid block as
// its diagram once the block is complete (`conversationDiagram.tsx`), and a
// ```visual block as its chart or table (`conversationVisual.tsx`).
export function ConversationReplyCodeBlock(props: CodeBlockProps) {
  const diagram = useDiagramDrawing(props.code, props.language, props.streaming)
  // At most one of the two answers for a block; the other is empty.
  const visual = useVisualDrawing(props.code, props.language, props.streaming)
  // The diagram's action joins the caller's rather than replacing them.
  const actions =
    props.actions && diagram.actions ? (
      <>
        {props.actions}
        {diagram.actions}
      </>
    ) : (
      (props.actions ?? diagram.actions)
    )
  return <CodeBlock {...props} {...diagram} {...visual} actions={actions} onPasteInTerminal={usePasteInTerminal()} />
}
