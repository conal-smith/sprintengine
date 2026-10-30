import React, { useState } from 'react'

import { useAppUpdateStore } from '../../store/appUpdateStore'
import { showToast } from '../../store/toastStore'
import { IconButton, Tooltip, TONE_COLOR_VAR, TONE_SOFT_VAR } from '../ui'
import { useOptionalConfirmDialog } from '../ui/ConfirmDialog'
import { Spinner } from '../ui/Spinner'
import { appUpdateInstallConfirmation, appUpdateRailView, type AppUpdateRailView } from './appUpdateRail'
import { downloadAppUpdate, restartToUpdateFromToast } from './manager/appUpdateToast'

// The app update's glyph at the rail's foot (appUpdateRail.ts has the steps).
// It sits on the rail's own `lg` square beside Usage, the account and the gear,
// and is ghost like them until a release is waiting: then the square takes the
// accent's soft ground and the glyph the accent — the one thing on the rail
// asking to be pressed. A word or a shape says each state; there is no dot.

// An arrow into a tray (lucide "download" geometry).
function DownloadGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 15V3m-5 7 5 5 5-5M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A clockwise arrow coming round (lucide "rotate-cw" geometry): restart.
function RestartGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8m0-5v5h-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// An arrow rising out of a circle (lucide "circle-arrow-up" geometry): the
// resting glyph, which checks for a newer release.
function UpdateGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="m16 12-4-4-4 4m4 4V8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The download arrow inside a ring that fills clockwise from twelve as the
// bytes arrive. The ring's track is the glyph's own colour, faint.
const RING_RADIUS = 14
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

function DownloadProgressGlyph({ percent }: { percent: number }) {
  return (
    <span className="relative grid size-full place-items-center">
      <svg aria-hidden="true" viewBox="0 0 32 32" className="absolute inset-0 size-full -rotate-90">
        <circle
          cx="16"
          cy="16"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.22"
          strokeWidth="1.5"
        />
        <circle
          cx="16"
          cy="16"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
          className="transition-[stroke-dashoffset] duration-[var(--motion-fast)] motion-reduce:transition-none"
        />
      </svg>
      <DownloadGlyph className="icon-md" />
    </span>
  )
}

function RailUpdateGlyph({ view }: { view: AppUpdateRailView }) {
  switch (view.phase) {
    case 'checking':
    case 'installing':
      return <Spinner size={18} />
    case 'downloading':
      return <DownloadProgressGlyph percent={view.percent ?? 0} />
    case 'available':
      return <DownloadGlyph className="icon-lg" />
    case 'ready':
      return <RestartGlyph className="icon-lg" />
    case 'idle':
      return <UpdateGlyph className="icon-lg" />
  }
}

function warn(title: string, description: string): void {
  showToast({ id: 'app-update:rail', tone: 'warn', title, description })
}

export function AppUpdateRailButton({ placement = 'right' }: { placement?: 'right' | 'top' }) {
  const state = useAppUpdateStore((s) => s.state)
  const dialog = useOptionalConfirmDialog()
  const [pending, setPending] = useState(false)
  const view = appUpdateRailView(state)
  if (!state || !view) return null

  const busy = pending || view.action === 'none'

  const press = async () => {
    if (busy) return
    const api = window.api
    setPending(true)
    try {
      if (view.action === 'check') {
        const result = await api.updateCheck()
        if (!result.ok) warn('Could not check for updates', result.message)
      } else if (view.action === 'download') {
        await downloadAppUpdate(state.updateVersion)
      } else if (view.action === 'install') {
        const question = appUpdateInstallConfirmation(state)
        const confirmed = dialog ? await dialog.confirm(question) : true
        if (confirmed) await restartToUpdateFromToast(state)
      }
    } catch (error) {
      warn('Update failed', error instanceof Error ? error.message : String(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <Tooltip content={view.label} placement={placement}>
      <IconButton
        size="lg"
        onClick={() => void press()}
        aria-label={view.label}
        // Busy while main works on it. A download in flight is not dimmed or
        // disabled: it is lit news, and a press on it simply does nothing.
        busy={pending || view.phase === 'checking' || view.phase === 'installing'}
        data-update-phase={view.phase}
        style={view.lit ? { color: TONE_COLOR_VAR.accent, backgroundColor: TONE_SOFT_VAR.accent } : undefined}
      >
        <RailUpdateGlyph view={view} />
      </IconButton>
    </Tooltip>
  )
}
