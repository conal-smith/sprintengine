import { readdir, readFile, stat } from 'fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
import { MAX_IMAGE_DATA_URL_BYTES } from './filesystem-read-limits'

type MemoryGraphNodeKind = 'markdown' | 'image' | 'text' | 'asset'

type MemoryGraphNode = {
  id: string
  path: string
  relativePath: string
  name: string
  kind: MemoryGraphNodeKind
  extension: string
  sizeBytes: number
  degree: number
  inboundDegree: number
  group: string
  /** Frontmatter title, falling back to first H1 in body, otherwise undefined. */
  title?: string
  /** Frontmatter type — used for graph color and the modal badge. */
  type?: string
  /** Frontmatter tags (string[] or comma-separated). */
  tags?: string[]
  /** Frontmatter `related` + `depends-on`, normalised to relative paths when resolvable. */
  related?: string[]
}

type MemoryGraphEdge = {
  id: string
  source: string
  target: string
  sourcePath: string
  targetPath: string
}

type MemoryUnresolvedLink = {
  sourcePath: string
  href: string
  resolvedRelativePath: string | null
  reason: 'missing' | 'outside-root'
}

export type MemoryRootStatus =
  | { ok: true; rootPath: string; relativeRoot: string }
  | {
      ok: false
      status: 'missing-workspace' | 'invalid-relative-path' | 'missing-memory-root' | 'inaccessible'
      relativeRoot: string | null
      message: string
    }

export type MemoryGraphIndexResult =
  | {
      ok: true
      rootPath: string
      relativeRoot: string
      nodes: MemoryGraphNode[]
      edges: MemoryGraphEdge[]
      groups: string[]
      unresolvedLinks: MemoryUnresolvedLink[]
      indexedAt: number
    }
  | MemoryRootStatus

export type MemoryPreviewResult =
  | { ok: true; node: MemoryGraphNode; previewKind: 'markdown' | 'text'; content: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'image'; dataUrl: string }
  | { ok: true; node: MemoryGraphNode; previewKind: 'unsupported'; message: string }
  | { ok: false; message: string }

const IMAGE_EXTENSIONS = new Set(['.apng', '.avif', '.bmp', '.gif', '.ico', '.jpg', '.jpeg', '.png', '.svg', '.webp'])
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.csv',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.scss',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
])
// [[note]] | [[note|alias]] | [[note#section]] | [[brand/logo-assets]]
// Negative lookbehind on `!` so image embeds (`![[…]]`) are still skipped.
const WIKILINK_RE = /(?<!!)\[\[([^\]\n]+?)\]\]/g
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const HEADING_RE = /^#\s+(.+)$/m
const MAX_INDEX_FILES = 5000
const MAX_MARKDOWN_BYTES = 1024 * 1024

type FileEntry = {
  path: string
  relativePath: string
  name: string
  extension: string
  sizeBytes: number
}

