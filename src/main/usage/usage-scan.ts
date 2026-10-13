import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

// The usage scan: find every agent session log on this machine, decide which
// changed since the last scan (by each file's size and modified time), and
// fold each changed one into a small aggregate — tokens per hour per model.
// Nothing here keeps a transcript: a 50 MB session folds to a few hundred
// bytes.
//
// Six sources:
//
// - Claude Code's logs, `<config>/projects/<folder>/<session>.jsonl` and the
//   subagent logs in `<folder>/<session>/**`. Studio's own Claude chats run
//   through the Agent SDK and write here too.
// - Codex's rollouts, `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`, Studio's
//   Codex chats among them.
// - OpenCode's store: `<data>/opencode.db`, one SQLite file holding every
//   session's messages, or the JSON files an older OpenCode kept per message
//   under `<data>/storage/message/<session>/`.
// - Gemini CLI's chat recordings, `<home>/tmp/<project>/chats/session-*.json`.
// - Grok's session updates, `<home>/sessions/<cwd>/<session>/updates.jsonl`.
// - Studio's chat transcripts, `<root>/.sprintengine/conversations/<ws>/<agent>.jsonl`.
//   Their `turn_completed` events carry the turn's usage when the runtime
//   reported it, the cost when it reported that, and the agent CLI session the
//   turn ran (`providerCursor.sessionId`), which is the only link between a
//   Studio chat and its CLI's log. The aggregation (usage-aggregate.ts) counts
//   a linked session from the CLI's own log, per request, and the transcript's
//   usage only for turns whose CLI log this machine does not have. Cursor
//   keeps no token counts on disk, so its Studio chats are counted from the
//   transcript alone, and a session run in its own terminal is not.
//
// It is pure Node and imports nothing of Electron, so it runs in the scan's
// worker thread (usage-scan-worker.ts), or inline, yielding between chunks,
// where no worker can start.

export type UsageSourceId = 'studio' | 'claude-code' | 'codex' | 'opencode' | 'gemini' | 'grok'

/**
 * One hour of one model's usage in one session:
 * `[hourStartMs, model, link, input, output, cacheRead, cacheWrite, requests, costUsd]`.
 * `link` is the agent CLI session a Studio turn ran, '' elsewhere. `input` is
 * fresh input only; cache reads and writes are apart from it.
 */
export type UsageBucket = [
  hour: number,
  model: string,
  link: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  requests: number,
  costUsd: number,
]

/** One session's aggregate, as the cache keeps it per group of files. */
export type UsageCacheEntry = {
  key: string
  src: UsageSourceId
  /** Fingerprint of the files the entry was read from: their sizes and modified times. */
  fp: string
  /** The agent CLI's session id; for a Studio transcript, the chat's agent id. */
  sessionId: string
  cwd: string | null
  /** The repository `cwd` belongs to, a linked worktree followed back to its main checkout. */
  repoRoot: string | null
  title: string | null
  providerId: string
  /** Studio transcripts: the chat, and every CLI session its turns ran. */
  studio?: { workspaceId: string; agentId: string; root: string; links: string[] }
  buckets: UsageBucket[]
}

/** A Studio transcript folder: one workspace's chats under one root. */
export type UsageStudioDir = { dir: string; workspaceId: string; root: string }

export type UsageScanRoots = {
  claudeProjects: string
  codexHome: string
  /** OpenCode's data folder (`opencode.db`, or the older `storage/`). Absent, OpenCode is not read. */
  opencodeData?: string
  /** Gemini CLI's home (`~/.gemini`). Absent, Gemini is not read. */
  geminiHome?: string
  /** Grok's home (`~/.grok`). Absent, Grok is not read. */
  grokHome?: string
  studioDirs: UsageStudioDir[]
}

export type UsageSourceStatus = { id: UsageSourceId; found: number; error: string | null }

export type UsageScanResult = {
  sources: UsageSourceStatus[]
  groups: number
  changed: number
  removed: string[]
}

type Group = {
  key: string
  src: UsageSourceId
  files: string[]
  main: string
  fp: string
  newest: number
  /** A session read out of a store that holds many (OpenCode's database). */
  sessionId?: string
}

const HOUR_MS = 3_600_000
const CLAUDE_PROVIDER = 'claude-agent'
const CODEX_PROVIDER = 'codex-agent'
const OPENCODE_PROVIDER = 'opencode-agent'
// No conversation provider drives Gemini CLI; its sessions report as the CLI.
const GEMINI_PROVIDER = 'gemini'
const GROK_PROVIDER = 'grok-agent'

// ── Reading lines ────────────────────────────────────────────────────────────

/**
 * Stream a file's lines without holding the file. `keep` is a cheap test of a
 * line's raw bytes, run before the line is decoded and handed on, so the many
 * lines a reader does not care about (tool output, attachments: most of a
 * log's bytes) are never decoded, let alone JSON-parsed. The markers a reader
 * looks for are ASCII, and in UTF-8 an ASCII byte only ever stands for itself,
 * so a marker is in a line's bytes exactly when it is in the decoded line,
 * whatever else the line holds. A line keeps a CRLF's carriage return, which
 * JSON reads as whitespace.
 */
