// The Git panel's "Write commit message": the person's own agent CLI drafts a
// message for what is staged, and it lands in the commit message box as a
// draft they edit. Nothing is committed: Commit is still theirs to press.
//
// Staged, because that is what Commit commits: the panel's checkboxes are the
// index, and `commitGitChanges` runs `git commit` on the index alone. So the
// button wants exactly what Commit wants — at least one checked file — and the
// main process reads `git diff --cached`, never the working tree.
//
// A box that already holds a message is asked about before the draft starts,
// with the confirm dialog every other destructive step in this panel uses. A
// silent replace would destroy what the person wrote, and the box is a
// controlled field, so the editor's own undo cannot bring it back once the
// app sets the value. Asking first, rather than after the draft, also spends
// no CLI call on a draft the person did not want. An empty box is filled
// without asking, since there is nothing to lose.
//
// While the draft runs the box is read-only, so what lands can only replace
// what the person agreed to replace, and the button turns into "stop", which
// stops the CLI in main. A failure keeps the box as it was and says why on the
// panel's message line, the way the pull request draft does in its dialog.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { isMachinePath } from '../../../../../shared/machine-paths'
import {
  resolveTextGenerationEngine,
  type CommitMessageResult,
  type TextGenerationEngine,
} from '../../../../../shared/text-generation/contract'
import { resolveStoreTextGenerationEngine } from '../../../store/generatedWorkspaceTitle'
import { useWorkspaceStore } from '../../../store/workspaceStore'

/** Why the button cannot draft right now, in words its tooltip and accessible name carry. */
export function commitMessageDraftUnavailableReason(input: {
  /** The shell can draft at all: a browser tab has no agent CLI of its own to run. */
  canDraft: boolean
  repoRoot: string | null
  textGenerationEnabled: boolean
  engine: TextGenerationEngine | null
  hasStaged: boolean
}): string | null {
  if (!input.canDraft) return 'available in the desktop app'
  if (!input.repoRoot) return 'no repository here'
  if (isMachinePath(input.repoRoot)) return 'not available for a checkout on another machine'
  // The setting before the files: checking files would not help with it.
  if (!input.textGenerationEnabled) return 'text generation is off in Settings → Agents'
  if (!input.engine) return 'needs Claude Code or Codex installed'
  if (!input.hasStaged) return 'check the files to commit first'
  return null
}

export type CommitMessageDraftOutcome =
  | { kind: 'filled'; message: string }
  /** The box held a message and the person chose to keep it. */
  | { kind: 'kept' }
  | { kind: 'stopped' }
  | { kind: 'failed'; reason: string }
  /** The panel moved to another checkout, or closed, while the draft ran: it lands nowhere. */
  | { kind: 'stale' }

/**
 * One draft, start to finish, with the panel's parts handed in so the rule
 * can be proved without a panel: ask before replacing a written message, run
 * the request, and fill the box only when it answered and the panel is still
 * where it was.
 */
export async function runCommitMessageDraft(steps: {
  current: () => string
  confirmReplace: () => Promise<boolean>
  request: () => Promise<CommitMessageResult>
  stillCurrent: () => boolean
  fill: (message: string) => void
}): Promise<CommitMessageDraftOutcome> {
  if (steps.current().trim() && !(await steps.confirmReplace())) return { kind: 'kept' }
  if (!steps.stillCurrent()) return { kind: 'stale' }
  let result: CommitMessageResult
  try {
    result = await steps.request()
  } catch (error) {
    result = { ok: false, code: 'transport', message: error instanceof Error ? error.message : String(error) }
  }
  if (!steps.stillCurrent()) return { kind: 'stale' }
  if (!result.ok) return result.code === 'cancelled' ? { kind: 'stopped' } : { kind: 'failed', reason: result.message }
  steps.fill(result.value.message)
  return { kind: 'filled', message: result.value.message }
}

export type CommitMessageDraftControl = {
  drafting: boolean
  /** Null when the button can draft. */
  unavailableReason: string | null
  start: () => void
  stop: () => void
}

/**
 * The panel's half: whether the button can draft, and the draft in flight.
 * `scopeKey` names the checkout the box belongs to; when it changes, or the
 * panel closes, a running draft is stopped and its answer dropped.
 */
