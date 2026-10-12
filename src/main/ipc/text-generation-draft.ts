import path from 'node:path'

import type { TextGenerationCliRuntimeOverrides, TextGenerationEngine } from '../../shared/text-generation/contract'
import { normalizeWritingStyle, type TextGenerationWritingStyle } from '../../shared/text-generation/writing-style'

// What the two drafting channels share — the chat's "Create PR" and the Git
// panel's "Write commit message": how a window's request names the engine,
// the per-CLI runtime overrides and the writing style, and how a draft the
// window stopped stops its CLI. One reading, so the two cannot disagree about
// what a well-formed request is.

export type DraftRequest = {
  engine: TextGenerationEngine
  cliRuntimes?: TextGenerationCliRuntimeOverrides
  /** Names the draft, so the window can stop it. Null when the window sent none. */
  draftId: string | null
  /** The person's writing style; anything unreadable is the default, match the repository. */
  writingStyle: TextGenerationWritingStyle
}

/** The engine, runtimes, id and style out of a window's request, or null when the engine is unreadable. */
export function readDraftRequest(record: Record<string, unknown>): DraftRequest | null {
  const { engine, cliRuntimes, draftId, writingStyle } = record
  if (!engine || typeof engine !== 'object') return null
  const { cli, model, reasoning } = engine as Record<string, unknown>
  if (typeof cli !== 'string' || typeof model !== 'string') return null
  return {
    engine: { cli, model, ...(typeof reasoning === 'string' && reasoning ? { reasoning } : {}) },
    ...(cliRuntimes && typeof cliRuntimes === 'object'
      ? { cliRuntimes: cliRuntimes as TextGenerationCliRuntimeOverrides }
      : {}),
    draftId: typeof draftId === 'string' && draftId.length > 0 && draftId.length <= 200 ? draftId : null,
    writingStyle: normalizeWritingStyle(writingStyle),
  }
}

/**
 * Drafts in flight, by the id the window gave each. A second draft under the
 * same id stops the first; `cancel` stops one by id, which is how closing a
 * dialog or pressing stop ends its CLI rather than leaving it to run to its
 * deadline for an answer nobody will read.
 */
export function createDraftRuns() {
  const runs = new Map<string, AbortController>()
  return {
    async run<T>(draftId: string | null, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const controller = new AbortController()
      if (draftId) {
        runs.get(draftId)?.abort()
        runs.set(draftId, controller)
      }
      try {
        return await work(controller.signal)
      } finally {
        if (draftId && runs.get(draftId) === controller) runs.delete(draftId)
      }
    },
    cancel(draftId: unknown): void {
      if (typeof draftId !== 'string') return
      runs.get(draftId)?.abort()
      runs.delete(draftId)
    },
  }
}

/** An absolute folder, or nothing: a relative one would resolve against main's own. */
export function folderOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) return null
  return path.isAbsolute(value) ? value : null
}
