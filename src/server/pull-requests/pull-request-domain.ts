import type {
  StudioPullRequest,
  StudioPullRequestOwner,
  StudioPullRequestsMethodMap,
  StudioPullRequestsTarget,
} from '../../../packages/studio-protocol/src/public'
import type {
  ConversationEvent,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
} from '../../shared/conversation-runtime'
import type { BranchPullRequest } from '../../shared/git/pull-request'
import { isPullRequestCreation, readOpenedPullRequest } from '../../shared/git/pull-request-opened'
import { resolveCheckoutForCwd } from '../../main/checkout-resolve'
import {
  createPullRequestRecord,
  type NoteOpenedOutcome,
  type PullRequestCheckout,
  type PullRequestConversationKey,
  type PullRequestRecord,
  type PullRequestRecordOptions,
  type WatchOutcome,
} from './pull-request-record'
import { createPullRequestWakes, type PullRequestWakes, type PullRequestWakesDeps } from './pull-request-wakes'

// The pull request record as a server domain (owner ruling 2026-10-03):
// features that react to chats live in the server, and every client displays
// the result through the protocol. This is where the record hears that a
// conversation opened a pull request, and what it answers on `pullRequests.*`.
//
// A conversation owns the pull requests its agent opened (owner ruling
// 2026-10-04), heard three ways, all of them read by the one reader in
// `src/shared/git/pull-request-opened.ts` or checked by the one classifier
// beside it:
//
// - A chat's tool call: a create command or tool starts (`tool_started`), and
//   its final output (`tool_output`) names the pull request.
// - A terminal agent's tool call, which the server does not run: the client
//   that runs it forwards what its hook saw (`pullRequests.noteToolCall`), and
//   it is read here exactly as a chat's is.
// - The agent says so itself, through the Studio gateway's
//   `pull_request.link` (`linkForAgent` below), or the person does, through
//   the desktop's "Create PR" (`pullRequests.link`, `link` below).
//
// A conversation's own checkout is noted at a chat's turn end and when a
// client says where one of its agents is (`pullRequests.noteWork`). That only
// decides which of its pull requests are from the branch it is on; it never
// adds one.
//
// An agent can also ask Studio to babysit one of its pull requests (the
// gateway's `pull_request.watch`): the record reads it on its watch and
// decides what is news, and the news wakes the chat here
// (`pull-request-wakes.ts`). The watch stops when the pull request lands, when
// the agent or the person stops it (`pull_request.unwatch`,
// `pullRequests.unwatch`), and when its chat is settled or deleted.

/** The most create calls waiting on their output at once; a call whose output never comes (a stopped turn) goes first. */
const MAX_PENDING_CALLS = 200

export type PullRequestsChanged = { workspaceIds: string[]; conversations: StudioPullRequestOwner[] }

/** What the protocol serves; `StudioRpc` takes this. */
export type StudioPullRequests = {
  list(target: StudioPullRequestsTarget): Promise<StudioPullRequestsMethodMap['pullRequests.list']['result']>
  refresh(target: StudioPullRequestsTarget): Promise<{ asked: boolean }>
  noteWork(input: StudioPullRequestsMethodMap['pullRequests.noteWork']['params']): Promise<void>
  noteToolCall(input: StudioPullRequestsMethodMap['pullRequests.noteToolCall']['params']): Promise<void>
  /** An owner opened this pull request for the conversation (the desktop's "Create PR"). */
  link(
    input: StudioPullRequestsMethodMap['pullRequests.link']['params'],
  ): Promise<
    | { ok: true; recorded: boolean; pullRequest: StudioPullRequest }
    | { ok: false; code: 'not_a_pull_request' | 'opened_by_another_conversation'; message: string }
  >
  /**
   * An owner stops a conversation's watch on one of its pull requests (the
   * desktop's "Stop watching"). Absent, the Studio does not advertise
   * `pull-request-watch`.
   */
  unwatch?(input: StudioPullRequestsMethodMap['pullRequests.unwatch']['params']): Promise<{ watched: boolean }>
  onChanged(listener: (change: PullRequestsChanged) => void): () => void
}

