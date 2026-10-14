import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, test } from 'vitest'

import { createWorktreeBranchLedger } from './worktree-branch-ledger'

const execFileAsync = promisify(execFile)
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', env })
  return stdout.trim()
}

let scratch = ''
let repo = ''
let other = ''
let caseNumber = 0

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-branch-ledger-')))
  for (const name of ['app', 'other']) {
    const dir = join(scratch, name)
    await mkdir(dir, { recursive: true })
    await git(dir, 'init', '-q', '-b', 'main')
    await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  repo = join(scratch, 'app')
  other = join(scratch, 'other')
})

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

/** A profile data directory of its own per case. */
async function dataDir(): Promise<string> {
  caseNumber += 1
  const dir = join(scratch, `profile-${caseNumber}`)
  await mkdir(dir, { recursive: true })
  return dir
}

const ledgerIn = (dir: string | null) => createWorktreeBranchLedger({ dataDir: () => dir, log: () => {} })

test('a branch recorded is read back for its repository, and for no other', async () => {
  const ledger = ledgerIn(await dataDir())
  await ledger.record(repo, 'feat/chat-1')
  await ledger.record(repo, 'chat-ab12')
  assert.deepEqual([...(await ledger.branches(repo))].sort(), ['chat-ab12', 'feat/chat-1'])
  assert.deepEqual([...(await ledger.branches(other))], [])
})

test('the record survives a restart', async () => {
  const dir = await dataDir()
  await ledgerIn(dir).record(repo, 'feat/chat-1')
  assert.deepEqual([...(await ledgerIn(dir).branches(repo))], ['feat/chat-1'])
})

test('every worktree of a repository, and any folder in it, names the same record', async () => {
  const ledger = ledgerIn(await dataDir())
  const worktree = join(scratch, `wt-${caseNumber}`)
  await git(repo, 'worktree', 'add', '-q', '-b', `wt-${caseNumber}`, worktree)
  await mkdir(join(repo, 'src'), { recursive: true })
  await ledger.record(worktree, 'feat/from-worktree')
  assert.ok((await ledger.branches(repo)).has('feat/from-worktree'))
  assert.ok((await ledger.branches(join(repo, 'src'))).has('feat/from-worktree'))
})

test('a missing record reads as empty', async () => {
  assert.equal((await ledgerIn(await dataDir()).branches(repo)).size, 0)
})

test('a corrupt or foreign record reads as empty, and the next write replaces it', async () => {
  const dir = await dataDir()
  const file = join(dir, 'worktree-branches.json')
  for (const content of [
    '{ not json',
    '[]',
    '{"version":99,"repos":{}}',
    '{"version":1,"repos":{"x":{"branches":"no"}}}',
  ]) {
    await writeFile(file, content)
    assert.equal((await ledgerIn(dir).branches(repo)).size, 0, content)
  }
  await ledgerIn(dir).record(repo, 'feat/chat-1')
  assert.deepEqual([...(await ledgerIn(dir).branches(repo))], ['feat/chat-1'])
})

test('a forgotten branch is struck off, and a repository with none left is dropped', async () => {
  const dir = await dataDir()
  const ledger = ledgerIn(dir)
  await ledger.record(repo, 'feat/a')
  await ledger.record(repo, 'feat/b')
  await ledger.forget(repo, ['feat/a'])
  assert.deepEqual([...(await ledger.branches(repo))], ['feat/b'])
  await ledger.forget(repo, ['feat/b'])
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'worktree-branches.json'), 'utf8')), { version: 1, repos: {} })
})

test('changes made together all land, in order', async () => {
  const ledger = ledgerIn(await dataDir())
  await Promise.all(['a', 'b', 'c', 'd'].map((name) => ledger.record(repo, `feat/${name}`)))
  await ledger.forget(repo, ['feat/b'])
  assert.deepEqual([...(await ledger.branches(repo))], ['feat/a', 'feat/c', 'feat/d'])
})

test('a write from another process in between is kept', async () => {
  const dir = await dataDir()
  await ledgerIn(dir).record(repo, 'feat/a')
  // Another process's ledger over the same file.
  await ledgerIn(dir).record(repo, 'feat/b')
  assert.deepEqual([...(await ledgerIn(dir).branches(repo))], ['feat/a', 'feat/b'])
})

test('with no data directory, nothing is kept and nothing is known', async () => {
  const ledger = ledgerIn(null)
  await ledger.record(repo, 'feat/a')
  assert.equal((await ledger.branches(repo)).size, 0)
})

test('a folder that is not a repository records nothing', async () => {
  const dir = await dataDir()
  const plain = join(scratch, 'plain')
  await mkdir(plain, { recursive: true })
  await ledgerIn(dir).record(plain, 'feat/a')
  assert.equal((await ledgerIn(dir).branches(plain)).size, 0)
})
