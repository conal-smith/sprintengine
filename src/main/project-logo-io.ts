import { nativeImage } from 'electron'
import { readFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import type { ProjectLogoIo } from './project-logo'
import { imageWithinDecodeLimits } from '../shared/image-dimensions'

// The real filesystem/raster side of project-logo detection. Kept apart from
// `project-logo.ts` so that module's ranking, size guard, and SVG sanitizer
// stay unit-testable without a disk or an Electron runtime.
export function createProjectLogoIo(): ProjectLogoIo {
  return {
    async readdir(dirPath: string): Promise<string[]> {
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name)
    },
    async stat(filePath: string) {
      const stats = await stat(filePath)
      return { isFile: stats.isFile(), size: stats.size, mtimeMs: stats.mtimeMs }
    },
    readFile,
    async downscaleRaster(bytes: Buffer, mimeType: string, maxPx: number) {
      // nativeImage decodes PNG and JPEG; a `.ico` (or anything it cannot read)
      // comes back empty and is served at its original bytes, which the 1 MB
      // guard has already bounded.
      if (!imageWithinDecodeLimits(bytes)) throw new Error('That picture is too large to decode.')
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) return { bytes, mimeType }

      const { width, height } = image.getSize()
      if (width <= maxPx && height <= maxPx) return { bytes, mimeType }

      // Constrain the longest edge only, so the aspect ratio survives — a wide
      // wordmark must not be squashed into the square slot.
      const resized =
        width >= height
          ? image.resize({ width: maxPx, quality: 'best' })
          : image.resize({ height: maxPx, quality: 'best' })
      return { bytes: resized.toPNG(), mimeType: 'image/png' }
    },
    join,
  }
}
