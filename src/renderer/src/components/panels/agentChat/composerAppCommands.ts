// What a message typed as a command asks of Studio before anything is sent.
//
// The `/` menu runs Studio's own commands (`/model`, `/effort`) in the view and
// never offers the ones that would leave the chat showing a conversation the
// CLI no longer has. Typing the same text past the menu must not reach the CLI
// either: `/model sonnet` would change the model behind a picker that still
// names the old one, and `/clear` would start a new conversation under an old
// transcript. So the send path asks here first.

/** What the view does with a message instead of sending it, or null to send it. */
export type ComposerAppCommand =
  /** Select `model` when named and known; otherwise open the model picker. */
  | { kind: 'model'; model?: string }
  /** Set `effort` when named; step to the next one when not. */
  | { kind: 'effort'; effort?: string }
  /** Ask `question` as a side question, kept out of the chat; without one, open the drawer to type it. */
  | { kind: 'sideQuestion'; question?: string }
  /** Not sent: say why, and keep the draft so nothing typed is lost. */
  | { kind: 'refuse'; notice: string }

const CLEARS_CONVERSATION = new Set(['clear', 'reset', 'new'])

export function composerAppCommand(
  text: string,
  chat: {
    cli: string | null
    /** The chat's model choices, for `/model <name>`. */
    models: ReadonlyArray<{ id: string; label?: string }>
    /** The efforts the chat's provider takes; empty when it has no effort control. */
    efforts: readonly string[]
    attachments: number
    /** The chat answers side questions, so `/btw` is Studio's. */
    sideQuestion?: boolean
  },
): ComposerAppCommand | null {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(text.trim())
  if (!match || !chat.cli) return null
  const name = match[1]!.toLowerCase()
  const argument = match[2]?.trim() ?? ''
  if (name === 'model') {
    if (!argument) return { kind: 'model' }
    const wanted = argument.toLowerCase()
    const found = chat.models.filter(
      (model) => model.id.toLowerCase() === wanted || model.label?.toLowerCase() === wanted,
    )
    return found.length === 1 ? { kind: 'model', model: found[0]!.id } : { kind: 'model' }
  }
  if (name === 'effort' && chat.efforts.length) {
    if (!argument) return { kind: 'effort' }
    const effort = chat.efforts.find((entry) => entry.toLowerCase() === argument.toLowerCase())
    return effort
      ? { kind: 'effort', effort }
      : { kind: 'refuse', notice: `Effort is one of ${chat.efforts.join(', ')}.` }
  }
  // Claude Code's /btw asks a side question in a terminal, and a headless child
  // answers it as a turn saying it is not available: one that costs a turn and
  // stays in the chat. Where the chat answers side questions, Studio asks it.
  if (name === 'btw' && chat.sideQuestion) {
    if (chat.attachments > 0)
      return { kind: 'refuse', notice: 'A side question takes words only. Remove the attachments to ask it.' }
    return argument ? { kind: 'sideQuestion', question: argument } : { kind: 'sideQuestion' }
  }
  if (CLEARS_CONVERSATION.has(name))
    return {
      kind: 'refuse',
      notice: `/${name} isn’t sent: this chat would keep showing messages the agent no longer has. Start a new chat for a fresh conversation.`,
    }
  // Codex compacts natively and takes nothing with it; instructions after
  // `/compact` would be dropped without a word.
  if (chat.cli === 'codex' && name === 'compact' && (argument || chat.attachments > 0))
    return { kind: 'refuse', notice: 'Codex’s /compact takes no instructions or images. Send /compact on its own.' }
  return null
}
