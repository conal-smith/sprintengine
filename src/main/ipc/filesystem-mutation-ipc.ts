import { shell } from 'electron'
import type { IpcMain } from 'electron'
import { cp, mkdir, rename, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { writeAttachmentImageFile, writeViewedImageFile } from '../attachment-image-file'
import type { AttachmentImageInput } from '../attachment-image-file'
import { resolveEditorSaveTarget } from '../editor-save-target'

type FilesystemMutationIpcDependencies = {
  getUniqueCopyPath(destinationDir: string, sourceName: string, sourcePath: string): Promise<string>
  pathExists(targetPath: string): Promise<boolean>
  trashItem(targetPath: string): Promise<void>
}

// One name, never a path: what a rename, a new file or a new folder is called
// stays in the folder it was made in.
function normalizeRenamedFileSystemEntryName(rawName: string): string {
  if (/[. ]$/u.test(rawName)) {
    throw new Error('File and folder names cannot end with a period or space.')
  }
  const name = rawName.trim()
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new Error('Enter a valid file or folder name.')
  }
  if (/[\u0000-\u001f<>:"|?*]/u.test(name)) {
    throw new Error('File and folder names cannot contain control characters or <>:"|?*.')
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) {
    throw new Error('That file or folder name is reserved by Windows.')
  }
  return name
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const child = resolve(childPath)
  const parent = resolve(parentPath)
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function registerFilesystemMutationIpc(ipcMain: IpcMain, deps: FilesystemMutationIpcDependencies): void {
  // `roots` are the folders of the project the file was opened in; a save
  // there does not write through a link that leads out of them.
  ipcMain.handle(
    'fs:writefile',
    async (_, filePath: string, content: string, options?: { roots?: unknown }): Promise<void> => {
      const roots = Array.isArray(options?.roots) ? options.roots : []
      await writeFile(await resolveEditorSaveTarget(filePath, roots), content, 'utf-8')
    },
  )

  ipcMain.handle('fs:save-dropped-image', async (_, input: AttachmentImageInput): Promise<string> => {
    return writeAttachmentImageFile(input, 'pasted')
  })

  // An image attached to a conversation turn lives as base64 in the renderer and
  // has no path to hand anyone, so opening it means writing it out first. The
  // bytes never leave the app's own temp folder, and the operating system picks
  // the viewer — the app owes the person their own image viewer here, not a
  // second-rate one of its own.
  ipcMain.handle('fs:open-image-attachment', async (_, input: AttachmentImageInput): Promise<void> => {
    const filePath = await writeViewedImageFile(input, 'image')
    // `openPath` reports failure by resolving with the message, not by throwing:
    // a non-empty string is the error the caller must see.
    const failure = await shell.openPath(filePath)
    if (failure) throw new Error(failure)
  })

  ipcMain.handle('fs:create-file', async (_, parentDir: string, name: string): Promise<string> => {
    const filePath = join(parentDir, normalizeRenamedFileSystemEntryName(name))
    await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
    return filePath
  })

  ipcMain.handle('fs:create-dir', async (_, parentDir: string, name: string): Promise<string> => {
    const dirPath = join(parentDir, normalizeRenamedFileSystemEntryName(name))
    await mkdir(dirPath)
    return dirPath
  })

  ipcMain.handle('fs:ensure-dir', async (_, parentDir: string, name: string): Promise<string> => {
    const dirPath = join(parentDir, normalizeRenamedFileSystemEntryName(name))
    await mkdir(dirPath, { recursive: true })
    return dirPath
  })

  ipcMain.handle('fs:rename', async (_, sourcePath: string, nextName: string): Promise<string> => {
    const normalizedName = normalizeRenamedFileSystemEntryName(nextName)

    const targetPath = join(dirname(sourcePath), normalizedName)
    if (targetPath === sourcePath) return targetPath

    if (await deps.pathExists(targetPath)) {
      throw new Error(`A file or folder named "${normalizedName}" already exists.`)
    }

    await rename(sourcePath, targetPath)
    return targetPath
  })

  ipcMain.handle('fs:copy', async (_, sourcePath: string, destinationDir: string): Promise<string> => {
    const sourceName = basename(sourcePath)
    const destinationPath = await deps.getUniqueCopyPath(destinationDir, sourceName, sourcePath)

    await cp(sourcePath, destinationPath, {
      errorOnExist: true,
      force: false,
      recursive: true,
    })

    return destinationPath
  })

  ipcMain.handle(
    'fs:copy-into',
    async (_, sourcePath: string, destinationDir: string, options?: { overwrite?: boolean }): Promise<string> => {
      const destinationPath = join(destinationDir, basename(sourcePath))
      const overwrite = options?.overwrite === true

      if (!overwrite && (await deps.pathExists(destinationPath))) {
        throw new Error(`A file or folder named "${basename(sourcePath)}" already exists.`)
      }

      await cp(sourcePath, destinationPath, {
        errorOnExist: !overwrite,
        force: overwrite,
        recursive: true,
      })

      return destinationPath
    },
  )

  ipcMain.handle('fs:move', async (_, sourcePath: string, destinationDir: string): Promise<string> => {
    if (isPathInsideOrEqual(destinationDir, sourcePath)) {
      throw new Error('Cannot move a file or folder into itself.')
    }

    const sourceName = basename(sourcePath)
    const destinationPath = join(destinationDir, sourceName)
    if (destinationPath === sourcePath) return sourcePath

    if (await deps.pathExists(destinationPath)) {
      throw new Error(`A file or folder named "${sourceName}" already exists.`)
    }

    await rename(sourcePath, destinationPath)
    return destinationPath
  })

  ipcMain.handle('fs:delete', async (_, targetPath: string): Promise<void> => {
    await deps.trashItem(targetPath)
  })
}
