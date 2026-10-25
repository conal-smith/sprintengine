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
 * - `setReasoningEffort` sets the reasoning effort the chat's turns run at,
 *   as its own effort control does on the desktop: kept on the chat, and
 *   applied from its next turn, whichever device sends it. `effort` is one of
 *   the levels the listed chat's provider runs (`capabilities.reasoningEfforts`);
 *   absent, the provider's own default. Refused for a level the provider does
 *   not run, and for a chat whose provider runs none. Answered with a `notice`
 *   while a session is live, since the turn running keeps its own. Needs
 *   `conversation-reasoning-effort`; a desktop without it refuses the kind as
 *   `unsupported_command`.
 * - `mcpServerAction` reconnects one of a live chat's MCP servers, or
 *   switches one on or off, as its composer's server rows do on the desktop:
 *   `serverId` names it as the chat's CLI does, and `action` is one of the
 *   listed chat's `capabilities.mcpServerActions`. Never resumes a chat at
 *   rest: its servers run with its agent. A sign-in is not among them: the
 *   CLI waits for the sign-in's callback on the desktop itself, so one begun
 *   from another device could not be finished there. Needs
 *   `conversation-mcp-server-actions`; a desktop without it refuses the kind
 *   as `unsupported_command`.
 * - `restartSession` restarts the chat's agent, as its own Restart agent
 *   session does on the desktop: its process is ended the way Settle ends
 *   it, suspended, so the session keeps its place and the next message
 *   starts the agent again on the same conversation, with whatever it has
 *   installed since. Refused while the agent works (a turn, a request it
 *   waits on, an agent or a monitor it runs). A chat with no agent running is
 *   answered with a `notice` saying so, and nothing is done; one at rest is
 *   never resumed for it. The same command sent again is answered as the
 *   first was, never carried out on the session a message has started since.
 *   Needs `conversation-restart-session`; a desktop without it refuses the
 *   kind as `unsupported_command`.
 * - `send` may say the `mode` the turn runs in, as the desktop's own chat
 *   sends one: `ask` answers without changing anything, `plan` has the agent
 *   plan and wait for the plan to be approved, where the chat's provider
 *   plans (the listed chat's `capabilities.planMode`). Absent, or `default`,
 *   the turn runs as every send did. Never beside `queue`: a held message is
 *   its words alone, and would go in the default mode. A steer the running
 *   turn cannot take is refused `busy` rather than held, for the same reason.
 *   Needs `conversation-send-mode`; a desktop without it drops the member and
 *   runs the turn in the default mode, which may change what an `ask` would
 *   not, so a client sends one only where it is advertised.
 * - `scheduleSend` has the desktop keep a message and send it into the chat
 *   at `sendAt` (epoch ms, the desktop's clock), as its own composer's
 *   Schedule does, whether or not the client is still awake then; answered
 *   once it is kept. Its words alone, as a held message is. One that comes
 *   due while a turn runs waits for the turn to end. `sendScheduledNow` sends
 *   one at once (a refused one again: Retry), and `cancelScheduled` deletes
 *   one, which is how a client takes one back to edit it. Both name the
 *   message by the `id` its `scheduled` frame gave, and are refused for one
 *   that is no longer scheduled. Needs `conversation-scheduled-sends`; a
 *   desktop without it refuses each kind as `unsupported_command`.
 * - `usageLimitResume` answers the chat's usage-limit notice (a
 *   `usageLimits` frame's `notice`), as the desktop's own tray row does:
 *   `schedule` has the desktop send the chat a short "carry on" once the
 *   limit resets (`always` switches that on for every chat a limit stops
 *   there, as the row's "Always resume at reset" does), `cancel` takes it
 *   back and keeps the notice, `dismiss` puts the notice away with whatever
 *   it had scheduled, and `retry` sends a resume the chat refused again.
 *   Answered `ok` for a chat with no notice, which there is nothing to do
 *   for. Needs `conversation-usage-limits`; a desktop without it refuses the
 *   kind as `unsupported_command`.
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
      mode?: ConversationSendMode
    }
  | { kind: 'setPermissionPreset'; preset: ConversationWirePermissionPreset; permissionMode?: string }
  | { kind: 'resolvePlan'; requestId: string; decision: ConversationPlanDecision }
  | { kind: 'cancelQueued'; queuedId: string }
  | { kind: 'stopSubagent'; toolUseId: string }
  | { kind: 'handoff' }
  | { kind: 'rewind'; turnSeq: number }
  | { kind: 'revert'; turnSeq: number; undo?: true; confirmed?: true; files?: string[] }
  | ConversationForkCommand
  | { kind: 'setReasoningEffort'; effort?: string }
  | { kind: 'mcpServerAction'; serverId: string; action: ConversationWireMcpServerAction }
  | { kind: 'restartSession' }
  | { kind: 'scheduleSend'; message: string; sendAt: number }
  | { kind: 'sendScheduledNow'; scheduledId: string }
  | { kind: 'cancelScheduled'; scheduledId: string }
  | { kind: 'usageLimitResume'; action: ConversationUsageLimitResumeAction; always?: true }

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

/** What a device may do to one of a live chat's MCP servers (`conversation-mcp-server-actions`). */
export type ConversationWireMcpServerAction = 'reconnect' | 'enable' | 'disable'

/** Every MCP server action a device may ask for. */
export const CONVERSATION_MCP_SERVER_ACTIONS: readonly ConversationWireMcpServerAction[] = [
  'reconnect',
  'enable',
  'disable',
]

/** The modes a `send` may name beside the default one (`conversation-send-mode`). */
export type ConversationSendMode = 'plan' | 'ask'

/** Every mode a `send` may name, the default one included, which is the same as naming none. */
export const CONVERSATION_SEND_MODES: readonly (ConversationSendMode | 'default')[] = ['default', 'plan', 'ask']

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
  'setReasoningEffort',
  'mcpServerAction',
  'restartSession',
  'scheduleSend',
  'sendScheduledNow',
  'cancelScheduled',
  'usageLimitResume',
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

// ── Messages scheduled for a time ───────────────────────────────────────────
//
// A message a person scheduled into a chat for a time they picked
// (`conversation-scheduled-sends`), kept and sent by the desktop the chat runs
// on, as a message scheduled from its own composer is. A client asks with
// `watchScheduled` once it follows the chat, and is sent a `scheduled` frame
// then and whenever the chat's scheduled messages change. A message the
// desktop holds for the turn's end (`queued`) is in neither: its `queued`
// frame names it.

/** One message the desktop keeps for a chat until its time. */
export type ConversationScheduledMessage = {
  id: string
  text: string
  /** When it goes out (epoch ms, the desktop's clock). */
  sendAt: number
  /** When it was scheduled (epoch ms). */
  createdAt: number
  /** It came due while the chat was working, and goes when the turn ends (epoch ms it came due). */
  waitingSince?: number
  /** It is on its way into the chat now. */
  sending?: true
  /**
   * It went out and the chat refused it, in the chat's words. It stays,
   * saying so, until it is sent again or deleted.
   */
  failure?: string
}

/** The most scheduled messages a `scheduled` frame names for one chat. */
export const CONVERSATION_MAX_SCHEDULED_MESSAGES = 50

/**
 * Ask the desktop to say what it has scheduled into the chat this socket
 * follows: answered by a `result` under `requestId`, then a `scheduled` frame
 * now and on every change, until the socket follows another chat or closes.
 * Sent again after each subscription's fence. A desktop without
 * `conversation-scheduled-sends` answers it `ok: false` with `invalid_frame`.
 */
export type ConversationWatchScheduledRequest = { type: 'watchScheduled'; requestId: string }

/** What the desktop has scheduled into `key`, soonest first, whole each time: empty once nothing is. */
export type ConversationScheduledFrame = {
  type: 'scheduled'
  key: ConversationWireKey
  messages: ConversationScheduledMessage[]
}

// ── Usage limits ────────────────────────────────────────────────────────────
//
// What the desktop the chat runs on knows of its agents' subscription limits
// (`conversation-usage-limits`): the five-hour session window and the weekly
// ones, as the agent CLIs reported them there, and, for the chat followed, the
// notice a usage limit left when it stopped the chat's turn, with the resume
// the desktop can send it once the limit resets. They are that desktop's to
// say: its agents report them, and it sends the resume. A client asks with
// `watchUsageLimits` once it follows the chat, and is sent a `usageLimits`
// frame then and whenever any of it changes.

/** What `usageLimitResume` does with the chat's notice. */
export type ConversationUsageLimitResumeAction = 'schedule' | 'cancel' | 'dismiss' | 'retry'

export const CONVERSATION_USAGE_LIMIT_RESUME_ACTIONS: readonly ConversationUsageLimitResumeAction[] = [
  'schedule',
  'cancel',
  'dismiss',
  'retry',
]

/** A chat's turn a usage limit stopped, and the resume the desktop can send it. */
export type ConversationUsageLimitNotice = {
  /** The plan's owner: `claude` or `codex` today; a newer desktop may name another. */
  provider: string
  /** Which of the plan's limits ran out; null when the agent did not say. */
  limit: 'session' | 'weekly' | null
  /** When the limit lifts (epoch ms), or null when nothing said. */
  resetsAt: number | null
  /** When the turn was stopped. */
  hitAt: number
  /** When the resume goes out (epoch ms), or null while none is scheduled. */
  resumeAt: number | null
  /** The resume went out and the chat refused it, in the chat's words; it waits on Retry or Dismiss. */
  failure?: string
}

/** One of a plan's windows, as the agent last reported it. */
export type ConversationUsageLimitWindow = {
  /** Stable across readings: `five_hour`, `seven_day`, `codex:primary`. */
  id: string
  label: string
  /** 0..100, or null when the agent said where the window stands but not how full it is. */
  usedPercent: number | null
  resetsAt: number | null
  durationMs?: number
  /** `model` for a window that meters one model's use rather than the account's. */
  scope?: 'model'
  status: 'allowed' | 'warning' | 'rejected'
  observedAt: number
}

/** One plan's windows. Only a subscription's: a plan billed by use has none. */
export type ConversationUsageLimitSnapshot = {
  provider: string
  plan?: string
  windows: ConversationUsageLimitWindow[]
  observedAt: number
}

/**
 * Ask the desktop to say what it knows of the usage limits, for the chat this
 * socket follows: answered by a `result` under `requestId`, then a
 * `usageLimits` frame now and on every change, until the socket follows
 * another chat or closes. Sent again after each subscription's fence. A
 * desktop without `conversation-usage-limits` answers it `ok: false` with
 * `invalid_frame`.
 */
export type ConversationWatchUsageLimitsRequest = { type: 'watchUsageLimits'; requestId: string }

/**
 * The desktop's usage limits, whole each time: the chat's `notice` (null for
 * a chat no limit has stopped), whether it resumes every such chat by itself
 * (`autoResume`), and each plan's windows (`limits`, empty before any agent
 * there has reported).
 */
export type ConversationUsageLimitsFrame = {
  type: 'usageLimits'
  key: ConversationWireKey
  notice: ConversationUsageLimitNotice | null
  autoResume: boolean
  limits: ConversationUsageLimitSnapshot[]
}

/** The most plans, and windows of one plan, a `usageLimits` frame names. */
export const CONVERSATION_MAX_USAGE_LIMIT_PLANS = 8
export const CONVERSATION_MAX_USAGE_LIMIT_WINDOWS = 16

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

// What a provider may call one of its reasoning effort levels: as short and
// as plain as a mode id.
const REASONING_EFFORT = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/

/** Whether a value can be a reasoning effort level. A desktop checks it against the chat's provider as well. */
export function isConversationReasoningEffortId(value: unknown): value is string {
  return typeof value === 'string' && REASONING_EFFORT.test(value)
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
