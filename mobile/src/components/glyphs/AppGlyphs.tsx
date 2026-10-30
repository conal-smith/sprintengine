import { Circle, Path, Rect } from "react-native-svg";

import { useTheme } from "../../theme/ThemeProvider";
import type { ThemeColors } from "../../theme/tokens";
import { GlyphFrame, iconSize, type GlyphProps } from "./Glyph";
import { DrawingParts } from "./MachineGlyph";
import { REMOTE_MACHINE_DRAWING } from "./machineMarks";

// The studio's own marks, ported to the phone: words give way to glyphs.
//
// The first three are copied coordinate-for-coordinate from the desktop
// renderer's AppIcons.tsx — `FolderGlyphIcon`, `RemoteMachineGlyph` (the
// Beam) and `GitBranchGlyph` — because a project, a machine and a branch have to wear the
// SAME mark on both surfaces or the chip stops being recognisable. They draw on
// the 16 grid the desktop draws them on, so nothing is rescaled by hand.
//
// The rest are drawn fresh at this file's one house stroke, the same way
// ChromeIcons is: they are chrome the desktop has no phone-shaped equivalent of.
// Ink is `textMuted` at rest, like every other chrome mark.

const STROKE = 1.4;

interface AppGlyphProps extends GlyphProps {
  /** Ink token. A chip passes `textMuted`; a danger menu row passes `toneError`. */
  tone?: keyof ThemeColors;
  /**
   * A literal colour, winning over `tone`.
   *
   * For the one ink that is not a token and cannot be: a project's hue is a
   * degree the desktop hashed, so it is one of 360 colours resolved at render
   * (theme/projectHue.ts) rather than a name in the palette. Everything else
   * should keep passing `tone` — an arbitrary colour on a glyph is how a design
   * system stops being one.
   */
  ink?: string | null;
}

function useInk(tone: keyof ThemeColors = "textMuted", ink?: string | null): string {
  const { colors } = useTheme();
  return ink ?? colors[tone];
}

// ── The studio's three, verbatim ──────────────────────────────────────────

/** A folder — the project chip's mark. Desktop `FolderGlyphIcon`. */
export function FolderGlyph({ tone, size = iconSize.xs, label, ink }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone, ink)} size={size} label={label}>
      <Path
        d="M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z"
        stroke="currentColor"
        strokeWidth={STROKE}
      />
    </GlyphFrame>
  );
}

/**
 * The Beam: a screen reached over the air — another machine, in general.
 * Desktop `remote-machine.svg`. A paired desktop that has said what it is wears
 * its own machine mark (`MachineGlyph`) instead.
 */
export function RemoteMachineGlyph({ tone, size = iconSize.xs, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <DrawingParts parts={REMOTE_MACHINE_DRAWING} />
    </GlyphFrame>
  );
}

/** Three nodes and a merge — the branch chip's mark. Desktop `GitBranchGlyph`. */
export function GitBranchGlyph({ tone, size = iconSize.xs, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Circle cx="4.5" cy="4" r="1.7" stroke="currentColor" strokeWidth={STROKE} />
      <Circle cx="4.5" cy="12" r="1.7" stroke="currentColor" strokeWidth={STROKE} />
      <Circle cx="11.5" cy="5.5" r="1.7" stroke="currentColor" strokeWidth={STROKE} />
      <Path
        d="M4.5 5.7v4.6M11.5 7.2c0 2.4-3.2 2.3-7 2.9"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
      />
    </GlyphFrame>
  );
}

// ── Chrome the phone needs ────────────────────────────────────────────────

/** A bell — the notices button. */
export function BellIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Path
        d="M4 11V7.5a4 4 0 118 0V11l1 1.5H3L4 11z"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <Path d="M6.5 14h3" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </GlyphFrame>
  );
}

/**
 * A clock face — a scheduled agent, a time still to come. Copied from the
 * desktop's `ScheduleGlyph`, so a schedule wears the same mark on both.
 */
export function ScheduleIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Circle cx="8" cy="8" r="5.6" stroke="currentColor" strokeWidth={STROKE} />
      <Path d="M8 4.9V8l2.1 1.4" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </GlyphFrame>
  );
}

