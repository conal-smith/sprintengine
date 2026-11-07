import React from 'react'

import type { MachineColour, MachineIdentity, MachineKind } from '../../../../shared/machine-identity'
import {
  DeviceDesktopGlyph,
  DeviceLaptopGlyph,
  MachineBoardGlyph,
  MachineCloudGlyph,
  MachineContainerGlyph,
  MachineMiniGlyph,
  MachineServerGlyph,
  MachineTowerGlyph,
  WslMachineGlyph,
} from '../AppIcons'

// A machine's mark: the drawing of its kind, in its colour (owner ruling
// 2026-10-04; design-system/components/glyphs → Machine kinds). One map from
// kind to drawing and one from colour to ink, so the composer's strip, the
// sidebar, the chat tabs, the machine picker and Settings › Machines cannot
// draw one machine two ways.

const KIND_GLYPH: Record<MachineKind, (props: { className?: string }) => React.JSX.Element> = {
  laptop: DeviceLaptopGlyph,
  desktop: DeviceDesktopGlyph,
  mini: MachineMiniGlyph,
  tower: MachineTowerGlyph,
  server: MachineServerGlyph,
  cloud: MachineCloudGlyph,
  container: MachineContainerGlyph,
  board: MachineBoardGlyph,
  wsl: WslMachineGlyph,
}

/**
 * The ink each colour paints a glyph in: the seven identity hues, and the
 * neutral, which is `text.muted`. Written out whole so the build sees every
 * class.
 */
export const MACHINE_COLOUR_INK: Record<MachineColour, string> = {
  blue: 'text-[color:var(--sem-color-mark-blue)]',
  teal: 'text-[color:var(--sem-color-mark-teal)]',
  cyan: 'text-[color:var(--sem-color-mark-cyan)]',
  orange: 'text-[color:var(--sem-color-mark-orange)]',
  yellow: 'text-[color:var(--sem-color-mark-yellow)]',
  violet: 'text-[color:var(--sem-color-mark-violet)]',
  red: 'text-[color:var(--sem-color-mark-red)]',
  neutral: 'text-[color:var(--text-muted)]',
}

/** The same colours as a fill, for the colour picker's swatches and nothing else. */
export const MACHINE_COLOUR_FILL: Record<MachineColour, string> = {
  blue: 'bg-[color:var(--sem-color-mark-blue)]',
  teal: 'bg-[color:var(--sem-color-mark-teal)]',
  cyan: 'bg-[color:var(--sem-color-mark-cyan)]',
  orange: 'bg-[color:var(--sem-color-mark-orange)]',
  yellow: 'bg-[color:var(--sem-color-mark-yellow)]',
  violet: 'bg-[color:var(--sem-color-mark-violet)]',
  red: 'bg-[color:var(--sem-color-mark-red)]',
  neutral: 'bg-[color:var(--text-muted)]',
}

/** A kind's drawing, in the caller's ink. */
export function MachineKindGlyph({ kind, className }: { kind: MachineKind; className?: string }): React.JSX.Element {
  const Glyph = KIND_GLYPH[kind]
  return <Glyph className={className} />
}

/**
 * A machine's glyph in its colour. Decorative: the surface it sits on names the
 * machine (a label beside it, a tooltip, an accessible name), and the glyph
 * carries `data-machine-mark` with the machine's id so a test or a pass can
 * find it.
 */
export function MachineGlyph({
  identity,
  className = 'icon-xs shrink-0',
  inheritInk = false,
}: {
  identity: MachineIdentity
  className?: string
  /** Take the surrounding ink instead of the machine's colour, where another mark beside it sets the ink. */
  inheritInk?: boolean
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 ${inheritInk ? '' : MACHINE_COLOUR_INK[identity.colour]}`.trim()}
      data-machine-mark={identity.id}
      data-machine-kind={identity.kind}
      data-machine-colour={identity.colour}
    >
      <MachineKindGlyph kind={identity.kind} className={className} />
    </span>
  )
}
