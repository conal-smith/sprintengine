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
  /**
   * A folder here, or one on an SSH machine spelled `ssh://<id>/…`
   * (machine-paths.ts), which the editor, installed here, opens through its
   * own Remote - SSH rather than from this computer's disk.
   */
  path: string
}

/**
 * The editors that open a folder on an SSH machine themselves, each by the URL
 * scheme its Remote - SSH extension answers (`<scheme>://vscode-remote/
 * ssh-remote+<host><path>`, as VS Code documents it). Only these are offered
 * for a project on an SSH machine.
 */
const SSH_REMOTE_URL_SCHEMES: Partial<Record<FolderOpenTargetId, string>> = {
  vscode: 'vscode',
  'vscode-insiders': 'vscode-insiders',
}

export function folderOpenTargetOpensOverSsh(target: FolderOpenTargetId): boolean {
  return Object.hasOwn(SSH_REMOTE_URL_SCHEMES, target)
}

// An SSH config alias, or `user@host`: what the URL's authority carries as it
// is. A destination with a port (`host:2222`) has no spelling there, so it is
// refused rather than opened on port 22.
const SSH_URL_HOST = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$/u

/**
 * The URL that opens `remotePath` on the SSH machine `destination` in
 * `target`, or a reason it cannot be opened that way.
 */
export function sshRemoteFolderUrl(
  target: FolderOpenTargetId,
  destination: string,
  remotePath: string,
): { ok: true; url: string } | { ok: false; message: string } {
  const scheme = SSH_REMOTE_URL_SCHEMES[target]
  if (!scheme) return { ok: false, message: 'This editor cannot open a folder on an SSH machine.' }
  const host = destination.trim()
  if (!SSH_URL_HOST.test(host))
    return {
      ok: false,
      message: `"${host}" names a port or something else an editor's link cannot carry. Save the machine as a Host in your SSH config and open it by that name.`,
    }
  if (!remotePath.startsWith('/')) return { ok: false, message: 'The folder on the SSH machine has no absolute path.' }
  const encoded = remotePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return { ok: true, url: `${scheme}://vscode-remote/ssh-remote+${host}${encoded}` }
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
