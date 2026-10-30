// A list row swiped to the left to show what can be done to it, as rules: when
// a drag is a swipe rather than a scroll, how far the row follows the finger,
// when a full swipe is armed, and where the row goes when the finger lifts.
// Kept free of React Native so the regression suite runs the same rules the
// row does (`SwipeRow.tsx`).

/** The width of one action behind the row. */
export const SWIPE_ACTION_WIDTH = 80;
/** How far a finger moves sideways before the drag is the row's and not the list's. */
export const SWIPE_CAPTURE_DX = 12;
/** A lift faster than this (px/ms) throws the row open or shut, wherever it is. */
export const SWIPE_FLING_VELOCITY = 0.6;
/** A full swipe arms past this share of the row's width, and never before every action has shown. */
export const SWIPE_COMMIT_SHARE = 0.55;
/** How much further than the actions a full swipe has to go, at least. */
export const SWIPE_COMMIT_MARGIN = 56;
/** Past the open edge a drag to the right meets this much give (a rubber band), and no more. */
export const SWIPE_OVERDRAG = 24;

export interface SwipeGeometry {
  /** How wide the actions behind the row are together. */
  actionsWidth: number;
  /** How wide the row is. */
  rowWidth: number;
  /** Whether a full swipe does the outermost action. */
  fullSwipe: boolean;
}

/**
 * Whether a move is a sideways swipe the row should take from the list: far
 * enough, and clearly more across than down. A row already open takes a drag
 * either way, so it can be pushed shut.
 */
export function swipeCaptures(dx: number, dy: number, open: boolean): boolean {
  if (Math.abs(dx) < SWIPE_CAPTURE_DX || Math.abs(dx) < Math.abs(dy) * 1.5) return false;
  return open || dx < 0;
}

/** How far a full swipe has to go, as a distance to the left. */
export function swipeCommitDistance(geometry: SwipeGeometry): number {
  return Math.max(geometry.actionsWidth + SWIPE_COMMIT_MARGIN, geometry.rowWidth * SWIPE_COMMIT_SHARE);
}

/**
 * Where the row sits for a drag of `dx` that started with the row at `start`
 * (0 shut, `-actionsWidth` open). It follows the finger to the left as far as
 * the row is wide where a full swipe is on, and only as far as the actions
 * plus a little give where it is not; to the right it gives a little past shut.
 */
export function swipeOffset(start: number, dx: number, geometry: SwipeGeometry): number {
  const raw = start + dx;
  if (raw > 0) return Math.min(SWIPE_OVERDRAG, raw / 4);
  const far = geometry.fullSwipe ? geometry.rowWidth : geometry.actionsWidth + SWIPE_OVERDRAG;
  return Math.max(-far, raw);
}

/** Whether lifting the finger here would do the full swipe's action. */
export function swipeArmed(offset: number, geometry: SwipeGeometry): boolean {
  return geometry.fullSwipe && -offset >= swipeCommitDistance(geometry);
}

export type SwipeRelease = "shut" | "open" | "commit";

/**
 * Where the row goes when the finger lifts at `offset` moving at `vx`: past
 * the full swipe's line it does the action; a quick throw opens or shuts it
 * whichever way it went; otherwise it settles on whichever is nearer.
 */
export function swipeRelease(offset: number, vx: number, geometry: SwipeGeometry): SwipeRelease {
  if (swipeArmed(offset, geometry)) return "commit";
  if (vx <= -SWIPE_FLING_VELOCITY) return "open";
  if (vx >= SWIPE_FLING_VELOCITY) return "shut";
  return -offset > geometry.actionsWidth / 2 ? "open" : "shut";
}
