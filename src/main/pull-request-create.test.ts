import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { test } from 'vitest'

import type { BranchPullRequestsRead } from './github/branch-pull-request'
import type { GhRunner } from './github/gh'
import { createPullRequestCreator } from './pull-request-create'

// The chat's "Create PR" against real git: a bare "origin" and a clone of it.
// `gh` and the branch lookup are stand-ins, so nothing reaches GitHub.

const exec = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
    },
  })
  return stdout.trim()
}

async function commit(cwd: string, file: string, text: string, message: string): Promise<void> {
  await writeFile(path.join(cwd, file), text)
  await git(cwd, 'add', file)
  await git(cwd, 'commit', '-q', '-m', message)
}

/** A clone of a bare origin, `main` pushed, `origin/HEAD` recorded, on a feature branch with one commit. */
async function checkout(): Promise<{ clone: string; origin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'sprintengine-pr-create-'))
  const origin = path.join(root, 'origin.git')
  const clone = path.join(root, 'app')
  await exec('git', ['init', '-q', '--bare', '-b', 'main', origin])
  await exec('git', ['init', '-q', '-b', 'main', clone])
  await git(clone, 'remote', 'add', 'origin', origin)
  await commit(clone, 'README.md', 'app\n', 'chore: start')
  await git(clone, 'push', '-q', '-u', 'origin', 'main')
  await git(clone, 'remote', 'set-head', 'origin', 'main')
  await git(clone, 'checkout', '-q', '-b', 'feature/marks')
  await commit(clone, 'marks.ts', 'export const marks = 1\n', 'feat: marks')
  // The remote reads as GitHub; pushes still go to the bare repository.
  await git(clone, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git')
  await git(clone, 'remote', 'set-url', '--push', 'origin', origin)
  return { clone, origin }
}

function lookupOf(read: BranchPullRequestsRead) {
  const asked: string[] = []
  return {
    asked,
    listBranch: async (input: { gitRoot: string; branch: string }) => {
      asked.push(input.branch)
      return read
    },
  }
}

const NONE: BranchPullRequestsRead = { settled: true, pullRequests: [] }

test('a branch with committed, unproposed work is ready, uncommitted work or not; an open pull request is not', async () => {
  const { clone } = await checkout()
  const lookup = lookupOf(NONE)
  const creator = createPullRequestCreator({ listBranch: lookup.listBranch })
  const state = await creator.state(clone)
  assert.deepEqual(state.readiness, { ready: true })
  assert.equal(state.branch, 'feature/marks')
  assert.equal(state.base, 'main')
  assert.equal(state.forge, 'github')
  assert.equal(state.uncommittedChanges, 0)

  await writeFile(path.join(clone, 'scratch.txt'), 'wip\n')
  await writeFile(path.join(clone, 'marks.ts'), 'export const marks = 2\n')
  await mkdir(path.join(clone, '.sprintengine'), { recursive: true })
  await writeFile(path.join(clone, '.sprintengine', 'capture.png'), 'png\n')
  const dirty = await creator.state(clone)
  assert.deepEqual(dirty.readiness, { ready: true }, 'uncommitted work does not hide the button')
  assert.equal(dirty.uncommittedChanges, 2, "an edit and an untracked file, never the app's own sidecar")
  await exec('rm', ['-r', path.join(clone, 'scratch.txt'), path.join(clone, '.sprintengine')])
  await git(clone, 'checkout', '--', 'marks.ts')

  const open = createPullRequestCreator({
    listBranch: lookupOf({
      settled: true,
      pullRequests: [
        {
          url: 'https://github.com/acme/app/pull/3',
          repoKey: 'github.com/acme/app',
          repoName: 'app',
          number: 3,
          title: 'Someone else’s',
          state: 'open',
          isDraft: false,
          openedAt: 1,
          stateAt: 1,
        },
      ],
    }).listBranch,
  })
  assert.deepEqual((await open.state(clone)).readiness, { ready: false, reason: 'open-pull-request' })

  await git(clone, 'checkout', '-q', 'main')
  assert.deepEqual((await creator.state(clone)).readiness, { ready: false, reason: 'default-branch' })
})

