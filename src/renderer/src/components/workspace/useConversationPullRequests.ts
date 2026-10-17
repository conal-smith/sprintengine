import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { StudioClient } from '../../../../../packages/agent-sdk/src/index'
import {
  STUDIO_PULL_REQUEST_LINK_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_PULL_REQUESTS_CAPABILITY,
  STUDIO_PULL_REQUESTS_MAX_IDS,
  type StudioPullRequest,
} from '../../../../../packages/studio-protocol/src/public'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import { watchWindowStudio, windowStudioClient, windowStudioState } from '../../studio/windowStudioClient'

// The pull requests a CONVERSATION holds, for the sidebar rows that have
// nothing running in them (owner, 2026-09-10).
//
// The problem it solves, in the owner's words: "there is an agent who has an
// open pull request… he is no longer active, but it doesn't show on his card
// that he has an open pull request. If I'm scanning through the old chats I
// don't know is there a pull request open that I'm missing."
//
// A live session's marks already arrive on the terminal snapshot and this hook
// deliberately does not touch them — a row with a live agent reads that, and
// this fills in only where there is no session left to read. Two sources, one
// per row, chosen by whether the row has a line of its own: see
// `pullRequestsForRow`.
//
// The record is the Studio server's (owner ruling 2026-10-03), so this reads
// it the way any client does: `pullRequests.list` by workspace over the
// window's Studio connection, in process and out of process alike, asked
// again when `pullRequests.changed` names what moved and when the connection
// comes back. A window coming to the front asks the server to look again.

export type ConversationPullRequests = Readonly<Record<string, readonly BranchPullRequest[]>>

const NONE: ConversationPullRequests = {}
// Asked, and there is nobody to ask: a window whose Studio does not serve pull
// requests. Not `NONE`, so the answer reads as given (nothing is known, and
// nothing will be) rather than as still on its way.
const UNSERVED: ConversationPullRequests = {}

/**
 * Whether the hook's answer is in, for a decision that must not be taken on
 * "no pull requests" before the list has been read: the rest sweep, which
 * keeps a chat with an open pull request, on its first tick after a launch.
 */
export function pullRequestsRead(value: ConversationPullRequests): boolean {
  return value !== NONE
}

/**
 * One ask per changed set, coalesced across a burst. Several pull requests can
 * move at once (a window's return re-reads every stale one), and each one
 * pushes; the sidebar must not send a request per push.
 */
const COALESCE_MS = 250

/** The window's Studio client, when it serves pull requests; null otherwise (or in a test with no window). */
async function pullRequestClient(): Promise<StudioClient | null> {
  const api = typeof window === 'undefined' ? null : window.api
  if (typeof api?.studioConnect !== 'function') return null
  try {
    const client = await windowStudioClient(api)
    return client.supports(STUDIO_PULL_REQUESTS_CAPABILITY) ? client : null
  } catch {
    return null
  }
}

/**
 * @param workspaceIds The conversations on screen. The hook keys its effect on
 *   the joined ids, so a caller rebuilding the array every render is fine, but
 *   the ids themselves changing re-asks.
 */
