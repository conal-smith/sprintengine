import type { SafeStorage } from 'electron'

/**
 * Whether `safeStorage` really protects what it seals. On Linux with no
 * keyring Electron can fall back to its `basic_text` backend, which seals with
 * a key built into Chromium: anyone who can read the profile can open it. That
 * counts as no encryption at all, so every store keeps its secrets in memory
 * for the session, as it does when encryption is missing, and the settings say
 * so.
 */
export function safeStorageProtects(
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable'> & Partial<Pick<SafeStorage, 'getSelectedStorageBackend'>>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (platform !== 'linux') return true
  return safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
}