test('a merged pull request carried the commits until new ones come', async () => {
  const { clone } = await checkout()
  const head = await git(clone, 'rev-parse', 'HEAD')
  const merged: BranchPullRequestsRead = {
    settled: true,
    pullRequests: [
      {
        url: 'https://github.com/acme/app/pull/2',
        repoKey: 'github.com/acme/app',
        repoName: 'app',
        number: 2,
        title: 'Marks',
        state: 'merged',
        isDraft: false,
        openedAt: 1,
        stateAt: 1,
        headRefOid: head,
      },
    ],
  }
  const creator = createPullRequestCreator({
    listBranch: lookupOf(merged).listBranch,
    now: (() => {
      let at = 0
      return () => (at += 60_000)
    })(),
  })
  assert.deepEqual((await creator.state(clone)).readiness, { ready: false, reason: 'nothing-to-propose' })
  await commit(clone, 'more.ts', 'export const more = 2\n', 'feat: more marks')
  assert.deepEqual((await creator.state(clone)).readiness, { ready: true })
})

test('the push sets an upstream the first time, then pushes only what the remote lacks', async () => {
  const { clone, origin } = await checkout()
  const creator = createPullRequestCreator({ listBranch: lookupOf(NONE).listBranch })
  assert.deepEqual(await creator.push(clone), { ok: true, pushed: true })
  assert.equal(await git(origin, 'rev-parse', 'refs/heads/feature/marks'), await git(clone, 'rev-parse', 'HEAD'))
  assert.equal(await git(clone, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feature/marks')
  assert.deepEqual(await creator.push(clone), { ok: true, pushed: false })
})

test('uncommitted work stays in the checkout: only the commit is pushed, and the draft reads only commits', async () => {
  const { clone, origin } = await checkout()
  const head = await git(clone, 'rev-parse', 'HEAD')
  await writeFile(path.join(clone, 'marks.ts'), 'export const marks = 99\n')
  await writeFile(path.join(clone, 'README.md'), 'staged readme\n')
  await git(clone, 'add', 'README.md')
  await writeFile(path.join(clone, 'scratch.txt'), 'untracked work\n')
  const statusBefore = await git(clone, 'status', '--porcelain')
  const creator = createPullRequestCreator({ listBranch: lookupOf(NONE).listBranch })
  const draft = await creator.draftInput(clone)
  assert.ok(draft.ok)
  assert.doesNotMatch(draft.input.patch, /marks = 99|staged readme|untracked work/u)
  assert.deepEqual(await creator.push(clone, { branch: 'feature/marks', headSha: head }), { ok: true, pushed: true })
  assert.equal(await git(origin, 'rev-parse', 'refs/heads/feature/marks'), head)
  assert.equal(await git(origin, 'show', 'refs/heads/feature/marks:marks.ts'), 'export const marks = 1')
  assert.equal(await git(clone, 'status', '--porcelain'), statusBefore, 'the working tree and index are untouched')
})

test('a push that cannot count what the remote lacks pushes rather than calling it pushed', async () => {
  const { clone, origin } = await checkout()
  await createPullRequestCreator({ listBranch: lookupOf(NONE).listBranch }).push(clone)
  await commit(clone, 'more.ts', 'export const more = 1\n', 'feat: more')
  const { runGitCommand } = await import('./git-utils')
  const creator = createPullRequestCreator({
    listBranch: lookupOf(NONE).listBranch,
    git: async (cwd, args, ...rest) =>
      args[0] === 'rev-list' && args.some((arg) => arg.startsWith('refs/remotes/origin/feature/marks..'))
        ? { ok: false, stdout: '', stderr: 'fatal: bad revision', message: 'bad revision' }
        : runGitCommand(cwd, args, ...rest),
  })
  assert.deepEqual(await creator.push(clone), { ok: true, pushed: true })
  assert.equal(await git(origin, 'rev-parse', 'refs/heads/feature/marks'), await git(clone, 'rev-parse', 'HEAD'))
})

test('a branch cut from origin/main, and so tracking it, is pushed to its own name and never to main', async () => {
  const { clone, origin } = await checkout()
  await git(clone, 'push', '-q', origin, 'main')
  await git(clone, 'fetch', '-q', origin, '+refs/heads/main:refs/remotes/origin/main')
  await git(clone, 'branch', '--set-upstream-to=origin/main')
  await git(clone, 'config', 'push.default', 'upstream')
  const mainBefore = await git(origin, 'rev-parse', 'refs/heads/main')
  const creator = createPullRequestCreator({ listBranch: lookupOf(NONE).listBranch })
  assert.deepEqual(await creator.push(clone), { ok: true, pushed: true })
  assert.equal(await git(origin, 'rev-parse', 'refs/heads/main'), mainBefore, 'main is untouched')
  assert.equal(await git(origin, 'rev-parse', 'refs/heads/feature/marks'), await git(clone, 'rev-parse', 'HEAD'))
  assert.equal(await git(clone, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feature/marks')
})

test('a branch set to push to a fork is pushed there, under its own name, and its pull request names the fork', async () => {
  const { clone, origin } = await checkout()
  const fork = path.join(path.dirname(origin), 'fork.git')
  await exec('git', ['init', '-q', '--bare', '-b', 'main', fork])
  await git(clone, 'remote', 'add', 'mine', 'git@github.com:dev/app.git')
  await git(clone, 'remote', 'set-url', '--push', 'mine', fork)
  await git(clone, 'config', 'branch.feature/marks.pushRemote', 'mine')
  const calls: string[][] = []
  const gh: GhRunner = {
    available: async () => true,
    run: async (args) => {
      calls.push(args)
      return { found: true, code: 0, stdout: 'https://github.com/acme/app/pull/14\n', stderr: '' }
    },
  }
  const creator = createPullRequestCreator({ gh, listBranch: lookupOf(NONE).listBranch })
  assert.deepEqual(await creator.push(clone), { ok: true, pushed: true })
  assert.equal(await git(fork, 'rev-parse', 'refs/heads/feature/marks'), await git(clone, 'rev-parse', 'HEAD'))
  await assert.rejects(git(origin, 'rev-parse', '--verify', 'refs/heads/feature/marks'), 'nothing was pushed to origin')
  await creator.create(clone, { title: 'feat: marks', body: '' })
  assert.equal(calls[0][calls[0].indexOf('--head') + 1], 'dev:feature/marks')

  // Pushed elsewhere by a setting, the branch keeps the upstream it had.
  await assert.rejects(git(clone, 'rev-parse', '--abbrev-ref', '@{u}'), 'no upstream was set')

  // A push remote that does not exist is an error, as it is for git, and
  // nothing goes to origin instead.
  await git(clone, 'config', 'branch.feature/marks.pushRemote', 'nowhere')
  await commit(clone, 'more.ts', 'export const more = 1\n', 'feat: more')
  const refused = await creator.push(clone)
  assert.equal(refused.ok, false)
  assert.match(refused.ok ? '' : refused.message, /“nowhere”.*branch\.feature\/marks\.pushRemote/)
  await assert.rejects(git(origin, 'rev-parse', '--verify', 'refs/heads/feature/marks'), 'still nothing on origin')
})

test('a clone of a fork, its parent as upstream, opens the pull request on the parent from the fork', async () => {
  const { clone } = await checkout()
  // origin is the person's fork; upstream is the repository it was forked from.
  await git(clone, 'remote', 'set-url', 'origin', 'git@github.com:dev/app.git')
  await git(clone, 'remote', 'add', 'upstream', 'https://github.com/acme/app.git')
  const calls: string[][] = []
  const gh: GhRunner = {
    available: async () => true,
    run: async (args) => {
      calls.push(args)
      return { found: true, code: 0, stdout: 'https://github.com/acme/app/pull/15\n', stderr: '' }
    },
  }
  const creator = createPullRequestCreator({ gh, listBranch: lookupOf(NONE).listBranch })
  await creator.create(clone, { title: 'feat: marks', body: '' })
  const flag = (name: string) => calls[0]![calls[0]!.indexOf(name) + 1]
  assert.equal(flag('--head'), 'dev:feature/marks')
  assert.equal(flag('--repo'), 'github.com/acme/app')

  // `gh repo set-default` marking origin as the base: the fork is the base, and the head is the branch alone.
  await git(clone, 'config', 'remote.origin.gh-resolved', 'base')
  calls.length = 0
  await creator.create(clone, { title: 'feat: marks', body: '' })
  assert.equal(flag('--head'), 'feature/marks')
  assert.equal(flag('--repo'), 'github.com/dev/app')
})

test('a push remote is chosen as git chooses it: the branch’s own, then the default, then a fork it tracks', async () => {
  const { clone, origin } = await checkout()
  const fork = path.join(path.dirname(origin), 'fork.git')
  await exec('git', ['init', '-q', '--bare', '-b', 'main', fork])
  await git(clone, 'remote', 'add', 'mine', 'git@github.com:dev/app.git')
  await git(clone, 'remote', 'set-url', '--push', 'mine', fork)
  const creator = createPullRequestCreator({ listBranch: lookupOf(NONE).listBranch })
  const head = () => git(clone, 'rev-parse', 'HEAD')

  // remote.pushDefault sends it to the fork…
  await git(clone, 'config', 'remote.pushDefault', 'mine')
  assert.deepEqual(await creator.push(clone), { ok: true, pushed: true })
  assert.equal(await git(fork, 'rev-parse', 'refs/heads/feature/marks'), await head())
  // …and the branch's own pushRemote, origin included, wins over it.
  await git(clone, 'config', 'branch.feature/marks.pushRemote', 'origin')
  assert.deepEqual(await creator.push(clone), { ok: true, pushed: true })
  assert.equal(await git(origin, 'rev-parse', 'refs/heads/feature/marks'), await head())

  // With neither, a branch tracking its namesake on the fork is pushed there,
  // and its upstream is left on the fork.
  await git(clone, 'config', '--unset', 'branch.feature/marks.pushRemote')
  await git(clone, 'config', '--unset', 'remote.pushDefault')
  await git(clone, 'config', 'branch.feature/marks.remote', 'mine')
  await git(clone, 'config', 'branch.feature/marks.merge', 'refs/heads/feature/marks')
  await commit(clone, 'fork.ts', 'export const fork = 1\n', 'feat: fork')
  assert.deepEqual(await creator.push(clone), { ok: true, pushed: true })
  assert.equal(await git(fork, 'rev-parse', 'refs/heads/feature/marks'), await head())
  assert.notEqual(await git(origin, 'rev-parse', 'refs/heads/feature/marks'), await head(), 'origin is not pushed')
  assert.equal(await git(clone, 'config', '--get', 'branch.feature/marks.remote'), 'mine')
})

test('GitHub: gh creates it with the body from a file, and an existing one is taken rather than failed', async () => {
  const { clone } = await checkout()
  const calls: Array<{ args: string[]; body: string }> = []
  let answer = { found: true, code: 0, stdout: 'https://github.com/acme/app/pull/12\n', stderr: '' }
  const gh: GhRunner = {
    available: async () => true,
    run: async (args) => {
      calls.push({ args, body: await readFile(args[args.indexOf('--body-file') + 1], 'utf8') })
      return answer
    },
  }
  const creator = createPullRequestCreator({ gh, listBranch: lookupOf(NONE).listBranch })
  assert.deepEqual(await creator.create(clone, { title: 'feat: marks', body: '## Why\n\nMarks.' }), {
    ok: true,
    kind: 'created',
    url: 'https://github.com/acme/app/pull/12',
  })
  assert.deepEqual(calls[0].args.slice(0, 8), [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    'feature/marks',
    '--title',
    'feat: marks',
  ])
  assert.equal(calls[0].body, '## Why\n\nMarks.')

  answer = {
    found: true,
    code: 1,
    stdout: '',
    stderr:
      'a pull request for branch "feature/marks" into branch "main" already exists:\nhttps://github.com/acme/app/pull/12\n',
  }
  assert.deepEqual(await creator.create(clone, { title: 'feat: marks', body: '' }), {
    ok: true,
    kind: 'existing',
    url: 'https://github.com/acme/app/pull/12',
  })

  answer = { found: true, code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }
  const signedOut = await creator.create(clone, { title: 'feat: marks', body: '' })
  assert.equal(signedOut.ok, false)
  assert.match(!signedOut.ok ? signedOut.message : '', /gh auth login/)

  answer = { found: false, code: -1, stdout: '', stderr: '' }
  const missing = await creator.create(clone, { title: 'feat: marks', body: '' })
  assert.match(!missing.ok ? missing.message : '', /not installed/)
})

test('another forge opens its own prefilled page instead', async () => {
  const { clone } = await checkout()
  await git(clone, 'remote', 'set-url', 'origin', 'git@gitlab.com:acme/app.git')
  const creator = createPullRequestCreator({
    gh: { available: async () => true, run: async () => assert.fail('gh is GitHub only') },
    listBranch: async () => assert.fail('the lookup is GitHub only'),
  })
  assert.deepEqual((await creator.state(clone)).readiness, { ready: true })
  assert.deepEqual(await creator.create(clone, { title: 'feat: marks', body: '' }), {
    ok: true,
    kind: 'page',
    url: 'https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fmarks&merge_request%5Btarget_branch%5D=main',
  })
})

test('a draft is written from the branch’s own commits and diff, its template and its convention', async () => {
  const { clone } = await checkout()
  await exec('mkdir', ['-p', path.join(clone, '.github')])
  await writeFile(
    path.join(clone, '.github', 'pull_request_template.md'),
    '<!-- say why -->\n### What changed and why\n',
  )
  await git(clone, 'add', '.github')
  await git(clone, 'commit', '-q', '-m', 'chore: template')
  const creator = createPullRequestCreator({ listBranch: lookupOf(NONE).listBranch })
  const draft = await creator.draftInput(clone)
  assert.ok(draft.ok)
  assert.equal(draft.input.base, 'main')
  assert.equal(draft.input.head, 'feature/marks')
  assert.match(draft.input.commits, /feat: marks/)
  assert.doesNotMatch(draft.input.commits, /chore: start/, 'only the branch’s own commits')
  assert.match(draft.input.patch, /export const marks = 1/)
  assert.equal(draft.input.template, '### What changed and why', 'comments are left out')
  assert.equal(draft.input.conventionalCommits, false, 'one commit on main says nothing about a convention')
})

test('the push and the creation are for the branch and commit confirmed, and refused once the checkout moved', async () => {
  const { clone, origin } = await checkout()
  const calls: string[][] = []
  const gh: GhRunner = {
    available: async () => true,
    run: async (args) => {
      calls.push(args)
      return { found: true, code: 0, stdout: 'https://github.com/acme/app/pull/16\n', stderr: '' }
    },
  }
  const creator = createPullRequestCreator({ gh, listBranch: lookupOf(NONE).listBranch })
  const confirmed = await creator.state(clone)
  assert.ok(confirmed.branch && confirmed.headSha)
  const pin = { branch: confirmed.branch, headSha: confirmed.headSha }

  // A commit lands after the person confirmed: nothing they did not see goes out.
  await commit(clone, 'later.ts', 'export const later = 1\n', 'feat: later')
  const pushed = await creator.push(clone, pin)
  assert.equal(pushed.ok, false)
  assert.match(!pushed.ok ? pushed.message : '', /moved after the pull request was confirmed/u)
  await assert.rejects(git(origin, 'rev-parse', '--verify', 'refs/heads/feature/marks'), 'nothing was pushed')
  const created = await creator.create(clone, { title: 'feat: marks', body: '' }, pin)
  assert.equal(created.ok, false)
  assert.deepEqual(calls, [], 'gh was not asked')

  // Another branch checked out is refused the same way.
  await git(clone, 'checkout', '-q', '-b', 'feature/other')
  assert.equal((await creator.push(clone, { ...pin, headSha: await git(clone, 'rev-parse', 'HEAD') })).ok, false)

  // Back where it was confirmed, the confirmed commit is what is pushed.
  await git(clone, 'checkout', '-q', 'feature/marks')
  await git(clone, 'reset', '-q', '--hard', pin.headSha)
  assert.deepEqual(await creator.push(clone, pin), { ok: true, pushed: true })
  assert.equal(await git(origin, 'rev-parse', 'refs/heads/feature/marks'), pin.headSha)
  assert.equal((await creator.create(clone, { title: 'feat: marks', body: '' }, pin)).ok, true)
})

test('a second confirm waits for the first push and creation on the checkout, never alongside them', async () => {
  const { clone } = await checkout()
  let active = 0
  let most = 0
  const gh: GhRunner = {
    available: async () => true,
    run: async () => {
      active += 1
      most = Math.max(most, active)
      await new Promise((resolve) => setTimeout(resolve, 20))
      active -= 1
      return { found: true, code: 0, stdout: 'https://github.com/acme/app/pull/17\n', stderr: '' }
    },
  }
  const creator = createPullRequestCreator({ gh, listBranch: lookupOf(NONE).listBranch })
  const text = { title: 'feat: marks', body: '' }
  const [first, second] = await Promise.all([creator.create(clone, text), creator.create(clone, text)])
  assert.equal(first.ok && second.ok, true)
  assert.equal(most, 1)
})
