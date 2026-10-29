import { ATTACHABLE_IMAGE_TYPES } from '../../../shared/conversation-attachments'
import { isPathInside } from '../../../shared/host-paths'
import { clientSupports } from '../clientCapabilities'
import { hasFileDropData, readFileDropPayload, SPRINTENGINE_FILE_DROP_MIME } from './terminalDrop'

// DataTransfer plumbing shared by every surface that takes an image from a
// paste or a drop — the chat composer (AgentChatView) and the new-chat launch
// surface (NewAgentPanel). Extracted from AgentChatView so the lazily-loaded
// launch surface does not have to import the whole chat panel for two helpers.

/**
 * Whether a drag/drop payload carries files at all. Mid-drag the payload itself
 * is unreadable — only the item kinds are — so this is what the drop target and
 * the preventDefault gate can key off. A drag of selected text reports no files
 * and is left entirely to the textarea's native handling.
 */
export function dataTransferHasFiles(data: DataTransfer | null): boolean {
  if (!data) return false
  if (Array.from(data.types ?? []).includes('Files')) return true
  return Array.from(data.items ?? []).some((item) => item.kind === 'file')
}

/**
 * Every file in a paste or drop, whatever its type. `DataTransfer.files` is
 * empty for a screenshot pasted from the clipboard, where the image only exists
 * as an `item` — both shapes have to be read or paste silently does nothing.
 */
export function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return []
  const files: File[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  if (files.length === 0) {
    for (const file of Array.from(data.files ?? [])) files.push(file)
  }
  return files
}

/**
 * A camera's raw DNG original. Its media type is not to be trusted: the system
 * labels one `image/tiff`, `image/png` or `image/jpeg` depending on where it
 * came from, and sent as that kind of image its raw bytes fail to decode. It is
 * a file, attached by its path, whatever it is labelled.
 */
export function isDngFile(file: Pick<File, 'name' | 'type'>): boolean {
  const mediaType = file.type.split(';', 1)[0]?.trim().toLowerCase()
  return (
    file.name.toLowerCase().endsWith('.dng') ||
    mediaType === 'image/dng' ||
    mediaType === 'image/x-dng' ||
    mediaType === 'image/x-adobe-dng'
  )
}

/** Whether a file is sent as an image: an attachable type, and not a raw original wearing one. */
function isAttachableImageFile(file: File): boolean {
  return (ATTACHABLE_IMAGE_TYPES as readonly string[]).includes(file.type) && !isDngFile(file)
}

/** The image files in a paste or drop, filtered to the types agents accept. */
export function imageFilesFromDataTransfer(data: DataTransfer | null): File[] {
  return filesFromDataTransfer(data).filter(isAttachableImageFile)
}

/**
 * Whether a drag carries anything a composer can take: files from the OS, or
 * the studio's own file drag (the Files pane, the Backlog). The studio's drag
 * carries no `Files` entry, so `dataTransferHasFiles` alone refuses it.
 */
export function dataTransferHasDroppableFiles(data: DataTransfer | null): boolean {
  if (!data) return false
  return dataTransferHasFiles(data) || hasFileDropData(data)
}

export type DroppedFiles = {
  /** Paths to type into the prompt: files from the studio's own panes, and every file where files do not attach by path. */
  paths: string[]
  /** Files from the system, by path: attached as cards, sent beside the words. */
  files: string[]
  /** Images to attach as images, when the surface attaches them. */
  images: File[]
  /** Files with no path on disk (an image dragged out of a web page). */
  pathless: File[]
}

/** What a composer does with a file it is given: attach images, attach other files by path as cards. */
export type FileSorting = {
  /** The surface sends images as images. */
  attachImages: boolean
  /**
   * The surface holds files by path as cards: a chat on this computer, in a
   * desktop window. Elsewhere a file is typed as its path, as it always was.
   */
  attachByPath: boolean
}

/**
 * A drop, sorted by what a composer does with each file. A file from the
 * system with a path is attached by that path where the surface takes cards,
 * whatever its type — a spreadsheet or a folder is as much the agent's to read
 * as a source file, and the composer shows it as a card rather than a string —
 * and is typed as its path where it does not. Images attach as images instead
 * where the surface can send them. One from the studio's own panes (the Files
 * pane, the Backlog) is typed as its path, as a pasted path into the workspace
 * is: it is a reference into the project, not a file brought in from outside.
 */
