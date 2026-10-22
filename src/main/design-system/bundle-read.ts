import { readdir, readFile, realpath, stat } from 'fs/promises'
import { extname, join, resolve } from 'path'

import { isSafeManifestRelativePath } from '../../../packages/module-sdk/src/manifest-validate'
import { isPathInsideOrEqual } from '../path-containment'

import {
  DESIGN_SYSTEM_MANIFEST_FILENAME,
  parseDesignSystemManifest,
  type DesignSystemManifest,
} from '../../shared/design-system/manifest'
import {
  emitTokensCss,
  parseTokenDocument,
  resolveAccentColor,
  resolveFontFamilies,
  resolveTokenScalar,
  resolveTokenValue,
} from '../../shared/design-system/tokens-css'
import {
  countDocListItems,
  extractBodyHtml,
  extractStages,
  extractStyleBlocks,
  parseComponentDoc,
  sentenceCaseLabel,
} from '../../shared/design-system/bundle-parse'
import { resolveDesignSystemAddedAt } from './entry-added-at'
import type {
  DesignSystemBundleReadFailure,
  DesignSystemBundleReadResult,
  DesignSystemComponentView,
  DesignSystemGlyphView,
  DesignSystemGroupView,
  DesignSystemPatternView,
  DesignSystemRampSwatch,
  DesignSystemSpecimenView,
  DesignSystemTokenFamiliesView,
  DesignSystemTokenView,
} from '../../shared/design-system/bundle-view'

// The Design door's reader (items 2002/2003). Reads a bundle directory and
// returns everything the door draws, in ONE call — see bundle-view.ts for why.
//
// Read-only by construction: this module opens files and nothing else. It never
// writes into the bundle, never forks its `scripts/*.mjs`, and never lints or
// regenerates. That is what makes pointing the door at a folder someone else
// authored safe. `bundle-read.test.ts` asserts the no-fork property by failing
// if this module ever imports a process-spawning API.
//
// The one process the READ path runs is a single `git log` in `entry-added-at`,
// asking the user's own repo when each entry arrived (the door's "New" marker).
// It is a query: no bundle script is forked, nothing is written, and a bundle
// outside git simply has no dates. The same test holds that module to the
// write-side half of this contract.

const TOKENS_SOURCE_RELATIVE_PATH = join('foundations', 'tokens.tokens.json')

/**
 * Total bytes of bundle assets inlined as `data:` URIs per read.
 *
 * A bundle can ship arbitrarily large images and fonts, and the payload crosses
 * an IPC boundary. 4 MB is generous for icon/font assets and small enough that a
 * pathological bundle cannot wedge the renderer. Exhausting it is REPORTED, not
 * silent: a preview missing its assets otherwise looks like a broken component.
 */
const ASSET_BUDGET_BYTES = 4 * 1024 * 1024

/** Asset types worth inlining. Anything else is stripped and reported. */
const INLINE_MIME_TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

function failure(reason: DesignSystemBundleReadFailure, path: string, message: string): DesignSystemBundleReadResult {
  return { ok: false, reason, path, message }
}

function codeOf(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Tracks the data-URI budget across one read, and refuses any path that escapes
 * the bundle.
 *
 * Confinement matters even though we only READ: a bundle is user-browsable
 * content, so `url(../../../../.ssh/id_rsa)` must not become a data URI the
 * renderer then holds. A ref pointing outside the bundle is treated exactly like
 * a missing one — reported, not inlined.
 */
class AssetInliner {
  private spent = 0
  exhausted = false
  private readonly cache = new Map<string, string | null>()
  private realBundleDir: Promise<string | null> | null = null

  constructor(private readonly bundleDir: string) {}

  /** Resolve a bundle-relative ref to a data URI, or null with a reason. */
  async inline(fromDir: string, ref: string): Promise<string | null> {
    // A JSON tuple, not a delimiter-joined string: paths may contain any
    // character, so any separator we picked could be ambiguous — and a control
    // byte in a source file makes git treat it as binary, which kills diffs.
    const cacheKey = JSON.stringify([fromDir, ref])
    const cached = this.cache.get(cacheKey)
    if (cached !== undefined) return cached
    const value = await this.read(fromDir, ref)
    this.cache.set(cacheKey, value)
    return value
  }

  private async read(fromDir: string, ref: string): Promise<string | null> {
    const target = resolve(fromDir, ref)
    if (!isPathInsideOrEqual(this.bundleDir, target)) return null
    const mime = INLINE_MIME_TYPES[extname(target).toLowerCase()]
    if (!mime) return null
    // Judged again where it really is: a link inside the bundle that leads
    // out of it is outside it.
    this.realBundleDir ??= realpath(this.bundleDir).catch(() => null)
    const realBundleDir = await this.realBundleDir
    const real = await realpath(target).catch(() => null)
    if (!realBundleDir || !real || !isPathInsideOrEqual(realBundleDir, real)) return null
    let bytes: Buffer
    try {
      bytes = await readFile(real)
    } catch {
      return null
    }
    if (this.spent + bytes.byteLength > ASSET_BUDGET_BYTES) {
      this.exhausted = true
      return null
    }
    this.spent += bytes.byteLength
    return `data:${mime};base64,${bytes.toString('base64')}`
  }
}

/** A `url(...)` reference in CSS, and the same in an `src`/`href` attribute. */
const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
const ATTR_URL_PATTERN = /\b(src|href|poster)\s*=\s*("([^"]*)"|'([^']*)')/gi

