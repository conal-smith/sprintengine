import type { TerminalSessionSnapshot, TerminalSessionsDelta } from '../../../shared/electron-api'

export type TerminalSessionsApi = {
  terminalList(): Promise<TerminalSessionSnapshot[]>
  onTerminalSessionsDelta(cb: (delta: TerminalSessionsDelta) => void): () => void
}

/**
 * What one apply changed, for a consumer that does per-session work and would
 * otherwise redo it for every session on every change.
 */
export type TerminalSessionsChange = {
  /** The sessions this apply added or updated — every session, for a full list. */
  upserted: TerminalSessionSnapshot[]
  /** Ids no longer present. */
  removed: string[]
  /** Whether any rendered field moved (the semantic channel notified). */
  semanticChanged: boolean
  /** A full list (initial load, recovery poll, a new subscriber's catch-up), not a delta. */
  full: boolean
}

function getActivitySignature(activity: TerminalSessionSnapshot['activity']) {
  switch (activity.kind) {
    case 'working':
    case 'idle':
      return [activity.kind, activity.since]
    case 'exited':
      return [activity.kind, activity.at, activity.exitCode]
    case 'failed':
      return [activity.kind, activity.at, activity.exitCode, activity.message ?? '']
  }
}

// The ledger reduced to what changes when it changes: how many files, the two
// running totals, how many edits made them, the newest edit time, and which
// file is at the head of the list.
//
// The edit COUNT is load-bearing, not decoration. An edit that adds and removes
// nothing is the reporter's honest answer for a tool whose result shape it
// cannot count (a NotebookEdit, a MultiEdit from a CLI that reports no patch),
// and the timestamp is a max over out-of-order hook frames, so neither the
// totals nor the time need move when such an edit lands. `edits` always does.
//
// The head path is the whole of the ordering: the ledger is rendered
// newest-first, and the only reordering a fold can produce is promoting one
// file to the front.
//
// The paths themselves are deliberately NOT hashed — five hundred of them is
// tens of kilobytes of string per session, and this runs for every session on
// every broadcast.
function getFileChangesSignature(fileChanges: TerminalSessionSnapshot['fileChanges']) {
  let additions = 0
  let deletions = 0
  let edits = 0
  let lastEditedAt = 0
  for (const change of fileChanges ?? []) {
    // `|| 0` so a malformed entry compares as itself rather than collapsing to
    // the NaN every other malformed entry serializes to.
    additions += change.additions || 0
    deletions += change.deletions || 0
    edits += change.edits || 0
    if (change.lastEditedAt > lastEditedAt) lastEditedAt = change.lastEditedAt
  }
  return [fileChanges?.length ?? 0, additions, deletions, edits, lastEditedAt, fileChanges?.[0]?.path ?? '']
}

// Signature of the session fields a consumer actually renders. Deliberately
// excludes high-frequency noise (notably lastOutputAt), so a broadcast that only
// bumps output timing is treated as unchanged.
export function getTerminalSessionsSignature(sessions: TerminalSessionSnapshot[]): string {
  const rows = [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId)).map(getTerminalSessionSignatureRow)
  return JSON.stringify(rows)
}

/** One session's share of {@link getTerminalSessionsSignature}, so a delta re-signs only what it carries. */
function getTerminalSessionSignature(session: TerminalSessionSnapshot): string {
  return JSON.stringify(getTerminalSessionSignatureRow(session))
}

