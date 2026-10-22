import type { ProjectLogo } from '../shared/electron-api'
import { imageMimeType } from './filesystem-image'
import { extractIcnsPng } from './project-logo-icns'
import { imageWithinDecodeLimits } from '../shared/image-dimensions'

// A project's own logo, read off the top level of its repo (or a macOS app's
// icon from where such a repo keeps it) so a row of projects reads like a row
// of products. Detection only — there is no
// per-project icon picker, and nothing here writes to the repo.
//
// This module is deliberately free of `fs` and `electron` imports (its
// imports, `imageMimeType` and the `.icns` reader, are pure): it takes its
// filesystem and raster work as a `ProjectLogoIo`, so the ranking, the size
// guard, and the SVG sanitizer are testable without a disk or an Electron
// runtime. `createProjectLogoIo` in `src/main/project-logo-io.ts` is the real
// one.

// Ranked candidate filenames, first hit wins. Matched case-insensitively
// against the repo's top-level entries — no recursive walk.
const PROJECT_LOGO_CANDIDATES = [
  'logo.svg',
  'logo.png',
  'icon.svg',
  'icon.png',
  'favicon.svg',
  'favicon.png',
  'favicon.ico',
  // A macOS app's icon, where a native project keeps its brand rather than in
  // a `logo.*`. Ranked last, so a repo with both keeps the logo it had.
  'icon.icns',
  'appicon.icns',
] as const

// Where an app's icon conventionally sits below the top level: the `build/`
// and `resources/` folders Electron packagers read it from, and a
// hand-assembled bundle's `Resources/`. Tried in order after every top-level
// candidate, each by a single existence check on its exact path — still no
// walk.
const PROJECT_LOGO_NESTED_CANDIDATES = ['build/icon.icns', 'resources/icon.icns', 'Resources/AppIcon.icns'] as const

// Candidates above this are skipped and the next-ranked one is tried. A
// sidebar glyph is never worth a megabyte, and the bytes travel to the renderer
// as a data URI.
export const PROJECT_LOGO_MAX_BYTES = 1024 * 1024

// An `.icns` holds every size from 16px to a 1024px master, so a real one
// passes a megabyte easily even though the PNG taken from it is small. It gets
// its own bound, still low enough that a huge or bogus file is skipped
// unread; the PNG taken out of it is held to PROJECT_LOGO_MAX_BYTES.
export const PROJECT_LOGO_ICNS_MAX_BYTES = 8 * 1024 * 1024

// Raster candidates are downscaled to twice the icon slot before caching.
// The slot is --sem-icon-size-sm (16px), so 2x is 32px — enough for a Retina
// pixel ratio, small enough that the data URI stays trivial.
export const PROJECT_LOGO_RASTER_MAX_PX = 32

const SVG_MIME_TYPE = 'image/svg+xml'
const PNG_MIME_TYPE = 'image/png'
// Internal only: it marks a candidate whose bytes are a container, and is
// never what a data URI is served as.
const ICNS_MIME_TYPE = 'image/icns'

type ProjectLogoStat = {
  isFile: boolean
  size: number
  mtimeMs: number
}

export type ProjectLogoIo = {
  /** Top-level entry names of the repo. Rejects when the folder is unreadable. */
  readdir(dirPath: string): Promise<string[]>
  stat(filePath: string): Promise<ProjectLogoStat>
  readFile(filePath: string): Promise<Buffer>
  /**
   * Downscale a raster candidate to at most `maxPx` on its longest edge,
   * preserving aspect ratio. Returning the input unchanged is always valid —
   * the size guard has already run.
   */
  downscaleRaster(bytes: Buffer, mimeType: string, maxPx: number): Promise<{ bytes: Buffer; mimeType: string }>
  join(dirPath: string, name: string): string
}