function normalizeMemoryRelativeRoot(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
  if (!normalized || normalized === '.' || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return null
  return normalized
}

function normalizePathKey(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

function toDisplayRelativePath(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath).split(sep).join('/')
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const parentKey = normalizePathKey(resolve(parentPath))
  const childKey = normalizePathKey(resolve(childPath))
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`)
}

function classifyNode(extension: string): MemoryGraphNodeKind {
  if (extension === '.md' || extension === '.mdx') return 'markdown'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'asset'
}

function groupForRelativePath(relativePath: string): string {
  const first = relativePath.split('/').filter(Boolean)[0]
  return first && relativePath.includes('/') ? first : 'Root'
}

async function collectFiles(rootPath: string): Promise<FileEntry[]> {
  const files: FileEntry[] = []

  const visit = async (dirPath: string) => {
    if (files.length >= MAX_INDEX_FILES) return
    const entries = await readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.obsidian') continue
      const entryPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }
      if (!entry.isFile()) continue

      const stats = await stat(entryPath)
      const extension = extname(entry.name).toLowerCase()
      files.push({
        path: entryPath,
        relativePath: toDisplayRelativePath(rootPath, entryPath),
        name: entry.name,
        extension,
        sizeBytes: stats.size,
      })
      if (files.length >= MAX_INDEX_FILES) return
    }
  }

  await visit(rootPath)
  return files
}

export async function resolveMemoryRoot(
  workspaceRoot: string | null | undefined,
  relativeRootInput: string | null | undefined,
): Promise<MemoryRootStatus> {
  const relativeRoot = normalizeMemoryRelativeRoot(relativeRootInput)
  if (!workspaceRoot?.trim()) {
    return {
      ok: false,
      status: 'missing-workspace',
      relativeRoot,
      message: 'Open a workspace folder before configuring the Knowledge Graph.',
    }
  }
  if (!relativeRoot) {
    return {
      ok: false,
      status: 'invalid-relative-path',
      relativeRoot: null,
      message: 'Knowledge path must be a non-empty relative path.',
    }
  }

  const rootPath = resolve(workspaceRoot, relativeRoot)
  try {
    const stats = await stat(rootPath)
    if (!stats.isDirectory()) {
      return {
        ok: false,
        status: 'missing-memory-root',
        relativeRoot,
        message: 'Configured knowledge path is not a folder.',
      }
    }
  } catch (error) {
    return {
      ok: false,
      status: 'missing-memory-root',
      relativeRoot,
      message: error instanceof Error ? error.message : 'Configured knowledge folder is missing.',
    }
  }

  return { ok: true, rootPath, relativeRoot }
}

/**
 * The destinations of `[label](href)` and `![alt](src)` links, as
 * `/!?\[[^\]]*]\(([^)]+)\)/g` would find them, in one forward pass.
 *
 * The regex is quadratic on text it cannot match: from every `[` it reads on
 * to the next `]`, and from every `](` on to the next `)`, so a file with many
 * of one and none of the other (a pasted terminal log is all `\x1b[32m`) is
 * read once per bracket. An 850 KB note took 15 s, in the main process. Here
 * a label that fails skips past its `]`, since any `[` nested in it closes on
 * the same `]` and fails the same way, and the scan stops once no `]` or `)`
 * is left for a later link to close on.
 */
export function parseMarkdownLinks(content: string): string[] {
  const links: string[] = []
  let cursor = 0
  while (cursor < content.length) {
    const labelStart = content.indexOf('[', cursor)
    if (labelStart === -1) break
    const labelEnd = content.indexOf(']', labelStart + 1)
    if (labelEnd === -1) break
    cursor = labelEnd + 1
    if (content[labelEnd + 1] !== '(') continue
    const close = content.indexOf(')', labelEnd + 2)
    if (close === -1) break
    if (close === labelEnd + 2) continue
    cursor = close + 1
    const raw = content.slice(labelEnd + 2, close).trim()
    if (!raw) continue
    const href = raw.split(/\s+["'][^"']*["']\s*$/u)[0]?.trim() ?? raw
    links.push(href)
  }
  return links
}

function parseWikilinks(content: string): string[] {
  const links: string[] = []
  for (const match of content.matchAll(WIKILINK_RE)) {
    const raw = match[1]?.trim()
    if (!raw) continue
    // Strip alias (after `|`) and fragment (after `#`).
    const target = raw.split('|')[0]?.split('#')[0]?.trim()
    if (target) links.push(target)
  }
  return links
}

type ParsedFrontmatter = {
  body: string
  data: Record<string, string | string[]>
}

/**
 * Minimal YAML frontmatter reader for the graph: scalar strings, inline arrays
 * `[a, b]`, and block-style arrays prefixed with `-`. Anything richer falls
 * through unparsed rather than crashing the index.
 */
