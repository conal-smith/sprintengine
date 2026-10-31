import { stat } from 'node:fs/promises'
import { BrowserWindow, Menu, app, dialog, type IpcMain } from 'electron'

import { ensureDefaultUserSkillsDir } from '../skills/user-skills-dir'

export const TEST_OPEN_DIR_ENV = 'SPRINTENGINE_TEST_OPEN_DIR'

export type TestOpenDirOverrideOptions = {
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
  statPath?: typeof stat
}

export async function resolveTestOpenDirOverride({
  isPackaged,
  env = process.env,
  statPath = stat,
}: TestOpenDirOverrideOptions): Promise<string | null> {
  const overridePath = env[TEST_OPEN_DIR_ENV]
  if (!overridePath || isPackaged) return null

  const target = await statPath(overridePath).catch(() => null)
  if (!target?.isDirectory()) {
    throw new Error(`${TEST_OPEN_DIR_ENV} must point to an existing directory: ${overridePath}`)
  }

  return overridePath
}

export function registerMenuDialogIpc(ipcMain: IpcMain): void {
  ipcMain.handle('fs:dialog:opendir', async (event, options?: { defaultPath?: string }) => {
    const testOverride = await resolveTestOpenDirOverride({ isPackaged: app.isPackaged })
    if (testOverride) return testOverride

    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: process.platform === 'darwin' ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
      title: 'Open Folder',
      ...(typeof options?.defaultPath === 'string' && options.defaultPath.trim()
        ? { defaultPath: options.defaultPath }
        : {}),
    })
    return result.filePaths[0] ?? null
  })

  // A project's own icon: one image file, by the kinds the icon slot can show.
  ipcMain.handle('fs:dialog:open-project-icon', async (event, options?: { defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      title: 'Choose Project Icon',
      filters: [{ name: 'Images', extensions: ['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns'] }],
      ...(typeof options?.defaultPath === 'string' && options.defaultPath.trim()
        ? { defaultPath: options.defaultPath }
        : {}),
    })
    return result.filePaths[0] ?? null
  })

  ipcMain.handle('skills:ensure-default-user-dir', (): string => ensureDefaultUserSkillsDir())

  // Cold-start default location for a brand-new workspace folder, used only
  // when the renderer has no selected/recent folder to derive a parent from.
  // The user's Documents directory is a predictable, cross-platform home for
  // projects; falling back to the home dir if Documents is unavailable.
  ipcMain.handle('app:default-workspace-parent', async (): Promise<string | null> => {
    try {
      return app.getPath('documents')
    } catch {
      try {
        return app.getPath('home')
      } catch {
        return null
      }
    }
  })

  ipcMain.handle('app:show-menubar-menu', async (event, menuLabel: string, position?: { x?: number; y?: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const appMenu = Menu.getApplicationMenu()
    if (!win || !appMenu) return false

    const topLevelItem = appMenu.items.find((item) => item.label === menuLabel)
    if (!topLevelItem?.submenu) return false

    topLevelItem.submenu.popup({
      window: win,
      x: typeof position?.x === 'number' ? Math.round(position.x) : undefined,
      y: typeof position?.y === 'number' ? Math.round(position.y) : undefined,
    })

    return true
  })
}
