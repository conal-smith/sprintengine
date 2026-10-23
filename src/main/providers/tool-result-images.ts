import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { studioPlatform } from '../../server/platform/platform'
import type { ConversationKey } from '../../shared/conversation-runtime'
import { CONVERSATION_TOOL_IMAGES_DIRECTORY, ConversationAttachmentStore } from '../conversation-attachment-store'

// The pictures a step returns, a browser screenshot most often: written to
// disk under the app's data folder, in a folder of the conversation's own
// (`conversation-images/<conversation>/`), and named on the step's
// `tool_output` as `images`, so the chat shows them rather than a size or a
// wall of base64. The folder is named from the conversation's identity, as
// sent pictures' are (`ConversationAttachmentStore.folderFor`), so deleting
// the conversation finds it and takes it too (`deleteConversation` there).
//
// What is kept is bounded the way an attachment is: four formats every
// preview can draw, a few per step, and a total a step may write. A step past
// either keeps the first that fit, and its output text ends with a line
// saying how many more there were (`toolImagesNotShown`); the model still saw
// them all, and the output text still says what the tool said.

/** The formats a step's picture is kept in, by the media type the tool names. */
const EXTENSION_OF: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** The most pictures one step keeps. */
export const MAX_TOOL_RESULT_IMAGES = 8
/** The most bytes one step's pictures may take on disk, all together. */
export const MAX_TOOL_RESULT_IMAGE_BYTES = 10 * 1024 * 1024

export type ToolResultImage = { mediaType: string; base64: string }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** A base64 string's decoded size, without decoding it. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/**
 * The pictures in a step's result content, in order, within the bounds above.
 * Reads both shapes a result arrives in: a Claude content block
 * (`{ type: 'image', source: { type: 'base64', media_type, data } }`) and an
 * MCP content item (`{ type: 'image', data, mimeType }`, as Codex relays a
 * server's result). Anything else, a picture by URL among them, is not one.
 */
export function toolResultImages(content: unknown): ToolResultImage[] {
  if (!Array.isArray(content)) return []
  const images: ToolResultImage[] = []
  let bytes = 0
  for (const entry of content) {
    const block = record(entry)
    if (block?.type !== 'image') continue
    const source = record(block.source)
    const mediaType = source ? source.media_type : block.mimeType
    const data = source ? (source.type === 'base64' ? source.data : undefined) : block.data
    if (typeof mediaType !== 'string' || !EXTENSION_OF[mediaType] || typeof data !== 'string' || !data) continue
    const size = decodedBytes(data)
    if (images.length >= MAX_TOOL_RESULT_IMAGES || bytes + size > MAX_TOOL_RESULT_IMAGE_BYTES) break
    bytes += size
    images.push({ mediaType, base64: data })
  }
  return images
}

/**
 * The line a step's output ends with when it returned pictures that are not
 * shown: past the eight kept, past the byte bound, or in a format that is not
 * kept. `content` is what `toolResultImages` read, `kept` how many it kept.
 * Empty when every picture is shown, and when none is: a step then draws no
 * pictures at all, and its output is what it always was.
 */
export function toolImagesNotShown(content: unknown, kept: number): string {
  if (!Array.isArray(content) || kept === 0) return ''
  const hidden = content.filter((entry) => record(entry)?.type === 'image').length - kept
  return hidden > 0 ? `[${hidden} more ${hidden === 1 ? 'image' : 'images'} not shown]` : ''
}

/**
 * Where a step's pictures will be, and the write that puts them there. The
 * paths are known at once; `written` settles once every file is on disk (or
 * has failed to be), and the step's `tool_output` waits for it, so a chat
 * that asks for a picture never finds its file missing.
 */
export type ToolImageWrite = { paths: string[]; written: Promise<void> }

export type SaveToolResultImages = (input: {
  key: ConversationKey
  toolUseId: string
  images: readonly ToolResultImage[]
}) => ToolImageWrite

/** A step id as a file name: word characters and dashes, so never `.`, `..` or a separator. */
function fileStem(toolUseId: string): string {
  const stem = toolUseId.replace(/[^\w-]/g, '_')
  return stem || 'step'
}

/** The folder a conversation's step pictures are kept in, under `dataDir`. */
export function toolImageFolder(dataDir: string, key: ConversationKey): string {
  return join(dataDir, CONVERSATION_TOOL_IMAGES_DIRECTORY, ConversationAttachmentStore.folderFor(key))
}

/**
 * Write a step's pictures under `dataDir`, as `<step>-<n>.<ext>` in the
 * conversation's folder. A path that would leave that folder is not written,
 * and a picture that cannot be written is left out of the paths answered.
 */
export function saveToolResultImagesUnder(dataDir: string): SaveToolResultImages {
  return ({ key, toolUseId, images }) => {
    const folder = toolImageFolder(dataDir, key)
    const within = resolve(folder) + sep
    const files = images
      .map((image, index) => ({
        image,
        path: join(folder, `${fileStem(toolUseId)}-${index + 1}.${EXTENSION_OF[image.mediaType] ?? 'png'}`),
      }))
      .filter((file) => resolve(file.path).startsWith(within))
    const paths = files.map((file) => file.path)
    const written = (async () => {
      try {
        await mkdir(folder, { recursive: true })
      } catch {
        paths.length = 0
        return
      }
      const failed = new Set<string>()
      await Promise.all(
        files.map(({ image, path }) =>
          writeFile(path, Buffer.from(image.base64, 'base64')).catch(() => {
            failed.add(path)
          }),
        ),
      )
      // Answered paths are the ones on disk: a failed write is left out.
      for (let index = paths.length - 1; index >= 0; index--) if (failed.has(paths[index]!)) paths.splice(index, 1)
    })()
    return { paths, written }
  }
}

/** The app's own: under its data folder. */
export const saveToolResultImages: SaveToolResultImages = (input) =>
  saveToolResultImagesUnder(studioPlatform().paths.dataDir())(input)
