import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import { conversationSummaryPhase, type ConversationPhase } from '../../../../../shared/conversation/phase'
import { layoutHasAgentTab } from '../../../utils/launchedAgentProjection'
import { labelForCliRuntime } from '../newWorkspace/cliRuntimeOptions'
import type { Activity } from './rowStyle'
import type { TerminalSessionSnapshot } from '../../../../../shared/ipc/terminal'
import { isSessionWorking } from '../../../hooks/useTerminalSessions'

/**
 * What a chat's mark says: the CLI it rides, so a chat line wears the same
 * provider mark a terminal line does and the two read as the same agent on a
 * different surface. `cli` is null for a provider that is not a CLI (the
 * API-key providers), which keep the chat glyph.
 */
export function conversationLineMark(
  summary: Pick<ConversationSessionSummary, 'providerId' | 'modelId' | 'displayName'>,
): {
  cli: string | null
  runtimeLabel: string
  tooltip: string
} {
  const cli = cliForConversationProvider(summary.providerId)
  const runtimeLabel = cli ? `${labelForCliRuntime(cli)} chat` : 'Chat'
  const parts = [summary.displayName?.trim(), runtimeLabel, summary.modelId].filter(Boolean)
  return { cli, runtimeLabel, tooltip: parts.join(' · ') }
}

/**
 * The chats a row draws a line for: one per chat tab in the workspace's layout.
 * Main lists every session it holds, and that is not the same count — a closed
 * tab's session can outlive it, and a chat can be left holding more than one —
 * but the row's lines are the workspace's tabs, so a session with no tab has no
 * line and a chat with two sessions has one, the one it spoke through last.
 */
export function conversationsWithTabs(
  sessions: readonly ConversationSessionSummary[],
  layoutModel: unknown,
): ConversationSessionSummary[] {
  const byAgent = new Map<string, ConversationSessionSummary>()
  for (const session of sessions) {
    const held = byAgent.get(session.agentId)
    if (held && held.updatedAt >= session.updatedAt) continue
    if (held || layoutHasAgentTab(layoutModel, session.agentId)) byAgent.set(session.agentId, session)
  }
  return sessions.filter((session) => byAgent.get(session.agentId) === session)
}

export function conversationLineText(summary: ConversationSessionSummary): string {
  return chatLineText(conversationSummaryPhase(summary), summary)
}

/**
 * What a chat's line says in its phase: the wait that needs a person, the tool
 * a running turn is in, else the opening of the agent's last reply. One
 * wording for a chat held here and one listed by a paired machine, so the two
 * rows read alike.
 */
export function chatLineText(
  phase: ConversationPhase,
  said: { currentToolTitle?: string | null; lastAssistantText?: string | null },
): string {
  if (phase === 'waiting_for_approval') return 'Needs approval'
  if (phase === 'waiting_for_input') return 'Asked a question'
  if (phase === 'failed') return 'Failed'
  if (phase === 'running') return said.currentToolTitle?.trim() || 'Thinking'
  return cachedReplyPreviewText(said.lastAssistantText ?? '') || (phase === 'starting' ? 'Starting' : 'Ready')
}

// The last few replies' previews. A row redraws its line far more often than
// its reply changes (the clock, a sibling terminal), and the preview is a
// dozen regular expressions over the reply's text each time.
const PREVIEW_CACHE_SIZE = 64
const previewCache = new Map<string, string>()
function cachedReplyPreviewText(markdown: string): string {
  if (!markdown) return ''
  const cached = previewCache.get(markdown)
  if (cached !== undefined) return cached
  const preview = replyPreviewText(markdown)
  if (previewCache.size >= PREVIEW_CACHE_SIZE) previewCache.delete(previewCache.keys().next().value as string)
  previewCache.set(markdown, preview)
  return preview
}

// Where escaped markdown characters wait out the stripping: the private-use
// block, which no reply's text is written in.
const ESCAPED_BASE = 0xe000

/**
 * A reply's markdown as one line of prose, for the row under an agent's name.
 * The runtime hands over the reply's first characters as written, and in a
 * single truncated line the syntax is all noise: a `#` before the first word,
 * `**` around the second, a link's URL longer than its text. What is left is
 * what the reader would have read. The source is cut mid-reply, so a marker
 * whose partner fell past the cut goes too.
 */
