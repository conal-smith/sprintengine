import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm, symlink, stat, link } from 'node:fs/promises'
import { workspaceStorePath } from './workspace-store'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ConversationIndex, conversationIndexTranscriptPath, firstMessageTitle } from './conversation-index'
import type { ConversationEvent } from '../shared/conversation-runtime'

async function fixture(
  run: (key: { workspaceRoot: string; workspaceId: string; agentId: string }, path: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-index-'))
  const key = { workspaceRoot: root, workspaceId: 'workspace', agentId: 'agent' }
  const path = conversationIndexTranscriptPath(key)
  await mkdir(workspaceStorePath(root, 'conversations', 'workspace'), { recursive: true })
  try {
    await run(key, path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function event(
  seq: number,
  type: ConversationEvent['type'],
  payload: Record<string, unknown>,
  agentId = 'agent',
): ConversationEvent {
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId,
    providerId: 'provider',
    modelId: 'model',
    createdAt: seq * 1000,
    type,
    payload,
  }
}
const lines = (events: ConversationEvent[]) => `${events.map((value) => JSON.stringify(value)).join('\n')}\n`

test('missing, corrupt and old-version caches rebuild from authoritative events', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'turn', text: 'Build a useful chat' }),
        event(2, 'turn_completed', { turnId: 'turn' }),
      ]),
    )
    const index = new ConversationIndex(),
      cache = workspaceStorePath(key.workspaceRoot, 'conversations', key.workspaceId, 'index.json')
    expect(await index.list(key)).toMatchObject([
      { agentId: 'agent', title: 'Build a useful chat', titleSource: 'first-message', turnCount: 1, lastSeq: 2 },
    ])
    for (const invalid of ['{broken', '{"version":0,"threads":[],"files":[]}']) {
      await writeFile(cache, invalid)
      expect((await index.list(key))[0]?.title).toBe('Build a useful chat')
    }
    expect(JSON.parse(await readFile(cache, 'utf8')).version).toBe(4)
  }))

test('conversation cost includes old turns and deduplicates completion records', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'turn_completed', { turnId: 'first', costUsd: 0.25 }),
        event(2, 'turn_completed', { turnId: 'second', costUsd: 0.5 }),
        event(3, 'turn_completed', { turnId: 'first', costUsd: 0.25 }),
        event(4, 'turn_completed', { turnId: 'third', costUsd: -1 }),
      ]),
    )
    expect((await new ConversationIndex().list(key))[0]?.totalCostUsd).toBe(0.75)
    expect((await new ConversationIndex().list(key))[0]?.totalCostUsd).toBe(0.75)
  }))

test('user rename survives rebuild and always wins over a generated title', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { text: 'Initial title' }),
        event(2, 'session_updated', { conversationTitle: 'My title', titleSource: 'user' }),
        event(3, 'session_updated', { conversationTitle: 'Generated later', titleSource: 'generated' }),
      ]),
    )
    expect((await new ConversationIndex().list(key))[0]).toMatchObject({ title: 'My title', titleSource: 'user' })
    expect(firstMessageTitle('  one\n two  ')).toBe('one two')
    expect(firstMessageTitle('x'.repeat(100))).toHaveLength(60)
  }))

test('search joins split assistant deltas and returns a jumpable user-turn sequence', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'turn', text: 'Question' }),
        event(2, 'content_delta', { turnId: 'turn', text: 'The alpha ' }),
        event(3, 'content_delta', { turnId: 'turn', text: 'beta answer.' }),
      ]),
    )
    const batches: unknown[] = []
    expect(
      await new ConversationIndex().search(
        { ...key, query: 'ALPHA BETA' },
        { onBatch: (batch) => batches.push(batch) },
      ),
    ).toEqual([{ agentId: 'agent', seq: 1, turnId: 'turn', snippet: 'The alpha beta answer.', from: 'agent' }])
    expect(batches).toHaveLength(1)
  }))

test('refresh creates the cache and a later append invalidates a stale cache', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { turnId: 'one', text: 'First' })]))
    const index = new ConversationIndex()
    await index.refresh(key)
    expect(
      await stat(workspaceStorePath(key.workspaceRoot, 'conversations', key.workspaceId, 'index.json')),
    ).toBeDefined()
    await appendFile(path, lines([event(2, 'user_message', { turnId: 'two', text: 'Second' })]))
    expect((await index.list(key))[0]?.turnCount).toBe(2)
  }))

