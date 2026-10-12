// The fixed set of places a workspace folder can be opened from the
// open-in-editor control. Renderer and main share this list so the probe result
// and the open request cannot drift apart.
//
// The order is the menu's, and the preference order the primary half falls
// back on: VS Code and the editors built on it, the other standalone editors,
// the JetBrains IDEs together, the file manager last. Only the installed ones
// are ever shown, so a long list costs a menu nothing.
//
// The ids are persisted (the remembered target), so one is never renamed or
// reused: a build that does not know an id reads it as no remembered target.
export const FOLDER_OPEN_TARGET_IDS = [
  'vscode',
  'vscode-insiders',
  'vscodium',
  'cursor',
  'windsurf',
  'trae',
  'kiro',
  'antigravity',
  'zed',
  'sublime',
  'intellij',
  'webstorm',
  'pycharm',
  'goland',
  'clion',
  'phpstorm',
  'rider',
  'rubymine',
  'rustrover',
  'datagrip',
  'finder',
] as const

export type FolderOpenTargetId = (typeof FOLDER_OPEN_TARGET_IDS)[number]

export function isFolderOpenTargetId(value: unknown): value is FolderOpenTargetId {
  return typeof value === 'string' && (FOLDER_OPEN_TARGET_IDS as readonly string[]).includes(value)
}

/**
 * One entry per target, always all of them. `available` is true only when the
 * launcher genuinely resolves — the editor CLI on PATH or an installed
 * application bundle — so a false entry means the editor is not installed and
 * the control must omit it rather than show it disabled. The file manager is
 * always available: it is the OS reveal that already ships.
 */
export type FolderOpenTargetAvailability = {
  id: FolderOpenTargetId
  available: boolean
}

export type FolderOpenRequest = {
  target: FolderOpenTargetId
  path: string
}

/**
 * Why a launch did not happen. Callers surface the failure; nothing retries a
 * different target on their behalf.
 */
export type FolderOpenFailureReason =
  /** `target` was not one of the known ids. */
  | 'unknown_target'
  /** The folder path was empty, or unreadable at launch time. */
  | 'path_unavailable'
  /** The target's launcher no longer resolves (uninstalled since the probe). */
  | 'target_unavailable'
  /** The launcher resolved but exited with a failure. */
  | 'launch_failed'

export type FolderOpenResult =
  | { ok: true; target: FolderOpenTargetId }
  | { ok: false; target: FolderOpenTargetId | null; reason: FolderOpenFailureReason; message: string }
