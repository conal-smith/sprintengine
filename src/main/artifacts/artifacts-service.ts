import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'

import { parseArtifactsRepositoryUrl, type ArtifactsSettings, type ArtifactsTestResult } from '../../shared/artifacts'
import { collectArtifactBundle, type ArtifactBundle } from './artifact-bundle'
import {
  ARTIFACTS_DIR,
  ARTIFACTS_SCHEMA,
  normalizeTags,
  readArtifactRecord,
  readArtifactRecords,
  slugify,
  SLUG_PATTERN,
  summarizeArtifact,
  writeArtifactRecord,
  writeArtifactsManifest,
  writeArtifactsSite,
  type ArtifactRecord,
  type ArtifactsSiteTemplate,
  type ArtifactSource,
  type ArtifactSummary,
} from './artifact-site'
import type { ArtifactsGit } from './artifacts-store'
import { resolveArtifactsHost, type ArtifactsHost, type ArtifactsHostDeps } from './artifacts-hosts'

// What the `artifacts.*` tools do, on whichever host Settings ▸ Artifacts
// names. A publish gathers the page and what it references
// (artifact-bundle.ts), lays it out in a folder of its own and takes its
// picture there, all before the host's queue is entered; then, in one change
// to the site's source, it writes the version, the record, the manifest and
// the site's own files, and the host puts it live. A change can be made more
// than once when another publish raced it (artifacts-store.ts), so everything
// inside it is worked out from the tree it is given.

/** A picture of a page: its first screen, as PNG. Null when none could be taken. */
export type ArtifactThumbnailer = (input: { file: string; width: number; height: number }) => Promise<Buffer | null>

export type ArtifactsServiceDeps = {
  settings: () => ArtifactsSettings
  hostDeps: ArtifactsHostDeps
  siteTemplate: () => Promise<ArtifactsSiteTemplate>
  thumbnailer?: ArtifactThumbnailer
  /** git, to read where a page came from (its repository, branch and commit). */
  git?: ArtifactsGit
  now?: () => Date
}

export type ArtifactSourceInput = { project?: string; repo?: string; branch?: string; commit?: string }

export type ArtifactPublishInput = ArtifactSourceInput & {
  path: string
  entry?: string
  stylesheets?: string[]
  title: string
  description?: string
  tags?: string[]
  /** An existing artifact to publish a new version of; a new one gets a slug from its title. */
  slug?: string
  /** A picture to use instead of the one Studio takes: PNG, JPEG or WebP. */
  thumbnail?: string
}

export type ArtifactUpdateInput = Partial<Omit<ArtifactPublishInput, 'slug'>> & { slug: string }

export type ArtifactListInput = { query?: string; tags?: string[]; project?: string; limit?: number }

export type ArtifactView = ArtifactSummary & { url: string; pageUrl: string }

type Failure = { ok: false; code: string; message: string }

const THUMBNAIL_SIZE = { width: 1280, height: 800 }
const THUMBNAIL_TYPES: Record<string, string> = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.webp': 'webp' }
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024

/**
 * A path in the site, each segment escaped, under the site's own address
 * (which may be a sub-path, so it is joined, never rooted). A query is given
 * apart, so its `?` is never escaped into the path.
 */
export function siteUrlFor(siteUrl: string, path: string, query?: Record<string, string>): string {
  const encoded = path
    .split('/')
    .map((segment) => (segment ? encodeURIComponent(segment) : segment))
    .join('/')
  const url = new URL(encoded.replace(/^\/+/, ''), siteUrl)
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  return url.toString()
}

function viewOf(siteUrl: string, record: ArtifactRecord): ArtifactView {
  const summary = summarizeArtifact(record)
  return {
    ...summary,
    url: siteUrlFor(siteUrl, `${ARTIFACTS_DIR}/${record.slug}/`),
    pageUrl: siteUrlFor(siteUrl, `${ARTIFACTS_DIR}/${record.slug}/${summary.entry}`),
  }
}

/** A version's folder name, inside the artifact's. */
function versionDir(version: number): string {
  return `v${version}`
}

/** A relative path that stays inside its folder: no `..`, no root, no drive. */
function isContainedPath(path: string): boolean {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every((segment) => segment !== '..' && segment !== '' && segment !== '.')
}

