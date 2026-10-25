import {
  CONVERSATION_MAX_MESSAGE_CHARS,
  isConversationWirePermissionPreset,
  parseConversationWireModels,
  type ConversationServerFrame,
  type ConversationWireErrorCode,
  type ConversationWireKey,
  type ConversationWirePhase,
  type ConversationWireThread,
} from './index.js'
import {
  CONVERSATION_MAX_QUEUED_MESSAGES,
  isConversationPermissionModeId,
  isConversationReasoningEffortId,
  type ConversationQueuedFrame,
  type ConversationQueuedMessage,
} from './commands.js'

// The client half of the frame contract: what a desktop or phone following a
// conversation accepts from the desktop it follows. `parseConversationClientFrame`
// guards the server against a client; this guards a client against a server
// that is older, newer, or broken. A frame of a known type that does not have
// its documented shape is refused here rather than half-applied, so a client
// never advances its cursor past an event it could not read.

/** The event envelope every `event` frame and snapshot page carries. Payloads stay opaque. */
export type ConversationWireEvent = {
  id: string
  seq?: number
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  type: string
  createdAt: number
  payload?: Record<string, unknown>
}

export type ConversationWirePage = { events: ConversationWireEvent[]; hasMore: boolean; beforeCursor: number | null }

/**
 * A listed conversation under the full contract. A desktop that advertises
 * `conversation-cli-permission-modes` names the CLI's own mode the chat runs
 * at its preset (`permissionMode`, absent for the preset's own) and the modes
 * its provider can run beside the presets (`capabilities.permissionModes`).
 */
