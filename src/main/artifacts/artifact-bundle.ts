import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// What one published version of an artifact is made of: the page and every
// local file it reaches, laid out exactly as they sit on disk relative to one
// another. Keeping the layout is what keeps a mockup's relative links working
// once it is served from somewhere else: `../foundations/tokens.css` beside
// `patterns/your-stars.html` is still one folder up and across. Nothing is
// rewritten except what a browser could not resolve on its own: a stylesheet's
// package import (`@import "@fontsource/kalam/400.css"`, which a bundler
// resolves through node_modules), a page's root-relative link when a folder
// was published, and the stylesheets the caller asked to add to the page.
//
// The scan is deliberately a reader of references, not a parser: it finds
// what HTML attributes, CSS `url()`/`@import` and static JS imports name.
// A file reached some other way (a `fetch` of a data file) is included by
// publishing the folder it is in.

export type ArtifactBundleFile = {
  /** Where the file goes in the version's folder, `/`-separated. */
  path: string
  /** The file on disk it comes from. */
  source: string
  /** Its bytes, when they were changed from the source's; read from `source` otherwise. */
  content?: Buffer
  bytes: number
}

export type ArtifactBundle = {
  /** The page to open, relative to the version's folder. */
  entry: string
  files: ArtifactBundleFile[]
  bytes: number
  /** What will not work the same once published, said once each. */
  warnings: string[]
}

export type ArtifactBundleInput = {
  /** An HTML file, or a folder holding the page and its assets. */
  path: string
  /** The page to open, inside the folder. `index.html` when left out, or the folder's only page. */
  entry?: string
  /** Local stylesheets to add to the page's head, such as the project's web fonts, with what they reference. */
  stylesheets?: string[]
  /**
   * The folders the page, its stylesheets and every file they reference must
   * be inside, judged on the real path (links in the parent folders resolved),
   * so neither a `../` nor a linked folder reaches past them. Absent, any.
   */
  roots?: readonly string[]
}

export const ARTIFACT_BUNDLE_LIMITS = {
  files: 2000,
  bytes: 50 * 1024 * 1024,
  fileBytes: 20 * 1024 * 1024,
} as const

const HTML_EXTENSIONS = new Set(['.html', '.htm'])
const CSS_EXTENSIONS = new Set(['.css'])
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs'])
const SVG_EXTENSIONS = new Set(['.svg'])
/** A folder's own files: never its version control, dependencies or hidden files. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git'])
const SCHEME = /^[a-z][a-z0-9+.-]*:/i

type Failure = { ok: false; message: string }

/** `a/b` from a path relative to the root, on any platform. */
function posix(path: string): string {
  return path.split(sep).join('/')
}

function relativeLink(fromFile: string, toFile: string): string {
  const link = posix(relative(dirname(fromFile), toFile))
  return link.startsWith('.') ? link : `./${link}`
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false,
  )
}

/**
 * What a referenced path is, without following a link at its end. A page is
 * published to a site anyone with its address can read, so a link it names
 * is not followed: a link beside a mockup could point anywhere on the disk.
 */
async function referencedKind(path: string): Promise<'file' | 'link' | 'none'> {
  const info = await lstat(path).catch(() => null)
  if (!info) return 'none'
  if (info.isSymbolicLink()) return 'link'
  return info.isFile() ? 'file' : 'none'
}

/** Whether a path, seen from `from`, passes through a hidden file or folder (`.env`, `.git/…`). */
function isHiddenFrom(from: string, path: string): boolean {
  return relative(from, path)
    .split(sep)
    .some((segment) => segment.startsWith('.') && segment !== '..' && segment !== '.')
}

/** The folders a bundle may take files from, as real paths. Unreadable ones are dropped. */
async function realRoots(roots: readonly string[]): Promise<string[]> {
  const real = await Promise.all(roots.map((root) => realpath(resolve(root)).catch(() => null)))
  return real.filter((root): root is string => root !== null)
}

