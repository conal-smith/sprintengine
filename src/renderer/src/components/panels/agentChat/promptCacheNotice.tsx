// The composer tray's row when a chat's prompt cache is about to go cold or
// already has: when, and how many tokens that puts at stake — with what makes
// the next message, and every one after it, smaller.
//
// While the cache is still warm, compacting reads the conversation from it
// cheaply, so Compact is the one action. Once it has gone cold, a compaction
// re-reads the whole conversation uncached first, which can cost as much as
// it saves: the default is then Handoff, a fresh session handed a file of the
// conversation's messages, and Compact is still there, a deliberate choice
// in the menu beside it that says what it re-reads.

import { useState } from 'react'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { formatTokenCount } from '../../../utils/tokenFormat'
import { GhostButton, SplitButton } from '../../ui'
import type { PromptCacheReading } from '../../../../../shared/prompt-cache'
import { promptCacheNeedsAttention, promptCacheNoticeLine, promptCacheState } from '../../workspace/promptCacheState'
import { ComposerTrayRow } from './composerTray'
import { CompactGlyph } from './toolRows/ToolKindGlyph'
import { HandoffGlyph } from './turnMeta'

// What a dismissal is about: this reading. The next request writes a new one,
// and a cache that goes cold after that is news again.
function readingKey(reading: PromptCacheReading): string {
  return `${reading.expiresAt ?? 'cold'}:${reading.recacheTokens ?? ''}`
}

/** "~221k tokens", or the words for a size the source has not said. */
function tokensAtStake(recacheTokens: number | null): string {
  return recacheTokens !== null ? `~${formatTokenCount(recacheTokens)} tokens` : 'the whole conversation'
}

/** What Handoff does and keeps, for its tooltip. */
export function handoffTooltip(recacheTokens: number | null): string {
  return `Start a fresh agent session instead of re-reading ${tokensAtStake(recacheTokens)} uncached. Studio saves this chat’s messages (no tool calls) to a file and points the new session at it with your next message. Your history here stays; a divider marks the handoff.`
}

export function PromptCacheComposerNotice({
  reading,
  busy,
  onCompact,
  onHandoff,
}: {
  reading: PromptCacheReading | null
  /** A turn is running or a send is in flight: every request refreshes the cache, and a compaction would queue. */
  busy: boolean
  onCompact: () => void
  /** Hand the chat off to a fresh session; absent where the chat cannot be. */
  onHandoff?: () => void
}) {
  const [dismissed, setDismissed] = useState<string | null>(null)
  // No clock for a reading already set aside: nothing it says is on screen.
  const now = useRelativeNow(30_000, reading !== null && !busy && dismissed !== readingKey(reading))
  if (busy || !reading || dismissed === readingKey(reading)) return null
  const state = promptCacheState(reading, now)
  if (!promptCacheNeedsAttention(state)) return null
  const compactGlyph = <CompactGlyph className="icon-xs" />
  return (
    <ComposerTrayRow
      tone="warn"
      onDismiss={() => setDismissed(readingKey(reading))}
      actions={
        state.kind === 'cold' && onHandoff ? (
          <SplitButton
            quiet
            label="Handoff"
            glyph={<HandoffGlyph className="icon-xs" />}
            primaryAriaLabel="Hand off to a new session"
            primaryTooltip={handoffTooltip(state.recacheTokens)}
            menuAriaLabel="Other ways to make the next message smaller"
            menuKind="alternatives"
            onPrimary={onHandoff}
            items={[
              {
                id: 'compact',
                label: 'Compact',
                icon: compactGlyph,
                hint: `Re-reads ${tokensAtStake(state.recacheTokens)} uncached`,
                onSelect: onCompact,
              },
            ]}
          />
        ) : (
          <GhostButton size="xs" onClick={onCompact}>
            {compactGlyph}
            Compact
          </GhostButton>
        )
      }
    >
      {promptCacheNoticeLine(state, now)}
    </ComposerTrayRow>
  )
}
