import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { isRecord } from '../../shared/records'

// The artifacts repository's layout, which is also its website: GitHub Pages
// serves the main branch as it is, with no build step, so every file a reader
// needs is written here as it will be served.
//
//   README.md          what the repository is, and where its site is
//   index.html         the gallery, which reads artifacts.json
//   artifacts.json     every artifact's summary, newest first
//   assets/            the gallery's and the viewer's stylesheet and scripts
//   a/<slug>/          one artifact:
//     index.html       its viewer (the same file for every artifact)
//     meta.json        its record, every version listed
//     thumbnail.png    a picture of its latest version
//     v1/, v2/, …      each version's page and the files it references
//   .nojekyll          serve every file as it is (Pages would otherwise drop
//                      folders such as node_modules a page's fonts sit in)
//
// The manifest is rebuilt from the meta.json files on every write, so two
// publishes that raced each other and were replayed one after the other
// (artifacts-repo.ts) cannot leave it disagreeing with what is there.

export const ARTIFACTS_SCHEMA = 1

export type ArtifactSource = {
  /** `owner/name` on GitHub, or whatever the remote was called. */
  repo?: string
  branch?: string
  commit?: string
  /** The commit on GitHub, when `repo` is a GitHub repository. */
  commitUrl?: string
}

export type ArtifactVersion = {
  version: number
  publishedAt: string
  /** The page, relative to the artifact's folder: `v2/patterns/your-stars.html`. */
  entry: string
  files: number
  bytes: number
  source: ArtifactSource
  /** What may not work the same as it did on disk (a page loading from the network, a missing file). */
  warnings?: string[]
}

export type ArtifactRecord = {
  schema: typeof ARTIFACTS_SCHEMA
  slug: string
  title: string
  description: string
  tags: string[]
  project: string
  /** The latest version's source. */
  source: ArtifactSource
  createdAt: string
  updatedAt: string
  /** The latest version's number. */
  version: number
  /** Relative to the artifact's folder, with a cache-breaking query; null when none could be made. */
  thumbnail: string | null
  versions: ArtifactVersion[]
}

export type ArtifactSummary = Omit<ArtifactRecord, 'schema' | 'versions'> & {
  /** The latest version's page, relative to the artifact's folder. */
  entry: string
  versionCount: number
}

export type ArtifactsManifest = {
  schema: typeof ARTIFACTS_SCHEMA
  generator: string
  updatedAt: string
  artifacts: ArtifactSummary[]
}

/** The files Studio writes into the repository, as they ship in `resources/artifacts-site`. */
export type ArtifactsSiteTemplate = {
  index: string
  viewer: string
  assets: Map<string, string>
}

/** The marker on a page Studio wrote, so a gallery the owner replaced by hand is left alone. */
const SITE_MARKER = 'data-studio-artifacts-site'
export const ARTIFACTS_DIR = 'a'
export const MANIFEST_FILE = 'artifacts.json'
export const META_FILE = 'meta.json'

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

/** A slug from a title: lowercase words joined by hyphens, at most 60 characters, cut at a word. */
export function slugify(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  let slug = ''
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > 60) break
    slug = next
  }
  return slug || words[0]?.slice(0, 60) || 'artifact'
}

/** Tags as stored: trimmed, lowercase, hyphenated, unique, in the order given. */
export function normalizeTags(tags: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const clean = tag.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40)
    if (clean) seen.add(clean)
  }
  return [...seen].slice(0, 20)
}

export async function readArtifactsSiteTemplate(siteDir: string): Promise<ArtifactsSiteTemplate> {
  const assets = new Map<string, string>()
  for (const name of await readdir(join(siteDir, 'assets'))) {
    if (!name.startsWith('.')) assets.set(name, await readFile(join(siteDir, 'assets', name), 'utf8'))
  }
  return {
    index: await readFile(join(siteDir, 'index.html'), 'utf8'),
    viewer: await readFile(join(siteDir, 'artifact.html'), 'utf8'),
    assets,
  }
}