function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return { body: content, data: {} }

  const data: Record<string, string | string[]> = {}
  const lines = match[1].split(/\r?\n/)
  let currentKey: string | null = null
  let currentList: string[] | null = null

  const stripQuotes = (value: string): string => {
    const trimmed = value.trim()
    if (trimmed.length >= 2) {
      const first = trimmed[0]
      const last = trimmed[trimmed.length - 1]
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return trimmed.slice(1, -1)
      }
    }
    return trimmed
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/u, '')
    if (!line.trim()) {
      if (currentKey && currentList) {
        data[currentKey] = currentList
        currentKey = null
        currentList = null
      }
      continue
    }
    const listItem = /^\s*-\s+(.+)$/.exec(line)
    if (listItem && currentKey) {
      if (!currentList) currentList = []
      currentList.push(stripQuotes(listItem[1]))
      continue
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    if (currentKey && currentList) {
      data[currentKey] = currentList
      currentList = null
    }
    const key = kv[1]
    const value = kv[2]
    if (!value) {
      currentKey = key
      currentList = []
      continue
    }
    const inlineArray = /^\[(.*)\]$/.exec(value.trim())
    if (inlineArray) {
      data[key] = inlineArray[1]
        .split(',')
        .map((entry) => stripQuotes(entry))
        .filter((entry) => entry.length > 0)
      currentKey = null
      currentList = null
      continue
    }
    data[key] = stripQuotes(value)
    currentKey = null
    currentList = null
  }
  if (currentKey && currentList) data[currentKey] = currentList

  return { body: content.slice(match[0].length), data }
}

function frontmatterStringList(value: string | string[] | undefined): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map((entry) => entry.trim()).filter(Boolean)
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function firstHeading(body: string): string | undefined {
  const match = HEADING_RE.exec(body)
  return match?.[1]?.trim() || undefined
}

/**
 * Resolves a wikilink-style href (no extension) to a known file. Tries:
 *   1. <sourceDir>/<href>.md  (and .mdx)
 *   2. <root>/<href>.md       (and .mdx)
 *   3. exact relative match if the href already has an extension
 * Returns the canonical relative path, or null when nothing matches.
 */
function resolveWikilink(
  href: string,
  sourceRelativePath: string,
  rootPath: string,
  keyByRelativePath: Map<string, string>,
): string | null {
  const cleaned = href.replace(/\\/g, '/').replace(/^\/+/u, '').trim()
  if (!cleaned) return null

  const candidates: string[] = []
  const hasExtension = /\.[a-z0-9]+$/i.test(cleaned)
  const sourceDir = sourceRelativePath.includes('/') ? sourceRelativePath.split('/').slice(0, -1).join('/') : ''

  if (hasExtension) {
    candidates.push(cleaned)
    if (sourceDir) candidates.push(`${sourceDir}/${cleaned}`)
  } else {
    const exts = ['.md', '.mdx']
    for (const ext of exts) {
      if (sourceDir) candidates.push(`${sourceDir}/${cleaned}${ext}`)
      candidates.push(`${cleaned}${ext}`)
    }
  }

  for (const candidate of candidates) {
    const resolved = resolve(rootPath, candidate)
    if (!isPathInside(rootPath, resolved)) continue
    const relativePath = toDisplayRelativePath(rootPath, resolved)
    const matched = keyByRelativePath.get(normalizePathKey(relativePath))
    if (matched) return matched
  }
  return null
}

function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')
}

function stripHrefDecoration(href: string): string {
  const withoutAnchor = href.split('#')[0] ?? href
  const withoutQuery = withoutAnchor.split('?')[0] ?? withoutAnchor
  try {
    return decodeURIComponent(withoutQuery)
  } catch {
    return withoutQuery
  }
}