export type PullRequestDomain = StudioPullRequests & {
  readonly record: PullRequestRecord
  /** An agent says it opened this pull request: the gateway's `pull_request.link`. */
  linkForAgent(key: PullRequestConversationKey, input: { url: string; title?: string }): Promise<NoteOpenedOutcome>
  /** An agent asks Studio to watch its pull request: the gateway's `pull_request.watch`. */
  watchForAgent(key: PullRequestConversationKey, input: { url: string }): Promise<WatchOutcome>
  /** An agent stops a watch it asked for: the gateway's `pull_request.unwatch`. */
  unwatchForAgent(key: PullRequestConversationKey, input: { url: string }): boolean
  /** Stop every watch whose chat is no longer one to wake (settled, deleted); asked when the chats' records move. */
  pruneWatches(): void
  /** The computer woke or was unlocked: news waiting on a timer looks again. */
  wakeWatches(): void
  /** Settle what is in flight: a quit's leg. */
  flush(): Promise<void>
  dispose(): void
}

export type PullRequestDomainOptions = {
  dataDir: string
  /** The chats: their events, the folder each session works in, and a tool's whole output. */
  conversations: {
    onEvent(listener: (event: ConversationEvent) => void): () => void
    sessionWorkspaceRoot?(sessionId: string): string | null
    getToolDetail?(input: ConversationToolDetailInput): Promise<ConversationToolDetailResult>
  }
  /** A workspace's folder, for a chat whose session's own folder is not known. */
  workspaceFolder(workspaceId: string): string | null
  /** The record, built here unless given (tests). */
  record?: PullRequestRecord
  /** Passed to the record this builds. */
  recordOptions?: Omit<PullRequestRecordOptions, 'userDataDir' | 'onRecordChanged'>
  /** The checkout a folder is in and the branch it is on; null when it is not a checkout on a branch. */
  resolveCheckout?(path: string): Promise<PullRequestCheckout | null>
  /**
   * How a watch's news reaches its chat (`pull-request-wakes.ts`). Absent,
   * watches are read and shown but wake nobody: a test, or a server with no
   * chats to send into.
   */
  wakes?: Omit<PullRequestWakesDeps, 'onChatGone' | 'onConversationEvent'>
  log?(message: string, error?: unknown): void
}

