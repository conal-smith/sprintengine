import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { setAgentWorktreeLockProfile } from '../agent-worktree-lock'
import { createRepoProgramsReader } from '../git-repo-programs'
import { createGitRepoTrust, type GitRepoTrust } from '../git-repo-trust'
import { createGitRepoTrustStore } from '../git-repo-trust-store'
import { installGitRepoTrust } from '../git-run'
import { installWorktreePool } from './active-pool'
import { createPoolStore } from './pool-store'
import { createWorktreePoolService } from './worktree-pool-service'

// The pool's checkouts in a repository whose own config names programs and
// that the person has not trusted: its hooks do not run, and where its config
// sets the LFS filter, Git LFS is called by name with its own commands.

const posix = process.platform !== 'win32'

let dir = ''
let repo = ''
let marks = ''
let trust: GitRepoTrust
const savedEnv = { ...process.env }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function ran(): string[] {
  return existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean) : []
}

function service() {
  return createWorktreePoolService({
    store: createPoolStore(join(dir, 'user-data')),
    livePaths: () => [],
    liveSessionPaths: () => [],
    log: () => {},
    timers: false,
    fetchFreshMs: 0,
    branchLedger: { record: async () => undefined },
  })
}

let pool: ReturnType<typeof service>

async function lease(name: string) {
  const result = await pool.lease({ repoRoot: repo, name, owner: `agent-${name}` })
  assert.equal(result.ok, true, result.ok ? '' : `${result.reason}: ${result.message}`)
  return result as Extract<typeof result, { ok: true }>
}

beforeEach(() => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  })
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'se-pool-untrusted-')))
  marks = join(dir, 'marks')
  const seed = join(dir, 'seed')
  execFileSync('git', ['init', '-q', '-b', 'main', seed])
  writeFileSync(join(seed, 'README.md'), '# app\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-q', '-m', 'init')
  const origin = join(dir, 'origin.git')
  execFileSync('git', ['clone', '-q', '--bare', seed, origin])
  repo = join(dir, 'app')
  execFileSync('git', ['clone', '-q', origin, repo])
  setAgentWorktreeLockProfile(join(dir, 'user-data'))
  installWorktreePool(null)
  pool = service()
  trust = createGitRepoTrust({
    store: createGitRepoTrustStore({ resolveUserDataDir: () => join(dir, 'user-data') }),
    reader: { read: (cwd) => createRepoProgramsReader().read(cwd), forget: () => undefined },
  })
  mkdirSync(join(dir, 'empty-hooks'))
  installGitRepoTrust((cwd) => trust.answerFor(cwd), { emptyHooksDir: join(dir, 'empty-hooks') })
})

afterEach(() => {
  installGitRepoTrust(null)
  setAgentWorktreeLockProfile(null)
  process.env = { ...savedEnv }
  rmSync(dir, { recursive: true, force: true })
})

test.runIf(posix)('a lease in an untrusted repository runs none of its hooks; trusted, it runs them', async () => {
  const hooks = join(dir, 'repo-hooks')
  mkdirSync(hooks)
  for (const hook of ['post-checkout', 'reference-transaction']) {
    writeFileSync(join(hooks, hook), `#!/bin/sh\necho ${hook} >> '${marks}'\n`)
    chmodSync(join(hooks, hook), 0o755)
  }
  git(repo, 'config', 'core.hooksPath', hooks)

  await lease('untrusted')
  assert.deepEqual(ran(), [], 'worktree add, the switch onto the branch: no hook ran')

  const view = await trust.view(repo)
  await trust.answer(repo, view!.hash, 'trusted')
  await lease('trusted')
  assert.ok(ran().includes('post-checkout'), ran().join(', '))
})

test.runIf(posix)(
  "where the repository's own config sets the LFS filter, Git LFS is called by name with its own commands",
  async () => {
    // A stand-in for git-lfs on PATH that notes how it was called.
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'git-lfs'), `#!/bin/sh\necho "git-lfs $1 $GIT_CONFIG_PARAMETERS" >> '${marks}'\n`)
    chmodSync(join(bin, 'git-lfs'), 0o755)
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
    const pusher = join(dir, 'pusher')
    execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), pusher])
    writeFileSync(join(pusher, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    git(pusher, 'add', '.')
    git(pusher, 'commit', '-q', '-m', 'lfs')
    git(pusher, 'push', '-q', 'origin', 'HEAD:main')
    git(repo, 'config', 'filter.lfs.smudge', `echo planted >> '${marks}'; cat`)
    git(repo, 'config', 'filter.lfs.process', 'planted-process')

    const leased = await lease('lfs')
    const lines = ran()
    assert.equal(lines.filter((line) => line.startsWith('planted')).length, 0, "the repository's own command never ran")
    const checkout = lines.find((line) => line.startsWith('git-lfs checkout '))
    assert.ok(checkout, lines.join('\n'))
    assert.match(checkout, /filter\.lfs\.smudge'?='?git-lfs smudge -- %f/u)
    assert.equal(
      leased.setupNote?.includes('Git LFS files were not fetched'),
      true,
      'pulling is still the project’s choice',
    )
  },
)
