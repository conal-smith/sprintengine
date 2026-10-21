import { useCallback, useEffect, useRef, useState } from 'react'

import { useWindowPageVisible } from '../../../utils/windowActivity'
import { useTailnetPresence, type TailnetPresence } from '../topbar/useTailnetPresence'
import { publishRemoteConversationList } from './remoteConversationFacts'
import { remoteLinkStateOf, shouldBrowse, type RemoteBrowseEntry, type RemoteLinkState } from './remoteSessionsModel'

// The reads behind the sidebar's Remote band (remote-sessions-in-the-sidebar,
// epic decision 2): an expanded band IS the ask, and the asking is bounded —
// only machines main's last check says are awake, on the transitions that
// change what they hold, and when a machine SAYS it changed. A machine that
// is asleep is never dialled: its last rows stay on screen dimmed, and the
// next reachability event that says it answered is what reads it again.
//
// The change feed (2026-09-05) replaced the thirty-second timer. Main holds
// one idle socket to each paired machine, on which that machine says its
// workspace or conversation list moved, and the band re-reads on that: the
// server owns the state, the client subscribes. The timer
// that remains is a slow fallback for a feed a machine could not open.
//
// A push re-reads only what it names: a conversation push re-lists the
// machine's chats, a workspace push re-browses it. A window
// nobody can see does not re-read at all; it remembers what changed and
// reads once when it is shown again.

/** The fallback re-read of awake machines while the band is open and focused; the change feed is the real beat. */
const REMOTE_BAND_CADENCE_MS = 180_000
/** A machine's change pushes arrive already throttled; a short settle folds the workspace and conversation pushes of one event into one read. */
const REMOTE_CHANGE_SETTLE_MS = 250

export type RemoteSessions = {
  presence: TailnetPresence
  browses: ReadonlyMap<string, RemoteBrowseEntry>
  /** This device's listener is up: the band may draw what it read from over there. */
  listening: boolean
  /**
   * Whether this device is on the tailnet at all — up, down, or not yet known.
   * What the rows that are WINDOWS here are gated on: a chat on another machine
   * is not openable, typable, or readable from a device with no tailnet, so its
   * row goes with the link and comes back with it (owner, 2026-09-13).
   */
  link: RemoteLinkState
  /** Read one machine now, or every machine that may be asked. */
  refresh: (connectionId?: string) => void
}

const EMPTY_ENTRY: RemoteBrowseEntry = { browse: null, loading: false, error: null, at: null }

/** The two reads behind a machine's rows: what it holds (a browse), and its chats (a conversation list). */
type ReadPart = 'browse' | 'conversations'
const EVERY_PART: ReadonlySet<ReadPart> = new Set(['browse', 'conversations'])

function withEntry(
  current: ReadonlyMap<string, RemoteBrowseEntry>,
  connectionId: string,
  update: (entry: RemoteBrowseEntry) => RemoteBrowseEntry,
): ReadonlyMap<string, RemoteBrowseEntry> {
  const next = new Map(current)
  next.set(connectionId, update(current.get(connectionId) ?? EMPTY_ENTRY))
  return next
}

