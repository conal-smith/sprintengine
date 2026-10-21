import assert from 'node:assert/strict'
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import { ConversationCheckpoints, longPathsConfig } from './conversation-checkpoints'
import { runGitCommand } from './git-utils'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import type {
  ConversationEvent,
  ConversationRevertInput,
  ConversationRevertResult,
} from '../shared/conversation-runtime'

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGitCommand(cwd, args)
  assert.ok(result.ok, result.message ?? result.stderr)
  return result.stdout
}
/** What the dialog does: preview, then confirm exactly the files it showed. */
async function previewThenRevert(
  revert: (input: ConversationRevertInput) => Promise<ConversationRevertResult>,
  input: Omit<ConversationRevertInput, 'confirmed' | 'files'>,
): Promise<ConversationRevertResult> {
  const preview = await revert(input)
  if (!preview.ok) return preview
  return revert({ ...input, confirmed: true, files: preview.files.map((file) => file.path) })
}
async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-checkpoints-'))
  const root = join(directory, 'repository')
  await mkdir(root)
  await git(root, ['init'])
  await git(root, ['config', 'user.name', 'Developer'])
  await git(root, ['config', 'user.email', 'dev@example.com'])
  await writeFile(join(root, 'existing.txt'), 'original\n')
  await writeFile(join(root, 'deleted.txt'), 'keep\n')
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n.sprintengine/\n')
  await git(root, ['add', '.'])
  await git(root, ['commit', '-m', 'Initial files'])
  return { root, directory, key: { workspaceRoot: root, workspaceId: 'workspace', agentId: 'agent' } }
}