// Rank the repo's top-level entries against PROJECT_LOGO_CANDIDATES,
// case-insensitively. Returns the ACTUAL entry names (not the lowercase
// candidates) in rank order, so the caller opens the file that is really on
// disk on a case-sensitive filesystem.
export function rankProjectLogoCandidates(entryNames: string[]): string[] {
  const byLowerName = new Map<string, string>()
  for (const name of entryNames) {
    const key = name.toLowerCase()
    // First entry wins, so a case-sensitive filesystem holding both `Logo.svg`
    // and `logo.svg` resolves stably to whichever the directory listed first.
    if (!byLowerName.has(key)) byLowerName.set(key, name)
  }
  const ranked: string[] = []
  for (const candidate of PROJECT_LOGO_CANDIDATES) {
    const actual = byLowerName.get(candidate)
    if (actual) ranked.push(actual)
  }
  return ranked
}

// An SVG candidate renders inside the app's own DOM, so it is held to a
// stricter bar than a raster: anything scriptable or anything that would reach
// off the machine is REJECTED outright (the caller falls through to the next
// candidate, then to the glyph). Nothing is stripped and re-served — a
// half-sanitized SVG is a worse thing to ship than no logo.
//
// Returns the source unchanged when it is clean, or null when it is rejected.
export function sanitizeProjectLogoSvg(source: string): string | null {
  const lowered = source.toLowerCase()

  // Scriptable or document-embedding elements.
  for (const element of ['<script', '<foreignobject', '<iframe', '<embed', '<object', '<set', '<handler']) {
    if (lowered.includes(element)) return null
  }
  // Inline event handlers (` onload=`, ` onclick=`, ...). The leading space is
  // what makes this an attribute name rather than a substring of path data.
  if (/\son[a-z]+\s*=/.test(lowered)) return null
  // Entity declarations are the XXE vector. A bare `<!DOCTYPE svg>` is common
  // in older exports and harmless, so only a doctype carrying an internal
  // subset is rejected along with any entity declaration.
  if (lowered.includes('<!entity')) return null
  const doctype = lowered.indexOf('<!doctype')
  if (doctype !== -1) {
    // An internal subset opens before the declaration's first `>`, so bound the
    // search there rather than scanning the whole document for a bracket.
    const declarationEnd = lowered.indexOf('>', doctype)
    const subset = lowered.indexOf('[', doctype)
    if (subset !== -1 && (declarationEnd === -1 || subset < declarationEnd)) return null
  }
  // Stylesheet imports pull bytes off the network.
  if (lowered.includes('@import')) return null
  if (lowered.includes('javascript:')) return null
  // `src` has no legitimate use in a standalone SVG asset.
  if (/\ssrc\s*=/.test(lowered)) return null

  // Every reference must be same-document. `href="#glyph"` is fine; a URL, a
  // relative path, and a nested data: payload are all rejected. Note the
  // `xmlns` declarations are namespace URIs, not references, so they are not
  // matched here — that is the whole reason this is attribute-aware rather
  // than a search for "http".
  const referenceAttribute = /(?:xlink:)?href\s*=\s*["']([^"']*)["']/g
  for (const match of lowered.matchAll(referenceAttribute)) {
    if (!match[1].trim().startsWith('#')) return null
  }
  const cssReference = /url\(\s*['"]?([^'")]*)/g
  for (const match of lowered.matchAll(cssReference)) {
    if (!match[1].trim().startsWith('#')) return null
  }

  return source
}

function toDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`
}

/**
 * Scan the top level of `folderPath`, then the few known places an app keeps
 * its icon, for the project's logo. Returns null when there is no usable
 * candidate — the caller keeps today's glyph and nothing is written anywhere.
 *
 * A candidate that is oversized, unreadable, or (for SVG) rejected by the
 * sanitizer does not end the scan: the next-ranked candidate is tried, exactly
 * as if the rejected file were not there.
 */
export async function detectProjectLogo(folderPath: string, io: ProjectLogoIo): Promise<ProjectLogo | null> {
  let entries: string[]
  try {
    entries = await io.readdir(folderPath)
  } catch {
    // A missing or unreadable project folder is not this feature's problem to
    // report — the folder check already surfaces it on the row.
    return null
  }

  const candidatePaths = [
    ...rankProjectLogoCandidates(entries).map((name) => io.join(folderPath, name)),
    ...PROJECT_LOGO_NESTED_CANDIDATES.map((relativePath) => io.join(folderPath, relativePath)),
  ]
  for (const filePath of candidatePaths) {
    // Only the io calls are caught. A candidate a user's disk will not give us
    // is an ordinary miss and falls through to the next-ranked one; a throw out
    // of the ranking, the sanitizer, or the encoding below is a bug in this
    // module and must surface rather than quietly degrade to the glyph.
    const read = await readCandidate(filePath, io)
    if (!read) continue

    const { stats, raw, mimeType } = read

    if (mimeType === SVG_MIME_TYPE) {
      const sanitized = sanitizeProjectLogoSvg(raw.toString('utf-8'))
      if (sanitized === null) continue
      return {
        path: filePath,
        mtimeMs: stats.mtimeMs,
        dataUrl: toDataUrl(Buffer.from(sanitized, 'utf-8'), mimeType),
      }
    }

    // Nothing downstream decodes an `.icns`; the PNG inside it is the logo.
    const raster = mimeType === ICNS_MIME_TYPE ? extractIcnsPng(raw, PROJECT_LOGO_RASTER_MAX_PX) : raw
    if (!raster || raster.byteLength > PROJECT_LOGO_MAX_BYTES) continue
    // A file that declares a vast picture is not a logo: the window would decode it.
    if (!imageWithinDecodeLimits(raster)) continue
    const downscaled = await downscaleCandidate(raster, mimeType === ICNS_MIME_TYPE ? PNG_MIME_TYPE : mimeType, io)
    return {
      path: filePath,
      mtimeMs: stats.mtimeMs,
      dataUrl: toDataUrl(downscaled.bytes, downscaled.mimeType),
    }
  }

  return null
}

type ReadCandidate = { stats: ProjectLogoStat; raw: Buffer; mimeType: string }

// Stat + read one candidate, applying the guards. Null means "not a usable
// candidate" for every reason a disk can produce: gone, not a file, oversized,
// or an extension we do not serve.
async function readCandidate(filePath: string, io: ProjectLogoIo): Promise<ReadCandidate | null> {
  try {
    const stats = await io.stat(filePath)
    if (!stats.isFile) return null
    const icns = filePath.toLowerCase().endsWith('.icns')
    if (stats.size > (icns ? PROJECT_LOGO_ICNS_MAX_BYTES : PROJECT_LOGO_MAX_BYTES)) return null

    // The app's one extension→image-mime answer, shared with image preview,
    // which has no use for an `.icns`.
    const mimeType = icns ? ICNS_MIME_TYPE : imageMimeType(filePath)
    if (!mimeType) return null

    return { stats, raw: await io.readFile(filePath), mimeType }
  } catch {
    return null
  }
}

// A downscale that cannot run is not a reason to drop the logo — the 1 MB guard
// already bounds what we would serve — so a failing resizer falls back to the
// candidate's own bytes rather than to the glyph.
async function downscaleCandidate(
  raw: Buffer,
  mimeType: string,
  io: ProjectLogoIo,
): Promise<{ bytes: Buffer; mimeType: string }> {
  try {
    return await io.downscaleRaster(raw, mimeType, PROJECT_LOGO_RASTER_MAX_PX)
  } catch {
    return { bytes: raw, mimeType }
  }
}

export type ProjectLogoResolver = {
  resolve(folderPath: string): Promise<ProjectLogo | null>
}

/**
 * `detectProjectLogo` behind a hit cache. There is no watcher — the check runs
 * when a project is opened, and the cached entry is only trusted while the
 * resolved file still exists at the same mtime. Misses are never cached, so
 * dropping a `logo.svg` into a repo and reopening the project picks it up
 * without a restart.
 */
export function createProjectLogoResolver(io: ProjectLogoIo): ProjectLogoResolver {
  const cache = new Map<string, ProjectLogo>()

  return {
    async resolve(folderPath: string): Promise<ProjectLogo | null> {
      if (!folderPath) return null

      const cached = cache.get(folderPath)
      if (cached) {
        try {
          const stats = await io.stat(cached.path)
          if (stats.isFile && stats.mtimeMs === cached.mtimeMs) return cached
        } catch {
          // The cached file went away; fall through to a fresh scan.
        }
        cache.delete(folderPath)
      }

      const detected = await detectProjectLogo(folderPath, io)
      if (detected) cache.set(folderPath, detected)
      return detected
    },
  }
}
