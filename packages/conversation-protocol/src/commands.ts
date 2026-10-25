import type { ConversationWireCommand, ConversationWireKey, ConversationWirePermissionPreset } from './index.js'

// The commands a client sends a conversation, and the answers it gives one.
//
// `ConversationWireCommand` (index.ts) is what every desktop since the lane
// shipped takes. The commands here extend it, each behind its own capability,
// so a client sends one only to a desktop that advertised it; a desktop
// without it refuses an unknown kind as `unsupported_command` and drops an
// unknown member, which is the fallback each extension below is shaped for.

/**
 * An answer to a `tool` permission request: allow this request `once`, allow
 * requests of its kind for the rest of the `conversation`, or `deny` it. A
 * rule that outlives the conversation is the person's to make on the desktop
 * itself, and no client can choose one.
 */
export type ConversationRequestDecision = 'once' | 'conversation' | 'deny'

/** Every decision a client may send, narrowest first. */
export const CONVERSATION_REQUEST_DECISIONS: readonly ConversationRequestDecision[] = ['once', 'conversation', 'deny']

/** An answer to a `plan` request: carry the plan out, or send the agent back to planning. */
export type ConversationPlanDecision = 'approve' | 'reject'

/** A question's answers: the question's text to the chosen answer (several comma-separated, free text verbatim). */
export type ConversationQuestionAnswers = Record<string, string>

