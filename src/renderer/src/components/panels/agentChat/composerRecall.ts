import { useCallback, useRef } from 'react'
import { type ComposerKeyEvent } from './ComposerField'
import { isImeKey } from '../../../utils/imeKey'

export type ComposerRecall = { index: number | null; stashed: string }
export const EMPTY_RECALL: ComposerRecall = { index: null, stashed: '' }
export function recallPrompt(input: {
  state: ComposerRecall
  history: readonly string[]
  draft: string
  key: string
  firstLine: boolean
  lastLine: boolean
}): { state: ComposerRecall; text: string; handled: boolean } {
  const { state, history, draft, key, firstLine, lastLine } = input
  const unchanged = { state, text: draft, handled: false }
  if (key === 'Escape' && state.index !== null) return { state: EMPTY_RECALL, text: state.stashed, handled: true }
  if (key === 'ArrowUp' && firstLine && history.length && (!draft || state.index !== null)) {
    const index = Math.max(0, (state.index ?? history.length) - 1)
    return {
      state: { index, stashed: state.index === null ? draft : state.stashed },
      text: history[index],
      handled: true,
    }
  }
  if (key === 'ArrowDown' && lastLine && state.index !== null) {
    const index = state.index + 1
    return index >= history.length
      ? { state: EMPTY_RECALL, text: state.stashed, handled: true }
      : { state: { ...state, index }, text: history[index], handled: true }
  }
  return unchanged
}

export function useComposerRecall(history: readonly string[], draft: string, setDraft: (text: string) => void) {
  const state = useRef<ComposerRecall>(EMPTY_RECALL)
  const shown = useRef<string | null>(null)
  const detachRecall = useCallback(() => {
    state.current = EMPTY_RECALL
    shown.current = null
  }, [])
  const handleRecallKeyDown = (event: ComposerKeyEvent): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || isImeKey(event)) return false
    if (!['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return false
    if (shown.current !== null && shown.current !== draft) detachRecall()
    // The field measures its own line boxes, soft wraps included; counting
    // newlines would send a wrapped paragraph's second line to recall.
    const edges = event.key === 'Escape' ? { firstLine: false, lastLine: false } : event.currentTarget.visualEdges()
    const next = recallPrompt({ state: state.current, history, draft, key: event.key, ...edges })
    if (!next.handled) return false
    event.preventDefault()
    state.current = next.state
    shown.current = next.state.index === null ? null : next.text
    setDraft(next.text)
    return true
  }
  return { handleRecallKeyDown, detachRecall }
}