export type ConversationThread = Omit<ConversationWireThread, 'capabilities'> & {
  permissionMode?: string
  capabilities?: NonNullable<ConversationWireThread['capabilities']> & {
    permissionModes?: string[]
    /**
     * The chat's provider takes a message into a turn it is running (a
     * `send` that says `steer`), from a desktop that advertises
     * `conversation-steer-sends`. Absent means unknown.
     */
    steer?: boolean
    /**
     * The chat's provider stops one agent it spawned by itself (a
     * `stopSubagent` command), from a desktop that advertises
     * `conversation-stop-subagent`. Absent means unknown.
     */
    stopSubagent?: boolean
    /**
     * The reasoning effort levels the chat's provider runs, from a desktop
     * that advertises `conversation-reasoning-effort`; empty for a provider
     * that runs none. Absent means unknown.
     */
    reasoningEfforts?: string[]
  }
  /**
   * The reasoning effort the chat runs at, one of its provider's
   * `capabilities.reasoningEfforts`, from a desktop that advertises
   * `conversation-reasoning-effort`. Absent for the provider's own default,
   * and from a desktop built before it was listed.
   */
  reasoningEffort?: string
  /**
   * The machine the chat runs on. Absent from a desktop built before it was
   * listed, and for a chat whose machine the desktop cannot name yet.
   */
  host?: ConversationWireHost
  /**
   * The pull requests the chat opened, as the desktop last recorded
   * them, newest first. Absent from a desktop built before it was listed;
   * empty when the chat has none.
   */
  pullRequests?: ConversationWirePullRequest[]
  /**
   * The chat's title as the desktop's own sidebar shows it: the name of the
   * desktop's chat it belongs to, which a rename there changes. `title` stays
   * the agent's name, for clients that read only that. Absent from a desktop
   * built before it was listed, and when the chat has no name there.
   */
  chatTitle?: string
  /**
   * When a person last sent the chat a message, from any device: the key
   * the desktop's sidebar orders its chats by, most recent first, and the
   * order the list arrives in. Absent from a desktop built before it was
   * listed, and for a chat nobody has written to since the desktop kept it;
   * a client orders such a row by `updatedAt`.
   */
  lastUserMessageAt?: number
  /**
   * The moment the desktop's own sidebar orders the chat by: `lastUserMessageAt`
   * when a person has written to it, else when the chat was made there or
   * last typed into in a terminal. A client that interleaves the list with
   * rows of its own orders it by this, so the chat sits where it sits on the
   * desktop it runs on; opening or settling nothing moves it. Absent from a
   * desktop built before it was listed, where a client falls back to
   * `lastUserMessageAt`, then `updatedAt`.
   */
  recencyAt?: number
  /**
   * When the turn the chat is running now began, for a "working for" count
   * that does not restart when an approval resolves or the model changes, as
   * `updatedAt` does. Absent while no turn runs, and from a desktop built
   * before it was listed.
   */
  turnStartedAt?: number
  /**
   * When the chat's current stretch of work began: the person's message that
   * began it, held through the turns the chat opens by itself while its
   * `backgroundWork` goes on (an agent's result or a monitor waking it), where
   * `turnStartedAt` restarts with each. The desktop's own sidebar counts
   * "working for" from it. Present whenever the desktop counts the chat as
   * working: `phase` running or starting, or `backgroundWork` beside a phase
   * that says the turn is over. Absent otherwise, and from a desktop built
   * before it was listed, where a client counts from `turnStartedAt`.
   */
  workingSince?: number
  /**
   * When the chat's agent last finished a turn, or failed one: read from the
   * chat's transcript, so it does not move on a rename, a model switch or a
   * session starting. Absent from a desktop built before it was listed, and
   * for a chat whose agent has not finished one.
   */
  lastTurnEndedAt?: number
  /**
   * When a person last had the chat on screen, on any device: the desktop
   * itself, a phone, another desktop (each device says so with
   * `conversation.visit`). A chat whose `lastTurnEndedAt` is later has a
   * finish nobody has seen yet. Absent from a desktop built before it was
   * listed, and for a chat no visit has been recorded for since; nothing
   * recorded visits before this, so a client reads that absence as seen.
   */
  lastVisitedAt?: number
  /**
   * When the chat was last marked unread, on any device: the moment Mark
   * unread (`conversation.mark_unread`) moved `lastVisitedAt` back. A client
   * that keeps visit readings of its own takes the listed `lastVisitedAt`
   * over a later one of them when this is newer than its reading, which is
   * how a chat marked unread while the client was closed reads as unread
   * there. Absent from a desktop built before it was listed, and for a chat
   * never marked unread.
   */
  visitRewoundAt?: number
  /**
   * The schedule whose run started the chat, by the desktop's own id for it:
   * the desktop marks such a chat with the schedule's clock. Absent for a chat
   * a person or an agent started, and from a desktop built before it was
   * listed.
   */
  scheduledAgentId?: string
  /**
   * When a chat the person snoozed on the desktop wakes. The desktop draws a
   * sleeping chat in its folder's Snoozed shelf and never marks it "finished,
   * unseen"; a client that reads this does the same until the time passes.
   * Absent for a chat that is awake, and from a desktop built before it was
   * listed.
   */
  snoozedUntil?: number
  /**
   * The mark a person put on the chat from its row menu, on any device: a
   * star, and a highlight colour, one of `CONVERSATION_HIGHLIGHT_COLORS`. The
   * desktop draws a starred chat in its Starred section and tints a coloured
   * one's row. Absent for a chat with neither, and from a desktop built before
   * it was listed.
   */
  highlight?: ConversationWireHighlight
  /**
   * The person switched Auto-settle on for the chat: the desktop settles it by
   * itself after three quiet days, or when its pull requests land. Absent when
   * it is off, which is the default, and from a desktop built before it was
   * listed.
   */
  autoSettle?: true
  /**
   * The opening of the agent's last reply, as the desktop's own sidebar
   * previews it under the chat's title: the reply's first characters as
   * written, markdown and all, at most `CONVERSATION_MAX_REPLY_PREVIEW`. Absent
   * from a desktop built before it was listed, and for a chat whose agent has
   * not replied since the person last wrote.
   */
  lastAssistantText?: string
  /**
   * The branch the chat's folder is checked out on there, as its HEAD names
   * it: what the desktop's own sidebar shows on the chat's line. Absent from a
   * desktop built before it was listed, for a folder that is not a
   * repository, and on a detached HEAD.
   */
  branch?: string
  /**
   * What the chat still has working outside a turn: the agents it launched in
   * the background that are still running (`agents`), and the background
   * tasks that will wake its agent when they report (`monitors`: a monitor
   * with a deadline, or a task the agent is told about when it ends). The
   * desktop's own sidebar counts a chat that has either as working while its
   * `phase` says the turn is over. `phase` is left as the turn's, so a client
   * that holds sends while a turn runs does not hold them for these. Absent
   * when nothing works in the background, and from a desktop built before it
   * was listed.
   */
  backgroundWork?: ConversationBackgroundWork
  /**
   * What the chat's checkout carries, in files, as the desktop's own sidebar
   * line and composer strip count it: the files its branch added, updated
   * and removed against the default branch, uncommitted work included, and,
   * in `uncommitted`, those changes alone (what a line shows once the branch
   * has landed by squash). Listed only for a chat with a live session, as
   * the desktop draws a line only for one: a parked chat's numbers would be
   * the checkout's, not the chat's. Read from the desktop's shared reading,
   * held for a few seconds, so a list asked for again runs no git. Absent for
   * a chat at rest, a folder that is not a repository or could not be read,
   * and from a desktop built before it was listed; never a confident zero.
   */
  changes?: ConversationWireChanges
  /**
   * The chat works in a git worktree of its project rather than the project's
   * own checkout: the desktop marks its branch with the worktree glyph.
   * Absent when it does not, and from a desktop built before it was listed.
   */
  worktree?: boolean
}