/** Three dots — the thread's one overflow button. */
export function MoreIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  const ink = useInk(tone);
  return (
    <GlyphFrame viewBox="0 0 16 16" color={ink} size={size} label={label}>
      <Circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
      <Circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <Circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
    </GlyphFrame>
  );
}

/** A page with a folded corner — changed files. */
export function FilesIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Path d="M4 2.5h5l3 3v8H4z" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
      <Path d="M9 2.5v3h3" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
    </GlyphFrame>
  );
}

/** A plus — compose, and "add a folder". */
export function PlusIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </GlyphFrame>
  );
}

/** A tick — a chosen option, and the git sheet's Commit row. */
export function CheckIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </GlyphFrame>
  );
}

/**
 * Two sheets, one over the other: copy. The desktop's `CopyIcon`, redrawn on
 * the 16 grid at the house stroke.
 */
export function CopyIcon({ tone, size = iconSize.sm, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Rect x="6" y="6" width="7.5" height="7.5" rx="1.4" stroke="currentColor" strokeWidth={STROKE} />
      <Path
        d="M3.5 10H3a1 1 0 0 1-1-1V3.4A1.4 1.4 0 0 1 3.4 2H9a1 1 0 0 1 1 1v.5"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </GlyphFrame>
  );
}

/** An arc and an arrow — refresh the git sheet. */
export function RefreshIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Path
        d="M13 8a5 5 0 11-1.5-3.6M13 3v2.5h-2.5"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </GlyphFrame>
  );
}

/** An arrow leaving a box — push. */
export function PushIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Path d="M8 12.5V3.5M4.8 6.7 8 3.5l3.2 3.2" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M3 13.2h10" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </GlyphFrame>
  );
}

/**
 * A folder holding a commit node: a checkout in its own directory. Desktop
 * `glyphs/worktree.svg`; New's context strip names a worktree with it.
 */
export function WorktreeGlyph({ tone, size = iconSize.xs, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Path
        d="M1.75 4.75c0-.83.67-1.5 1.5-1.5h3.1l1.5 1.5h5.4c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5z"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinejoin="round"
      />
      <Circle cx="8" cy="9.6" r="1.25" fill="none" stroke="currentColor" strokeWidth={1.2} />
      <Path d="M4.25 9.6h2.5M9.25 9.6h2.5" stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" />
    </GlyphFrame>
  );
}

/** A branch feeding an arrow — open a pull request. */
export function PullRequestIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Circle cx="4.3" cy="4" r="1.6" stroke="currentColor" strokeWidth={STROKE} />
      <Circle cx="4.3" cy="12" r="1.6" stroke="currentColor" strokeWidth={STROKE} />
      <Circle cx="11.7" cy="12" r="1.6" stroke="currentColor" strokeWidth={STROKE} />
      <Path d="M4.3 5.6v4.8M11.7 10.4V6.6a2 2 0 0 0-2-2H7.4" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <Path d="M8.9 3.1 7.3 4.6l1.6 1.5" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </GlyphFrame>
  );
}

/** Stacked rules — review the changed files. */
export function DiffIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Path d="M2.6 4h10.8M2.6 8h10.8M2.6 12h6.8" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </GlyphFrame>
  );
}

/** A head and shoulders — the account row. */
export function PersonIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Circle cx="8" cy="5.6" r="2.5" stroke="currentColor" strokeWidth={STROKE} />
      <Path d="M3 13.2a5 5 0 0 1 10 0" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </GlyphFrame>
  );
}

/** A half-filled disc — the appearance row. */
export function AppearanceIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Circle cx="8" cy="8" r="5.2" stroke="currentColor" strokeWidth={STROKE} />
      <Path d="M8 2.8a5.2 5.2 0 0 1 0 10.4z" fill="currentColor" />
    </GlyphFrame>
  );
}

/** An arrow out of a door — sign out, and forget a desktop. */
export function SignOutIcon({ tone, size = iconSize.md, label }: AppGlyphProps) {
  return (
    <GlyphFrame viewBox="0 0 16 16" color={useInk(tone)} size={size} label={label}>
      <Path d="M9.5 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h5.5" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <Path d="M7.5 8h6M11.3 5.6 13.7 8l-2.4 2.4" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </GlyphFrame>
  );
}