function commitUrlFor(
  repo: string | undefined,
  host: string | undefined,
  commit: string | undefined,
): string | undefined {
  if (!repo || !host || !commit || !/^[0-9a-f]{7,40}$/i.test(commit)) return undefined
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9._-]+$/.test(repo)) return undefined
  if (host === 'gitlab.com') return `https://${host}/${repo}/-/commit/${commit}`
  if (host === 'bitbucket.org') return `https://${host}/${repo}/commits/${commit}`
  return `https://${host}/${repo}/commit/${commit}`
}

export function createArtifactsService(deps: ArtifactsServiceDeps) {
  const now = deps.now ?? (() => new Date())
  // One host per configuration, kept: its store's queue is what keeps two
  // changes from this Studio apart.
  let cached: { key: string; host: ArtifactsHost } | null = null

  function host(): { ok: true; host: ArtifactsHost } | Failure {
    const settings = deps.settings()
    const key = JSON.stringify(settings)
    if (cached?.key === key) return { ok: true, host: cached.host }
    const resolved = resolveArtifactsHost(settings, deps.hostDeps)
    if (!resolved.ok) return resolved
    cached = { key, host: resolved.host }
    return resolved
  }

  /** Where a page came from, read from its checkout, with what the caller said winning. */
  async function sourceOf(
    path: string,
    given: ArtifactSourceInput,
  ): Promise<{ project: string; source: ArtifactSource }> {
    const git = deps.git
    const cwd = (await stat(path).then(
      (info) => info.isDirectory(),
      () => false,
    ))
      ? path
      : dirname(path)
    const ask = async (args: string[]) => {
      if (!git) return ''
      const answer = await git(cwd, args).catch(() => null)
      return answer?.ok ? answer.stdout.trim() : ''
    }
    const top = await ask(['rev-parse', '--show-toplevel'])
    const detected = top
      ? {
          commit: await ask(['rev-parse', 'HEAD']),
          branch: await ask(['symbolic-ref', '--quiet', '--short', 'HEAD']),
          remote: await ask(['remote', 'get-url', 'origin']),
        }
      : { commit: '', branch: '', remote: '' }
    const remote = detected.remote ? parseArtifactsRepositoryUrl(detected.remote) : null
    const givenRepo = given.repo?.trim() ? parseArtifactsRepositoryUrl(given.repo.trim()) : null
    const repository = givenRepo?.ok ? givenRepo.repository : remote?.ok ? remote.repository : null
    const repo = repository ? `${repository.owner}/${repository.name}` : given.repo?.trim() || undefined
    const commit = given.commit?.trim() || detected.commit || undefined
    const branch = given.branch?.trim() || detected.branch || undefined
    const commitUrl =
      repository && repository.transport !== 'file'
        ? commitUrlFor(repo, repository.host.replace(/:\d+$/, ''), commit)
        : undefined
    const project = given.project?.trim() || repository?.name || (top ? (top.split(/[\\/]/).pop() ?? '') : '')
    return {
      project,
      source: {
        ...(repo ? { repo } : {}),
        ...(branch ? { branch } : {}),
        ...(commit ? { commit } : {}),
        ...(commitUrl ? { commitUrl } : {}),
      },
    }
  }

  /** The page laid out in a folder of its own, with its picture taken there. */
  async function stage(
    input: Pick<ArtifactPublishInput, 'path' | 'entry' | 'stylesheets' | 'thumbnail'>,
  ): Promise<
    { ok: true; dir: string; bundle: ArtifactBundle; thumbnail: { bytes: Buffer; type: string } | null } | Failure
  > {
    const collected = await collectArtifactBundle({
      path: input.path,
      ...(input.entry ? { entry: input.entry } : {}),
      ...(input.stylesheets?.length ? { stylesheets: input.stylesheets } : {}),
    })
    if (!collected.ok) return { ok: false, code: 'invalid_page', message: collected.message }
    const bundle = collected.bundle
    let given: { bytes: Buffer; type: string } | null = null
    if (input.thumbnail) {
      const type = THUMBNAIL_TYPES[extname(input.thumbnail).toLowerCase()]
      const info = isAbsolute(input.thumbnail) ? await stat(input.thumbnail).catch(() => null) : null
      if (!type || !info?.isFile()) {
        return {
          ok: false,
          code: 'invalid_arguments',
          message: '"thumbnail" is an absolute path to a PNG, JPEG or WebP picture.',
        }
      }
      if (info.size > MAX_THUMBNAIL_BYTES)
        return { ok: false, code: 'invalid_arguments', message: 'The thumbnail is over 5 MB.' }
      given = { bytes: await readFile(input.thumbnail), type }
    }
    const dir = await mkdtemp(join(tmpdir(), 'artifact-stage-'))
    for (const file of bundle.files) {
      if (!isContainedPath(file.path)) {
        await rm(dir, { recursive: true, force: true })
        return { ok: false, code: 'invalid_page', message: `${file.path} would be written outside the artifact.` }
      }
      const target = join(dir, ...file.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      if (file.content) await writeFile(target, file.content)
      else await cp(file.source, target)
    }
    let thumbnail = given
    if (!thumbnail && deps.thumbnailer) {
      const taken = await deps
        .thumbnailer({ file: join(dir, ...bundle.entry.split('/')), ...THUMBNAIL_SIZE })
        .catch(() => null)
      if (taken) thumbnail = { bytes: taken, type: 'png' }
    }
    return { ok: true, dir, bundle, thumbnail }
  }

  /** Write a new version of an artifact into the tree; the record is answered, not yet written. */
  async function writeVersion(
    root: string,
    record: ArtifactRecord,
    staged: { dir: string; bundle: ArtifactBundle; thumbnail: { bytes: Buffer; type: string } | null },
    source: ArtifactSource,
    at: string,
  ): Promise<ArtifactRecord> {
    const version = (record.versions.length ? Math.max(...record.versions.map((entry) => entry.version)) : 0) + 1
    const folder = join(root, ARTIFACTS_DIR, record.slug)
    const target = join(folder, versionDir(version))
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    await cp(staged.dir, target, { recursive: true })
    let thumbnail = record.thumbnail
    if (staged.thumbnail) {
      for (const type of new Set(Object.values(THUMBNAIL_TYPES)))
        await rm(join(folder, `thumbnail.${type}`), { force: true })
      await writeFile(join(folder, `thumbnail.${staged.thumbnail.type}`), staged.thumbnail.bytes)
      thumbnail = `thumbnail.${staged.thumbnail.type}?v=${version}`
    }
    return {
      ...record,
      source,
      updatedAt: at,
      version,
      thumbnail,
      versions: [
        ...record.versions,
        {
          version,
          publishedAt: at,
          entry: `${versionDir(version)}/${staged.bundle.entry}`,
          files: staged.bundle.files.length,
          bytes: staged.bundle.bytes,
          source,
          ...(staged.bundle.warnings.length ? { warnings: staged.bundle.warnings } : {}),
        },
      ],
    }
  }

  /** The site's own files and its manifest, brought up to date on the tree. */
  async function finishTree(root: string, active: ArtifactHostLike): Promise<void> {
    const settings = deps.settings()
    const repository =
      settings.provider === 'github-pages'
        ? settings.github.repositoryUrl
        : settings.cloudflare.repositoryUrl || `Cloudflare Pages project ${settings.cloudflare.projectName}`
    await writeArtifactsSite(root, await deps.siteTemplate(), { repository, siteUrl: active.siteUrl })
    await writeArtifactsManifest(root)
  }

  type ArtifactHostLike = Pick<ArtifactsHost, 'siteUrl'>

  function liveNote(active: ArtifactsHost, notLive: string | undefined): string {
    if (notLive) return notLive
    return active.kind === 'github-pages'
      ? 'Pushed to main; GitHub Pages usually shows it within a minute or two.'
      : 'Uploaded to Cloudflare Pages.'
  }

  return {
    /** Set up an empty site: README, gallery and manifest, with no artifacts. */
    async initialize(): Promise<{ ok: true; commit: string | null; siteUrl: string; note: string } | Failure> {
      const resolved = host()
      if (!resolved.ok) return resolved
      const active = resolved.host
      const changed = await active.change(async (root) => {
        await finishTree(root, active)
        return { message: 'Set up the artifacts site', value: true }
      })
      if (!changed.ok) return { ok: false, code: 'publish_failed', message: changed.message }
      return { ok: true, commit: changed.commit, siteUrl: active.siteUrl, note: liveNote(active, changed.notLive) }
    },

    async publish(input: ArtifactPublishInput) {
      const resolved = host()
      if (!resolved.ok) return resolved
      const active = resolved.host
      if (input.slug !== undefined && !SLUG_PATTERN.test(input.slug)) {
        return { ok: false as const, code: 'invalid_arguments', message: `"${input.slug}" is not an artifact slug.` }
      }
      const staged = await stage(input)
      if (!staged.ok) return staged
      try {
        const { project, source } = await sourceOf(resolve(input.path), input)
        const tags = normalizeTags(input.tags ?? [])
        const changed = await active.change(async (root) => {
          const at = now().toISOString()
          let record = input.slug ? await readArtifactRecord(root, input.slug) : null
          const created = record === null
          if (!record) {
            let slug = input.slug ?? slugify(input.title)
            if (!input.slug) {
              const base = slug.slice(0, 56).replace(/-+$/, '')
              for (
                let n = 2;
                await stat(join(root, ARTIFACTS_DIR, slug)).then(
                  () => true,
                  () => false,
                );
                n += 1
              )
                slug = `${base}-${n}`
            }
            record = {
              schema: ARTIFACTS_SCHEMA,
              slug,
              title: input.title,
              description: input.description ?? '',
              tags,
              project,
              source,
              createdAt: at,
              updatedAt: at,
              version: 0,
              thumbnail: null,
              versions: [],
            }
          } else {
            record = {
              ...record,
              title: input.title,
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.tags !== undefined ? { tags } : {}),
              ...(input.project !== undefined || !record.project ? { project } : {}),
            }
          }
          const next = await writeVersion(root, record, staged, source, at)
          await writeArtifactRecord(root, next)
          await finishTree(root, active)
          return {
            message: `Publish ${next.slug} v${next.version}: ${next.title}`,
            value: { record: next, created },
          }
        })
        if (!changed.ok) return { ok: false as const, code: 'publish_failed', message: changed.message }
        if (!changed.value) return { ok: false as const, code: 'publish_failed', message: 'Nothing was published.' }
        const { record, created } = changed.value
        return {
          ok: true as const,
          created,
          artifact: viewOf(active.siteUrl, record),
          versionUrl: siteUrlFor(active.siteUrl, `${ARTIFACTS_DIR}/${record.slug}/`, { v: String(record.version) }),
          commit: changed.commit,
          live: !changed.notLive,
          note: liveNote(active, changed.notLive),
          thumbnail: staged.thumbnail !== null,
          warnings: staged.bundle.warnings,
        }
      } finally {
        await rm(staged.dir, { recursive: true, force: true })
      }
    },

    async update(input: ArtifactUpdateInput) {
      const resolved = host()
      if (!resolved.ok) return resolved
      const active = resolved.host
      if (!SLUG_PATTERN.test(input.slug)) {
        return { ok: false as const, code: 'invalid_arguments', message: `"${input.slug}" is not an artifact slug.` }
      }
      const staged = input.path ? await stage({ ...input, path: input.path }) : null
      if (staged && !staged.ok) return staged
      try {
        const sourced = staged?.ok ? await sourceOf(resolve(input.path as string), input) : null
        const changed = await active.change(async (root) => {
          const record = await readArtifactRecord(root, input.slug)
          if (!record) return { failure: `There is no artifact "${input.slug}". artifacts.list names them.` }
          const at = now().toISOString()
          let next: ArtifactRecord = {
            ...record,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
            ...(input.project !== undefined ? { project: input.project.trim() } : {}),
          }
          const what: string[] = []
          if (staged?.ok && sourced) {
            next = await writeVersion(root, next, staged, sourced.source, at)
            what.push(`v${next.version}`)
          } else if (input.thumbnail) {
            return { failure: 'A new thumbnail comes with a new version: pass "path" as well.' }
          }
          if (input.title !== undefined && input.title !== record.title) what.push('title')
          if (input.description !== undefined && input.description !== record.description) what.push('description')
          if (input.tags !== undefined && next.tags.join(',') !== record.tags.join(',')) what.push('tags')
          if (input.project !== undefined && next.project !== record.project) what.push('project')
          if (!what.length) {
            // Nothing to change; the host still puts live anything an earlier change left behind.
            await finishTree(root, active)
            return { message: `Refresh the artifacts site`, value: { record, changed: [] as string[] } }
          }
          if (!staged) next = { ...next, updatedAt: at }
          await writeArtifactRecord(root, next)
          await finishTree(root, active)
          return { message: `Update ${next.slug}: ${what.join(', ')}`, value: { record: next, changed: what } }
        })
        if (!changed.ok)
          return {
            ok: false as const,
            code: changed.message.startsWith('There is no artifact') ? 'unknown_artifact' : 'publish_failed',
            message: changed.message,
          }
        if (!changed.value) return { ok: false as const, code: 'publish_failed', message: 'Nothing was changed.' }
        return {
          ok: true as const,
          changed: changed.value.changed,
          artifact: viewOf(active.siteUrl, changed.value.record),
          commit: changed.commit,
          live: !changed.notLive,
          note: liveNote(active, changed.notLive),
          warnings: staged?.ok ? staged.bundle.warnings : [],
        }
      } finally {
        if (staged?.ok) await rm(staged.dir, { recursive: true, force: true })
      }
    },

    async remove(slug: string) {
      const resolved = host()
      if (!resolved.ok) return resolved
      const active = resolved.host
      if (!SLUG_PATTERN.test(slug))
        return { ok: false as const, code: 'invalid_arguments', message: `"${slug}" is not an artifact slug.` }
      const changed = await active.change(async (root) => {
        const record = await readArtifactRecord(root, slug)
        if (!record) return { failure: `There is no artifact "${slug}". artifacts.list names them.` }
        // Removed from the tree; the folder is only ever the slug's own.
        const folder = join(root, ARTIFACTS_DIR, slug)
        if (!folder.startsWith(`${join(root, ARTIFACTS_DIR)}${sep}`))
          return { failure: `"${slug}" is not an artifact slug.` }
        await rm(folder, { recursive: true, force: true })
        await finishTree(root, active)
        return { message: `Remove ${slug}: ${record.title}`, value: record }
      })
      if (!changed.ok) {
        return {
          ok: false as const,
          code: changed.message.startsWith('There is no artifact') ? 'unknown_artifact' : 'publish_failed',
          message: changed.message,
        }
      }
      return {
        ok: true as const,
        removed: slug,
        commit: changed.commit,
        live: !changed.notLive,
        note: changed.commit
          ? `Removed from the site; it stays in the repository’s history (${changed.commit.slice(0, 12)} and before).`
          : liveNote(active, changed.notLive),
      }
    },

    async list(input: ArtifactListInput = {}) {
      const resolved = host()
      if (!resolved.ok) return resolved
      const active = resolved.host
      const read = await active.read((root) => readArtifactRecords(root))
      if (!read.ok) return { ok: false as const, code: 'unavailable', message: read.message }
      const words = (input.query ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s+/).filter(Boolean)
      const tags = normalizeTags(input.tags ?? [])
      const project = input.project?.trim().toLowerCase()
      const matching = read.value.filter((record) => {
        if (project && record.project.toLowerCase() !== project) return false
        if (tags.some((tag) => !record.tags.includes(tag))) return false
        if (!words.length) return true
        const text = [
          record.title,
          record.description,
          record.project,
          record.slug,
          record.tags.join(' '),
          record.source.branch ?? '',
        ]
          .join(' ')
          .normalize('NFKD')
          .replace(/[̀-ͯ]/g, '')
          .toLowerCase()
        return words.every((word) => text.includes(word))
      })
      const limit = Math.max(1, Math.min(200, input.limit ?? 50))
      return {
        ok: true as const,
        total: matching.length,
        artifacts: matching.slice(0, limit).map((record) => viewOf(active.siteUrl, record)),
        siteUrl: active.siteUrl,
        ...(read.stale
          ? { note: `Could not reach ${active.label}; this is the list as this machine last saw it.` }
          : {}),
      }
    },

    async get(slug: string) {
      const resolved = host()
      if (!resolved.ok) return resolved
      const active = resolved.host
      if (!SLUG_PATTERN.test(slug))
        return { ok: false as const, code: 'invalid_arguments', message: `"${slug}" is not an artifact slug.` }
      const read = await active.read((root) => readArtifactRecord(root, slug))
      if (!read.ok) return { ok: false as const, code: 'unavailable', message: read.message }
      if (!read.value)
        return {
          ok: false as const,
          code: 'unknown_artifact',
          message: `There is no artifact "${slug}". artifacts.list names them.`,
        }
      const record = read.value
      return {
        ok: true as const,
        artifact: {
          ...viewOf(active.siteUrl, record),
          versions: record.versions.map((entry) => ({
            ...entry,
            url: siteUrlFor(active.siteUrl, `${ARTIFACTS_DIR}/${record.slug}/`, { v: String(entry.version) }),
            pageUrl: siteUrlFor(active.siteUrl, `${ARTIFACTS_DIR}/${record.slug}/${entry.entry}`),
          })),
        },
        ...(read.stale
          ? { note: `Could not reach ${active.label}; this is the record as this machine last saw it.` }
          : {}),
      }
    },

    async test(): Promise<ArtifactsTestResult | Failure> {
      const resolved = host()
      if (!resolved.ok) return resolved
      return resolved.host.test()
    },
  }
}

export type ArtifactsService = ReturnType<typeof createArtifactsService>
