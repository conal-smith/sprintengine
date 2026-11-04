import React from 'react'

import type { MeshPairRequestView } from '../../../../shared/tailnet-mesh'
import { OutlineButton, StatusDot } from '../ui'
import { showToast } from '../../store/toastStore'

// A request THIS machine made, while it waits (pair-from-the-scan-and-stay-
// paired, phases 2–3). The code is shown large because the person at the
// other machine has to type it; the sentence says exactly that. Main owns
// the wait, so this card is drawable anywhere — the Remote popover, Settings,
// the Mesh — and closing whichever surface asked does not end the request.

function pendingPairRequestNote(request: MeshPairRequestView, nowMs: number): string {
  const expiresAtMs = Date.parse(request.expiresAt)
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) {
    return `${request.machineName} did not answer in time. Ask again when someone is at it.`
  }
  return `Type this code on ${request.machineName} to allow it.`
}

/** "481 972": the digits grouped the way a person reads them aloud. */
function displayCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
}

export function OutboundPairRequestCard({
  request,
  now,
  variant = 'card',
}: {
  request: MeshPairRequestView
  now: number
  variant?: 'card' | 'flush'
}) {
  const [stopping, setStopping] = React.useState(false)
  const msLeft = Math.max(0, Date.parse(request.expiresAt) - now)
  const minutes = Math.floor(msLeft / 60_000)
  const seconds = Math.floor((msLeft % 60_000) / 1000)
  const lapsed = msLeft === 0
  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      await window.api.meshCancelPairing(request.requestId)
    } catch (error) {
      showToast({
        tone: 'error',
        title: 'Could not stop waiting',
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setStopping(false)
    }
  }
  const frame =
    variant === 'card'
      ? 'mx-2.5 my-1.5 rounded-md border border-[color:var(--border-default)] p-2.5'
      : // A row inside a card: the card owns the hairline, so the row owns only
        // its padding — and it pads its sides too, since the card is full-bleed.
        'px-3 py-2.5'
  return (
    <div className={frame} data-outbound-request={request.requestId}>
      <div className="flex items-center gap-2 text-meta">
        <StatusDot tone="warn" pulse={!lapsed} label="Waiting" />
        <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--text-default)]">
          Waiting for {request.machineName}
        </span>
      </div>
      <div className="my-2 rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] py-1.5 text-center">
        <div
          className="font-mono text-title tracking-[0.3em] text-[color:var(--text-strong)]"
          aria-label={`Code ${request.comparisonCode}`}
        >
          {displayCode(request.comparisonCode)}
        </div>
        <div className="mt-0.5 text-micro text-[color:var(--text-subtle)]">{pendingPairRequestNote(request, now)}</div>
      </div>
      {request.reverseOffered ? (
        <p className="mb-2 text-micro text-[color:var(--text-subtle)]">
          Allowing it also lets {request.machineName} drive this device.
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <span className="font-mono text-micro tabular-nums text-[color:var(--tone-warn)]">
          {lapsed ? 'Lapsed' : `${minutes}:${String(seconds).padStart(2, '0')}`}
        </span>
        <span className="flex-1" />
        <OutlineButton size="sm" disabled={stopping} onClick={() => void stop()}>
          {stopping ? 'Stopping…' : 'Stop waiting'}
        </OutlineButton>
      </div>
    </div>
  )
}
