import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, test } from 'vitest'

import { createMainCheckoutCatchUp, type CatchUpChat } from './main-checkout-catch-up'

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
let origin = ''
let checkout = ''
let pusher = ''

/** Commit `file` on origin's main from another clone, as a merged pull request would land. */
async function landOnOrigin(file: string, content: string): Promise<string> {
  await git(pusher, 'pull', '-q', '--ff-only', 'origin', 'main')
  await writeFile(join(pusher, file), content)
  await git(pusher, 'add', file)
  await git(pusher, 'commit', '-q', '-m', `land ${file}`)
  await git(pusher, 'push', '-q', 'origin', 'HEAD:main')
  return git(pusher, 'rev-parse', 'HEAD')
}

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'checkout-catch-up-')))
  origin = join(scratch, 'origin.git')
  checkout = join(scratch, 'project')
  pusher = join(scratch, 'pusher')
  await git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
  await git(scratch, 'clone', '-q', origin, pusher)
  await git(pusher, 'switch', '-q', '-c', 'main')
  await writeFile(join(pusher, 'README.md'), '# project\n')
  await git(pusher, 'add', '.')
  await git(pusher, 'commit', '-q', '-m', 'first')
  await git(pusher, 'push', '-q', 'origin', 'main')
  await git(scratch, 'clone', '-q', origin, checkout)
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

function makeCatchUp(options: { chat?: CatchUpChat | null; live?: string[] } = {}) {
  const lines: string[] = []
  const catchUp = createMainCheckoutCatchUp({
    chat: () => (options.chat === undefined ? { folderPath: checkout, worktree: null } : options.chat),
    liveSessionPaths: () => options.live ?? [],
    log: (line) => lines.push(line),
  })
  return { catchUp: () => catchUp({ workspaceId: 'ws-1', workspaceRoot: checkout }), lines }
}

test('a new chat in a clean checkout on the default branch starts on what origin has now', async () => {
  const old = await git(checkout, 'rev-parse', 'HEAD')
  await landOnOrigin('a.txt', 'a\n')
  const landed = await landOnOrigin('b.txt', 'b\n')
  // Untracked files of the person's own stay where they are.
  await writeFile(join(checkout, 'scratch.txt'), 'mine\n')
  const { catchUp, lines } = makeCatchUp()

  const outcome = await catchUp()
  assert.deepEqual(outcome, { kind: 'moved', from: old, to: landed, commits: 2, ref: 'origin/main' })
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), landed, 'fetched and fast-forwarded')
  assert.equal(await git(checkout, 'branch', '--show-current'), 'main')
  assert.equal(await readFile(join(checkout, 'scratch.txt'), 'utf8'), 'mine\n')
  assert.match(lines.join('\n'), /fast-forwarded to origin\/main .*2 commits/)

  assert.deepEqual(await catchUp(), { kind: 'current' })
})

test('a checkout holding anyone’s work, or not on the default branch, is left where it is', async () => {
  const old = await git(checkout, 'rev-parse', 'HEAD')
  await landOnOrigin('a.txt', 'a\n')

  await writeFile(join(checkout, 'README.md'), '# edited\n')
  let outcome = await makeCatchUp().catchUp()
  assert.deepEqual(outcome, { kind: 'skipped', why: 'it has uncommitted changes' })
  await git(checkout, 'checkout', '--', 'README.md')

  await git(checkout, 'switch', '-q', '-c', 'feature')
  outcome = await makeCatchUp().catchUp()
  assert.deepEqual(outcome, { kind: 'skipped', why: 'on feature, not main' })
  await git(checkout, 'switch', '-q', 'main')

  // Local commits origin does not have: a fast-forward or nothing.
  await writeFile(join(checkout, 'local.txt'), 'local\n')
  await git(checkout, 'add', 'local.txt')
  await git(checkout, 'commit', '-q', '-m', 'local')
  const local = await git(checkout, 'rev-parse', 'HEAD')
  outcome = await makeCatchUp().catchUp()
  assert.deepEqual(outcome, { kind: 'skipped', why: 'main has commits origin/main does not' })
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), local)
  assert.notEqual(local, old)
})

test('a checkout another chat is working in, a linked worktree, and a chat that is not a folder chat here are left alone', async () => {
  const old = await git(checkout, 'rev-parse', 'HEAD')
  await landOnOrigin('a.txt', 'a\n')

  let outcome = await makeCatchUp({ live: [join(checkout, 'src')] }).catchUp()
  assert.deepEqual(outcome, { kind: 'skipped', why: 'another chat has a turn running in it' })

  outcome = await makeCatchUp({ chat: { folderPath: checkout, worktree: { branch: 'agent/x' } } }).catchUp()
  assert.equal(outcome.kind, 'skipped')
  outcome = await makeCatchUp({
    chat: { folderPath: checkout, worktree: null, environment: { kind: 'ssh' } },
  }).catchUp()
  assert.equal(outcome.kind, 'skipped')
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), old, 'none of them moved it')

  const linked = join(scratch, 'linked')
  await git(checkout, 'worktree', 'add', '-q', '-b', 'main-copy', linked, 'HEAD')
  const catchUp = createMainCheckoutCatchUp({
    chat: () => ({ folderPath: linked, worktree: null }),
    liveSessionPaths: () => [],
    log: () => {},
  })
  outcome = await catchUp({ workspaceId: 'ws-2', workspaceRoot: linked })
  assert.deepEqual(outcome, { kind: 'skipped', why: 'a linked worktree' })
})

test('offline, the checkout catches up to what origin/main already says', async () => {
  await landOnOrigin('a.txt', 'a\n')
  await git(checkout, 'fetch', '-q', 'origin')
  const known = await git(checkout, 'rev-parse', 'origin/main')
  await git(checkout, 'remote', 'set-url', 'origin', join(scratch, 'gone.git'))
  const { catchUp, lines } = makeCatchUp()

  const outcome = await catchUp()
  assert.equal(outcome.kind, 'moved')
  assert.equal(await git(checkout, 'rev-parse', 'HEAD'), known)
  assert.match(lines.join('\n'), /fetching origin\/main failed/)
})
