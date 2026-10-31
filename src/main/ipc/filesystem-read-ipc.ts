import type { IpcMain } from 'electron'
import type { FileSystemStat, ProjectLogo, WorkspaceFolderCheckResult } from '../../shared/electron-api'

type FileSystemDirectoryEntry = {
  name: string
  isDir: boolean
}

type FilesystemReadIpcDependencies = {
  readDirectory(dirPath: string): Promise<FileSystemDirectoryEntry[]>
  readTextFile(filePath: string): Promise<string>
  readImageDataUrl(filePath: string): Promise<string>
  pathExists(targetPath: string): Promise<boolean>
  statPath(targetPath: string): Promise<FileSystemStat>
  checkWorkspaceFolder(targetPath: string): Promise<WorkspaceFolderCheckResult>
  detectProjectLogo(folderPath: string): Promise<ProjectLogo | null>
  readProjectIconFile(filePath: string): Promise<ProjectLogo | null>
  showItemInFolder(targetPath: string): Promise<void>
  openHtmlFileInBrowser(targetPath: string): Promise<void>
}

export function registerFilesystemReadIpc(ipcMain: IpcMain, deps: FilesystemReadIpcDependencies): void {
  ipcMain.handle('fs:readdir', async (_, dirPath: string): Promise<FileSystemDirectoryEntry[]> => {
    return deps.readDirectory(dirPath)
  })

  ipcMain.handle('fs:readfile', async (_, filePath: string): Promise<string> => {
    return deps.readTextFile(filePath)
  })

  ipcMain.handle('fs:read-image-data-url', async (_, filePath: string): Promise<string> => {
    return deps.readImageDataUrl(filePath)
  })

  ipcMain.handle('fs:path-exists', async (_, targetPath: string): Promise<boolean> => {
    return deps.pathExists(targetPath)
  })

  ipcMain.handle('fs:stat', async (_, targetPath: string): Promise<FileSystemStat> => {
    return deps.statPath(targetPath)
  })

  ipcMain.handle('fs:check-workspace-folder', async (_, targetPath: string): Promise<WorkspaceFolderCheckResult> => {
    return deps.checkWorkspaceFolder(targetPath)
  })

  ipcMain.handle('fs:detect-project-logo', async (_, folderPath: string): Promise<ProjectLogo | null> => {
    return deps.detectProjectLogo(folderPath)
  })

  ipcMain.handle('fs:read-project-icon', async (_, filePath: string): Promise<ProjectLogo | null> => {
    return deps.readProjectIconFile(filePath)
  })

  ipcMain.handle('fs:show-item-in-folder', async (_, targetPath: string): Promise<void> => {
    await deps.showItemInFolder(targetPath)
  })

  ipcMain.handle('fs:open-html-file-in-browser', async (_, targetPath: string): Promise<void> => {
    await deps.openHtmlFileInBrowser(targetPath)
  })
}