/** Whether a file, once its links are resolved, is inside one of `roots`. */
async function isInsideRoots(path: string, roots: readonly string[]): Promise<boolean> {
  const real = await realpath(path).catch(() => null)
  if (!real) return false
  return roots.some((root) => real === root || real.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
}

/** Whether a file the caller names (a thumbnail) is inside one of the folders it may publish from. */
export async function isInsideArtifactRoots(path: string, roots: readonly string[]): Promise<boolean> {
  return isInsideRoots(path, await realRoots(roots))
}

function outsideRoots(path: string): Failure {
  return {
    ok: false,
    message: `${path} is outside the folders this chat may publish from (its project, its worktree), so nothing was published.`,
  }
}

/** The deepest folder holding `start` and every path. */
function commonRoot(start: string, paths: string[]): string {
  let root = start
  for (const path of paths) {
    while (path !== root && !path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
      const parent = dirname(root)
      if (parent === root) break
      root = parent
    }
  }
  return root
}

/** A reference as written, without its query and fragment, decoded. Null for one that names no file. */
function referencedPath(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.startsWith('#') || text.startsWith('{') || text.includes('${')) return null
  const bare = text.split(/[?#]/, 1)[0]
  if (!bare) return null
  try {
    return decodeURI(bare)
  } catch {
    return bare
  }
}

type Reference = { raw: string; kind: 'link' | 'package' }

/** The place a CSS reference is written: `url(…)` or the string of an `@import`. */
// A quoted `url("…")` is taken whole, so a `url(#n)` inside a data URI's
// SVG (a texture's filter, say) is part of that string, not a file.
const CSS_REFERENCE = /@import\s+(["'])([^"']+)\1|url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s]+))\s*\)/g

type CssMatch = { imported?: string; importQuote?: string; url?: string; urlQuote: string }

function cssMatchOf(groups: Array<string | undefined>): CssMatch {
  const [importQuote, imported, doubleQuoted, singleQuoted, bare] = groups
  if (imported !== undefined) return { imported, importQuote, urlQuote: '' }
  if (doubleQuoted !== undefined) return { url: doubleQuoted, urlQuote: '"' }
  if (singleQuoted !== undefined) return { url: singleQuoted, urlQuote: "'" }
  return { url: bare, urlQuote: '' }
}

function cssReferences(text: string): Reference[] {
  const found: Reference[] = []
  for (const match of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(CSS_REFERENCE)) {
    const reference = cssMatchOf(match.slice(1))
    const raw = reference.imported ?? reference.url
    if (raw) found.push({ raw, kind: 'package' })
  }
  return found
}

const SCRIPT_IMPORT =
  /(?:import|export)\s[^'"`;]*?from\s*(["'])(\.{1,2}\/[^"']+)\1|import\s*\(\s*(["'])(\.{1,2}\/[^"']+)\3\s*\)|import\s+(["'])(\.{1,2}\/[^"']+)\5/g

function scriptReferences(text: string): Reference[] {
  const found: Reference[] = []
  for (const match of text.matchAll(SCRIPT_IMPORT)) {
    const raw = match[2] ?? match[4] ?? match[6]
    if (raw) found.push({ raw, kind: 'link' })
  }
  return found
}

const LINK_RELS_FOLLOWED = /\b(?:stylesheet|icon|apple-touch-icon|preload|modulepreload|manifest|mask-icon)\b/i
const TAG = /<([a-zA-Z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g
const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/g

/** The character references an attribute value commonly carries, as the browser reads them. */
function decodeAttribute(value: string): string {
  return value.replace(/&(quot|apos|amp|lt|gt|#39|#34);/g, (_whole, name: string) => {
    switch (name) {
      case 'quot':
      case '#34':
        return '"'
      case 'apos':
      case '#39':
        return "'"
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      default:
        return '&'
    }
  })
}

function attributesOf(text: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of text.matchAll(ATTRIBUTE)) {
    attributes.set(match[1].toLowerCase(), decodeAttribute(match[2] ?? match[3] ?? match[4] ?? ''))
  }
  return attributes
}

/**
 * What a page names: its stylesheets, scripts, images, media, frames and
 * inline styles, and the static imports of its module scripts. Links to other
 * pages (`<a href>`) are not followed: a page publishes alone unless its
 * folder is published.
 */
function htmlReferences(html: string): Reference[] {
  const found: Reference[] = []
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '')
  // Inline scripts and styles are read for what they import, then left out of
  // the tag scan, where text inside them would read as markup.
  const tagsOnly = withoutComments.replace(
    /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2\s*>)/gi,
    (_whole, open: string, tag: string, body: string, close: string) => {
      if (tag.toLowerCase() === 'style') found.push(...cssReferences(body))
      else found.push(...scriptReferences(body))
      return `${open}${close}`
    },
  )
  for (const match of tagsOnly.matchAll(TAG)) {
    const tag = match[1].toLowerCase()
    const attributes = attributesOf(match[2])
    const style = attributes.get('style')
    if (style) found.push(...cssReferences(style))
    if (tag === 'a' || tag === 'area' || tag === 'form' || tag === 'base') continue
    if (tag === 'link' && !LINK_RELS_FOLLOWED.test(attributes.get('rel') ?? '')) continue
    for (const name of ['src', 'href', 'poster', 'data', 'xlink:href']) {
      const value = attributes.get(name)
      if (value) found.push({ raw: value, kind: 'link' })
    }
    for (const name of ['srcset', 'imagesrcset']) {
      const value = attributes.get(name)
      if (!value) continue
      for (const candidate of value.split(','))
        found.push({ raw: candidate.trim().split(/\s+/, 1)[0] ?? '', kind: 'link' })
    }
  }
  return found
}

function referencesOf(path: string, text: string): Reference[] {
  const extension = extname(path).toLowerCase()
  if (HTML_EXTENSIONS.has(extension) || SVG_EXTENSIONS.has(extension)) return htmlReferences(text)
  if (CSS_EXTENSIONS.has(extension)) return cssReferences(text)
  if (SCRIPT_EXTENSIONS.has(extension)) return scriptReferences(text)
  return []
}

/** A package path (`@fontsource/kalam/400.css`) as Node would find it, from the folder up. */
async function resolvePackagePath(fromDir: string, specifier: string): Promise<string | null> {
  if (specifier.startsWith('.') || specifier.startsWith('/') || SCHEME.test(specifier)) return null
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', specifier)
    if (await isFile(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function walkFolder(root: string, into: string[]): Promise<Failure | null> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const failed = await walkFolder(path, into)
      if (failed) return failed
    } else if (entry.isFile()) {
      into.push(path)
      if (into.length > ARTIFACT_BUNDLE_LIMITS.files) {
        return {
          ok: false,
          message: `The folder holds more than ${ARTIFACT_BUNDLE_LIMITS.files} files; publish a smaller one.`,
        }
      }
    }
  }
  return null
}

/** The folder's page: the one asked for, `index.html`, or its only page. */
async function folderEntry(folder: string, entry: string | undefined): Promise<string | Failure> {
  if (entry) {
    const path = resolve(folder, entry)
    if (!path.startsWith(`${folder}${sep}`) || !(await isFile(path))) {
      return { ok: false, message: `"${entry}" is not a file in ${folder}.` }
    }
    return path
  }
  if (await isFile(join(folder, 'index.html'))) return join(folder, 'index.html')
  const pages = (await readdir(folder).catch(() => [] as string[])).filter((name) =>
    HTML_EXTENSIONS.has(extname(name).toLowerCase()),
  )
  if (pages.length === 1) return join(folder, pages[0])
  return {
    ok: false,
    message: pages.length
      ? `The folder has ${pages.length} pages and no index.html; say which to open with "entry".`
      : 'The folder has no HTML page to publish.',
  }
}

/** Collect a page, or a folder, with every local file it references. Never throws. */
export async function collectArtifactBundle(
  input: ArtifactBundleInput,
): Promise<{ ok: true; bundle: ArtifactBundle } | Failure> {
  if (!isAbsolute(input.path)) return { ok: false, message: `"${input.path}" is not an absolute path.` }
  const target = resolve(input.path)
  const info = await stat(target).catch(() => null)
  if (!info) return { ok: false, message: `Nothing is at ${target}.` }
  const roots = input.roots ? await realRoots(input.roots) : null
  if (roots && !(await isInsideRoots(target, roots))) return outsideRoots(target)

  let folder: string | null = null
  let entry: string
  const seeds: string[] = []
  if (info.isDirectory()) {
    folder = target
    const chosen = await folderEntry(folder, input.entry)
    if (typeof chosen !== 'string') return chosen
    entry = chosen
    const failed = await walkFolder(folder, seeds)
    if (failed) return failed
  } else {
    if (!HTML_EXTENSIONS.has(extname(target).toLowerCase())) {
      return { ok: false, message: `${target} is not an HTML page (.html or .htm).` }
    }
    entry = target
    seeds.push(target)
  }

  const stylesheets: string[] = []
  for (const sheet of input.stylesheets ?? []) {
    if (!isAbsolute(sheet) || !(await isFile(sheet)) || extname(sheet).toLowerCase() !== '.css') {
      return { ok: false, message: `"${sheet}" is not a stylesheet (an absolute path to a .css file).` }
    }
    if (roots && !(await isInsideRoots(sheet, roots))) return outsideRoots(resolve(sheet))
    stylesheets.push(resolve(sheet))
  }

  const warnings = new Set<string>()
  const remoteHosts = new Set<string>()
  const included = new Set<string>()
  // A reference to rewrite, per file: as written → what the browser should be told.
  const rewrites = new Map<string, Map<string, string>>()
  const queue = [...seeds, ...stylesheets]
  for (const path of queue) included.add(path)

  const rewrite = (file: string, raw: string, to: string) => {
    let forFile = rewrites.get(file)
    if (!forFile) rewrites.set(file, (forFile = new Map()))
    forFile.set(raw, to)
  }

  for (let index = 0; index < queue.length; index += 1) {
    const file = queue[index]
    const extension = extname(file).toLowerCase()
    if (
      !HTML_EXTENSIONS.has(extension) &&
      !CSS_EXTENSIONS.has(extension) &&
      !SCRIPT_EXTENSIONS.has(extension) &&
      !SVG_EXTENSIONS.has(extension)
    )
      continue
    const text = await readFile(file, 'utf8').catch(() => '')
    for (const reference of referencesOf(file, text)) {
      const raw = reference.raw.trim()
      if (/^(?:data|blob|javascript|mailto|tel|about):/i.test(raw)) continue
      if (/^(?:https?:)?\/\//i.test(raw)) {
        try {
          remoteHosts.add(new URL(raw.startsWith('//') ? `https:${raw}` : raw).host)
        } catch {
          // Not a URL a browser would load either.
        }
        continue
      }
      if (SCHEME.test(raw)) continue
      const path = referencedPath(raw)
      if (!path) continue
      let resolved: string | null = null
      if (path.startsWith('/')) {
        // Root-relative: the site's root on a server, which under a Pages
        // sub-path is not the folder's. Inside a published folder it is the
        // folder, so it is pointed there; anywhere else it cannot be placed.
        const inFolder = folder ? join(folder, path) : null
        if (inFolder && (await isFile(inFolder))) {
          resolved = inFolder
          rewrite(file, raw, relativeLink(file, inFolder) + raw.slice(raw.split(/[?#]/, 1)[0].length))
        } else {
          warnings.add(
            `${raw} (in ${posix(relative(dirname(entry), file)) || file}) is root-relative and will not load from the published site.`,
          )
          continue
        }
      } else {
        const local = resolve(dirname(file), path)
        if (await isFile(local)) resolved = local
        else if (reference.kind === 'package') {
          const fromPackage = await resolvePackagePath(dirname(file), path)
          if (fromPackage) {
            resolved = fromPackage
            rewrite(file, raw, relativeLink(file, fromPackage) + raw.slice(raw.split(/[?#]/, 1)[0].length))
          }
        }
      }
      if (!resolved) {
        warnings.add(`${raw} (in ${posix(relative(dirname(entry), file)) || file}) is not on disk; it is left out.`)
        continue
      }
      if (!included.has(resolved)) {
        const kind = await referencedKind(resolved)
        if (kind !== 'file' || isHiddenFrom(dirname(entry), resolved)) {
          warnings.add(
            kind === 'link'
              ? `${raw} (in ${posix(relative(dirname(entry), file))}) is a symbolic link; links are not followed, so it is left out.`
              : `${raw} (in ${posix(relative(dirname(entry), file))}) is a hidden file; it is left out.`,
          )
          continue
        }
        if (roots && !(await isInsideRoots(resolved, roots))) return outsideRoots(resolved)
        included.add(resolved)
        queue.push(resolved)
        if (included.size > ARTIFACT_BUNDLE_LIMITS.files) {
          return {
            ok: false,
            message: `The page reaches more than ${ARTIFACT_BUNDLE_LIMITS.files} files; publish a smaller one.`,
          }
        }
      }
    }
  }
  if (remoteHosts.size > 0) {
    warnings.add(
      `It loads from the network (${[...remoteHosts].sort().join(', ')}); those files are not published with it.`,
    )
  }

  const all = [...included]
  const root = commonRoot(folder ?? dirname(entry), all)
  const files: ArtifactBundleFile[] = []
  let bytes = 0
  for (const source of all) {
    const size = (await stat(source)).size
    if (size > ARTIFACT_BUNDLE_LIMITS.fileBytes) {
      return { ok: false, message: `${source} is over ${ARTIFACT_BUNDLE_LIMITS.fileBytes / 1024 / 1024} MB.` }
    }
    let content: Buffer | undefined
    const forFile = rewrites.get(source)
    if (forFile || (source === entry && stylesheets.length > 0)) {
      let text = await readFile(source, 'utf8')
      if (forFile) text = applyRewrites(source, text, forFile)
      if (source === entry && stylesheets.length > 0)
        text = injectStylesheets(
          text,
          stylesheets.map((sheet) => relativeLink(entry, sheet)),
        )
      content = Buffer.from(text, 'utf8')
    }
    const fileBytes = content ? content.length : size
    bytes += fileBytes
    if (bytes > ARTIFACT_BUNDLE_LIMITS.bytes) {
      return {
        ok: false,
        message: `The page and what it references come to over ${ARTIFACT_BUNDLE_LIMITS.bytes / 1024 / 1024} MB.`,
      }
    }
    files.push({ path: posix(relative(root, source)), source, bytes: fileBytes, ...(content ? { content } : {}) })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { ok: true, bundle: { entry: posix(relative(root, entry)), files, bytes, warnings: [...warnings] } }
}

/** A file's references respelled, wherever it names them. */
function applyRewrites(file: string, text: string, rewrites: Map<string, string>): string {
  const swap = (raw: string) => rewrites.get(raw.trim()) ?? raw
  const cssRewrite = (whole: string, ...groups: Array<string | undefined>) => {
    const found = cssMatchOf(groups.slice(0, 5))
    if (found.imported !== undefined && rewrites.has(found.imported.trim())) {
      return `@import ${found.importQuote}${swap(found.imported)}${found.importQuote}`
    }
    if (found.url !== undefined && rewrites.has(found.url.trim())) {
      return `url(${found.urlQuote}${swap(found.url)}${found.urlQuote})`
    }
    return whole
  }
  if (CSS_EXTENSIONS.has(extname(file).toLowerCase())) return text.replace(CSS_REFERENCE, cssRewrite)
  return text
    .replace(/(=\s*)(["'])([^"']*)\2/g, (whole, equals: string, quote: string, value: string) =>
      rewrites.has(value.trim()) ? `${equals}${quote}${swap(value)}${quote}` : whole,
    )
    .replace(CSS_REFERENCE, cssRewrite)
}

/** The stylesheets linked at the top of the page's head, before its own, so its own rules still win. */
function injectStylesheets(html: string, hrefs: string[]): string {
  const links = hrefs.map((href) => `<link rel="stylesheet" href="${href.replace(/"/g, '&quot;')}" />`).join('\n    ')
  const head = /<head\b[^>]*>/i.exec(html)
  if (head)
    return `${html.slice(0, head.index + head[0].length)}\n    ${links}${html.slice(head.index + head[0].length)}`
  return `${links}\n${html}`
}
