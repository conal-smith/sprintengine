import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, vi } from 'vitest'

import { diffBranchSelection } from './branch-steps'
import { runGitCommand } from './git-utils'

// Every git call still runs; the spy only records the arguments, so the one
// made on the throwaway index copy can be read back.
vi.mock('./git-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-utils')>()
  return { ...actual, runGitCommand: vi.fn(actual.runGitCommand) }
})

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
    },
  })
}

test('the intent-to-add on the index copy runs without preloading the index', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sprintengine-steps-preload-'))
  try {
    gitIn(dir, 'init', '-b', 'main')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const one = 1\nexport const two = 2\n')
    gitIn(dir, 'add', '.')
    gitIn(dir, 'commit', '-m', 'seed')
    renameSync(join(dir, 'src', 'a.ts'), join(dir, 'src', 'b.ts'))

    const diff = await diffBranchSelection(dir, { kind: 'uncommitted' })
    assert.equal(diff.files.find((file) => file.path === 'src/b.ts')?.status, 'renamed')

    const calls = vi.mocked(runGitCommand).mock.calls
    const add = calls.find(([, args]) => args.includes('--intent-to-add'))
    assert.ok(add, 'the move is paired through an intent-to-add on the copy')
    assert.equal(add[2]?.GIT_INDEX_FILE !== undefined, true, 'the add runs on the index copy')
    assert.ok(add[1].join(' ').includes('-c core.preloadIndex=false'))
    const others = calls.filter(([, args]) => args !== add[1] && args.includes('core.preloadIndex=false'))
    assert.deepEqual(others, [], 'only the add on the copy turns preloading off')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
