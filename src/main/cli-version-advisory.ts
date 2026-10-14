// Is an installed agent CLI behind the version its registry publishes?
// Ask npm for `latest`, compare loosely to what `--version` printed, and name
// the command that would update it. Loosely, because a CLI is free to print a
// build suffix or a `v` prefix that the registry version does not carry, and a
// false "you are behind" is worse than no advisory at all.
//
// Pure apart from the fetcher, which is injected. The registry answer is cached
// in memory for an hour per package so a focus-driven availability refresh
// never re-asks npm. A registry that does not answer within the timeout yields
// `unknown`, never a failure that could block availability detection.
import type {
  CliAvailability,
  CliUpdateCommand,
  CliVersionAdvisory,
  CliVersionAdvisoryMap,
} from '../shared/electron-api'
import { existsSync, realpathSync } from 'node:fs'
import { win32 } from 'node:path'

import { LOCAL_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { PluginManifest } from '../shared/plugin-manifest'
import { compareSemver } from '../shared/semver'

const NPM_LATEST_CACHE_TTL_MS = 60 * 60 * 1_000
const NPM_LATEST_TIMEOUT_MS = 4_000

export type NpmLatestFetch = (url: string, init: RequestInit) => Promise<Response>

type CacheEntry = { version: string | null; expiresAt: number }
const npmLatestCache = new Map<string, CacheEntry>()

export function clearNpmLatestCache(): void {
  npmLatestCache.clear()
}

export async function fetchNpmLatestVersion(
  packageName: string,
  deps: { fetcher?: NpmLatestFetch; now?: () => number; timeoutMs?: number; force?: boolean } = {},
): Promise<string | null> {
  const now = deps.now ?? Date.now
  const cached = npmLatestCache.get(packageName)
  if (!deps.force && cached && cached.expiresAt > now()) return cached.version

  const fetcher = deps.fetcher ?? defaultFetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? NPM_LATEST_TIMEOUT_MS)
  let version: string | null = null
  try {
    const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.ok) {
      const payload = (await response.json()) as { version?: unknown }
      version = typeof payload.version === 'string' && payload.version.trim() ? payload.version.trim() : null
    }
  } catch {
    version = null
  } finally {
    clearTimeout(timeout)
  }
  // A miss is cached too: an unreachable registry is asked once an hour, not
  // once per refresh.
  npmLatestCache.set(packageName, { version, expiresAt: now() + NPM_LATEST_CACHE_TTL_MS })
  return version
}

export function deriveCliVersionStatus(
  currentVersion: string | null,
  latestVersion: string | null,
): CliVersionAdvisory['status'] {
  const compared = compareSemver(currentVersion, latestVersion)
  if (compared === null) return 'unknown'
  return compared < 0 ? 'behind_latest' : 'current'
}

// Homebrew installs land under its prefix (Cellar/Caskroom or the linked bin);
// a binary there is upgraded with brew, not with npm.
export function isHomebrewPath(path: string | null | undefined): boolean {
  if (!path) return false
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return (
    normalized.includes('/homebrew/cellar/') ||
    normalized.includes('/homebrew/caskroom/') ||
    normalized.startsWith('/opt/homebrew/bin/') ||
    normalized.startsWith('/usr/local/cellar/') ||
    normalized.startsWith('/home/linuxbrew/.linuxbrew/')
  )
}

// What the chooser may read of the machine the CLI is on: where a path ends up
// once every symlink is followed, and whether a file is there. Null for a
// machine whose files main cannot read (a WSL distribution).
export type CliInstallFs = {
  realPath: (path: string) => string | null
  exists: (path: string) => boolean
}

export const localCliInstallFs: CliInstallFs = {
  realPath: (path) => {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  },
  exists: (path) => existsSync(path),
}