/**
 * A command, from the full contract. Beyond the wire's own:
 *
 * - `setPermissionPreset` may name the CLI's own `permissionMode` at that
 *   preset (Claude Code's Accept edits, Codex's Workspace). Needs
 *   `conversation-cli-permission-modes`; a desktop without it ignores the
 *   member and runs the preset's own mode. A mode whose level is not the
 *   preset runs the preset's own as well.
 * - `resolvePlan` answers a `plan` request and only a plan request. Needs
 *   `conversation-plans`; before it, a plan was answered as a `resolveApproval`
 *   (`once` carries it out, `deny` rejects it), which every desktop still takes.
 * - `send` may say `queue`: the desktop holds the message and sends it the
 *   moment the chat's turn ends (at once, if none is running), and answers as
 *   soon as it holds it rather than when a turn ends. A held message is its
 *   words alone, so `queue` never rides beside `uploadIds`. Needs
 *   `conversation-queued-sends`; a desktop without it drops the member, and
 *   a send made while a turn runs is refused `busy`, as every send was.
 * - `send` may name `skills`: ids of the desktop's skills the chat runs with
 *   this message, at most `CONVERSATION_MAX_SEND_SKILLS`. Never beside
 *   `queue`. Needs `conversation-send-skills`; a desktop without it drops the
 *   member and the message goes without them.
 * - `send` may say `steer`: the message goes into the turn that is running
 *   rather than waiting for it to end, where the chat's provider takes one
 *   (the listed chat's `capabilities.steer`). Answered when that turn ends, as
 *   any send is. With no turn running it is an ordinary send. A turn that
 *   cannot take it (a provider that cannot, a request the agent waits on, a
 *   turn that ended on the way) has the desktop hold it as a `queue` send is
 *   held, answered at once with a `notice` saying so; one carrying
 *   `uploadIds`, `skills` or `mentions`, which a held message cannot, is
 *   refused `busy` instead, and sent again goes as the next turn once the
 *   turn is over. One that reached the chat is answered as taken even if
 *   its turn then fails, with that in its `notice`, so a client never sends
 *   the same words twice. Never beside `queue`. Needs `conversation-steer-sends`; a desktop without it
 *   drops the member, and a send made while a turn runs is refused `busy`.
 * - `cancelQueued` takes back a message the desktop holds (`queued` frames
 *   name each by `id`), refused once it is on its way into the chat. Needs
 *   `conversation-queued-sends` too.
 * - `stopSubagent` stops one agent the chat spawned, named by the call that
 *   spawned it (the `toolUseId` its `subagent_status` events carry), and
 *   leaves the chat, its turn and its other agents running; between turns
 *   too, where a background agent works on. The agent reports its own end,
 *   which closes its lane. Refused for an agent that is not running, and for
 *   a chat whose provider cannot stop one by itself (the listed chat's
 *   `capabilities.stopSubagent`). Needs `conversation-stop-subagent`; a
 *   desktop without it refuses the kind as `unsupported_command`.
 * - `handoff` hands the chat off to a fresh session instead of compacting it,
 *   as its own Handoff does on the desktop: the chat's messages are written to
 *   a file on the desktop, the provider session is let go, and the next
 *   message starts a new one pointed at the file (a `context_handed_off`
 *   event records it). Refused while a turn runs, a request waits on the
 *   person, or the chat has an agent, a shell or a monitor running, and for a
 *   chat whose provider cannot (the listed chat's `capabilities.handoff`).
 *   Never resumes a chat at rest. Needs `conversation-handoff`; a desktop
 *   without it refuses the kind as `unsupported_command`.
 * - `rewind` takes the chat back to before the user message at `turnSeq`
 *   (its `user_message` event's `seq`), as its Edit from here does on the
 *   desktop: that message and every turn after it leave the agent's context,
 *   and a `session_updated` carrying `rewoundFromSeq` takes them out of the
 *   transcript's view. Files are not touched. Refused while a turn runs, and
 *   for a chat whose provider cannot (the listed chat's
 *   `capabilities.rewind`). Never resumes a chat at rest: the next message
 *   starts from where it went back to. The desktop answers a repeat of the
 *   same command id with the first answer. Needs `conversation-rewind`; a
 *   desktop without it refuses the kind as `unsupported_command`.
 * - `revert` puts back the files of the desktop's checkout as they were
 *   before the turn at `turnSeq`, from its checkpoint (`undo`: as they were
 *   before the last revert of that turn), as its Revert and Undo revert do.
 *   Without `confirmed` it changes nothing and answers with the files it
 *   would touch; `confirmed`, it acts on exactly the `files` named, which are
 *   the paths that answer listed, and refuses with `changed` when the list
 *   is no longer that. The answer rides on the `commandResult` as `data`
 *   (`ConversationRevertAnswer`). Refused while a turn runs in the checkout.
 *   A repeat of a confirmed revert under the same command id is answered as
 *   the first was. Needs `conversation-checkpoint-revert`, and a listed chat
 *   with `capabilities.checkpoints`; a desktop without it refuses the kind as
 *   `unsupported_command`.
 * - `send` may name `mentions`: files and folders of the chat's folder on the
 *   desktop, each by its path relative to that folder (`ConversationWireMention`,
 *   at most `CONVERSATION_MAX_SEND_MENTIONS`), as its own composer's @ chips
 *   name them. The desktop resolves each against the chat's own folder, as it
 *   resolves its own, and refuses the send in words for one outside it or gone.
 *   Never beside `queue`, as `skills` are not. Needs
 *   `conversation-send-mentions`; a desktop without it drops the member and
 *   the message goes without them, so a client sends it only where it is
 *   advertised.
 * - `send` may say when the person wrote it, `composedAt` (epoch ms, the
 *   client's clock), beside any of the above. A desktop refuses one written
 *   more than `CONVERSATION_STALE_SEND_MS` ago as `stale`, recording nothing,
 *   unless it also says `confirmedStale`: the person saw it had not gone and
 *   asked for it to go now. A message a client kept while it slept is not one
 *   the person still means hours later. The message it records carries
 *   `composedAt`, so a reader can say when it was written. No capability: a
 *   desktop without it drops both members and sends as it always did, so a
 *   client sends `composedAt` with every message and decides for itself what
 *   it no longer sends without asking.
 * - `fork` starts a new chat beside this one, `newAgentId`, holding it up to a
 *   point, as its own Fork from here does on the desktop: through the reply of
 *   the turn `turnId` names (`side: 'assistant'`), or up to but not including
 *   the person's message at `turnSeq` (`side: 'user'`). The new chat joins the
 *   same workspace on the desktop, named after this one, works in the same
 *   files and carries on by itself; this chat is not touched. The client names
 *   the new chat's id, so it can follow it once the fork is answered; the
 *   desktop refuses an id that is taken. Refused while this chat is working,
 *   and for a chat whose provider cannot be forked (the listed chat's
 *   `capabilities.fork`). The same command sent again is answered as the
 *   first was. Never resumes a chat at rest. Needs `conversation-fork`; a
 *   desktop without it refuses the kind as `unsupported_command`.
 */
