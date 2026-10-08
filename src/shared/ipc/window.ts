// Part of the IPC contract: windows, the splash, aux windows and app updates.
// ../electron-api.ts re-exports everything here.

export type WindowState = {
  isMaximized: boolean
  isFullScreen: boolean
}

export type WindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type WindowPlacement = {
  bounds: WindowBounds
  isMaximized: boolean
  displayId: number | null
}

// One push from the boot-discovery pass to the splash window. `status` is a
// plain sentence naming the leg still in flight ("Finding your agents…"), never
// a percentage: the legs run concurrently and resolve out of order, so a
// percentage would be a promise the boot cannot keep. `progress` is 0..1 and
// drives only the hairline pinned to the splash's bottom edge, which advances on
// leg COMPLETION. Declared here rather than in src/main because the splash
// renderer and the preload both read it, and src/shared cannot import src/main.
export type SplashProgress = {
  status: string
  progress: number
}

export type CreateWorkspaceWindowInput = {
  windowId: string
  workspaceId?: string | null
  bounds?: WindowBounds | null
  isMaximized?: boolean
}

export type CreateWorkspaceWindowResult = { ok: true; windowId: string } | { ok: false; message: string }

// Lightweight auxiliary windows (diff viewer, external file editor, a pane
// popped out of its workspace window). Unlike workspace windows they do not
// mount the workspace shell or join workspace sync — the renderer branches on
// the `aux` query param into a dedicated root, mirroring the diagnostics window
// (`?view=diagnostics`). A `pane` window is not opened through
// `openAuxWindow`: it has an owner window main has to remember, so it has a
// channel of its own (`panePopOutOpen`, ipc/pane-popout.ts).
export type AuxWindowKind = 'diff' | 'file' | 'pane'

export type OpenAuxWindowInput = {
  kind: AuxWindowKind
  // Small string params encoded into the renderer URL (e.g. repoRoot, focusPath).
  params: Record<string, string>
  // Singleton identity. A request whose key matches an open window retargets and
  // focuses it instead of opening a duplicate. Diff uses a constant key (one diff
  // window at a time); file uses the file path (one window per file).
  singletonKey: string
  bounds?: WindowBounds | null
  /**
   * False for an agent's reveal: the window is retargeted where it stands, or
   * shown inactive when new, and never takes the keyboard or comes forward.
   * Absent (the person's own click) brings it forward as always.
   */
  focus?: boolean
}

export type OpenAuxWindowResult = { ok: true; retargeted: boolean } | { ok: false; message: string }

export type AuxWindowRetargetPayload = {
  kind: AuxWindowKind
  params: Record<string, string>
}

// Dock-back: the external editor window asks the owning workspace window to
// reopen a file as a normal editor tab. Broadcast to all windows; the one whose
// model owns the workspace handles it (others no-op).
export type DockFileToWorkspaceInput = {
  workspaceId: string
  path: string
  name: string
}

// The diff window handing its diff back to the app (git-commit-window T3).
// Broadcast like a docked file: the window that owns the workspace opens the
// pane's Diff tab on this repository and flips the sticky preference home.
export type DockDiffToWorkspaceInput = {
  workspaceId: string
  repoRoot: string
  focusPath: string | null
  focusKind: 'staged' | 'unstaged' | null
  /** The changelist the window was filtered to, so the pane tab it becomes
   *  opens on the same list (agent changelists). Null or absent: all changes. */
  changelistId?: string | null
}

// What the receiving window is handed, and what it acks with. The diff window
// closes itself on the strength of this hand-off, so the hand-off has to be
// acknowledged: `requestId` is what the workspace window sends back once it has
// actually opened the tab.
export type DockDiffToWorkspacePayload = DockDiffToWorkspaceInput & { requestId: string }

/** `accepted: false` means no open window took the diff — the caller keeps its
 *  own window up and says so, rather than closing into nothing. */
export type DockDiffToWorkspaceResult = { accepted: boolean }

// The diff viewer's "Add to chat": a passage of the diff, already worded as
// the quote it lands as, for the composer of the workspace's chat. The window
// holding that chat sets it into the draft and acks; the same one-at-a-time
// offer as the dock above, so two windows never both take it.
export type DiffToChatInput = { workspaceId: string; text: string }
export type DiffToChatPayload = DiffToChatInput & { requestId: string }
/** `accepted: false`: no open window holds a chat for that workspace. */
export type DiffToChatResult = { accepted: boolean }
/** The longest quote the hand-off carries: the composer's own quote ceiling, a note, and the reference. */
export const DIFF_TO_CHAT_MAX_CHARS = 12_000

export type OpenExternalResult = { ok: true } | { ok: false; message: string }

/** `installing` runs from "Restart to update" until the app hands over to the installer. */
export type AppUpdateStatus =
  'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'not_available' | 'error'

/** A release train an installed build can follow. */
export type AppUpdateTrack = 'stable' | 'nightly'

/** The channel the updater follows; `dev` is an unpackaged build, which follows none. */
export type AppUpdateChannel = 'dev' | AppUpdateTrack

/** The channel a packaged build would follow, and whether the person picked it
 *  (`chosen`) or it came from the build's own version. */
export type AppUpdateChannelSetting = {
  channel: AppUpdateTrack
  chosen: boolean
}

export type AppUpdateProgress = {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/**
 * What became of the last update this install handed to an installer, read
 * once at the start after it (main's update-install note). `updated` when the
 * version running is the one it went to; `failed` when it is still the one it
 * came from.
 */
export type AppUpdateInstallOutcome = {
  kind: 'updated' | 'failed'
  /** The version the update was going to. */
  version: string
  fromVersion: string
  /** Why it failed, in a sentence; null when it did not. */
  message: string | null
}

export type AppUpdateState = {
  status: AppUpdateStatus
  version: string
  /** The channel the updater follows now: the saved choice, else the build's
   *  own. `dev` for an unpackaged build. */
  channel: AppUpdateChannel
  /** The channel this build was cut for, read from its version and fixed for
   *  the life of the process. It differs from `channel` once a person switches
   *  trains in Settings: a nightly build following stable is still a nightly
   *  until the stable update installs over it. */
  buildChannel: AppUpdateTrack
  packaged: boolean
  updateVersion: string | null
  releaseName: string | null
  releaseNotes: string | null
  releaseNotesUrl: string | null
  downloaded: boolean
  progress: AppUpdateProgress | null
  errorMessage: string | null
  lastCheckedAt: string | null
  /** Download an update as soon as a check finds one. Off unless the person turns it on. */
  autoDownload: boolean
  /**
   * Installing needs an administrator: a Windows installation for all users,
   * or in a folder the person cannot write. Windows asks for permission when
   * Restart to update is pressed, and such an update does not install at quit.
   */
  installRequiresAdmin: boolean
  /** The last update's result, until the renderer has shown it. */
  installOutcome: AppUpdateInstallOutcome | null
}

export type AppUpdateCheckResult =
  { ok: true; state: AppUpdateState; message: string } | { ok: false; state: AppUpdateState; message: string }

export type SessionUser = {
  id: string
  email: string | null
  displayName: string | null
  /**
   * The provider profile photo, ready to render: a `data:` URL served from the
   * main process's on-disk cache, never the provider's remote URL.
   * Null when the account has no photo or the bytes could not be fetched —
   * the renderer falls back to initials either way.
   */
  photoUrl: string | null
}