// Package managers the update button does not drive. Each keeps its own global
// tree (a Volta image even lays one out as `lib/node_modules/<pkg>`), and
// `npm install -g` would put a second copy beside it that PATH may never reach.
//
// mise is read three ways. Its shim (`mise/shims/<cli>`) is a link to the mise
// binary itself, so the shim's real path is mise, wherever MISE_DATA_DIR put
// the shims; a Homebrew mise sits in a Cellar keg, and without this the keg
// would offer `brew upgrade` of a formula nobody installed. Its npm backend
// lays a tool version out as `mise/installs/<tool>/<version>/lib/node_modules/…`,
// which reads as an npm prefix and would have npm write into mise's version
// folder. A global installed by the npm of a mise-managed Node
// (`mise/installs/node/<version>/…`) is npm's, and keeps the npm update.
const FOREIGN_PACKAGE_MANAGERS: ReadonlyArray<readonly [name: string, segment: RegExp]> = [
  ['Volta', /[\\/]\.?volta[\\/]/i],
  ['pnpm', /[\\/]\.?pnpm[\\/]/i],
  ['Bun', /[\\/]\.bun[\\/]/i],
  ['Yarn', /[\\/](?:\.yarn|yarn[\\/]global)[\\/]/i],
  ['mise', /[\\/]mise[\\/]shims[\\/]/i],
  ['mise', /(?:^|[\\/])mise(?:\.exe)?$/i],
  ['mise', /[\\/]mise[\\/]installs[\\/](?!node[\\/])[^\\/]+[\\/][^\\/]+[\\/]/i],
]

/** The package manager other than npm and Homebrew that put a binary here, when its path says so. */
export function foreignPackageManager(...paths: Array<string | null | undefined>): string | null {
  for (const path of paths) {
    if (!path) continue
    for (const [name, segment] of FOREIGN_PACKAGE_MANAGERS) if (segment.test(path)) return name
  }
  return null
}

const isWindowsPath = (path: string): boolean => /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')

/**
 * The npm prefix a binary was installed under by `npm install -g <pkg>`, or
 * null when npm did not put it there. On macOS and Linux npm links
 * `<prefix>/bin/<name>` into `<prefix>/lib/node_modules/<pkg>/`, so the
 * binary's real path names both; on Windows npm writes a shim beside
 * `<prefix>/node_modules/<pkg>/`.
 */
export function npmGlobalPrefix(resolvedPath: string, packageName: string, fs: CliInstallFs): string | null {
  if (isWindowsPath(resolvedPath)) {
    const prefix = win32.dirname(resolvedPath)
    const installed = win32.join(prefix, 'node_modules', ...packageName.split('/'), 'package.json')
    return fs.exists(installed) ? prefix : null
  }
  const real = fs.realPath(resolvedPath)
  if (!real) return null
  const marker = `/lib/node_modules/${packageName}/`
  const at = real.indexOf(marker)
  return at > 0 ? real.slice(0, at) : null
}