export function replyPreviewText(markdown: string): string {
  // An escaped marker is a character the writer meant literally; it is set
  // aside before the markers are read and put back as itself at the end.
  const escaped = markdown.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/gu, (_, char: string) =>
    String.fromCharCode(ESCAPED_BASE + char.charCodeAt(0)),
  )
  const lines: string[] = []
  for (const raw of escaped.split(/\r?\n/u)) {
    let line = raw.trim()
    // A fence line, a rule or a table's alignment row says nothing on its own.
    if (/^(?:`{3,}|~{3,})/u.test(line) || /^(?:[-*_]\s*){3,}$/u.test(line) || /^\|?[\s:|-]+\|[\s:|-]*$/u.test(line))
      continue
    line = line
      .replace(/^(?:>\s?)+/u, '')
      .replace(/^#{1,6}\s+/u, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/u, '')
      .replace(/^\[[ xX]\]\s+/u, '')
      .replace(/^\|\s*|\s*\|$/gu, '')
      .replace(/\s+\|\s+/gu, ' · ')
    if (line) lines.push(line)
  }
  return lines
    .join(' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)?/gu, '$1')
    .replace(/\[([^\]]+)\](?:\([^)]*\)?|\[[^\]]*\])/gu, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/gu, '$1')
    .replace(/`+/gu, '')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/gu, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/gu, '$1$2')
    .replace(/(^|\W)_(?=\S)([^_]*?\S)_(?!\w)/gu, '$1$2')
    .replace(/\*\*|__|~~/gu, '')
    .replace(/[\uE000-\uE07F]/gu, (char) => String.fromCharCode(char.charCodeAt(0) - ESCAPED_BASE))
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * When a resting chat last finished a turn, for the "how long since" readings
 * on its sidebar line and its tab. Null while a turn is open or waiting on a
 * person (those surfaces say working or waiting instead), and for a chat that
 * has never finished one.
 */
export function conversationFinishedAt(summary: ConversationSessionSummary): number | null {
  const phase = conversationSummaryPhase(summary)
  if (phase !== 'completed' && phase !== 'failed' && phase !== 'idle') return null
  return summary.lastTurnEndedAt ?? null
}

/**
 * When the person last sent a chat a message, for a workspace's "last typed"
 * recency. Not `updatedAt`, which also moves on a model or permission change.
 * A chat with no message yet counts from when it was opened, which the person
 * did.
 */
export function conversationLastInputAt(summary: ConversationSessionSummary): number {
  return summary.lastUserMessageAt ?? summary.createdAt
}

export function conversationPhaseActivity(phase: ConversationPhase): Activity {
  if (phase === 'waiting_for_approval' || phase === 'waiting_for_input') return 'needs-input'
  if (phase === 'failed') return 'failed'
  if (phase === 'running' || phase === 'starting') return 'working'
  return 'idle'
}

/**
 * Whether anything in the chat is still working, which Settle and Snooze
 * refuse and the rest sweep waits for: both end the chat's agent processes,
 * and the work with them. Read per session — chat and terminal alike — as well
 * as from the row's combined activity, because a waiting prompt or a failed
 * turn outranks working there: one terminal agent at a prompt hid another
 * still mid-turn beside it, and Settle ended that one. An agent the chat
 * launched in the background counts whatever its parent's phase says: it goes
 * on working while the parent waits on the person, or after the parent's turn
 * failed.
 *
 * Only an agent's work counts. A plain shell reads as working whenever it has
 * printed in the last few seconds, which is terminal UX and not work Settle
 * would be cutting short: a chat holding only a shell, or a shell beside an
 * idle agent, settles like any other, and its shell ends with it. Main's own
 * Settle (`conversation.settle`) reads agent terminals alone for the same
 * reason. The row's combined activity carries a shell's working too, so it is
 * believed only while no shell is the one printing.
 */
export function workspaceIsWorking(
  activity: Activity,
  conversations: readonly ConversationSessionSummary[],
  terminals: readonly TerminalSessionSnapshot[] = [],
): boolean {
  const shellPrinting = terminals.some((session) => session.kind !== 'agent' && isSessionWorking(session))
  if (activity === 'working' && !shellPrinting) return true
  if (terminals.some((session) => session.kind === 'agent' && isSessionWorking(session))) return true
  return conversations.some(
    (summary) =>
      (summary.backgroundAgents ?? 0) > 0 || conversationPhaseActivity(conversationSummaryPhase(summary)) === 'working',
  )
}

/** The row's existing status vocabulary, including when a terminal shares it. */
export function combinedAgentActivity(
  terminal: Activity,
  conversations: readonly ConversationSessionSummary[],
): Activity {
  const rank: Record<Activity, number> = { idle: 0, working: 1, failed: 2, 'needs-input': 3 }
  let result = terminal
  for (const summary of conversations) {
    const next = conversationPhaseActivity(conversationSummaryPhase(summary))
    if (rank[next] > rank[result]) result = next
  }
  return result
}
