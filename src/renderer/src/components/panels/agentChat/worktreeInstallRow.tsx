// The chat's worktree installing its dependencies, said in the composer's
// tray while it runs (main's worktree-pool/dependency-install.ts).
//
// A chat started from outside a window — a paired device's New chat,
// `conversation.create` — is made while its worktree's install runs, and its
// first message waits for the install. Without this the chat would sit with
// no message and no reason. A window's own New chat has no folder while its
// install runs: its chat folds the install under its working line instead,
// found by branch (`useWorktreeInstallOnBranch`).
//
// Matched by path: the install is the worktree's, and the chat works in it.
// Gone once the install ends; how it ended is the toast's and the bell's.

import { memo, useEffect, useState } from 'react'

import type { WorktreeDependencyInstallView } from '../../../../../shared/electron-api'
import { comparablePath } from '../../../../../shared/host-paths'
import { Spinner } from '../../ui'
import { ComposerTrayRow } from './composerTray'

/** The running installs after one more change: added or moved on while it runs, dropped once it ends. */
export function applyInstallChange(
  installs: readonly WorktreeDependencyInstallView[],
  view: WorktreeDependencyInstallView,
): WorktreeDependencyInstallView[] {
  const others = installs.filter((install) => install.id !== view.id)
  return view.state === 'running' ? [...others, view] : others
}

/** The install running in the folder a chat works in, if any. */
export function installIn(
  installs: readonly WorktreeDependencyInstallView[],
  folder: string | null | undefined,
): WorktreeDependencyInstallView | null {
  if (!folder) return null
  const wanted = comparablePath(folder)
  return installs.find((install) => comparablePath(install.path) === wanted) ?? null
}

/** The installs running now, kept current while `active`. Empty outside the desktop app, where there are none to hear. */
function useRunningWorktreeInstalls(active: boolean): WorktreeDependencyInstallView[] {
  const [installs, setInstalls] = useState<WorktreeDependencyInstallView[]>([])
  useEffect(() => {
    const api = typeof window === 'undefined' ? null : window.api
    if (!active || !api || typeof api.onWorktreeInstallChanged !== 'function') return
    let disposed = false
    const unsubscribe = api.onWorktreeInstallChanged((view) => {
      if (!disposed) setInstalls((current) => applyInstallChange(current, view))
    })
    // One that started before this view mounted.
    void api
      .listWorktreeInstalls?.()
      .then((running) => {
        if (!disposed) setInstalls((current) => running.reduce(applyInstallChange, current))
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [active])
  return installs
}

/** The install running in `folder` now, kept current. Null outside the desktop app, where there is none to hear. */
export function useWorktreeInstall(folder: string | null | undefined): WorktreeDependencyInstallView | null {
  return installIn(useRunningWorktreeInstalls(Boolean(folder)), folder)
}

/**
 * The install running for the worktree on `branch` now: a New chat's, whose
 * folder is not the chat's yet while the install runs (main answers the
 * worktree only once it has installed).
 */
export function useWorktreeInstallOnBranch(branch: string | null): WorktreeDependencyInstallView | null {
  const installs = useRunningWorktreeInstalls(Boolean(branch))
  return branch ? (installs.find((install) => install.branch === branch) ?? null) : null
}

// Memoised on the folder: the tray re-renders with every streamed token, and
// this row changes only when an install does.
export const WorktreeInstallTrayRow = memo(function WorktreeInstallTrayRow({
  folder,
}: {
  folder: string | null | undefined
}) {
  const install = useWorktreeInstall(folder)
  if (!install) return null
  return (
    <ComposerTrayRow glyph={<Spinner />}>
      Installing this worktree’s dependencies ({install.command}). The agent starts on them when it finishes.
      {install.lastLine ? (
        <span className="block truncate text-meta text-[color:var(--text-muted)]">{install.lastLine}</span>
      ) : null}
    </ComposerTrayRow>
  )
})