// A prefix goes into a shell command line; one with a space or a quote in it
// is quoted for the shell the update runs in (PowerShell on Windows).
function shellPath(path: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(path)) return path
  return isWindowsPath(path) ? `'${path.replace(/'/g, "''")}'` : `'${path.replace(/'/g, `'\\''`)}'`
}

// The update the button runs, in precedence order: the CLI's own updater when
// the manifest declares one that is always right (`update`); `brew upgrade`
// when the binary lives under Homebrew and a formula is known; `npm install -g`
// into the same prefix when npm is what put the binary where it is; the CLI's
// own updater when the manifest declares one for the installs no package
// manager made (`selfUpdate`, the vendor's script); else nothing here, and
// updateCli falls back to re-running the install method. npm is never the
// guess: run against a binary another installer put on PATH, it installs a
// second copy somewhere else, PATH keeps finding the first, and the update
// reads as having done nothing. Where the machine's files cannot be read (a
// WSL distribution, `fs: null`) the CLI's own updater is preferred, since it
// can tell how it was installed, and npm is only the last resort.
export function chooseCliUpdateCommand(input: {
  manifest: Pick<PluginManifest, 'binary' | 'update' | 'selfUpdate' | 'package'>
  resolvedPath: string | null | undefined
  fs?: CliInstallFs | null
}): CliUpdateCommand | null {
  const { manifest, resolvedPath } = input
  const fs = input.fs === undefined ? localCliInstallFs : input.fs
  if (manifest.update?.args?.length) {
    return { kind: 'cli-updater', command: [manifest.binary, ...manifest.update.args].join(' ') }
  }
  const selfUpdate = manifest.selfUpdate?.args?.length
    ? ({ kind: 'cli-updater', command: [manifest.binary, ...manifest.selfUpdate.args].join(' ') } as const)
    : null
  const npm = manifest.package?.npm
  const brew = manifest.package?.brew
  const real = resolvedPath && fs ? fs.realPath(resolvedPath) : null
  if (foreignPackageManager(resolvedPath, real)) return null
  // A Homebrew keg can hold an npm tree of its own (a formula that vendors a
  // Node package), so the keg is read first: only brew moves what is in it.
  if (isHomebrewKeg(real)) return brew ? { kind: 'brew', command: `brew upgrade ${brew}` } : null
  if (!fs) {
    if (brew && isHomebrewPath(resolvedPath)) return { kind: 'brew', command: `brew upgrade ${brew}` }
    if (selfUpdate) return selfUpdate
    return npm ? { kind: 'npm', command: `npm install -g ${npm}@latest` } : null
  }
  const prefix = npm && resolvedPath ? npmGlobalPrefix(resolvedPath, npm, fs) : null
  if (npm && prefix) return { kind: 'npm', command: `npm install -g --prefix ${shellPath(prefix)} ${npm}@latest` }
  // Under Homebrew's bin with nowhere further to follow: brew's own link.
  if (brew && !real && isHomebrewPath(resolvedPath)) return { kind: 'brew', command: `brew upgrade ${brew}` }
  return selfUpdate
}

// Inside a formula's or cask's own directory: what only brew installs.
function isHomebrewKeg(path: string | null): boolean {
  if (!path) return false
  return /\/(cellar|caskroom)\//i.test(path.replace(/\\/g, '/'))
}

export type ResolveCliVersionAdvisoriesDeps = {
  /** The machine the availability map was detected on; absent is this one. */
  hostId?: ExecutionHostId
  getManifest: (cli: string) => PluginManifest | null | undefined
  fetchLatest?: (packageName: string, force: boolean) => Promise<string | null>
  now?: () => Date
  force?: boolean
  /** This machine's files, read to tell who installed a CLI; another machine's are not read. */
  fs?: CliInstallFs
}

// One advisory per CLI in the availability map. Only an installed CLI with a
// version and an npm package is asked about; everything else is `unknown`
// with the update command still named, so Settings can offer Update either way.
// A CLI that is not installed costs nothing here: no registry request, and the
// map it comes from was read, not probed.
export async function resolveCliVersionAdvisories(
  availability: Partial<Record<string, CliAvailability>>,
  deps: ResolveCliVersionAdvisoriesDeps,
): Promise<CliVersionAdvisoryMap> {
  const fetchLatest = deps.fetchLatest ?? ((pkg, force) => fetchNpmLatestVersion(pkg, { force }))
  const now = deps.now ?? (() => new Date())
  const force = deps.force ?? false
  const hostId = deps.hostId ?? LOCAL_HOST_ID
  const out: CliVersionAdvisoryMap = {}
  await Promise.all(
    Object.values(availability).map(async (entry) => {
      if (!entry) return
      const manifest = deps.getManifest(entry.cli)
      const updateCommand = manifest
        ? chooseCliUpdateCommand({
            manifest,
            resolvedPath: entry.resolvedPath,
            fs: hostId === LOCAL_HOST_ID ? deps.fs : null,
          })
        : null
      const packageName = manifest?.package?.npm ?? null
      const currentVersion = entry.version?.trim() || null
      const latestVersion =
        entry.installed && currentVersion && packageName ? await fetchLatest(packageName, force) : null
      out[entry.cli] = {
        cli: entry.cli,
        hostId,
        status: entry.installed ? deriveCliVersionStatus(currentVersion, latestVersion) : 'unknown',
        currentVersion,
        latestVersion,
        updateCommand,
        checkedAt: now().toISOString(),
      }
    }),
  )
  return out
}

// Which CLIs are behind, in a stable order, for the toast and the bell row.
export function outdatedClis(advisories: CliVersionAdvisoryMap): CliVersionAdvisory[] {
  return Object.values(advisories)
    .filter((entry): entry is CliVersionAdvisory => !!entry && entry.status === 'behind_latest')
    .sort((a, b) => a.cli.localeCompare(b.cli))
}

async function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is not available in this runtime.')
  return globalThis.fetch(url, init)
}
