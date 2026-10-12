// The marks of the external editors the open-in-editor control can hand a
// folder to, each in the colour its vendor publishes. Brand SVG assets, like
// the CLI badges in CliIcon.tsx and the product mark beside them in this
// folder: the hex here is the vendor's identity, not our chrome, and the
// token guard exempts the file on that basis (lint-design-tokens.mjs,
// PATH_EXEMPTIONS, category (c)).
//
// Ruled 2026-09-06 (principles.md → "Identity colour"): a mark that names
// another product wears that product's colour, because a monochrome vendor
// mark is a drawing of a logo rather than the logo — every
// other app shows the real one, and the neutral version read as a placeholder.
// The file manager's folder is ours and stays in `currentColor`; the vendor
// marks ignore the surrounding ink on purpose.
//
// Each is a single glyph sized by the icon ramp: the caller passes the size
// utility (`size-icon-sm` in the menu rows and on the split button).

import React from 'react'
import CliIcon from '../CliIcon'

// vscode target: the vendor's single-path mark in its blue.
export function VsCodeMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="#0078D4">
      <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
    </svg>
  )
}

// vscode-insiders target: the same mark in the green the Insiders build wears,
// which is how the two installs are told apart everywhere else on the machine.
export function VsCodeInsidersMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="#24BFA5">
      <path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
    </svg>
  )
}

// intellij target: the vendor's square, in its three-stop brand sweep, carrying
// the white "IJ" and the white bar. The gradient id is scoped per mount so two
// marks on one page (the split button and its open menu) do not share a def.
export function IntelliJMark({ className }: { className?: string }) {
  const gradientId = React.useId()
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none">
      <defs>
        <linearGradient id={gradientId} x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FE2857" />
          <stop offset="0.5" stopColor="#FC801D" />
          <stop offset="1" stopColor="#087CFA" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="3" fill={`url(#${gradientId})`} />
      <path
        d="M3.723 3.111h5v1.834h-1.39v6.277h1.39v1.834h-5v-1.834h1.444V4.945H3.723zm11.055 0H17v6.5c0 .612-.055 1.111-.222 1.556-.167.444-.39.777-.723 1.11-.277.279-.666.557-1.11.668a3.933 3.933 0 0 1-1.445.278c-.778 0-1.444-.167-1.944-.445a4.81 4.81 0 0 1-1.279-1.056l1.39-1.555c.277.334.555.555.833.722.277.167.611.278.945.278.389 0 .721-.111 1-.389.221-.278.333-.667.333-1.278zM2.222 19.5h9V21h-9z"
        fill="#FFFFFF"
      />
    </svg>
  )
}

// The other JetBrains IDEs share IntelliJ's anatomy — a square in the
// product's own sweep, its two-letter abbreviation and the white bar — and
// differ only in the letters and the colours, so one drawing serves them all.
// The letters are set in the UI face rather than traced, at a size the 24-unit
// box reads at the icon ramp's smallest step.
function JetBrainsMark({
  letters,
  stops,
  className,
}: {
  letters: string
  stops: readonly [string, string, string]
  className?: string
}) {
  const gradientId = React.useId()
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none">
      <defs>
        <linearGradient id={gradientId} x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={stops[0]} />
          <stop offset="0.5" stopColor={stops[1]} />
          <stop offset="1" stopColor={stops[2]} />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="22" height="22" rx="3" fill={`url(#${gradientId})`} />
      <text x="3.5" y="12.5" fill="white" fontSize="9" fontWeight="700" letterSpacing="-0.3">
        {letters}
      </text>
      <rect x="2.25" y="19.5" width="9" height="1.5" fill="white" />
    </svg>
  )
}

const WEBSTORM_STOPS = ['#07C3F2', '#087CFA', '#FCF84A'] as const
const PYCHARM_STOPS = ['#21D789', '#FCF84A', '#07C3F2'] as const
const GOLAND_STOPS = ['#0D7BF7', '#B74AF7', '#3BEA62'] as const
const CLION_STOPS = ['#21D789', '#009AE5', '#ED358C'] as const
const PHPSTORM_STOPS = ['#FF318C', '#765AF8', '#B345F1'] as const
const RIDER_STOPS = ['#C90F5E', '#077CFB', '#FDB60D'] as const
const RUBYMINE_STOPS = ['#FE2857', '#FC801D', '#FE5BC0'] as const
const RUSTROVER_STOPS = ['#FF8100', '#FE2857', '#8C47FF'] as const
const DATAGRIP_STOPS = ['#22D88F', '#9775F8', '#FF59E6'] as const

export function WebStormMark({ className }: { className?: string }) {
  return <JetBrainsMark letters="WS" stops={WEBSTORM_STOPS} className={className} />
}

export function PyCharmMark({ className }: { className?: string }) {
  return <JetBrainsMark letters="PC" stops={PYCHARM_STOPS} className={className} />
}

export function GoLandMark({ className }: { className?: string }) {
  return <JetBrainsMark letters="GO" stops={GOLAND_STOPS} className={className} />
}

export function CLionMark({ className }: { className?: string }) {
  return <JetBrainsMark letters="CL" stops={CLION_STOPS} className={className} />
}

export function PhpStormMark({ className }: { className?: string }) {
  return <JetBrainsMark letters="PS" stops={PHPSTORM_STOPS} className={className} />
}

export function RiderMark({ className }: { className?: string }) {
  return <JetBrainsMark letters="RD" stops={RIDER_STOPS} className={className} />
}

export function RubyMineMark({ className }: { className?: string }) {
  return <JetBrainsMark letters="RM" stops={RUBYMINE_STOPS} className={className} />
}

export function RustRoverMark({ className }: { className?: string }) {
  return <JetBrainsMark letters="RR" stops={RUSTROVER_STOPS} className={className} />
}

export function DataGripMark({ className }: { className?: string }) {
  return <JetBrainsMark letters="DG" stops={DATAGRIP_STOPS} className={className} />
}

// cursor target: the mark the agent pickers already draw for the Cursor CLI
// (CliIcon). It is the same product, so it is the same picture.
export function CursorMark({ className }: { className?: string }) {
  return <CliIcon cli="cursor" className={className} />
}

// zed, windsurf, sublime, vscodium, trae, kiro and antigravity targets: no
// vendor SVG is bundled for these, so
// each draws a simple, original tile in the Cursor mark's idiom — an outlined
// square in the surrounding ink holding the product's initial. Swap a tile for
// the vendor's own mark, in its colour, if one is bundled.
function InitialTileMark({ initial, className }: { initial: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} fill="none">
      <rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke="currentColor" strokeWidth="1.7" />
      <text x="12" y="16" fill="currentColor" fontSize="11" fontWeight="700" textAnchor="middle">
        {initial}
      </text>
    </svg>
  )
}

export function ZedMark({ className }: { className?: string }) {
  return <InitialTileMark initial="Z" className={className} />
}

export function WindsurfMark({ className }: { className?: string }) {
  return <InitialTileMark initial="W" className={className} />
}

export function SublimeTextMark({ className }: { className?: string }) {
  return <InitialTileMark initial="S" className={className} />
}

export function VSCodiumMark({ className }: { className?: string }) {
  return <InitialTileMark initial="V" className={className} />
}

export function TraeMark({ className }: { className?: string }) {
  return <InitialTileMark initial="T" className={className} />
}

export function KiroMark({ className }: { className?: string }) {
  return <InitialTileMark initial="K" className={className} />
}

export function AntigravityMark({ className }: { className?: string }) {
  return <InitialTileMark initial="A" className={className} />
}
