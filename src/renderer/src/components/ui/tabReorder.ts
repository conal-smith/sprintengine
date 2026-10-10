// The arithmetic behind dragging a tab to a new place in its strip, kept apart
// from the pointer handling so it can be checked without a layout engine.
//
// A drag is read as a SLOT: the gap between two tabs the dragged one would
// land in, 0 before the first tab and `count` after the last. The drop
// indicator is drawn at the slot; the move is reported as the index the tab
// ends up at once it has left its own place, which is what a splice wants.

/** How far a press has to travel before it is a drag rather than a click. */
export const TAB_REORDER_THRESHOLD_PX = 4

/**
 * How far inside the strip's last edge the drop marker stands for the slot
 * after the last tab: the marker's own half-width (it is 2px, centred), so all
 * of it is on the near side of the scroller's clip.
 */
export const TAB_DROP_MARKER_INSET_PX = 1

/**
 * The slot the pointer is over: the number of tabs whose horizontal middle is
 * left of it. Past a tab's middle reads as "after it", the rule every tab
 * strip uses, so a drag never needs to reach the far edge of a wide tab.
 */
export function tabReorderSlot(midpoints: readonly number[], pointerX: number): number {
  let slot = 0
  for (const middle of midpoints) {
    if (pointerX > middle) slot += 1
  }
  return slot
}

/**
 * The index a tab dragged from `fromIndex` ends up at when dropped in `slot`.
 * A slot right of the tab's own place counts the tab itself, which has left;
 * the two slots either side of it are where it already is.
 */
export function tabReorderTargetIndex(slot: number, fromIndex: number): number {
  return slot > fromIndex ? slot - 1 : slot
}