export async function forEachLine(
  path: string,
  keep: (line: Buffer) => boolean,
  onLine: (line: string) => void,
  options: { yieldEveryBytes?: number; chunkBytes?: number } = {},
): Promise<void> {
  const stream = createReadStream(path, { highWaterMark: options.chunkBytes ?? 1 << 20 })
  // The start of a line that runs past the chunks read so far, joined once its end comes.
  let carry: Buffer[] = []
  let carried = 0
  const take = (line: Buffer) => {
    if (line.length && keep(line)) onLine(line.toString('utf8'))
  }
  let sinceYield = 0
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      sinceYield += chunk.length
      let from = 0
      let at = chunk.indexOf(NEWLINE)
      if (carry.length && at >= 0) {
        take(Buffer.concat([...carry, chunk.subarray(0, at)]))
        carry = []
        carried = 0
        from = at + 1
        at = chunk.indexOf(NEWLINE, from)
      }
      for (; at >= 0; at = chunk.indexOf(NEWLINE, from)) {
        take(chunk.subarray(from, at))
        from = at + 1
      }
      if (from < chunk.length) {
        // A tail is copied, so the chunk it came in is not held for it.
        carry.push(from === 0 ? chunk : Buffer.from(chunk.subarray(from)))
        carried += chunk.length - from
        // A single line longer than 64 MB is not one any reader here wants.
        if (carried > 64 << 20) {
          carry = []
          carried = 0
        }
      }
      if (options.yieldEveryBytes && sinceYield >= options.yieldEveryBytes) {
        sinceYield = 0
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
    if (carry.length) take(Buffer.concat(carry))
  } finally {
    stream.destroy()
  }
}

const NEWLINE = 0x0a

/** A line's test for any of `markers`, each an ASCII string, as raw bytes. */
function markers(...texts: string[]): (line: Buffer) => boolean {
  const encoded = texts.map((text) => Buffer.from(text, 'latin1'))
  return (line) => encoded.some((marker) => line.includes(marker))
}

// What each reader keeps a line for.
const CLAUDE_REPLY = markers('"type":"assistant"')
const CLAUDE_TITLE = markers('"type":"ai-title"', '"type":"summary"')
const CODEX_RECORD = markers('"session_meta"', '"turn_context"', '"token_usage_record"', '"token_count"')
const CODEX_USER_MESSAGE = markers('"user_message"')
const CODEX_THREAD_NAME = markers('thread_name')
const STUDIO_TURN = markers('"turn_completed"')
const GROK_TURN = markers('turn_completed')

function parseJson(line: string): Record<string, unknown> | null {
  try {
    return rec(JSON.parse(line))
  } catch {
    return null
  }
}

const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

function timeOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

const hourOf = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS

// ── Discovery ────────────────────────────────────────────────────────────────

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

async function listDir(path: string): Promise<Array<{ name: string; dir: boolean }>> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries.map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
}

async function jsonlUnder(root: string, depth: number, out: string[]): Promise<void> {
  if (depth > 4) return
  let entries: Array<{ name: string; dir: boolean }>
  try {
    entries = await listDir(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.dir) await jsonlUnder(path, depth + 1, out)
    else if (entry.name.endsWith('.jsonl')) out.push(path)
  }
}

/** Each file's size and modified time, so an unchanged session is never read again. */
async function fingerprint(files: string[]): Promise<{ fp: string; newest: number }> {
  const parts: string[] = []
  let newest = 0
  for (const file of [...files].sort()) {
    try {
      const info = await stat(file)
      parts.push(`${info.size}:${Math.floor(info.mtimeMs)}`)
      newest = Math.max(newest, info.mtimeMs)
    } catch {
      // Gone between listing and stat: left out of the fingerprint.
    }
  }
  return { fp: `${parts.length}|${parts.join(',')}`, newest }
}

async function discoverClaude(projects: string, status: UsageSourceStatus): Promise<Group[]> {
  let folders: Array<{ name: string; dir: boolean }>
  try {
    folders = await listDir(projects)
  } catch (error) {
    if (!isMissing(error)) status.error = `Could not read ${projects}: ${(error as Error).message}`
    return []
  }
  const groups: Group[] = []
  for (const folder of folders) {
    if (!folder.dir) continue
    const dir = join(projects, folder.name)
    let entries: Array<{ name: string; dir: boolean }>
    try {
      entries = await listDir(dir)
    } catch {
      continue
    }
    const sessions = new Map<string, { main: string | null; extra: string[] }>()
    for (const entry of entries) {
      if (!entry.dir && entry.name.endsWith('.jsonl')) {
        const id = entry.name.slice(0, -'.jsonl'.length)
        const session = sessions.get(id) ?? { main: null, extra: [] }
        session.main = join(dir, entry.name)
        sessions.set(id, session)
      } else if (entry.dir && /^[0-9a-f-]{36}$/i.test(entry.name)) {
        // A session's own folder holds its subagents' logs.
        const extra: string[] = []
        await jsonlUnder(join(dir, entry.name), 0, extra)
        if (extra.length === 0) continue
        const session = sessions.get(entry.name) ?? { main: null, extra: [] }
        session.extra = extra
        sessions.set(entry.name, session)
      }
    }
    for (const [id, session] of sessions) {
      const files = [...(session.main ? [session.main] : []), ...session.extra]
      if (files.length === 0) continue
      const { fp, newest } = await fingerprint(files)
      groups.push({
        key: `claude-code:${folder.name}/${id}`,
        src: 'claude-code',
        files,
        main: session.main ?? files[0]!,
        fp,
        newest,
      })
    }
  }
  status.found = groups.length
  return groups
}

