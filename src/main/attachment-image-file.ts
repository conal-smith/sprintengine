import { createHash } from 'crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { tmpdir } from 'os'

// Where an image that exists only as bytes becomes a file on disk. Two callers
// want the same thing: the composer, which attaches a pasted or dropped image
// by path so an agent can read it, and "open this image", which hands the file
// to the operating system's own viewer. One writer, so both wear the same
// extension map, the same ceiling, and the same collision-free naming.

// The same image set the conversation composer stages
// (shared/conversation-attachments.ts), keyed to the extension the saved file
// wears — agents and previewers alike read the type off the name. The
// conversation attachment store names its files from the same map.
export const ATTACHMENT_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

// Not a vision-model budget — the file goes to disk and is read by path. This
// only bounds a runaway IPC payload; a real screenshot is far under it.
const MAX_ATTACHMENT_IMAGE_BYTES = 32 * 1024 * 1024

// Long enough for a screenshot's own name, short enough that no filesystem
// refuses it once the extension is on the end.
const MAX_BASE_NAME_LENGTH = 80

export type AttachmentImageInput = {
  mediaType?: unknown
  dataBase64?: unknown
  // The name the image carried when it was attached, kept so the OS viewer's
  // title bar says "Screenshot 2026-09-07.png" and not a random tail. Absent
  // for a clipboard paste, which never had one.
  name?: unknown
}

// The name is renderer-supplied, so it is a suggestion and never a path: only
// the basename survives, separators and control characters are dropped, and a
// leading dot cannot make the file hidden. What is left, if empty, falls back
// to `fallbackStem`.
export function safeImageFileName(rawName: unknown, fallbackStem: string, extension: string): string {
  const suggested = typeof rawName === 'string' ? basename(rawName) : ''
  const stem = suggested
    .slice(0, suggested.length - extname(suggested).length)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[.\s]+|[.\s]+$/gu, '')
    .slice(0, MAX_BASE_NAME_LENGTH)
    .trim()
  // Windows keeps device names for itself, whatever follows the first dot:
  // `CON.png` and `nul.tar.png` cannot be created there.
  const usable = WINDOWS_DEVICE_NAME.test(stem) ? `_${stem}` : stem
  return `${usable || fallbackStem}.${extension}`
}

/** A stem Windows reads as a device: CON, PRN, AUX, NUL, COM1–9, LPT1–9 (and the superscript digits), alone or before a dot. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\s*\..*)?$/iu

/**
 * The folder images that exist only as bytes are written under. Linux's temp
 * folder is shared by every user, so there it is one of this user's own,
 * named for them; macOS and Windows already give each user a temp folder.
 */
export function attachmentImagesRoot(platform: NodeJS.Platform = process.platform): string {
  const uid = process.getuid?.()
  return platform === 'linux' && uid !== undefined
    ? join(tmpdir(), `sprintengine-images-${uid}`)
    : join(tmpdir(), 'sprintengine-images')
}

// Only this user may list or write into the folder. One someone else made
// first, or a link standing in its place, is not used.
async function privateImagesRoot(): Promise<string> {
  const root = attachmentImagesRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') return root
  const info = await lstat(root)
  const uid = process.getuid?.()
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid))
    throw new Error('Studio’s folder for images is not this user’s own, so the image was not saved.')
  if ((info.mode & 0o077) !== 0) await chmod(root, 0o700)
  return root
}

// Each write gets its own directory rather than a unique file name, so the file
// itself can keep the name the person knows it by: two saves in the same
// instant are two directories, never one silently overwriting the other.
export async function writeAttachmentImageFile(input: AttachmentImageInput, fallbackStem: string): Promise<string> {
  const { bytes, extension } = imageBytesOf(input)
  // A fresh folder of this user's own (`mkdtemp` makes it 0700), and the
  // file readable by this user only.
  const directory = await mkdtemp(join(await privateImagesRoot(), 'image-'))
  const filePath = join(directory, safeImageFileName(input.name, fallbackStem, extension))
  await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 })
  return filePath
}

function imageBytesOf(input: AttachmentImageInput): { bytes: Buffer; extension: string } {
  const mediaType = typeof input?.mediaType === 'string' ? input.mediaType : ''
  const extension = ATTACHMENT_IMAGE_EXTENSIONS[mediaType]
  if (!extension) throw new Error('Only PNG, JPEG, WebP, and GIF images can be attached.')
  if (typeof input.dataBase64 !== 'string') throw new Error('That image could not be read.')
  const bytes = Buffer.from(input.dataBase64, 'base64')
  if (bytes.length === 0) throw new Error('That image could not be read.')
  if (bytes.length > MAX_ATTACHMENT_IMAGE_BYTES) throw new Error('That image is too large to attach.')
  return { bytes, extension }
}

/** A copy written for the system's viewer is kept this long after it was last opened. */
export const VIEWED_IMAGE_KEEP_MS = 24 * 60 * 60 * 1000
const VIEWED_FOLDER = /^view-[0-9a-f]{32}$/u

/**
 * An image opened in the system's viewer, as a file. Nothing but that viewer
 * reads it, so it is named by its bytes: opening the same picture again opens
 * the same file rather than writing another, and one not opened for a day is
 * removed the next time any is. The composer's copies (above) are left alone:
 * a prompt names them.
 */
export async function writeViewedImageFile(
  input: AttachmentImageInput,
  fallbackStem: string,
  now: () => number = Date.now,
): Promise<string> {
  const { bytes, extension } = imageBytesOf(input)
  const root = await privateImagesRoot()
  await pruneViewedImages(root, now())
  const directory = join(root, `view-${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const filePath = join(directory, safeImageFileName(input.name, fallbackStem, extension))
  try {
    await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    // The same bytes under the same name: the file is already the one wanted.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const info = await lstat(filePath)
    if (!info.isFile() || info.size !== bytes.length) throw error
  }
  const at = new Date(now())
  await utimes(directory, at, at)
  return filePath
}

async function pruneViewedImages(root: string, at: number): Promise<void> {
  const folders = await readdir(root).catch(() => [] as string[])
  for (const folder of folders) {
    if (!VIEWED_FOLDER.test(folder)) continue
    const path = join(root, folder)
    try {
      if (at - (await stat(path)).mtimeMs > VIEWED_IMAGE_KEEP_MS) await rm(path, { recursive: true, force: true })
    } catch {
      // Gone already.
    }
  }
}
