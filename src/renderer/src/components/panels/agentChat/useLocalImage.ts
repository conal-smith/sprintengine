import { useEffect, useState } from 'react'
import { distroOfUncPath } from '../../../../../shared/host-paths'
import { resolveTerminalFileReferencePath } from '../../../utils/terminalFileLinks'
import { useConversationLinkContext } from './conversationLinks'
import type { ChatFileSource } from './chatServices'
import {
  useConversationTransport,
  type ConversationToolImageResult,
  type ConversationTransport,
} from './conversationTransport'

// The image formats main will hand back as a data URL (filesystem-image.ts).
const PREVIEWABLE_IMAGE = /\.(apng|avif|bmp|gif|ico|jpe?g|png|svg|webp)$/iu
export function isPreviewableImagePath(path: string): boolean {
  return PREVIEWABLE_IMAGE.test(path.trim())
}

export type LocalImage = {
  /**
   * Where the image is on this disk. Null when it cannot be here at all: the
   * conversation runs on another machine, whose paths name files over there, or
   * a relative path has no folder to resolve against.
   */
  resolved: string | null
  src?: string
  failed?: boolean
}

// Pictures read off this disk, by path and the file's size and modification
// time, so a row the virtual list re-mounts draws what it already read instead
// of reading and encoding the file again, while a file rewritten under the same
// name is read afresh. Few entries: each is a data URL, often megabytes.
const LOCAL_IMAGE_CACHE_ENTRIES = 8
const localImages = new Map<string, Promise<string>>()

async function readLocalImage(files: ChatFileSource, path: string): Promise<string> {
  const stat = await files.stat(path).catch(() => null)
  if (!stat || typeof stat.modifiedAtMs !== 'number') return files.readImage(path)
  const key = `${stat.modifiedAtMs}:${stat.sizeBytes}:${path}`
  const cached = localImages.get(key)
  if (cached) {
    localImages.delete(key)
    localImages.set(key, cached)
    return cached
  }
  const read = files.readImage(path)
  localImages.set(key, read)
  while (localImages.size > LOCAL_IMAGE_CACHE_ENTRIES) localImages.delete(localImages.keys().next().value!)
  // A failed read is not kept: the next look asks again.
  read.catch(() => {
    if (localImages.get(key) === read) localImages.delete(key)
  })
  return read
}

/** A path in the agent's home folder (`~/Desktop/shot.png`), which main expands (home-path.ts). */
export function isHomePath(path: string): boolean {
  return /^~[\\/]/u.test(path)
}