function isExternalRef(ref: string): boolean {
  return /^(https?:|data:|blob:|mailto:|#|\/\/)/i.test(ref) || ref.startsWith('/')
}

/**
 * Rewrite bundle-relative refs in CSS to data URIs; strip and report the rest.
 *
 * Absolute URLs, protocol-relative URLs and filesystem-absolute paths are never
 * followed: the door reads inside the bundle and nowhere else.
 */
async function inlineCssUrls(
  css: string,
  fromDir: string,
  inliner: AssetInliner,
  unresolved: string[],
): Promise<string> {
  const refs = [...css.matchAll(CSS_URL_PATTERN)]
  let output = css
  for (const match of refs) {
    const ref = match[2].trim()
    if (isExternalRef(ref)) {
      if (!ref.startsWith('data:')) {
        unresolved.push(ref)
        output = output.replace(match[0], 'url()')
      }
      continue
    }
    const inlined = await inliner.inline(fromDir, ref)
    if (inlined) {
      output = output.replace(match[0], `url("${inlined}")`)
    } else {
      unresolved.push(ref)
      output = output.replace(match[0], 'url()')
    }
  }
  return output
}

/** The same rewrite for markup attributes (`<img src>`, `<use href>`). */
async function inlineMarkupUrls(
  html: string,
  fromDir: string,
  inliner: AssetInliner,
  unresolved: string[],
): Promise<string> {
  const refs = [...html.matchAll(ATTR_URL_PATTERN)]
  let output = html
  for (const match of refs) {
    const ref = (match[3] ?? match[4] ?? '').trim()
    if (!ref || ref.startsWith('#') || ref.startsWith('data:')) continue
    if (isExternalRef(ref)) {
      unresolved.push(ref)
      output = output.replace(match[0], `${match[1]}=""`)
      continue
    }
    const inlined = await inliner.inline(fromDir, ref)
    if (inlined) {
      output = output.replace(match[0], `${match[1]}="${inlined}"`)
    } else {
      unresolved.push(ref)
      output = output.replace(match[0], `${match[1]}=""`)
    }
  }
  return output
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Read one design-system bundle directory.
 *
 * Failure is typed and always carries the path, because the rail renders a
 * broken row rather than dropping it: a system whose folder moved is still a
 * system the user pointed at, and silently losing the row would hide the fact
 * that anything is wrong.
 */
export async function readDesignSystemBundle(bundleDir: string): Promise<DesignSystemBundleReadResult> {
  if (typeof bundleDir !== 'string' || bundleDir.trim().length === 0) {
    return failure('missing', String(bundleDir ?? ''), 'No bundle directory provided.')
  }

  try {
    const stats = await stat(bundleDir)
    if (!stats.isDirectory()) {
      return failure('missing', bundleDir, `Not a directory: ${bundleDir}`)
    }
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return failure('missing', bundleDir, `That folder is no longer there: ${bundleDir}`)
    }
    return failure('unreadable', bundleDir, `Could not open ${bundleDir}: ${describe(error)}`)
  }

  let manifestContents: string
  try {
    manifestContents = await readFile(join(bundleDir, DESIGN_SYSTEM_MANIFEST_FILENAME), 'utf8')
  } catch (error) {
    const code = codeOf(error)
    if (code === 'ENOENT') {
      return failure(
        'no-manifest',
        bundleDir,
        `That folder has no ${DESIGN_SYSTEM_MANIFEST_FILENAME}, so it is not a design system.`,
      )
    }
    return failure(
      'unreadable',
      bundleDir,
      `Could not read ${DESIGN_SYSTEM_MANIFEST_FILENAME} in ${bundleDir}: ${describe(error)}`,
    )
  }

  // The canonical parser, never a local re-read: it validates schema v1 and
  // preserves unknown fields, which is what lets a bundle declaring contents
  // groups we did not anticipate still render.
  let manifest: DesignSystemManifest
  try {
    manifest = parseDesignSystemManifest(manifestContents)
  } catch (error) {
    return failure('invalid-manifest', bundleDir, describe(error))
  }

  // Tokens are optional to READ: a bundle mid-authoring may have a manifest and
  // no token file yet. That is not a broken bundle — it is a bundle with no
  // accent and no specimen ramp, so those render as absent.
  const tokenDocument = await readTokenDocument(bundleDir)
  const specimen = buildSpecimen(tokenDocument)
  const inliner = new AssetInliner(bundleDir)

  const groups = declaredGroups(manifest)
  // When each declared entry arrived, from git or from birthtime. Derived, never
  // declared: `design-system.json` gains no field for this, so a bundle a user
  // authored years ago still lights its markers. Once per read, so Reload
  // genuinely re-asks and there is no cache of its own to go stale.
  const addedAt = await resolveDesignSystemAddedAt(bundleDir, manifest)
  const components = await readComponents(bundleDir, manifest, inliner)
  const patterns = await readPatterns(bundleDir, manifest, inliner)
  const glyphs = await readGlyphs(bundleDir, manifest)

  return {
    ok: true,
    view: {
      identity: {
        path: bundleDir,
        name: manifest.name,
        version: manifest.version,
        summary: manifest.summary,
        accent: {
          light: tokenDocument ? resolveAccentColor(tokenDocument, 'light') : null,
          dark: tokenDocument ? resolveAccentColor(tokenDocument, 'dark') : null,
        },
      },
      manifest,
      specimen,
      groups,
      addedAt,
      components,
      patterns,
      glyphs,
      assetBudgetExhausted: inliner.exhausted,
    },
  }
}

async function readTokenDocument(bundleDir: string): Promise<Record<string, unknown> | null> {
  const contents = await readTextOrNull(join(bundleDir, TOKENS_SOURCE_RELATIVE_PATH))
  return contents === null ? null : parseTokenDocument(contents)
}

function buildSpecimen(document: Record<string, unknown> | null): DesignSystemSpecimenView {
  if (!document) {
    return {
      tokensCss: '',
      ramp: [],
      fontFamilyUi: null,
      fontFamilyMono: null,
      tokens: emptyTokenFamilies(),
      problems: [],
    }
  }
  const { css, problems } = emitTokensCss(document)
  const families = resolveFontFamilies(document)
  return {
    tokensCss: css,
    ramp: buildRamp(document),
    fontFamilyUi: families.ui,
    fontFamilyMono: families.mono,
    tokens: buildTokenFamilies(document),
    problems,
  }
}

function emptyTokenFamilies(): DesignSystemTokenFamiliesView {
  return {
    fontSize: [],
    fontWeight: [],
    fontLine: [],
    fontTracking: [],
    space: [],
    size: [],
    radius: [],
    shadow: [],
  }
}

/**
 * The `sem` families the Type and Spacing tabs draw, resolved once, here.
 *
 * The renderer must not re-parse `tokens.tokens.json`: the reader is the one
 * thing that knows a bundle's layout, and a second parser in the door would be a
 * second answer to "what is this token worth". Alias chains are followed by
 * `resolveTokenValue`, exactly as the ramp's colours are, so a family declared
 * entirely in aliases resolves to the concrete values it points at.
 */
function buildTokenFamilies(document: Record<string, unknown>): DesignSystemTokenFamiliesView {
  return {
    fontSize: tokenFamily(document, 'sem.font.size'),
    fontWeight: tokenFamily(document, 'sem.font.weight'),
    fontLine: tokenFamily(document, 'sem.font.line'),
    fontTracking: tokenFamily(document, 'sem.font.tracking'),
    space: tokenFamily(document, 'sem.space'),
    size: tokenFamily(document, 'sem.size.control'),
    radius: tokenFamily(document, 'sem.radius'),
    shadow: tokenFamily(document, 'sem.shadow'),
  }
}

/**
 * One family's LEAF tokens, in the document's own order.
 *
 * Only the immediate leaves: `sem.size.control.sm` is a control height, and
 * walking deeper would sweep up whatever a bundle nests under a step. The
 * author's order is kept — a ramp has an intended reading order, and sorting it
 * would invent one.
 */
function tokenFamily(document: Record<string, unknown>, prefix: string): DesignSystemTokenView[] {
  let node: unknown = document
  for (const segment of prefix.split('.')) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return []
    node = (node as Record<string, unknown>)[segment]
  }
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return []
  const out: DesignSystemTokenView[] = []
  for (const key of Object.keys(node as Record<string, unknown>)) {
    // `$type` / `$description` / `$extensions` are DTCG group metadata.
    if (key.startsWith('$')) continue
    const path = `${prefix}.${key}`
    // The SCALAR resolver: a weight and a line height are numbers in DTCG, and
    // a family the door draws as a specimen cannot be missing because of it.
    const light = resolveTokenScalar(document, path, 'light')
    if (light === null || !isDrawableTokenValue(light)) continue
    const dark = resolveTokenScalar(document, path, 'dark')
    out.push({
      path,
      light,
      dark: dark !== null && isDrawableTokenValue(dark) ? dark : light,
    })
  }
  return out
}

