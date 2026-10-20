// The lifecycle vocabulary's *data*: the state set, its labels, and the theme
// token each state inks from. Kept out of LifecycleGlyph.tsx — which imports
// react-native-svg — so `node --test` can load it and enforce the WCAG 1.4.11
// contrast floor on every state/surface pair.
//
// Traces ../multicode/src/renderer/src/components/ui/LifecycleGlyph.tsx.
import type { ThemeColors } from "../../theme/tokens";

// One shape-coded lifecycle vocabulary, carrying Backlog readiness.
// State reads by shape (ring / dashed / gauge / "!" / check /
// slash / "×"), never by color alone — color only reinforces. Domain-agnostic:
// callers map their own status enum to a LifecycleState.
export type LifecycleState =
  | "todo"
  | "idea"
  | "ready"
  | "in_progress"
  | "paused"
  | "review"
  | "needs_input"
  /** A filed evidence record — a document mark with a tick. Read-only. */
  | "recorded"
  | "done"
  /** Cancelled work — kept on the record, never a lane of its own. */
  | "canceled"
  /** Approved by policy, not a human hand: the `done` check on an outline ring. */
  | "approved_auto"
  /** Complete, sitting on a branch — a green git fork. */
  | "done_unmerged"
  /** Complete and merged — the same fork in merged-purple. */
  | "done_merged"
  | "archived"
  | "failed";

export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  todo: "To do",
  idea: "Idea",
  ready: "Ready",
  in_progress: "In progress",
  paused: "Paused",
  review: "In review",
  needs_input: "Needs input",
  recorded: "Recorded",
  done: "Done",
  canceled: "Canceled",
  approved_auto: "Approved automatically",
  done_unmerged: "Complete · not merged",
  done_merged: "Merged",
  archived: "Archived",
  failed: "Failed",
};

// Token name per state, not a resolved color: the glyph re-inks with the theme
// because it reads `colors[LIFECYCLE_TONE[state]]` at render, and the map stays a
// 1:1 trace of the desktop's `TONE` record.
export const LIFECYCLE_TONE: Record<LifecycleState, keyof ThemeColors> = {
  todo: "textSubtle",
  idea: "textDisabled",
  ready: "accentPrimary",
  in_progress: "accentPrimary",
  // Paused is a held run, not a live one: neutral ink, never the accent that
  // signals "happening right now".
  paused: "textSubtle",
  review: "accentPrimary",
  needs_input: "toneWarn",
  // Recorded evidence is neutral, not a status the user must act on.
  recorded: "textSubtle",
  done: "toneGood",
  // Canceled work is history, not attention: disabled ink like archived.
  canceled: "textDisabled",
  approved_auto: "toneGood",
  done_unmerged: "toneGood",
  done_merged: "toneMerged",
  archived: "textDisabled",
  failed: "toneError",
};

export const lifecycleStates = Object.keys(LIFECYCLE_TONE) as LifecycleState[];

/**
 * Every surface a glyph can be painted on: the screen canvas, cards, and the
 * hover/pressed/selected states a list row passes through. The contrast floor is
 * enforced against all of them.
 */
export const glyphSurfaces = [
  "bgApp",
  "bgSurface",
  "bgSurfaceRaised",
  "bgSurfaceSelected",
  "bgHover",
  "bgActive",
  "bgSelected",
  // The resting selection tier. A row in a pane that is not being driven
  // still shows its glyphs, so this surface owes the same 3:1 floor as every
  // other — adding the token without adding it here would have left a whole
  // selection tier unswept.
  "bgSelectedResting",
] as const satisfies readonly (keyof ThemeColors)[];

/** WCAG 2.1 SC 1.4.11: informational graphics owe 3:1 against their background. */
export const nonTextContrastFloor = 3;