function getTerminalSessionSignatureRow(session: TerminalSessionSnapshot) {
  return [
    session.sessionId,
    session.processAlive,
    getActivitySignature(session.activity),
    session.kind,
    session.workspaceId ?? '',
    session.agentId ?? '',
    session.terminalId ?? '',
    session.cli ?? '',
    session.cwd ?? '',
    session.executionMode ?? '',
    session.worktreeId ?? '',
    session.worktreePath ?? '',
    session.agentSession?.sessionId ?? '',
    session.agentSession?.executionId ?? '',
    session.exitedAt ?? null,
    // User lock: flips alone (no co-varying field like suspend's
    // processAlive), so it must be in the signature or toggling the lock
    // never re-renders the control.
    session.reapExempt,
    // The only authoritative-phase distinction the bridged `activity` cannot
    // express: awaiting_input reads as idle, yet needs attention. Including the
    // raw phase instead would defeat this signature's purpose — thinking ↔
    // tool_use flips on every tool call are high-frequency noise, like
    // lastOutputAt above. Widen this when more phase detail is actually rendered.
    session.agentState?.phase === 'awaiting_input',
    // The tab hover preview and the auto-title both render this, so a new
    // prompt has to survive the dedupe. Keyed on the timestamp rather than the
    // text: it changes on every submit, including a prompt re-sent verbatim.
    session.lastPrompt?.at ?? null,
    // Observed checkout: the tab glyph and identity card render
    // where the session's hooks last saw it, so a cwd move or git's answer
    // for it must survive the dedupe. `at` is deliberately omitted — it only
    // changes alongside `cwd`.
    session.observedCheckout?.cwd ?? '',
    session.observedCheckout?.resolved ?? false,
    session.observedCheckout?.gitRoot ?? '',
    session.observedCheckout?.branch ?? '',
    session.observedCheckout?.isLinkedWorktree ?? false,
    session.observedCheckout?.missing ?? false,
    // The per-session file ledger and the subagent count: both are numbers a
    // row renders, and both move without any phase moving, so a session that
    // only edited a file would otherwise never re-render. Unlike the
    // thinking ↔ tool_use churn excluded above, these change once per edit
    // and once per subagent — a rate a paint can carry.
    getFileChangesSignature(session.fileChanges),
    session.activeSubagents ?? 0,
    // Context-window usage, for the same reason: a status-line refresh moves
    // no phase and no activity, so a session whose only news is a fuller
    // context would never repaint. Main broadcasts only when the WHOLE
    // percent moves, so this is at most one repaint per percent per session.
    //
    // The percentage ALONE, deliberately. Its `at` moves with it today and
    // only with it, so including it would add nothing — and would quietly
    // couple this signature to that main-process invariant: the day `at`
    // becomes "when we last heard" rather than "when it last moved", every
    // refresh of every session would repaint every window, and nothing here
    // would notice. -1 for absent, which no reading can be: the parser
    // refuses anything outside 0..100, so zero is a reading, not an absence.
    session.contextUsage?.usedPercentage ?? -1,
    // The window the percent is of, which the peek reads as "84k / 200k". It
    // moves on a model switch and on nothing else, so it costs no repaints.
    session.contextUsage?.contextWindowSize ?? -1,
    // The conversation's pull request marks, for the same reason again: a
    // pull request lands on GitHub, or a lookup finally answers, and NO other
    // field on the snapshot moves — so without this term a mark that was blue
    // stayed blue for ever, and a new one only appeared when some
    // unrelated field happened to twitch. The sidebar line and the peek head
    // both read this off the SEMANTIC channel (`useTerminalSessions()`
    // defaults to `live: false`), which is exactly the channel this signature
    // gates.
    //
    // The four fields that are drawn: the URL says which pull request it is
    // (and a new one joining the list is news), the state and the draft flag
    // decide the shape and the tone, and the TITLE is what the peek's tooltip
    // leads with — an entry a hook captured, before marks came from branch
    // lookups alone, loads with an empty title and learns it from GitHub's
    // first read, and that arrival has to repaint.
    // `stateAt` is deliberately excluded, like `contextUsage.at` above: it is
    // re-stamped on every poll whether or not anything was read, so including
    // it would repaint every window on every backoff tick.
    session.pullRequests?.map((pr) => `${pr.url}:${pr.state}:${pr.isDraft}:${pr.title}`).join('|') ?? '',
    // The prompt cache, for the same reason as the context reading: its status
    // line refresh lands on its own, often after the turn's end has already
    // settled everything else, and without this term the tab and the card keep
    // the previous turn's cache — "expired 40m ago" on one that was just warmed.
    session.promptCache
      ? `${session.promptCache.ttl}:${session.promptCache.expiresAt}:${session.promptCache.recacheTokens}`
      : '',
  ]
}

