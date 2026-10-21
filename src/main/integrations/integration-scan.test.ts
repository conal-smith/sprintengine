import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { scanGitIntegrations } from './integration-scan'
import { LEGACY_SHARED_EXCLUDE_LINES } from './worktree-exclude'

// A repository whose shared exclude file still carries the pair an earlier
// build appended, with a subfolder a workspace can be opened at.
async function withRepository(fn: (dir: string, repo: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sprintengine-integration-scan-'))
  try {
    const repo = join(dir, 'repo')
    execFileSync('git', ['init', '--quiet', repo])
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true })
    writeFileSync(join(repo, '.git', 'info', 'exclude'), `${LEGACY_SHARED_EXCLUDE_LINES.join('\n')}\n`)
    await fn(dir, repo)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function sharedExcludeFinds(found: Awaited<ReturnType<typeof scanGitIntegrations>>['found']): string[] {
  return found.filter((write) => write.marker === 'legacy-shared-pair').map((write) => realpathSync(write.path))
}

test('a subfolder of a repository finds the shared exclude file', async () => {
  await withRepository(async (_dir, repo) => {
    const { found } = await scanGitIntegrations({ path: join(repo, 'apps', 'web'), hostId: 'local' })
    assert.deepEqual(sharedExcludeFinds(found), [realpathSync(join(repo, '.git', 'info', 'exclude'))])
  })
})

test('a subfolder reached through a symlink finds the shared exclude file', async () => {
  await withRepository(async (dir, repo) => {
    const link = join(dir, 'web-link')
    symlinkSync(join(repo, 'apps', 'web'), link)
    const { found } = await scanGitIntegrations({ path: link, hostId: 'local' })
    assert.deepEqual(sharedExcludeFinds(found), [realpathSync(join(repo, '.git', 'info', 'exclude'))])
  })
})