/** A listed chat's background work (`ConversationThread.backgroundWork`). At least one count is above zero. */
export type ConversationBackgroundWork = { agents: number; monitors: number }

/** Files changed, by what happened to each. */
export type ConversationWireFileCounts = { added: number; updated: number; removed: number }

/**
 * Whose changes a listed chat's counts are: `worktree`, the chat's own
 * worktree's branch; `branch`, the branch the folder is on, which other chats
 * may share; `folder`, only what is uncommitted (a folder on the default
 * branch, or with none to compare against).
 */
export type ConversationWireChangeScope = 'worktree' | 'branch' | 'folder'

const CHANGE_SCOPES: ReadonlySet<string> = new Set<ConversationWireChangeScope>(['worktree', 'branch', 'folder'])

/** A listed chat's changed files (`ConversationThread.changes`). */
export type ConversationWireChanges = ConversationWireFileCounts & {
  /** Absent from a desktop that did not say; a client then reads the counts as the branch's. */
  scope?: ConversationWireChangeScope
  uncommitted?: ConversationWireFileCounts
}

/** The most characters of a reply's opening a listed chat carries. */
export const CONVERSATION_MAX_REPLY_PREVIEW = 240

/**
 * The machine a listed chat runs on, or the desktop itself.
 *
 * `id` is the machine's stable id, the same on every device that sees it:
 * `local` for the desktop the list came from, `wsl:<distro>` for a WSL
 * distribution on it, `ssh:<host>` for an SSH machine and `tailnet:<host>`
 * for a paired machine. A client draws no machine mark for `local`: the chat
 * runs on the machine it is talking to.
 *
 * `kind` and `color` are the person's choice in Settings › Machines, else
 * the defaults. Today `kind` is one of `laptop`, `desktop`, `mini`, `tower`,
 * `server`, `cloud`, `container`, `board` or `wsl`, and `color` one of `blue`,
 * `teal`, `cyan`, `orange`, `yellow`, `violet`, `red` or `neutral`. A newer
 * desktop may add one, so a client draws an unknown kind as a desktop and an
 * unknown colour as the neutral rather than dropping the machine.
 */
export type ConversationWireHost = { id: string; kind: string; label: string; color: string }

/** One pull request a listed chat's branch has. Nothing here is read from GitHub when the list is asked for. */
export type ConversationWirePullRequest = {
  number: number
  state: ConversationWirePullRequestState
  url: string
  title: string
}
export type ConversationWirePullRequestState = 'open' | 'merged' | 'closed'

