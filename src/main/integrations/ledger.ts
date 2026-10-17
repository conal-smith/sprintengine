// The integration ledger: every file, entry and piece of machine state this app
// writes outside its own data directory, recorded as it is written.
//
// It exists so the app can take all of it back out — at every quit, and from
// the Windows uninstaller — without guessing. Each entry says what was written
// (`kind`), where (`path`, absolute as this process opens it), how our part of
// it is recognised (`marker`), and for which CLI, machine and repository. The
// removal reads the file at `path` again and takes out only what `marker`
// identifies, so a stale entry (the person already deleted the file, or edited
// our block out) costs a no-op, never someone's content.
//
// A write the ledger missed — one from a build before the ledger existed — is
// found by the first-run scan (`integration-scan.ts`) and recorded the same way.
//
// Entries for a WSL distribution are mirrored into that distribution, under
// its own `~/.sprintengine`, so what was written there is listed there too.

import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { writeFileAtomically } from '../config-file-write'

export const INTEGRATION_LEDGER_FILE = 'integration-ledger.json'
const LEDGER_VERSION = 1

/**
 * What was written. Each kind has exactly one removal, so a kind is never
 * reused for a differently-shaped write.
 */
export type IntegrationKind =
  /** Agent-state hook entries in a CLI's config (any registration kind; `marker` names it). */
  | 'agent-state-hooks'
  /** Our `statusLine` in a Claude settings file (wrapping the person's own). */
  | 'status-line'
  /** A reporter script copied under `.sprintengine/hooks` (older builds, or the knowledge-activity hook). */
  | 'hook-script'
  /** The app's MCP gateway entry in a CLI's MCP config. */
  | 'mcp-gateway'
  /** `sprintengine-studio` in `enabledMcpjsonServers`. */
  | 'mcp-approval'
  /** The materialised plugin under `.sprintengine/studio-plugin`. */
  | 'studio-plugin-copy'
  /** `enabledPlugins` / `extraKnownMarketplaces` naming the app's plugin in a Claude settings file. */
  | 'claude-plugin-setting'
  /** An entry Claude Code itself added to `~/.claude/plugins/known_marketplaces.json` for that marketplace. */
  | 'claude-known-marketplace'
  /** A skill directory copied with the app's provenance marker. */
  | 'skill-copy'
  /** The knowledge-activity hook entries in `.claude/settings.local.json`. */
  | 'knowledge-activity-hook'
  /** Lines in a git exclude file, or the per-worktree excludes configuration. */
  | 'git-exclude'
  /** A `git worktree lock` this profile placed. */
  | 'worktree-lock'
  /** A `tailscale serve --bg` mapping this app published. */
  | 'tailnet-share'
  /** The `sprintengine://` protocol registration. */
  | 'protocol-handler'
  /** The launcher directory under a home. */
  | 'launcher'
  /** The WSL data directory (`~/.local/share/sprintengine-studio`) in a distribution. */
  | 'wsl-data'

export type IntegrationLedgerEntry = {
  kind: IntegrationKind
  /** Absolute path as this process opens it. For machine state with no file (a serve port), a stable descriptor. */
  path: string
  /** How our part is recognised inside `path`: a block marker, a JSON key, a tag, `owned` for a whole file. */
  marker: string
  /** The machine: `local`, or `wsl:<distro>`. */
  hostId: string
  cli?: string
  /** The repository (workspace root or worktree) the write was for, when it was for one. */
  repo?: string
  /**
   * True when this app created the file. Only then may removal delete a file it
   * leaves empty; absent means it was there already, or is not known.
   */
  createdFile?: boolean
  /** Kind-specific facts the removal needs (a serve port's local port, a lock's worktree). */
  detail?: Record<string, string | number | boolean>
  /** How it was learned: written by this build, or found by the scan. */
  source: 'write' | 'scan'
  firstRecordedAt: string
  lastRecordedAt: string
}

export type IntegrationWrite = Omit<IntegrationLedgerEntry, 'source' | 'firstRecordedAt' | 'lastRecordedAt'> & {
  source?: IntegrationLedgerEntry['source']
}

