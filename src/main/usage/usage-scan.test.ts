import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { forEachLine, repositoryRoot, runUsageScan, type UsageCacheEntry, type UsageScanRoots } from './usage-scan'

let home: string
let roots: UsageScanRoots

const HOUR = 3_600_000
const T0 = Date.parse('2026-10-08T09:15:00.000Z')
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString()
const jsonl = (records: unknown[]): string => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'se-usage-scan-')))
  roots = {
    claudeProjects: join(home, '.claude', 'projects'),
    codexHome: join(home, '.codex'),
    studioDirs: [],
  }
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function scan(previous: Record<string, string> = {}): Promise<{
  entries: UsageCacheEntry[]
  result: Awaited<ReturnType<typeof runUsageScan>>
}> {
  const entries: UsageCacheEntry[] = []
  const result = await runUsageScan(roots, previous, { onEntry: (entry) => entries.push(entry) })
  return { entries, result }
}

const assistant = (
  sessionId: string,
  messageId: string,
  requestId: string,
  usage: Record<string, number>,
  minutes: number,
  extra: Record<string, unknown> = {},
) => ({
  type: 'assistant',
  sessionId,
  requestId,
  cwd: join(home, 'repo'),
  timestamp: at(minutes),
  message: { id: messageId, model: 'claude-opus-4-1', usage, content: [{ type: 'text', text: 'ok' }] },
  ...extra,
})

test('a Claude Code reply streamed as several records is counted once, at its largest', async () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const folder = join(roots.claudeProjects, '-repo')
  await mkdir(join(folder, sid, 'subagents'), { recursive: true })
  await writeFile(
    join(folder, `${sid}.jsonl`),
    jsonl([
      { type: 'user', sessionId: sid, cwd: join(home, 'repo'), timestamp: at(0), message: { content: 'hi' } },
      // One reply, three content blocks: only the last has the final output.
      assistant(sid, 'msg_1', 'req_1', { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100 }, 1),
      assistant(sid, 'msg_1', 'req_1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, 1),
      assistant(
        sid,
        'msg_1',
        'req_1',
        { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
        1,
      ),
      // A record a resumed session copied from its parent belongs to the parent.
      assistant(sid, 'msg_0', 'req_0', { input_tokens: 999, output_tokens: 999 }, 2, { session_id: 'parent' }),
      // A synthetic reply costs nothing.
      {
        ...assistant(sid, 'msg_s', 'req_s', { input_tokens: 5 }, 3),
        message: { id: 'msg_s', model: '<synthetic>', usage: { input_tokens: 5 } },
      },
      { type: 'ai-title', aiTitle: 'Fix the checkout' },
    ]),
  )
  // A subagent log repeats the parent's reply and adds one of its own.
  await writeFile(
    join(folder, sid, 'subagents', 'agent-a.jsonl'),
    jsonl([
      assistant(sid, 'msg_1', 'req_1', { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 100 }, 1),
      assistant(sid, 'msg_2', 'req_2', { input_tokens: 3, output_tokens: 4 }, 70),
    ]),
  )

  const { entries, result } = await scan()
  assert.equal(result.sources.find((source) => source.id === 'claude-code')?.found, 1)
  assert.equal(entries.length, 1)
  const [entry] = entries
  assert.equal(entry!.sessionId, sid)
  assert.equal(entry!.providerId, 'claude-agent')
  assert.equal(entry!.title, 'Fix the checkout')
  assert.equal(entry!.cwd, join(home, 'repo'))
  const byHour = new Map(entry!.buckets.map((bucket) => [bucket[0], bucket]))
  const first = byHour.get(Math.floor(Date.parse(at(1)) / HOUR) * HOUR)!
  assert.deepEqual(first.slice(1), ['claude-opus-4-1', '', 10, 40, 100, 7, 1, 0])
  const later = byHour.get(Math.floor(Date.parse(at(70)) / HOUR) * HOUR)!
  assert.deepEqual(later.slice(3, 8), [3, 4, 0, 0, 1])
})

test('Codex: token_usage_record counted once per response, cached input taken out of input', async () => {
  const day = join(roots.codexHome, 'sessions', '2026', '10', '08')
  await mkdir(day, { recursive: true })
  await writeFile(
    join(roots.codexHome, 'session_index.jsonl'),
    jsonl([{ id: 'thread-1', thread_name: 'Speed up tests' }]),
  )
  const record = (id: string, minutes: number) => ({
    type: 'token_usage_record',
    timestamp: at(minutes),
    payload: {
      response_id: id,
      model: 'gpt-5-codex',
      usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 },
    },
  })
  await writeFile(
    join(day, 'rollout-2026-10-08-a.jsonl'),
    jsonl([
      {
        type: 'session_meta',
        timestamp: at(0),
        payload: { id: 'thread-1', cwd: join(home, 'repo'), originator: 'codex_cli' },
      },
      { type: 'turn_context', timestamp: at(0), payload: { model: 'gpt-5-codex', cwd: join(home, 'repo') } },
      record('resp_1', 1),
      record('resp_1', 1),
      record('resp_2', 2),
      // Totals are ignored when the rollout has per-response records.
      {
        type: 'event_msg',
        timestamp: at(3),
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 99999 } } },
      },
    ]),
  )
  const { entries } = await scan()
  assert.equal(entries.length, 1)
  assert.equal(entries[0]!.sessionId, 'thread-1')
  assert.equal(entries[0]!.title, 'Speed up tests')
  assert.equal(entries[0]!.providerId, 'codex-agent')
  const totals = entries[0]!.buckets.reduce(
    (sum, bucket) => sum.map((value, index) => value + (bucket[3 + index] as number)),
    [0, 0, 0, 0, 0],
  )
  assert.deepEqual(totals, [400, 100, 1600, 0, 2])
})

