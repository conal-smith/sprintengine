// What a finished turn says about itself under its reply — the model it ran
// on, the tokens it used, what it cost when that means anything — and the
// seams drawn across the transcript: the divider a context compaction leaves,
// and the one above the replies not read yet.

import type { ReactNode } from 'react'
import type { TranscriptEntry } from './conversationProjection'
import { apiKeyBillingNotice } from '../../../../../shared/conversation/apiKeySource'
import { CONVERSATION_DEFAULT_MODEL_ID } from '../../../../../shared/conversation-harness'
import { CompactGlyph } from './toolRows/ToolKindGlyph'
import { formatTokenCount } from '../../../utils/tokenFormat'
import { GhostButton } from '../../ui'

type AssistantEntry = Extract<TranscriptEntry, { kind: 'assistant' }>
type CompactionEntry = Extract<TranscriptEntry, { kind: 'compaction' }>
type HandoffEntry = Extract<TranscriptEntry, { kind: 'handoff' }>

// A provider's model id as the footer names it. The dated snapshot suffix is
// noise next to the family and version; the harness's "default" is not a name.
export function formatTurnModel(modelId: string): string {
  if (modelId === CONVERSATION_DEFAULT_MODEL_ID) return 'Default model'
  return modelId.replace(/-\d{8}$/u, '')
}

export type TurnMetaParts = {
  model?: string
  tokens?: string
  cost?: string
}

// The pieces of a settled turn's footer. Cost only for a turn that billed API
// usage: on a subscription the provider still reports a list-price estimate,
// and a dollar figure there reads as a charge that never happens.
export function turnMetaParts(entry: AssistantEntry): TurnMetaParts {
  const parts: TurnMetaParts = {}
  if (entry.modelId) parts.model = formatTurnModel(entry.modelId)
  if (entry.inputTokens !== undefined || entry.outputTokens !== undefined) {
    // The cached share, where the provider reports one: most of a long turn's
    // input is the conversation re-read from the prompt cache at a fraction of
    // the price, and "11.3M in" alone reads as 11.3M tokens paid in full.
    const cached = entry.cachedInputTokens ? ` · ${formatTokenCount(entry.cachedInputTokens)} cached` : ''
    parts.tokens = `${formatTokenCount(entry.inputTokens ?? 0)} in${cached} · ${formatTokenCount(entry.outputTokens ?? 0)} out`
  }
  if (entry.costUsd !== undefined && entry.costUsd > 0 && apiKeyBillingNotice(entry.apiKeySource) !== null) {
    parts.cost = entry.costUsd < 0.01 ? '<$0.01' : `$${entry.costUsd.toFixed(2)}`
  }
  return parts
}

const HOVER_REVEAL = 'opacity-0 group-hover/conversation:opacity-100 group-focus-within/conversation:opacity-100'

// The footer's own pieces, laid into the turn's meta line. They wait for hover
// like the clock beside them, except the model right after a switch: that is
// the one thing a reader scanning the transcript needs to see unprompted.
export function TurnMeta({ entry, modelSwitched = false }: { entry: AssistantEntry; modelSwitched?: boolean }) {
  const { model, tokens, cost } = turnMetaParts(entry)
  return (
    <>
      {model && modelSwitched ? (
        <span className="shrink-0 whitespace-nowrap" data-turn-model="">
          {model}
        </span>
      ) : null}
      {model && !modelSwitched ? (
        <span className={`shrink-0 whitespace-nowrap text-[color:var(--text-subtle)] ${HOVER_REVEAL}`}>{model}</span>
      ) : null}
      {tokens ? (
        <span className={`shrink-0 whitespace-nowrap tabular-nums text-[color:var(--text-subtle)] ${HOVER_REVEAL}`}>
          {tokens}
        </span>
      ) : null}
      {cost ? (
        <span className={`shrink-0 whitespace-nowrap tabular-nums text-[color:var(--text-subtle)] ${HOVER_REVEAL}`}>
          {cost}
        </span>
      ) : null}
    </>
  )
}

