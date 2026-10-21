import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'

import type { BrowserTabState } from '../../../../../../shared/browser'
import { normalizeBrowserUrlInput } from '../../../../../../shared/browser'
import { IconButton, Input, Tooltip } from '../../../ui'
import { isImeKey } from '../../../../utils/imeKey'

// The browser tab's one band of chrome (panel-header geometry, 34px): back ·
// forward · reload/stop · the address field · the right cluster. Loading is a
// 2px accent hairline riding the band's bottom border — accent as a hairline
// marking a live process, never a second band.

export type BrowserToolbarHandle = {
  focusAddress: () => void
}

type BrowserToolbarProps = {
  state: BrowserTabState | null
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop: () => void
  onOpenExternal: () => void
  /** After Enter in the address field: the host hands focus to the guest. */
  onAfterSubmit?: () => void
  /** The right cluster: inspect, screenshot, the view menu. */
  trailing?: React.ReactNode
}

function Glyph({ d, className }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className ?? 'icon-sm'} aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const BACK = 'M10 3.5 5.5 8l4.5 4.5'
const FORWARD = 'M6 3.5 10.5 8 6 12.5'
const RELOAD = 'M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3'
const STOP = 'M4.5 4.5l7 7M11.5 4.5l-7 7'
const EXTERNAL = 'M6.5 3H3v10h10V9.5M9.5 3H13v3.5M13 3 7.5 8.5'

export const BrowserToolbar = forwardRef<BrowserToolbarHandle, BrowserToolbarProps>(function BrowserToolbar(
  { state, onNavigate, onBack, onForward, onReload, onStop, onOpenExternal, onAfterSubmit, trailing },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null)
  const currentUrl = state?.url && state.url !== 'about:blank' ? state.url : ''
  // The field shows the page's URL until the person starts typing; a draft
  // survives navigation events underneath it until Enter or Escape.
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? currentUrl

  useImperativeHandle(ref, () => ({
    focusAddress: () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    },
  }))

  // A completed navigation elsewhere (a link click) drops a draft nobody is
  // typing in, so the field never shows a stale address over a new page.
  useEffect(() => {
    if (draft !== null && document.activeElement !== inputRef.current) setDraft(null)
  }, [currentUrl, draft])

  const submit = () => {
    const next = normalizeBrowserUrlInput(value)
    if (!next) return
    setDraft(null)
    onNavigate(next)
    inputRef.current?.blur()
    onAfterSubmit?.()
  }

  const loading = state?.loading ?? false
  const hasPage = Boolean(currentUrl)

  return (
    <div className="relative flex h-control-md shrink-0 items-center gap-0.5 border-b border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-1.5">
      <Tooltip content="Back" placement="bottom">
        <IconButton onClick={onBack} aria-label="Back" disabled={!state?.canGoBack}>
          <Glyph d={BACK} />
        </IconButton>
      </Tooltip>
      <Tooltip content="Forward" placement="bottom">
        <IconButton onClick={onForward} aria-label="Forward" disabled={!state?.canGoForward}>
          <Glyph d={FORWARD} />
        </IconButton>
      </Tooltip>
      {loading ? (
        <Tooltip content="Stop" placement="bottom">
          <IconButton onClick={onStop} aria-label="Stop loading">
            <Glyph d={STOP} />
          </IconButton>
        </Tooltip>
      ) : (
        <Tooltip content="Reload" placement="bottom">
          <IconButton onClick={onReload} aria-label="Reload" disabled={!hasPage}>
            <Glyph d={RELOAD} />
          </IconButton>
        </Tooltip>
      )}
      {/* `xs` is the kit's dense step: 26px, so the address bar is the same
          height as the icon buttons flanking it. */}
      <Input
        ref={inputRef}
        type="text"
        size="xs"
        fullWidth={false}
        value={value}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (isImeKey(event)) return
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            // First press restores the page's URL; a second, with nothing to
            // restore, leaves the field.
            if (draft !== null) setDraft(null)
            else inputRef.current?.blur()
          }
        }}
        placeholder="Enter a URL"
        aria-label="Address"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className="mx-1 min-w-0 flex-1 font-mono"
      />
      <Tooltip content="Open in system browser" placement="bottom">
        <IconButton onClick={onOpenExternal} aria-label="Open in system browser" disabled={!hasPage}>
          <Glyph d={EXTERNAL} />
        </IconButton>
      </Tooltip>
      {trailing}
      {loading ? (
        // The one live-process motion: an indeterminate load has no progress
        // to report, so the hairline breathes rather than pretending to fill.
        <span
          role="progressbar"
          aria-label="Loading page"
          className="absolute inset-x-0 bottom-0 h-0.5 w-3/5 animate-pulse bg-[color:var(--accent-primary)] motion-reduce:animate-none"
        />
      ) : null}
    </div>
  )
})
