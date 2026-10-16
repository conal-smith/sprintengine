import type { StudioErrorCode } from './envelope.js'
import { STUDIO_BOARD_FILES_CAPABILITY } from './handshake.js'
import type { StudioScope } from './scopes.js'

// Files under a workspace's roots: read, list, write, remove and watch, by a
// root and a path relative to it, never by an absolute path. The first
// members of the file family the server keeps (it holds raw access to its
// machine; everything on a screen is a client's), and what a client needs to
// run the canvas over a Studio's board files: the canvas service runs in the
// client, the boards stay on the server's disk.
//
// Owners only in this version. A write is atomic (a temp file beside the
// target, then a rename) and conditional on what the client last read
// (`ifMatch`, the SHA-256 of the file's bytes; null to create only), and in
// this version only a board (`*.excalidraw`) may be written or removed.

/**
 * Where a path is read from: the workspace's own folder, the board store
 * Studio keeps for it, or the project's store, where Studio keeps the rest of
 * what it knows about the project (the browser's captures and recordings, chat
 * transcripts) in the person's home rather than in the project. `store` is
 * additive: a Studio that serves it says `store: true` from `files.roots`, and
 * one built before it leaves the member out and refuses the kind.
 */
export type StudioFileRoot = { kind: 'boards' | 'workspace' | 'store'; workspaceId: string }

export type StudioFileEntry = { name: string; kind: 'file' | 'directory' }

export type StudioFileStat = { kind: 'file' | 'directory'; size: number; mtimeMs: number; hash?: string }

/** A conditional write that found the file other than the client expected: its hash now, null when absent. */
export type StudioFileConflict = { ok: false; code: 'conflict'; currentHash: string | null }

export type StudioFileWritten = { ok: true; hash: string; size: number; mtimeMs: number }

/** The most bytes one file read or written may be. A large answer is chunked; a large write is uploaded first. */
export const STUDIO_MAX_FILE_BYTES = 64 * 1024 * 1024

/** The only files this version writes or removes. */
export const STUDIO_WRITABLE_FILE_EXTENSIONS = ['.excalidraw'] as const

export type StudioFilesMethodMap = {
  /** Which roots a workspace has here. `store` is absent from a Studio that does not serve it. */
  'files.roots': { params: { workspaceId: string }; result: { workspace: boolean; boards: boolean; store?: boolean } }
  /** One level of a directory. A symbolic link is listed as neither kind, and is not followed. */
  'files.list': { params: { root: StudioFileRoot; path: string }; result: { entries: StudioFileEntry[] } }
  'files.read': {
    params: { root: StudioFileRoot; path: string }
    result: { text: string; hash: string; size: number; mtimeMs: number }
  }
  /** Atomic, conditional; parents are created. `uploadId` names bytes staged with `uploads.begin { purpose: 'file' }`. */
  'files.write': {
    params: {
      root: StudioFileRoot
      path: string
      text?: string
      uploadId?: string
      ifMatch: string | null
      commandId: string
    }
    result: StudioFileWritten | StudioFileConflict
  }
  'files.remove': {
    params: { root: StudioFileRoot; path: string; ifMatch: string | null; commandId: string }
    result: { ok: true; removed: boolean } | StudioFileConflict
  }
}

export type StudioFilesMethod = keyof StudioFilesMethodMap

export type StudioFilesTopicMap = {
  /** The names in one directory that changed, debounced: `{ names: string[] }` per push. */
  'files.watch': { params: { root: StudioFileRoot; path: string } }
}

type MethodSpec = {
  scope: StudioScope
  mutation: boolean
  capability: typeof STUDIO_BOARD_FILES_CAPABILITY
  owner: true
}

const reading: MethodSpec = {
  scope: 'files:read',
  mutation: false,
  capability: STUDIO_BOARD_FILES_CAPABILITY,
  owner: true,
}
const writing: MethodSpec = {
  scope: 'files:write',
  mutation: true,
  capability: STUDIO_BOARD_FILES_CAPABILITY,
  owner: true,
}

export const STUDIO_FILES_METHODS: { readonly [M in StudioFilesMethod]: MethodSpec } = {
  'files.roots': reading,
  'files.list': reading,
  'files.read': reading,
  'files.write': writing,
  'files.remove': writing,
}

export const STUDIO_FILES_TOPICS: {
  readonly [T in keyof StudioFilesTopicMap]: {
    scope: StudioScope
    capability: typeof STUDIO_BOARD_FILES_CAPABILITY
    owner: true
    push: true
  }
} = {
  'files.watch': { scope: 'files:read', capability: STUDIO_BOARD_FILES_CAPABILITY, owner: true, push: true },
}