export function useRemoteSessions({ enabled: wanted }: { enabled: boolean }): RemoteSessions {
  const presence = useTailnetPresence()
  // Off the tailnet nothing over there can answer, so nothing is asked
  // (owner ruling 2026-09-05): the band draws only what is open here until
  // the listener is back, and the first read after that is the mount read.
  const listening = presence.status?.running === true
  const link = remoteLinkStateOf(presence.status)
  const enabled = wanted && listening
  const [browses, setBrowses] = useState<ReadonlyMap<string, RemoteBrowseEntry>>(() => new Map())
  const browsesRef = useRef(browses)
  browsesRef.current = browses
  /** Machines being read right now, and what was asked for while each read was out. */
  const inFlight = useRef(new Map<string, ReadonlySet<ReadPart>>())
  const queued = useRef(new Map<string, Set<ReadPart>>())
  // A host without the mesh bridge (partial test harnesses, narrower
  // preloads) gets a band that draws what the rows already know and asks
  // nothing — never a throw inside an effect.
  const bridge = typeof window !== 'undefined' && typeof window.api?.meshBrowse === 'function'
  const conversationBridge = bridge && typeof window.api?.meshConversationList === 'function'
  const visible = useWindowPageVisible()

  const read = useCallback(
    (connectionId: string, parts: ReadonlySet<ReadPart> = EVERY_PART) => {
      if (!bridge) return
      if (inFlight.current.has(connectionId)) {
        // A read is out, and may have left before whatever prompted this one:
        // what is asked now runs when it lands, once.
        const waiting = queued.current.get(connectionId) ?? new Set<ReadPart>()
        for (const part of parts) waiting.add(part)
        queued.current.set(connectionId, waiting)
        return
      }
      const wantBrowse = parts.has('browse')
      const wantList = parts.has('conversations') && conversationBridge
      if (!wantBrowse && !wantList) return
      inFlight.current.set(connectionId, parts)
      if (wantBrowse)
        setBrowses((current) => withEntry(current, connectionId, (entry) => ({ ...entry, loading: true })))
      void (async () => {
        const result = wantBrowse ? await window.api.meshBrowse(connectionId) : null
        // Its chats too, once it has answered: the list is a short socket
        // on the conversation lane. A pairing that may not read them, or a
        // machine that does not serve them, lists none.
        const listed =
          wantList && (result === null || result.reachable)
            ? await window.api.meshConversationList(connectionId).catch(() => null)
            : null
        // The tab of a pane open on one of these chats draws from the same list.
        if (listed?.ok) publishRemoteConversationList(connectionId, listed.conversations)
        setBrowses((current) =>
          withEntry(current, connectionId, (entry) => {
            // A list read on its own keeps the rows it has when it fails: the
            // machine may simply be asleep, which the browse is the one to say.
            const conversations = listed
              ? listed.ok
                ? listed.conversations
                : result
                  ? []
                  : entry.conversations
              : entry.conversations
            // Whether the machine keeps its chats' rest, and what this pairing
            // may do with them, as its newest list said.
            const lifecycle = listed?.ok ? listed.lifecycle === true : entry.lifecycle
            const access = listed?.ok ? listed.access : entry.access
            const listedParts = {
              ...(conversations ? { conversations } : {}),
              ...(lifecycle !== undefined ? { lifecycle } : {}),
              ...(access !== undefined ? { access } : {}),
            }
            if (!result) return { ...entry, at: Date.now(), ...listedParts }
            return {
              // A machine that did not answer keeps its last rows; only an
              // answer replaces them.
              browse: result.reachable ? result : entry.browse,
              loading: false,
              error: result.reachable ? null : (result.unreachableReason ?? 'Not answering.'),
              at: Date.now(),
              ...listedParts,
            }
          }),
        )
      })()
        .catch((error: unknown) => {
          setBrowses((current) =>
            withEntry(current, connectionId, (entry) => ({
              ...entry,
              loading: false,
              error: error instanceof Error ? error.message : String(error),
              at: Date.now(),
            })),
          )
        })
        .finally(() => {
          inFlight.current.delete(connectionId)
          const waiting = queued.current.get(connectionId)
          queued.current.delete(connectionId)
          if (waiting) read(connectionId, waiting)
        })
    },
    [bridge, conversationBridge],
  )
  const browse = useCallback((connectionId: string) => read(connectionId), [read])

  const { mesh, meshReachability, meshRemoteChanges } = presence

  // The change feed: a machine that said it changed is re-read, once its
  // pushes settle, for what it said changed. Keyed by the mesh's revision of
  // each kind, so a re-render of the same push reads nothing, and only
  // machines that may be asked are asked. While the window is out of sight
  // the reads wait here and run once it is back.
  const handledChangeRevision = useRef(new Map<string, Partial<Record<string, number>>>())
  const pendingChanges = useRef(new Map<string, Set<ReadPart>>())
  useEffect(() => {
    if (!enabled) return
    for (const [id, change] of meshRemoteChanges) {
      const handled = handledChangeRevision.current.get(id) ?? {}
      const revisions: Partial<Record<string, number>> = change.revisions ?? { [change.what]: change.revision }
      let parts: Set<ReadPart> | null = null
      for (const [kind, revision] of Object.entries(revisions)) {
        if (revision === undefined || (handled[kind] ?? 0) >= revision) continue
        handled[kind] = revision
        parts ??= pendingChanges.current.get(id) ?? new Set<ReadPart>()
        parts.add(kind === 'conversations' ? 'conversations' : 'browse')
      }
      handledChangeRevision.current.set(id, handled)
      if (parts && mesh.some((connection) => connection.id === id) && shouldBrowse(meshReachability.get(id)))
        pendingChanges.current.set(id, parts)
    }
    for (const id of [...handledChangeRevision.current.keys()]) {
      if (meshRemoteChanges.has(id)) continue
      handledChangeRevision.current.delete(id)
      pendingChanges.current.delete(id)
    }
    if (!visible || pendingChanges.current.size === 0) return
    const timer = window.setTimeout(() => {
      const due = [...pendingChanges.current]
      pendingChanges.current.clear()
      for (const [id, parts] of due) read(id, parts)
    }, REMOTE_CHANGE_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [enabled, visible, mesh, meshReachability, meshRemoteChanges, read])

  // The pairing list: a machine not yet read gets its first read; a machine
  // forgotten drops its entry so its rows go with it.
  useEffect(() => {
    const paired = new Set(mesh.map((connection) => connection.id))
    setBrowses((current) => {
      let next: Map<string, RemoteBrowseEntry> | null = null
      for (const id of current.keys()) {
        if (paired.has(id)) continue
        next ??= new Map(current)
        next.delete(id)
      }
      return next ?? current
    })
    if (!enabled) return
    for (const connection of mesh) {
      if (browsesRef.current.has(connection.id) || inFlight.current.has(connection.id)) continue
      if (!shouldBrowse(meshReachability.get(connection.id))) continue
      browse(connection.id)
    }
  }, [enabled, mesh, meshReachability, browse])

  // Reachability transitions: a machine that answers again after being quiet
  // is read again. The first read at mount is the effect above's; this one
  // only fires on a genuine off → on edge.
  const wasAwake = useRef(new Map<string, boolean>())
  useEffect(() => {
    for (const [id, reach] of meshReachability) {
      const awake = shouldBrowse(reach) && reach.checkedAt !== null
      const was = wasAwake.current.has(id)
        ? wasAwake.current.get(id)!
        : browsesRef.current.has(id) || inFlight.current.has(id)
      wasAwake.current.set(id, awake)
      if (enabled && awake && !was && mesh.some((connection) => connection.id === id)) browse(id)
    }
    for (const id of [...wasAwake.current.keys()]) {
      if (!meshReachability.has(id)) wasAwake.current.delete(id)
    }
  }, [enabled, mesh, meshReachability, browse])

  // The fallback cadence: only while the band is open and this window is in
  // front, and slow — a machine whose change feed is up has already said
  // everything this read could find.
  useEffect(() => {
    if (!enabled || !bridge) return
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) return
      for (const connection of mesh) {
        if (shouldBrowse(meshReachability.get(connection.id))) browse(connection.id)
      }
    }, REMOTE_BAND_CADENCE_MS)
    return () => window.clearInterval(timer)
  }, [enabled, bridge, mesh, meshReachability, browse])

  const refresh = useCallback(
    (connectionId?: string) => {
      for (const connection of mesh) {
        if (connectionId && connection.id !== connectionId) continue
        if (connectionId || shouldBrowse(meshReachability.get(connection.id))) browse(connection.id)
      }
    },
    [mesh, meshReachability, browse],
  )

  return { presence, browses, listening, link, refresh }
}
