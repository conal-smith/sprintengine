// The product monogram: "se", the application icon's own letters
// (resources/brand/sprintengine-se-mark.source.html) — the wordmark's setting
// (Inter semibold, lowercase, "sprintengine" is never capitalised) cut to its
// initials, with the pair drawn tighter than the wordmark's -0.011em because at
// mark size the letters' optical closeness has to be drawn in.
//
// Live DOM text, not an SVG `<text>`, so it takes `text-title` from the type
// ramp rather than scaling by a viewBox outside every type rule.
//
// Two settings, one per ground:
//   - `theme` (a stable build): the active theme's inks on whatever ground the
//     host gives it — `--text-strong` for "s", `--accent-primary` for "e". The
//     accent is ink here, never a fill.
//   - `icon` (a nightly build's night tile): the icon's own fixed inks, because
//     the tile it sits on is the icon's fixed night ground in every theme, and
//     a light theme's dark foreground would vanish into it (assets/index.css,
//     `.brand-night-tile`).
//
// This replaced the full "sprintengine" wordmark in the sidebar's chrome row
// (owner ruling 2026-10-30): the brand is the rail's foot now, below Settings
// (RailBrandMark). See the window-chrome carve-out in
// design-system/foundations/principles.md under "The product does not name
// itself".

type SprintEngineMonogramProps = {
  inks?: 'theme' | 'icon'
  className?: string
}

export default function SprintEngineMonogram({ inks = 'theme', className = '' }: SprintEngineMonogramProps) {
  const s = inks === 'icon' ? 'text-[color:var(--brand-icon-ink)]' : 'text-[color:var(--text-strong)]'
  const e = inks === 'icon' ? 'text-[color:var(--brand-icon-accent)]' : 'text-[color:var(--accent-primary)]'
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-baseline text-title font-semibold leading-none tracking-[-0.06em] ${s} ${className}`}
    >
      s<span className={e}>e</span>
    </span>
  )
}