test('revert locks all conversations sharing files until the transaction settles', async () => {
  const f = await repository()
  const adapter = createMockConversationProvider()
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const running = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = ConversationCheckpoints.prototype.revert
  const delayed = vi.spyOn(ConversationCheckpoints.prototype, 'revert').mockImplementation(async function (
    this: ConversationCheckpoints,
    input,
  ) {
    entered()
    await gate
    return original.call(this, input)
  })
  try {
    const a = await runtime.startSession({ ...f.key, providerId: adapter.id, modelId: adapter.listModels()[0] })
    const b = await runtime.startSession({
      ...f.key,
      agentId: 'other',
      providerId: adapter.id,
      modelId: adapter.listModels()[0],
    })
    assert.ok(a.ok && b.ok)
    assert.ok((await new ConversationCheckpoints().capture(f.key, 1, 'pre')).ok)
    const reverting = runtime.revertToTurn({ key: f.key, turnSeq: 1, confirmed: true, files: [] })
    await running
    assert.equal((await runtime.sendTurn({ sessionId: a.session.sessionId, message: 'edit' })).ok, false)
    assert.equal((await runtime.sendTurn({ sessionId: b.session.sessionId, message: 'edit' })).ok, false)
    assert.equal((await runtime.deleteTranscript(f.key)).ok, false)
    assert.equal((await runtime.revertToTurn({ key: f.key, turnSeq: 1, confirmed: true })).ok, false)
    assert.equal(
      (
        await runtime.startSession({
          ...f.key,
          agentId: 'third',
          providerId: adapter.id,
          modelId: adapter.listModels()[0],
        })
      ).ok,
      false,
    )
    release()
    assert.ok((await reverting).ok)
  } finally {
    release()
    delayed.mockRestore()
    await runtime.shutdown()
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('reverting a closed conversation persists markers and the next-send file-state notice', async () => {
  const f = await repository()
  let lastMessage = ''
  const adapter = {
    ...createMockConversationProvider(),
    sendTurn(input: Parameters<ReturnType<typeof createMockConversationProvider>['sendTurn']>[0]) {
      lastMessage = input.message
      return [
        {
          id: '',
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          providerId: input.providerId,
          modelId: input.modelId,
          createdAt: 0,
          type: 'turn_completed' as const,
          payload: { turnId: input.turnId },
        },
      ]
    },
  }
  const initial = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  try {
    assert.ok((await initial.startSession({ ...f.key, providerId: adapter.id, modelId: adapter.listModels()[0] })).ok)
    await initial.shutdown()
    assert.ok((await new ConversationCheckpoints().capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'changed\n')
    assert.ok((await previewThenRevert((input) => runtime.revertToTurn(input), { key: f.key, turnSeq: 1 })).ok)
    const transcript = await runtime.readTranscript(f.key, { all: true })
    assert.ok(transcript.ok)
    assert.equal(transcript.events.at(-1)?.payload?.revertedAfterSeq, 1)
    const opened = await runtime.startSession({ ...f.key, providerId: adapter.id, modelId: adapter.listModels()[0] })
    assert.ok(opened.ok)
    await runtime.sendTurn({ sessionId: opened.session.sessionId, message: 'continue' })
    assert.match(lastMessage, /Files were reverted/)
  } finally {
    await initial.shutdown()
    await runtime.shutdown()
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('capture preserves the user branch, staging bytes and mtime, status and stash', async () => {
  const f = await repository()
  try {
    await writeFile(join(f.root, 'existing.txt'), 'staged\n')
    await git(f.root, ['add', 'existing.txt'])
    await writeFile(join(f.root, 'existing.txt'), 'unstaged\n')
    await writeFile(join(f.root, 'untracked.txt'), 'new\n')
    const indexPath = join(f.root, '.git', 'index')
    const index = await readFile(indexPath)
    const modified = (await stat(indexPath)).mtimeMs
    const before = await Promise.all([
      git(f.root, ['status', '--porcelain=v1']),
      git(f.root, ['rev-parse', 'HEAD']),
      git(f.root, ['stash', 'list']),
    ])
    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    assert.deepEqual(await readFile(indexPath), index)
    assert.equal((await stat(indexPath)).mtimeMs, modified)
    assert.deepEqual(
      await Promise.all([
        git(f.root, ['status', '--porcelain=v1']),
        git(f.root, ['rev-parse', 'HEAD']),
        git(f.root, ['stash', 'list']),
      ]),
      before,
    )
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('new staged files remain captured when their names match ignore rules', async () => {
  const f = await repository()
  try {
    await writeFile(join(f.root, 'ignored.txt'), 'tracked before\n')
    await git(f.root, ['add', '-f', 'ignored.txt'])
    const index = await readFile(join(f.root, '.git', 'index'))
    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'ignored.txt'), 'tracked after\n')
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    assert.deepEqual(await readFile(join(f.root, '.git', 'index')), index)
    const diff = await checkpoints.getTurnDiff({ key: f.key, turnSeq: 1, path: 'ignored.txt' })
    assert.ok(diff.ok)
    assert.equal(diff.original, 'tracked before\n')
    assert.equal(diff.modified, 'tracked after\n')
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('revert restores modified/deleted files, removes later files, and can undo without touching ignored files', async () => {
  const f = await repository()
  try {
    const checkpoints = new ConversationCheckpoints()
    await writeFile(join(f.root, 'ignored.txt'), 'private ignored content')
    assert.ok((await checkpoints.capture(f.key, 3, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'after\nsecond\n')
    await rm(join(f.root, 'deleted.txt'))
    await writeFile(join(f.root, 'created.txt'), 'created\n')
    assert.ok((await checkpoints.capture(f.key, 3, 'post')).ok)
    const diff = await checkpoints.getTurnDiff({ key: f.key, turnSeq: 3, path: 'existing.txt' })
    assert.ok(diff.ok)
    assert.equal(diff.diff.files.length, 3)
    assert.ok(diff.patch?.includes('+second'))
    const preview = await checkpoints.revert({ key: f.key, turnSeq: 3 })
    assert.ok(preview.ok && !preview.reverted)
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'after\nsecond\n')
    const reverted = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 3 })
    assert.ok(reverted.ok && reverted.reverted)
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'original\n')
    assert.equal(await readFile(join(f.root, 'deleted.txt'), 'utf8'), 'keep\n')
    await assert.rejects(stat(join(f.root, 'created.txt')), { code: 'ENOENT' })
    assert.equal(await readFile(join(f.root, 'ignored.txt'), 'utf8'), 'private ignored content')
    const undo = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 3, undo: true })
    assert.ok(undo.ok)
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'after\nsecond\n')
    assert.equal(await readFile(join(f.root, 'created.txt'), 'utf8'), 'created\n')
    await assert.rejects(stat(join(f.root, 'deleted.txt')), { code: 'ENOENT' })
    await checkpoints.deleteConversation(f.key)
    assert.equal(
      (await git(f.root, ['for-each-ref', '--format=%(refname)', 'refs/sprintengine/checkpoints/'])).trim(),
      '',
    )
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('checkpoint capture supports linked worktrees and refuses oversized untracked payloads', async () => {
  const f = await repository()
  try {
    const root = join(f.directory, 'linked')
    await git(f.root, ['worktree', 'add', '-b', 'linked', root])
    const checkpoints = new ConversationCheckpoints()
    const key = { ...f.key, workspaceRoot: root }
    assert.ok(await checkpoints.available(root))
    assert.ok((await checkpoints.capture(key, 1, 'pre')).ok)
    await writeFile(join(root, 'existing.txt'), 'linked work\n')
    assert.ok((await checkpoints.capture(key, 1, 'post')).ok)
    assert.ok((await previewThenRevert((input) => checkpoints.revert(input), { key, turnSeq: 1 })).ok)
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'original\n')
    await writeFile(join(root, 'too-large.txt'), '12345')
    const limited = new ConversationCheckpoints({ bytes: 4, files: 100 })
    const result = await limited.capture(key, 2, 'pre')
    assert.ok(!result.ok && result.skipped)
    const countLimited = new ConversationCheckpoints({ bytes: 100, files: 0 })
    assert.equal((await countLimited.capture(key, 2, 'pre')).ok, false)
    await checkpoints.collectExpired(root, Date.now() + 31 * 24 * 60 * 60 * 1000)
    assert.equal(
      (await git(root, ['for-each-ref', '--format=%(refname)', 'refs/sprintengine/checkpoints/'])).trim(),
      '',
    )
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('runtime captures lazily around writes, reports totals, blocks active reverts and replays file-state notices', async () => {
  const f = await repository()
  let lastMessage = ''
  const adapter = {
    ...createMockConversationProvider(),
    async *sendTurn(
      input: import('./providers/conversation-provider-adapter').MockAdapterTurnInput,
    ): AsyncIterable<ConversationEvent> {
      lastMessage = input.message
      const envelope = {
        id: '',
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        createdAt: 0,
      }
      yield {
        ...envelope,
        type: 'tool_started',
        payload: {
          turnId: input.turnId,
          tool: 'Write',
          toolCallId: input.turnId,
          input: { path: 'existing.txt', content: 'changed\n' },
        },
      }
      const blocked = await runtime.revertToTurn({ key: f.key, turnSeq: 3, confirmed: true })
      assert.equal(blocked.ok, false)
      await writeFile(join(f.root, 'existing.txt'), 'changed\n')
      yield { ...envelope, type: 'turn_completed', payload: { turnId: input.turnId } }
    },
  }
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  try {
    const started = await runtime.startSession({ ...f.key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    assert.equal(started.session.capabilities?.checkpoints, true)
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'edit' })
    const replay = await runtime.readTranscript(f.key)
    assert.ok(replay.ok)
    const complete = replay.events.find((event) => event.type === 'turn_completed')!
    assert.equal(complete.payload?.checkpointAvailable, true, JSON.stringify(replay.events))
    assert.deepEqual(complete.payload?.checkpointSummary, { files: 1, addedLines: 1, removedLines: 1 })
    const turnSeq = Number(complete.payload?.checkpointTurnSeq)
    const diff = await runtime.getTurnDiff({ key: f.key, turnSeq, path: 'existing.txt' })
    assert.ok(diff.ok)
    assert.equal(diff.original, 'original\n')
    assert.equal(diff.modified, 'changed\n')
    const reverted = await previewThenRevert((input) => runtime.revertToTurn(input), { key: f.key, turnSeq })
    assert.ok(reverted.ok)
    await runtime.sendTurn({ sessionId: started.session.sessionId, message: 'continue' })
    assert.match(lastMessage, /Files were reverted/)
  } finally {
    await runtime.shutdown()
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('revert restores work tree files only and leaves the index exactly as the user had it', async () => {
  const f = await repository()
  try {
    const checkpoints = new ConversationCheckpoints()
    await writeFile(join(f.root, 'existing.txt'), 'staged by user\n')
    await git(f.root, ['add', 'existing.txt'])
    await writeFile(join(f.root, 'existing.txt'), 'unstaged by user\n')
    await writeFile(join(f.root, 'notes.txt'), 'untracked by user\n')
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'agent edit\n')
    await writeFile(join(f.root, 'notes.txt'), 'agent edit\n')
    await rm(join(f.root, 'deleted.txt'))
    await writeFile(join(f.root, 'created.txt'), 'agent file\n')
    await git(f.root, ['add', 'created.txt'])
    const index = await readFile(join(f.root, '.git', 'index'))
    const staged = await git(f.root, ['ls-files', '--stage'])
    const preview = await checkpoints.revert({ key: f.key, turnSeq: 1 })
    assert.ok(preview.ok)
    const reverted = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 1 })
    assert.ok(reverted.ok && reverted.reverted, JSON.stringify(reverted))
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'unstaged by user\n')
    assert.equal(await readFile(join(f.root, 'notes.txt'), 'utf8'), 'untracked by user\n')
    assert.equal(await readFile(join(f.root, 'deleted.txt'), 'utf8'), 'keep\n')
    await assert.rejects(stat(join(f.root, 'created.txt')), { code: 'ENOENT' })
    assert.deepEqual(await readFile(join(f.root, '.git', 'index')), index)
    assert.equal(await git(f.root, ['ls-files', '--stage']), staged)
    assert.match(await git(f.root, ['status', '--porcelain=v1']), /^\?\? notes\.txt$/mu)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('undo keeps a recovery point of work done after the revert, and repeated reverts keep every recovery ref', async () => {
  const f = await repository()
  const refs = async () =>
    (await git(f.root, ['for-each-ref', '--format=%(refname:lstrip=4)', 'refs/sprintengine/checkpoints/']))
      .trim()
      .split('\n')
  try {
    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 2, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'agent one\n')
    const first = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 2 })
    assert.ok(first.ok && first.reverted)
    await writeFile(join(f.root, 'existing.txt'), 'agent two\n')
    const second = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 2 })
    assert.ok(second.ok && second.reverted)
    assert.notEqual(first.undoRef, second.undoRef)
    assert.deepEqual(await refs(), ['2-pre', '2-undo-1', '2-undo-2'])
    assert.equal(await git(f.root, ['show', `${first.undoRef}:existing.txt`]), 'agent one\n')
    // Work the user does after reverting must survive an undo.
    await writeFile(join(f.root, 'existing.txt'), 'user work after revert\n')
    const undo = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 2, undo: true })
    assert.ok(undo.ok && undo.reverted && undo.undoRef)
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'agent two\n')
    assert.equal(await git(f.root, ['show', `${undo.undoRef}:existing.txt`]), 'user work after revert\n')
    assert.deepEqual(await refs(), ['2-pre', '2-redo-1', '2-undo-1', '2-undo-2'])
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a confirmed revert acts only on the files the dialog showed', async () => {
  const f = await repository()
  try {
    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'agent edit\n')
    const preview = await checkpoints.revert({ key: f.key, turnSeq: 1 })
    assert.ok(preview.ok)
    assert.deepEqual(
      preview.files.map((file) => file.path),
      ['existing.txt'],
    )
    // Written after the dialog opened: never shown, so never removed.
    await writeFile(join(f.root, 'late.txt'), 'written while the dialog was open\n')
    const refused = await checkpoints.revert({ key: f.key, turnSeq: 1, confirmed: true, files: ['existing.txt'] })
    assert.ok(!refused.ok && refused.changed)
    assert.equal(await readFile(join(f.root, 'late.txt'), 'utf8'), 'written while the dialog was open\n')
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'agent edit\n')
    const unlisted = await checkpoints.revert({ key: f.key, turnSeq: 1, confirmed: true })
    assert.ok(!unlisted.ok && unlisted.changed)
    const confirmed = await checkpoints.revert({
      key: f.key,
      turnSeq: 1,
      confirmed: true,
      files: ['late.txt', 'existing.txt'],
    })
    assert.ok(confirmed.ok && confirmed.reverted)
    await assert.rejects(stat(join(f.root, 'late.txt')), { code: 'ENOENT' })
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('revert never replaces or removes a file its recovery checkpoint cannot bring back', async () => {
  const f = await repository()
  try {
    const checkpoints = new ConversationCheckpoints()
    await writeFile(join(f.root, 'ignored.txt'), 'ignored before the turn\n')
    await writeFile(join(f.root, 'notes.log'), 'untracked before the turn\n')
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    // The turn swaps which of the two files is ignored, then both change.
    await writeFile(join(f.root, '.gitignore'), '*.log\n.sprintengine/\n')
    await writeFile(join(f.root, 'notes.log'), 'edited after it became ignored\n')
    await writeFile(join(f.root, 'ignored.txt'), 'edited after it stopped being ignored\n')
    const reverted = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 1 })
    assert.ok(reverted.ok && reverted.reverted)
    assert.equal(await readFile(join(f.root, 'notes.log'), 'utf8'), 'untracked before the turn\n')
    // Ignored again under the restored rules, so it predates the turn: kept.
    assert.deepEqual(reverted.kept, ['ignored.txt'])
    assert.equal(await readFile(join(f.root, 'ignored.txt'), 'utf8'), 'edited after it stopped being ignored\n')
    const undo = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 1, undo: true })
    assert.ok(undo.ok && undo.reverted)
    assert.equal(await readFile(join(f.root, 'notes.log'), 'utf8'), 'edited after it became ignored\n')
    assert.equal(await readFile(join(f.root, 'ignored.txt'), 'utf8'), 'edited after it stopped being ignored\n')
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('expiry keeps every checkpoint of a conversation that is still active, however old its turns', async () => {
  const f = await repository()
  const day = 24 * 60 * 60 * 1000
  const refs = async () =>
    (await git(f.root, ['for-each-ref', '--format=%(refname:lstrip=4)', 'refs/sprintengine/checkpoints/'])).trim()
  try {
    const checkpoints = new ConversationCheckpoints()
    const other = { ...f.key, agentId: 'other' }
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    assert.ok((await checkpoints.capture(other, 1, 'pre')).ok)
    const later = Date.now() + 40 * day
    await checkpoints.collectExpired(f.root, later, [{ key: f.key, updatedAt: later - day }])
    assert.equal(await refs(), '1-pre')
    await checkpoints.collectExpired(f.root, later, [{ key: f.key, updatedAt: later - 31 * day }])
    assert.equal(await refs(), '')
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('capture leaves app sidecar folders out whether or not the repository ignores them', async () => {
  const f = await repository()
  try {
    await writeFile(join(f.root, '.gitignore'), '')
    await mkdir(join(f.root, '.sprintengine'))
    await writeFile(join(f.root, '.sprintengine', 'transcript.jsonl'), '{}\n')
    await writeFile(join(f.root, 'existing.txt'), 'changed\n')
    const checkpoints = new ConversationCheckpoints()
    const captured = await checkpoints.capture(f.key, 1, 'pre')
    assert.ok(captured.ok, JSON.stringify(captured))
    const files = await git(f.root, ['ls-tree', '-r', '--name-only', captured.ref])
    assert.deepEqual(files.trim().split('\n'), ['.gitignore', 'deleted.txt', 'existing.txt'])
    assert.equal(await git(f.root, ['show', `${captured.ref}:existing.txt`]), 'changed\n')
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('an agent edit to a file the user marked assume-unchanged or skip-worktree is captured and reverted', async () => {
  const f = await repository()
  try {
    const checkpoints = new ConversationCheckpoints()
    await writeFile(join(f.root, 'existing.txt'), 'local setting\n')
    await git(f.root, ['update-index', '--assume-unchanged', 'existing.txt'])
    await writeFile(join(f.root, 'deleted.txt'), 'local override\n')
    await git(f.root, ['update-index', '--skip-worktree', 'deleted.txt'])
    const flags = await git(f.root, ['ls-files', '-v'])
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'agent edit\n')
    await writeFile(join(f.root, 'deleted.txt'), 'agent edit\n')
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    const diff = await checkpoints.getTurnDiff({ key: f.key, turnSeq: 1 })
    assert.ok(diff.ok)
    assert.deepEqual(diff.diff.files.map((file) => file.path).sort(), ['deleted.txt', 'existing.txt'])
    const reverted = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 1 })
    assert.ok(reverted.ok && reverted.reverted, JSON.stringify(reverted))
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'local setting\n')
    assert.equal(await readFile(join(f.root, 'deleted.txt'), 'utf8'), 'local override\n')
    assert.equal(await git(f.root, ['ls-files', '-v']), flags, "the user's own index keeps its flags")
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test("an index another git wrote is not trusted for a file whose inode it does not know, whatever the repository's checkStat", async () => {
  // Linux git on a Windows drive (`/mnt/c/…`) reads an index Git for Windows
  // wrote: every entry's inode and owner differ from what the mount reports,
  // and only size and mtime agree. Git for Windows usually converts CRLF on
  // add (core.autocrlf), so the blob it recorded is not the bytes on disk.
  // Were that entry trusted, the turn's "before" would hold LF for a CRLF
  // file: the diff would show every line changed, and revert would write LF.
  const f = await repository()
  try {
    const crlf = 'one\r\ntwo\r\n'
    await git(f.root, ['config', 'core.autocrlf', 'false'])
    await writeFile(join(f.root, 'windows.txt'), crlf)
    const past = new Date('2020-01-02T03:04:05Z')
    await utimes(join(f.root, 'windows.txt'), past, past)
    await git(f.root, ['-c', 'core.autocrlf=true', 'add', 'windows.txt'])
    await git(f.root, ['-c', 'core.autocrlf=true', 'commit', '-m', 'From Windows'])
    // The same bytes and mtime under a new inode, as the drive mount shows them.
    await copyFile(join(f.root, 'windows.txt'), join(f.root, 'windows.tmp'))
    await rename(join(f.root, 'windows.tmp'), join(f.root, 'windows.txt'))
    await utimes(join(f.root, 'windows.txt'), past, past)
    // What Studio's own git on the drive mount runs with, plus no ctime, which
    // a rename changes and the mount does not.
    await git(f.root, ['config', 'core.checkStat', 'minimal'])
    await git(f.root, ['config', 'core.trustCtime', 'false'])

    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'windows.txt'), 'one\r\nTWO\r\n')
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    const diff = await checkpoints.getTurnDiff({ key: f.key, turnSeq: 1 })
    assert.ok(diff.ok)
    assert.deepEqual(
      diff.diff.files.map(({ path, addedLines, removedLines }) => ({ path, addedLines, removedLines })),
      [{ path: 'windows.txt', addedLines: 1, removedLines: 1 }],
      'the turn changed one line',
    )
    const reverted = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 1 })
    assert.ok(reverted.ok && reverted.reverted, JSON.stringify(reverted))
    assert.equal(await readFile(join(f.root, 'windows.txt'), 'utf8'), crlf, 'revert brings back the bytes it replaced')
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a file whose name starts with two dots is in the work tree, and the turn keeps its checkpoint', async () => {
  const f = await repository()
  try {
    await writeFile(join(f.root, '..env'), 'TOKEN=example\n')
    const checkpoints = new ConversationCheckpoints()
    const captured = await checkpoints.capture(f.key, 1, 'pre')
    assert.ok(captured.ok, captured.ok ? '' : captured.message)
    await writeFile(join(f.root, '..env'), 'TOKEN=changed\n')
    const reverted = await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 1 })
    assert.ok(reverted.ok, reverted.ok ? '' : reverted.message)
    assert.equal(await readFile(join(f.root, '..env'), 'utf8'), 'TOKEN=example\n')
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

// ── A turn that moves HEAD ────────────────────────────────────────────────────

/** A commit dated an hour ago, the way a colleague's pushed commit arrives. */
const EARLIER = { GIT_AUTHOR_DATE: '@1700000000 +0000', GIT_COMMITTER_DATE: '@1700000000 +0000' }

async function gitWith(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runGitCommand(cwd, args, env)
  assert.ok(result.ok, result.message ?? result.stderr)
  return result.stdout
}

/** The repository plus a clone it pulls from, which already holds commits it has not seen. */
async function repositoryWithUpstream(upstreamFiles: Record<string, string>) {
  const f = await repository()
  const upstream = join(f.directory, 'upstream')
  await git(f.directory, ['clone', '--quiet', f.root, upstream])
  await git(upstream, ['config', 'user.name', 'Colleague'])
  await git(upstream, ['config', 'user.email', 'dev@example.com'])
  for (const [path, content] of Object.entries(upstreamFiles)) await writeFile(join(upstream, path), content)
  await git(upstream, ['add', '.'])
  await gitWith(upstream, ['commit', '-m', 'Upstream work'], EARLIER)
  const branch = (await git(f.root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  await git(f.root, ['remote', 'add', 'origin', upstream])
  await git(f.root, ['config', 'pull.rebase', 'false'])
  return { ...f, upstream, branch }
}

async function turnFiles(checkpoints: ConversationCheckpoints, key: { workspaceRoot: string }, turnSeq: number) {
  const diff = await checkpoints.getTurnDiff({ key: key as never, turnSeq })
  assert.ok(diff.ok, diff.ok ? '' : diff.message)
  return diff.diff.files.map((file) => file.path)
}

test('a pull during a turn leaves the pulled files out of the turn, while revert still sees the whole tree', async () => {
  const f = await repositoryWithUpstream({ 'pulled.txt': 'from upstream\n', 'deleted.txt': 'upstream edit\n' })
  try {
    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'agent edit\n')
    await git(f.root, ['pull', '--quiet', '--no-edit', 'origin', f.branch])
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    assert.deepEqual(await turnFiles(checkpoints, f.key, 1), ['existing.txt'])
    const pulled = await checkpoints.getTurnDiff({ key: f.key, turnSeq: 1, path: 'pulled.txt' })
    assert.equal(pulled.ok, false, 'a pulled file is not part of the turn')
    const preview = await checkpoints.revert({ key: f.key, turnSeq: 1 })
    assert.ok(preview.ok)
    assert.deepEqual(preview.files.map((file) => file.path).sort(), ['deleted.txt', 'existing.txt', 'pulled.txt'])
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a rebase during a turn counts the conflict it resolved and not the commits it rebased onto', async () => {
  const f = await repositoryWithUpstream({ 'existing.txt': 'upstream line\n', 'pulled.txt': 'from upstream\n' })
  try {
    await writeFile(join(f.root, 'existing.txt'), 'local line\n')
    await gitWith(f.root, ['commit', '-am', 'Local work'], EARLIER)
    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await git(f.root, ['fetch', '--quiet', 'origin'])
    const conflicted = await runGitCommand(f.root, ['rebase', `origin/${f.branch}`])
    assert.equal(conflicted.ok, false, 'the rebase stops on the conflict')
    await writeFile(join(f.root, 'existing.txt'), 'local line\nupstream line\n')
    await git(f.root, ['add', 'existing.txt'])
    await gitWith(f.root, ['rebase', '--continue'], { GIT_EDITOR: 'true' })
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    assert.deepEqual(await turnFiles(checkpoints, f.key, 1), ['existing.txt'])
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a commit the agent makes during a turn stays in the turn beside a merge it pulled', async () => {
  const f = await repositoryWithUpstream({ 'pulled.txt': 'from upstream\n' })
  try {
    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'created.txt'), 'agent file\n')
    await git(f.root, ['add', 'created.txt'])
    await git(f.root, ['commit', '-m', 'Agent work'])
    await git(f.root, ['pull', '--quiet', '--no-edit', 'origin', f.branch])
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    assert.deepEqual(await turnFiles(checkpoints, f.key, 1), ['created.txt'])
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a turn that leaves HEAD where it was keeps every changed file, on a parentless checkpoint naming HEAD', async () => {
  const f = await repository()
  try {
    const checkpoints = new ConversationCheckpoints()
    const head = (await git(f.root, ['rev-parse', 'HEAD'])).trim()
    const pre = await checkpoints.capture(f.key, 1, 'pre')
    assert.ok(pre.ok)
    await writeFile(join(f.root, 'existing.txt'), 'agent edit\n')
    await writeFile(join(f.root, 'created.txt'), 'created\n')
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    assert.deepEqual(await turnFiles(checkpoints, f.key, 1), ['created.txt', 'existing.txt'])
    assert.equal((await git(f.root, ['rev-list', '--parents', '-n', '1', pre.ref])).trim().split(' ').length, 1)
    assert.match(await git(f.root, ['log', '-1', '--format=%B', pre.ref]), new RegExp(`^Head: ${head}$`, 'mu'))
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a checkpoint written before HEAD was recorded keeps the full diff of a turn that pulled', async () => {
  const f = await repositoryWithUpstream({ 'pulled.txt': 'from upstream\n' })
  try {
    const checkpoints = new ConversationCheckpoints()
    const pre = await checkpoints.capture(f.key, 1, 'pre')
    assert.ok(pre.ok)
    // What earlier builds wrote: the same tree, no HEAD line.
    const tree = (await git(f.root, ['rev-parse', `${pre.ref}^{tree}`])).trim()
    const legacy = (await git(f.root, ['commit-tree', tree, '-m', 'Conversation checkpoint 1 pre'])).trim()
    await git(f.root, ['update-ref', pre.ref, legacy])
    await writeFile(join(f.root, 'existing.txt'), 'agent edit\n')
    await git(f.root, ['pull', '--quiet', '--no-edit', 'origin', f.branch])
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    assert.deepEqual(await turnFiles(checkpoints, f.key, 1), ['existing.txt', 'pulled.txt'])
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a turn whose own files would overflow one command line is diffed in batches, every file kept', async () => {
  const f = await repositoryWithUpstream({ 'pulled.txt': 'from upstream\n' })
  try {
    const checkpoints = new ConversationCheckpoints()
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    const names = Array.from(
      { length: 400 },
      (_, i) => `${'generated-module-'.repeat(5)}${String(i).padStart(3, '0')}.ts`,
    )
    await Promise.all(names.map((name) => writeFile(join(f.root, name), `export const n = ${name.length}\n`)))
    await git(f.root, ['pull', '--quiet', '--no-edit', 'origin', f.branch])
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    assert.deepEqual(await turnFiles(checkpoints, f.key, 1), names)
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('a repository with no commit inside the work tree is left out, and the turn keeps its checkpoint', async () => {
  const f = await repository()
  try {
    // What an agent's `git init` leaves: one at the top, one inside a folder git has not seen.
    for (const nested of ['scratch', join('tools', 'generated')]) {
      await mkdir(join(f.root, nested), { recursive: true })
      await git(join(f.root, nested), ['init'])
      await writeFile(join(f.root, nested, 'notes.txt'), 'nested\n')
    }
    await writeFile(join(f.root, 'tools', 'build.sh'), 'echo build\n')
    const checkpoints = new ConversationCheckpoints()
    const pre = await checkpoints.capture(f.key, 1, 'pre')
    assert.ok(pre.ok, JSON.stringify(pre))
    await writeFile(join(f.root, 'existing.txt'), 'agent edit\n')
    const post = await checkpoints.capture(f.key, 1, 'post')
    assert.ok(post.ok, JSON.stringify(post))
    const files = await git(f.root, ['ls-tree', '-r', '--name-only', post.ref])
    assert.deepEqual(files.trim().split('\n'), ['.gitignore', 'deleted.txt', 'existing.txt', 'tools/build.sh'])
    assert.deepEqual(await turnFiles(checkpoints, f.key, 1), ['existing.txt'])
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

// An unreadable file fails the add for a reason of its own; root, and Windows, read it anyway.
test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'a snapshot that fails for another reason still fails, with git’s own error',
  async () => {
    const f = await repository()
    const secret = join(f.root, 'locked', 'secret.txt')
    try {
      await mkdir(join(f.root, 'locked'))
      await writeFile(secret, 'x\n')
      await chmod(secret, 0o000)
      const captured = await new ConversationCheckpoints().capture(f.key, 1, 'pre')
      assert.equal(captured.ok, false)
      assert.match(captured.ok ? '' : captured.message, /secret\.txt/)
    } finally {
      await chmod(secret, 0o644).catch(() => {})
      await rm(f.directory, { recursive: true, force: true })
    }
  },
)

test('a folder that becomes a repository after its chat started keeps checkpoints from the next turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-checkpoints-later-'))
  const root = join(directory, 'project')
  await mkdir(root)
  await writeFile(join(root, 'notes.txt'), 'original\n')
  const key = { workspaceRoot: root, workspaceId: 'workspace', agentId: 'agent' }
  const adapter = {
    ...createMockConversationProvider(),
    async *sendTurn(
      input: import('./providers/conversation-provider-adapter').MockAdapterTurnInput,
    ): AsyncIterable<ConversationEvent> {
      const envelope = {
        id: '',
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        createdAt: 0,
      }
      yield {
        ...envelope,
        type: 'tool_started',
        payload: { turnId: input.turnId, tool: 'Write', toolCallId: input.turnId, input: { path: 'notes.txt' } },
      }
      await writeFile(join(root, 'notes.txt'), `${input.message}\n`)
      yield { ...envelope, type: 'turn_completed', payload: { turnId: input.turnId } }
    },
  }
  const runtime = new ConversationRuntime({ adapters: [adapter], getProviderById: () => undefined })
  try {
    const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(started.ok)
    assert.equal(started.session.capabilities?.checkpoints, false)
    const sessionId = started.session.sessionId
    assert.ok((await runtime.sendTurn({ sessionId, message: 'before git' })).ok)

    await git(root, ['init'])
    await git(root, ['config', 'user.name', 'Developer'])
    await git(root, ['config', 'user.email', 'dev@example.com'])
    await git(root, ['add', '.'])
    await git(root, ['commit', '-m', 'Initial files'])
    const turned = await runtime.sendTurn({ sessionId, message: 'after git' })
    assert.ok(turned.ok)
    assert.equal(turned.session.capabilities?.checkpoints, true)
    assert.ok((await runtime.sendTurn({ sessionId, message: 'once more' })).ok)

    const replay = await runtime.readTranscript(key)
    assert.ok(replay.ok)
    const enabled = replay.events.filter(
      (event) =>
        event.type === 'session_updated' &&
        (event.payload?.capabilities as { checkpoints?: boolean } | undefined)?.checkpoints === true,
    )
    assert.equal(enabled.length, 1, 'said once, as the first turn in the repository starts')
    const completed = replay.events.filter((event) => event.type === 'turn_completed')
    assert.deepEqual(
      completed.map((event) => event.payload?.checkpointAvailable),
      [undefined, true, true],
      'the turn before git init has no checkpoint; the ones after have',
    )
  } finally {
    await runtime.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

test('capture and revert leave a split index the repository still uses in place', async () => {
  const f = await repository()
  try {
    // A repository on a split index whose shared files expire at once: any
    // split write in it deletes every shared index file older than now.
    await git(f.root, ['config', 'core.splitIndex', 'true'])
    await git(f.root, ['config', 'splitIndex.sharedIndexExpire', 'now'])
    await git(f.root, ['update-index', '--split-index'])
    const gitDir = join(f.root, '.git')
    const past = new Date(Date.now() - 60_000)
    for (const name of await readdir(gitDir))
      if (name.startsWith('sharedindex.')) await utimes(join(gitDir, name), past, past)
    const checkpoints = new ConversationCheckpoints()
    await writeFile(join(f.root, 'untracked.txt'), 'new\n')
    assert.ok((await checkpoints.capture(f.key, 1, 'pre')).ok)
    await writeFile(join(f.root, 'existing.txt'), 'after\n')
    assert.ok((await checkpoints.capture(f.key, 1, 'post')).ok)
    assert.ok((await previewThenRevert((input) => checkpoints.revert(input), { key: f.key, turnSeq: 1 })).ok)
    assert.equal(await readFile(join(f.root, 'existing.txt'), 'utf8'), 'original\n')
    // The repository's own index still reads.
    assert.match(await git(f.root, ['ls-files', '--cached']), /existing\.txt/)
    await git(f.root, ['status', '--porcelain'])
  } finally {
    await rm(f.directory, { recursive: true, force: true })
  }
})

test('checkpoint git commands turn on long paths on Windows only', () => {
  assert.deepEqual(longPathsConfig('win32'), ['-c', 'core.longpaths=true'])
  assert.deepEqual(longPathsConfig('darwin'), [])
  assert.deepEqual(longPathsConfig('linux'), [])
})
