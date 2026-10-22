import { useEffect, useState } from 'react'

import {
  gitRepoTrustNeedsAnswer,
  type GitRepoTrustDecision,
  type GitRepoTrustView,
} from '../../../../shared/ipc/git-repo-trust'
import { GhostButton } from '../ui'
import { Banner } from '../ui/Banner'

/** At most this many setting names in the strip; the rest are counted. */
const NAMED_SETTINGS = 3

/** The strip's sentence for the settings a repository's config names. */
export function repoTrustMessage(settings: readonly string[]): string {
  const named = settings.slice(0, NAMED_SETTINGS).join(', ')
  const more = settings.length > NAMED_SETTINGS ? ` and ${settings.length - NAMED_SETTINGS} more` : ''
  return `This repository's own git config names programs for git to run (${named}${more}). Studio's background git leaves them off until you trust this repository.`
}

// The strip across the top of a project whose repository's own git config
// names programs git would run (a filter, a merge driver, a hooks folder…).
// Until the person trusts the repository, the git the app starts by itself
// there runs with those programs off (git-run.ts). Shown once: either answer
// puts it away until the settings change.
export function RepoTrustBanner({ folderPath }: { folderPath: string | null }) {
  const [view, setView] = useState<GitRepoTrustView | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    setView(null)
    if (!folderPath || typeof window.api?.getGitRepoTrust !== 'function') return
    let current = true
    void window.api
      .getGitRepoTrust(folderPath)
      .then((next) => {
        if (current) setView(next)
      })
      .catch(() => undefined)
    const unsubscribe = window.api.onGitRepoTrustChanged?.((changed) => {
      setView((shown) => (shown && changed && shown.repoPath === changed.repoPath ? changed : shown))
    })
    return () => {
      current = false
      unsubscribe?.()
    }
  }, [folderPath])

  if (!folderPath || !gitRepoTrustNeedsAnswer(view)) return null

  const answer = (decision: GitRepoTrustDecision) => {
    setPending(true)
    void window.api
      .answerGitRepoTrust({ folderPath, hash: view.hash, decision })
      .then((next) => setView(next))
      .catch(() => undefined)
      .finally(() => setPending(false))
  }

  return (
    <Banner
      tone="warn"
      message={repoTrustMessage(view.settings)}
      action={
        <>
          <GhostButton disabled={pending} onClick={() => answer('trusted')}>
            Trust this repository
          </GhostButton>
          <GhostButton disabled={pending} onClick={() => answer('dismissed')}>
            Not now
          </GhostButton>
        </>
      }
    />
  )
}
