// Token names mirror the design system's `--sem-*` names so a surface is
// portable between the two apps by name. Values are the sprintengine.ai site's:
// the phone wears the site's
// white page in Light and its neutral-950 page in Dark — Tailwind's neutral
// scale, one green that is brand rather than accent, and an inverse-ink primary
// button. Every deviation from the site is a contrast floor and is called out
// inline: the site sets 13–15px marketing copy in neutral-400/500, which is
// below AA for the 11–13px identifiers and meta the phone sets, so the muted and
// subtle tiers here are one or two steps darker (lighter, in Dark) than the site's.
//
// Green is brand, not accent. `accentPrimary` keeps its name for the wordmark,
// the focus ring and the working mark; the primary action is `buttonBg`/`buttonInk`,
// exactly the site's "Download now". Green fills only a control whose whole
// point is "on" or "go": the composer's round send, which wears the accent on
// both apps with `textOnAccent` for its arrow, a
// switch's track while it is on, and the microphone while it listens. The
// token lint (`accent-fill`) holds it to those three.
export interface ThemeColors {
  bgApp: string;
  bgSurface: string;
  bgSurfaceRaised: string;
  bgHover: string;
  bgActive: string;
  bgSelected: string;
  /**
   * `--sem-color-bg-selected-resting`: the second selection tier. Every pane that
   * is NOT the one being driven shows its selection here — it remembers the choice
   * without competing with the one action worth taking. Pre-composited opaque for
   * the same reason `bgSurfaceSelected` is.
   */
  bgSelectedResting: string;
  /**
   * Opaque selected-row surface: `accentPrimarySoft` pre-composited over
   * `bgSurface`. React Native cannot layer a translucent fill over a View's own
   * opaque background — a selected style's `backgroundColor` *replaces* the
   * row's `bgSurface`, so a translucent accent tint would blend with whatever
   * the ancestor paints (the Screen canvas, `bgApp`) instead of with the card.
   * Rows that are opaque at rest use this; chrome that is transparent at rest
   * (the drawer's active item) keeps `accentPrimarySoft`.
   */
  bgSurfaceSelected: string;

  /**
   * `--agent-surface`: the conversation's ground, and New's, so starting a
   * chat does not change the ground under the composer. The theme's brightest
   * paper (`bgSurfaceRaised`): the conversation is the thing being read, so it
   * is the one surface lifted above the canvas, as on the desktop. It was `bgApp`,
   * which in Dark read as a hole cut down to the window behind.
   */
  agentSurface: string;
  /**
   * `--agent-inset`: what sits IN the conversation and has to read as a shape
   * on it, the person's message bubble and a command's plain output. The
   * ramp's next step off the paper (`bgHover`): a shade under it in Light, so
   * the bubble reads as pressed into the page, a shade over it in Dark.
   */
  agentInset: string;
  /**
   * `--composer-surface`: the composer's ground, one step above
   * `agentSurface`. `bgHover` in Dark; Light has no tone brighter than its
   * raised paper, so it is pure white there and the hairline is the edge.
   */
  composerSurface: string;
  /**
   * The bottom stop of the composer's wash (`--composer-fill`): the ground
   * settled 55% of the way toward `agentSurface`, pre-mixed because React
   * Native has no `color-mix`.
   */
  composerSurfaceEnd: string;

  borderSubtle: string;
  borderDefault: string;
  borderStrong: string;
  /** Focus-visible ring for external keyboards and switch access — accent-derived, like the desktop `--border-focus`. */
  borderFocus: string;
  /** Modal/sheet scrim: neutral ink over the canvas, heavier in Dark. */
  overlayScrim: string;

  /** `--sem-color-text-primary`. */
  textPrimary: string;
  textDefault: string;
  textMuted: string;
  textSubtle: string;
  textDisabled: string;
  textOnAccent: string;

  accentPrimary: string;
  accentPrimaryHover: string;
  accentPrimarySoft: string;
  /** `--sem-color-accent-soft-strong`: the stronger accent wash, for a pressed or
   * active soft surface where `accentPrimarySoft` reads as nothing. */
  accentPrimarySoftStrong: string;