test('Codex: an older rollout is read from its running totals, differenced', async () => {
  const day = join(roots.codexHome, 'sessions', '2026', '10', '08')
  await mkdir(day, { recursive: true })
  const count = (minutes: number, input: number, cached: number, output: number) => ({
    type: 'event_msg',
    timestamp: at(minutes),
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } },
    },
  })
  await writeFile(
    join(day, 'rollout-old.jsonl'),
    jsonl([
      { type: 'session_meta', timestamp: at(0), payload: { id: 'old-1', cwd: join(home, 'repo') } },
      { type: 'turn_context', timestamp: at(0), payload: { model: 'gpt-5' } },
      count(1, 100, 0, 10),
      count(2, 100, 0, 10), // unchanged: nothing
      count(3, 300, 150, 30),
      { type: 'event_msg', timestamp: at(4), payload: { type: 'user_message', message: 'Second line\nmore' } },
    ]),
  )
  const { entries } = await scan()
  const totals = entries[0]!.buckets.reduce(
    (sum, bucket) => sum.map((value, index) => value + (bucket[3 + index] as number)),
    [0, 0, 0, 0, 0],
  )
  // 100 fresh, then 200 more of which 150 cached; output 10 + 20; two requests.
  assert.deepEqual(totals, [150, 30, 150, 0, 2])
  assert.equal(entries[0]!.title, 'Second line')
})

test('Studio transcripts: usage, reported cost and the CLI session each turn ran', async () => {
  const root = join(home, 'project')
  const dir = join(root, '.sprintengine', 'conversations', 'ws-1')
  await mkdir(dir, { recursive: true })
  roots.studioDirs = [{ dir, workspaceId: 'ws-1', root }]
  await writeFile(join(dir, 'index.json'), JSON.stringify({ threads: [{ agentId: 'chat 1', title: 'Release notes' }] }))
  const turn = (minutes: number, payload: Record<string, unknown>) => ({
    type: 'turn_completed',
    providerId: 'cursor-agent',
    modelId: 'auto',
    createdAt: Date.parse(at(minutes)),
    payload,
  })
  await writeFile(
    join(dir, 'chat%201.jsonl'),
    jsonl([
      { type: 'user_message', createdAt: Date.parse(at(0)), payload: { text: 'hello' } },
      turn(1, {
        usage: { inputTokens: 12, outputTokens: 30, cacheReadTokens: 500 },
        costUsd: 0.25,
        providerCursor: { sessionId: 'cli-9' },
      }),
      // An older turn: no usage, a cost.
      turn(2, { costUsd: 0.1 }),
      // Nothing to count.
      turn(3, {}),
    ]),
  )
  const { entries } = await scan()
  assert.equal(entries.length, 1)
  const [entry] = entries
  assert.equal(entry!.src, 'studio')
  assert.equal(entry!.sessionId, 'chat 1')
  assert.equal(entry!.title, 'Release notes')
  assert.equal(entry!.providerId, 'cursor-agent')
  assert.deepEqual(entry!.studio, { workspaceId: 'ws-1', agentId: 'chat 1', root, links: ['cli-9'] })
  const sorted = [...entry!.buckets].sort((a, b) => a[2].localeCompare(b[2]))
  assert.deepEqual(
    sorted.map((bucket) => bucket.slice(1)),
    [
      ['auto', '', 0, 0, 0, 0, 0, 0.1],
      ['auto', 'cli-9', 12, 30, 500, 0, 1, 0.25],
    ],
  )
})

