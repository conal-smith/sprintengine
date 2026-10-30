// The brand at the foot of the app rail, below Settings (owner ruling
// 2026-10-30): the application icon's "se" and nothing else, and a click opens
// the project's GitHub repository. It replaced the "sprintengine" wordmark and
// the Nightly chip that sat at the top of the sidebar's chrome row.
//
// A nightly build wears the icon's night ground behind the letters — a small
// rounded tile, the same square the nightly application icon is drawn on — and
// a stable build wears no ground at all: the letters stand on the rail's own
// canvas, the way the stable icon's letters stand on its dark card.
//
// It says what the BUILD is, never what the updater follows. Main reads both
// (`AppUpdateState.buildChannel` from the version it was cut with, `channel`
// from the person's pick in Settings); the renderer does not parse the version
// itself, so a nightly that was switched to stable is still drawn as a nightly
// until the stable update actually installs over it — and the tooltip says
// which train it is on meanwhile.

import { useEffect, useState } from 'react'
import type { AppUpdateState } from '../../../../shared/electron-api'
import { REPOSITORY_URL } from '../../../../shared/releases-repo'
import { IconButton } from '../ui/Buttons'
import { Tooltip } from '../ui/Tooltip'
import SprintEngineMonogram from './SprintEngineMonogram'

type BuildIdentity = Pick<AppUpdateState, 'version' | 'channel' | 'buildChannel'>

const OPEN_REPOSITORY = 'Open the GitHub repository'

/** One or two sentences: the build's version, then what it updates from. */
export function nightlyBuildTooltip({ version, channel }: BuildIdentity): string {
  const build = `Nightly build ${version}.`
  if (channel === 'dev') return `${build} A development build; it does not update itself.`
  if (channel === 'stable') return `${build} Following the stable channel: the next stable release replaces it.`
  return `${build} Updates from the nightly channel.`
}

/** What the mark does, then — on a nightly — what the build is. */
export function railBrandMarkTooltip(identity: BuildIdentity | null): string {
  if (identity?.buildChannel !== 'nightly') return OPEN_REPOSITORY
  return `${OPEN_REPOSITORY}. ${nightlyBuildTooltip(identity)}`
}

/** The build identity main reports, or null until it answers. */
function useBuildIdentity(): BuildIdentity | null {
  const [identity, setIdentity] = useState<BuildIdentity | null>(null)
  useEffect(() => {
    const api = typeof window === 'undefined' ? null : window.api
    if (!api || typeof api.updateGetState !== 'function') return
    let cancelled = false
    void api
      .updateGetState()
      .then((state) => {
        if (!cancelled) setIdentity(state)
      })
      .catch(() => undefined)
    // A channel switch in Settings changes `channel`, and so the tooltip.
    const unsubscribe =
      typeof api.onUpdateStateChanged === 'function' ? api.onUpdateStateChanged((state) => setIdentity(state)) : null
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])
  return identity
}

export function RailBrandMark() {
  const identity = useBuildIdentity()
  const nightly = identity?.buildChannel === 'nightly'
  return (
    // The rail's own square at its `lg` step, so the mark lines up with the
    // Settings gear above it and lifts on hover the way every rail square does.
    // Its accessible name is the action, not the brand (principles, "The
    // product does not name itself"); the build is in the tooltip and in
    // Settings.
    <div className="app-no-drag flex shrink-0 justify-center px-2 pb-2">
      <Tooltip content={railBrandMarkTooltip(identity)} placement="right" wrapperClassName="flex">
        <IconButton
          size="lg"
          onClick={() => void window.api.openExternal(REPOSITORY_URL)}
          aria-label={OPEN_REPOSITORY}
          data-build={nightly ? 'nightly' : 'stable'}
        >
          {nightly ? (
            <span className="brand-night-tile flex size-control-sm items-center justify-center rounded-sm">
              <SprintEngineMonogram inks="icon" />
            </span>
          ) : (
            <SprintEngineMonogram />
          )}
        </IconButton>
      </Tooltip>
    </div>
  )
}