async function discoverCodex(codexHome: string, status: UsageSourceStatus): Promise<Group[]> {
  const root = join(codexHome, 'sessions')
  try {
    await stat(root)
  } catch (error) {
    if (!isMissing(error)) status.error = `Could not read ${root}: ${(error as Error).message}`
    return []
  }
  const files: string[] = []
  await jsonlUnder(root, 0, files)
  const groups: Group[] = []
  for (const file of files) {
    if (!basename(file).startsWith('rollout-')) continue
    const { fp, newest } = await fingerprint([file])
    groups.push({ key: `codex:${file.slice(root.length + 1)}`, src: 'codex', files: [file], main: file, fp, newest })
  }
  status.found = groups.length
  return groups
}

async function discoverStudio(dirs: UsageStudioDir[], status: UsageSourceStatus): Promise<Group[]> {
  const groups: Group[] = []
  const seen = new Set<string>()
  for (const { dir } of dirs) {
    let entries: Array<{ name: string; dir: boolean }>
    try {
      entries = await listDir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.dir || !entry.name.endsWith('.jsonl')) continue
      const file = join(dir, entry.name)
      if (seen.has(file)) continue
      seen.add(file)
      const { fp, newest } = await fingerprint([file])
      groups.push({ key: `studio:${file}`, src: 'studio', files: [file], main: file, fp, newest })
    }
  }
  status.found = groups.length
  return groups
}

// ── Claude Code ──────────────────────────────────────────────────────────────

function blankEntry(group: Group, providerId: string): UsageCacheEntry {
  return {
    key: group.key,
    src: group.src,
    fp: group.fp,
    sessionId: '',
    cwd: null,
    repoRoot: null,
    title: null,
    providerId,
    buckets: [],
  }
}

/** Add one request (or one turn) to the entry's hour bucket for its model and link. */
function addUsage(
  buckets: Map<string, UsageBucket>,
  at: number,
  model: string,
  link: string,
  counts: [input: number, output: number, cacheRead: number, cacheWrite: number, requests: number, costUsd: number],
): void {
  const hour = hourOf(at)
  const key = `${hour}|${model}|${link}`
  const bucket = buckets.get(key) ?? [hour, model, link, 0, 0, 0, 0, 0, 0]
  for (let index = 0; index < 6; index += 1) bucket[3 + index] = (bucket[3 + index] as number) + counts[index]!
  buckets.set(key, bucket)
}

/**
 * Fold one Claude Code session: its log and its subagents' logs.
 *
 * - One reply streams as several records (one per content block) that share
 *   `message.id` + `requestId`, and only the last carries the final usage; the
 *   earlier ones show partial counts. Each reply is counted once, keeping the
 *   largest value of each field. (Keeping the first undercounts output about
 *   fourfold on subagent-heavy sessions.)
 * - A resumed or forked session copies its parent's records, marked by a
 *   `session_id` other than its own `sessionId`; those are counted where they
 *   were first written, so they are skipped here.
 * - Subagent logs repeat some of the parent's replies; the per-session key
 *   dedupes those too.
 */
export async function foldClaude(group: Group, yieldEveryBytes?: number): Promise<UsageCacheEntry> {
  const entry = blankEntry(group, CLAUDE_PROVIDER)
  const sessionId = basename(group.main, '.jsonl')
  const requests = new Map<string, { at: number; model: string; counts: number[] }>()
  let anonymous = 0
  for (const file of group.files) {
    const isMain = file === group.main && file.endsWith(`${sep}${sessionId}.jsonl`)
    await forEachLine(
      file,
      (line) => CLAUDE_REPLY(line) || (isMain && (CLAUDE_TITLE(line) || !entry.cwd)),
      (line) => {
        const record = parseJson(line)
        if (!record) return
        entry.cwd ??= str(record.cwd)
        if (isMain && record.type === 'ai-title') entry.title = str(record.aiTitle) ?? entry.title
        if (isMain && record.type === 'summary' && !entry.title) entry.title = str(record.summary)
        if (record.type !== 'assistant') return
        const copiedFrom = str(record.session_id)
        if (copiedFrom && copiedFrom !== str(record.sessionId)) return
        const message = rec(record.message)
        const usage = rec(message?.usage)
        if (!message || !usage) return
        const model = str(message.model) ?? 'unknown'
        if (model === '<synthetic>') return
        const at = timeOf(record.timestamp)
        if (at === null) return
        const counts = [
          num(usage.input_tokens),
          num(usage.output_tokens),
          num(usage.cache_read_input_tokens),
          num(usage.cache_creation_input_tokens),
        ]
        const messageId = str(message.id)
        const requestId = str(record.requestId)
        const key = messageId || requestId ? `${messageId ?? ''}|${requestId ?? ''}` : `anon:${anonymous++}`
        const known = requests.get(key)
        if (known) {
          // A later block of the same reply: its usage is the more complete one.
          for (let index = 0; index < 4; index += 1)
            known.counts[index] = Math.max(known.counts[index]!, counts[index]!)
        } else requests.set(key, { at, model, counts })
      },
      { yieldEveryBytes },
    )
  }
  const buckets = new Map<string, UsageBucket>()
  for (const { at, model, counts } of requests.values()) {
    addUsage(buckets, at, model, '', [counts[0]!, counts[1]!, counts[2]!, counts[3]!, 1, 0])
  }
  entry.sessionId = sessionId
  entry.buckets = [...buckets.values()]
  return entry
}