  toneNeutral: string;
  toneAccent: string;
  toneGood: string;
  toneWarn: string;
  toneError: string;
  /**
   * Merged-purple. The one tone the desktop declares once in `:root` and never
   * re-states per theme, so both themes carry the same hex here. It only ever
   * inks the `done_merged` branch glyph (LifecycleGlyph), never text.
   *
   * This is the tightest pair in the pack: against the surface it is *closest*
   * to — Dark `bgSelected` — it clears the 3:1 non-text floor (WCAG 1.4.11)
   * at ~3.12:1, with little margin. It is kept anyway because
   * merged-purple is cross-app identity, not theme ink; re-tinting it per theme
   * would make the same merged task read as two different states across apps.
   * `glyphContrast.regression.test.js` pins that exact pair, so any tweak to
   * `bgSelected` fails CI rather than quietly dropping the glyph below the floor.
   */
  toneMerged: string;

  toneNeutralSoft: string;
  toneAccentSoft: string;
  toneGoodSoft: string;
  toneWarnSoft: string;
  toneErrorSoft: string;

  /** The inverse-ink primary button: the site's "Download now" (neutral-900 on white, neutral-100 on black). */
  buttonBg: string;
  buttonInk: string;
  /** The outlined secondary button's border (the site's neutral-300 / neutral-700). */
  buttonOutline: string;
  /** A card's 1px ring — the site's `ring-neutral-800` in Dark, a faint ink ring in Light. */
  cardRing: string;
  /** A card's shadow colour; `Theme.cardShadowOpacity` is 0 in Dark, where the ring alone lifts the card. */
  cardShadowColor: string;
  /**
   * The toast's lit top edge: the desktop's `inset 0 1px 0` highlight, drawn
   * as a 1px top border. White at 70% on the white Light card; at 9% in Dark,
   * where anything brighter reads as a stray line rather than light.
   */
  toastEdge: string;

  /**
   * `--sem-color-mark-*`: the seven hues a machine's glyph wears. The desktop's own values, Light and Dark, so a machine is the
   * same colour on both screens. Glyph ink only, never text and never a fill:
   * each clears 3:1 on every surface a glyph sits on
   * (`machineMarks.regression.test.js` pins it), not 4.5:1, so the machine's
   * name beside its glyph stays in the text inks.
   */
  markBlue: string;
  markTeal: string;
  markCyan: string;
  markOrange: string;
  markYellow: string;
  markViolet: string;
  markRed: string;
}

// Dark — the site's `dark:bg-neutral-950` page. Canvas #0a0a0a, cards
// neutral-900 with a neutral-800 ring, text neutral-100/300/400.
const darkColors: ThemeColors = {
  bgApp: "#0a0a0a",
  bgSurface: "#171717",
  bgSurfaceRaised: "#1c1c1c",
  bgHover: "#202020",
  bgActive: "#262626",
  // Neutral, and no lighter than this: merged-purple (toneMerged) must keep 3:1
  // on the lightest surface a row passes through, and it sits at ~3.1:1 here.
  bgSelected: "#2a2a2a",
  bgSelectedResting: "#242424",
  bgSurfaceSelected: "#222222",

  agentSurface: "#1c1c1c",
  agentInset: "#202020",
  composerSurface: "#202020",
  // #202020 at 55% over #1c1c1c.
  composerSurfaceEnd: "#1e1e1e",

  borderSubtle: "rgba(245,245,245,0.08)",
  borderDefault: "rgba(245,245,245,0.12)",
  borderStrong: "rgba(245,245,245,0.18)",
  borderFocus: "rgba(63,148,104,0.6)",
  overlayScrim: "rgba(0,0,0,0.6)",

  textPrimary: "#f5f5f5",
  textDefault: "#d4d4d4",
  textMuted: "#a3a3a3",
  // The site's neutral-500 (#737373) reads at ~3.3:1 as 11px identifiers on a
  // hovered row; lifted to the darkest grey that clears 4.5:1 on bgSelected.
  textSubtle: "#929292",
  // Inks the idea/archived glyphs (3:1 informational floor on bgSelected).
  textDisabled: "#767676",
  textOnAccent: "#0a0a0a",

  accentPrimary: "#3f9468",
  accentPrimaryHover: "#4daf7d",
  accentPrimarySoft: "rgba(63,148,104,0.14)",
  accentPrimarySoftStrong: "rgba(63,148,104,0.24)",

  toneNeutral: "#a3a3a3",
  toneAccent: "#3f9468",
  toneGood: "#30d058",
  toneWarn: "#fcc030",
  toneError: "#fc787c",
  toneMerged: "#8957e5",

  toneNeutralSoft: "rgba(163,163,163,0.18)",
  toneAccentSoft: "rgba(63,148,104,0.16)",
  toneGoodSoft: "rgba(48,208,88,0.18)",
  toneWarnSoft: "rgba(252,192,48,0.18)",
  toneErrorSoft: "rgba(252,120,124,0.18)",

  buttonBg: "#f5f5f5",
  buttonInk: "#171717",
  buttonOutline: "#404040",
  cardRing: "#262626",
  cardShadowColor: "#000000",
  toastEdge: "rgba(255,255,255,0.09)",

  // The desktop declares violet once for both themes, as it does merged-purple:
  // ~3.1:1 on bgSelected, the same tight pair toneMerged sits on.
  markBlue: "#5ea0f2",
  markTeal: "#2dd4bf",
  markCyan: "#22d3ee",
  markOrange: "#fb923c",
  markYellow: "#fcc030",
  markViolet: "#8957e5",
  markRed: "#fc787c",
};