test('search caps hits, emits bounded batches and honours cancellation', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines(
        Array.from({ length: 500 }, (_, index) =>
          event(index + 1, 'user_message', { turnId: `turn-${index}`, text: 'match' }),
        ),
      ),
    )
    const index = new ConversationIndex(),
      batches: number[] = []
    expect(
      await index.search({ ...key, query: 'match' }, { onBatch: (batch) => batches.push(batch.length) }),
    ).toHaveLength(200)
    expect(batches).toEqual(Array.from({ length: 10 }, () => 20))
    const controller = new AbortController()
    controller.abort()
    await expect(index.search({ ...key, query: 'match' }, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  }))

test('delete closes the transcript and removes only its log, detail directory and cache row', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { text: 'One' })]))
    const other = conversationIndexTranscriptPath({ ...key, agentId: 'other' })
    await writeFile(other, lines([event(1, 'user_message', { text: 'Other' }, 'other')]))
    const tools = path.replace(/\.jsonl$/, '.tools')
    await mkdir(tools)
    await writeFile(join(tools, 'tool.json'), '{}')
    const closed: string[] = [],
      index = new ConversationIndex({
        close: async (value) => {
          closed.push(value)
        },
      })
    await index.list(key)
    await index.delete(key)
    expect(closed).toEqual([path])
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(tools)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await index.list(key)).toMatchObject([{ agentId: 'other' }])
    expect(await readFile(other, 'utf8')).toContain('Other')
  }))

test('cancellation during a streamed batch stops without leaking a stream error', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines(
        Array.from({ length: 1000 }, (_, index) =>
          event(index + 1, 'user_message', { turnId: `turn-${index}`, text: `match ${'padding '.repeat(200)}` }),
        ),
      ),
    )
    const controller = new AbortController()
    await expect(
      new ConversationIndex().search(
        { ...key, query: 'match' },
        {
          signal: controller.signal,
          onBatch: () => controller.abort(),
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  }))

test('a symlink transcript is neither searched nor deleted through', async () =>
  fixture(async (key, path) => {
    const outside = join(key.workspaceRoot, 'private.jsonl')
    await writeFile(outside, lines([event(1, 'user_message', { text: 'private match' })]))
    await symlink(outside, path)
    const index = new ConversationIndex()
    expect(await index.search({ ...key, query: 'private' })).toEqual([])
    await expect(index.delete(key)).rejects.toThrow('symbolic link')
    expect(await readFile(outside, 'utf8')).toContain('private match')
  }))

test('coalesced delta sequence ranges survive index rebuild', async () =>
  fixture(async (key, path) => {
    const merged = {
      ...event(2, 'content_delta', { turnId: 'turn', text: 'ab' }),
      parts: [
        ['first', 2000, 1, 2],
        ['second', 3000, 1, 3],
      ],
    }
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'turn', text: 'Question' }),
        merged,
        event(4, 'turn_completed', { turnId: 'turn' }),
      ]),
    )
    expect((await new ConversationIndex().list(key))[0]?.lastSeq).toBe(4)
  }))

test('a transcript past the read limit is listed and searched from its opening and its end', async () =>
  fixture(async (key, path) => {
    const events = [event(1, 'user_message', { turnId: 't0', text: 'Opening question' })]
    for (let seq = 2; seq < 400; seq++)
      events.push(event(seq, 'content_delta', { turnId: 't0', text: `filler ${'x'.repeat(200)}` }))
    events.push(event(400, 'user_message', { turnId: 't1', text: 'Closing needle question' }))
    events.push(event(401, 'turn_completed', { turnId: 't1' }))
    await writeFile(path, lines(events))
    const size = (await stat(path)).size
    // Below the file, and far enough below it that the middle is skipped.
    const index = new ConversationIndex({ maxTranscriptBytes: Math.floor(size / 4) })
    const [thread] = await index.list(key)
    expect(thread).toMatchObject({ agentId: 'agent', title: 'Opening question', lastSeq: 401 })
    expect(await index.search({ ...key, query: 'needle' })).toMatchObject([{ agentId: 'agent', seq: 400 }])
  }))