export function useCommitMessageDraft(options: {
  repoRoot: string | null
  scopeKey: string
  hasStaged: boolean
  readMessage: () => string
  writeMessage: (message: string) => void
  confirmReplace: () => Promise<boolean>
  report: (message: { tone: 'neutral' | 'error' | 'success'; text: string } | null) => void
  focusMessage: () => void
}): CommitMessageDraftControl {
  const textGeneration = useWorkspaceStore((s) => s.appSettings.textGeneration)
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const cliAvailability = useWorkspaceStore((s) => s.cliAvailability)
  const engine = useMemo(
    () =>
      resolveTextGenerationEngine(
        textGeneration,
        (pluginCatalogEntries ?? []).map((entry) => entry.id),
        (cli) => cliAvailability?.[cli]?.installed,
      ),
    [textGeneration, pluginCatalogEntries, cliAvailability],
  )
  const canDraft = typeof window !== 'undefined' && typeof window.api?.draftCommitMessage === 'function'
  const unavailableReason = commitMessageDraftUnavailableReason({
    canDraft,
    repoRoot: options.repoRoot,
    textGenerationEnabled: textGeneration.enabled,
    engine,
    hasStaged: options.hasStaged,
  })

  const [drafting, setDrafting] = useState(false)
  // The draft in flight: its id, so stop can name it, and the scope it was
  // started in, so an answer for another checkout's box is dropped.
  const running = useRef<{ draftId: string; scopeKey: string } | null>(null)
  const latest = useRef(options)
  latest.current = options

  const stop = useCallback(() => {
    const draft = running.current
    if (!draft) return
    void window.api.cancelCommitMessageDraft?.(draft.draftId)?.catch(() => undefined)
  }, [])

  // A new checkout, or the panel closing, ends the draft: its answer belongs
  // to a box that is no longer on screen.
  useEffect(
    () => () => {
      const draft = running.current
      if (!draft) return
      running.current = null
      setDrafting(false)
      void window.api.cancelCommitMessageDraft?.(draft.draftId)?.catch(() => undefined)
    },
    [options.repoRoot, options.scopeKey],
  )

  const start = useCallback(() => {
    const { repoRoot, scopeKey } = latest.current
    if (running.current || unavailableReason || !repoRoot) return
    const chosen = resolveStoreTextGenerationEngine()
    if (!chosen) return
    const draftId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const settings = useWorkspaceStore.getState().appSettings
    const isThisDraft = () => running.current?.draftId === draftId
    // Claimed before the first step, which may answer synchronously: an empty
    // box goes straight to the request, and it checks it is still the draft.
    running.current = { draftId, scopeKey }
    void runCommitMessageDraft({
      current: latest.current.readMessage,
      confirmReplace: latest.current.confirmReplace,
      stillCurrent: () => isThisDraft() && running.current?.scopeKey === latest.current.scopeKey,
      request: () => {
        setDrafting(true)
        latest.current.report({ tone: 'neutral', text: 'Writing a commit message from the staged changes…' })
        return window.api.draftCommitMessage({
          repoRoot,
          engine: chosen,
          draftId,
          writingStyle: settings.textGeneration.writingStyle,
          ...(settings.cliRuntimes ? { cliRuntimes: settings.cliRuntimes } : {}),
        })
      },
      fill: (message) => latest.current.writeMessage(message),
    }).then((outcome) => {
      if (!isThisDraft()) return
      running.current = null
      setDrafting(false)
      const { report, focusMessage } = latest.current
      if (outcome.kind === 'filled') {
        report({ tone: 'success', text: 'Drafted a commit message. Edit it before you commit.' })
        // After the box is writable again, which is the next paint.
        window.requestAnimationFrame(() => focusMessage())
      } else if (outcome.kind === 'stopped') {
        report({ tone: 'neutral', text: 'Stopped writing the commit message.' })
      } else if (outcome.kind === 'failed') {
        report({ tone: 'error', text: `The commit message could not be written: ${outcome.reason}` })
      }
    })
  }, [unavailableReason])

  return { drafting, unavailableReason, start, stop }
}