export function isStudioFilesMethod(value: unknown): value is StudioFilesMethod {
  return typeof value === 'string' && Object.hasOwn(STUDIO_FILES_METHODS, value)
}

// ── Validation ──────────────────────────────────────────────────────────────

type Refusal = { ok: false; code: StudioErrorCode; message: string }
const refuse = (message: string, code: StudioErrorCode = 'invalid_params'): Refusal => ({ ok: false, code, message })

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

/** A root, or null. */
export function parseStudioFileRoot(value: unknown): StudioFileRoot | null {
  if (
    !record(value) ||
    (value.kind !== 'boards' && value.kind !== 'workspace' && value.kind !== 'store') ||
    !id(value.workspaceId)
  )
    return null
  return { kind: value.kind, workspaceId: value.workspaceId }
}

/**
 * A path under a root: relative, with `/` between its parts, and nothing that
 * could leave the root by its spelling (a `..` part, a drive, a leading `/`, a
 * backslash, a NUL). The empty path is the root itself. A Studio still checks
 * that what the path names, symbolic links followed, stays inside the root.
 */
export function isStudioRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false
  if (value === '') return true
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  return value.split('/').every((part) => part !== '..' && part !== '')
}

/** Whether this version may write or remove the file a path names. */
export function isStudioWritableFile(path: string): boolean {
  const lower = path.toLowerCase()
  return STUDIO_WRITABLE_FILE_EXTENSIONS.some(
    (extension) => lower.endsWith(extension) && lower.length > extension.length,
  )
}

const ROOT = '"root" is { kind: "boards" | "workspace" | "store", workspaceId }.'
const PATH = '"path" is relative to its root, with "/" between parts and no "..".'
const HASH = /^[0-9a-f]{64}$/

/** A `files.*` method's params, shape-checked, keeping only the members it defines. */
export function parseStudioFilesParams<M extends StudioFilesMethod>(
  method: M,
  params: unknown,
): { ok: true; params: StudioFilesMethodMap[M]['params'] } | Refusal {
  const value = params === undefined ? {} : params
  if (!record(value)) return refuse(`${method} takes an object of params.`)
  const ok = (parsed: unknown) => ({ ok: true as const, params: parsed as StudioFilesMethodMap[M]['params'] })
  if (method === 'files.roots')
    return id(value.workspaceId) ? ok({ workspaceId: value.workspaceId }) : refuse('"workspaceId" names the workspace.')
  const root = parseStudioFileRoot(value.root)
  if (!root) return refuse(ROOT)
  if (!isStudioRelativePath(value.path)) return refuse(PATH)
  const path = value.path
  switch (method as StudioFilesMethod) {
    case 'files.list':
    case 'files.read':
      return ok({ root, path })
    case 'files.write':
    case 'files.remove': {
      if (!id(value.commandId)) return refuse('"commandId" must be a string of 1 to 200 characters.')
      if (!isStudioWritableFile(path)) return refuse('Only a board (*.excalidraw) may be written or removed.')
      if (value.ifMatch !== null && !(typeof value.ifMatch === 'string' && HASH.test(value.ifMatch)))
        return refuse('"ifMatch" is the SHA-256 of the file as last read, or null to create it.')
      if (method === 'files.remove') return ok({ root, path, ifMatch: value.ifMatch, commandId: value.commandId })
      const hasText = typeof value.text === 'string'
      const hasUpload = id(value.uploadId)
      if (hasText === hasUpload) return refuse('A write carries "text", or the "uploadId" of bytes staged for it.')
      return ok({
        root,
        path,
        ...(hasText ? { text: value.text } : { uploadId: value.uploadId }),
        ifMatch: value.ifMatch,
        commandId: value.commandId,
      })
    }
    default:
      return refuse(`${method} is not a files method.`)
  }
}

/** `files.watch`'s params, or why they are not. */
export function parseStudioFilesWatchParams(
  params: unknown,
): { ok: true; params: StudioFilesTopicMap['files.watch']['params'] } | Refusal {
  if (!record(params)) return refuse('files.watch takes { root, path }.')
  const root = parseStudioFileRoot(params.root)
  if (!root) return refuse(ROOT)
  if (!isStudioRelativePath(params.path)) return refuse(PATH)
  return { ok: true, params: { root, path: params.path } }
}