// Light — the site's white page. Cards are white on white and lift on a faint
// ring plus the site's `0 18px 40px -16px rgba(15,18,24,.18)` shadow; text is
// neutral-900/700; hover/active/selected are neutral-100/150/200.
const lightColors: ThemeColors = {
  bgApp: "#ffffff",
  bgSurface: "#ffffff",
  bgSurfaceRaised: "#ffffff",
  bgHover: "#f5f5f5",
  bgActive: "#ebebeb",
  bgSelected: "#e5e5e5",
  bgSelectedResting: "#efefef",
  bgSurfaceSelected: "#f0f0f0",

  agentSurface: "#ffffff",
  agentInset: "#f5f5f5",
  composerSurface: "#ffffff",
  composerSurfaceEnd: "#ffffff",

  borderSubtle: "rgba(23,23,23,0.08)",
  borderDefault: "rgba(23,23,23,0.16)",
  borderStrong: "rgba(23,23,23,0.28)",
  borderFocus: "rgba(47,106,74,0.6)",
  overlayScrim: "rgba(10,10,10,0.35)",

  textPrimary: "#171717",
  textDefault: "#404040",
  // The site's neutral-500 (#737373) is 3.8:1 as 13px meta on a selected row;
  // two steps darker clears 4.5:1 there with a little room.
  textMuted: "#5f5f5f",
  // The site's neutral-400 (#a3a3a3) is 2.5:1 on white — fine for its 14px
  // marketing captions, not for 11px ids. The lightest grey clearing 4.5:1 on
  // bgSelected, one step above textMuted so the tiers still read in order.
  textSubtle: "#666666",
  // Inks the idea/archived glyphs: 3:1 on bgSelected.
  textDisabled: "#808080",
  textOnAccent: "#ffffff",

  // The site's --brand-green. Wordmark, focus ring, a live mark, and the three
  // fills the note at the top names.
  accentPrimary: "#2f6a4a",
  accentPrimaryHover: "#275842",
  accentPrimarySoft: "rgba(47,106,74,0.10)",
  accentPrimarySoftStrong: "rgba(47,106,74,0.18)",

  // The system sheet's light status inks (emerald-700 #157f37, amber-800
  // #9a6000, red-600 #d92d2d) sit at 3.8–4.1:1 as 12px pill text on a selected
  // row; each is darkened along its own hue to clear 4.5:1 on bgSelected.
  toneNeutral: "#5f5f5f",
  toneAccent: "#2f6a4a",
  toneGood: "#126b2f",
  toneWarn: "#805000",
  toneError: "#c02020",
  toneMerged: "#8957e5",

  toneNeutralSoft: "rgba(95,95,95,0.14)",
  toneAccentSoft: "rgba(47,106,74,0.12)",
  toneGoodSoft: "rgba(18,107,47,0.16)",
  toneWarnSoft: "rgba(128,80,0,0.16)",
  toneErrorSoft: "rgba(192,32,32,0.14)",

  buttonBg: "#171717",
  buttonInk: "#ffffff",
  buttonOutline: "#d4d4d4",
  cardRing: "rgba(15,18,24,0.08)",
  cardShadowColor: "#0f1218",
  toastEdge: "rgba(255,255,255,0.7)",

  markBlue: "#2b6cd4",
  markTeal: "#0f766e",
  markCyan: "#0e7490",
  markOrange: "#c2410c",
  markYellow: "#9a6000",
  markViolet: "#8957e5",
  markRed: "#d92d2d",
};

