import type { App, BrowserWindow, Notification, NotificationConstructorOptions, SafeStorage } from 'electron'

import type { StudioPlatform } from '../../server/platform/platform'
import { safeStorageProtects } from './safe-storage-protects'

// The platform while the server's code still runs inside Electron main. Each
// member does exactly what the code it replaced did, read at call time: the
// paths are `app.getPath` and friends (asked when wanted, so the dev profile
// `configureDevUserData` moves to is the one every store sees), the cipher is
// `safeStorage` byte for byte (so everything sealed before still opens), a
// broadcast is the all-windows loop, and a notice is an OS notification.
//
// Electron is handed in rather than imported, so the entry decides when it is
// touched and a test can build the platform over a stand-in. Each member is
// looked up only when it is used, so a stand-in needs only what its suite uses.

export type ElectronPlatformDeps = {
  app: Pick<App, 'getPath' | 'getAppPath' | 'getVersion' | 'isPackaged'>
  safeStorage: Pick<SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'> &
    Partial<Pick<SafeStorage, 'getSelectedStorageBackend'>>
  /** The OS the backend is judged for; this process's own unless a test says otherwise. */
  platform?: NodeJS.Platform
  BrowserWindow: { getAllWindows(): Array<Pick<BrowserWindow, 'isDestroyed' | 'webContents'>> }
  Notification: {
    isSupported(): boolean
    new (options: NotificationConstructorOptions): Pick<Notification, 'on' | 'close' | 'show'>
  }
  /** `process.resourcesPath`, where electron-builder's extraResources land. */
  resourcesPath?: () => string | undefined
  /** Whether a window's contents is a workspace window, for the `workspace-windows` target. Absent: every window is. */
  isWorkspaceWindow?: (webContents: BrowserWindow['webContents']) => boolean
}

export function createElectronPlatform(deps: ElectronPlatformDeps): StudioPlatform {
  // A later notice with the same key replaces the banner rather than stacking
  // under it.
  const shown = new Map<string, Pick<Notification, 'on' | 'close' | 'show'>>()
  return {
    paths: {
      dataDir: () => deps.app.getPath('userData'),
      logsDir: () => deps.app.getPath('logs'),
      isPackaged: () => deps.app.isPackaged,
      resourcesDir: () => (deps.resourcesPath ? deps.resourcesPath() : process.resourcesPath) ?? null,
      appRoot: () => deps.app.getAppPath(),
    },
    secrets: {
      available: () => safeStorageProtects(deps.safeStorage, deps.platform),
      seal: (plaintext) => deps.safeStorage.encryptString(plaintext),
      open: (sealed) => deps.safeStorage.decryptString(sealed),
    },
    clients: {
      // A window's client id in process is its contents' id, as the tunnel's
      // stand-in sender numbers them out of process.
      publish(topic, payload, target = 'all') {
        for (const window of deps.BrowserWindow.getAllWindows()) {
          if (window.isDestroyed() || window.webContents.isDestroyed()) continue
          const id = String(window.webContents.id)
          if (target === 'workspace-windows' && deps.isWorkspaceWindow && !deps.isWorkspaceWindow(window.webContents))
            continue
          if (typeof target === 'object' && 'clientId' in target && target.clientId !== id) continue
          if (typeof target === 'object' && 'exceptClientId' in target && target.exceptClientId === id) continue
          try {
            window.webContents.send(topic, payload)
          } catch {
            // Best-effort per window.
          }
        }
      },
    },
    notifier: {
      notify(notice) {
        if (!deps.Notification.isSupported()) return
        shown.get(notice.key)?.close()
        // Windows drops a click on a toast once it has timed out into
        // Notification Center, so a notice that opens something stays on
        // screen there until it is clicked or dismissed.
        const holdsForClick = Boolean(notice.onActivate) && (deps.platform ?? process.platform) === 'win32'
        const banner = new deps.Notification({
          title: notice.title,
          body: notice.body,
          silent: notice.silent ?? false,
          ...(holdsForClick ? { timeoutType: 'never' as const } : {}),
        })
        if (notice.onActivate) banner.on('click', notice.onActivate)
        banner.on('close', () => {
          if (shown.get(notice.key) === banner) shown.delete(notice.key)
        })
        shown.set(notice.key, banner)
        banner.show()
      },
    },
    identity: {
      version: () => deps.app.getVersion(),
    },
  }
}
