import { Circle, G, Path } from "react-native-svg";

import { useTheme } from "../../theme/ThemeProvider";
import type { ThemeColors } from "../../theme/tokens";
import { GlyphFrame, iconSize, type GlyphProps } from "./Glyph";

// Navigation and control icons for the shell. Unlike the lifecycle vocabulary
// — which is ported shape-for-shape — chrome is drawn fresh on the
// 16 grid at one house stroke, because a tab bar has to read as a single family
// and the desktop's chrome comes off a 24 grid at a lighter relative weight.
// Where the desktop has an equivalent mark, its geometry is followed.
//
// Chrome inks from `textMuted` at rest and `accentPrimary` when active — the
// one accent the view is allowed.

const STROKE = 1.4;

interface ChromeIconProps extends GlyphProps {
  /** Ink token. Tab bars pass `accentPrimary` for the active tab. */
  tone?: keyof ThemeColors;
}

function useChromeInk(tone: keyof ThemeColors = "textMuted"): string {
  const { colors } = useTheme();
  return colors[tone];
}

// ── Tab bar ───────────────────────────────────────────────────────────────
// One glyph per destination, each a distinct silhouette at 22 pt under a thumb.

/** A house — the landing surface. Roof line, walls, and a door. */
export function HomeIcon({ tone, size = iconSize.lg, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Path
        d="M2.6 7.5 8 3l5.4 4.5"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M4 8.7v4a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-4"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
      <Path d="M6.7 13.7v-3h2.6v3" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
    </GlyphFrame>
  );
}

/** A worklist: three rows, each led by its item mark. */
export function BacklogIcon({ tone, size = iconSize.lg, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Circle cx="3.6" cy="4.4" r="0.95" fill="currentColor" />
      <Circle cx="3.6" cy="8" r="0.95" fill="currentColor" />
      <Circle cx="3.6" cy="11.6" r="0.95" fill="currentColor" />
      <Path
        d="M6.6 4.4h5.8M6.6 8h5.8M6.6 11.6h3.6"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </GlyphFrame>
  );
}

/** Two sliders — the desktop's own Settings mark, not a gear. */
export function SettingsIcon({ tone, size = iconSize.lg, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Path d="M2.7 5.3h2.2M7.7 5.3h5.6" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <Circle cx="6.3" cy="5.3" r="1.4" stroke="currentColor" strokeWidth={STROKE} />
      <Path d="M2.7 10.7h6.2M11.7 10.7h1.6" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <Circle cx="10.3" cy="10.7" r="1.4" stroke="currentColor" strokeWidth={STROKE} />
    </GlyphFrame>
  );
}

/** A bolt — the access a new chat's agent runs with (New chat's access chip). */
export function BoltIcon({ tone, size = iconSize.sm, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Path
        d="M9 2.2 3.9 9h3.3l-.7 4.8L11.9 7H8.3z"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
    </GlyphFrame>
  );
}

/**
 * Anthropic's starburst, for the model chip.
 *
 * The one mark in this file that does not take a tone. It is a logo, not chrome:
 * it identifies whose model is about to run, and a logo rendered in our own ink
 * stops identifying anything. The colour is Anthropic's, fixed in both themes,
 * and it is the only place the app carries a second brand — which is why it is
 * confined to the model chip and never used as decoration.
 */
// design-tokens-allow: Anthropic's brand colour, and a logo may not be recoloured.
const CLAUDE_ORANGE = "#d77757";

/** Eight-armed starburst, filled — the Anthropic mark. */
export function ClaudeMark({ size = iconSize.sm, label }: GlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={CLAUDE_ORANGE} size={size} label={label}>
      <G fill="currentColor">
        <Path d="M8 1.4 9.05 6.2 8 8 6.95 6.2z" />
        <Path d="M8 14.6 6.95 9.8 8 8l1.05 1.8z" />
        <Path d="M1.4 8 6.2 6.95 8 8 6.2 9.05z" />
        <Path d="M14.6 8 9.8 9.05 8 8l1.8-1.05z" />
        <Path d="M3.34 3.34 7.3 6.06 8 8 6.06 7.3z" />
        <Path d="M12.66 12.66 8.7 9.94 8 8l1.94.7z" />
        <Path d="M12.66 3.34 9.94 7.3 8 8l.7-1.94z" />
        <Path d="M3.34 12.66 6.06 8.7 8 8l-.7 1.94z" />
      </G>
    </GlyphFrame>
  );
}