/** The most pull requests a listed chat carries; a desktop sends at most this many. */
export const CONVERSATION_MAX_PULL_REQUESTS = 20

const PULL_REQUEST_STATES = new Set<ConversationWirePullRequestState>(['open', 'merged', 'closed'])
// A kind or a colour is a short lower-case token. One this client does not
// know still passes: a newer desktop may add one, and the client says so with
// its fallback rather than losing the machine.
const MARK_TOKEN = /^[a-z][a-z0-9-]{0,31}$/

/** A listed chat's machine, or null when it is not one. */
export function parseConversationWireHost(value: unknown): ConversationWireHost | null {
  if (!record(value)) return null
  if (!id(value.id) || !text(value.label, 200) || typeof value.kind !== 'string' || typeof value.color !== 'string')
    return null
  if (!MARK_TOKEN.test(value.kind) || !MARK_TOKEN.test(value.color)) return null
  return { id: value.id, kind: value.kind, label: value.label, color: value.color }
}

/** A listed chat's pull requests: unreadable entries dropped, at most `CONVERSATION_MAX_PULL_REQUESTS`. */
export function parseConversationWirePullRequests(value: unknown): ConversationWirePullRequest[] | null {
  if (!Array.isArray(value)) return null
  const pullRequests: ConversationWirePullRequest[] = []
  for (const entry of value) {
    if (pullRequests.length >= CONVERSATION_MAX_PULL_REQUESTS) break
    if (!record(entry)) continue
    if (!(typeof entry.number === 'number' && Number.isSafeInteger(entry.number) && entry.number > 0)) continue
    if (!PULL_REQUEST_STATES.has(entry.state as ConversationWirePullRequestState)) continue
    if (typeof entry.url !== 'string' || !/^https?:\/\//.test(entry.url) || entry.url.length > 2_000) continue
    if (!text(entry.title, 2_000)) continue
    pullRequests.push({
      number: entry.number,
      state: entry.state as ConversationWirePullRequestState,
      url: entry.url,
      title: entry.title,
    })
  }
  return pullRequests
}

/** A server frame after validation: events and pages are typed, everything else as the protocol declares it. */
export type ConversationParsedServerFrame =
  | Exclude<ConversationServerFrame, { type: 'event' } | { type: 'snapshot' } | { type: 'sessions' }>
  | { type: 'sessions'; requestId: string; sessions: ConversationThread[] }
  | { type: 'event'; event: ConversationWireEvent }
  | {
      type: 'snapshot'
      page: ConversationWirePage
      reset?: true
      generation?: string
      part?: { index: number; total: number }
      key?: ConversationWireKey
    }
  | ConversationQueuedFrame

const SERVER_FRAME_TYPES = new Set([
  'sessions',
  'event',
  'chunk',
  'snapshot',
  'synchronized',
  'subscribeFailed',
  'result',
  'commandResult',
  'error',
  'queued',
])
const PHASES = new Set<ConversationWirePhase>([
  'idle',
  'starting',
  'running',
  'waiting_for_approval',
  'waiting_for_input',
  'failed',
  'completed',
])
// A logical frame is at most 32 MB and a chunk carries 48k characters, so a
// few thousand chunks is the most a well-formed frame can need.
const MAX_CHUNKS = 4096

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function text(value: unknown, max = 20_000): value is string {
  return typeof value === 'string' && value.length <= max
}
/** An epoch-milliseconds time. */
function clock(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
function optional<T>(value: unknown, check: (value: unknown) => value is T): boolean {
  return value === undefined || check(value)
}
/** An error code as a string. Codes this build has never heard of pass: a newer desktop may add one. */
function code(value: unknown): value is ConversationWireErrorCode {
  return typeof value === 'string' && /^[a-z_]{1,64}$/.test(value)
}

/**
 * Whether a frame's `type` is one this protocol version defines. A client
 * ignores a frame of any other type — a newer desktop may send one — but a
 * frame of a known type that `parseConversationServerFrame` refuses is a
 * broken frame.
 */
export function isKnownConversationServerFrameType(value: unknown): boolean {
  return record(value) && typeof value.type === 'string' && SERVER_FRAME_TYPES.has(value.type)
}

/** One event envelope, or null. Unknown event types pass; a client skips what it cannot show. */
export function parseConversationWireEvent(value: unknown): ConversationWireEvent | null {
  if (!record(value)) return null
  if (
    !id(value.id) ||
    !optional(value.seq, integer) ||
    !text(value.sessionId, 200) ||
    !text(value.workspaceId, 200) ||
    !text(value.agentId, 200) ||
    !text(value.providerId, 200) ||
    !text(value.modelId, 400) ||
    typeof value.type !== 'string' ||
    !/^[a-z_]{1,64}$/.test(value.type) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    !optional(value.payload, record)
  )
    return null
  return {
    id: value.id,
    ...(value.seq === undefined ? {} : { seq: value.seq as number }),
    sessionId: value.sessionId,
    workspaceId: value.workspaceId,
    agentId: value.agentId,
    providerId: value.providerId,
    modelId: value.modelId,
    type: value.type,
    createdAt: value.createdAt,
    ...(value.payload === undefined ? {} : { payload: value.payload as Record<string, unknown> }),
  }
}

function page(value: unknown): ConversationWirePage | null {
  if (!record(value) || !Array.isArray(value.events) || typeof value.hasMore !== 'boolean') return null
  if (value.beforeCursor !== null && !integer(value.beforeCursor)) return null
  const events: ConversationWireEvent[] = []
  for (const entry of value.events) {
    const event = parseConversationWireEvent(entry)
    if (!event) return null
    events.push(event)
  }
  return { events, hasMore: value.hasMore, beforeCursor: value.beforeCursor as number | null }
}

function key(value: unknown): ConversationWireKey | null {
  return record(value) && id(value.workspaceId) && id(value.agentId)
    ? { workspaceId: value.workspaceId, agentId: value.agentId }
    : null
}

/**
 * A listed chat's `backgroundWork`, or null: both counts whole and not
 * negative, and one of them above zero. Anything else is left out, and the
 * row reads as a chat with nothing working in the background.
 */
export function parseConversationBackgroundWork(value: unknown): ConversationBackgroundWork | null {
  if (!record(value) || !integer(value.agents) || !integer(value.monitors)) return null
  if (value.agents === 0 && value.monitors === 0) return null
  return { agents: value.agents, monitors: value.monitors }
}

function fileCounts(value: unknown): ConversationWireFileCounts | null {
  return record(value) && integer(value.added) && integer(value.updated) && integer(value.removed)
    ? { added: value.added, updated: value.updated, removed: value.removed }
    : null
}

/**
 * A listed chat's `changes`, or null: every count whole and not negative.
 * An `uncommitted` reading in the wrong shape is left out on its own; the
 * branch's counts still stand.
 */
export function parseConversationWireChanges(value: unknown): ConversationWireChanges | null {
  const counts = fileCounts(value)
  if (!counts) return null
  const uncommitted = record(value) ? fileCounts(value.uncommitted) : null
  const scope =
    record(value) && typeof value.scope === 'string' && CHANGE_SCOPES.has(value.scope)
      ? (value.scope as ConversationWireChangeScope)
      : null
  return { ...counts, ...(scope ? { scope } : {}), ...(uncommitted ? { uncommitted } : {}) }
}

/**
 * The highlight colours a chat's row may wear, as the desktop's row menu
 * offers them. A colour a client does not know is left out of the listed
 * `highlight` rather than drawn as something else.
 */
export const CONVERSATION_HIGHLIGHT_COLORS = ['red', 'orange', 'amber', 'green', 'blue', 'purple', 'pink'] as const
export type ConversationHighlightColor = (typeof CONVERSATION_HIGHLIGHT_COLORS)[number]

/** A chat's star and highlight colour (`ConversationThread.highlight`). Never both off. */
export type ConversationWireHighlight = { starred: boolean; color?: ConversationHighlightColor }

export function isConversationHighlightColor(value: unknown): value is ConversationHighlightColor {
  return typeof value === 'string' && (CONVERSATION_HIGHLIGHT_COLORS as readonly string[]).includes(value)
}

/**
 * A listed `highlight`, or null for anything that says neither a star nor a
 * known colour: the row then reads as one with no mark.
 */
export function parseConversationWireHighlight(value: unknown): ConversationWireHighlight | null {
  if (!record(value)) return null
  const starred = value.starred === true
  const color = isConversationHighlightColor(value.color) ? value.color : null
  if (!starred && !color) return null
  return { starred, ...(color ? { color } : {}) }
}

/** One listed conversation, or null. Capabilities absent or malformed read as unknown, not as refused. */
function thread(value: unknown): ConversationThread | null {
  if (!record(value)) return null
  const listed = key(value)
  if (
    !listed ||
    !text(value.title, 2_000) ||
    !PHASES.has(value.phase as ConversationWirePhase) ||
    typeof value.updatedAt !== 'number' ||
    typeof value.createdAt !== 'number' ||
    !text(value.providerId, 200) ||
    !text(value.modelId, 400) ||
    !integer(value.turnCount) ||
    !integer(value.lastSeq) ||
    !optional(value.sessionId, id)
  )
    return null
  const flags = record(value.capabilities) ? value.capabilities : null
  const flag = (name: string) => flags?.[name] === true
  // A catalog in the wrong shape is left out, like an unknown preset: the
  // model control hides rather than offering rows it could not read.
  const models = value.models === undefined ? null : parseConversationWireModels(value.models)
  const host = value.host === undefined ? null : parseConversationWireHost(value.host)
  const pullRequests = value.pullRequests === undefined ? null : parseConversationWirePullRequests(value.pullRequests)
  const chatTitle = text(value.chatTitle, 2_000) && value.chatTitle.trim() ? value.chatTitle : null
  // A preview past its length is cut rather than refused: it is a sidebar's
  // line, and the row is worth more than the words.
  // A branch name is one line of git's own: anything else is not one, and is left out.
  const branch =
    text(value.branch, 255) &&
    value.branch.trim() === value.branch &&
    value.branch &&
    !/[\s\u0000-\u001f]/u.test(value.branch)
      ? value.branch
      : null
  const backgroundWork = parseConversationBackgroundWork(value.backgroundWork)
  const changes = parseConversationWireChanges(value.changes)
  const highlight = parseConversationWireHighlight(value.highlight)
  const lastAssistantText =
    typeof value.lastAssistantText === 'string' && value.lastAssistantText.trim()
      ? value.lastAssistantText.slice(0, CONVERSATION_MAX_REPLY_PREVIEW)
      : null
  return {
    ...listed,
    title: value.title,
    phase: value.phase as ConversationWirePhase,
    updatedAt: value.updatedAt,
    createdAt: value.createdAt,
    providerId: value.providerId,
    modelId: value.modelId,
    turnCount: value.turnCount,
    lastSeq: value.lastSeq,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId as string }),
    // A preset this client does not know is left out rather than guessed at.
    ...(isConversationWirePermissionPreset(value.permissionPreset) ? { permissionPreset: value.permissionPreset } : {}),
    // A mode only means something beside the preset it belongs to.
    ...(isConversationWirePermissionPreset(value.permissionPreset) &&
    isConversationPermissionModeId(value.permissionMode)
      ? { permissionMode: value.permissionMode }
      : {}),
    ...(isConversationReasoningEffortId(value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(models ? { models } : {}),
    // A machine or a pull request this client cannot read is left out: the
    // row shows no mark rather than a wrong one.
    ...(host ? { host } : {}),
    ...(pullRequests ? { pullRequests } : {}),
    // The lifecycle members: a title or a clock in the wrong shape is left
    // out, and the row reads as from a desktop that does not send it.
    ...(chatTitle ? { chatTitle } : {}),
    ...(clock(value.lastUserMessageAt) ? { lastUserMessageAt: value.lastUserMessageAt } : {}),
    ...(clock(value.recencyAt) ? { recencyAt: value.recencyAt } : {}),
    ...(clock(value.turnStartedAt) ? { turnStartedAt: value.turnStartedAt } : {}),
    ...(clock(value.workingSince) ? { workingSince: value.workingSince } : {}),
    ...(clock(value.lastTurnEndedAt) ? { lastTurnEndedAt: value.lastTurnEndedAt } : {}),
    ...(clock(value.lastVisitedAt) ? { lastVisitedAt: value.lastVisitedAt } : {}),
    ...(clock(value.visitRewoundAt) ? { visitRewoundAt: value.visitRewoundAt } : {}),
    ...(id(value.scheduledAgentId) ? { scheduledAgentId: value.scheduledAgentId } : {}),
    ...(clock(value.snoozedUntil) ? { snoozedUntil: value.snoozedUntil } : {}),
    ...(highlight ? { highlight } : {}),
    ...(value.autoSettle === true ? { autoSettle: true as const } : {}),
    ...(lastAssistantText ? { lastAssistantText } : {}),
    ...(branch ? { branch } : {}),
    ...(backgroundWork ? { backgroundWork } : {}),
    ...(changes ? { changes } : {}),
    ...(value.worktree === true ? { worktree: true } : {}),
    ...(flags
      ? {
          capabilities: {
            images: flag('images'),
            approvals: flag('approvals'),
            questions: flag('questions'),
            planMode: flag('planMode'),
            interrupt: flag('interrupt'),
            checkpoints: flag('checkpoints'),
            ...(Array.isArray(flags.permissionPresets)
              ? { permissionPresets: flags.permissionPresets.filter(isConversationWirePermissionPreset) }
              : {}),
            ...(Array.isArray(flags.permissionModes)
              ? { permissionModes: flags.permissionModes.filter(isConversationPermissionModeId) }
              : {}),
            ...(typeof flags.steer === 'boolean' ? { steer: flags.steer } : {}),
            ...(typeof flags.stopSubagent === 'boolean' ? { stopSubagent: flags.stopSubagent } : {}),
            ...(Array.isArray(flags.reasoningEfforts)
              ? { reasoningEfforts: flags.reasoningEfforts.filter(isConversationReasoningEffortId) }
              : {}),
          },
        }
      : {}),
  }
}

function retry(value: Record<string, unknown>): { retryAfterMs?: number } {
  return integer(value.retryAfterMs) ? { retryAfterMs: value.retryAfterMs } : {}
}

/**
 * Validate one frame from the desktop a client follows, keeping only the
 * members the protocol defines. Null for a frame of an unknown type or of a
 * known type in the wrong shape; `isKnownConversationServerFrameType` tells
 * the two apart.
 */
export function parseConversationServerFrame(value: unknown): ConversationParsedServerFrame | null {
  if (!isKnownConversationServerFrameType(value)) return null
  const frame = value as Record<string, unknown>
  switch (frame.type) {
    case 'sessions': {
      if (!id(frame.requestId) || !Array.isArray(frame.sessions)) return null
      const sessions: ConversationThread[] = []
      for (const entry of frame.sessions) {
        const listed = thread(entry)
        // One unreadable row does not hide the rest of the list.
        if (listed) sessions.push(listed)
      }
      return { type: 'sessions', requestId: frame.requestId, sessions }
    }
    case 'event': {
      const event = parseConversationWireEvent(frame.event)
      return event ? { type: 'event', event } : null
    }
    case 'chunk':
      return id(frame.frameId) &&
        integer(frame.total) &&
        frame.total > 0 &&
        frame.total <= MAX_CHUNKS &&
        integer(frame.index) &&
        frame.index < frame.total &&
        typeof frame.json === 'string'
        ? { type: 'chunk', frameId: frame.frameId, index: frame.index, total: frame.total, json: frame.json }
        : null
    case 'snapshot': {
      const snapshot = page(frame.page)
      if (!snapshot) return null
      if (frame.reset !== undefined && frame.reset !== true) return null
      if (!optional(frame.generation, id)) return null
      const snapshotKey = frame.key === undefined ? undefined : key(frame.key)
      if (snapshotKey === null) return null
      const part = frame.part
      if (
        part !== undefined &&
        !(record(part) && integer(part.total) && part.total > 0 && integer(part.index) && part.index < part.total)
      )
        return null
      return {
        type: 'snapshot',
        page: snapshot,
        ...(frame.reset === true ? { reset: true as const } : {}),
        ...(frame.generation === undefined ? {} : { generation: frame.generation as string }),
        ...(part === undefined
          ? {}
          : { part: { index: (part as { index: number }).index, total: (part as { total: number }).total } }),
        ...(snapshotKey ? { key: snapshotKey } : {}),
      }
    }
    case 'synchronized': {
      const fenceKey = frame.key === undefined ? undefined : key(frame.key)
      return integer(frame.seq) && optional(frame.generation, id) && fenceKey !== null
        ? {
            type: 'synchronized',
            seq: frame.seq,
            ...(frame.generation === undefined ? {} : { generation: frame.generation as string }),
            ...(fenceKey ? { key: fenceKey } : {}),
          }
        : null
    }
    case 'subscribeFailed': {
      const failed = key(frame.key)
      return failed && code(frame.code) && text(frame.message) && typeof frame.retryable === 'boolean'
        ? {
            type: 'subscribeFailed',
            key: failed,
            code: frame.code,
            message: frame.message,
            retryable: frame.retryable,
            ...retry(frame),
          }
        : null
    }
    case 'result':
      return id(frame.requestId) &&
        typeof frame.ok === 'boolean' &&
        optional(frame.code, code) &&
        optional(frame.message, text)
        ? {
            type: 'result',
            requestId: frame.requestId,
            ok: frame.ok,
            ...(frame.data === undefined ? {} : { data: frame.data }),
            ...(frame.code === undefined ? {} : { code: frame.code as ConversationWireErrorCode }),
            ...(frame.message === undefined ? {} : { message: frame.message as string }),
            ...retry(frame),
          }
        : null
    case 'commandResult':
      return id(frame.commandId) &&
        typeof frame.ok === 'boolean' &&
        optional(frame.code, code) &&
        optional(frame.message, text)
        ? {
            type: 'commandResult',
            commandId: frame.commandId,
            ok: frame.ok,
            ...(frame.code === undefined ? {} : { code: frame.code as ConversationWireErrorCode }),
            ...(frame.message === undefined ? {} : { message: frame.message as string }),
            // A notice this client cannot read is dropped; the result itself stands.
            ...(frame.ok === true && typeof frame.notice === 'string' && frame.notice.length <= 2_000
              ? { notice: frame.notice }
              : {}),
            ...retry(frame),
          }
        : null
    case 'error':
      return code(frame.code) && text(frame.message)
        ? { type: 'error', code: frame.code, message: frame.message, ...retry(frame) }
        : null
    case 'queued': {
      const key = frame.key
      if (!record(key) || !id(key.workspaceId) || !id(key.agentId) || !Array.isArray(frame.messages)) return null
      const messages: ConversationQueuedMessage[] = []
      for (const entry of frame.messages) {
        if (messages.length >= CONVERSATION_MAX_QUEUED_MESSAGES) break
        // One unreadable message does not hide the rest.
        if (
          !record(entry) ||
          !id(entry.id) ||
          !text(entry.text, CONVERSATION_MAX_MESSAGE_CHARS) ||
          !clock(entry.createdAt)
        )
          continue
        messages.push({
          id: entry.id,
          text: entry.text,
          createdAt: entry.createdAt,
          ...(typeof entry.failure === 'string' && entry.failure.length <= 2_000 ? { failure: entry.failure } : {}),
        })
      }
      return { type: 'queued', key: { workspaceId: key.workspaceId, agentId: key.agentId }, messages }
    }
    default:
      return null
  }
}