export function useConversationPullRequests(workspaceIds: readonly string[]): ConversationPullRequests {
  const [byWorkspace, setByWorkspace] = useState<ConversationPullRequests>(NONE)
  const key = useMemo(() => [...workspaceIds].sort().join('\0'), [workspaceIds])
  const idsRef = useRef<readonly string[]>(workspaceIds)
  idsRef.current = workspaceIds
  const aliveRef = useRef(true)
  // Asks overlap (a push during a set change), and only the latest may
  // answer: the answer REPLACES what is drawn, so an earlier one for an older
  // set of ids landing last would drop the marks of every row added since.
  const latestRef = useRef(0)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const ask = useCallback(async (): Promise<void> => {
    const asked = ++latestRef.current
    const ids = idsRef.current
    if (ids.length === 0) {
      setByWorkspace((current) => (current === NONE ? current : NONE))
      return
    }
    const client = await pullRequestClient()
    if (!client) {
      if (aliveRef.current && asked === latestRef.current)
        setByWorkspace((current) => (current === NONE ? UNSERVED : current))
      return
    }
    try {
      const answer: Record<string, BranchPullRequest[]> = {}
      for (let start = 0; start < ids.length; start += STUDIO_PULL_REQUESTS_MAX_IDS) {
        const page = await client.request('pullRequests.list', {
          workspaceIds: ids.slice(start, start + STUDIO_PULL_REQUESTS_MAX_IDS),
        })
        for (const [workspaceId, list] of Object.entries(page.workspaces)) answer[workspaceId] = list.map(fromWire)
      }
      if (!aliveRef.current || asked !== latestRef.current) return
      // Replace rather than merge. The answer is the whole truth for the ids
      // asked about, and merging would keep a conversation's marks alive after
      // its row left the list — which is how a stale count survives a filter.
      // The first answer always lands, an empty one included: it is what
      // tells `pullRequestsRead` the list has been read.
      setByWorkspace((current) => (current !== NONE && sameLists(current, answer) ? current : answer))
    } catch {
      // A read that reached nobody leaves what is on screen alone. A mark must
      // never blink out because one request failed (the record's own rule).
    }
  }, [])

  // Ask when the set of conversations changes, and once on mount.
  useEffect(() => {
    void ask()
  }, [ask, key])

  // …and whenever the server says something moved, or the connection comes
  // back from a server restart. The ids on a push are not filtered against what
  // is on screen: the answer is filtered by the ask itself.
  useAskWhenPullRequestsMove(ask)

  return byWorkspace
}

/** Workspace → agent → the pull requests that agent's conversation opened. */
export type PullRequestsByConversation = Readonly<Record<string, ConversationPullRequests>>

const NO_CONVERSATIONS: PullRequestsByConversation = {}

/**
 * The pull requests each of these CONVERSATIONS opened (a workspace and one
 * agent in it), for the sidebar's chat lines: a chat line wears its own
 * conversation's pull requests, not every one its workspace holds. The record
 * files a pull request under the conversation whose agent opened it (owner
 * ruling 2026-10-04), so this asks by conversation, as the open chat's strip
 * does. Filed by workspace, and a workspace's map keeps its identity while
 * its lists draw the same, so a memoized row re-renders only for its own.
 */
export function usePullRequestsByConversation(
  conversations: readonly { workspaceId: string; agentId: string }[],
): PullRequestsByConversation {
  const [byWorkspace, setByWorkspace] = useState<PullRequestsByConversation>(NO_CONVERSATIONS)
  const key = useMemo(
    () =>
      conversations
        .map((entry) => `${entry.workspaceId}\0${entry.agentId}`)
        .sort()
        .join('\n'),
    [conversations],
  )
  const keysRef = useRef(conversations)
  keysRef.current = conversations
  const aliveRef = useRef(true)
  const latestRef = useRef(0)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])
  const ask = useCallback(async (): Promise<void> => {
    const asked = ++latestRef.current
    const keys = keysRef.current
    if (keys.length === 0) {
      setByWorkspace((current) => (current === NO_CONVERSATIONS ? current : NO_CONVERSATIONS))
      return
    }
    const client = await pullRequestClient()
    if (!client) return
    try {
      const answer: Record<string, Record<string, BranchPullRequest[]>> = {}
      for (let start = 0; start < keys.length; start += STUDIO_PULL_REQUESTS_MAX_IDS) {
        const page = await client.request('pullRequests.list', {
          conversations: keys
            .slice(start, start + STUDIO_PULL_REQUESTS_MAX_IDS)
            .map(({ workspaceId, agentId }) => ({ workspaceId, agentId })),
        })
        for (const entry of page.conversations) {
          ;(answer[entry.workspaceId] ??= {})[entry.agentId] = entry.pullRequests.map(fromWire)
        }
      }
      if (!aliveRef.current || asked !== latestRef.current) return
      setByWorkspace((current) => {
        const next: Record<string, ConversationPullRequests> = {}
        let changed = Object.keys(current).length !== Object.keys(answer).length
        for (const [workspaceId, lists] of Object.entries(answer)) {
          const previous = current[workspaceId]
          if (previous && sameLists(previous, lists)) next[workspaceId] = previous
          else {
            next[workspaceId] = lists
            changed = true
          }
        }
        return changed ? next : current
      })
    } catch {
      // A read that reached nobody leaves what is on screen alone.
    }
  }, [])
  useEffect(() => {
    void ask()
  }, [ask, key])
  useAskWhenPullRequestsMove(ask)
  return byWorkspace
}

