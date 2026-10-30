// Single source of truth for the JavaScript side of the theme system.
//
// The CSS contract (the actual color values per theme) lives in
// `src/renderer/src/assets/index.css` under the `:root[data-theme="..."]`
// blocks. The catalogue was cut to eleven on 2026-09-06 (owner): a picker of
// nineteen read as a wall, and the themes that went were the ones nobody could
// tell apart from a neighbour. It has since grown to fifteen (2026-10-13) with
// four community palettes people ask for by name — Nord, Dracula, and
// Catppuccin's Mocha and Latte — each distinct from every theme beside it and
// recognisable on sight; the ruling still stands for anything that is not.
// This file owns everything else: the id list, user-facing labels,
// the resolved-vs-user-preference relationship, type unions, normalizer, and
// the Select option list that the picker renders.
//
// Adding a new theme:
//   1. Add a row to APP_THEMES below.
//   2. Add the matching `:root[data-theme="<id>"]` block in index.css.
//   3. Only if it paints a light surface: add the literal id to LIGHT_SURFACES
//      in the boot script in `src/renderer/public/boot-theme.js` (it can't import bundled
//      code), and to each light-surface selector list in index.css (the
//      date-picker glyph, the git lanes and ref pills, the highlight
//      palettes). LIGHT_SURFACE_THEMES below derives itself from the swatches.
// Nothing else needs to change; `appTheme.registry.test.ts` fails if a step is
// missed.

export type AppTheme =
  | 'system'
  | 'dark'
  | 'light'
  | 'paper'
  | 'vellum'
  | 'herbarium'
  | 'herbarium-dark'
  | 'slate'
  | 'sage'
  | 'lantern'
  | 'tokyo-night'
  | 'rose-pine'
  | 'nord'
  | 'dracula'
  | 'catppuccin-mocha'
  | 'catppuccin-latte'

// The concrete themes that <html data-theme="…"> can actually carry. `system`
// is a user preference that resolves to one of these at mount time.
export type ResolvedAppTheme = Exclude<AppTheme, 'system'>

// Swatch tuple for the visual picker thumbnail. Mirrors the five most
// representative tokens of each theme — surface ramp + accent + foreground.
// Hard-coded here (rather than read from CSS at runtime) because the picker
// renders these as inline style backgrounds while the user is on any
// other theme; we can't read another theme's --bg-app off the live :root.
// This module is outside the design-tokens lint scope so the hex literals
// below don't trip the no-inline-hex guard.
export type ThemeSwatches = {
  bgApp: string
  bgSurface: string
  bgSurfaceRaised: string
  accent: string
  textStrong: string
}

type AppThemeDescriptor = {
  id: AppTheme
  label: string
  // null for the `system` row (the user preference that defers to OS); the
  // resolved theme id otherwise. Used by the picker, the normalizer, and
  // useAppTheme's resolveTheme() helper.
  resolved: ResolvedAppTheme | null
  // One-line description shown in the visual picker beneath the swatches.
  description?: string
  // Feature flags surfaced as glyphs in the visual picker. Anti-dither is
  // not a flag because every theme is anti-dither baseline — the multiples-
  // of-4 channel discipline is applied across the catalogue, not a sticker
  // on individual themes.
  lowBlueLight?: boolean
  // Swatch tuple for the visual preview. Omitted on the `system` row, which
  // renders an OS-monitor glyph instead of a color preview.
  swatches?: ThemeSwatches
}