test('an unchanged session is not read again; a removed one is reported', async () => {
  const sid = 'aaaaaaaa-2222-3333-4444-555555555555'
  const folder = join(roots.claudeProjects, '-repo')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, `${sid}.jsonl`), jsonl([assistant(sid, 'm', 'r', { input_tokens: 1 }, 1)]))
  const first = await scan()
  const previous = Object.fromEntries(first.entries.map((entry) => [entry.key, entry.fp]))
  const second = await scan({ ...previous, 'claude-code:-gone/x': '1|1:1' })
  assert.equal(second.entries.length, 0)
  assert.equal(second.result.changed, 0)
  assert.deepEqual(second.result.removed, ['claude-code:-gone/x'])
})

test('a missing source is empty, not an error', async () => {
  const { result } = await scan()
  assert.deepEqual(
    result.sources.map((source) => [source.id, source.found, source.error]),
    [
      ['studio', 0, null],
      ['claude-code', 0, null],
      ['codex', 0, null],
      ['opencode', 0, null],
      ['gemini', 0, null],
      ['grok', 0, null],
    ],
  )
})

const sum = (entry: UsageCacheEntry, index: 3 | 4 | 5 | 6 | 7 | 8): number =>
  entry.buckets.reduce((total, bucket) => total + (bucket[index] as number), 0)

test("OpenCode's database is read a session at a time, with its own price kept", async () => {
  const { DatabaseSync } = await import('node:sqlite')
  roots.opencodeData = join(home, 'opencode')
  await mkdir(roots.opencodeData, { recursive: true })
  const db = new DatabaseSync(join(roots.opencodeData, 'opencode.db'))
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
  db.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_1', 'Fix the parser', join(home, 'repo'))
  const message = (id: string, data: Record<string, unknown>, minutes: number) =>
    db
      .prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)')
      .run(id, 'ses_1', T0 + minutes * 60_000, T0 + minutes * 60_000, JSON.stringify(data))
  message('msg_u', { role: 'user', time: { created: T0 } }, 0)
  message(
    'msg_a',
    {
      role: 'assistant',
      modelID: 'claude-sonnet-4-5',
      providerID: 'anthropic',
      cost: 0.42,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 50 } },
      time: { created: T0 + 60_000 },
    },
    1,
  )
  message(
    'msg_b',
    {
      role: 'assistant',
      modelID: 'big-pickle',
      cost: 0,
      tokens: { input: 7, output: 3, cache: { read: 0, write: 0 } },
    },
    2,
  )
  db.close()

  const first = await scan()
  const entry = first.entries.find((candidate) => candidate.src === 'opencode')!
  assert.equal(entry.key, 'opencode:opencode.db/ses_1')
  assert.equal(entry.providerId, 'opencode-agent')
  assert.equal(entry.sessionId, 'ses_1')
  assert.equal(entry.title, 'Fix the parser')
  assert.equal(entry.cwd, join(home, 'repo'))
  assert.deepEqual(
    entry.buckets.map((bucket) => bucket.slice(1)).sort(),
    [
      // Reasoning is billed as output; the price OpenCode wrote is kept.
      ['big-pickle', '', 7, 3, 0, 0, 1, 0],
      ['claude-sonnet-4-5', '', 100, 25, 1000, 50, 1, 0.42],
    ].sort(),
  )

  // Unchanged, the session is not read again.
  const previous = Object.fromEntries(first.entries.map((candidate) => [candidate.key, candidate.fp]))
  const second = await scan(previous)
  assert.equal(second.result.changed, 0)
})

test("an older OpenCode's per-message files are read by session folder", async () => {
  roots.opencodeData = join(home, 'opencode')
  const dir = join(roots.opencodeData, 'storage', 'message', 'ses_old')
  await mkdir(dir, { recursive: true })
  await mkdir(join(roots.opencodeData, 'storage', 'session', 'proj'), { recursive: true })
  await writeFile(
    join(roots.opencodeData, 'storage', 'session', 'proj', 'ses_old.json'),
    JSON.stringify({ id: 'ses_old', title: 'Old session', directory: join(home, 'repo') }),
  )
  await writeFile(
    join(dir, 'msg_1.json'),
    JSON.stringify({
      role: 'assistant',
      modelID: 'gpt-5',
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 4, write: 0 } },
      time: { created: T0 },
    }),
  )
  const { entries } = await scan()
  const entry = entries.find((candidate) => candidate.src === 'opencode')!
  assert.equal(entry.sessionId, 'ses_old')
  assert.equal(entry.title, 'Old session')
  assert.deepEqual(entry.buckets[0]!.slice(1), ['gpt-5', '', 10, 2, 4, 0, 1, 0])
})

