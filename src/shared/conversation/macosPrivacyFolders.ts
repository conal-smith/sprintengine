// macOS keeps Desktop, Documents, Downloads and iCloud Drive behind its own
// privacy permission (Files and Folders), granted per app. An agent CLI the
// app starts in a project there inherits the app's grant; without one the
// system refuses it the folder, and the CLI dies at startup with nothing more
// than EPERM or "Operation not permitted" — which reads as the CLI's fault.
// When that is the likely cause, the failure says what to change and where.

/** Said after the CLI's own failure, so the error's words stay first. */
export const MACOS_PRIVACY_FOLDER_HINT =
  'macOS may be blocking access to this folder. Allow it in System Settings › Privacy & Security › Files and Folders.'

/** System Settings, open on Privacy & Security › Files and Folders. The one non-web link the app opens. */
export const MACOS_FILES_AND_FOLDERS_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'

// Relative to the home folder. iCloud Drive is `Library/Mobile Documents`.
const PROTECTED_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents']

const normalize = (path: string) => path.replace(/\/+$/u, '').toLowerCase()

/** Whether a folder is one of the ones macOS keeps behind Files and Folders, or inside one. */
export function isMacosPrivacyFolder(folder: string, home: string): boolean {
  if (!folder || !home) return false
  const target = normalize(folder)
  const base = normalize(home)
  return PROTECTED_FOLDERS.some((name) => {
    const root = `${base}/${name.toLowerCase()}`
    return target === root || target.startsWith(`${root}/`)
  })
}

/** Whether a failure's text is the system refusing access, the way a privacy denial reads. */
export function looksLikeOperationNotPermitted(text: string): boolean {
  return /\bEPERM\b|operation not permitted/iu.test(text)
}

/**
 * The failure message with the privacy hint after it, when the CLI ran on
 * macOS in a protected folder and was refused with EPERM. `evidence` is
 * everything the failure said (the error, the CLI's stderr); the message
 * itself is returned unchanged otherwise, and never gets the hint twice.
 */
export function withMacosPrivacyFolderHint(
  message: string,
  context: { platform: string; folder: string | null | undefined; home: string; evidence?: string },
): string {
  if (context.platform !== 'darwin' || !context.folder) return message
  if (message.includes(MACOS_PRIVACY_FOLDER_HINT)) return message
  if (!isMacosPrivacyFolder(context.folder, context.home)) return message
  if (!looksLikeOperationNotPermitted(`${message}\n${context.evidence ?? ''}`)) return message
  const separator = /[.!?)]$/u.test(message.trim()) ? ' ' : '. '
  return `${message.trim()}${separator}${MACOS_PRIVACY_FOLDER_HINT}`
}

/** Whether a failure carries the hint, so the transcript can lead with it and offer the settings. */
export function hasMacosPrivacyFolderHint(text: string | null | undefined): boolean {
  return Boolean(text?.includes(MACOS_PRIVACY_FOLDER_HINT))
}
