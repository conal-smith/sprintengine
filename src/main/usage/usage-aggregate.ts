import type { UsageGroupBy, UsageQuery, UsageRow } from '../../shared/modules/activity-service'
import type { UsageCacheEntry } from './usage-scan'

// The query side of the usage service: the cached per-session aggregates
// (usage-scan.ts), summed over a window and the dimensions asked for.
//
// Counting each request once is the whole job:
//
// - A Studio chat on Claude Code or Codex leaves two records of the same
//   turns: the transcript's `turn_completed` usage and the CLI's own log. The
//   CLI's log is the one counted — it has every request, subagents included —
//   and it is attributed to the chat (workspace, agent id, title) through the
//   transcript's link to its session. The transcript's own usage is counted
//   only for turns whose CLI log this machine does not have (another runtime,
//   a log since deleted); the cost the runtime reported is kept for exactly
//   those, since the turns priced from the log need no second price.
// - A CLI session no chat links to (one a person ran in a terminal) is
//   attributed to the open workspace whose folder holds it, if any.
// - A CLI that prices its own turns (OpenCode, Grok) keeps that price in its
//   log, and it is reported as the cost; Claude Code and Codex record none.

export type UsageWorkspaceRef = { id: string; folderPath: string | null }

export type UsageAggregateContext = {
  /** Open workspaces in registry order; the first of the longest matching folder wins. */
  workspaces: readonly UsageWorkspaceRef[]
  /** A chat's title when its transcript's index did not have one. */
  chatTitle?: (workspaceId: string, agentId: string) => string | null
  /** The calendar day an hour falls on. Defaults to this machine's local day. */
  dayOf?: (hourMs: number) => string
}

type Atom = {
  hour: number
  model: string
  providerId: string
  workspaceId: string | null
  sessionId: string
  agentId?: string
  chatTitle: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  requests: number
  costUsd: number | null
}

export function localDay(hourMs: number): string {
  const date = new Date(hourMs)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function aggregateUsage(
  entries: Iterable<UsageCacheEntry>,
  query: UsageQuery,
  context: UsageAggregateContext,
): UsageRow[] {
  const all = [...entries]
  const cliSessions = new Set(all.filter((entry) => entry.src !== 'studio').map((entry) => entry.sessionId))
  const chats = new Map<string, { workspaceId: string; agentId: string; title: string | null }>()
  for (const entry of all) {
    if (!entry.studio) continue
    const chat = {
      workspaceId: entry.studio.workspaceId,
      agentId: entry.studio.agentId,
      title: entry.title ?? context.chatTitle?.(entry.studio.workspaceId, entry.studio.agentId) ?? null,
    }
    for (const link of entry.studio.links) chats.set(link, chat)
  }
  const folders = context.workspaces
    .filter((workspace): workspace is { id: string; folderPath: string } => Boolean(workspace.folderPath))
    .map((workspace) => ({ id: workspace.id, folder: trimSeparators(workspace.folderPath) }))
    .sort((a, b) => b.folder.length - a.folder.length)
  const workspaceFor = (paths: Array<string | null>): string | null => {
    for (const path of paths) {
      if (!path) continue
      const candidate = trimSeparators(path)
      const match = folders.find(
        ({ folder }) =>
          candidate === folder || candidate.startsWith(`${folder}/`) || candidate.startsWith(`${folder}\\`),
      )
      if (match) return match.id
    }
    return null
  }

  const inWindow = (hour: number): boolean => hour >= query.from && hour < query.to
  const atoms: Atom[] = []
  for (const entry of all) {
    if (entry.studio) {
      const studio = entry.studio
      const title = entry.title ?? context.chatTitle?.(studio.workspaceId, studio.agentId) ?? null
      for (const [hour, model, link, input, output, cacheRead, cacheWrite, requests, costUsd] of entry.buckets) {
        // Counted from the CLI's own log instead.
        if (!inWindow(hour) || (link && cliSessions.has(link))) continue
        if (input + output + cacheRead + cacheWrite === 0 && costUsd === 0) continue
        atoms.push({
          hour,
          model,
          providerId: entry.providerId,
          workspaceId: studio.workspaceId,
          sessionId: link || studio.agentId,
          agentId: studio.agentId,
          chatTitle: title,
          input,
          output,
          cacheRead,
          cacheWrite,
          requests,
          costUsd: costUsd > 0 ? costUsd : null,
        })
      }
      continue
    }
    const chat = chats.get(entry.sessionId)
    const workspaceId = chat?.workspaceId ?? workspaceFor([entry.repoRoot, entry.cwd])
    for (const [hour, model, , input, output, cacheRead, cacheWrite, requests, costUsd] of entry.buckets) {
      if (!inWindow(hour)) continue
      atoms.push({
        hour,
        model,
        providerId: entry.providerId,
        workspaceId,
        sessionId: entry.sessionId,
        ...(chat ? { agentId: chat.agentId } : {}),
        chatTitle: chat?.title ?? entry.title,
        input,
        output,
        cacheRead,
        cacheWrite,
        requests,
        costUsd: costUsd > 0 ? costUsd : null,
      })
    }
  }

  const groupBy = new Set<UsageGroupBy>(query.groupBy ?? [])
  const dayOf = context.dayOf ?? localDay
  const rows = new Map<string, UsageRow>()
  for (const atom of atoms) {
    const day = groupBy.has('day') ? dayOf(atom.hour) : undefined
    const key = JSON.stringify([
      day,
      groupBy.has('model') ? atom.model : undefined,
      groupBy.has('provider') ? atom.providerId : undefined,
      groupBy.has('workspace') ? atom.workspaceId : undefined,
      groupBy.has('session') ? atom.sessionId : undefined,
    ])
    let row = rows.get(key)
    if (!row) {
      row = {
        ...(day !== undefined ? { day } : {}),
        ...(groupBy.has('model') ? { model: atom.model } : {}),
        ...(groupBy.has('provider') ? { providerId: atom.providerId } : {}),
        ...(groupBy.has('workspace') ? { workspaceId: atom.workspaceId } : {}),
        ...(groupBy.has('session')
          ? { sessionId: atom.sessionId, ...(atom.agentId ? { agentId: atom.agentId } : {}), chatTitle: atom.chatTitle }
          : {}),
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        requests: 0,
        reportedCostUsd: null,
      }
      rows.set(key, row)
    }
    row.tokens.input += atom.input
    row.tokens.output += atom.output
    row.tokens.cacheRead += atom.cacheRead
    row.tokens.cacheWrite += atom.cacheWrite
    row.requests += atom.requests
    if (atom.costUsd !== null) row.reportedCostUsd = (row.reportedCostUsd ?? 0) + atom.costUsd
  }
  return [...rows.values()].sort((a, b) => (a.day ?? '').localeCompare(b.day ?? '') || totalTokens(b) - totalTokens(a))
}

const totalTokens = (row: UsageRow): number =>
  row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite

function trimSeparators(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}
