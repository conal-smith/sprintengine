import { isPathOrChild } from './paths'

type EditorBufferListener = () => void

const buffers = new Map<string, string>()
const listeners = new Map<string, Set<EditorBufferListener>>()
// What each open file held on disk when the editor last read or wrote it. The
// buffer is compared against it when the file changes on disk, to tell an
// agent's edit from the editor's own save (utils/editorDiskSync.ts). Kept
// beside the buffers so it follows them through a rename, a move and a close.
const diskBaselines = new Map<string, string>()

function bufferKey(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`
}

function emit(workspaceId: string, path: string): void {
  listeners.get(bufferKey(workspaceId, path))?.forEach((listener) => listener())
}

export function getEditorBuffer(workspaceId: string, path: string, fallback = ''): string {
  return buffers.get(bufferKey(workspaceId, path)) ?? fallback
}

export function hasEditorBuffer(workspaceId: string, path: string): boolean {
  return buffers.has(bufferKey(workspaceId, path))
}

export function setEditorBuffer(workspaceId: string, path: string, content: string): void {
  const key = bufferKey(workspaceId, path)
  if (buffers.get(key) === content) return
  buffers.set(key, content)
  emit(workspaceId, path)
}

export function getEditorDiskBaseline(workspaceId: string, path: string): string | undefined {
  return diskBaselines.get(bufferKey(workspaceId, path))
}

export function setEditorDiskBaseline(workspaceId: string, path: string, content: string): void {
  diskBaselines.set(bufferKey(workspaceId, path), content)
}

function moveDiskBaseline(fromKey: string, toKey: string): void {
  const baseline = diskBaselines.get(fromKey)
  diskBaselines.delete(fromKey)
  if (baseline !== undefined) diskBaselines.set(toKey, baseline)
}

export function deleteEditorBuffer(workspaceId: string, path: string): void {
  const key = bufferKey(workspaceId, path)
  diskBaselines.delete(key)
  if (!buffers.delete(key)) return
  emit(workspaceId, path)
}

export function remapEditorBuffers(workspaceId: string, fromPath: string, toPath: string): void {
  const separator = fromPath.includes('\\') && !fromPath.includes('/') ? '\\' : '/'
  const fromPrefix = `${fromPath}${separator}`

  for (const [key, content] of [...buffers.entries()]) {
    const [bufferWorkspaceId, path] = key.split('\u0000')
    if (bufferWorkspaceId !== workspaceId || !path || (path !== fromPath && !path.startsWith(fromPrefix))) {
      continue
    }

    const suffix = path === fromPath ? '' : path.slice(fromPath.length)
    const nextPath = `${toPath}${suffix}`
    buffers.delete(key)
    buffers.set(bufferKey(workspaceId, nextPath), content)
    moveDiskBaseline(key, bufferKey(workspaceId, nextPath))
    emit(workspaceId, path)
    emit(workspaceId, nextPath)
  }
}

export function moveEditorBuffer(sourceWorkspaceId: string, destWorkspaceId: string, path: string): void {
  if (sourceWorkspaceId === destWorkspaceId) return
  const sourceKey = bufferKey(sourceWorkspaceId, path)
  if (!buffers.has(sourceKey)) return
  const content = buffers.get(sourceKey) ?? ''
  buffers.delete(sourceKey)
  buffers.set(bufferKey(destWorkspaceId, path), content)
  moveDiskBaseline(sourceKey, bufferKey(destWorkspaceId, path))
  emit(sourceWorkspaceId, path)
  emit(destWorkspaceId, path)
}

export function removeEditorBuffersForPath(workspaceId: string, path: string): void {
  for (const key of [...buffers.keys()]) {
    const [bufferWorkspaceId, bufferPath] = key.split('\u0000')
    if (bufferWorkspaceId !== workspaceId || !bufferPath || !isPathOrChild(bufferPath, path)) continue
    buffers.delete(key)
    diskBaselines.delete(key)
    emit(workspaceId, bufferPath)
  }
}

export function subscribeEditorBuffer(workspaceId: string, path: string, listener: EditorBufferListener): () => void {
  const key = bufferKey(workspaceId, path)
  const bucket = listeners.get(key) ?? new Set<EditorBufferListener>()
  bucket.add(listener)
  listeners.set(key, bucket)

  return () => {
    bucket.delete(listener)
    if (bucket.size === 0) listeners.delete(key)
  }
}
