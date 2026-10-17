import { MACOS_FILES_AND_FOLDERS_SETTINGS_URL } from '../../shared/conversation/macosPrivacyFolders'

export type SafeExternalUrl = { ok: true; url: string } | { ok: false; message: string }

// Terminal output is untrusted: only hand http/https to the OS so that schemes
// like file:, vscode:, or custom protocol handlers cannot be triggered by
// clicking text a process happened to print into the terminal.
export function safeExternalUrl(url: unknown): SafeExternalUrl {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, message: 'No link to open.' }
  }
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return { ok: false, message: `Not a valid link: ${url}` }
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, message: `Cannot open ${protocol} links from the terminal.` }
  }
  return { ok: true, url }
}

/**
 * What a window may ask the OS to open: a web link, or on macOS exactly one
 * other address, System Settings on Privacy & Security › Files and Folders,
 * which a chat that macOS kept out of its folder offers to open. That one is
 * matched whole, so no other settings pane, and no other scheme, gets through.
 */
export function safeWindowExternalUrl(url: unknown, platform: NodeJS.Platform = process.platform): SafeExternalUrl {
  if (platform === 'darwin' && url === MACOS_FILES_AND_FOLDERS_SETTINGS_URL) return { ok: true, url }
  return safeExternalUrl(url)
}