test('an unreadable transcript gets a row of its own instead of failing the whole list and search', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { turnId: 't', text: 'Readable chat' })]))
    const folder = workspaceStorePath(key.workspaceRoot, 'conversations', key.workspaceId)
    const other = join(folder, 'other.jsonl')
    await writeFile(other, lines([event(1, 'user_message', { turnId: 't', text: 'Readable chat too' }, 'other')]))
    // A hard link is refused by confined file access, like any other unsafe file.
    const linked = join(tmpdir(), `conversation-index-link-${process.pid}-${Date.now()}`)
    await link(other, linked)
    try {
      const threads = await new ConversationIndex().list(key)
      expect(threads.map((thread) => [thread.agentId, thread.title]).sort()).toEqual([
        ['agent', 'Readable chat'],
        ['other', 'Unreadable conversation'],
      ])
    } finally {
      await rm(linked, { force: true })
    }
    await link(other, linked)
    try {
      expect(await new ConversationIndex().search({ ...key, query: 'readable' })).toMatchObject([{ agentId: 'agent' }])
    } finally {
      await rm(linked, { force: true })
    }
  }))

test('an unreadable transcript whose file name is not valid percent-encoding still gets its row', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { turnId: 't', text: 'Readable chat' })]))
    const folder = workspaceStorePath(key.workspaceRoot, 'conversations', key.workspaceId)
    const odd = join(folder, '50%.jsonl')
    await writeFile(odd, lines([event(1, 'user_message', { turnId: 't', text: 'Hidden' }, '50%')]))
    const linked = join(tmpdir(), `conversation-index-link-${process.pid}-${Date.now()}`)
    await link(odd, linked)
    try {
      const threads = await new ConversationIndex().list(key)
      expect(threads.map((thread) => [thread.agentId, thread.title]).sort()).toEqual([
        ['50%', 'Unreadable conversation'],
        ['agent', 'Readable chat'],
      ])
    } finally {
      await rm(linked, { force: true })
    }
  }))

test('a listing reads only the transcripts that changed and keeps every other cached row', async () =>
  fixture(async (key, path) => {
    const folder = workspaceStorePath(key.workspaceRoot, 'conversations', key.workspaceId)
    await writeFile(path, lines([event(1, 'user_message', { turnId: 'one', text: 'Busy chat' })]))
    await writeFile(
      join(folder, 'quiet.jsonl'),
      lines([event(1, 'user_message', { turnId: 'one', text: 'Quiet chat' }, 'quiet')]),
    )
    const index = new ConversationIndex()
    await index.list(key)
    // Mark the quiet chat's cached row: it is served as cached only if its transcript is not read again.
    const cachePath = join(folder, 'index.json')
    const cache = JSON.parse(await readFile(cachePath, 'utf8'))
    for (const thread of cache.threads) if (thread.agentId === 'quiet') thread.title = 'Served from the cache'
    await writeFile(cachePath, JSON.stringify(cache))

    await appendFile(path, lines([event(2, 'user_message', { turnId: 'two', text: 'Again' })]))
    const threads = await index.list(key)
    expect(threads.find((thread) => thread.agentId === 'quiet')?.title).toBe('Served from the cache')
    expect(threads.find((thread) => thread.agentId === 'agent')).toMatchObject({ title: 'Busy chat', turnCount: 2 })
  }))

test('a transcript that grew is read on from where the last read ended', async () =>
  fixture(async (key, path) => {
    // The first line is longer than the bytes that identify the file, so the second can change below it.
    const first = JSON.stringify(event(1, 'user_message', { turnId: 'one', text: `Opening ${'x'.repeat(600)}` }))
    const second = JSON.stringify(event(2, 'user_message', { turnId: 'two', text: 'Second' }))
    await writeFile(path, `${first}\n${second}\n`)
    const index = new ConversationIndex()
    expect((await index.list(key))[0]?.turnCount).toBe(2)

    // Already read: blanking it now changes nothing an incremental read looks at.
    const third = JSON.stringify(event(3, 'user_message', { turnId: 'three', text: 'Third' }))
    await writeFile(path, `${first}\n${' '.repeat(second.length)}\n${third}\n`)
    expect((await index.list(key))[0]).toMatchObject({ turnCount: 3, lastSeq: 3 })
    expect((await index.refresh(key))?.turnCount).toBe(3)

    // A new instance knows nothing it read before and reads the whole file.
    await appendFile(path, lines([event(4, 'turn_completed', { turnId: 'three' })]))
    expect((await new ConversationIndex().list(key))[0]?.turnCount).toBe(2)
  }))

test('costs and turns are counted once across an append', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'first', text: 'Question' }),
        event(2, 'turn_completed', { turnId: 'first', costUsd: 0.25 }),
      ]),
    )
    const index = new ConversationIndex()
    expect((await index.list(key))[0]).toMatchObject({ turnCount: 1, totalCostUsd: 0.25 })
    await appendFile(
      path,
      lines([
        event(3, 'turn_completed', { turnId: 'first', costUsd: 0.25 }),
        event(4, 'user_message', { turnId: 'second', text: 'Another' }),
        event(5, 'turn_completed', { turnId: 'second', costUsd: 0.5 }),
      ]),
    )
    expect((await index.list(key))[0]).toMatchObject({ turnCount: 2, totalCostUsd: 0.75, lastSeq: 5 })
  }))

