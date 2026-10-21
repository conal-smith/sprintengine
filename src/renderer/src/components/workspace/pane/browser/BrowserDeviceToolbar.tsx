import React, { useEffect, useState } from 'react'

import {
  BROWSER_DEVICE_PRESETS,
  clampViewportSize,
  presetViewport,
  rotateViewport,
  type BrowserViewport,
} from '../../../../../../shared/browser-devices'
import { IconButton, Input, Select, Tooltip } from '../../../ui'
import { isImeKey } from '../../../../utils/imeKey'

// The device toolbar: a second, dismissable band under the browser toolbar
// (the one case the panel-header rule allows a second band — off by default,
// closed by its own ×). Preset select · width × height · aspect lock · rotate
// · close. Every control is control.xs because the band is 32px.

type SizedViewport = Exclude<BrowserViewport, { mode: 'fill' }>

type BrowserDeviceToolbarProps = {
  viewport: SizedViewport
  onChange: (viewport: BrowserViewport) => void
  onClose: () => void
}

const RESPONSIVE = 'responsive'

function Glyph({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const ROTATE = 'M12.5 6.5A5 5 0 0 0 4 5.2M3.5 9.5a5 5 0 0 0 8.5 1.3M4 2.5v3h3M12 13.5v-3H9'
const LOCK = 'M6.5 9.5 9.5 6.5M7 5l1-1a2.5 2.5 0 1 1 3.5 3.5l-1 1M9 11l-1 1a2.5 2.5 0 1 1-3.5-3.5l1-1'
const UNLOCK = 'M6.5 9.5 9.5 6.5M7 5l1-1a2.5 2.5 0 1 1 3.5 3.5l-1 1M9 11l-1 1a2.5 2.5 0 1 1-3.5-3.5l1-1M3 3l10 10'
const CLOSE = 'M4 4l8 8M12 4l-8 8'

function SizeField({ label, value, onCommit }: { label: string; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => {
    setDraft(String(value))
  }, [value])
  const commit = () => {
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      setDraft(String(value))
      return
    }
    const next = clampViewportSize(parsed)
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }
  return (
    // `xs` is the kit's dense numeric step — `h-control-xs px-2 text-meta` —
    // added for exactly this case: a 30px field would be the tallest thing in a
    // toolbar of 26px icon buttons.
    <Input
      type="text"
      size="xs"
      fullWidth={false}
      inputMode="numeric"
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (isImeKey(event)) return
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          setDraft(String(value))
          event.currentTarget.blur()
        }
      }}
      aria-label={label}
      className="w-[60px] text-center font-mono tabular-nums"
    />
  )
}

export function BrowserDeviceToolbar({ viewport, onChange, onClose }: BrowserDeviceToolbarProps) {
  const [aspectLocked, setAspectLocked] = useState(false)
  const selectValue = viewport.mode === 'preset' ? viewport.presetId : RESPONSIVE
  const items = [
    { value: RESPONSIVE, label: 'Responsive' },
    ...BROWSER_DEVICE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
  ]

  const setSize = (width: number, height: number) => {
    onChange({ mode: 'freeform', width: clampViewportSize(width), height: clampViewportSize(height) })
  }

  return (
    <div className="flex h-control-md shrink-0 items-center gap-1.5 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-1.5">
      <Select
        ariaLabel="Device"
        items={items}
        value={selectValue}
        onChange={(value) => {
          if (value === RESPONSIVE) setSize(viewport.width, viewport.height)
          else onChange(presetViewport(value))
        }}
        triggerMinWidthClassName="min-w-0"
        className="max-w-[160px]"
      />
      <SizeField
        label="Viewport width"
        value={viewport.width}
        onCommit={(raw) => {
          // Clamp first, then derive the other axis, so a locked ratio holds
          // at the bounds instead of rounding past them.
          const width = clampViewportSize(raw)
          setSize(width, aspectLocked ? Math.round((width * viewport.height) / viewport.width) : viewport.height)
        }}
      />
      <span aria-hidden="true" className="text-micro text-[color:var(--text-subtle)]">
        ×
      </span>
      <SizeField
        label="Viewport height"
        value={viewport.height}
        onCommit={(raw) => {
          const height = clampViewportSize(raw)
          setSize(aspectLocked ? Math.round((height * viewport.width) / viewport.height) : viewport.width, height)
        }}
      />
      <Tooltip content={aspectLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'} placement="bottom">
        <IconButton
          onClick={() => setAspectLocked((value) => !value)}
          aria-label={aspectLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio'}
          pressed={aspectLocked}
        >
          <Glyph d={aspectLocked ? LOCK : UNLOCK} />
        </IconButton>
      </Tooltip>
      <Tooltip content="Rotate" placement="bottom">
        <IconButton onClick={() => onChange(rotateViewport(viewport))} aria-label="Rotate viewport">
          <Glyph d={ROTATE} />
        </IconButton>
      </Tooltip>
      <span className="flex-1" />
      <Tooltip content="Hide device toolbar" placement="bottom">
        <IconButton onClick={onClose} aria-label="Hide device toolbar">
          <Glyph d={CLOSE} />
        </IconButton>
      </Tooltip>
    </div>
  )
}
