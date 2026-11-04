// Shared KbdChord primitive. A presentational keyboard-chord display.
// Renders each key as a real <kbd> element so screen readers announce the
// chord with kbd semantics. Token: the monospace family wired through the
// global .font-mono rule in src/renderer/src/assets/index.css.
//
// Not interactive — the chord describes a shortcut, it does not invoke one.
// The caller wires the actual keyboard handler on the control the chord
// labels (button, menu item, etc.).
import React from 'react'
import { isModifierTapChord, keybindingToKbdKeys, type KeybindingPlatform } from '../../commands/keybindings'

type KbdChordProps = {
  /** Ordered keys, e.g. ['Cmd', 'K'] or ['Shift', 'Enter']. */
  keys?: readonly string[]
  /** Canonical or user-entered shortcut, e.g. "Primary+K" or "CmdOrCtrl+K". */
  chord?: string
  platform?: KeybindingPlatform
  /** Visual separator between keys. Defaults to a thin '+' glyph. */
  separator?: React.ReactNode
  /** Accessible name for the chord, e.g. "Command K". Joined keys when omitted. */
  ariaLabel?: string
  className?: string
}

export function KbdChord({ keys, chord, platform, separator, ariaLabel, className }: KbdChordProps) {
  const renderedStrokes = chord ? keybindingToKbdKeys(chord, platform) : []
  const displayStrokes = renderedStrokes.length > 0 ? renderedStrokes : keys ? [keys] : []
  // `Shift Shift` is one gesture (a double tap), not a stroke followed by
  // another stroke, so it renders as two adjacent keys with no "then" between.
  const tapChord = chord ? isModifierTapChord(chord) : false
  const label = ariaLabel ?? displayStrokes.map((stroke) => stroke.join(' ')).join(tapChord ? ' ' : ' then ')
  // Mac glyphs sit together ("⌘ K", no plus), as the menu bar draws them.
  const sep = separator ?? (platform === 'darwin' ? null : '+')
  return (
    <span role="img" aria-label={label} className={['inline-flex items-center gap-1', className ?? ''].join(' ')}>
      {displayStrokes.map((stroke, strokeIndex) => (
        <React.Fragment key={`stroke-${strokeIndex}`}>
          {strokeIndex > 0 && !tapChord ? (
            <span aria-hidden="true" className="px-0.5 font-mono text-micro text-[color:var(--text-disabled)]">
              then
            </span>
          ) : null}
          {stroke.map((key, index) => (
            <React.Fragment key={`${strokeIndex}-${index}-${key}`}>
              {index > 0 && sep !== null ? (
                <span aria-hidden="true" className="font-mono text-micro text-[color:var(--text-disabled)]">
                  {sep}
                </span>
              ) : null}
              <kbd className="font-mono inline-flex h-4 min-w-[16px] items-center justify-center rounded-xs border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-1 text-micro text-[color:var(--text-muted)]">
                {key}
              </kbd>
            </React.Fragment>
          ))}
        </React.Fragment>
      ))}
    </span>
  )
}
