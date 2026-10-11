import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  CLAUDE_WORKTREE_LEASE_TOOLS,
  GATEWAY_WORKTREE_LEASE_TOOLS,
  isInGitCheckout,
  runsGitWorktreeAdd,
  worktreeLeaseInstruction,
  worktreeLeaseRedirect,
} from './worktree-lease-guidance'

test('Claude Code is told the pool tools by the names it files the gateway tools under', () => {
  expect(CLAUDE_WORKTREE_LEASE_TOOLS).toEqual({
    lease: 'mcp__sprintengine-studio__worktree_lease',
    release: 'mcp__sprintengine-studio__worktree_release',
  })
  expect(worktreeLeaseInstruction(CLAUDE_WORKTREE_LEASE_TOOLS)).toBe(
    'To work in a separate git worktree, call the SprintEngine Studio tool ' +
      '`mcp__sprintengine-studio__worktree_lease` (and `mcp__sprintengine-studio__worktree_release` when done) ' +
      'instead of running `git worktree add`: it gives you a pooled worktree on a fresh branch off the default ' +
      'branch, with dependencies installed when the project has turned that on.',
  )
})

test('Codex is told the gateway names and the server they are on', () => {
  expect(worktreeLeaseInstruction(GATEWAY_WORKTREE_LEASE_TOOLS)).toContain(
    'call the SprintEngine Studio tool `worktree.lease` from its `sprintengine-studio` MCP server ' +
      '(and `worktree.release` when done) instead of running `git worktree add`',
  )
})

test('the redirect names the tool and says a repeat of the command goes through', () => {
  const redirect = worktreeLeaseRedirect(CLAUDE_WORKTREE_LEASE_TOOLS)
  expect(redirect).toContain('`mcp__sprintengine-studio__worktree_lease`')
  expect(redirect).toContain('explicitly asked for `git worktree add`')
  expect(redirect).toContain('run the same command again')
})

test('git worktree add is found however the command spells and chains it', () => {
  for (const command of [
    'git worktree add ../app-fix -b fix',
    'git -C /Users/dev/app worktree add ../app-fix',
    'git -C "/Users/dev/my app" worktree add ../x',
    'git -c core.hooksPath=/dev/null --no-pager worktree add x',
    'git --git-dir=/Users/dev/app/.git worktree add x',
    'cd /Users/dev/app && git worktree add ../x && cd ../x',
    'git fetch origin; git worktree add -b feat ../feat origin/main',
    'npm test || git worktree add x',
    '(git worktree add x)',
    '/usr/bin/git worktree add x',
    'git worktree add',
    'git worktree   add\tx',
  ])
    expect(runsGitWorktreeAdd(command), command).toBe(true)
})

test('other git worktree commands and look-alikes are left alone', () => {
  for (const command of [
    'git worktree list',
    'git worktree remove ../x',
    'git worktree prune',
    'git add -A',
    'git commit -m "worktree add"',
    'legit worktree add',
    'git worktree addition',
    'ls',
  ])
    expect(runsGitWorktreeAdd(command), command).toBe(false)
  expect(runsGitWorktreeAdd(undefined)).toBe(false)
  expect(runsGitWorktreeAdd({ command: 'git worktree add x' })).toBe(false)
})

test('a folder is in a git checkout by a .git in it or above it, a worktree file included', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lease-guidance-'))
  try {
    await mkdir(join(root, 'repo', '.git'), { recursive: true })
    await mkdir(join(root, 'repo', 'packages', 'app'), { recursive: true })
    await mkdir(join(root, 'linked'), { recursive: true })
    await writeFile(join(root, 'linked', '.git'), 'gitdir: /Users/dev/app/.git/worktrees/linked\n')
    await mkdir(join(root, 'plain'), { recursive: true })
    expect(await isInGitCheckout(join(root, 'repo'))).toBe(true)
    expect(await isInGitCheckout(join(root, 'repo', 'packages', 'app'))).toBe(true)
    expect(await isInGitCheckout(join(root, 'linked'))).toBe(true)
    expect(await isInGitCheckout(join(root, 'plain'))).toBe(false)
    expect(await isInGitCheckout(undefined)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
