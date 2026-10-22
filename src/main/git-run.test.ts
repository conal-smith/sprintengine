import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import {
  GIT_NETWORK_TIMEOUT_MS,
  DRIVE_MOUNT_GIT_CONFIG,
  GIT_SAFETY_CONFIG,
  GIT_READ_TIMEOUT_MS,
  classifyGitCommand,
  defaultGitTimeoutMs,
  gitEnv,
  gitSafetyEnv,
  installGitHostResolver,
  runGit,
  runGitCommand,
  withGitHost,
  wslShareSafeDirectories,
  wslShareSafeDirectoryEnv,
} from './git-run'
import { claudeLocalChildEnv } from './providers/claude-agent-provider'

test('reads are told apart from writes, so only reads get a deadline and skip optional locks', () => {
  const reads: string[][] = [
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    ['diff', '--numstat', '-z', 'HEAD'],
    ['rev-parse', '--show-toplevel'],
    ['rev-list', '--count', 'a..b'],
    ['for-each-ref', '--format=%(refname)', 'refs/heads'],
    ['branch', '--format=%(refname:short)', '--sort=refname'],
    ['branch'],
    ['tag', '--list'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['stash', 'list', '--format=%H'],
    ['worktree', 'list', '--porcelain', '-z'],
    ['remote', '-v'],
    ['remote', 'get-url', 'origin'],
    ['config', '--get', 'remote.origin.url'],
    ['-c', 'core.quotepath=off', 'ls-files', '--others'],
    ['--version'],
  ]
  for (const args of reads) assert.equal(classifyGitCommand(args), 'read', args.join(' '))

  const writes: string[][] = [
    ['commit', '-m', 'x'],
    ['merge', '--no-edit', 'main'],
    ['rebase', 'main'],
    ['push'],
    ['pull', '--no-rebase'],
    ['worktree', 'add', '-b', 'agent/x', '/tmp/x', 'HEAD'],
    ['worktree', 'remove', '/tmp/x'],
    ['branch', '-d', 'feature'],
    ['branch', 'feature', 'abc123'],
    ['tag', 'v1', 'abc123'],
    ['tag', '-a', 'v1', '-m', 'release'],
    ['symbolic-ref', 'HEAD', 'refs/heads/main'],
    ['stash', 'push', '-m', 'x'],
    ['add', '-A'],
    ['update-ref', '-d', 'refs/x'],
    ['config', 'user.name', 'dev'],
    ['some-future-subcommand'],
  ]
  for (const args of writes) assert.equal(classifyGitCommand(args), 'write', args.join(' '))

  assert.equal(classifyGitCommand(['fetch', '--prune']), 'network')
  assert.equal(classifyGitCommand(['remote', 'update']), 'network')

  assert.equal(defaultGitTimeoutMs('read'), GIT_READ_TIMEOUT_MS)
  assert.equal(defaultGitTimeoutMs('network'), GIT_NETWORK_TIMEOUT_MS)
  assert.equal(defaultGitTimeoutMs('write'), null, 'a hook-running write is never killed')
})

test('every git runs without a terminal prompt, and only reads opt out of optional locks', () => {
  const read = gitEnv(undefined, 'read')
  assert.equal(read.GIT_TERMINAL_PROMPT, '0')
  assert.equal(read.GIT_OPTIONAL_LOCKS, '0')
  assert.equal(read.LC_ALL, 'C')

  const write = gitEnv()
  assert.equal(write.GIT_TERMINAL_PROMPT, '0')
  assert.equal(write.GIT_OPTIONAL_LOCKS, undefined, 'a write takes the locks it needs')

  assert.equal(gitEnv({ GIT_DIR: undefined }, 'read').GIT_DIR, undefined, 'caller overrides still win')
})

test('a git that outlives its deadline is stopped and reported as timed out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'git-run-'))
  try {
    // `hash-object --stdin` waits on a stdin that is never closed: a stand-in
    // for a git blocked on a network mount or a lock.
    const startedAt = Date.now()
    const result = await runGitCommand(dir, ['hash-object', '--stdin'], undefined, { timeoutMs: 300 })
    assert.equal(result.ok, false)
    assert.match(result.message ?? '', /did not finish within/)
    assert.ok(Date.now() - startedAt < 10_000, 'the deadline, not the process, ended the call')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a repository on a WSL machine is run by that machine's git, under the same rules", async () => {
  const calls: Array<{ cwd: string; args: readonly string[]; timeoutMs: number | null; env: Record<string, string> }> =
    []
  let answer = { code: 0, stdout: 'main\n', stderr: '', timedOut: false }
  installGitHostResolver((cwd) =>
    cwd.startsWith('\\\\wsl.localhost\\')
      ? {
          kind: 'wsl',
          runGit: async (at, args, options) => {
            calls.push({ cwd: at, args, ...options })
            return answer
          },
        }
      : null,
  )
  try {
    const read = await runGitCommand('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', ['branch', '--show-current'])
    assert.deepEqual(read, { ok: true, stdout: 'main\n', stderr: '', message: null })
    assert.equal(calls[0].timeoutMs, GIT_READ_TIMEOUT_MS, 'a read keeps its deadline')
    assert.deepEqual(calls[0].env, { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' })

    answer = { code: 1, stdout: '', stderr: 'fatal: not a git repository', timedOut: false }
    const write = await runGitCommand('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', ['commit', '-m', 'x'], {
      GIT_AUTHOR_NAME: 'dev',
    })
    assert.equal(write.ok, false)
    assert.equal(write.message, 'fatal: not a git repository')
    assert.equal(calls[1].timeoutMs, null, 'a write keeps no deadline')
    assert.equal(calls[1].env.GIT_AUTHOR_NAME, 'dev')
    assert.equal(calls[1].env.GIT_OPTIONAL_LOCKS, undefined)

    answer = { code: 1, stdout: '', stderr: '', timedOut: true }
    const slow = await runGitCommand('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', ['status'])
    assert.equal(slow.ok, false)
    assert.match(slow.message ?? '', /did not finish within 15 s/u)
  } finally {
    installGitHostResolver(null)
  }
  // Anything the resolver does not claim keeps this machine's git.
  const dir = await mkdtemp(join(tmpdir(), 'se-git-local-'))
  try {
    const local = await runGitCommand(dir, ['--version'])
    assert.equal(local.ok, true)
    assert.equal(calls.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a machine named for one piece of work runs its git, ahead of the resolver', async () => {
  const seen: string[] = []
  installGitHostResolver(() => null)
  try {
    const host = {
      kind: 'wsl' as const,
      runGit: async (cwd: string) => {
        seen.push(cwd)
        return { code: 0, stdout: '/home/dev/repo\n', stderr: '', timedOut: false }
      },
    }
    const inside = await withGitHost(host, () => runGitCommand('C:\\repo', ['rev-parse', '--show-toplevel']))
    assert.equal(inside.ok, true)
    assert.deepEqual(seen, ['C:\\repo'])
    const dir = await mkdtemp(join(tmpdir(), 'se-git-scope-'))
    try {
      await withGitHost(null, () => runGitCommand(dir, ['--version']))
      assert.equal(seen.length, 1, 'no machine named: the resolver (here, this machine) decides')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  } finally {
    installGitHostResolver(null)
  }
})

test("a repository's own filesystem-monitor program is never run by the app's git", async (context) => {
  if (process.platform === 'win32') {
    context.skip('the planted program is a shell script')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'se-git-fsmonitor-'))
  try {
    await runGit(dir, ['init', '--quiet'])
    const marker = join(dir, 'fsmonitor-ran')
    const program = join(dir, 'monitor.sh')
    await writeFile(program, `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(program, 0o755)
    await runGit(dir, ['config', 'core.fsmonitor', program])
    await writeFile(join(dir, 'file.txt'), 'x')

    await runGit(dir, ['status', '--porcelain'])
    await runGit(dir, ['diff', '--shortstat'])

    await assert.rejects(stat(marker), 'the planted program never ran')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("a repository on another machine gets the same override ahead of the caller's arguments", async () => {
  const seen: Array<readonly string[]> = []
  const host = {
    kind: 'wsl' as const,
    runGit: async (_cwd: string, args: readonly string[]) => {
      seen.push(args)
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  await withGitHost(host, () => runGitCommand('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', ['status', '--porcelain']))
  assert.deepEqual(seen, [[...GIT_SAFETY_CONFIG, 'status', '--porcelain']])
})

test('Linux git on a Windows drive trusts the index Git for Windows wrote, by size and mtime', async () => {
  const seen: Array<readonly string[]> = []
  const host = {
    kind: 'wsl' as const,
    runGit: async (_cwd: string, args: readonly string[]) => {
      seen.push(args)
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  await withGitHost(host, () => runGitCommand('C:\\Users\\dev\\repo', ['status', '--porcelain']))
  await withGitHost(host, () => runGitCommand('/mnt/d/work/repo', ['status', '--porcelain']))
  assert.deepEqual(seen, [
    [...GIT_SAFETY_CONFIG, ...DRIVE_MOUNT_GIT_CONFIG, 'status', '--porcelain'],
    [...GIT_SAFETY_CONFIG, ...DRIVE_MOUNT_GIT_CONFIG, 'status', '--porcelain'],
  ])
})

test("Git for Windows is told a repository inside a distribution is the person's, for this call only", () => {
  assert.deepEqual(wslShareSafeDirectories('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', 'win32'), [
    '%(prefix)///wsl.localhost/Ubuntu/home/dev/repo',
    '%(prefix)///wsl.localhost/Ubuntu/home/dev',
    '%(prefix)///wsl.localhost/Ubuntu/home',
    '%(prefix)///wsl.localhost/Ubuntu',
  ])
  assert.deepEqual(
    wslShareSafeDirectories('//wsl$/Debian/srv/', 'win32'),
    ['%(prefix)///wsl$/Debian/srv', '%(prefix)///wsl$/Debian'],
    'the share is spelled as given, which is how git names the repository back',
  )
  assert.deepEqual(wslShareSafeDirectories('C:\\Users\\dev\\repo', 'win32'), [])
  assert.deepEqual(wslShareSafeDirectories('\\\\fileserver\\team\\repo', 'win32'), [], 'only a distribution')
  assert.deepEqual(wslShareSafeDirectories('//wsl.localhost/Ubuntu/home/dev/repo', 'darwin'), [])
})

test('the environment form carries the same entries after any already there', () => {
  const env = gitSafetyEnv(
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'dev' },
    '//wsl.localhost/Ubuntu/home',
    'win32',
  )
  assert.equal(env.GIT_CONFIG_COUNT, '5')
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name')
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => [env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]]),
    [
      ['core.fsmonitor', 'false'],
      ['safe.bareRepository', 'explicit'],
      ['safe.directory', '%(prefix)///wsl.localhost/Ubuntu/home'],
      ['safe.directory', '%(prefix)///wsl.localhost/Ubuntu'],
    ],
  )
  assert.equal(gitSafetyEnv({}, 'C:\\Users\\dev\\repo', 'win32').GIT_CONFIG_COUNT, '2')
})

test("an agent's own git on This PC is told a distribution's folder is safe, after the person's own entries", () => {
  const base = {
    PATH: 'C:\\Windows',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'a.b',
    GIT_CONFIG_VALUE_0: '1',
    GIT_CONFIG_KEY_1: 'c.d',
    GIT_CONFIG_VALUE_1: '2',
  }
  const env = wslShareSafeDirectoryEnv(base, '\\\\wsl$\\Debian\\srv\\app', 'win32')
  assert.equal(env.GIT_CONFIG_COUNT, '5')
  assert.equal(env.GIT_CONFIG_KEY_1, 'c.d', 'the entries already there keep their places')
  assert.deepEqual(
    [2, 3, 4].map((n) => [env[`GIT_CONFIG_KEY_${n}`], env[`GIT_CONFIG_VALUE_${n}`]]),
    [
      ['safe.directory', '%(prefix)///wsl$/Debian/srv/app'],
      ['safe.directory', '%(prefix)///wsl$/Debian/srv'],
      ['safe.directory', '%(prefix)///wsl$/Debian'],
    ],
  )
  // Only the safe-directory entries: the app's own fsmonitor override is not the agent's.
  assert.equal(Object.values(env).includes('core.fsmonitor'), false)
  // Anywhere else, the environment is the one given.
  assert.equal(wslShareSafeDirectoryEnv(base, 'C:\\Users\\dev\\app', 'win32'), base)
  assert.equal(wslShareSafeDirectoryEnv(base, '//wsl.localhost/Ubuntu/home/dev', 'darwin'), base)
  assert.equal(wslShareSafeDirectoryEnv(base, undefined, 'win32'), base)
  // A count that is not a number starts the agent's entries at 0.
  assert.equal(
    wslShareSafeDirectoryEnv({ GIT_CONFIG_COUNT: 'x' }, '//wsl.localhost/Ubuntu', 'win32').GIT_CONFIG_KEY_0,
    'safe.directory',
  )
})

test("a Claude chat on This PC in a distribution's folder starts with that folder safe for its git", () => {
  const env = claudeLocalChildEnv(
    { PATH: 'C:\\Windows', SPRINTENGINE_MCP_CHANNEL_TOKEN: 'inherited' },
    'tok_child',
    '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app',
    'win32',
  )
  assert.equal(env.GIT_CONFIG_COUNT, '4')
  assert.equal(env.GIT_CONFIG_VALUE_0, '%(prefix)///wsl.localhost/Ubuntu/home/dev/app')
  assert.equal(claudeLocalChildEnv({ PATH: '/usr/bin' }, null, '/Users/dev/app', 'darwin').GIT_CONFIG_COUNT, undefined)
})