function defaultTerminalSessionsApi(): TerminalSessionsApi {
  return window.api
}

/**
 * Merge one delta entry over what the store holds. An entry without a list
 * means main has not seen that list move since it last sent it, so the list
 * already held stands; a session this store has never seen gets empty lists
 * until the next full list fills them.
 */
function mergeDeltaEntry(
  previous: TerminalSessionSnapshot | undefined,
  entry: TerminalSessionsDelta['upserts'][number],
): TerminalSessionSnapshot {
  return {
    ...entry,
    fileChanges: entry.fileChanges ?? previous?.fileChanges ?? [],
    pullRequests: entry.pullRequests ?? previous?.pullRequests ?? [],
  }
}

type WorkspaceSnapshotCache = { version: number; key: string; sessions: TerminalSessionSnapshot[] }

export function createTerminalSessionsStore(apiProvider: () => TerminalSessionsApi = defaultTerminalSessionsApi) {
  let unsubscribeIpc: (() => void) | null = null
  let subscriberCount = 0
  let hasLiveSnapshot = false
  // Keyed by session id, in main's order; the arrays below are views of it.
  let sessionsById = new Map<string, TerminalSessionSnapshot>()
  // Each session's semantic signature, so a delta re-signs only the sessions it
  // carries instead of every session on every broadcast.
  let signaturesById = new Map<string, string>()
  let liveSessions: TerminalSessionSnapshot[] = []
  let semanticSessions: TerminalSessionSnapshot[] = []
  // Moves every time the semantic channel notifies; the per-workspace views
  // below recompute only when it has.
  let semanticVersion = 0
  const workspaceSnapshots = new Map<string | null, WorkspaceSnapshotCache>()
  let connectionVersion = 0

  const liveListeners = new Set<() => void>()
  const semanticListeners = new Set<() => void>()
  const liveSnapshotListeners = new Set<(sessions: TerminalSessionSnapshot[], change: TerminalSessionsChange) => void>()

  const reportListenerError = (error: unknown) => {
    setTimeout(() => {
      throw error
    }, 0)
  }

  const notify = (listener: () => void) => {
    try {
      listener()
    } catch (error) {
      reportListenerError(error)
    }
  }

  const notifySnapshot = (
    listener: (sessions: TerminalSessionSnapshot[], change: TerminalSessionsChange) => void,
    sessions: TerminalSessionSnapshot[],
    change: TerminalSessionsChange,
  ) => {
    try {
      listener(sessions, change)
    } catch (error) {
      reportListenerError(error)
    }
  }

  const publish = (upserted: TerminalSessionSnapshot[], removed: string[], semanticChanged: boolean, full: boolean) => {
    liveSessions = [...sessionsById.values()]
    hasLiveSnapshot = true
    const change: TerminalSessionsChange = { upserted, removed, semanticChanged, full }
    for (const listener of liveListeners) notify(listener)
    for (const listener of liveSnapshotListeners) notifySnapshot(listener, liveSessions, change)

    if (!semanticChanged) return
    semanticSessions = liveSessions
    semanticVersion += 1
    for (const listener of semanticListeners) notify(listener)
  }

  /** A full list from `terminal:list`: replaces everything held. */
  const applyFull = (sessions: TerminalSessionSnapshot[]) => {
    const nextById = new Map<string, TerminalSessionSnapshot>()
    const nextSignatures = new Map<string, string>()
    let semanticChanged = sessions.length !== signaturesById.size
    for (const session of sessions) {
      nextById.set(session.sessionId, session)
      const signature = getTerminalSessionSignature(session)
      nextSignatures.set(session.sessionId, signature)
      if (signaturesById.get(session.sessionId) !== signature) semanticChanged = true
    }
    const removed = [...sessionsById.keys()].filter((sessionId) => !nextById.has(sessionId))
    sessionsById = nextById
    signaturesById = nextSignatures
    publish(sessions, removed, semanticChanged, true)
  }

  /** A `terminal:sessions-delta`: only the sessions that changed, and the ids that went away. */
  const applyDelta = (delta: TerminalSessionsDelta) => {
    let semanticChanged = false
    const upserted: TerminalSessionSnapshot[] = []
    const removed: string[] = []
    for (const sessionId of delta.removed) {
      if (!sessionsById.delete(sessionId)) continue
      signaturesById.delete(sessionId)
      removed.push(sessionId)
      semanticChanged = true
    }
    for (const entry of delta.upserts) {
      const session = mergeDeltaEntry(sessionsById.get(entry.sessionId), entry)
      sessionsById.set(session.sessionId, session)
      upserted.push(session)
      const signature = getTerminalSessionSignature(session)
      if (signaturesById.get(session.sessionId) !== signature) {
        signaturesById.set(session.sessionId, signature)
        semanticChanged = true
      }
    }
    if (upserted.length === 0 && removed.length === 0) return
    publish(upserted, removed, semanticChanged, false)
  }

  const refresh = async (): Promise<TerminalSessionSnapshot[]> => {
    const version = connectionVersion
    const api = apiProvider() as Partial<TerminalSessionsApi> | undefined
    // Same partial-host tolerance as connect(): quiet emptiness, not a throw.
    if (typeof api?.terminalList !== 'function') return []
    const sessions = await api.terminalList()
    if (subscriberCount === 0 || version !== connectionVersion) return sessions
    applyFull(sessions)
    return sessions
  }

  /**
   * Ask main for the list and say whether the pushes had already delivered it.
   * `missed` means the semantic picture main holds differs from the one the
   * push channel left here — a push went missing somewhere — and the fresh
   * list has now been applied. A push racing the request can read as `missed`
   * once; the next reconcile then reads `in-sync`.
   */
  const reconcile = async (): Promise<'in-sync' | 'missed'> => {
    const before = new Map(signaturesById)
    const sessions = await refresh()
    if (sessions.length !== before.size) return 'missed'
    for (const session of sessions) {
      if (before.get(session.sessionId) !== getTerminalSessionSignature(session)) return 'missed'
    }
    return 'in-sync'
  }

  const connect = () => {
    if (unsubscribeIpc) return
    // A host without the terminal bridge (a partial test harness, an aux
    // window with a narrower preload) gets an empty, quiet store rather than
    // a subscriber-time throw inside React's commit.
    const api = apiProvider() as Partial<TerminalSessionsApi> | undefined
    if (typeof api?.onTerminalSessionsDelta !== 'function' || typeof api.terminalList !== 'function') return
    connectionVersion += 1
    const version = connectionVersion
    unsubscribeIpc = api.onTerminalSessionsDelta(applyDelta)
    void api
      .terminalList()
      .then((sessions) => {
        if (subscriberCount === 0 || !unsubscribeIpc || version !== connectionVersion) return
        applyFull(sessions)
      })
      .catch(() => {})
  }

  const disconnectIfIdle = () => {
    if (subscriberCount > 0) return
    connectionVersion += 1
    unsubscribeIpc?.()
    unsubscribeIpc = null
    hasLiveSnapshot = false
    sessionsById = new Map()
    signaturesById = new Map()
    liveSessions = []
    semanticSessions = []
    semanticVersion += 1
    workspaceSnapshots.clear()
  }

  const subscribe = (listeners: Set<() => void>, listener: () => void): (() => void) => {
    let disposed = false
    const wrapped = () => listener()
    subscriberCount += 1
    listeners.add(wrapped)
    connect()
    return () => {
      if (disposed) return
      disposed = true
      listeners.delete(wrapped)
      subscriberCount = Math.max(0, subscriberCount - 1)
      disconnectIfIdle()
    }
  }

  const subscribeLiveSnapshot = (
    listener: (sessions: TerminalSessionSnapshot[], change: TerminalSessionsChange) => void,
  ): (() => void) => {
    let disposed = false
    const wrapped = (sessions: TerminalSessionSnapshot[], change: TerminalSessionsChange) => listener(sessions, change)
    const hadLiveSnapshot = hasLiveSnapshot
    subscriberCount += 1
    liveSnapshotListeners.add(wrapped)
    connect()
    // A late subscriber catches up on everything, as if it were a full list.
    if (hadLiveSnapshot) {
      notifySnapshot(wrapped, liveSessions, { upserted: liveSessions, removed: [], semanticChanged: true, full: true })
    }
    return () => {
      if (disposed) return
      disposed = true
      liveSnapshotListeners.delete(wrapped)
      subscriberCount = Math.max(0, subscriberCount - 1)
      disconnectIfIdle()
    }
  }

  /**
   * The semantic snapshot narrowed to one workspace's sessions (plus any that
   * name no workspace), as an array whose identity changes only when one of
   * THOSE sessions changed in a rendered way. A workspace's layout used to
   * rebuild its tabs whenever any agent anywhere moved.
   */
  const getWorkspaceSemanticSnapshot = (workspaceId: string | null): TerminalSessionSnapshot[] => {
    const cached = workspaceSnapshots.get(workspaceId)
    if (cached && cached.version === semanticVersion) return cached.sessions
    const sessions = semanticSessions.filter(
      (session) => workspaceId === null || session.workspaceId === workspaceId || session.workspaceId === undefined,
    )
    // `lastInputAt` rides along although the signature leaves it out: a tab's
    // "last typed" label reads it, and the global list used to refresh it
    // whenever anything else moved.
    const key = sessions
      .map((session) => `${signaturesById.get(session.sessionId) ?? session.sessionId}|${session.lastInputAt ?? ''}`)
      .join('\n')
    if (cached && cached.key === key) {
      cached.version = semanticVersion
      return cached.sessions
    }
    workspaceSnapshots.set(workspaceId, { version: semanticVersion, key, sessions })
    return sessions
  }

  return {
    getLiveSnapshot: () => liveSessions,
    getSemanticSnapshot: () => semanticSessions,
    getWorkspaceSemanticSnapshot,
    /** True once main has answered at least once — before that, "no sessions" is "not asked yet". */
    hasSnapshot: () => hasLiveSnapshot,
    refresh,
    reconcile,
    subscribeLive: (listener: () => void) => subscribe(liveListeners, listener),
    subscribeLiveSnapshot,
    subscribeSemantic: (listener: () => void) => subscribe(semanticListeners, listener),
  }
}

const terminalSessionsStore = createTerminalSessionsStore()

export const getLiveTerminalSessionsSnapshot = terminalSessionsStore.getLiveSnapshot
export const getTerminalSessionsSnapshot = terminalSessionsStore.getSemanticSnapshot
export const refreshTerminalSessions = terminalSessionsStore.refresh
export const reconcileTerminalSessions = terminalSessionsStore.reconcile
export const subscribeLiveTerminalSessions = terminalSessionsStore.subscribeLive
export const subscribeLiveTerminalSessionSnapshots = terminalSessionsStore.subscribeLiveSnapshot
export const subscribeTerminalSessions = terminalSessionsStore.subscribeSemantic
export const getWorkspaceTerminalSessionsSnapshot = terminalSessionsStore.getWorkspaceSemanticSnapshot