type LedgerFile = {
  version: number
  /** When the first-run scan finished; absent until it has. */
  scannedAt?: string
  /** The last repository clean-up a start ran (`cleanRepositoriesAtBoot`), by its version. */
  cleanedVersion?: number
  entries: IntegrationLedgerEntry[]
}

export function ledgerKey(entry: Pick<IntegrationLedgerEntry, 'kind' | 'path' | 'marker' | 'hostId'>): string {
  return `${entry.kind}\u0000${entry.hostId}\u0000${entry.path}\u0000${entry.marker}`
}

function isEntry(value: unknown): value is IntegrationLedgerEntry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.kind === 'string' &&
    typeof record.path === 'string' &&
    typeof record.marker === 'string' &&
    typeof record.hostId === 'string'
  )
}

export function parseLedger(text: string | null): LedgerFile {
  if (!text) return { version: LEDGER_VERSION, entries: [] }
  try {
    const parsed = JSON.parse(text) as Partial<LedgerFile>
    return {
      version: LEDGER_VERSION,
      ...(typeof parsed.scannedAt === 'string' ? { scannedAt: parsed.scannedAt } : {}),
      ...(typeof parsed.cleanedVersion === 'number' ? { cleanedVersion: parsed.cleanedVersion } : {}),
      entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [],
    }
  } catch {
    return { version: LEDGER_VERSION, entries: [] }
  }
}

export type IntegrationLedger = {
  /** Record writes. Merges with an existing entry of the same key; `createdFile` is sticky once true. */
  record: (writes: ReadonlyArray<IntegrationWrite>) => Promise<void>
  /** Remove entries (after a removal replayed them). */
  forget: (keys: ReadonlyArray<string>) => Promise<void>
  /** Remove every entry `match` accepts (a share the person stopped from the app). */
  forgetWhere: (match: (entry: IntegrationLedgerEntry) => boolean) => Promise<void>
  list: () => Promise<IntegrationLedgerEntry[]>
  scannedAt: () => Promise<string | null>
  markScanned: () => Promise<void>
  cleanedVersion: () => Promise<number>
  markCleaned: (version: number) => Promise<void>
  /** Settles once every queued write has reached disk. */
  flush: () => Promise<void>
}

export type IntegrationLedgerOptions = {
  /** Absolute path of the ledger file. */
  path: string
  /** Where to mirror a WSL distribution's entries (its own `~/.sprintengine/<file>`, as this process opens it), or null. */
  mirrorPathFor?: (hostId: string) => string | null
  now?: () => Date
  onError?: (error: unknown) => void
}

/**
 * A later write's facts over an earlier one's, except that a fact recorded as
 * `true` stays true — like `createdFile`, "the app turned this on" is learned
 * once (the first write) and a repeat, which finds it already on, must not
 * erase it.
 */
function mergedDetail(
  earlier: IntegrationLedgerEntry['detail'],
  later: IntegrationLedgerEntry['detail'],
): { detail?: Record<string, string | number | boolean> } {
  if (!earlier && !later) return {}
  const detail = { ...earlier, ...later }
  for (const [key, value] of Object.entries(earlier ?? {})) {
    if (value === true) detail[key] = true
  }
  return { detail }
}

