// Width bounds for the right-docked workspace pane column, mirroring the
// workspace sidebar's drag-to-resize idiom (sidebarWidth.ts). No collapse snap —
// the column's visibility is the pane's open flag, not the drag's. The names
// keep the column's original "aside" vocabulary: the chrome in
// workspaceAsideColumn.tsx predates the pane and is what the pane renders in.
export const WORKSPACE_ASIDE_MIN_WIDTH = 240
export const WORKSPACE_ASIDE_DEFAULT_WIDTH = 420

// No fixed ceiling (owner ruling 2026-11-02): the person may drag the column
// as wide as the row it sits in. That ceiling is the row's width, which only
// the column can measure, so it caps itself (workspaceAsideColumn.tsx) and a
// stored width is only floored here.
export function clampWorkspaceAsideWidth(width: number): number {
  if (!Number.isFinite(width)) return WORKSPACE_ASIDE_DEFAULT_WIDTH
  return Math.max(WORKSPACE_ASIDE_MIN_WIDTH, Math.round(width))
}