export type ThemeName = "light" | "dark";

export interface Theme {
  name: ThemeName;
  colors: ThemeColors;
  /** Drives status-bar style and native appearance. */
  isDark: boolean;
  /** The card shadow's opacity: the site's 0.18 in Light, none in Dark (the ring lifts the card). */
  cardShadowOpacity: number;
}

export const themes: Record<ThemeName, Theme> = {
  light: { name: "light", colors: lightColors, isDark: false, cardShadowOpacity: 0.18 },
  dark: { name: "dark", colors: darkColors, isDark: true, cardShadowOpacity: 0 },
};

/**
 * The card's lift, as React Native shadow props. The site's
 * `shadow-[0_18px_40px_-16px_rgba(15,18,24,.18)]` in Light; nothing in Dark,
 * where `cardRing` alone separates the card from the canvas.
 */
export const cardShadow = { offset: { width: 0, height: 10 }, radius: 20 } as const;

// --- The scale exports, named for their `--sem-*` counterparts ----------------
//
// Every export below carries the design system's own token name so a surface is
// portable between the two apps by name (see the type-ramp note below).
// Where a value differs from the pointer scale it is the `compact` touch value and
// says so; where it is identical the name is the whole story.
//
// The design system is at ../multicode/design-system. It ships CSS custom
// properties, which React Native cannot consume — USAGE.md is explicit that
// components are reference implementations to rebuild, not paste. So this file is
// the RN expression of the same contract, not a copy of it.

/**
 * `--sem-space-*`, the 2px grid. Every padding, margin and gap comes from here.
 *
 * These ten steps are the system's exactly. The six the phone used to ship
 * (4/8/12/16/24/32) each landed on one of them, so adopting the system's names
 * was value-preserving at every call site — and it gains the 2, 6, 10 and 20
 * steps the dense end of the grid was missing.
 */
export const space = {
  "3xs": 2,
  "2xs": 4,
  xs: 6,
  sm: 8,
  md: 10,
  lg: 12,
  xl: 16,
  "2xl": 20,
  "3xl": 24,
  "4xl": 32,
} as const;

/**
 * `--sem-radius-*`. At most two per view. The site's values: controls are
 * `rounded-md` (6), cards and sheets `rounded-xl` (12), the hero card
 * `rounded-2xl` (16), and chips are pills.
 */
export const radius = {
  chip: 999,
  control: 6,
  overlay: 12,
  shell: 16,
  /**
   * `--sem-radius-composer`: the message box, New's and the chat's alike
   *. Rounder than a card, so the one place you
   * write reads as its own thing.
   */
  composer: 22,
  /** `--sem-radius-composer-strip`: the context strip tucked under New's box, rounded at the bottom only. */
  composerStrip: 16,
} as const;

/**
 * `--sem-icon-size-*`.
 *
 * `xs` is the one compact divergence: 14 against the pointer scale's 13. A 13px
 * glyph beside 13px meta copy reads as chrome on a monitor; beside the compact
 * ramp's 15px body it reads as a smudge. The other three are the system's values
 * unchanged.
 */
export const iconSize = {
  xs: 14,
  sm: 16,
  md: 18,
  lg: 22,
} as const;

/**
 * `--sem-size-control-*` — an input and a select side by side share a height.
 *
 * Compact throughout: the pointer scale's 26/30/34 are pointer targets, and a
 * touch control cannot be smaller than the hit-target floor below. Each step is
 * the pointer value plus the same 10pt, keeping the ramp's shape.
 */
export const controlSize = {
  xs: 36,
  sm: 40,
  md: 44,
} as const;

/**
 * `--sem-size-hit-target-min`. Nothing interactive is drawn below this.
 *
 * 44, not the pointer scale's 24: that value is a mouse target. 44pt is the iOS
 * HIG minimum and Material's 48dp rounds to the same intent, and the phone has
 * been building to it since the premium redesign. A small glyph pads out to it
 * with a transparent hit area rather than shrinking its target.
 */
export const hitTargetMin = 44;

/**
 * The transparent hit area that pads a control drawn `height` by `width`
 * points out to `hitTargetMin`, as a Pressable's `hitSlop`. A side that
 * already clears the floor gets none, so a row of chips does not reach into
 * its neighbours' targets.
 */