export function createIntegrationLedger(options: IntegrationLedgerOptions): IntegrationLedger {
  const now = options.now ?? (() => new Date())
  let chain: Promise<unknown> = Promise.resolve()

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task)
    chain = run.catch((error) => options.onError?.(error))
    return run
  }

  async function load(): Promise<LedgerFile> {
    return parseLedger(await readFile(options.path, 'utf8').catch(() => null))
  }

  async function save(file: LedgerFile, touchedHosts: ReadonlySet<string>): Promise<void> {
    await mkdir(join(options.path, '..'), { recursive: true })
    await writeFileAtomically(options.path, `${JSON.stringify(file, null, 2)}\n`)
    for (const hostId of touchedHosts) {
      if (hostId === 'local') continue
      const mirror = options.mirrorPathFor?.(hostId)
      if (!mirror) continue
      try {
        await mkdir(join(mirror, '..'), { recursive: true })
        const entries = file.entries.filter((entry) => entry.hostId === hostId)
        await writeFileAtomically(mirror, `${JSON.stringify({ version: LEDGER_VERSION, entries }, null, 2)}\n`)
      } catch (error) {
        // A distribution that is not running is mirrored the next time.
        options.onError?.(error)
      }
    }
  }

  function forgetWhere(match: (entry: IntegrationLedgerEntry) => boolean): Promise<void> {
    return serialize(async () => {
      const file = await load()
      const touched = new Set<string>()
      const entries = file.entries.filter((entry) => {
        if (!match(entry)) return true
        touched.add(entry.hostId)
        return false
      })
      if (entries.length === file.entries.length) return
      await save({ ...file, entries }, touched)
    })
  }

  return {
    record: (writes) =>
      serialize(async () => {
        if (writes.length === 0) return
        const file = await load()
        const byKey = new Map(file.entries.map((entry) => [ledgerKey(entry), entry]))
        const at = now().toISOString()
        const touched = new Set<string>()
        let changed = false
        for (const write of writes) {
          const key = ledgerKey(write)
          const existing = byKey.get(key)
          touched.add(write.hostId)
          if (existing) {
            const next: IntegrationLedgerEntry = {
              ...existing,
              ...write,
              source: existing.source === 'write' || write.source !== 'scan' ? 'write' : 'scan',
              createdFile: existing.createdFile === true || write.createdFile === true ? true : write.createdFile,
              ...mergedDetail(existing.detail, write.detail),
              firstRecordedAt: existing.firstRecordedAt,
              lastRecordedAt: at,
            }
            if (next.createdFile === undefined) delete next.createdFile
            // The same write again (every launch repeats them) is not worth a
            // disk write: only a fact that changed is.
            if (
              JSON.stringify({ ...next, lastRecordedAt: '' }) === JSON.stringify({ ...existing, lastRecordedAt: '' })
            ) {
              continue
            }
            byKey.set(key, next)
          } else {
            const entry: IntegrationLedgerEntry = {
              ...write,
              source: write.source ?? 'write',
              firstRecordedAt: at,
              lastRecordedAt: at,
            }
            if (entry.createdFile === undefined) delete entry.createdFile
            byKey.set(key, entry)
          }
          changed = true
        }
        if (!changed) return
        await save({ ...file, entries: [...byKey.values()] }, touched)
      }),
    forget: (keys) => {
      const drop = new Set(keys)
      return drop.size === 0 ? Promise.resolve() : forgetWhere((entry) => drop.has(ledgerKey(entry)))
    },
    forgetWhere,
    list: () => serialize(async () => (await load()).entries),
    scannedAt: () => serialize(async () => (await load()).scannedAt ?? null),
    markScanned: () =>
      serialize(async () => {
        const file = await load()
        await save({ ...file, scannedAt: now().toISOString() }, new Set())
      }),
    cleanedVersion: () => serialize(async () => (await load()).cleanedVersion ?? 0),
    markCleaned: (version) =>
      serialize(async () => {
        const file = await load()
        await save({ ...file, cleanedVersion: version }, new Set())
      }),
    flush: () => serialize(async () => undefined),
  }
}

/**
 * The machine a path belongs to, read off its spelling: a `\\wsl.localhost\<distro>\…`
 * (or `\\wsl$\<distro>\…`) path is inside that distribution, anything else is
 * this machine's. A WSL workspace kept on a Windows drive reads as local here,
 * which is right for removal — this process opens the file the same way.
 */
export function hostIdForPath(path: string): string {
  const match = /^[\\/]{2}wsl(?:\.localhost|\$)[\\/]([^\\/]+)/iu.exec(path)
  return match ? `wsl:${match[1]}` : 'local'
}

// ── The process-wide recorder ───────────────────────────────────────────────
//
// Writers all over main record through this one function, so none of them has
// to be handed the ledger. Until app-services installs it (and in tests that do
// not), a record is dropped: the first-run scan is what catches a write the
// ledger never saw.

let installed: IntegrationLedger | null = null

export function installIntegrationLedger(ledger: IntegrationLedger | null): void {
  installed = ledger
}

export function integrationLedger(): IntegrationLedger | null {
  return installed
}

/** Record writes; never throws and never delays the writer. */
export function recordIntegrationWrite(...writes: IntegrationWrite[]): void {
  const ledger = installed
  if (!ledger || writes.length === 0) return
  void ledger.record(writes).catch(() => undefined)
}
