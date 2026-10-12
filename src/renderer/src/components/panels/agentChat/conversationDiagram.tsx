import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  appearanceKey,
  cachedDiagram,
  drawDiagram,
  scopeDiagramIds,
  subscribeAppearance,
  type DiagramResult,
} from '../../../lib/diagram/mermaidDiagram'
import type { CodeBlockNoteAction } from '../../ui/CodeBlock'
import { OpenDiagramButton } from './diagramViewer'

const DIAGRAM_LANGUAGES = new Set(['mermaid', 'mmd'])

export function isDiagramLanguage(language: string | undefined): boolean {
  return DIAGRAM_LANGUAGES.has((language ?? '').toLowerCase())
}

const subscribeNothing = () => () => undefined

/** Mermaid's complaint, cut to the line that says what is wrong. */
function diagramNote(error: string): string {
  const first = error.split('\n', 1)[0].trim().replace(/:$/u, '')
  return first ? `Shown as source: ${first}` : 'Shown as source: the diagram could not be drawn'
}

/**
 * What a reply's ```mermaid block draws in place of its source: nothing while
 * the message streams — a diagram half-typed does not parse, and redrawing
 * it every token would flicker — then the diagram once the block is complete.
 * One that does not parse keeps its source, with a note under it saying why;
 * one whose renderer did not load says so too, with a Retry that asks for the
 * renderer again.
 *
 * Drawn for the window's current appearance; after a switch the previous
 * drawing stays up until the new one is ready, so the block never drops back
 * to its source in between. A drawn diagram also gets an Open diagram action,
 * which shows the same drawing larger (`diagramViewer.tsx`).
 */
export function useDiagramDrawing(
  code: string,
  language: string | undefined,
  streaming: boolean | undefined,
): { drawing?: ReactNode; actions?: ReactNode; note?: string; noteAction?: CodeBlockNoteAction } {
  const wanted = !streaming && isDiagramLanguage(language)
  // Only a diagram listens for the appearance: every other block in a reply
  // goes through this hook too.
  const appearance = useSyncExternalStore(
    isDiagramLanguage(language) ? subscribeAppearance : subscribeNothing,
    appearanceKey,
    appearanceKey,
  )
  const cached = wanted ? cachedDiagram(appearance, code) : undefined
  const [drawn, setDrawn] = useState<{ code: string; appearance: string; result: DiagramResult } | null>(null)
  // Bumped by Retry: a failed load is never cached, so drawing again asks for
  // the renderer again.
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!wanted || cached) return
    let current = true
    void drawDiagram(appearance, code).then((result) => {
      if (current) setDrawn({ code, appearance, result })
    })
    return () => {
      current = false
    }
  }, [wanted, cached, appearance, code, attempt])
  const result = cached ?? (drawn?.code === code ? drawn.result : undefined)
  if (!wanted || !result) return {}
  if ('error' in result) {
    const note = diagramNote(result.error)
    return result.retry ? { note, noteAction: { label: 'Retry', onClick: () => setAttempt((n) => n + 1) } } : { note }
  }
  return { drawing: <DiagramSvg svg={result.svg} />, actions: <OpenDiagramButton svg={result.svg} /> }
}

// Each copy on screen gets ids of its own (`scopeDiagramIds`); a count rather
// than `useId`, which repeats from one React root to the next.
let copies = 0

// The SVG has been sanitized on its way out of the renderer
// (`sanitizeDiagramSvg`), which is what makes setting it as markup safe.
function DiagramSvg({ svg }: { svg: string }) {
  const [scope] = useState(() => `diagram-copy-${++copies}`)
  const scoped = useMemo(() => scopeDiagramIds(svg, scope), [svg, scope])
  return <div className="contents" dangerouslySetInnerHTML={{ __html: scoped }} />
}
