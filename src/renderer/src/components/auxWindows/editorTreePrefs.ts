// The editor window's file tree remembers two things about itself: whether it
// is showing, and how wide it is (the diff viewer's file column, the same). They belong to that window, so they live in
// its own localStorage key — exactly as the window's placement does
// (auxWindowPlacement.ts) — and never in the shared settings envelope. An aux
// window writing the envelope would push the snapshot it opened with over
// every setting the workspace window has changed since (auxSettingsWrite.ts),
// and a column width is not worth that hazard.

export const EDITOR_TREE_DEFAULT_WIDTH = 260
export const EDITOR_TREE_MIN_WIDTH = 180
export const EDITOR_TREE_MAX_WIDTH = 480

export const EDITOR_TREE_PREFS_KEY = 'sprintengine.auxWindow.file.tree'

export type EditorTreePrefs = {
  visible: boolean
  width: number
}

export const DEFAULT_EDITOR_TREE_PREFS: EditorTreePrefs = {
  // Shown by default: the tree is how the window says where the file is.
  visible: true,
  width: EDITOR_TREE_DEFAULT_WIDTH,
}

export function clampEditorTreeWidth(width: number): number {
  if (!Number.isFinite(width)) return EDITOR_TREE_DEFAULT_WIDTH
  return Math.round(Math.min(EDITOR_TREE_MAX_WIDTH, Math.max(EDITOR_TREE_MIN_WIDTH, width)))
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    // A document with storage blocked throws on the accessor itself.
    return null
  }
}

/**
 * The diff viewer's file column keeps the same two facts, under a key per host:
 * the diff window's, and the pane's Diff tab's. The pane's starts hidden — it
 * is the narrow right-hand column, where a tree beside a side-by-side diff
 * would leave neither readable — and the window's starts shown, like the
 * editor window's.
 */
export const DIFF_WINDOW_TREE_PREFS_KEY = 'sprintengine.auxWindow.diff.tree'
export const DIFF_PANE_TREE_PREFS_KEY = 'sprintengine.pane.diff.tree'

export function readTreeColumnPrefs(
  key: string,
  defaults: EditorTreePrefs,
  storage: StorageLike | null = defaultStorage(),
): EditorTreePrefs {
  try {
    const raw = storage?.getItem(key)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<EditorTreePrefs> | null
    return {
      visible: typeof parsed?.visible === 'boolean' ? parsed.visible : defaults.visible,
      width: typeof parsed?.width === 'number' ? clampEditorTreeWidth(parsed.width) : defaults.width,
    }
  } catch {
    return defaults
  }
}

export function writeTreeColumnPrefs(
  key: string,
  prefs: EditorTreePrefs,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(key, JSON.stringify({ visible: prefs.visible, width: clampEditorTreeWidth(prefs.width) }))
  } catch {
    // Best-effort: a quota or serialization failure means the next window
    // opens with the defaults.
  }
}

export function readEditorTreePrefs(storage: StorageLike | null = defaultStorage()): EditorTreePrefs {
  return readTreeColumnPrefs(EDITOR_TREE_PREFS_KEY, DEFAULT_EDITOR_TREE_PREFS, storage)
}

export function writeEditorTreePrefs(prefs: EditorTreePrefs, storage: StorageLike | null = defaultStorage()): void {
  writeTreeColumnPrefs(EDITOR_TREE_PREFS_KEY, prefs, storage)
}