export type ConversationCommand =
  | Exclude<ConversationWireCommand, { kind: 'setPermissionPreset' } | { kind: 'send' }>
  | {
      kind: 'send'
      message: string
      uploadIds?: string[]
      queue?: true
      skills?: string[]
      mentions?: ConversationWireMention[]
      steer?: true
      composedAt?: number
      confirmedStale?: true
    }
  | { kind: 'setPermissionPreset'; preset: ConversationWirePermissionPreset; permissionMode?: string }
  | { kind: 'resolvePlan'; requestId: string; decision: ConversationPlanDecision }
  | { kind: 'cancelQueued'; queuedId: string }
  | { kind: 'stopSubagent'; toolUseId: string }
  | { kind: 'handoff' }
  | { kind: 'rewind'; turnSeq: number }
  | { kind: 'revert'; turnSeq: number; undo?: true; confirmed?: true; files?: string[] }
  | ConversationForkCommand

/** Where a `fork` cuts the chat: after a reply's turn, or before one of the person's messages. */
export type ConversationForkCommand = { kind: 'fork'; newAgentId: string } & (
  { side: 'assistant'; turnId: string } | { side: 'user'; turnSeq: number }
)

export type ConversationCommandKind = ConversationCommand['kind']

/** The most paths a confirmed `revert` names, and the longest one. */
export const CONVERSATION_MAX_REVERT_FILES = 10_000
export const CONVERSATION_MAX_REVERT_PATH_CHARS = 4096

/**
 * One file a `revert` would put back, or did. `path` is relative to the
 * desktop's checkout, a path on the desktop's disk and never the client's.
 */
export type ConversationRevertFile = {
  path: string
  status: 'added' | 'modified' | 'deleted'
  addedLines: number
  removedLines: number
  binary: boolean
}

/**
 * What a `revert` answered, as its `commandResult`'s `data`. Accepted: the
 * files it would touch (`reverted: false`, unconfirmed) or touched (`true`),
 * and the new files it left in place because the checkout's ignore rules
 * ignore them, so they may well predate the turn (`kept`). Refused because
 * the files moved since they were shown: `changed`, and the client shows the
 * new list and asks again.
 */
export type ConversationRevertAnswer =
  { files: ConversationRevertFile[]; reverted: boolean; kept?: string[] } | { changed: true }

/**
 * How old a `send`'s `composedAt` may be before a desktop asks for it to be
 * confirmed. Wider than any client's own limit (the phone stops at ten
 * minutes) so a client whose clock runs a few minutes off the desktop's never
 * has a message it just sent refused: this is the backstop for a client that
 * forgot to ask, not the rule a person meets.
 */
export const CONVERSATION_STALE_SEND_MS = 30 * 60_000

/**
 * Whether a desktop refuses this send as `stale` at `now`: it says when it
 * was written, that is longer ago than the limit, and the person has not
 * confirmed it. A send that does not say (every client before the member) is
 * never stale.
 */
export function isStaleConversationSend(
  command: { composedAt?: number; confirmedStale?: true | boolean },
  now: number,
): boolean {
  return (
    command.confirmedStale !== true &&
    typeof command.composedAt === 'number' &&
    now - command.composedAt > CONVERSATION_STALE_SEND_MS
  )
}

/** Every command kind this version of the contract defines. */
export const CONVERSATION_COMMAND_KINDS: readonly ConversationCommandKind[] = [
  'send',
  'interrupt',
  'resolveApproval',
  'answerQuestion',
  'resolvePlan',
  'setPermissionPreset',
  'setModel',
  'cancelQueued',
  'stopSubagent',
  'handoff',
  'rewind',
  'revert',
  'fork',
]

// ── Messages the desktop holds ──────────────────────────────────────────────
//
// A message queued while a chat was mid-turn, held by the desktop the chat
// runs on (`conversation-queued-sends`). The desktop is the one that sends
// it, so it is the one that says what is waiting: a client asks with
// `watchQueued` once it follows the chat, and is sent a `queued` frame then
// and whenever what the desktop holds for that chat changes. A message on its
// way into the chat is in none: its `user_message` is in the transcript.

