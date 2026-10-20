import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { githubRepositoryOf, readFolderGitInfo, resolveSshHostName } from './workspace-git-info'

// A workspace's branch and remotes for capability modules. Git does the
// worktree and submodule resolving; this file pins what git cannot know — that
// an SSH alias names GitHub — and the result shapes a module switches on.

const SSH_CONFIG = `
# work account
Host github-work
  HostName github.com
  User git
  IdentityFile ~/.ssh/work

Host *.internal !build-box.internal
    HostName=%h.example.net

Host *
  ServerAliveInterval 60
`

test('an SSH alias resolves through the first matching Host block', () => {
  assert.equal(resolveSshHostName('github-work', SSH_CONFIG), 'github.com')
  assert.equal(resolveSshHostName('cache.internal', SSH_CONFIG), 'cache.internal.example.net')
  assert.equal(resolveSshHostName('build-box.internal', SSH_CONFIG), null, 'a negated pattern excludes the host')
  assert.equal(resolveSshHostName('gitlab.example.com', SSH_CONFIG), null)
  assert.equal(resolveSshHostName('github-work', ''), null)
})

test('an SSH config value is read the way ssh splits it', () => {
  const config = `
Host "github-personal" 'github-oss'
  HostName github.com # personal account

Host github-quoted
  HostName "github.com"

Host "github-broken
  HostName evil.example.com

Host github-escaped
  HostName github\\ .com
`
  assert.equal(resolveSshHostName('github-personal', config), 'github.com', 'a trailing comment is not the value')
  assert.equal(resolveSshHostName('github-oss', config), 'github.com', 'single quotes group a pattern')
  assert.equal(resolveSshHostName('github-quoted', config), 'github.com')
  assert.equal(resolveSshHostName('github-broken', config), null, 'an unterminated quote matches nothing')
  assert.equal(resolveSshHostName('"github-broken', config), null)
  assert.equal(resolveSshHostName('github-escaped', config), 'github .com', 'a backslash escapes a space')
})

test('GitHub remotes are read in every URL form', () => {
  const resolve = (alias: string) => resolveSshHostName(alias, SSH_CONFIG)
  assert.equal(githubRepositoryOf('git@github.com:acme/app.git'), 'acme/app')
  assert.equal(githubRepositoryOf('https://github.com/acme/app'), 'acme/app')
  assert.equal(githubRepositoryOf('https://dev:ghp_token@github.com/acme/app.git'), 'acme/app')
  assert.equal(githubRepositoryOf('ssh://git@ssh.github.com:443/acme/app.git'), 'acme/app')
  assert.equal(githubRepositoryOf('git@github-work:acme/app.git', resolve), 'acme/app', 'an alias for github.com')
  assert.equal(githubRepositoryOf('ssh://git@github-work/acme/app', resolve), 'acme/app')
  assert.equal(githubRepositoryOf('git@github-work:acme/app.git'), null, 'without the config the alias is unknown')
  assert.equal(githubRepositoryOf('https://github-work/acme/app', resolve), null, 'an alias is an SSH concept')
  assert.equal(githubRepositoryOf('https://gitlab.example.com/acme/app.git'), null)
  assert.equal(githubRepositoryOf('https://github.com/acme'), null)
  assert.equal(githubRepositoryOf('C:\\repos\\app'), null)
  assert.equal(githubRepositoryOf('/Users/dev/repos/app'), null)
})

test('a folder with no repository, or no folder, says so', async () => {
  assert.deepEqual(await readFolderGitInfo(null), {
    ok: false,
    code: 'no_folder',
    message: 'The workspace has no folder.',
  })
  const result = await readFolderGitInfo('/Users/dev/plain', { readRepoRoot: async () => null })
  assert.equal(result.ok === false && result.code, 'not_a_repository')
  const machine = await readFolderGitInfo('ssh://build-box/home/dev/app')
  assert.equal(machine.ok === false && machine.code, 'unavailable')
})

test('remotes are sorted, credentials are stripped and GitHub ones are named', async () => {
  const result = await readFolderGitInfo('/Users/dev/acme', {
    readRepoRoot: async () => '/Users/dev/acme',
    readBranch: async () => 'feature/radar',
    readSshConfig: async () => SSH_CONFIG,
    readRemotes: async () =>
      [
        'upstream\tgit@github-work:acme/app.git (fetch)',
        'upstream\tgit@github-work:acme/app.git (push)',
        'origin\thttps://dev:ghp_s3cret@github.com/dev/app.git (fetch)',
        'mirror\thttps://gitlab.example.com/acme/app.git (fetch)',
      ].join('\n'),
  })
  assert.deepEqual(result, {
    ok: true,
    branch: 'feature/radar',
    remotes: [
      { name: 'mirror', url: 'https://gitlab.example.com/acme/app.git' },
      { name: 'origin', url: 'https://github.com/dev/app.git', github: 'dev/app' },
      { name: 'upstream', url: 'git@github-work:acme/app.git', github: 'acme/app' },
    ],
  })
})

test('a git failure is a result, never a throw', async () => {
  const result = await readFolderGitInfo('/Users/dev/acme', {
    readRepoRoot: async () => '/Users/dev/acme',
    readRemotes: async () => {
      throw new Error('fatal: not a git repository')
    },
  })
  assert.equal(result.ok === false && result.code, 'git_failed')
})

test('a real worktree reports its own branch and the shared remotes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-git-info-')))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Dev',
        GIT_AUTHOR_EMAIL: 'dev@example.com',
        GIT_COMMITTER_NAME: 'Dev',
        GIT_COMMITTER_EMAIL: 'dev@example.com',
      },
    })
  try {
    const main = join(root, 'app')
    git(root, 'init', '-q', '-b', 'main', main)
    git(main, 'commit', '-q', '--allow-empty', '-m', 'first')
    git(main, 'remote', 'add', 'origin', 'https://github.com/acme/app.git')
    const worktree = join(root, 'app-radar')
    git(main, 'worktree', 'add', '-q', '-b', 'radar', worktree)

    const fromMain = await readFolderGitInfo(main, { readSshConfig: async () => '' })
    assert.deepEqual(fromMain, {
      ok: true,
      branch: 'main',
      remotes: [{ name: 'origin', url: 'https://github.com/acme/app.git', github: 'acme/app' }],
    })
    const fromWorktree = await readFolderGitInfo(worktree, { readSshConfig: async () => '' })
    assert.equal(fromWorktree.ok && fromWorktree.branch, 'radar')
    assert.deepEqual(fromWorktree.ok && fromWorktree.remotes, fromMain.ok && fromMain.remotes)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
