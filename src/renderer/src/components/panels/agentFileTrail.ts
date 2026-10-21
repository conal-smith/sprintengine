// The agent's trail through the Files tree: which rows are marked because an
// agent in this workspace is reading or editing them, and which folders lead
// to one. Derived from the chats' summaries and a clock, never stored, so a
// mark goes on time even when no summary moves.

import type { ConversationFileActivity, ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import { conversationTurnInProgress } from '../../../../shared/conversation/phase'
import { normalizePathKey } from '../../hooks/useGitStatus'

/**
 * How long a file stays marked after the call that touched it ends. A read
 * takes milliseconds, so without it a mark would never be seen; long enough to
 * follow the agent moving through a folder, short enough that the trail is the
 * last few steps and not the whole session.
 */
export const AGENT_TRAIL_LINGER_MS = 10_000

/** Who is on a row right now: what seeds the agent's glyph. */
export type AgentTrailWho = { agentId: string }

export type AgentTrailMark = {
  /** Editing outranks reading: a folder holding both says editing. */
  verb: ConversationFileActivity['verb']
  /** Marked files at or under the row: 1 on a file. */
  count: number
  /** An agent is on this file, or on one under this folder, right now. */
  here: AgentTrailWho | null
}

export type AgentTrail = {
  /** By `normalizePathKey` of the row's path: files and the folders above them, the root excluded. */
  marks: ReadonlyMap<string, AgentTrailMark>
  /** When a lingering mark next lapses, for the one timer that redraws the tree. */
  nextChangeAt: number | null
}

export const EMPTY_AGENT_TRAIL: AgentTrail = { marks: new Map(), nextChangeAt: null }

type Live = { path: string; verb: ConversationFileActivity['verb']; here: AgentTrailWho | null }

function trimRoot(key: string): string {
  return key.replace(/\/+$/u, '')
}

/**
 * The marks for the tree rooted at `rootPath`, or for every file and no folder
 * when it is null (an editor's tabs, which sit under no one root), from the summaries of the chats
 * in its workspace. A file is marked while a call on it runs, for
 * `AGENT_TRAIL_LINGER_MS` after it ends, and for as long as it is the last
 * file its agent touched while the chat is still working: an agent thinking
 * over the file it just read is still on it.
 *
 * A call still open on a chat that is not working is not counted: a transcript
 * cut off mid-call (a crash, a resume) would otherwise mark a file for good.
 */
export function agentFileTrail(
  sessions: readonly Pick<
    ConversationSessionSummary,
    'agentId' | 'phase' | 'status' | 'backgroundAgents' | 'fileActivity'
  >[],
  rootPath: string | null,
  now: number,
): AgentTrail {
  const root = rootPath === null ? null : trimRoot(normalizePathKey(rootPath))
  const live: Live[] = []
  let nextChangeAt: number | null = null
  for (const session of sessions) {
    const activity = session.fileActivity
    if (!activity?.length) continue
    const working = conversationTurnInProgress(session as ConversationSessionSummary)
    // The latest call of each agent in the chat (its own, and each spawned
    // one's): where that agent is.
    const latest = new Map<string, ConversationFileActivity>()
    if (working)
      for (const entry of activity) {
        const lane = entry.laneId ?? ''
        const prior = latest.get(lane)
        if (!prior || entry.startedAt >= prior.startedAt) latest.set(lane, entry)
      }
    for (const entry of activity) {
      const lane = entry.laneId ?? ''
      const isLatest = latest.get(lane)?.toolUseId === entry.toolUseId
      const running = entry.endedAt === undefined
      if (running && !working) continue
      if (!running && !isLatest) {
        const lapses = entry.endedAt! + AGENT_TRAIL_LINGER_MS
        if (lapses <= now) continue
        nextChangeAt = nextChangeAt === null ? lapses : Math.min(nextChangeAt, lapses)
      }
      live.push({
        path: entry.path,
        verb: entry.verb,
        // A spawned agent wears the face its lane in the chat wears.
        here: isLatest ? { agentId: entry.laneId ?? session.agentId } : null,
      })
    }
  }
  if (live.length === 0) return nextChangeAt === null ? EMPTY_AGENT_TRAIL : { marks: new Map(), nextChangeAt }

  const marks = new Map<string, AgentTrailMark>()
  // Each file once, however many calls are on it, so a folder counts files.
  const files = new Map<string, Live>()
  for (const item of live) {
    const key = normalizePathKey(item.path)
    if (root !== null && !key.startsWith(`${root}/`)) continue
    const prior = files.get(key)
    files.set(key, {
      path: key,
      verb: prior?.verb === 'editing' ? 'editing' : item.verb,
      here: prior?.here ?? item.here,
    })
  }
  for (const [key, file] of files) {
    marks.set(key, { verb: file.verb, count: 1, here: file.here })
    if (root === null) continue
    // Every folder between the root and the file.
    let cut = key.lastIndexOf('/')
    while (cut > root.length) {
      const folder = key.slice(0, cut)
      const prior = marks.get(folder)
      marks.set(folder, {
        verb: prior?.verb === 'editing' ? 'editing' : file.verb,
        count: (prior?.count ?? 0) + 1,
        here: prior?.here ?? file.here,
      })
      cut = key.lastIndexOf('/', cut - 1)
    }
  }
  return { marks, nextChangeAt }
}