export async function indexMemoryGraph(
  workspaceRoot: string | null | undefined,
  relativeRootInput: string | null | undefined,
): Promise<MemoryGraphIndexResult> {
  const root = await resolveMemoryRoot(workspaceRoot, relativeRootInput)
  if (!root.ok) return root

  try {
    const files = await collectFiles(root.rootPath)
    const nodeByRelativePath = new Map<string, MemoryGraphNode>()
    const keyByRelativePath = new Map<string, string>()

    files.forEach((file) => {
      const node: MemoryGraphNode = {
        id: file.relativePath,
        path: file.path,
        relativePath: file.relativePath,
        name: file.name,
        kind: classifyNode(file.extension),
        extension: file.extension,
        sizeBytes: file.sizeBytes,
        degree: 0,
        inboundDegree: 0,
        group: groupForRelativePath(file.relativePath),
      }
      nodeByRelativePath.set(file.relativePath, node)
      keyByRelativePath.set(normalizePathKey(file.relativePath), file.relativePath)
    })

    const edges: MemoryGraphEdge[] = []
    const edgeKeys = new Set<string>()
    const unresolvedLinks: MemoryUnresolvedLink[] = []

    const recordEdge = (sourceRelPath: string, targetKey: string) => {
      if (sourceRelPath === targetKey) return
      const edgeKey = `${sourceRelPath}${targetKey}`
      if (edgeKeys.has(edgeKey)) return
      edgeKeys.add(edgeKey)
      edges.push({
        id: `${sourceRelPath}->${targetKey}`,
        source: sourceRelPath,
        target: targetKey,
        sourcePath: sourceRelPath,
        targetPath: targetKey,
      })
    }

    for (const file of files) {
      if (file.extension !== '.md' && file.extension !== '.mdx') continue
      if (file.sizeBytes > MAX_MARKDOWN_BYTES) continue

      const raw = await readFile(file.path, 'utf-8')
      const { body, data } = parseFrontmatter(raw)

      const node = nodeByRelativePath.get(file.relativePath)
      if (node) {
        const explicitTitle = typeof data.title === 'string' ? data.title : undefined
        node.title = explicitTitle || firstHeading(body) || undefined
        node.type = typeof data.type === 'string' ? data.type : undefined
        const tags = frontmatterStringList(data.tags as string | string[] | undefined)
        if (tags.length > 0) node.tags = tags
      }

      for (const href of parseMarkdownLinks(body)) {
        if (isExternalHref(href)) continue
        const cleanHref = stripHrefDecoration(href)
        if (!cleanHref) continue

        const targetPath = resolve(join(root.rootPath, file.relativePath, '..'), cleanHref)
        if (!isPathInside(root.rootPath, targetPath)) {
          unresolvedLinks.push({
            sourcePath: file.relativePath,
            href,
            resolvedRelativePath: null,
            reason: 'outside-root',
          })
          continue
        }

        const targetRelativePath = toDisplayRelativePath(root.rootPath, targetPath)
        const targetKey = keyByRelativePath.get(normalizePathKey(targetRelativePath))
        if (!targetKey) {
          unresolvedLinks.push({
            sourcePath: file.relativePath,
            href,
            resolvedRelativePath: targetRelativePath,
            reason: 'missing',
          })
          continue
        }
        recordEdge(file.relativePath, targetKey)
      }

      for (const href of parseWikilinks(body)) {
        const targetKey = resolveWikilink(href, file.relativePath, root.rootPath, keyByRelativePath)
        if (!targetKey) {
          unresolvedLinks.push({
            sourcePath: file.relativePath,
            href: `[[${href}]]`,
            resolvedRelativePath: null,
            reason: 'missing',
          })
          continue
        }
        recordEdge(file.relativePath, targetKey)
      }

      const relatedRefs = [
        ...frontmatterStringList(data.related as string | string[] | undefined),
        ...frontmatterStringList(data['depends-on'] as string | string[] | undefined),
      ]
      const relatedTargets: string[] = []
      for (const ref of relatedRefs) {
        const targetKey = resolveWikilink(ref, file.relativePath, root.rootPath, keyByRelativePath)
        if (targetKey) {
          recordEdge(file.relativePath, targetKey)
          if (!relatedTargets.includes(targetKey)) relatedTargets.push(targetKey)
        }
      }
      if (relatedTargets.length > 0 && node) node.related = relatedTargets
    }

    edges.forEach((edge) => {
      const source = nodeByRelativePath.get(edge.source)
      const target = nodeByRelativePath.get(edge.target)
      if (source) source.degree += 1
      if (target) {
        target.degree += 1
        target.inboundDegree += 1
      }
    })

    const nodes = [...nodeByRelativePath.values()]
    const groups = [...new Set(nodes.map((node) => node.group))].sort()

    return {
      ok: true,
      rootPath: root.rootPath,
      relativeRoot: root.relativeRoot,
      nodes,
      edges,
      groups,
      unresolvedLinks,
      indexedAt: Date.now(),
    }
  } catch (error) {
    return {
      ok: false,
      status: 'inaccessible',
      relativeRoot: root.relativeRoot,
      message: error instanceof Error ? error.message : 'Unable to index knowledge folder.',
    }
  }
}

