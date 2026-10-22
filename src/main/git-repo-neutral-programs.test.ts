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
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { ConversationCheckpoints } from './conversation-checkpoints'
import { createRepoProgramsReader } from './git-repo-programs'
import { createGitRepoTrust, type GitRepoTrust } from './git-repo-trust'
import { createGitRepoTrustStore } from './git-repo-trust-store'
import {
  installGitRepoTrust,
  neutralRepoPrograms,
  runGitCommand,
  withNeutralRepoPrograms,
  type GitRepoTrustAnswer,
} from './git-run'
import { getGitStatus } from './git-status'

// The git the app starts by itself, in a repository whose own config names
// programs and that the person has not trusted, runs none of them. Real git,
// real repositories: each program is a script that leaves a mark when it runs.

const posix = process.platform !== 'win32'

let dir = ''
let repo = ''
let marks = ''
let hooks = ''
let trust: GitRepoTrust

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** A program that notes `name` when it runs, then passes its input through. */
function program(name: string): string {
  const path = join(dir, `${name}.sh`)
  writeFileSync(path, `#!/bin/sh\necho ${name} >> '${marks}'\ncat\n`)
  chmodSync(path, 0o755)
  return path
}

function ran(): string[] {
  return existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').filter(Boolean) : []
}

const neutral = { repoPrograms: 'neutral' as const }

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'se-neutral-programs-')))
  repo = join(dir, 'app')
  marks = join(dir, 'marks')
  hooks = join(dir, 'empty-hooks')
  mkdirSync(hooks)
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, 'config', 'user.email', 'dev@example.com')
  git(repo, 'config', 'user.name', 'dev')
  writeFileSync(join(repo, '.gitattributes'), '*.dat filter=x diff=x merge=m\n')
  writeFileSync(join(repo, 'a.dat'), 'one\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  trust = createGitRepoTrust({
    store: createGitRepoTrustStore({ resolveUserDataDir: () => join(dir, 'user-data') }),
    reader: { read: (cwd) => createRepoProgramsReader().read(cwd), forget: () => undefined },
  })
  installGitRepoTrust((cwd) => trust.answerFor(cwd), { emptyHooksDir: hooks })
})

afterEach(() => {
  installGitRepoTrust(null)
  rmSync(dir, { recursive: true, force: true })
})

async function trustRepo(): Promise<void> {
  const view = await trust.view(repo)
  await trust.answer(repo, view!.hash, 'trusted')
}

test.runIf(posix)(
  'a filter marked required runs neither its clean nor its smudge, and git does not fail for it',
  async () => {
    git(repo, 'config', 'filter.x.clean', program('clean'))
    git(repo, 'config', 'filter.x.smudge', program('smudge'))
    git(repo, 'config', 'filter.x.required', 'true')
    writeFileSync(join(repo, 'a.dat'), 'two\n')

    const status = await runGitCommand(repo, ['status', '--porcelain'], undefined, neutral)
    assert.equal(status.ok, true, status.message ?? '')
    assert.equal(status.stdout.trim(), 'M a.dat')
    const added = await runGitCommand(repo, ['add', 'a.dat'], undefined, neutral)
    assert.equal(added.ok, true, added.message ?? '')
    assert.equal((await runGitCommand(repo, ['commit', '-q', '-m', 'two'], undefined, neutral)).ok, true)
    rmSync(join(repo, 'a.dat'))
    const checkedOut = await runGitCommand(repo, ['checkout', '--', 'a.dat'], undefined, neutral)
    assert.equal(checkedOut.ok, true, checkedOut.message ?? '')
    assert.equal(readFileSync(join(repo, 'a.dat'), 'utf8'), 'two\n', 'the bytes as they are')
    assert.deepEqual(ran(), [])

    // The same git without the override runs them: the marks are real.
    rmSync(join(repo, 'a.dat'))
    await runGitCommand(repo, ['checkout', '--', 'a.dat'])
    assert.deepEqual(ran(), ['smudge'])
  },
)

test.runIf(posix)('a long-running filter process is not started, required or not', async () => {
  git(repo, 'config', 'filter.x.process', program('process'))
  git(repo, 'config', 'filter.x.required', 'true')
  writeFileSync(join(repo, 'a.dat'), 'two\n')
  const added = await runGitCommand(repo, ['add', 'a.dat'], undefined, neutral)
  assert.equal(added.ok, true, added.message ?? '')
  rmSync(join(repo, 'a.dat'))
  const checkedOut = await runGitCommand(repo, ['checkout', '--', 'a.dat'], undefined, neutral)
  assert.equal(checkedOut.ok, true, checkedOut.message ?? '')
  assert.deepEqual(ran(), [])
})

