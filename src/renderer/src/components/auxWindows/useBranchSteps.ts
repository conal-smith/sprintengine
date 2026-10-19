import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { selectedEntry, stripEntriesFrom } from './branchSteps'
import { isWindowVisible, onWindowVisibilityChange } from '../../utils/windowActivity'
import type { BranchStepDiff, BranchStepSelection, BranchStepsSnapshot } from '../../../../shared/electron-api'

/**
 * The branch's steps and the selected step's diff
 * (the-diff-an-agent-made / changed-files-and-commit-steps).
 *
 * Read live and never cached across a change: a rebase or an amend
 * re-identifies commits, so a strip held from before one would be confidently
 * wrong about work that no longer exists under those hashes.
 *
 * TWO triggers, and the second exists because the first is not enough. The
 * caller's git-status snapshot fires whenever the working tree moves, which is
 * the common case and the cheap one. But `GitStatusSnapshot` carries no branch
 * and no HEAD, so on a CLEAN tree a rebase, a `commit --amend` and a
 * `git checkout other-branch` all leave its signature identical — and a review
 * confirmed the strip then kept the previous branch's chips indefinitely, still
 * clickable, because the reflog keeps the objects. So main's git-directory
 * watch backs the snapshot up: every one of those moves rewrites HEAD or a ref,
 * and main says so (`watchGitCheckout`, git-repo-watch.ts). It used to be a
 * ten-second interval, which re-read the strip whether or not anything moved.
 */
export type BranchStepsState = {
  snapshot: BranchStepsSnapshot | null
  diff: BranchStepDiff | null
  selection: BranchStepSelection
  loading: boolean
  select: (selection: BranchStepSelection) => void
}

const SPAN: BranchStepSelection = { kind: 'span' }

export function useBranchSteps(
  repoRoot: string | null,
  enabled: boolean,
  revision: unknown,
  // A step someone outside the strip asked for — an agent's editor.open_diff
  // naming the branch, the uncommitted tail or one commit. Applied once per
  // `key`, after which the strip is the person's again.
  requested: { selection: BranchStepSelection; key: string } | null = null,
  // What the host kept of an earlier mount: the step that was open and the
  // request it was chosen after. A pane tab unmounts its viewer when another
  // tab is shown, and coming back put the strip on the whole branch, or on an
  // agent's request the person had already moved on from.
  kept: { step: BranchStepSelection; afterReveal: string | null } | null = null,
  onKeep?: (kept: { step: BranchStepSelection; afterReveal: string | null }) => void,
): BranchStepsState {
  const [snapshot, setSnapshot] = useState<BranchStepsSnapshot | null>(null)
  const [diff, setDiff] = useState<BranchStepDiff | null>(null)
  const [selection, setSelection] = useState<BranchStepSelection>(() => kept?.step ?? SPAN)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !repoRoot || typeof window.api?.getBranchSteps !== 'function') {
      setSnapshot(null)
      return
    }
    let cancelled = false
    // A read skipped while the window could not be seen runs when it is shown
    // again, so a ref that moved in the meantime is not missed until the next
    // change. The window-activity signal, not `document.hidden`, which macOS
    // leaves false for a minimized window.
    let missed = false
    const read = async (): Promise<void> => {
      if (!isWindowVisible()) {
        missed = true
        return
      }
      missed = false
      try {
        const next = await window.api.getBranchSteps(repoRoot)
        if (!cancelled) setSnapshot(next)
      } catch {
        // Quiet: the strip falls back to the span, which always reads.
        if (!cancelled) setSnapshot(null)
      }
    }
    void read()
    const stopWatching =
      typeof window.api.watchGitCheckout === 'function'
        ? window.api.watchGitCheckout(repoRoot, (change) => {
            if (change.kinds.includes('refs')) void read()
          })
        : null
    const stopVisibility = onWindowVisibilityChange((visible) => {
      if (visible && missed) void read()
    })
    return () => {
      cancelled = true
      stopWatching?.()
      stopVisibility()
    }
  }, [repoRoot, enabled, revision])

  // A repo change must not leave the previous repo's chips on screen while the
  // new snapshot is in flight — the selection would be resolved against a strip
  // belonging to somewhere else.
  // On a change of repository, not on mount: a mount starts from what was kept.
  // A request still standing is applied again in the new repository.
  const shownRepoRoot = useRef(repoRoot)
  const keptAfter = useRef(kept?.afterReveal ?? null)
  useEffect(() => {
    if (shownRepoRoot.current === repoRoot) return
    shownRepoRoot.current = repoRoot
    keptAfter.current = null
    setSnapshot(null)
    setSelection(SPAN)
  }, [repoRoot])

  // After the repo reset above, so a request that arrives with a new repository
  // is not immediately undone by it. A request the kept step was already chosen
  // after is not applied again on a remount.
  const requestedKey = requested?.key ?? null
  const requestedRef = useRef(requested)
  requestedRef.current = requested
  useEffect(() => {
    if (!requestedKey || !requestedRef.current || requestedKey === keptAfter.current) return
    keptAfter.current = requestedKey
    setSelection(requestedRef.current.selection)
  }, [requestedKey, repoRoot])

  const onKeepRef = useRef(onKeep)
  onKeepRef.current = onKeep
  useEffect(() => {
    onKeepRef.current?.({ step: selection, afterReveal: keptAfter.current })
  }, [selection])

  // A selection can stop existing under us — a rebase drops the hash a person
  // had open. Resolving through the strip's own entries means the surface falls
  // back to the span rather than showing an empty list beneath a dead chip.
  const resolved = useMemo(() => {
    if (!enabled) return SPAN
    return selectedEntry(stripEntriesFrom(snapshot), selection).selection
  }, [enabled, snapshot, selection])

  useEffect(() => {
    if (!enabled || !repoRoot || typeof window.api?.getBranchStepDiff !== 'function') {
      setDiff(null)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const next = await window.api.getBranchStepDiff(repoRoot, resolved)
        if (!cancelled) setDiff(next)
      } catch {
        if (!cancelled) setDiff(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // `resolved` is a fresh object each render, so the key is its content.
  }, [repoRoot, enabled, revision, resolved.kind, resolved.kind === 'commit' ? resolved.hash : ''])

  const select = useCallback((next: BranchStepSelection) => setSelection(next), [])

  return { snapshot, diff, selection: resolved, loading, select }
}