export const APP_THEMES: readonly AppThemeDescriptor[] = [
  {
    id: 'system',
    label: 'Match system',
    resolved: null,
    description: 'Follows your OS preference',
  },
  {
    id: 'dark',
    label: 'Dark',
    resolved: 'dark',
    description: 'Calm neutral ink, green accent',
    swatches: {
      bgApp: '#08080c',
      bgSurface: '#0c0c10',
      bgSurfaceRaised: '#101418',
      accent: '#3f9468',
      textStrong: '#ececec',
    },
  },
  {
    id: 'light',
    label: 'Light',
    resolved: 'light',
    description: 'Cool-neutral white, green accent',
    swatches: {
      bgApp: '#eaeef2',
      bgSurface: '#ffffff',
      bgSurfaceRaised: '#ffffff',
      accent: '#2f6a4a',
      textStrong: '#202428',
    },
  },
  {
    id: 'paper',
    label: 'Paper',
    resolved: 'paper',
    description: 'Warm cream and sage, green accent',
    swatches: {
      bgApp: '#f4f1e8',
      bgSurface: '#fbf9f2',
      bgSurfaceRaised: '#fdfcf7',
      accent: '#2f6a4a',
      textStrong: '#191613',
    },
  },
  {
    id: 'vellum',
    label: 'Vellum',
    resolved: 'vellum',
    description: 'Warm vintage parchment',
    swatches: {
      bgApp: '#e8e0d0',
      bgSurface: '#f4ece0',
      bgSurfaceRaised: '#fcf4e8',
      accent: '#b04428',
      textStrong: '#2c2418',
    },
  },
  {
    id: 'herbarium',
    label: 'Herbarium',
    resolved: 'herbarium',
    description: 'Sage-green parchment, warm cards',
    swatches: {
      bgApp: '#d4dcc0',
      bgSurface: '#f4ece0',
      bgSurfaceRaised: '#fcf4e8',
      accent: '#b04428',
      textStrong: '#242818',
    },
  },
  {
    id: 'herbarium-dark',
    label: 'Herbarium Dark',
    resolved: 'herbarium-dark',
    description: 'Dark slate, sage-green accent',
    swatches: {
      bgApp: '#181c14',
      bgSurface: '#1c2018',
      bgSurfaceRaised: '#242820',
      accent: '#d4dcc0',
      textStrong: '#e4e8d8',
    },
  },
  {
    id: 'slate',
    label: 'Slate',
    resolved: 'slate',
    description: 'Neutral editor grey',
    swatches: {
      bgApp: '#202020',
      bgSurface: '#242424',
      bgSurfaceRaised: '#2c2c30',
      accent: '#5c7cfc',
      textStrong: '#e8e8e8',
    },
  },
  {
    id: 'sage',
    label: 'Sage',
    resolved: 'sage',
    description: 'Muted gray-green, terracotta accent',
    swatches: {
      bgApp: '#20241c',
      bgSurface: '#282c20',
      bgSurfaceRaised: '#303428',
      accent: '#c85838',
      textStrong: '#e8e8d4',
    },
  },
  {
    id: 'lantern',
    label: 'Lantern',
    resolved: 'lantern',
    description: 'Late-night warm amber',
    lowBlueLight: true,
    swatches: {
      bgApp: '#181408',
      bgSurface: '#1c1810',
      bgSurfaceRaised: '#242018',
      accent: '#e8a850',
      textStrong: '#f4e8c8',
    },
  },
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    resolved: 'tokyo-night',
    description: 'Muted blue night coding',
    swatches: {
      bgApp: '#181824',
      bgSurface: '#1c1c28',
      bgSurfaceRaised: '#24283c',
      accent: '#7cb4fc',
      textStrong: '#c0c8dc',
    },
  },
  {
    id: 'rose-pine',
    label: 'Rose Pine',
    resolved: 'rose-pine',
    description: 'Soft mauve and rose',
    swatches: {
      bgApp: '#181420',
      bgSurface: '#1c1828',
      bgSurfaceRaised: '#241c34',
      accent: '#d488a0',
      textStrong: '#e0d4dc',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    resolved: 'nord',
    description: 'Arctic blue-grey, frost accent',
    swatches: {
      bgApp: '#242c38',
      bgSurface: '#283040',
      bgSurfaceRaised: '#2c3440',
      accent: '#88c0d0',
      textStrong: '#ecf0f4',
    },
  },
  {
    id: 'dracula',
    label: 'Dracula',
    resolved: 'dracula',
    description: 'Dark violet, neon pink accent',
    swatches: {
      bgApp: '#181820',
      bgSurface: '#20202c',
      bgSurfaceRaised: '#282838',
      accent: '#fc78c4',
      textStrong: '#f8f8f0',
    },
  },
  {
    id: 'catppuccin-mocha',
    label: 'Catppuccin Mocha',
    resolved: 'catppuccin-mocha',
    description: 'Deep pastel night, mauve accent',
    swatches: {
      bgApp: '#10101c',
      bgSurface: '#181824',
      bgSurfaceRaised: '#1c1c2c',
      accent: '#cca8f8',
      textStrong: '#ccd4f4',
    },
  },
  {
    id: 'catppuccin-latte',
    label: 'Catppuccin Latte',
    resolved: 'catppuccin-latte',
    description: 'Soft pastel day, mauve accent',
    swatches: {
      bgApp: '#dce0e8',
      bgSurface: '#e4e8f0',
      bgSurfaceRaised: '#f0f0f4',
      accent: '#8838f0',
      textStrong: '#484c64',
    },
  },
]

const APP_THEME_IDS: readonly AppTheme[] = APP_THEMES.map((t) => t.id)

export type ColorScheme = 'light' | 'dark'

const APP_THEME_BY_ID: ReadonlyMap<AppTheme, AppThemeDescriptor> = new Map(APP_THEMES.map((t) => [t.id, t]))