/** One message the desktop holds for a chat until its turn ends. */
export type ConversationQueuedMessage = {
  id: string
  /** The message as it will be sent: several queued in one turn read as one, a line apiece. */
  text: string
  /** When it was first held (epoch ms). */
  createdAt: number
  /**
   * The chat refused it when its turn came, in the chat's words. It stays,
   * waiting on the person, until it is taken back.
   */
  failure?: string
}

/** What a desktop holds for one chat, at most this many. */
export const CONVERSATION_MAX_QUEUED_MESSAGES = 20

/**
 * Ask the desktop to say what it holds for the chat this socket follows:
 * answered by a `result` under `requestId`, then a `queued` frame now and on
 * every change, until the socket follows another chat or closes. Sent again
 * after each subscription's fence. A desktop without
 * `conversation-queued-sends` answers it `ok: false` with `invalid_frame`.
 */
export type ConversationWatchQueuedRequest = { type: 'watchQueued'; requestId: string }

/** What the desktop holds for `key`, whole each time: an empty list once nothing is held. */
export type ConversationQueuedFrame = {
  type: 'queued'
  key: ConversationWireKey
  messages: ConversationQueuedMessage[]
}

/**
 * What starting a conversation takes. A transport adds what it carries
 * besides (a module's in-process pictures, a socket's upload ids); these
 * members mean the same everywhere.
 */
export type ConversationCreateRequest = {
  workspaceId: string
  /** The agent CLI the chat runs on; absent, the one the person last chose. */
  cli?: string
  /** The CLI's model id; absent, the CLI's own default. */
  model?: string
  /** The opening turn. Absent, the chat starts without one. */
  prompt?: string
  /** Display name; absent, the desktop picks one. */
  name?: string
  /** Skill ids installed before the first turn and invoked in it. */
  skills?: string[]
  /** Absent, the person's own default. A desktop may lower it to the caller's ceiling. */
  permissionPreset?: ConversationWirePermissionPreset
  /** The CLI's own mode at `permissionPreset`; read only beside it. */
  permissionMode?: string
  /**
   * Tools the chat may use without asking, by the name its CLI gives them
   * (`Write`, `Edit`). Questions and plans still ask. A CLI that cannot take
   * the list ignores it and asks as its preset says, which is never looser.
   */
  allowedTools?: string[]
}

/** The most tools `allowedTools` names. */
export const CONVERSATION_MAX_ALLOWED_TOOLS = 64
/** The most skills a send names. */
export const CONVERSATION_MAX_SEND_SKILLS = 32
/** The most skills a create names. */
export const CONVERSATION_MAX_CREATE_SKILLS = 32

// ── Mentions a send names ──────────────────────────────────────────────────
//
// A file or folder of the chat's folder on the desktop, as its own composer's
// @ chips name one: by its path relative to that folder, with `/` between
// segments, and for a file a line or a range of lines. Never a path of the
// client's own: the folder is the desktop's (`conversation-send-mentions`).

/** One file or folder a `send` names. */
export type ConversationWireMention = {
  path: string
  kind: 'file' | 'folder'
  /** The first line meant, from 1. */
  line?: number
  /** The last line meant, at or after `line`. */
  endLine?: number
}

/** The most mentions a send names, as the desktop's own composer takes. */
export const CONVERSATION_MAX_SEND_MENTIONS = 50
const MAX_MENTION_PATH_CHARS = 4096

function line(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * A send's `mentions`, each kept as the contract defines it, or null when any
 * is not one: an absolute path, a drive, a `..` segment, a control character
 * or a range that runs backwards is refused rather than dropped, so a message
 * never goes without what its chips showed. The desktop checks each again
 * against the chat's folder.
 */
export function parseConversationWireMentions(value: unknown): ConversationWireMention[] | null {
  if (!Array.isArray(value) || value.length > CONVERSATION_MAX_SEND_MENTIONS) return null
  const mentions: ConversationWireMention[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
    const mention = entry as Record<string, unknown>
    const path = mention.path
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > MAX_MENTION_PATH_CHARS ||
      /[\u0000-\u001f\u007f]/u.test(path) ||
      path.startsWith('/') ||
      path.startsWith('\\') ||
      /^[A-Za-z]:/u.test(path) ||
      path.split(/[\\/]/u).includes('..')
    )
      return null
    if (mention.kind !== 'file' && mention.kind !== 'folder') return null
    if (mention.line !== undefined && !line(mention.line)) return null
    const from = line(mention.line) ? mention.line : 1
    if (mention.endLine !== undefined && !(line(mention.endLine) && mention.endLine >= from)) return null
    mentions.push({
      path,
      kind: mention.kind,
      ...(mention.line === undefined ? {} : { line: mention.line as number }),
      ...(mention.endLine === undefined ? {} : { endLine: mention.endLine as number }),
    })
  }
  return mentions
}