/**
 * A token value the door is willing to put in a style attribute.
 *
 * Token documents are THIRD-PARTY content — the same rule that makes
 * `isColorValue` guard the ramp. A length, a weight and a shadow are all made of
 * numbers, units, functions and separators, so the permitted alphabet is small;
 * anything carrying a `url(`, a quote, a semicolon or a brace is refused rather
 * than passed through to the renderer, where it would be drawn.
 */
function isDrawableTokenValue(value: string): boolean {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 300) return false
  if (/url\s*\(/i.test(trimmed)) return false
  return /^[-+0-9a-zA-Z.,%()/#\s]+$/.test(trimmed)
}

/**
 * The specimen's colour bar: the `ref` tier's colours in document order.
 *
 * The raw scale rather than the semantic layer, because the bar is the system's
 * palette — its identity — and `sem` is a mapping onto it, which would show the
 * same hue several times over. Order is the author's, not sorted: a palette has
 * an intended reading order and re-sorting it by luminance would invent one.
 */
function buildRamp(document: Record<string, unknown>): DesignSystemRampSwatch[] {
  const swatches: DesignSystemRampSwatch[] = []
  const walk = (node: unknown, path: string[]): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return
    const record = node as Record<string, unknown>
    if ('$value' in record) {
      if (record.$type !== 'color') return
      const dotted = path.join('.')
      const light = resolveTokenValue(document, dotted, 'light')
      const dark = resolveTokenValue(document, dotted, 'dark')
      if (light) swatches.push({ path: dotted, light, dark: dark ?? light })
      return
    }
    for (const [key, child] of Object.entries(record)) walk(child, [...path, key])
  }
  const ref = (document as Record<string, unknown>).ref
  if (ref) walk(ref, ['ref'])
  return swatches
}

