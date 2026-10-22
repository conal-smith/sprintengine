import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { gitRepoTrustNeedsAnswer } from '../shared/ipc/git-repo-trust'
import {
  createRepoProgramsReader,
  parseConfigListing,
  repoProgramSettings,
  repoProgramsHash,
} from './git-repo-programs'
import { createGitRepoTrust } from './git-repo-trust'
import { createGitRepoTrustStore } from './git-repo-trust-store'

let dir = ''
let repo = ''
let userData = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'se-repo-trust-')))
  repo = join(dir, 'app')
  userData = join(dir, 'user-data')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function service() {
  const store = createGitRepoTrustStore({ resolveUserDataDir: () => userData })
  // A reader that asks git every time, so a config edit is seen at once.
  const reader = { read: (cwd: string) => createRepoProgramsReader().read(cwd), forget: () => undefined }
  return { store, trust: createGitRepoTrust({ store, reader }) }
}

test('a listing is read entry by entry, scope, key and value, a value-less key included', () => {
  const stdout = 'local\0filter.lfs.clean\ngit-lfs clean -- %f\0global\0core.pager\nless -R\0local\0core.hookspath\0'
  assert.deepEqual(parseConfigListing(stdout), [
    { scope: 'local', key: 'filter.lfs.clean', value: 'git-lfs clean -- %f' },
    { scope: 'global', key: 'core.pager', value: 'less -R' },
    { scope: 'local', key: 'core.hookspath', value: '' },
  ])
})

test("only the repository's own settings count, and a credential helper only when it is a shell command", () => {
  const entries = [
    { scope: 'local', key: 'filter.x.smudge', value: 'run' },
    { scope: 'worktree', key: 'merge.ours.driver', value: 'true' },
    { scope: 'global', key: 'diff.img.textconv', value: 'exiftool' },
    { scope: 'local', key: 'credential.helper', value: 'osxkeychain' },
    { scope: 'local', key: 'credential.https://example.com.helper', value: '!f() { echo; }; f' },
    { scope: 'command', key: 'core.sshcommand', value: 'ssh -v' },
  ]
  assert.deepEqual(
    repoProgramSettings(entries).map((entry) => entry.key),
    ['filter.x.smudge', 'merge.ours.driver', 'credential.https://example.com.helper'],
  )
  assert.equal(
    repoProgramsHash(repoProgramSettings(entries)),
    repoProgramsHash([...repoProgramSettings(entries)].reverse()),
    'the order git lists them in does not change the hash',
  )
})

test('every kind of program setting is found in a real repository, an included file and config.worktree too', async () => {
  git(repo, 'config', 'filter.x.clean', 'cat')
  git(repo, 'config', 'filter.x.smudge', 'cat')
  git(repo, 'config', 'filter.y.process', 'run-it')
  git(repo, 'config', 'diff.img.textconv', 'conv')
  git(repo, 'config', 'diff.img.command', 'ext')
  for (const key of ['hooksPath', 'sshCommand', 'gitProxy', 'askPass', 'pager', 'editor']) {
    git(repo, 'config', `core.${key}`, 'prog')
  }
  git(repo, 'config', 'credential.helper', '!echo hi')
  git(repo, 'config', 'include.path', 'extra.config')
  writeFileSync(join(repo, '.git', 'extra.config'), '[merge "m"]\n\tdriver = evil %O %A %B\n')
  // Settings that name no program are not asked about.
  git(repo, 'config', 'core.autocrlf', 'false')
  git(repo, 'config', 'filter.x.required', 'true')

  const read = await createRepoProgramsReader().read(repo)
  assert.equal(read?.repoPath, repo)
  assert.deepEqual(read?.settings.map((entry) => entry.key).sort(), [
    'core.askpass',
    'core.editor',
    'core.gitproxy',
    'core.hookspath',
    'core.pager',
    'core.sshcommand',
    'credential.helper',
    'diff.img.command',
    'diff.img.textconv',
    'filter.x.clean',
    'filter.x.smudge',
    'filter.y.process',
    'merge.m.driver',
  ])
})

test('a repository whose config names no program has nothing to answer, and no banner', async () => {
  const { trust } = service()
  const view = await trust.view(repo)
  assert.deepEqual(view?.settings, [])
  assert.equal(gitRepoTrustNeedsAnswer(view), false)
  assert.equal((await trust.answerFor(repo))?.trusted, true)
})