// "Context compacted · automatically · 182k → 24k tokens". Studio's own
// compaction before the cache expired says so: the CLI calls it a manual one,
// since what it was sent was `/compact`, but nobody asked for it.
export function compactionLabel(entry: CompactionEntry): string {
  const tokens =
    entry.preTokens === undefined
      ? undefined
      : entry.postTokens === undefined
        ? `from ${formatTokenCount(entry.preTokens)} tokens`
        : `${formatTokenCount(entry.preTokens)} → ${formatTokenCount(entry.postTokens)} tokens`
  const trigger = entry.beforeCacheExpiry
    ? 'automatically, before the cache expired'
    : entry.trigger === 'auto'
      ? 'automatically'
      : entry.trigger === 'manual'
        ? 'on request'
        : undefined
  return ['Context compacted', trigger, tokens].filter(Boolean).join(' · ')
}

// "Handed off to a new session · 221k tokens left behind".
export function handoffLabel(entry: HandoffEntry): string {
  const left = entry.preTokens !== undefined ? `${formatTokenCount(entry.preTokens)} tokens left behind` : undefined
  return ['Handed off to a new session', left].filter(Boolean).join(' · ')
}

// A seam across the transcript column: a hairline either side of a quiet
// label. The view's own furniture, never something said in the chat. An
// action, where the seam has one, sits after the label, in its quiet line.
function TimelineSeam({
  label,
  ariaLabel,
  glyph,
  action,
}: {
  label: string
  ariaLabel: string
  glyph?: ReactNode
  action?: ReactNode
}) {
  return (
    <div
      role="separator"
      aria-label={ariaLabel}
      className="flex items-center gap-3 pb-6 text-micro text-[color:var(--text-subtle)]"
    >
      <span className="flex-1 border-t border-[color:var(--border-subtle)]" />
      <span className="flex shrink-0 items-center gap-1.5">
        {glyph}
        {label}
        {action}
      </span>
      <span className="flex-1 border-t border-[color:var(--border-subtle)]" />
    </div>
  )
}

// Past this line the model works from a summary of the conversation, not the
// conversation itself, so the seam is drawn across the column rather than
// tucked into a turn.
export function CompactionDivider({ entry }: { entry: CompactionEntry }) {
  const label = compactionLabel(entry)
  return (
    <TimelineSeam
      label={label}
      ariaLabel={label}
      glyph={<CompactGlyph className="icon-xs shrink-0 text-[color:var(--text-disabled)]" />}
    />
  )
}

// Past this line the agent is a new session that has the conversation above
// only as a file of its messages, which its first message pointed it at. The
// history stays as it was; the seam says where the agent's memory of it
// changed. Open file shows the file the new session was given.
export function HandoffDivider({ entry, onOpenFile }: { entry: HandoffEntry; onOpenFile?: (path: string) => void }) {
  const label = handoffLabel(entry)
  return (
    <TimelineSeam
      label={label}
      ariaLabel={label}
      glyph={<HandoffGlyph className="icon-xs shrink-0 text-[color:var(--text-disabled)]" />}
      action={
        onOpenFile ? (
          <GhostButton size="xs" className="-my-1 ml-1" onClick={() => onOpenFile(entry.path)}>
            Open file
          </GhostButton>
        ) : undefined
      }
    />
  )
}

// A page handed across: what the new session is given in place of the old one.
export function HandoffGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M4 2.5h5l3 3v8H4z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.5 9.5h3M8.5 8 10 9.5 8.5 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// Where the replies the person has not read yet begin (`unreadDivider.ts`).
// The same seam as a compaction's, so it reads as the transcript's own
// furniture rather than a banner; the word is short because the place says
// the rest.
export function UnreadDivider() {
  return <TimelineSeam label="New" ariaLabel="New since you last looked" />
}