test('a transcript deleted and written again under the same name is read whole', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { turnId: 'one', text: 'Old chat' })]))
    const index = new ConversationIndex()
    expect((await index.list(key))[0]?.title).toBe('Old chat')
    await rm(path)
    await writeFile(
      path,
      lines([
        { ...event(1, 'user_message', { turnId: 'new', text: 'New chat' }), id: 'another-run' },
        event(2, 'user_message', { turnId: 'next', text: 'More' }),
      ]),
    )
    expect((await index.list(key))[0]).toMatchObject({ title: 'New chat', turnCount: 2 })
  }))

test('a row says when its agent last finished a turn, a steered end aside, and keeps it across an append', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'one', text: 'Question' }),
        event(2, 'turn_completed', { turnId: 'one' }),
        event(3, 'user_message', { turnId: 'two', text: 'More' }),
        // A message steered into a running turn ends nothing: the work goes on.
        event(4, 'turn_completed', { turnId: 'two', steered: true }),
        event(5, 'session_updated', { conversationTitle: 'Renamed', titleSource: 'user' }),
      ]),
    )
    const index = new ConversationIndex()
    const [first] = await index.list(key)
    expect(first?.lastTurnEndedAt).toBe(2000)
    // A rename moves `updatedAt`, never the turn end.
    expect(first?.updatedAt).toBe(5000)
    await appendFile(path, lines([event(6, 'turn_failed', { turnId: 'two' })]))
    expect((await index.list(key))[0]?.lastTurnEndedAt).toBe(6000)
  }))

test('a chat keeps the opening of its last reply, cleared when the person writes again', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'one', text: 'Question' }),
        event(2, 'content_delta', { turnId: 'one', text: 'The answer ' }),
        event(3, 'content_delta', { turnId: 'one', text: 'is here.' }),
        event(4, 'turn_completed', { turnId: 'one' }),
      ]),
    )
    const index = new ConversationIndex()
    expect((await index.list(key))[0]?.lastAssistantText).toBe('The answer is here.')
    await appendFile(path, lines([event(5, 'user_message', { turnId: 'two', text: 'And then?' })]))
    expect((await index.list(key))[0]?.lastAssistantText).toBe('')
    // The opening only, as the runtime's session keeps it.
    await appendFile(path, lines([event(6, 'content_delta', { turnId: 'two', text: 'x'.repeat(300) })]))
    expect((await index.list(key))[0]?.lastAssistantText).toHaveLength(240)
  }))

test('a chat whose agent never finished a turn names no turn end', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { turnId: 'one', text: 'Question' })]))
    expect('lastTurnEndedAt' in (await new ConversationIndex().list(key))[0]!).toBe(false)
  }))

test('a cache written before rows kept the turn end is read again, so older turns say when they ended', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'one', text: 'Question' }),
        event(2, 'turn_completed', { turnId: 'one' }),
      ]),
    )
    const cache = workspaceStorePath(key.workspaceRoot, 'conversations', key.workspaceId, 'index.json')
    // The file as the version before wrote it: the same fingerprint, a row
    // with no turn end.
    await new ConversationIndex().list(key)
    const written = JSON.parse(await readFile(cache, 'utf8'))
    for (const thread of written.threads) delete thread.lastTurnEndedAt
    await writeFile(cache, JSON.stringify({ ...written, version: 2 }))
    expect((await new ConversationIndex().list(key))[0]?.lastTurnEndedAt).toBe(2000)
  }))

test('search says who wrote each match, and reads past tool output it never parses', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'one', text: 'Is the wave model wired up?' }),
        event(2, 'tool_output', { turnId: 'one', text: 'wave '.repeat(50) }),
        event(3, 'content_delta', { turnId: 'one', text: 'The wave model is wired up.' }),
        event(4, 'user_message', { turnId: 'two', text: 'Wave check', origin: { kind: 'studio' } }),
      ]),
    )
    const hits = await new ConversationIndex().search({ ...key, query: 'wave' })
    expect(hits.map((hit) => [hit.seq, hit.from])).toEqual([
      [1, 'person'],
      [1, 'agent'],
      [4, 'studio'],
    ])
  }))