/**
 * One section per NON-EMPTY declared `contents` key, in manifest order.
 *
 * The five known keys are validated by the parser, but `contents` is an open
 * record — a bundle declaring another group survives the parse and must survive
 * here too. A group the manifest declares empty is not drawn at all.
 */
function declaredGroups(manifest: DesignSystemManifest): DesignSystemGroupView[] {
  const groups: DesignSystemGroupView[] = []
  for (const [key, value] of Object.entries(manifest.contents)) {
    if (!Array.isArray(value)) continue
    const entries = value.filter((entry): entry is string => typeof entry === 'string')
    if (entries.length === 0) continue
    groups.push({ key, label: sentenceCaseLabel(key), entries, count: entries.length })
  }
  return groups
}

async function readComponents(
  bundleDir: string,
  manifest: DesignSystemManifest,
  inliner: AssetInliner,
): Promise<DesignSystemComponentView[]> {
  const componentsDir = join(bundleDir, 'components')
  // The manifest's declaration is the source of truth for WHAT the system
  // contains; the directory is only where the files are. A component declared
  // but absent is skipped rather than faked, and a directory present but
  // undeclared is not shown — `contents` is authored, and the door renders what
  // the system says it is.
  const declared = Array.isArray(manifest.contents.components)
    ? manifest.contents.components.filter((name): name is string => typeof name === 'string')
    : []
  const present = new Set(await readDirNames(componentsDir))
  const views: DesignSystemComponentView[] = []
  for (const name of declared) {
    if (!present.has(name)) continue
    const dir = join(componentsDir, name)
    const unresolvedRefs: string[] = []
    const rawHtml = (await readTextOrNull(join(dir, 'component.html'))) ?? ''
    const rawCss = (await readTextOrNull(join(dir, 'component.css'))) ?? ''
    const markdown = await readTextOrNull(join(dir, 'component.md'))

    const css = await inlineCssUrls(rawCss, dir, inliner, unresolvedRefs)
    const inlineStyles: string[] = []
    for (const block of extractStyleBlocks(rawHtml)) {
      inlineStyles.push(await inlineCssUrls(block, dir, inliner, unresolvedRefs))
    }
    // The `<link rel=stylesheet href="../../foundations/tokens.css">` every
    // component.html carries is deliberately NOT inlined: the door composes the
    // token block from the SOURCE instead, so following that link would
    // reintroduce exactly the staleness we read around. It is stripped by
    // `stripActiveContent`, and it is not reported as unresolved because nothing
    // is missing — we chose a better source.
    const body = await inlineMarkupUrls(extractBodyHtml(rawHtml), dir, inliner, unresolvedRefs)
    const doc = markdown ? parseComponentDoc(markdown) : null

    views.push({
      name,
      css,
      inlineStyles,
      stages: extractStages(body),
      variantCount: countDocListItems(doc?.variants),
      stateCount: countDocListItems(doc?.states),
      doc,
      unresolvedRefs: [...new Set(unresolvedRefs)],
    })
  }
  return views
}