export function sortDroppedFiles(data: DataTransfer, sorting: FileSorting): DroppedFiles {
  const studioDrop = Array.from(data.types ?? []).includes(SPRINTENGINE_FILE_DROP_MIME)
    ? readFileDropPayload(data)
    : null
  if (studioDrop) return { paths: studioDrop.files.map((file) => file.path), files: [], images: [], pathless: [] }
  return sortFiles(filesFromDataTransfer(data), sorting)
}

/**
 * Files picked from the system's file dialog, pasted from the clipboard, or
 * dropped, sorted the same way: images attach where the surface can send them,
 * everything else is attached by its path where the surface takes cards and
 * typed as its path where it does not, and a file with no path is uploaded
 * where the shell can. Reading the path through `attachFile` is what lets a
 * card open the file later — main opens only a path read off the person's own
 * file this way — so a path that will only be typed is read without it, and
 * main is not told about a file no card will show.
 */
export function sortFiles(files: Iterable<File>, { attachImages, attachByPath }: FileSorting): DroppedFiles {
  const sorted: DroppedFiles = { paths: [], files: [], images: [], pathless: [] }
  for (const file of files) {
    if (attachImages && isAttachableImageFile(file)) {
      sorted.images.push(file)
      continue
    }
    const path = attachByPath ? window.api.attachFile(file) : window.api.getPathForFile(file)
    if (!path) sorted.pathless.push(file)
    else if (attachByPath) sorted.files.push(path)
    else sorted.paths.push(path)
  }
  return sorted
}

/**
 * Paths for dropped files that have none on this machine. A browser sends them
 * to the server, which answers where it saved each (`file-uploads`); a shell
 * that cannot, or an upload that fails, answers the reason instead.
 */
export async function pathsForPathlessFiles(files: File[]): Promise<{ paths: string[]; message: string | null }> {
  if (files.length === 0) return { paths: [], message: null }
  if (!clientSupports('file-uploads')) return { paths: [], message: pathlessDropMessage(files) }
  try {
    return { paths: await window.api.uploadFiles(files), message: null }
  } catch (error) {
    return { paths: [], message: error instanceof Error ? error.message : pathlessDropMessage(files) }
  }
}

/** The refusal for files a drop could neither attach nor name by path. */
export function pathlessDropMessage(files: File[]): string {
  const name = files[0]?.name
  return `${name ? name : 'That file'} has no path on disk, so it cannot be added to the message.`
}

/**
 * A path as prompt text, quoted only when it needs it — the terminal drop idiom.
 * A Windows path takes double quotes, which no Windows path can contain; any
 * other takes single quotes, with an apostrophe in it spliced out as `'"'"'`
 * the way a POSIX shell spells one, so `John's Files` does not end the quote.
 */
export function quotePromptPath(path: string): string {
  if (!/[\s'"]/.test(path)) return path
  if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path)) return `"${path}"`
  return `'${path.replace(/'/g, `'"'"'`)}'`
}

/** One file's bytes as base64, with the media type the browser reports. */
export function readFileAsBase64(file: File): Promise<{ mediaType: string; dataBase64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(result)
      if (!match) {
        reject(new Error(`Could not read ${file.name || 'the image'}.`))
        return
      }
      resolve({ mediaType: match[1], dataBase64: match[2] })
    }
    reader.onerror = () => reject(new Error(`Could not read ${file.name || 'the image'}.`))
    reader.readAsDataURL(file)
  })
}

// The image extensions a pasted path is read for: the attachable types, spelled
// the ways a file name spells them.
const PASTED_IMAGE_PATH = /\.(png|jpe?g|webp|gif)$/i

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

// A `file://` URL's path, or null when the word is not one.
function fileUrlPath(word: string): string | null {
  try {
    const url = new URL(word)
    if (url.protocol !== 'file:') return null
    const path = decodeURIComponent(url.pathname)
    // `file:///C:/…` names a drive path; the leading slash is the URL's.
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
  } catch {
    return null
  }
}

/**
 * Split text into words the way a shell reads a command line: whitespace
 * separates, '…' is literal, "…" is literal but for an escaped quote or
 * backslash, and a backslash outside quotes escapes the next character. Null
 * when a quote is left open or the text ends on a lone backslash.
 */