test('a Gemini CLI recording counts each reply once, cached input apart from fresh', async () => {
  roots.geminiHome = join(home, '.gemini')
  const chats = join(roots.geminiHome, 'tmp', 'abc123', 'chats')
  await mkdir(chats, { recursive: true })
  await writeFile(
    join(chats, 'session-2026-10-08T09-15-aaaa.json'),
    JSON.stringify({
      sessionId: 'gem-1',
      messages: [
        { id: 'u1', type: 'user', timestamp: at(0), content: 'Explain the build\nplease' },
        {
          id: 'g1',
          type: 'gemini',
          model: 'gemini-2.5-pro',
          timestamp: at(1),
          tokens: { input: 1200, output: 80, cached: 1000, thoughts: 20, tool: 0, total: 1300 },
        },
      ],
    }),
  )
  const { entries, result } = await scan()
  assert.equal(result.sources.find((source) => source.id === 'gemini')?.found, 1)
  const entry = entries.find((candidate) => candidate.src === 'gemini')!
  assert.equal(entry.sessionId, 'gem-1')
  assert.equal(entry.title, 'Explain the build')
  assert.equal(entry.providerId, 'gemini')
  assert.deepEqual(entry.buckets[0]!.slice(1), ['gemini-2.5-pro', '', 200, 100, 1000, 0, 1, 0])
})

test("a Grok session's completed turns are counted per model, at Grok's own price", async () => {
  roots.grokHome = join(home, '.grok')
  const cwd = join(home, 'repo')
  const dir = join(roots.grokHome, 'sessions', encodeURIComponent(cwd), '01a0-session')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'summary.json'),
    JSON.stringify({ session_summary: 'Tidy the tests', current_model_id: 'grok-4.6' }),
  )
  const turn = (promptId: string, usage: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: '01a0-session',
      update: { sessionUpdate: 'turn_completed', promptId, usage },
      _meta: { agentTimestampMs: T0 },
    },
  })
  await writeFile(
    join(dir, 'updates.jsonl'),
    jsonl([
      { params: { update: { sessionUpdate: 'agent_message_chunk' } } },
      turn('p1', {
        inputTokens: 500,
        cachedReadTokens: 400,
        cacheCreationTokens: 0,
        outputTokens: 30,
        costUsdTicks: 5e8,
      }),
      // A turn reported twice is counted once.
      turn('p1', {
        inputTokens: 500,
        cachedReadTokens: 400,
        cacheCreationTokens: 0,
        outputTokens: 30,
        costUsdTicks: 5e8,
      }),
      turn('p2', {
        modelUsage: {
          'grok-4.6': { inputTokens: 100, cachedReadTokens: 0, outputTokens: 10, costUsdTicks: 1e8 },
          'grok-code-fast': { inputTokens: 50, cachedReadTokens: 20, outputTokens: 5, costUsdTicks: 0 },
        },
      }),
    ]),
  )
  const { entries } = await scan()
  const entry = entries.find((candidate) => candidate.src === 'grok')!
  assert.equal(entry.providerId, 'grok-agent')
  assert.equal(entry.sessionId, '01a0-session')
  assert.equal(entry.cwd, cwd)
  assert.equal(entry.title, 'Tidy the tests')
  assert.equal(sum(entry, 3), 100 + 100 + 30)
  assert.equal(sum(entry, 5), 400 + 20)
  assert.equal(sum(entry, 7), 3)
  assert.ok(Math.abs(sum(entry, 8) - 0.06) < 1e-9)
  assert.deepEqual(entry.buckets.map((bucket) => bucket[1]).sort(), ['grok-4.6', 'grok-code-fast'])
})

test('repositoryRoot follows a linked worktree back to its repository', async () => {
  const repo = join(home, 'repo')
  const worktree = join(home, 'pool', 'slot-1')
  await mkdir(join(repo, '.git', 'worktrees', 'slot-1'), { recursive: true })
  await mkdir(join(worktree, 'src'), { recursive: true })
  await writeFile(join(worktree, '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'slot-1')}\n`)
  assert.equal(await repositoryRoot(join(worktree, 'src')), repo)
  assert.equal(await repositoryRoot(join(repo)), repo)
  assert.equal(await repositoryRoot(join(home, 'elsewhere')), null)
})

// ── Reading lines ──

// How lines were read before they were tested as bytes: the whole file decoded,
// split on the newline character, each line tested as text.
async function decodedLines(path: string, keep: (line: string) => boolean): Promise<string[]> {
  const kept: string[] = []
  let carry = ''
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 7 }) as AsyncIterable<string>) {
    const text = carry + chunk
    let from = 0
    for (let at = text.indexOf('\n', from); at >= 0; at = text.indexOf('\n', from)) {
      const line = text.slice(from, at)
      from = at + 1
      if (line && keep(line)) kept.push(line)
    }
    carry = text.slice(from)
  }
  if (carry && keep(carry)) kept.push(carry)
  return kept
}