// ── Controls ──────────────────────────────────────────────────────────────

/** Ring, hub, and eight teeth. The affordance for "configure this surface". */
export function GearIcon({ tone, size = iconSize.sm, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Circle cx="8" cy="8" r="3.9" stroke="currentColor" strokeWidth={STROKE} />
      <Circle cx="8" cy="8" r="1.6" stroke="currentColor" strokeWidth={STROKE} />
      <Path
        d="M8 4.1V2.8M8 11.9v1.3M4.1 8H2.8M11.9 8h1.3M5.24 5.24 4.32 4.32M10.76 10.76l.92.92M10.76 5.24l.92-.92M5.24 10.76l-.92.92"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </GlyphFrame>
  );
}

export type ChevronDirection = "up" | "right" | "down" | "left";

const CHEVRON_ROTATION: Record<ChevronDirection, number> = {
  down: 0,
  left: 90,
  up: 180,
  right: 270,
};

/** One chevron, four ways. Down is the drawn shape; the rest rotate about centre. */
export function ChevronIcon({
  direction = "down",
  tone,
  size = iconSize.sm,
  label,
}: ChromeIconProps & { direction?: ChevronDirection }) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <G rotation={CHEVRON_ROTATION[direction]} origin="8, 8">
        <Path
          d="M4.2 6.4 8 10.2l3.8-3.8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </G>
    </GlyphFrame>
  );
}

/** Narrowing rules — the desktop FilterMenu mark, already on the 16 grid. */
export function FilterIcon({ tone, size = iconSize.sm, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </GlyphFrame>
  );
}

export function CloseIcon({ tone, size = iconSize.sm, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Path d="M4.4 4.4 11.6 11.6M11.6 4.4 4.4 11.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </GlyphFrame>
  );
}

/** Two corners pulled outward: open something at full size. */
export function ExpandIcon({ tone, size = iconSize.sm, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Path
        d="M9.5 2.75h3.75V6.5M13.25 2.75 9.25 6.75M6.5 13.25H2.75V9.5M2.75 13.25l4-4"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </GlyphFrame>
  );
}

/** Two corners pushed inward: back to the smaller size. Expand's reverse. */
export function CollapseIcon({ tone, size = iconSize.sm, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Path
        d="M9.25 3v3.75H13M9.25 6.75l4-4M6.75 13V9.25H3M6.75 9.25l-4 4"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </GlyphFrame>
  );
}

export function SearchIcon({ tone, size = iconSize.sm, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Circle cx="7" cy="7" r="3.6" stroke="currentColor" strokeWidth={STROKE} />
      <Path d="M9.7 9.7 13.2 13.2" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </GlyphFrame>
  );
}

/**
 * Three rules — the affordance for "this opens the project panel".
 *
 * It is not a navigation hamburger: the drawer stays retired (the tab bar is the
 * navigation model, per the completed 2026-07-07 app-shell decision). This mark
 * only ever opens the context switcher, which is why it sits *inside* the project
 * chip rather than alone in the header where a drawer trigger would live.
 */
export function MenuIcon({ tone, size = iconSize.sm, label }: ChromeIconProps) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Path d="M2.8 4.4h10.4M2.8 8h10.4M2.8 11.6h10.4" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </GlyphFrame>
  );
}

/**
 * The favourite mark, in both states. Filled is starred, outline is not — the
 * state reads by fill, never by colour alone, so it survives the Herbarium
 * parchment and a colour-blind read the same way the lifecycle glyphs do.
 */
export function StarIcon({ filled = false, tone, size = iconSize.sm, label }: ChromeIconProps & { filled?: boolean }) {
  const ink = useChromeInk(tone);

  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Path
        d="M8 2.2 9.85 5.95l4.15.6-3 2.93.71 4.12L8 11.65l-3.71 1.95.71-4.12-3-2.93 4.15-.6z"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill={filled ? "currentColor" : "none"}
      />
    </GlyphFrame>
  );
}