// ── Codex ────────────────────────────────────────────────────────────────────

/**
 * Fold one Codex rollout. Each model response is a `token_usage_record` with
 * its own `response_id`, counted once. An older rollout without them has only
 * `token_count` events, whose running `total_token_usage` is differenced
 * (a total that went down means the count restarted). Codex's `input_tokens`
 * includes the cached part, which is taken out.
 */
export async function foldCodex(group: Group, yieldEveryBytes?: number): Promise<UsageCacheEntry> {
  const entry = blankEntry(group, CODEX_PROVIDER)
  let model = 'unknown'
  const responses = new Set<string>()
  const buckets = new Map<string, UsageBucket>()
  let hasRecords = false
  const fallback: Array<{ at: number; model: string; counts: [number, number, number, number, number, number] }> = []
  let previousTotal: number[] | null = null
  await forEachLine(
    group.main,
    (line) => CODEX_RECORD(line) || (!entry.title && CODEX_USER_MESSAGE(line)),
    (line) => {
      const record = parseJson(line)
      if (!record) return
      const payload = rec(record.payload)
      if (record.type === 'session_meta' && payload) {
        entry.sessionId = str(payload.id) ?? str(payload.session_id) ?? entry.sessionId
        entry.cwd = str(payload.cwd) ?? entry.cwd
        return
      }
      if (record.type === 'turn_context' && payload) {
        model = str(payload.model) ?? model
        entry.cwd ??= str(payload.cwd)
        return
      }
      const at = timeOf(record.timestamp)
      if (at === null) return
      if (record.type === 'token_usage_record' && payload) {
        const usage = rec(payload.usage)
        const id = str(payload.response_id)
        if (!usage || (id && responses.has(id))) return
        if (id) responses.add(id)
        hasRecords = true
        const input = num(usage.input_tokens)
        const cached = Math.min(input, num(usage.cached_input_tokens))
        const written = Math.min(input - cached, num(usage.cache_write_input_tokens))
        addUsage(buckets, at, str(payload.model) ?? model, '', [
          input - cached - written,
          num(usage.output_tokens),
          cached,
          written,
          1,
          0,
        ])
        return
      }
      if (payload?.type === 'token_count') {
        const total = rec(rec(payload.info)?.total_token_usage)
        if (!total) return
        const now = [
          num(total.input_tokens),
          num(total.cached_input_tokens),
          num(total.cache_write_input_tokens),
          num(total.output_tokens),
        ]
        const previous: number[] = previousTotal && now[0]! >= previousTotal[0]! ? previousTotal : [0, 0, 0, 0]
        previousTotal = now
        const delta = now.map((value, index) => Math.max(0, value - (previous[index] ?? 0)))
        if (delta.every((value) => value === 0)) return
        const cached = Math.min(delta[0]!, delta[1]!)
        const written = Math.min(delta[0]! - cached, delta[2]!)
        fallback.push({ at, model, counts: [delta[0]! - cached - written, delta[3]!, cached, written, 1, 0] })
        return
      }
      if (record.type === 'event_msg' && payload?.type === 'user_message' && !entry.title) {
        entry.title = str(payload.message)?.split('\n')[0]?.slice(0, 120) ?? null
      }
    },
    { yieldEveryBytes },
  )
  if (!hasRecords) for (const item of fallback) addUsage(buckets, item.at, item.model, '', item.counts)
  if (!entry.sessionId) entry.sessionId = basename(group.main, '.jsonl')
  entry.buckets = [...buckets.values()]
  return entry
}

// ── Studio transcripts ───────────────────────────────────────────────────────

/**
 * Fold one Studio chat transcript: each `turn_completed`'s usage (when the
 * runtime reported it: `payload.usage` with `inputTokens`, `outputTokens`,
 * `cacheReadTokens`, `cacheWriteTokens`, any of which may be absent, and
 * older transcripts carry none), its reported `costUsd`, and the CLI session it
 * ran, kept as the bucket's link so the aggregation can prefer that CLI's own
 * log.
 */