/**
 * The pull requests ONE conversation opened, newest first: what the open
 * chat's composer strip shows (owner ruling 2026-10-04). The same record and
 * the same protocol as the sidebar's rows, asked by conversation rather than
 * by workspace. Null asks nothing (a chat on a paired machine, whose record
 * is that machine's).
 */
export function usePullRequestsOfConversation(
  conversation: { workspaceId: string; agentId: string } | null,
): readonly BranchPullRequest[] {
  const [list, setList] = useState<readonly BranchPullRequest[]>(EMPTY)
  const workspaceId = conversation?.workspaceId ?? null
  const agentId = conversation?.agentId ?? null
  // Only the latest ask answers: one for the conversation this view showed
  // before landing last would put that conversation's pull requests here.
  const latestRef = useRef(0)
  const ask = useCallback(async (): Promise<void> => {
    const asked = ++latestRef.current
    if (!workspaceId || !agentId) {
      setList((current) => (current === EMPTY ? current : EMPTY))
      return
    }
    const client = await pullRequestClient()
    if (!client) return
    try {
      const page = await client.request('pullRequests.list', { conversations: [{ workspaceId, agentId }] })
      const found = page.conversations.find((entry) => entry.workspaceId === workspaceId && entry.agentId === agentId)
      const next = found ? found.pullRequests.map(fromWire) : EMPTY
      if (asked !== latestRef.current) return
      setList((current) => (sameList(current, next) ? current : next))
    } catch {
      // A read that reached nobody leaves what is on screen alone.
    }
  }, [workspaceId, agentId])
  useEffect(() => {
    // Another conversation's list is not this one's while the ask is out.
    setList((current) => (current === EMPTY ? current : EMPTY))
    void ask()
  }, [ask])
  useAskWhenPullRequestsMove(ask)
  return list
}

/**
 * Record a pull request the person just opened from the chat's "Create PR" as
 * the conversation's, through the same record the gateway's tool and the
 * captured create commands write. Never throws.
 */