export function createPullRequestDomain(options: PullRequestDomainOptions): PullRequestDomain {
  const listeners = new Set<(change: PullRequestsChanged) => void>()
  const log =
    options.log ??
    ((message: string, error?: unknown) => {
      console.warn(`[pull-requests] ${message}`, error ?? '')
    })
  let disposed = false

  // A chat deleted or put away has nobody to wake: its watches stop.
  const stopWatchesOf = (key: PullRequestConversationKey) => {
    for (const watched of record.watches())
      if (watched.conversation.workspaceId === key.workspaceId && watched.conversation.agentId === key.agentId)
        record.unwatch(key, watched.url)
  }
  const wakes: PullRequestWakes | null = options.wakes
    ? createPullRequestWakes({
        ...options.wakes,
        onConversationEvent: (listener) => options.conversations.onEvent(listener),
        onChatGone: stopWatchesOf,
      })
    : null

  const record =
    options.record ??
    createPullRequestRecord({
      loadStoredOnStart: true,
      ...options.recordOptions,
      userDataDir: options.dataDir,
      onRecordChanged: (change) => publish(change),
      onWatchNews: (news) => wakes?.deliver(news),
      logWarning: options.recordOptions?.logWarning ?? ((message, error) => log(message, error)),
    })

  function publish(change: PullRequestsChanged): void {
    if (disposed || (change.workspaceIds.length === 0 && change.conversations.length === 0)) return
    for (const listener of [...listeners]) {
      try {
        listener(change)
      } catch (error) {
        log('a pull request listener failed', error)
      }
    }
  }

  const resolveCheckout = options.resolveCheckout ?? defaultResolveCheckout

  function workspaceRootOf(sessionId: string, workspaceId: string): string | null {
    return options.conversations.sessionWorkspaceRoot?.(sessionId) ?? options.workspaceFolder(workspaceId)
  }

  // ── Chats: a create call and its output, and a turn's end ─────────────────

  type PendingCall = { key: PullRequestConversationKey; name: string; input: unknown }
  /** Session + tool call → a create call waiting on its output. */
  const pending = new Map<string, PendingCall>()

  async function readChatCall(event: ConversationEvent, call: PendingCall, toolUseId: string): Promise<void> {
    const payload = event.payload ?? {}
    let output: unknown = payload.output ?? payload.preview ?? ''
    // The event carries a bounded preview of a long output; the URL may be
    // past it, so the whole output is read from the tool's detail.
    if (payload.truncated === true && options.conversations.getToolDetail) {
      const workspaceRoot = workspaceRootOf(event.sessionId, call.key.workspaceId)
      if (workspaceRoot) {
        const detail = await options.conversations
          .getToolDetail({ workspaceRoot, workspaceId: call.key.workspaceId, agentId: call.key.agentId, toolUseId })
          .catch(() => null)
        if (detail?.ok) output = detail.detail.output
      }
    }
    const opened = readOpenedPullRequest({
      name: call.name,
      input: call.input,
      output,
      failed: payload.status === 'error' || payload.isError === true,
    })
    if (opened && !disposed) await record.noteOpened(call.key, { url: opened.url })
  }

  const stopEvents = options.conversations.onEvent((event) => {
    if (disposed || !event.workspaceId || !event.agentId || !event.sessionId) return
    const key = { workspaceId: event.workspaceId, agentId: event.agentId }
    if (event.type === 'tool_started' || event.type === 'tool_output') {
      const toolUseId = toolUseIdOf(event)
      if (!toolUseId) return
      const id = `${event.sessionId}\0${toolUseId}`
      if (event.type === 'tool_started') {
        const name = typeof event.payload?.name === 'string' ? event.payload.name : ''
        const input: unknown = event.payload?.input
        if (!isPullRequestCreation({ name, input })) return
        pending.delete(id)
        pending.set(id, { key, name, input })
        while (pending.size > MAX_PENDING_CALLS) {
          const oldest = pending.keys().next().value
          if (oldest === undefined) break
          pending.delete(oldest)
        }
        return
      }
      if (event.payload?.partial === true) return
      const call = pending.get(id)
      if (!call) return
      pending.delete(id)
      void readChatCall(event, call, toolUseId).catch((error) => log('could not read a tool call', error))
      return
    }
    if (event.type === 'turn_completed' || event.type === 'turn_failed') {
      const root = workspaceRootOf(event.sessionId, event.workspaceId)
      if (!root) return
      void resolveCheckout(root)
        .then((home) => {
          if (home && !disposed) record.noteCheckout(key, home)
        })
        .catch((error) => log('could not read a checkout', error))
      return
    }
    if (event.type === 'session_closed') {
      for (const id of pending.keys()) if (id.startsWith(`${event.sessionId}\0`)) pending.delete(id)
    }
  })

  // ── What the protocol serves ───────────────────────────────────────────────

  async function list(
    target: StudioPullRequestsTarget,
  ): Promise<StudioPullRequestsMethodMap['pullRequests.list']['result']> {
    // A list asked for before the stored record is read would be empty, and
    // a client would draw no marks until the next change: wait for it.
    await record.whenLoaded()
    const workspaces: Record<string, StudioPullRequest[]> = {}
    for (const workspaceId of target.workspaceIds ?? []) {
      const found = record.forWorkspace(workspaceId)
      if (found.length > 0) workspaces[workspaceId] = found.map(toWire)
    }
    const conversations: Array<StudioPullRequestOwner & { pullRequests: StudioPullRequest[] }> = []
    for (const key of target.conversations ?? []) {
      const found = record.forConversation(key)
      if (found.length > 0) conversations.push({ ...key, pullRequests: found.map(toWire) })
    }
    return { workspaces, conversations }
  }

  return {
    record,
    list,
    async refresh(target) {
      const workspaceIds = target.workspaceIds ?? []
      const keys = target.conversations ?? []
      if (workspaceIds.length === 0 && keys.length === 0) {
        record.refreshOutstanding()
        return { asked: true }
      }
      await record.whenLoaded()
      let asked = false
      for (const workspaceId of workspaceIds) if (record.refreshWorkspace(workspaceId)) asked = true
      for (const key of keys) if (record.refreshConversation(key)) asked = true
      return { asked }
    },
    async noteWork(input) {
      if (disposed) return
      if (input.checkout) record.noteCheckout(input.conversation, input.checkout)
      if (input.turnEnded === true) {
        await record.whenLoaded()
        record.refreshConversation(input.conversation)
      }
    },
    async noteToolCall(input) {
      if (disposed) return
      const opened = readOpenedPullRequest(input.toolCall)
      if (opened) await record.noteOpened(input.conversation, { url: opened.url })
    },
    linkForAgent(key, input) {
      return record.noteOpened(key, input)
    },
    watchForAgent(key, input) {
      return record.watch(key, input)
    },
    unwatchForAgent(key, input) {
      return record.unwatch(key, input.url)
    },
    async unwatch(input) {
      await record.whenLoaded()
      return { watched: record.unwatch(input.conversation, input.url) }
    },
    pruneWatches() {
      const chat = options.wakes?.chat
      if (!chat || disposed) return
      for (const watched of record.watches()) {
        const found = chat(watched.conversation)
        if (!found || found.settled) record.unwatch(watched.conversation, watched.url)
      }
    },
    wakeWatches() {
      wakes?.wake()
    },
    async link(input) {
      const outcome = await record.noteOpened(input.conversation, {
        url: input.url,
        ...(input.title ? { title: input.title } : {}),
      })
      if (!outcome.ok) return outcome
      return { ok: true, recorded: outcome.recorded, pullRequest: toWire(outcome.pullRequest) }
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async flush() {
      await record.flush()
    },
    dispose() {
      disposed = true
      wakes?.dispose()
      stopEvents()
      pending.clear()
      listeners.clear()
      record.dispose()
    },
  }
}

/** A record entry as the protocol carries it: no ids of who opened it. */
function toWire(entry: BranchPullRequest): StudioPullRequest {
  return {
    url: entry.url,
    repoKey: entry.repoKey,
    repoName: entry.repoName,
    number: entry.number,
    title: entry.title,
    state: entry.state,
    isDraft: entry.isDraft,
    openedAt: entry.openedAt,
    stateAt: entry.stateAt,
    ...(typeof entry.endedAt === 'number' ? { endedAt: entry.endedAt } : {}),
    ...(entry.forge ? { forge: entry.forge } : {}),
    ...(entry.onSessionBranch ? { onConversationBranch: true as const } : {}),
    ...(entry.watch ? { watch: entry.watch } : {}),
  }
}

function toolUseIdOf(event: ConversationEvent): string | null {
  const id = event.payload?.toolUseId ?? event.payload?.toolCallId
  return typeof id === 'string' && id.length > 0 ? id : null
}

async function defaultResolveCheckout(path: string): Promise<PullRequestCheckout | null> {
  const facts = await resolveCheckoutForCwd(path)
  if (!facts || facts.missing || !facts.gitRoot || !facts.branch) return null
  return { gitRoot: facts.gitRoot, branch: facts.branch }
}