test.runIf(posix)(
  'a merge driver runs for neither merge-tree nor a remerge diff, and the file is a conflict',
  async () => {
    git(repo, 'switch', '-q', '-c', 'side')
    writeFileSync(join(repo, 'a.dat'), 'side\n')
    git(repo, 'commit', '-q', '-am', 'side')
    git(repo, 'switch', '-q', 'main')
    writeFileSync(join(repo, 'a.dat'), 'main\n')
    git(repo, 'commit', '-q', '-am', 'main')
    // A merge commit to remerge, made before the driver is configured.
    git(repo, 'merge', '-q', '-s', 'ours', '--no-edit', 'side')
    git(repo, 'config', 'merge.m.driver', `${program('merge')} %O %A %B`)

    const merged = await runGitCommand(repo, ['merge-tree', '--write-tree', 'main~1', 'side'], undefined, neutral)
    assert.equal(merged.ok, false, 'a conflict, not a merge the driver claimed')
    assert.match(merged.stdout, /CONFLICT \(content\): Merge conflict in a\.dat/u)
    const remerged = await runGitCommand(
      repo,
      ['log', '--format=', '--diff-merges=remerge', '--name-only', '-z', '-1', 'main'],
      undefined,
      neutral,
    )
    assert.equal(remerged.ok, true, remerged.message ?? '')
    assert.deepEqual(ran(), [])

    await runGitCommand(repo, ['merge-tree', '--write-tree', 'main~1', 'side'])
    assert.deepEqual(ran(), ['merge'], 'as configured, the driver runs')
  },
)

test.runIf(posix)('a diff converter and an external diff are refused, and the diff still reads', async () => {
  git(repo, 'config', 'diff.x.textconv', program('textconv'))
  writeFileSync(join(repo, 'a.dat'), 'two\n')
  const diff = await runGitCommand(repo, ['diff'], undefined, neutral)
  assert.equal(diff.ok, true, diff.message ?? '')
  assert.match(diff.stdout, /^\+two$/mu)
  git(repo, 'config', 'diff.x.command', program('external'))
  const again = await runGitCommand(repo, ['diff', '--', 'a.dat'], undefined, neutral)
  assert.equal(again.ok, true, again.message ?? '')
  const shown = await runGitCommand(repo, ['log', '-p', '-1'], undefined, neutral)
  assert.equal(shown.ok, true, shown.message ?? '')
  assert.deepEqual(ran(), [])
})

test.runIf(posix)(
  "the repository's hooks folder is swapped for the app's empty one on switch, checkout and worktree add",
  async () => {
    const own = join(dir, 'repo-hooks')
    mkdirSync(own)
    writeFileSync(join(own, 'post-checkout'), `#!/bin/sh\necho post-checkout >> '${marks}'\n`)
    chmodSync(join(own, 'post-checkout'), 0o755)
    git(repo, 'config', 'core.hooksPath', own)

    assert.equal((await runGitCommand(repo, ['switch', '-q', '-c', 'feature'], undefined, neutral)).ok, true)
    assert.equal((await runGitCommand(repo, ['checkout', '-q', 'main'], undefined, neutral)).ok, true)
    const added = await runGitCommand(repo, ['worktree', 'add', '-q', join(dir, 'wt'), 'feature'], undefined, neutral)
    assert.equal(added.ok, true, added.message ?? '')
    assert.deepEqual(ran(), [])

    // Trusted, the repository's hooks run again.
    await trustRepo()
    await runGitCommand(repo, ['switch', '-q', '-c', 'trusted'], undefined, neutral)
    assert.deepEqual(ran(), ['post-checkout'])
  },
)

test.runIf(posix)('an ssh command and a proxy command are not run for a fetch', async () => {
  git(repo, 'config', 'core.sshCommand', program('ssh'))
  git(repo, 'config', 'core.gitProxy', program('proxy'))
  git(repo, 'remote', 'add', 'over-ssh', 'ssh://git@127.0.0.1:1/x.git')
  git(repo, 'remote', 'add', 'over-git', 'git://127.0.0.1:1/x.git')
  const viaSsh = await runGitCommand(repo, ['fetch', 'over-ssh'], { GIT_SSH_COMMAND: undefined }, neutral)
  const viaGit = await runGitCommand(repo, ['fetch', 'over-git'], undefined, neutral)
  assert.equal(viaSsh.ok, false, 'nothing listens there')
  assert.equal(viaGit.ok, false)
  assert.deepEqual(ran(), [])

  await runGitCommand(repo, ['fetch', 'over-git'])
  assert.deepEqual(ran(), ['proxy'], 'as configured, the proxy runs')
})

test.runIf(posix)("a shell-command credential helper is not run, and the person's own helpers still are", async () => {
  const globalConfig = join(dir, 'global.gitconfig')
  writeFileSync(globalConfig, `[credential]\n\thelper = "!${program('own-helper')}"\n`)
  git(repo, 'config', 'credential.helper', `!${program('repo-helper')}`)
  const env = { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    await runGitCommand(repo, ['credential', 'fill'], undefined, {
      ...neutral,
      stdin: 'protocol=https\nhost=example.com\n\n',
    })
  } finally {
    process.env = saved
  }
  assert.deepEqual(ran(), ['own-helper'])
})