export async function foldStudio(
  group: Group,
  dir: UsageStudioDir,
  titles: Map<string, string>,
): Promise<UsageCacheEntry> {
  const entry = blankEntry(group, '')
  const agentId = decodeSegment(basename(group.main, '.jsonl'))
  const links = new Set<string>()
  const buckets = new Map<string, UsageBucket>()
  entry.sessionId = agentId
  entry.cwd = dir.root
  entry.title = titles.get(agentId) ?? null
  await forEachLine(group.main, STUDIO_TURN, (line) => {
    const record = parseJson(line)
    if (!record || record.type !== 'turn_completed') return
    entry.providerId = str(record.providerId) ?? entry.providerId
    const payload = rec(record.payload)
    const at = typeof record.createdAt === 'number' ? record.createdAt : timeOf(record.createdAt)
    if (!payload || at === null) return
    const link = str(rec(payload.providerCursor)?.sessionId) ?? ''
    if (link) links.add(link)
    const usage = rec(payload.usage)
    const counts: [number, number, number, number, number, number] = [
      num(usage?.inputTokens),
      num(usage?.outputTokens),
      num(usage?.cacheReadTokens),
      num(usage?.cacheWriteTokens),
      usage ? 1 : 0,
      num(payload.costUsd),
    ]
    if (!usage && counts[5] === 0) return
    addUsage(buckets, at, str(record.modelId) ?? 'default', link, counts)
  })
  entry.studio = { workspaceId: dir.workspaceId, agentId, root: dir.root, links: [...links].slice(0, 500) }
  entry.buckets = [...buckets.values()]
  return entry
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function studioTitles(dir: string, cache: Map<string, Map<string, string>>): Promise<Map<string, string>> {
  const known = cache.get(dir)
  if (known) return known
  const titles = new Map<string, string>()
  try {
    const index = rec(JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')))
    for (const thread of Array.isArray(index?.threads) ? index.threads : []) {
      const row = rec(thread)
      const id = str(row?.agentId)
      const title = str(row?.title)
      if (id && title) titles.set(id, title.slice(0, 160))
    }
  } catch {
    // No index yet: the chat's own record names it at query time.
  }
  cache.set(dir, titles)
  return titles
}

async function codexTitles(codexHome: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  try {
    await forEachLine(join(codexHome, 'session_index.jsonl'), CODEX_THREAD_NAME, (line) => {
      const record = parseJson(line)
      const id = str(record?.id)
      const name = str(record?.thread_name)
      if (id && name) titles.set(id, name.slice(0, 160))
    })
  } catch {
    // No index: a session is titled by its first message.
  }
  return titles
}

// ── OpenCode ─────────────────────────────────────────────────────────────────

type SqliteDatabase = import('node:sqlite').DatabaseSync

/** Every `opencode*.db` in OpenCode's data folder; more than one when a channel keeps its own. */
async function opencodeDatabases(data: string): Promise<string[]> {
  try {
    return (await listDir(data))
      .filter((entry) => !entry.dir && /^opencode(?:-[\w.-]+)?\.db$/.test(entry.name))
      .map((entry) => join(data, entry.name))
  } catch {
    return []
  }
}

/**
 * Open OpenCode's database read only. OpenCode may be writing to it; a reader
 * waits a moment for its lock rather than failing. Null where this runtime has
 * no SQLite (`node:sqlite` arrived in Node 22.5) or the file will not open.
 */
async function openSqlite(path: string): Promise<SqliteDatabase | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA busy_timeout = 250')
    return db
  } catch {
    return null
  }
}

/**
 * OpenCode keeps every session in one database, so a session is a group of
 * its own, fingerprinted by its messages' count and newest update rather than
 * by the file, which changes whenever any session does. The legacy JSON store
 * (one file per message, a folder per session) is grouped by folder.
 */
async function discoverOpencode(
  data: string | undefined,
  status: UsageSourceStatus,
  databases: Map<string, SqliteDatabase>,
): Promise<Group[]> {
  if (!data) return []
  const groups: Group[] = []
  for (const path of await opencodeDatabases(data)) {
    const db = await openSqlite(path)
    if (!db) {
      status.error = `Could not open ${path}.`
      continue
    }
    databases.set(path, db)
    try {
      const rows = db
        .prepare('SELECT session_id AS id, COUNT(*) AS n, MAX(time_updated) AS t FROM message GROUP BY session_id')
        .all() as Array<{ id: string; n: number; t: number }>
      for (const row of rows) {
        groups.push({
          key: `opencode:${basename(path)}/${row.id}`,
          src: 'opencode',
          files: [path],
          main: path,
          fp: `db|${row.n}:${row.t}`,
          newest: Number(row.t) || 0,
          sessionId: row.id,
        })
      }
    } catch (error) {
      status.error = `Could not read ${path}: ${(error as Error).message}`
    }
  }
  const legacy = join(data, 'storage', 'message')
  let sessions: Array<{ name: string; dir: boolean }> = []
  try {
    sessions = await listDir(legacy)
  } catch {
    // No legacy store: OpenCode has only ever kept its database here.
  }
  const inDatabase = new Set(groups.map((group) => group.sessionId))
  for (const session of sessions) {
    // A session the database also holds was migrated into it; its rows win.
    if (!session.dir || inDatabase.has(session.name)) continue
    const dir = join(legacy, session.name)
    let files: string[]
    try {
      files = (await listDir(dir)).filter((e) => !e.dir && e.name.endsWith('.json')).map((e) => join(dir, e.name))
    } catch {
      continue
    }
    if (files.length === 0) continue
    const { fp, newest } = await fingerprint(files)
    groups.push({
      key: `opencode:storage/${session.name}`,
      src: 'opencode',
      files,
      main: dir,
      fp,
      newest,
      sessionId: session.name,
    })
  }
  status.found = groups.length
  return groups
}