async function readPatterns(
  bundleDir: string,
  manifest: DesignSystemManifest,
  inliner: AssetInliner,
): Promise<DesignSystemPatternView[]> {
  const dir = join(bundleDir, 'patterns')
  const declared = Array.isArray(manifest.contents.patterns)
    ? manifest.contents.patterns.filter((name): name is string => typeof name === 'string')
    : []
  const views: DesignSystemPatternView[] = []
  for (const name of declared) {
    // A pattern may be declared with or without its extension, and either as a
    // bare name or as the manifest's canonical bundle-relative path
    // ("patterns/context-rail.html") — joining the path form onto the patterns
    // dir doubled the prefix and silently dropped every declared pattern.
    // A name is a path inside the bundle, never one that climbs out of it.
    if (!isSafeManifestRelativePath(name)) continue
    const relative = name.startsWith('patterns/') ? name.slice('patterns/'.length) : name
    const fileName = relative.endsWith('.html') ? relative : `${relative}.html`
    const raw = await readTextOrNull(join(dir, fileName))
    if (raw === null) continue
    const unresolvedRefs: string[] = []
    const inlineStyles: string[] = []
    for (const block of extractStyleBlocks(raw)) {
      inlineStyles.push(await inlineCssUrls(block, dir, inliner, unresolvedRefs))
    }
    const html = await inlineMarkupUrls(extractBodyHtml(raw), dir, inliner, unresolvedRefs)
    views.push({
      name: relative.replace(/\.html$/i, ''),
      html,
      inlineStyles,
      unresolvedRefs: [...new Set(unresolvedRefs)],
    })
  }
  return views
}

async function readGlyphs(bundleDir: string, manifest: DesignSystemManifest): Promise<DesignSystemGlyphView[]> {
  const dir = join(bundleDir, 'glyphs')
  const declared = Array.isArray(manifest.contents.glyphs)
    ? manifest.contents.glyphs.filter((name): name is string => typeof name === 'string')
    : []
  const views: DesignSystemGlyphView[] = []
  for (const name of declared) {
    // Same dual form as patterns: bare name or bundle-relative path, and never
    // one that climbs out of the bundle.
    if (!isSafeManifestRelativePath(name)) continue
    const relative = name.startsWith('glyphs/') ? name.slice('glyphs/'.length) : name
    const fileName = relative.endsWith('.svg') ? relative : `${relative}.svg`
    const svg = await readTextOrNull(join(dir, fileName))
    if (svg === null) continue
    views.push({ name: relative.replace(/\.svg$/i, ''), svg })
  }
  return views
}