export async function linkPullRequestToConversation(
  conversation: { workspaceId: string; agentId: string },
  url: string,
  title: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const client = await pullRequestClient()
  if (!client?.supports(STUDIO_PULL_REQUEST_LINK_CAPABILITY)) {
    return { ok: false, message: `The pull request is open (${url}), but this Studio cannot record it.` }
  }
  try {
    await client.request('pullRequests.link', { conversation, url, title })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: `The pull request is open (${url}), but it could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Stop Studio watching a pull request for the conversation: the person's
 * "Stop watching". The list moves through `pullRequests.changed`, as for any
 * other change; `watched` says whether this conversation was the one watching
 * it. Never throws.
 */
export async function unwatchPullRequest(
  conversation: { workspaceId: string; agentId: string },
  url: string,
): Promise<{ ok: true; watched: boolean } | { ok: false; message: string }> {
  const client = await pullRequestClient()
  if (!client?.supports(STUDIO_PULL_REQUEST_WATCH_CAPABILITY)) {
    return { ok: false, message: 'This Studio cannot stop the watch.' }
  }
  try {
    const answer = await client.request('pullRequests.unwatch', { conversation, url })
    return { ok: true, watched: answer.watched }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Ask again whenever the server says pull requests moved, when the window's
 * Studio connection comes back, and ask the server to re-read stale states
 * when the window comes to the front (decision 9).
 */
function useAskWhenPullRequestsMove(ask: () => Promise<void>): void {
  useEffect(() => {
    const api = typeof window === 'undefined' ? null : window.api
    if (typeof api?.studioConnect !== 'function') return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    let stop: (() => void) | null = null
    const schedule = () => {
      if (timer || !alive) return
      timer = setTimeout(() => {
        timer = null
        void ask()
      }, COALESCE_MS)
    }
    // A client that reconnects keeps its subscription; one that closed for
    // good is replaced by a new client, which needs one of its own.
    let subscribed: StudioClient | null = null
    const subscribe = () => {
      void pullRequestClient().then((client) => {
        if (!client || !alive || client === subscribed) return
        stop?.()
        subscribed = client
        stop = client.subscribe('pullRequests.changed', {}, { onPayload: schedule })
      })
    }
    subscribe()
    const unwatch = watchWindowStudio(api, () => {
      if (windowStudioState(api) !== 'open') return
      subscribe()
      schedule()
    })
    // Coming back to the app is the cheapest moment to notice a pull request
    // that merged while it was in the background (decision 9).
    const onFocus = () => {
      void pullRequestClient().then((client) => client?.request('pullRequests.refresh', {}).catch(() => undefined))
    }
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      stop?.()
      unwatch()
      window.removeEventListener('focus', onFocus)
    }
  }, [ask])
}

/** A wire entry as the marks read it. A workspace's list says nothing about any one branch. */
function fromWire(entry: StudioPullRequest): BranchPullRequest {
  const { onConversationBranch: _onBranch, ...rest } = entry
  return rest
}

/** Whether two lists draw the same: URL, state, draft and number, in order. */
function sameList(a: readonly BranchPullRequest[], b: readonly BranchPullRequest[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, i) =>
        entry.url === b[i].url &&
        entry.state === b[i].state &&
        entry.isDraft === b[i].isDraft &&
        entry.title === b[i].title &&
        entry.forge === b[i].forge &&
        sameWatch(entry, b[i]),
    )
  )
}

/** Whether two readings of a pull request's watch say the same words. */
function sameWatch(a: BranchPullRequest, b: BranchPullRequest): boolean {
  const left = a.watch
  const right = b.watch
  if (!left || !right) return left === right
  return (
    left.waitingOn === right.waitingOn &&
    left.approved === right.approved &&
    left.autoMerge === right.autoMerge &&
    left.base === right.base &&
    left.failedChecks === right.failedChecks
  )
}

/** Whether two answers say the same thing, so an unchanged read commits nothing. */
function sameLists(a: ConversationPullRequests, b: ConversationPullRequests): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const id of aKeys) {
    const left = a[id]
    const right = b[id]
    if (!right || left.length !== right.length) return false
    for (let i = 0; i < left.length; i += 1) {
      // URL and state are the whole of what a mark draws from; a title moving
      // changes a tooltip, which is not worth a sidebar repaint.
      if (left[i].url !== right[i].url || left[i].state !== right[i].state) return false
      if (left[i].isDraft !== right[i].isDraft) return false
      // When it ended is what Settle on merge reads.
      if (left[i].endedAt !== right[i].endedAt) return false
      // A watch's words are on the row, and whether there is one decides its seat.
      if (!sameWatch(left[i], right[i])) return false
    }
  }
  return true
}

/**
 * Which list a row should draw: its live session's, or the conversation's.
 *
 * A row with a live agent line already has marks from the terminal snapshot and
 * they are the more precise answer — they carry `onSessionBranch`, which is what
 * decides the "landed" diff reading. The conversation's list is the fallback for
 * a row with no line left, and it is deliberately NOT merged into a live one: a
 * conversation's list spans every agent it ever had, and folding that into a
 * running agent's row would put another agent's pull request on this agent's
 * line.
 */
export function pullRequestsForRow(input: {
  /** Whether the row has agent lines of its own, each drawing its own marks. */
  hasLiveLines: boolean
  /** What the conversation holds, from this hook. */
  conversation: readonly BranchPullRequest[] | undefined
}): readonly BranchPullRequest[] {
  // A row with lines has already said everything it has to say, on the lines
  // themselves, where each mark sits beside the agent that opened it. Adding
  // the conversation's list underneath would draw the same pull request twice
  // and put one agent's work on another agent's row.
  if (input.hasLiveLines) return EMPTY
  return input.conversation ?? EMPTY
}

const EMPTY: readonly BranchPullRequest[] = []