test.runIf(posix)(
  'the status poll runs inside the scope; a git outside it, like a terminal’s, is as configured',
  async () => {
    git(repo, 'config', 'filter.x.clean', program('clean'))
    // A changed stat with the same bytes makes git rehash the file through its filter.
    writeFileSync(join(repo, 'a.dat'), 'one\n')
    execFileSync('touch', ['-t', '200001010000', join(repo, 'a.dat')])
    await getGitStatus(repo)
    await withNeutralRepoPrograms(() => runGitCommand(repo, ['status', '--porcelain']))
    assert.deepEqual(ran(), [])
    execFileSync('git', ['-C', repo, 'status', '--porcelain'])
    assert.deepEqual(ran(), ['clean'], "the person's own git runs the repository's filter")
  },
)

test.runIf(posix)("a turn's checkpoints snapshot the files without the repository's filter", async () => {
  git(repo, 'config', 'filter.x.clean', program('clean'))
  git(repo, 'config', 'filter.x.required', 'true')
  const key = { workspaceRoot: repo, workspaceId: 'workspace', agentId: 'agent' }
  const checkpoints = new ConversationCheckpoints()
  assert.equal((await checkpoints.capture(key, 1, 'pre')).ok, true)
  writeFileSync(join(repo, 'a.dat'), 'edited\n')
  assert.equal((await checkpoints.capture(key, 1, 'post')).ok, true)
  assert.deepEqual(ran(), [])

  await trustRepo()
  writeFileSync(join(repo, 'a.dat'), 'edited again\n')
  assert.equal((await checkpoints.capture(key, 2, 'pre')).ok, true)
  assert.ok(ran().includes('clean'), 'trusted, the snapshot runs the filter as git would')
})

test('a repository that names nothing, or one the person trusted, gets no overrides', () => {
  const answer = (trusted: boolean): GitRepoTrustAnswer => ({
    trusted,
    settings: [{ scope: 'local', key: 'core.hookspath', value: '.husky' }],
    entries: [{ scope: 'local', key: 'core.hookspath', value: '.husky' }],
  })
  assert.equal(neutralRepoPrograms(null, { emptyHooksDir: '/x' }), null)
  assert.equal(neutralRepoPrograms(answer(true), { emptyHooksDir: '/x' }), null)
  assert.equal(neutralRepoPrograms({ trusted: false, settings: [], entries: [] }, { emptyHooksDir: '/x' }), null)
  assert.deepEqual(neutralRepoPrograms(answer(false), { emptyHooksDir: '/x' })?.config, ['-c', 'core.hooksPath=/x'])
})

test("each setting gets its own override, the person's ssh command and helpers kept", () => {
  const entries = [
    { scope: 'global', key: 'core.sshcommand', value: 'ssh -i ~/.ssh/work' },
    { scope: 'global', key: 'credential.helper', value: 'osxkeychain' },
    { scope: 'local', key: 'filter.lfs.smudge', value: 'evil' },
    { scope: 'local', key: 'merge.ours.driver', value: 'evil' },
    { scope: 'local', key: 'core.sshcommand', value: 'evil' },
    { scope: 'local', key: 'core.gitproxy', value: 'evil' },
    { scope: 'local', key: 'core.askpass', value: 'evil' },
    { scope: 'local', key: 'core.pager', value: 'evil' },
    { scope: 'local', key: 'core.editor', value: 'evil' },
    { scope: 'local', key: 'credential.helper', value: '!evil' },
    { scope: 'local', key: 'credential.https://example.com.helper', value: 'store' },
    { scope: 'local', key: 'diff.img.textconv', value: 'evil' },
  ]
  const settings = entries.filter(
    (entry) => entry.scope === 'local' && entry.key !== 'credential.https://example.com.helper',
  )
  const programs = neutralRepoPrograms({ trusted: false, settings, entries }, { emptyHooksDir: '/x', env: {} })
  const pairs = programs!.config.filter((_, index) => index % 2 === 1)
  assert.deepEqual(pairs, [
    'merge.ours.driver=',
    'core.sshCommand=ssh -i ~/.ssh/work',
    'core.askPass=',
    'core.pager=',
    'core.editor=:',
    'filter.lfs.clean=',
    'filter.lfs.smudge=',
    'filter.lfs.process=',
    'filter.lfs.required=false',
    'credential.helper=',
    'credential.helper=osxkeychain',
    'credential.https://example.com.helper=store',
  ])
  assert.deepEqual(programs!.env, { GIT_PROXY_COMMAND: '' })
  assert.equal(programs!.noDiffPrograms, true)
  assert.deepEqual(programs!.filters, ['lfs'])
  // A proxy command the person set in the environment already wins over the repository's.
  const own = neutralRepoPrograms(
    { trusted: false, settings, entries },
    { emptyHooksDir: '/x', env: { GIT_PROXY_COMMAND: 'mine' } },
  )
  assert.deepEqual(own!.env, {})
  // No ssh command of the person's own: git's own `ssh`.
  const plain = neutralRepoPrograms(
    { trusted: false, settings: [{ scope: 'local', key: 'core.sshcommand', value: 'evil' }], entries: [] },
    { emptyHooksDir: '/x' },
  )
  assert.deepEqual(plain!.config, ['-c', 'core.sshCommand=ssh'])
})