// Perceived luminance (Rec. 601) of a #rrggbb hex; ~0–1.
function hexLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

// Light/dark surface of a resolved theme, derived from its swatch canvas so it
// never drifts as themes are added: a theme whose `bgApp` reads as a light
// surface is a light theme. Used to tell the main process which scheme to launch
// agent CLIs in. Defaults to 'dark' for any theme missing a swatch.
export function colorSchemeForResolvedTheme(resolved: ResolvedAppTheme): ColorScheme {
  const bgApp = APP_THEME_BY_ID.get(resolved)?.swatches?.bgApp
  if (!bgApp) return 'dark'
  return hexLuminance(bgApp) > 0.5 ? 'light' : 'dark'
}

// The themes that paint a light surface: today `light`, `paper`, `vellum`,
// `herbarium` and `catppuccin-latte`. Derived from the same swatch luminance as the scheme above so a
// theme can never be light by one measure and dark by the other; a theme with
// no swatch counts as dark, matching the app's dark-default :root.
//
// This is the app's half of the polarity bridge to the design-system bundle.
// The bundle's bare :root is its LIGHT tier and its dark tier keys off
// `[data-mode="dark"]` — the inverse of index.css, whose bare :root is Dark —
// so <html> carries `data-mode` alongside `data-theme`. applyThemeAttributes()
// in hooks/useAppTheme.ts writes both; the boot script (public/boot-theme.js) stamps the
// same pair before any CSS evaluates.
export const LIGHT_SURFACE_THEMES: readonly ResolvedAppTheme[] = APP_THEMES.flatMap((t) =>
  t.resolved && colorSchemeForResolvedTheme(t.resolved) === 'light' ? [t.resolved] : [],
)

export const DEFAULT_SYSTEM_LIGHT_THEME: ResolvedAppTheme = 'light'
export const DEFAULT_SYSTEM_DARK_THEME: ResolvedAppTheme = 'dark'

/** The themes `system` may use in light mode (`light`) or dark mode (`dark`), in the picker's order. */
export function systemThemeChoices(side: ColorScheme): ResolvedAppTheme[] {
  return APP_THEMES.flatMap((t) =>
    t.resolved && LIGHT_SURFACE_THEMES.includes(t.resolved) === (side === 'light') ? [t.resolved] : [],
  )
}

/** A stored theme for one side of `system`, or that side's default when it is not one of its choices. */
export function normalizeSystemTheme(value: unknown, side: ColorScheme): ResolvedAppTheme {
  const choices = systemThemeChoices(side)
  return (
    choices.find((choice) => choice === value) ??
    (side === 'light' ? DEFAULT_SYSTEM_LIGHT_THEME : DEFAULT_SYSTEM_DARK_THEME)
  )
}

/** The theme a preference paints: itself, or under `system` the side the OS is on. */
export function resolveAppTheme(
  theme: AppTheme,
  prefersLight: boolean,
  system: Pick<AppearanceSettings, 'systemLightTheme' | 'systemDarkTheme'>,
): ResolvedAppTheme {
  if (theme !== 'system') return theme
  return prefersLight ? system.systemLightTheme : system.systemDarkTheme
}

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && (APP_THEME_IDS as readonly string[]).includes(value)
}

// Window chrome material — a second appearance axis, orthogonal to the theme.
// 'glass' frosts the window canvas (sidebar, title strip, aside column) with
// OS-native vibrancy under the active theme's tint; macOS-only.
// 'tinted' paints the same canvas opaque, with a static, heavily feathered
// wash in the colour of what sits on it — the foreground under the rail and
// the title band, and no control of its own — the premium ground for platforms with no vibrancy,
// and an option on macOS for anyone who would rather not have glass (owner
// ruling 2026-09-24). 'solid' is the plain opaque canvas.
const WINDOW_MATERIALS = ['solid', 'glass', 'tinted'] as const
export type WindowMaterial = (typeof WINDOW_MATERIALS)[number]

export function isWindowMaterial(value: unknown): value is WindowMaterial {
  return typeof value === 'string' && (WINDOW_MATERIALS as readonly string[]).includes(value)
}

// The material a stored preference paints on this platform. The stored default
// is 'glass' — "the premium material" — and where the OS has no vibrancy the
// premium material is tinted, so glass resolves to tinted off macOS. That is
// also how every existing Windows and Linux profile, which holds the untouched
// glass default, lands on tinted without a migration. An explicit solid or
// tinted is honoured everywhere.
export function effectiveWindowMaterial(material: WindowMaterial, platform: string | undefined): WindowMaterial {
  return material === 'glass' && platform !== 'darwin' ? 'tinted' : material
}