/**
 * One OpenCode assistant message: `tokens.input` is fresh input (cache reads
 * and writes are apart from it), reasoning is billed as output, and `cost` is
 * OpenCode's own price for it, kept when it priced one (it writes 0 for a model
 * it has no rate for).
 */
function addOpencodeMessage(
  buckets: Map<string, UsageBucket>,
  entry: UsageCacheEntry,
  data: Record<string, unknown>,
  createdFallback: number | null,
): void {
  if (data.role !== undefined && data.role !== 'assistant') return
  const tokens = rec(data.tokens)
  if (!tokens) return
  const model = rec(data.model)
  const name = str(model?.id) ?? str(model?.modelID) ?? str(data.modelID) ?? 'unknown'
  const at = timeOf(rec(data.time)?.created) ?? createdFallback
  if (at === null) return
  const cache = rec(tokens.cache)
  const counts: [number, number, number, number, number, number] = [
    num(tokens.input),
    num(tokens.output) + num(tokens.reasoning),
    num(cache?.read),
    num(cache?.write),
    1,
    num(data.cost),
  ]
  if (counts[0] + counts[1] + counts[2] + counts[3] === 0 && counts[5] === 0) return
  entry.cwd ??= str(rec(data.path)?.cwd)
  addUsage(buckets, at, name, '', counts)
}

export async function foldOpencode(group: Group, databases: Map<string, SqliteDatabase>): Promise<UsageCacheEntry> {
  const entry = blankEntry(group, OPENCODE_PROVIDER)
  const sessionId = group.sessionId ?? basename(group.main)
  const buckets = new Map<string, UsageBucket>()
  entry.sessionId = sessionId
  const db = databases.get(group.main)
  if (db) {
    const session = db.prepare('SELECT title, directory FROM session WHERE id = ?').get(sessionId) as
      { title?: string; directory?: string } | undefined
    entry.title = str(session?.title)
    entry.cwd = str(session?.directory)
    const rows = db
      .prepare('SELECT data, time_created AS created FROM message WHERE session_id = ?')
      .all(sessionId) as Array<{ data: string; created: number }>
    for (const row of rows) {
      const data = parseJson(row.data)
      if (data) addOpencodeMessage(buckets, entry, data, timeOf(row.created))
    }
  } else {
    for (const file of group.files) {
      const data = parseJson(await readFile(file, 'utf8'))
      if (data) addOpencodeMessage(buckets, entry, data, null)
    }
    // The legacy store keeps each session's title beside its project.
    try {
      // `<data>/storage/message/<session>` → `<data>/storage/session/<project>/<session>.json`
      const sessions = join(dirname(dirname(group.main)), 'session')
      for (const project of await listDir(sessions)) {
        if (!project.dir) continue
        const info = parseJson(
          await readFile(join(sessions, project.name, `${sessionId}.json`), 'utf8').catch(() => ''),
        )
        if (!info) continue
        entry.title = str(info.title)
        entry.cwd = str(info.directory) ?? entry.cwd
        break
      }
    } catch {
      // No session record: the session goes untitled.
    }
  }
  entry.buckets = [...buckets.values()]
  return entry
}

// ── Gemini CLI ───────────────────────────────────────────────────────────────

async function discoverGemini(home: string | undefined, status: UsageSourceStatus): Promise<Group[]> {
  if (!home) return []
  const root = join(home, 'tmp')
  let projects: Array<{ name: string; dir: boolean }>
  try {
    projects = await listDir(root)
  } catch (error) {
    if (!isMissing(error)) status.error = `Could not read ${root}: ${(error as Error).message}`
    return []
  }
  const groups: Group[] = []
  for (const project of projects) {
    if (!project.dir) continue
    const chats = join(root, project.name, 'chats')
    let files: Array<{ name: string; dir: boolean }>
    try {
      files = await listDir(chats)
    } catch {
      continue
    }
    for (const file of files) {
      if (file.dir || !/^session-.*\.jsonl?$/.test(file.name)) continue
      const path = join(chats, file.name)
      const { fp, newest } = await fingerprint([path])
      groups.push({ key: `gemini:${project.name}/${file.name}`, src: 'gemini', files: [path], main: path, fp, newest })
    }
  }
  status.found = groups.length
  return groups
}

/**
 * Fold one Gemini CLI chat recording: a JSON document (`messages`), or the
 * line-per-record form a newer CLI appends to. A reply is a `gemini` message
 * whose `tokens` are `input` (cached part included), `cached`, `output`,
 * `thoughts` (billed as output) and `tool` (prompt tokens a tool's result
 * added). A message rewritten as it streams is counted once, at its largest.
 */
