import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { formatHunkHeader } from '../../../../shared/git/hunks'
import {
  emphasizeChangedWords,
  pairReplacedLines,
  type ConversationEdit,
} from '../../../../shared/conversation/editHunks'
import { loadCodeLanguage, normalizeCodeLanguage } from '../../lib/highlight/codeHighlight'
import { GhostButton } from './Buttons'
import { formatDiffCount } from '../../utils/diffCount'
import '../../../../../design-system/components/inline-diff/component.css'

export function InlineDiff({ edit, onOpen }: { edit: ConversationEdit; onOpen?: () => void }) {
  const [all, setAll] = useState(false)
  const [highlighted, setHighlighted] = useState<Map<string, { content: string; color?: string }[]>>(new Map())
  const limited = edit.added + edit.removed > 400
  // A new file or a whole-file write is all additions: show its head only.
  const wholeFile = edit.newFile || edit.contentsOnly === true
  const hunks = limited && !all ? edit.hunks.slice(0, 3) : edit.hunks
  const sourceHunks = useMemo(() => edit.hunks.map((hunk) => hunk.lines), [edit.hunks])
  const pairs = useMemo(() => sourceHunks.map((lines) => pairReplacedLines(lines)), [sourceHunks])
  useEffect(() => {
    let cancelled = false
    const language = normalizeCodeLanguage(edit.path.split('.').at(-1))
    if (!language) return
    void loadCodeLanguage(language)
      .then((engine) => {
        const tokens = new Map<string, { content: string; color?: string }[]>()
        let remaining = 2000
        for (const [hunkIndex, lines] of sourceHunks.entries()) {
          const visible = lines.slice(0, remaining)
          remaining -= visible.length
          if (!visible.length) break
          // Each side has its own grammar state: deleted delimiters must not
          // alter highlighting of added lines or the following context.
          for (const side of ['-', '+']) {
            const selected = visible
              .map((line, index) => ({ line, index }))
              .filter(({ line }) => line.startsWith(side) || line.startsWith(' '))
            const highlighted = engine.codeToTokensBase(selected.map(({ line }) => line.slice(1)).join('\n'), {
              lang: language,
              theme: 'semantic-code',
              tokenizeTimeLimit: 50,
            })
            for (const [index, entry] of selected.entries())
              tokens.set(`${hunkIndex}:${entry.index}`, highlighted[index] ?? [{ content: entry.line.slice(1) }])
          }
        }
        if (!cancelled) setHighlighted(tokens)
      })
      .catch(() => {
        /* Diffs remain readable if their grammar cannot load. */
      })
    return () => {
      cancelled = true
    }
  }, [edit.path, sourceHunks])
  return (
    <section aria-label={`Changes in ${edit.path}`}>
      <div className="flex items-center gap-2 text-meta">
        <span>
          +{formatDiffCount(edit.added)} −{formatDiffCount(edit.removed)}
        </span>
        {onOpen ? (
          <GhostButton size="inline" onClick={onOpen}>
            Open in diff viewer
          </GhostButton>
        ) : null}
      </div>
      <div className="ds-inline-diff">
        {hunks.map((hunk, hunkIndex) => (
          <div key={hunkIndex}>
            <div className="ds-inline-diff__header">{formatHunkHeader(hunk)}</div>
            {(wholeFile && !all ? hunk.lines.slice(0, 40) : hunk.lines).map((line, index) => {
              const added = line.startsWith('+'),
                removed = line.startsWith('-')
              const partner = pairs[edit.hunks.indexOf(hunk)]?.get(index)
              const sibling = partner === undefined ? undefined : hunk.lines[partner]
              const emphasis = sibling
                ? emphasizeChangedWords((removed ? line : sibling).slice(1), (added ? line : sibling).slice(1))
                : undefined
              const parts = emphasis ? (added ? emphasis.next : emphasis.old) : undefined
              return (
                <div
                  key={index}
                  className={`ds-inline-diff__line${added ? ' ds-inline-diff__line--added' : removed ? ' ds-inline-diff__line--removed' : ''}`}
                >
                  {line[0]}
                  {renderDiffTokens(highlighted.get(`${hunkIndex}:${index}`) ?? [{ content: line.slice(1) }], parts)}
                </div>
              )
            })}
          </div>
        ))}
      </div>
      {edit.contentsOnly ? <p>Wrote the whole file. Its previous contents were not recorded.</p> : null}
      {((wholeFile && edit.added > 40) || limited) && !all ? (
        <GhostButton size="inline" onClick={() => (onOpen ? onOpen() : setAll(true))}>
          Open full diff
        </GhostButton>
      ) : null}
      {edit.limited ? <p>Diff preview exceeded its time limit. Open the full diff to inspect this change.</p> : null}
    </section>
  )
}

function renderDiffTokens(
  tokens: { content: string; color?: string }[],
  emphasis?: { text: string; changed: boolean }[],
): ReactNode {
  let partIndex = 0
  let partOffset = 0
  return tokens.map((token, tokenIndex) => {
    if (!emphasis)
      return (
        <span key={tokenIndex} style={{ color: token.color }}>
          {token.content}
        </span>
      )
    const pieces: ReactNode[] = []
    let offset = 0
    while (offset < token.content.length) {
      const part = emphasis[partIndex]
      if (!part) {
        pieces.push(token.content.slice(offset))
        break
      }
      const length = Math.min(token.content.length - offset, part.text.length - partOffset)
      const piece = token.content.slice(offset, offset + length)
      pieces.push(part.changed ? <mark key={offset}>{piece}</mark> : piece)
      offset += length
      partOffset += length
      if (partOffset === part.text.length) {
        partIndex++
        partOffset = 0
      }
    }
    return (
      <span key={tokenIndex} style={{ color: token.color }}>
        {pieces}
      </span>
    )
  })
}