async function byteLines(path: string, markers: string[], chunkBytes?: number): Promise<string[]> {
  const encoded = markers.map((marker) => Buffer.from(marker))
  const kept: string[] = []
  await forEachLine(
    path,
    (line) => encoded.some((marker) => line.includes(marker)),
    (line) => kept.push(line),
    chunkBytes ? { chunkBytes } : {},
  )
  return kept
}

// Every awkward line at once: markers beside multibyte text, CRLF endings, a
// blank line, a marker only in text that is not JSON, and no final newline.
const MIXED = [
  JSON.stringify({ type: 'assistant', text: 'héllo wörld' }),
  '',
  `${JSON.stringify({ type: 'user', text: '日本語のテキスト' })}\r`,
  `${JSON.stringify({ text: '🙂🙂', type: 'assistant' })}\r`,
  JSON.stringify({ type: 'summary', summary: 'Résumé "type":"assistant" inside a string' }),
  'not json but "type":"assistant"',
  JSON.stringify({ type: 'tool_result', content: 'ünïcödé'.repeat(40) }),
  JSON.stringify({ type: 'assistant', text: 'the last line, with no newline after it ✓' }),
].join('\n')

test('lines tested as bytes are the lines tested as decoded text, at every chunk size', async () => {
  const path = join(home, 'mixed.jsonl')
  await writeFile(path, MIXED)
  for (const markers of [['"type":"assistant"'], ['"type":"summary"', '"type":"user"'], ['ünïcödé'], ['']]) {
    const expected = await decodedLines(path, (line) => markers.some((marker) => line.includes(marker)))
    assert.ok(expected.length > 0)
    for (const chunkBytes of [1, 2, 3, 5, 16, 64, undefined])
      assert.deepEqual(await byteLines(path, markers, chunkBytes), expected, `${markers} at ${chunkBytes ?? 'default'}`)
  }
})

test('a marker split across two chunks still keeps its line', async () => {
  const path = join(home, 'split.jsonl')
  const line = JSON.stringify({ padding: 'x'.repeat(10), type: 'assistant' })
  await writeFile(path, `${line}\n`)
  const marker = '"type":"assistant"'
  // Chunks that end inside the marker, at each of its bytes.
  for (let cut = line.indexOf(marker) + 1; cut < line.indexOf(marker) + marker.length; cut += 1)
    assert.deepEqual(await byteLines(path, [marker], cut), [line])
})

test('a multibyte character split across two chunks decodes whole, beside a marker', async () => {
  const path = join(home, 'multibyte.jsonl')
  const line = `${JSON.stringify({ type: 'assistant', text: '€🙂€' })}`
  await writeFile(path, `${line}\r\n${line}`)
  for (let chunkBytes = 1; chunkBytes <= Buffer.byteLength(line) + 2; chunkBytes += 1)
    assert.deepEqual(await byteLines(path, ['"type":"assistant"'], chunkBytes), [`${line}\r`, line])
})

test('a Claude Code log written with CRLF counts what the same log with LF does', async () => {
  const sid = '99999999-2222-3333-4444-555555555555'
  const folder = join(roots.claudeProjects, '-repo')
  await mkdir(folder, { recursive: true })
  const records = [
    { type: 'user', sessionId: sid, cwd: join(home, 'repo'), timestamp: at(0), message: { content: 'naïve café' } },
    assistant(sid, 'msg_1', 'req_1', { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 100 }, 1),
    { type: 'ai-title', aiTitle: 'Fix the café' },
  ]
  await writeFile(join(folder, `${sid}.jsonl`), jsonl(records))
  const lf = (await scan()).entries
  await writeFile(join(folder, `${sid}.jsonl`), jsonl(records).replaceAll('\n', '\r\n'))
  const crlf = (await scan()).entries
  assert.equal(lf.length, 1)
  assert.deepEqual(
    crlf.map(({ fp: _fp, ...entry }) => entry),
    lf.map(({ fp: _fp, ...entry }) => entry),
  )
  assert.equal(crlf[0]!.title, 'Fix the café')
})