export function splitShellWords(text: string): string[] | null {
  const words: string[] = []
  let current = ''
  let inWord = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === "'") {
      const end = text.indexOf("'", index + 1)
      if (end === -1) return null
      current += text.slice(index + 1, end)
      index = end
      inWord = true
    } else if (char === '"') {
      let closed = false
      for (index += 1; index < text.length; index += 1) {
        const inner = text[index]
        if (inner === '\\' && (text[index + 1] === '"' || text[index + 1] === '\\')) {
          current += text[index + 1]
          index += 1
        } else if (inner === '"') {
          closed = true
          break
        } else current += inner
      }
      if (!closed) return null
      inWord = true
    } else if (char === '\\') {
      if (index + 1 >= text.length) return null
      current += text[index + 1]
      index += 1
      inWord = true
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current)
      current = ''
      inWord = false
    } else {
      current += char
      inWord = true
    }
  }
  if (inWord) words.push(current)
  return words
}

/**
 * The image files a text paste names, or null when the paste is anything else.
 * A screenshot tool, a terminal and Finder all put a file's path on the
 * clipboard rather than its bytes, quoted ('…' or "…") or with its spaces
 * backslash-escaped; a paste that is only such paths means "attach these", not
 * "type these". One path pasted bare, spaces and all, counts too, as does a
 * Windows path, whose backslashes separate rather than escape.
 *
 * A path inside one of `projectRoots` stays text: the agent can open a file of
 * its own project itself, and "replace /repo/public/logo.png with…" is an
 * instruction about that file, not a picture of it. Only an image from outside
 * (a screenshot's temporary copy, Downloads, the desktop) has to travel as
 * bytes. A paste that names both kinds stays text whole, rather than being
 * split into half a sentence and an attachment.
 */
export function pastedImagePaths(text: string, projectRoots: readonly string[] = []): string[] | null {
  const paths = pastedImagePathList(text)
  if (!paths) return null
  const roots = projectRoots.filter((root) => root.trim())
  return paths.some((path) => roots.some((root) => isPathInside(path, root))) ? null : paths
}

function pastedImagePathList(text: string): string[] | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // A second path inside it means a sentence about paths, not one path.
  const bare =
    !trimmed.includes('\n') && !/\s\//.test(trimmed) && isAbsolutePath(trimmed) && PASTED_IMAGE_PATH.test(trimmed)
  if (bare && /^[A-Za-z]:\\/.test(trimmed)) return [trimmed]
  const words = splitShellWords(trimmed)
  const paths = words?.map((word) => (word.startsWith('file://') ? fileUrlPath(word) : word))
  if (
    paths &&
    paths.length > 0 &&
    paths.every((path) => path !== null && isAbsolutePath(path) && PASTED_IMAGE_PATH.test(path))
  )
    return paths as string[]
  return bare ? [trimmed] : null
}

// Why a pasted path could not be read, in words: the IPC wrapper's own
// prefix is dropped, and a file that is gone says so — the usual case, a
// screenshot's temporary copy the system has already cleared.
function pastedPathFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/ENOENT/.test(message)) return 'the file no longer exists.'
  const reason = message.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, '')
  return reason || 'it could not be read.'
}

function fileFromDataUrl(dataUrl: string, name: string): File | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new File([bytes], name, { type: match[1] })
}

/**
 * Read pasted image paths into files now. The bytes are taken at paste time
 * because the file may not outlive the paste: a macOS screenshot's thumbnail
 * copy sits in a temporary folder the system clears minutes later. All or
 * nothing — a paste that cannot be read whole is left as the text it was.
 */
export async function readPastedImagePaths(
  paths: string[],
  readDataUrl: (path: string) => Promise<string> = (path) => window.api.readImageDataUrl(path),
): Promise<{ ok: true; files: File[] } | { ok: false; message: string }> {
  const files: File[] = []
  for (const path of paths) {
    const name = path.split(/[\\/]/).pop() || 'image'
    try {
      const file = fileFromDataUrl(await readDataUrl(path), name)
      if (!file) return { ok: false, message: `Could not read ${name}.` }
      files.push(file)
    } catch (error) {
      return { ok: false, message: `Could not attach ${name}: ${pastedPathFailure(error)}` }
    }
  }
  return { ok: true, files }
}