export async function foldGemini(group: Group): Promise<UsageCacheEntry> {
  const entry = blankEntry(group, GEMINI_PROVIDER)
  const replies = new Map<string, { at: number; model: string; counts: number[] }>()
  let anonymous = 0
  const take = (record: Record<string, unknown>): void => {
    entry.sessionId ||= str(record.sessionId) ?? ''
    if (!entry.title && record.type === 'user') {
      const content = record.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? str(rec(content[0])?.text) : null
      entry.title = text?.split('\n')[0]?.slice(0, 120) || null
    }
    if (record.type !== 'gemini') return
    const tokens = rec(record.tokens)
    const at = timeOf(record.timestamp)
    if (!tokens || at === null) return
    const input = num(tokens.input) + num(tokens.tool)
    const cached = Math.min(input, num(tokens.cached))
    const counts = [input - cached, num(tokens.output) + num(tokens.thoughts), cached, 0]
    const key = str(record.id) ?? `anon:${anonymous++}`
    const known = replies.get(key)
    if (known)
      for (let index = 0; index < 4; index += 1) known.counts[index] = Math.max(known.counts[index]!, counts[index]!)
    else replies.set(key, { at, model: str(record.model) ?? 'gemini', counts })
  }
  if (group.main.endsWith('.jsonl')) {
    await forEachLine(
      group.main,
      () => true,
      (line) => {
        const record = parseJson(line)
        if (record) take(record)
      },
    )
  } else {
    const document = parseJson(await readFile(group.main, 'utf8'))
    entry.sessionId = str(document?.sessionId) ?? ''
    for (const message of Array.isArray(document?.messages) ? document.messages : []) {
      const record = rec(message)
      if (record) take(record)
    }
  }
  // Newer CLIs name the project folder and record its root beside the chats.
  entry.cwd = str(await readFile(join(dirname(dirname(group.main)), '.project_root'), 'utf8').catch(() => null))
  const buckets = new Map<string, UsageBucket>()
  for (const { at, model, counts } of replies.values()) {
    addUsage(buckets, at, model, '', [counts[0]!, counts[1]!, counts[2]!, counts[3]!, 1, 0])
  }
  if (!entry.sessionId) entry.sessionId = basename(group.main).replace(/\.jsonl?$/, '')
  entry.buckets = [...buckets.values()]
  return entry
}

// ── Grok ─────────────────────────────────────────────────────────────────────

/** Grok keeps a folder per session under a folder per working directory, `<cwd encoded>/<session>/`. */
async function discoverGrok(home: string | undefined, status: UsageSourceStatus): Promise<Group[]> {
  if (!home) return []
  const root = join(home, 'sessions')
  let folders: Array<{ name: string; dir: boolean }>
  try {
    folders = await listDir(root)
  } catch (error) {
    if (!isMissing(error)) status.error = `Could not read ${root}: ${(error as Error).message}`
    return []
  }
  const groups: Group[] = []
  for (const folder of folders) {
    if (!folder.dir) continue
    let sessions: Array<{ name: string; dir: boolean }>
    try {
      sessions = await listDir(join(root, folder.name))
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.dir) continue
      const path = join(root, folder.name, session.name, 'updates.jsonl')
      const { fp, newest } = await fingerprint([path])
      // Only the session summary, no turns: nothing to count.
      if (fp === '0|') continue
      groups.push({ key: `grok:${folder.name}/${session.name}`, src: 'grok', files: [path], main: path, fp, newest })
    }
  }
  status.found = groups.length
  return groups
}

const GROK_TICKS_PER_USD = 1e10

/**
 * Fold one Grok session's `updates.jsonl`: each `turn_completed` update's
 * usage, per model when it breaks the turn down by model (`modelUsage`).
 * `inputTokens` includes the cached part; `costUsdTicks` is Grok's own price
 * in ten-billionths of a dollar.
 */
export async function foldGrok(group: Group): Promise<UsageCacheEntry> {
  const entry = blankEntry(group, GROK_PROVIDER)
  const sessionDir = dirname(group.main)
  entry.sessionId = basename(sessionDir)
  entry.cwd = decodeSegment(basename(dirname(sessionDir)))
  const summary = parseJson(await readFile(join(sessionDir, 'summary.json'), 'utf8').catch(() => ''))
  entry.title = str(summary?.session_summary)?.split('\n')[0]?.slice(0, 120) ?? null
  const fallbackModel = str(summary?.current_model_id) ?? 'grok'
  const buckets = new Map<string, UsageBucket>()
  const seen = new Set<string>()
  const add = (at: number, model: string, usage: Record<string, unknown>): void => {
    const input = num(usage.inputTokens)
    const cached = Math.min(input, num(usage.cachedReadTokens))
    const written = Math.min(input - cached, num(usage.cacheCreationTokens))
    addUsage(buckets, at, model, '', [
      input - cached - written,
      num(usage.outputTokens),
      cached,
      written,
      1,
      num(usage.costUsdTicks) / GROK_TICKS_PER_USD,
    ])
  }
  await forEachLine(group.main, GROK_TURN, (line) => {
    const record = parseJson(line)
    const params = rec(record?.params)
    const update = rec(params?.update)
    const usage = rec(update?.usage)
    if (!record || !update || !usage || update.sessionUpdate !== 'turn_completed') return
    const at = timeOf(rec(params?._meta)?.agentTimestampMs) ?? timeOf(record.timestamp)
    if (at === null) return
    const turn = str(update.promptId) ?? str(params?.promptId) ?? str(record.prompt_id)
    if (turn) {
      if (seen.has(turn)) return
      seen.add(turn)
    }
    const perModel = Object.entries(rec(usage.modelUsage) ?? {})
    if (perModel.length === 0) return add(at, str(usage.model) ?? fallbackModel, usage)
    for (const [model, value] of perModel) {
      const modelUsage = rec(value)
      if (modelUsage) add(at, model, modelUsage)
    }
  })
  entry.buckets = [...buckets.values()]
  return entry
}