function imageMimeType(filePath: string): string | null {
  switch (extname(filePath).toLowerCase()) {
    case '.apng':
      return 'image/apng'
    case '.avif':
      return 'image/avif'
    case '.bmp':
      return 'image/bmp'
    case '.gif':
      return 'image/gif'
    case '.ico':
      return 'image/x-icon'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.svg':
      return 'image/svg+xml'
    case '.webp':
      return 'image/webp'
    default:
      return null
  }
}

export async function readMemoryPreview(
  workspaceRoot: string | null | undefined,
  relativeRootInput: string | null | undefined,
  relativePathInput: string,
): Promise<MemoryPreviewResult> {
  const root = await resolveMemoryRoot(workspaceRoot, relativeRootInput)
  if (!root.ok) return { ok: false, message: root.message }

  const relativePath = relativePathInput.replace(/\\/g, '/').replace(/^\/+/u, '')
  const filePath = resolve(root.rootPath, relativePath)
  if (!isPathInside(root.rootPath, filePath)) {
    return { ok: false, message: 'Knowledge preview path is outside the knowledge root.' }
  }

  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) return { ok: false, message: 'Knowledge preview target is not a file.' }
    const extension = extname(filePath).toLowerCase()
    const node: MemoryGraphNode = {
      id: relativePath,
      path: filePath,
      relativePath,
      name: relativePath.split('/').filter(Boolean).pop() ?? relativePath,
      kind: classifyNode(extension),
      extension,
      sizeBytes: stats.size,
      degree: 0,
      inboundDegree: 0,
      group: groupForRelativePath(relativePath),
    }

    if (node.kind === 'image') {
      const mimeType = imageMimeType(filePath)
      if (!mimeType) return { ok: true, node, previewKind: 'unsupported', message: 'Image type is not supported.' }
      if (stats.size > MAX_IMAGE_DATA_URL_BYTES) {
        return { ok: true, node, previewKind: 'unsupported', message: 'Image is too large to preview.' }
      }
      const content = await readFile(filePath)
      return { ok: true, node, previewKind: 'image', dataUrl: `data:${mimeType};base64,${content.toString('base64')}` }
    }

    if (node.kind === 'markdown' || node.kind === 'text') {
      if (stats.size > MAX_MARKDOWN_BYTES) {
        return { ok: true, node, previewKind: 'unsupported', message: 'File is too large to preview.' }
      }
      const content = await readFile(filePath, 'utf-8')
      if (node.kind === 'markdown') {
        const { body, data } = parseFrontmatter(content)
        const title = typeof data.title === 'string' ? data.title : undefined
        node.title = title || firstHeading(body) || undefined
        node.type = typeof data.type === 'string' ? data.type : undefined
        const tags = frontmatterStringList(data.tags as string | string[] | undefined)
        if (tags.length > 0) node.tags = tags
        return { ok: true, node, previewKind: 'markdown', content: body }
      }
      return { ok: true, node, previewKind: 'text', content }
    }

    return { ok: true, node, previewKind: 'unsupported', message: 'Preview is not available for this file type.' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Unable to read knowledge preview.' }
  }
}
