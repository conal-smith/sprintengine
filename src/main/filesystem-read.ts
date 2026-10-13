import { access, readdir, readFile, stat } from 'fs/promises'
import { extname } from 'path'
import { pathToFileURL } from 'url'
import { imageMimeType } from './filesystem-image'
import { MAX_IMAGE_DATA_URL_BYTES, MAX_TEXT_FILE_READ_BYTES } from './filesystem-read-limits'
import { checkWorkspaceFolder, pathExists } from './filesystem-workspace'
import { expandHomePath } from './home-path'
import { createProjectLogoResolver, type ProjectLogoIo } from './project-logo'

const BINARY_SNIFF_BYTES = 4096
const MAX_CONTROL_CHARACTER_RATIO = 0.05

export { MAX_IMAGE_DATA_URL_BYTES, MAX_TEXT_FILE_READ_BYTES }

/**
 * What the reads that hand a file to the OS need: the shell's file manager and
 * browser. Electron's `shell` in main; absent in the Studio server, which reads
 * files for the chat view and opens nothing on a screen.
 */
export type FileOpener = {
  showItemInFolder(path: string): void
  openExternal(url: string): Promise<void>
}

export function createFilesystemReadHandlers(options: { opener?: FileOpener; projectLogoIo?: ProjectLogoIo } = {}) {
  const { opener } = options
  const os = (): FileOpener => {
    if (!opener) throw new Error('Opening a file on screen is the desktop window’s, not the Studio server’s.')
    return opener
  }
  // One resolver per handler set, so the hit cache outlives a single project
  // open and a re-open costs a stat instead of a directory scan.
  // The logo is decoded with the shell's image codec, so only the shell resolves it.
  const projectLogos = options.projectLogoIo ? createProjectLogoResolver(options.projectLogoIo) : null

  return {
    detectProjectLogo(folderPath: string) {
      return projectLogos ? projectLogos.resolve(folderPath) : Promise.resolve(null)
    },
    async readDirectory(dirPath: string) {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
    },
    async readTextFile(filePath: string) {
      const targetStats = await stat(filePath)
      if (!targetStats.isFile()) {
        throw new Error('Only files can be read.')
      }
      if (targetStats.size > MAX_TEXT_FILE_READ_BYTES) {
        throw new Error(
          `File is too large to open in SprintEngine (${formatBytes(targetStats.size)}; limit ${formatBytes(MAX_TEXT_FILE_READ_BYTES)}).`,
        )
      }

      const content = await readFile(filePath)
      if (looksLikeBinary(content)) {
        throw new Error('File appears to be binary and cannot be opened as text.')
      }

      return content.toString('utf-8')
    },
    async readImageDataUrl(requested: string) {
      const filePath = expandHomePath(requested)
      const mimeType = imageMimeType(filePath)
      if (!mimeType) throw new Error('Unsupported image file type.')
      const targetStats = await stat(filePath)
      if (!targetStats.isFile()) {
        throw new Error('Only files can be read.')
      }
      if (targetStats.size > MAX_IMAGE_DATA_URL_BYTES) {
        throw new Error(
          `Image is too large to preview in SprintEngine (${formatBytes(targetStats.size)}; limit ${formatBytes(MAX_IMAGE_DATA_URL_BYTES)}).`,
        )
      }
      const content = await readFile(filePath)
      return `data:${mimeType};base64,${content.toString('base64')}`
    },
    async statPath(targetPath: string) {
      const targetStats = await stat(expandHomePath(targetPath))
      return {
        isFile: targetStats.isFile(),
        isDirectory: targetStats.isDirectory(),
        sizeBytes: targetStats.size,
        modifiedAt: targetStats.mtime.toISOString(),
        modifiedAtMs: targetStats.mtimeMs,
      }
    },
    pathExists,
    checkWorkspaceFolder,
    async showItemInFolder(targetPath: string) {
      await access(targetPath)
      os().showItemInFolder(targetPath)
    },
    async openHtmlFileInBrowser(targetPath: string) {
      const extension = extname(targetPath).toLowerCase()
      if (extension !== '.html' && extension !== '.htm') {
        throw new Error('Only HTML files can be opened in the browser.')
      }

      const targetStats = await stat(targetPath)
      if (!targetStats.isFile()) {
        throw new Error('Only files can be opened in the browser.')
      }

      await os().openExternal(pathToFileURL(targetPath).toString())
    },
  }
}

export function looksLikeBinary(content: Buffer): boolean {
  if (content.length === 0) return false
  const sample = content.subarray(0, Math.min(content.length, BINARY_SNIFF_BYTES))
  let controlCharacters = 0

  for (const byte of sample) {
    if (byte === 0) return true
    const isAllowedControl = byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x1b
    if (byte < 0x20 && !isAllowedControl) controlCharacters += 1
  }

  return controlCharacters / sample.length > MAX_CONTROL_CHARACTER_RATIO
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}