// An image path the agent wrote — a screenshot it read, a picture its reply
// shows — read from this machine's disk as a data URL. Relative paths resolve
// against the conversation's folder the way a file link in the same transcript
// does, so the picture and the link beside it always name the same file.
//
// `home` lets a picture in a reply name it in the agent's home folder, as
// `~/…`. A terminal link does not follow such a path (terminalFileLinks.ts),
// since a shell's `~` may be another machine's; a chat on this computer, not
// in a WSL distribution, ran its agent here, so its `~` is this machine's home
// folder. The path goes to main as it is, since only main knows that folder.
export function useLocalImage(path: string | null | undefined, options: { home?: boolean } = {}): LocalImage {
  const context = useConversationLinkContext()
  const transport = useConversationTransport()
  const localFiles = transport.capabilities.localFiles
  const files = transport.services.files
  const inWsl = Boolean(distroOfUncPath(context?.cwd || context?.workspaceRoot || ''))
  const resolved =
    !path || !localFiles
      ? null
      : options.home && isHomePath(path) && transport.kind === 'local' && !inWsl
        ? path
        : resolveTerminalFileReferencePath(path, { executionRoot: context?.cwd, workspaceRoot: context?.workspaceRoot })
  const [image, setImage] = useState<{ path: string; src?: string; failed?: boolean }>()
  useEffect(() => {
    if (!resolved) return
    let cancelled = false
    readLocalImage(files, resolved).then(
      (src) => {
        if (!cancelled) setImage({ path: resolved, src })
      },
      () => {
        if (!cancelled) setImage({ path: resolved, failed: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [resolved, files])
  const current = image?.path === resolved ? image : undefined
  return { resolved, src: current?.src, failed: current?.failed }
}

// A remote chat's pictures, per transport (one per followed conversation), so a
// row that scrolls away and back, or opens after showing collapsed, draws what
// was already fetched instead of asking the other machine again. A failure is
// not kept, since the picture may be there on the next look; a machine that
// does not serve pictures is, since it will not start to mid-conversation.
// Bounded by count and by the length of the data URLs held: twelve full-size
// pictures would be over a hundred megabytes in one window, and main keeps
// its own copy of each for when one is asked for again.
const TOOL_IMAGE_CACHE_ENTRIES = 12
const TOOL_IMAGE_CACHE_CHARS = 24 * 1024 * 1024
type ToolImageCache = {
  entries: Map<string, { answer: Promise<ConversationToolImageResult>; chars: number }>
  chars: number
}
const toolImageCache = new WeakMap<ConversationTransport, ToolImageCache>()

export function fetchToolImage(
  transport: ConversationTransport,
  toolImage: NonNullable<ConversationTransport['toolImage']>,
  toolUseId: string,
): Promise<ConversationToolImageResult> {
  let cache = toolImageCache.get(transport)
  if (!cache) {
    cache = { entries: new Map(), chars: 0 }
    toolImageCache.set(transport, cache)
  }
  const kept = cache.entries
  const cached = kept.get(toolUseId)
  if (cached) {
    // The most recently shown stays longest.
    kept.delete(toolUseId)
    kept.set(toolUseId, cached)
    return cached.answer
  }
  const asked = toolImage({ toolUseId }).catch((error: unknown): ConversationToolImageResult => ({
    ok: false,
    unsupported: false,
    message: error instanceof Error ? error.message : String(error),
  }))
  const entry = { answer: asked, chars: 0 }
  kept.set(toolUseId, entry)
  const evict = (): void => {
    for (const [id, older] of kept) {
      if ((kept.size <= TOOL_IMAGE_CACHE_ENTRIES && cache.chars <= TOOL_IMAGE_CACHE_CHARS) || older === entry) break
      kept.delete(id)
      cache.chars -= older.chars
    }
  }
  evict()
  void asked.then((answer) => {
    if (kept.get(toolUseId) !== entry) return
    if (!answer.ok && !answer.unsupported) {
      kept.delete(toolUseId)
      return
    }
    entry.chars = answer.ok ? answer.src.length : 0
    cache.chars += entry.chars
    evict()
  })
  return asked
}

/**
 * The picture a step made or looked at. On this machine, read off the disk as
 * `useLocalImage` does. In a chat on a paired machine, asked of that machine by
 * the step's id — never by path, which names a file over there — and `remote`
 * says so, since there is no file here to reveal. Unresolved where that
 * machine does not serve pictures: the picture is on the other machine.
 */
export function useToolImage(toolUseId: string, path: string | null | undefined): LocalImage & { remote?: boolean } {
  const local = useLocalImage(path)
  const transport = useConversationTransport()
  const remote = Boolean(path) && !transport.capabilities.localFiles && transport.toolImage !== undefined
  const [image, setImage] = useState<{ id: string; answer: ConversationToolImageResult }>()
  useEffect(() => {
    if (!remote || !transport.toolImage) return
    let cancelled = false
    void fetchToolImage(transport, transport.toolImage, toolUseId).then((answer) => {
      if (!cancelled) setImage({ id: toolUseId, answer })
    })
    return () => {
      cancelled = true
    }
  }, [remote, transport, toolUseId])
  if (!remote) return local
  const answer = image?.id === toolUseId ? image.answer : undefined
  if (answer && !answer.ok && answer.unsupported) return { resolved: null }
  return {
    resolved: path ?? null,
    src: answer?.ok ? answer.src : undefined,
    failed: answer ? !answer.ok : undefined,
    remote: true,
  }
}
