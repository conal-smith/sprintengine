import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { appearanceKey, subscribeAppearance } from '../../../lib/diagram/mermaidDiagram'
import { cachedVisual, drawVisual, type VisualResult } from '../../../lib/visual/visualDocument'
import type { CodeBlockNoteAction } from '../../ui/CodeBlock'
import { VisualFrame } from '../../ui/VisualFrame'

// Its own tag rather than ```html or ```svg: those are routinely source code
// being shown, and drawing them would hide the code that was asked for.
const VISUAL_LANGUAGES = new Set(['visual', 'studio-visual'])

export function isVisualLanguage(language: string | undefined): boolean {
  return VISUAL_LANGUAGES.has((language ?? '').toLowerCase())
}

const subscribeNothing = () => () => undefined

/**
 * What a reply's ```visual block draws in place of its source — a chart, a
 * table, an annotated drawing an agent wrote as static HTML and SVG — as a
 * diagram block does (`conversationDiagram.tsx`): nothing while the message
 * streams, since half a document draws as half a chart and would flicker
 * token by token, then the visual in a frame once the block is complete. One
 * refused (too large, or nothing left once sanitized) keeps its source with a
 * note saying why; one whose sanitizer did not load says so, with a Retry.
 *
 * Built for the window's current appearance, since its colours come from the
 * window's tokens; after a switch the previous frame stays up until the new
 * document is ready.
 */
export function useVisualDrawing(
  code: string,
  language: string | undefined,
  streaming: boolean | undefined,
): { drawing?: ReactNode; note?: string; noteAction?: CodeBlockNoteAction } {
  const visual = isVisualLanguage(language)
  const wanted = !streaming && visual
  // Only a visual listens for the appearance: every block in a reply goes
  // through this hook too.
  const appearance = useSyncExternalStore(visual ? subscribeAppearance : subscribeNothing, appearanceKey, appearanceKey)
  const cached = wanted ? cachedVisual(appearance, code) : undefined
  const [drawn, setDrawn] = useState<{ code: string; result: VisualResult } | null>(null)
  // Bumped by Retry: a failed load is never cached, so drawing again asks for
  // the sanitizer again.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!wanted || cached) return
    let current = true
    void drawVisual(appearance, code).then((result) => {
      if (current) setDrawn({ code, result })
    })
    return () => {
      current = false
    }
  }, [wanted, cached, appearance, code, attempt])
  const result = cached ?? (drawn?.code === code ? drawn.result : undefined)
  if (!wanted || !result) return {}
  if ('error' in result) {
    const note = `Shown as source: ${result.error}`
    return result.retry ? { note, noteAction: { label: 'Retry', onClick: () => setAttempt((n) => n + 1) } } : { note }
  }
  return { drawing: <VisualFrame srcDoc={result.html} title={result.title} /> }
}