export function touchSlop(
  height: number,
  width: number = hitTargetMin,
): { top: number; bottom: number; left: number; right: number } {
  const vertical = Math.max(0, Math.ceil((hitTargetMin - height) / 2));
  const horizontal = Math.max(0, Math.ceil((hitTargetMin - width) / 2));
  return { top: vertical, bottom: vertical, left: horizontal, right: horizontal };
}

/** `--sem-focus-ring-*`. See the focus rules in principles.md. */
export const focusRing = {
  width: 2,
  /**
   * Never zero. `borderFocus` and `accentPrimary` are the same hue, so a ring
   * drawn tight against an accent-filled control has nothing to contrast with and
   * focused renders identically to unfocused.
   */
  offset: 2,
} as const;

/** `--sem-font-weight-*`. At most three per view. */
export const fontWeight = {
  regular: "400",
  medium: "500",
  emphasis: "600",
} as const;

/** `--sem-font-line-*`. Line height by context, not one default everywhere. */
export const lineHeightRatio = {
  tight: 1.25,
  default: 1.4,
  relaxed: 1.5,
} as const;

/**
 * `--sem-font-tracking-*`, in RN's `letterSpacing` points rather than `em`.
 *
 * The system expresses tracking in `em` because CSS can; RN cannot, so these are
 * the em values resolved against the compact ramp's body size (15pt):
 * -0.01em -> -0.15, 0.02em -> 0.3. Applied to other steps the drift is under a
 * quarter of a point, which is below the rendering floor.
 */
export const tracking = {
  tight: -0.15,
  normal: 0,
  wide: 0.3,
} as const;

/**
 * `--sem-z-*`. A surface that needs to sit between two of these is the wrong kind
 * of surface.
 */
export const zIndex = {
  base: 0,
  sticky: 10,
  drawer: 40,
  popover: 50,
  menu: 60,
  modal: 70,
  toast: 80,
} as const;

// The design system's `compact` type ramp — the touch-scale counterpart of its
// pointer scale. Same step NAMES and same step COUNT, different values, recorded
// in the system itself at `sem.font.size.*.$extensions["com.multicode"].platforms.compact`
// (the studio's design-system/foundations/tokens.tokens.json), not forked here.
//
// Why the phone keeps its own values. Three candidates
// were on the table: adopt the pointer values (11/12/13/14/16), keep the phone's
// and register them as a system mode, or take the system's names and step count
// while keeping the phone's values. The third won:
//
// - `principles.md` sets 13px as a *floor* for primary content ("primary content
//   does not go below font.size.body"). A 15px body EXCEEDS that rule; it does not
//   break it. So the phone was never non-conformant on the axis that has a rule.
// - A 13px body at 30cm and a 13px body at 60cm are different physical sizes, and
//   the viewing distances do not cancel. iOS HIG and Material both floor body copy
//   above 13px.
// - The 2026-07-10 conformance pass set these values with evidence. Re-litigating
//   them to match a pointer scale would be a regression wearing a conformance
//   badge — the same trap the epic warns about for the contrast floors.
//
// What this buys: a surface is portable between the two apps by NAME. `text-body`
// means "the default reading size" in both; only the pixels differ. `heading`
// deliberately collapses onto `body` — weight separates them, and a phone screen
// rarely earns four sizes against the "3 font sizes per view" ceiling.
//
// `title` at 22 and the 28px pairing-code field sit above the pointer ramp's top
// step, which is the same gap the desktop filed as `display-type-tier-above-title`.
// The compact ramp answers it for touch; the desktop's item still owns the pointer
// side. Repeat the same steps per screen.
export const typography = {
  title: { fontSize: 22, fontWeight: "600", lineHeight: 28 },
  heading: { fontSize: 15, fontWeight: "600", lineHeight: 20 },
  body: { fontSize: 15, fontWeight: "400", lineHeight: 21 },
  meta: { fontSize: 13, fontWeight: "400", lineHeight: 18 },
  micro: { fontSize: 11, fontWeight: "500", lineHeight: 14 },
} as const;

// `monoFontFamily` moved to ./fonts.ts: it was the only value in this
// file that needed react-native, and importing `Platform` here kept the whole
// token layer out of reach of the bare-Node regression suite.

/**
 * `#rrggbb` + alpha → `rgba(...)`: one identity hex drives a band, a chip
 * tint, and an avatar backing without per-file clones of this conversion.
 */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