// How far the conversation column may grow. `comfortable` and `wide` cap the
// transcript and the composer together at a reading measure and centre them,
// the scrollbar staying at the pane's edge; `full` is the pane's own width.
//
// A new install opens on Comfortable (owner ruling 2026-10-04: the composer and
// the transcript read best at `size.chat-column.comfortable`). A profile that
// already holds a width keeps it, and one stored before the setting existed
// keeps `full`, the chat's shape back then: a default that re-lays an existing
// transcript is a change nobody asked for.
const CHAT_WIDTHS = ['comfortable', 'wide', 'full'] as const
export type ChatWidth = (typeof CHAT_WIDTHS)[number]
export const DEFAULT_CHAT_WIDTH: ChatWidth = 'comfortable'
/** The width a stored appearance from before the setting reads as. */
export const LEGACY_CHAT_WIDTH: ChatWidth = 'full'

export function isChatWidth(value: unknown): value is ChatWidth {
  return typeof value === 'string' && (CHAT_WIDTHS as readonly string[]).includes(value)
}

// The chat's text contrast, in percent of the theme's own inks: under 100 the
// inks fade toward the chat's background, over 100 they move away from it.
// Five-point steps, so the value the slider names is always one it can reach.
// The floor is measured, not picked: 85 is the lowest step at which body text
// still clears 4.5:1 against the chat surface in every theme (herbarium, the
// theme with the least contrast to give, is 4.9:1 there and 4.4:1 at 80). Dark
// and light alone would allow 75, but a floor that holds only in some themes
// is a setting that silently breaks when the theme changes.
export const CHAT_CONTRAST_MIN = 85
export const CHAT_CONTRAST_MAX = 200
export const CHAT_CONTRAST_STEP = 5
export const DEFAULT_CHAT_CONTRAST = 100

/** A stored contrast as one the slider can show: on the ramp, on a step. */
export function normalizeChatContrast(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CHAT_CONTRAST
  const stepped = Math.round(value / CHAT_CONTRAST_STEP) * CHAT_CONTRAST_STEP
  return Math.min(CHAT_CONTRAST_MAX, Math.max(CHAT_CONTRAST_MIN, stepped))
}

// How a clock time is written across the app — a message's stamp, a step's,
// a snooze's wake, a scheduled send. `system` is the locale's own habit (the
// reader's language decides between "3:05 PM" and "15:05"); the other two pin
// it for a person whose locale and preference disagree.
const CLOCK_FORMATS = ['system', '12h', '24h'] as const
export type ClockFormat = (typeof CLOCK_FORMATS)[number]
export const DEFAULT_CLOCK_FORMAT: ClockFormat = 'system'

export function isClockFormat(value: unknown): value is ClockFormat {
  return typeof value === 'string' && (CLOCK_FORMATS as readonly string[]).includes(value)
}

// How a reply streaming in is drawn: `live`, each word as it arrives, or
// `paragraph`, each block once it is finished (shared/conversation/
// markdownSegments.ts, `createParagraphHold`), so text never reflows under the
// reader. Either way the whole reply is drawn once it ends.
const REPLY_STREAMING_MODES = ['live', 'paragraph'] as const
export type ReplyStreaming = (typeof REPLY_STREAMING_MODES)[number]
export const DEFAULT_REPLY_STREAMING: ReplyStreaming = 'live'

export function isReplyStreaming(value: unknown): value is ReplyStreaming {
  return typeof value === 'string' && (REPLY_STREAMING_MODES as readonly string[]).includes(value)
}

export type AppearanceSettings = {
  theme: AppTheme
  // What `system` resolves to on each side of the OS's light/dark switch: a
  // light-surface theme for light mode, any other for dark.
  systemLightTheme: ResolvedAppTheme
  systemDarkTheme: ResolvedAppTheme
  windowMaterial: WindowMaterial
  chatContrast: number
  chatWidth: ChatWidth
  clockFormat: ClockFormat
  replyStreaming: ReplyStreaming
  // Draw each spawned agent as a small character that moves while it works.
  // Off, an agent is a working mark while it runs and a lifecycle glyph after.
  agentCharacters: boolean
  // Show a subscription's usage limits (the five-hour and weekly windows the
  // agents report) on a Claude or Codex chat's composer strip.
  usageLimits: boolean
  // The families put in front of the design system's two stacks: the
  // interface's (`--sem-font-family-ui`) and code's (`--sem-font-family-mono`,
  // which the terminals and editors draw in too). Free text, cleaned by
  // `normalizeFontFamilyPreference`; empty is the bundled face.
  interfaceFont: string
  codeFont: string
}