// ── Which repository a folder belongs to ─────────────────────────────────────

/**
 * The git root of `start`, with a linked worktree (`.git` is a file naming
 * `<repo>/.git/worktrees/<name>`) followed back to the repository it belongs
 * to, so a session in a worktree is attributed to the project. Null when no
 * repository contains it (or the folder is gone).
 */
export async function repositoryRoot(start: string): Promise<string | null> {
  let dir = start
  for (let depth = 0; depth < 16 && dir; depth += 1) {
    let git: 'dir' | string | null = null
    try {
      const info = await stat(join(dir, '.git'))
      git = info.isDirectory() ? 'dir' : (await readFile(join(dir, '.git'), 'utf8')).slice(0, 1000)
    } catch {
      git = null
    }
    if (git === 'dir') return dir
    if (typeof git === 'string') {
      const gitdir = /gitdir:\s*(.+)/.exec(git)?.[1]?.trim()
      const main = gitdir ? /^(.*)[\\/]\.git[\\/](?:worktrees|modules)[\\/]/.exec(gitdir)?.[1] : undefined
      return main ?? dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ── The scan ─────────────────────────────────────────────────────────────────

/**
 * Scan everything. `previous` maps each group key to the fingerprint the cache
 * holds; groups whose fingerprint still matches are not read. Changed entries
 * go to `onEntry` as they are folded, newest work first, so the caller keeps
 * its memory flat.
 */
export async function runUsageScan(
  roots: UsageScanRoots,
  previous: Readonly<Record<string, string>>,
  hooks: { onEntry: (entry: UsageCacheEntry) => void; yieldEveryBytes?: number; shouldStop?: () => boolean },
): Promise<UsageScanResult> {
  const status: Record<UsageSourceId, UsageSourceStatus> = {
    studio: { id: 'studio', found: 0, error: null },
    'claude-code': { id: 'claude-code', found: 0, error: null },
    codex: { id: 'codex', found: 0, error: null },
    opencode: { id: 'opencode', found: 0, error: null },
    gemini: { id: 'gemini', found: 0, error: null },
    grok: { id: 'grok', found: 0, error: null },
  }
  // OpenCode's databases stay open for the scan, so each session is one query.
  const databases = new Map<string, SqliteDatabase>()
  try {
    return await scanGroups(roots, previous, hooks, status, databases)
  } finally {
    for (const db of databases.values()) {
      try {
        db.close()
      } catch {
        // Already closed.
      }
    }
  }
}

async function scanGroups(
  roots: UsageScanRoots,
  previous: Readonly<Record<string, string>>,
  hooks: { onEntry: (entry: UsageCacheEntry) => void; yieldEveryBytes?: number; shouldStop?: () => boolean },
  status: Record<UsageSourceId, UsageSourceStatus>,
  databases: Map<string, SqliteDatabase>,
): Promise<UsageScanResult> {
  const groups = [
    ...(await discoverClaude(roots.claudeProjects, status['claude-code'])),
    ...(await discoverCodex(roots.codexHome, status.codex)),
    ...(await discoverOpencode(roots.opencodeData, status.opencode, databases)),
    ...(await discoverGemini(roots.geminiHome, status.gemini)),
    ...(await discoverGrok(roots.grokHome, status.grok)),
    ...(await discoverStudio(roots.studioDirs, status.studio)),
  ]
  const present = new Set(groups.map((group) => group.key))
  const removed = Object.keys(previous).filter((key) => !present.has(key))
  const changed = groups.filter((group) => previous[group.key] !== group.fp).sort((a, b) => b.newest - a.newest)
  const dirsByPath = new Map(roots.studioDirs.map((dir) => [dir.dir, dir]))
  const titleCache = new Map<string, Map<string, string>>()
  const codexNames = changed.some((group) => group.src === 'codex')
    ? await codexTitles(roots.codexHome)
    : new Map<string, string>()
  const repoRoots = new Map<string, Promise<string | null>>()
  let folded = 0
  for (const group of changed) {
    if (hooks.shouldStop?.()) break
    try {
      let entry: UsageCacheEntry
      if (group.src === 'claude-code') entry = await foldClaude(group, hooks.yieldEveryBytes)
      else if (group.src === 'codex') {
        entry = await foldCodex(group, hooks.yieldEveryBytes)
        entry.title = codexNames.get(entry.sessionId) ?? entry.title
      } else if (group.src === 'opencode') entry = await foldOpencode(group, databases)
      else if (group.src === 'gemini') entry = await foldGemini(group)
      else if (group.src === 'grok') entry = await foldGrok(group)
      else {
        const dir = dirsByPath.get(dirname(group.main))
        if (!dir) continue
        entry = await foldStudio(group, dir, await studioTitles(dir.dir, titleCache))
      }
      if (entry.cwd && entry.src !== 'studio') {
        let root = repoRoots.get(entry.cwd)
        if (!root) {
          root = repositoryRoot(entry.cwd)
          repoRoots.set(entry.cwd, root)
        }
        entry.repoRoot = await root
      }
      hooks.onEntry(entry)
      folded += 1
    } catch {
      // A file that vanished or could not be read mid-scan is retried next time.
    }
  }
  return { sources: Object.values(status), groups: groups.length, changed: folded, removed }
}
