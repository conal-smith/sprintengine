import type { ITheme, Terminal } from '@xterm/xterm'

// xterm.js does not read CSS variables, so we resolve the theme-relevant
// tokens off `:root` at terminal-mount time and re-resolve whenever the
// `<html data-theme>` attribute changes. Each Terminal instance subscribes
// individually; the MutationObserver shared singleton broadcasts to every
// subscriber so all live terminals re-tint in lockstep.

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

// xterm's default 16-color ANSI palette is tuned for dark backgrounds: its
// `white`/`brightWhite` (and the bright variants agents use for bold text)
// sit near #fff and vanish on a light surface. Themes with a light terminal
// background get this palette instead — darkened hues that hold WCAG-AA
// contrast on near-white. Derived from the GitHub light terminal palette.
const LIGHT_TERMINAL_ANSI: ITheme = {
  black: '#24292e',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#7d4e00',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#24292e',
  selectionBackground: 'rgba(56, 92, 252, 0.20)',
}

// These are the terminal renderer's dark default colors. Keeping the complete
// palette here lets transcript output use the same colors as a terminal pane.
const DARK_TERMINAL_ANSI: ITheme = {
  black: '#2e3436',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#c4a000',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#06989a',
  white: '#d3d7cf',
  brightBlack: '#555753',
  brightRed: '#ef2929',
  brightGreen: '#8ae234',
  brightYellow: '#fce94f',
  brightBlue: '#729fcf',
  brightMagenta: '#ad7fa8',
  brightCyan: '#34e2e2',
  brightWhite: '#eeeeec',
}

const ANSI_COLOR_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const

// xterm nudges any glyph whose fg/bg contrast falls below this ratio toward
// legibility, per cell. It is the only lever that also covers 256-color and
// truecolor output — syntax highlighting and dimmed tool-call / diff text the
// agent CLIs emit — which bypass the 16-color ANSI palette above and otherwise
// render as near-invisible pale ink on a light surface. Enforced (AAA 7:1)
// only on light terminal backgrounds; dark surfaces keep xterm's default (1 =
// off) so their already-legible, deliberately tuned output is untouched.
const LIGHT_TERMINAL_MIN_CONTRAST = 7
const DEFAULT_MIN_CONTRAST = 1

// Perceived luminance (Rec. 601). Returns false for any value we can't parse
// as a hex color, so unknown backgrounds keep the dark-tuned default palette.
function isLightBackground(color: string): boolean {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return false
  let hex = match[1]
  if (hex.length === 3)
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6
}

/**
 * Whether the pane's own background is a light one.
 *
 * Exported for the search decorations (`terminalSearch.ts`): xterm's decoration
 * API takes literal `#RRGGBB`, not CSS variables, so a match highlight has to
 * pick its pair the same way the ANSI palette above does — by asking what it
 * will be painted on.
 */
export function isLightTerminalBackground(): boolean {
  return isLightBackground(readVar('--terminal-bg', readVar('--bg-app', '#08090b')))
}

// A theme that is someone else's published palette (Nord, Dracula,
// Catppuccin) carries its own sixteen ANSI colours, because a Dracula terminal
// whose greens were not Dracula's would not be Dracula. It declares them in its
// index.css block as `--terminal-ansi-<name>` (`brightBlack` is
// `--terminal-ansi-bright-black`), and each one it declares replaces the
// stock palette's colour; a theme that declares none keeps the stock palette
// whole. Read off the same `:root` as the rest, so a theme change re-tints them.
function themeAnsiOverrides(): ITheme {
  const overrides: ITheme = {}
  for (const key of ANSI_COLOR_KEYS) {
    const value = readVar(`--terminal-ansi-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, '')
    if (value) overrides[key] = value
  }
  return overrides
}

export function getTerminalTheme(): ITheme {
  // Terminals read from dedicated --terminal-* tokens so they can sit deeper
  // than the panel chrome. Fall back to the surface scale tokens for any theme
  // that hasn't declared terminal-specific values, preserving compatibility.
  const background = readVar('--terminal-bg', readVar('--bg-app', '#08090b'))
  const base: ITheme = {
    background,
    foreground: readVar('--terminal-fg', readVar('--text-strong', '#ececee')),
    cursor: readVar('--terminal-cursor', readVar('--accent-primary', '#5c7cff')),
  }
  // A light terminal surface needs the light ANSI palette or colored/bold agent
  // output washes out; dark surfaces keep xterm's default palette untouched.
  // Either way a theme's own ANSI colours, where it has them, go on top.
  return {
    ...base,
    ...(isLightBackground(background) ? LIGHT_TERMINAL_ANSI : DARK_TERMINAL_ANSI),
    ...themeAnsiOverrides(),
  }
}

export function getTerminalAnsiPalette(): string[] {
  const theme = getTerminalTheme()
  return ANSI_COLOR_KEYS.map((key) => theme[key] ?? '')
}

// Companion to getTerminalTheme: the contrast floor for the current surface.
// Set alongside the theme so 256-color / truecolor output stays legible on
// light backgrounds (see LIGHT_TERMINAL_MIN_CONTRAST).
function getTerminalMinimumContrastRatio(): number {
  const background = readVar('--terminal-bg', readVar('--bg-app', '#08090b'))
  return isLightBackground(background) ? LIGHT_TERMINAL_MIN_CONTRAST : DEFAULT_MIN_CONTRAST
}

type Subscriber = () => void
const subscribers = new Set<Subscriber>()
let observer: MutationObserver | null = null
let themeEpoch = 0

function ensureObserver(): void {
  if (observer || typeof window === 'undefined') return
  observer = new MutationObserver((mutations) => {
    if (!mutations.some((m) => m.attributeName === 'data-theme')) return
    themeEpoch++
    for (const fn of subscribers) {
      try {
        fn()
      } catch {
        // Subscriber threw; keep notifying the rest.
      }
    }
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
}

export function subscribeTerminalTheme(onChange: () => void): () => void {
  ensureObserver()
  subscribers.add(onChange)
  return () => {
    subscribers.delete(onChange)
  }
}

export function getTerminalThemeEpoch(): number {
  return themeEpoch
}

// Apply the current theme to `term`, then subscribe so the terminal re-tints
// on every `<html data-theme>` change. Returns a dispose function that
// removes the subscription. Call dispose alongside the existing terminal
// teardown.
export function bindTerminalTheme(term: Terminal): () => void {
  term.options.theme = getTerminalTheme()
  term.options.minimumContrastRatio = getTerminalMinimumContrastRatio()
  ensureObserver()
  const onChange: Subscriber = () => {
    term.options.theme = getTerminalTheme()
    term.options.minimumContrastRatio = getTerminalMinimumContrastRatio()
  }
  subscribers.add(onChange)
  return () => {
    subscribers.delete(onChange)
  }
}