// What a CLI may call one of its own modes: short, and nothing a path, a flag
// or a markup fragment could be read as.
const PERMISSION_MODE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
// A tool name, or a CLI's pattern over one (`Bash(npm test:*)`): printable,
// one line, bounded, with no space at either end.
function toolName(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 200 || value.trim() !== value) return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** Whether a value can be a CLI's own permission mode id. A desktop checks it against the chat's CLI as well. */
export function isConversationPermissionModeId(value: unknown): value is string {
  return typeof value === 'string' && PERMISSION_MODE.test(value)
}

/** Whether a value is a usable `allowedTools` list. */
export function isConversationAllowedTools(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= CONVERSATION_MAX_ALLOWED_TOOLS && value.every(toolName)
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/**
 * Validate a create request at a trust boundary, keeping only the members the
 * contract defines. The refusal names the member, so a caller can fix it.
 */
export function parseConversationCreateRequest(
  value: unknown,
): { ok: true; request: ConversationCreateRequest } | { ok: false; field: string; message: string } {
  const refuse = (field: string, message: string) => ({ ok: false as const, field, message })
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return refuse('', 'A create request is an object.')
  const input = value as Record<string, unknown>
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim() || input.workspaceId.length > 200)
    return refuse('workspaceId', '"workspaceId" is required.')
  for (const [field, max] of [
    ['cli', 200],
    ['model', 400],
    ['name', 200],
    ['prompt', 200_000],
  ] as const) {
    if (input[field] !== undefined && !text(input[field], max))
      return refuse(field, `"${field}" must be a string of at most ${max} characters.`)
  }
  if (
    input.skills !== undefined &&
    !(
      Array.isArray(input.skills) &&
      input.skills.length <= CONVERSATION_MAX_CREATE_SKILLS &&
      input.skills.every((skill) => typeof skill === 'string' && skill.trim() !== '' && skill.length <= 200)
    )
  )
    return refuse('skills', '"skills" must be a list of skill ids.')
  if (
    input.permissionPreset !== undefined &&
    !['none', 'manual', 'auto', 'bypass'].includes(input.permissionPreset as string)
  )
    return refuse('permissionPreset', '"permissionPreset" must be "none", "manual", "auto" or "bypass".')
  if (input.permissionMode !== undefined && !isConversationPermissionModeId(input.permissionMode))
    return refuse('permissionMode', '"permissionMode" must be one of the CLI\'s own mode ids.')
  if (input.allowedTools !== undefined && !isConversationAllowedTools(input.allowedTools))
    return refuse(
      'allowedTools',
      `"allowedTools" must be a list of at most ${CONVERSATION_MAX_ALLOWED_TOOLS} tool names.`,
    )
  return {
    ok: true,
    request: {
      workspaceId: input.workspaceId.trim(),
      ...(input.cli === undefined ? {} : { cli: input.cli as string }),
      ...(input.model === undefined ? {} : { model: input.model as string }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt as string }),
      ...(input.name === undefined ? {} : { name: input.name as string }),
      ...(input.skills === undefined ? {} : { skills: [...(input.skills as string[])] }),
      ...(input.permissionPreset === undefined
        ? {}
        : { permissionPreset: input.permissionPreset as ConversationWirePermissionPreset }),
      // A mode rides only beside a preset, as everywhere else.
      ...(input.permissionMode === undefined || input.permissionPreset === undefined
        ? {}
        : { permissionMode: input.permissionMode as string }),
      ...(input.allowedTools === undefined ? {} : { allowedTools: [...(input.allowedTools as string[])] }),
    },
  }
}