async function readText(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

async function writeIfChanged(path: string, content: string): Promise<void> {
  if ((await readText(path)) === content) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export function renderArtifactsReadme(settings: { repository: string; siteUrl: string }): string {
  return [
    '# Artifacts',
    '',
    `Pages, mockups and prototypes published by agents in SprintEngine Studio, to open from any device.`,
    '',
    `**Open the gallery: ${settings.siteUrl}**`,
    '',
    'Each artifact has a stable address, `a/<slug>/`, which opens its latest version with a',
    'header for picking an earlier one. Every version stays where it was published.',
    '',
    '## Layout',
    '',
    '| Path | What it is |',
    '| --- | --- |',
    '| `index.html` | The gallery: search, tags, projects, grid or list. |',
    '| `artifacts.json` | Every artifact, newest first. The gallery reads it. |',
    '| `a/<slug>/meta.json` | One artifact: title, tags, source commit, every version. |',
    '| `a/<slug>/v<n>/` | One version: the page and the files it references, as laid out on disk. |',
    '| `a/<slug>/thumbnail.png` | A picture of the latest version. |',
    '| `assets/` | The gallery’s stylesheet and scripts. |',
    '',
    'The site is static and served from `main` as it is: there is no build step.',
    'Studio writes this repository with git, one commit per change, so the history',
    'is the record of what was published, changed or removed, and when.',
    '',
    `Source: \`${settings.repository}\``,
    '',
  ].join('\n')
}

/**
 * The site's own files: the gallery while it is still Studio's (it carries
 * the marker), the assets, every artifact's viewer, and the README once.
 */
export async function writeArtifactsSite(
  checkout: string,
  template: ArtifactsSiteTemplate,
  settings: { repository: string; siteUrl: string },
): Promise<void> {
  const index = await readText(join(checkout, 'index.html'))
  if (index === null || index.includes(SITE_MARKER)) await writeIfChanged(join(checkout, 'index.html'), template.index)
  for (const [name, content] of template.assets) await writeIfChanged(join(checkout, 'assets', name), content)
  await writeIfChanged(join(checkout, '.nojekyll'), '')
  if ((await readText(join(checkout, 'README.md'))) === null) {
    await writeIfChanged(join(checkout, 'README.md'), renderArtifactsReadme(settings))
  }
  for (const slug of await listArtifactSlugs(checkout)) {
    await writeIfChanged(join(checkout, ARTIFACTS_DIR, slug, 'index.html'), template.viewer)
  }
}

export async function listArtifactSlugs(checkout: string): Promise<string[]> {
  const entries = await readdir(join(checkout, ARTIFACTS_DIR), { withFileTypes: true }).catch(() => [])
  return entries.filter((entry) => entry.isDirectory() && SLUG_PATTERN.test(entry.name)).map((entry) => entry.name)
}

function parseRecord(raw: unknown, slug: string): ArtifactRecord | null {
  if (!isRecord(raw) || raw.slug !== slug || typeof raw.title !== 'string' || !Array.isArray(raw.versions)) return null
  const versions = raw.versions.filter(
    (entry): entry is ArtifactVersion =>
      isRecord(entry) && typeof entry.version === 'number' && typeof entry.entry === 'string',
  )
  if (!versions.length) return null
  return {
    schema: ARTIFACTS_SCHEMA,
    slug,
    title: raw.title,
    description: typeof raw.description === 'string' ? raw.description : '',
    tags: Array.isArray(raw.tags) ? normalizeTags(raw.tags) : [],
    project: typeof raw.project === 'string' ? raw.project : '',
    source: isRecord(raw.source) ? (raw.source as ArtifactSource) : {},
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : versions[0].publishedAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : versions[versions.length - 1].publishedAt,
    version: Math.max(...versions.map((entry) => entry.version)),
    thumbnail: typeof raw.thumbnail === 'string' ? raw.thumbnail : null,
    versions: [...versions].sort((a, b) => a.version - b.version),
  }
}

export async function readArtifactRecord(checkout: string, slug: string): Promise<ArtifactRecord | null> {
  if (!SLUG_PATTERN.test(slug)) return null
  const text = await readText(join(checkout, ARTIFACTS_DIR, slug, META_FILE))
  if (text === null) return null
  try {
    return parseRecord(JSON.parse(text), slug)
  } catch {
    return null
  }
}

export async function writeArtifactRecord(checkout: string, record: ArtifactRecord): Promise<void> {
  await writeIfChanged(join(checkout, ARTIFACTS_DIR, record.slug, META_FILE), `${JSON.stringify(record, null, 2)}\n`)
}

/** Every artifact on record, newest first. */
export async function readArtifactRecords(checkout: string): Promise<ArtifactRecord[]> {
  const records: ArtifactRecord[] = []
  for (const slug of await listArtifactSlugs(checkout)) {
    const record = await readArtifactRecord(checkout, slug)
    if (record) records.push(record)
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.slug.localeCompare(b.slug))
}

export function summarizeArtifact(record: ArtifactRecord): ArtifactSummary {
  const { schema: _schema, versions, ...rest } = record
  const latest = versions.find((entry) => entry.version === record.version) ?? versions[versions.length - 1]
  return { ...rest, entry: latest.entry, versionCount: versions.length }
}

/** artifacts.json, rebuilt from the records. Unchanged records leave it unchanged. */
export async function writeArtifactsManifest(checkout: string): Promise<ArtifactsManifest> {
  const records = await readArtifactRecords(checkout)
  const manifest: ArtifactsManifest = {
    schema: ARTIFACTS_SCHEMA,
    generator: 'SprintEngine Studio',
    updatedAt: records[0]?.updatedAt ?? new Date(0).toISOString(),
    artifacts: records.map(summarizeArtifact),
  }
  await writeIfChanged(join(checkout, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}
