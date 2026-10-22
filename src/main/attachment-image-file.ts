import { chmod, lstat, mkdir, mkdtemp, writeFile } from 'fs/promises'
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
  return `${stem || fallbackStem}.${extension}`
}

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
  const mediaType = typeof input?.mediaType === 'string' ? input.mediaType : ''
  const extension = ATTACHMENT_IMAGE_EXTENSIONS[mediaType]
  if (!extension) throw new Error('Only PNG, JPEG, WebP, and GIF images can be attached.')
  if (typeof input.dataBase64 !== 'string') throw new Error('That image could not be read.')
  const bytes = Buffer.from(input.dataBase64, 'base64')
  if (bytes.length === 0) throw new Error('That image could not be read.')
  if (bytes.length > MAX_ATTACHMENT_IMAGE_BYTES) throw new Error('That image is too large to attach.')

  // A fresh folder of this user's own (`mkdtemp` makes it 0700), and the
  // file readable by this user only.
  const directory = await mkdtemp(join(await privateImagesRoot(), 'image-'))
  const filePath = join(directory, safeImageFileName(input.name, fallbackStem, extension))
  await writeFile(filePath, bytes, { flag: 'wx', mode: 0o600 })
  return filePath
}