test('a repository that names a program asks once, is trusted when the person says so, and asks again when it changes', async () => {
  git(repo, 'config', 'core.hooksPath', '.husky')
  const { trust } = service()

  const first = await trust.view(repo)
  assert.equal(gitRepoTrustNeedsAnswer(first), true)
  assert.deepEqual(first?.settings, ['core.hookspath'])
  assert.equal((await trust.answerFor(repo))?.trusted, false, 'not trusted until the person says so')

  const answered = await trust.answer(repo, first!.hash, 'trusted')
  assert.equal(answered?.decision, 'trusted')
  assert.equal(gitRepoTrustNeedsAnswer(answered), false)
  assert.equal((await trust.answerFor(repo))?.trusted, true)
  // Kept on disk, under the repository's path.
  const saved = JSON.parse(readFileSync(join(userData, 'git-repo-trust.json'), 'utf8'))
  assert.equal(saved.repositories[repo].decision, 'trusted')
  // A store read from that file again knows it.
  const reopened = createGitRepoTrust({
    store: createGitRepoTrustStore({ resolveUserDataDir: () => userData }),
    reader: createRepoProgramsReader(),
  })
  assert.equal((await reopened.answerFor(repo))?.trusted, true)

  // The value changes: asked again, and not trusted meanwhile.
  git(repo, 'config', 'core.hooksPath', 'elsewhere')
  const changed = await trust.view(repo)
  assert.equal(gitRepoTrustNeedsAnswer(changed), true)
  assert.notEqual(changed?.hash, first?.hash)
  assert.equal((await trust.answerFor(repo))?.trusted, false)

  // An answer for settings that are not the current ones records nothing.
  const stale = await trust.answer(repo, first!.hash, 'trusted')
  assert.equal(stale?.decision, null)
})

test('Not now puts the banner away for these settings, and trusts nothing', async () => {
  git(repo, 'config', 'merge.m.driver', 'evil')
  const { trust } = service()
  const view = await trust.view(repo)
  const dismissed = await trust.answer(repo, view!.hash, 'dismissed')
  assert.equal(gitRepoTrustNeedsAnswer(dismissed), false)
  assert.equal((await trust.answerFor(repo))?.trusted, false)
})

test('a linked worktree shares its repository’s answer', async () => {
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'dev')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  git(repo, 'config', 'filter.x.smudge', 'cat')
  const worktree = join(dir, 'wt')
  git(repo, 'worktree', 'add', '-q', worktree)
  const { trust } = service()
  const view = await trust.view(worktree)
  assert.equal(view?.repoPath, repo)
  await trust.answer(worktree, view!.hash, 'trusted')
  assert.equal((await trust.answerFor(repo))?.trusted, true)
})

test('a folder that is not a repository has no view', async () => {
  const { trust } = service()
  assert.equal(await trust.view(dir), null)
  assert.equal(await trust.answerFor(dir), null)
})

test('the reader keeps its answer while the config files are unchanged, and reads again when one is written', async () => {
  let reads = 0
  let clock = 0
  const reader = createRepoProgramsReader({
    now: () => clock,
    run: async (cwd, args, env, options) => {
      if (args[0] === 'config') reads += 1
      const { runGitCommand } = await import('./git-run')
      return runGitCommand(cwd, args, env, options)
    },
  })
  await reader.read(repo)
  clock += 10_000
  await reader.read(repo)
  assert.equal(reads, 1, 'nothing changed: not read again')
  git(repo, 'config', 'filter.x.clean', 'cat')
  clock += 10_000
  const read = await reader.read(repo)
  assert.equal(reads, 2)
  assert.deepEqual(
    read?.settings.map((entry) => entry.key),
    ['filter.x.clean'],
  )
})

test('an answer given in one process is seen by the other, which reads the file again when it changed', async () => {
  let clock = 0
  const main = createGitRepoTrustStore({ resolveUserDataDir: () => userData, now: () => clock })
  const server = createGitRepoTrustStore({ resolveUserDataDir: () => userData, now: () => clock })
  assert.equal(server.decisionFor(repo, 'abc'), null)
  await main.record(repo, 'abc', 'trusted')
  clock += 5_000
  assert.equal(server.decisionFor(repo, 'abc'), 'trusted')
  assert.equal(server.decisionFor(repo, 'other'), null, 'an answer is for the settings it was given for')
})
