import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'

import type { WorktreeDependencyInstallView } from '../../../../../shared/electron-api'
import { useToastStore } from '../../../store/toastStore'

const published = vi.hoisted(() => ({ diagnostics: [] as Array<Record<string, unknown>> }))
vi.mock('../../../utils/diagnostics', () => ({
  publishDiagnosticSync: (entry: Record<string, unknown>) => published.diagnostics.push(entry),
}))

const { showWorktreeInstallToast } = await import('./worktreeInstallToast')

const RUNNING: WorktreeDependencyInstallView = {
  id: 'install-1',
  repoRoot: '/Users/dev/app',
  path: '/Users/dev/.sprintengine-worktrees/app/pool-03',
  branch: 'agent/fix-login',
  command: 'npm ci',
  reason: 'changed',
  state: 'running',
  startedAt: 1_000,
  endedAt: null,
  lastLine: null,
  output: null,
  exitCode: null,
}

const toast = () => useToastStore.getState().toasts.find((entry) => entry.id === 'worktree-install:install-1')

beforeEach(() => {
  useToastStore.setState({ toasts: [] })
  published.diagnostics.length = 0
})

test('a running install is one toast that stays, and its progress does not bring it back once dismissed', () => {
  showWorktreeInstallToast(RUNNING, { report: true })
  assert.equal(toast()?.title, 'Installing dependencies')
  assert.equal(toast()?.description, 'npm ci in pool-03: the lockfile changed. The agent starts when it finishes.')
  assert.equal(toast()?.autoDismissMs, false)

  useToastStore.getState().dismissToast('worktree-install:install-1')
  showWorktreeInstallToast({ ...RUNNING, lastLine: 'added 12 packages' }, { report: true })
  assert.equal(toast(), undefined)

  showWorktreeInstallToast({ ...RUNNING, state: 'succeeded', endedAt: 43_000, exitCode: 0 }, { report: true })
  assert.equal(toast()?.title, 'Dependencies installed')
  assert.equal(toast()?.description, 'npm ci in pool-03, 42 s.')
  assert.equal(published.diagnostics.length, 0, 'a success is no bell row')
})

test('a failed install says so in the toast, and one window files what it printed in the bell', () => {
  const failed = { ...RUNNING, state: 'failed' as const, endedAt: 5_000, exitCode: 1, output: 'npm ERR! code E401' }
  showWorktreeInstallToast(failed, { report: false })
  assert.equal(toast()?.title, 'Dependencies did not install')
  assert.equal(toast()?.tone, 'warn')
  assert.match(toast()?.description ?? '', /exit code 1\)\. The agent started anyway/)
  assert.equal(published.diagnostics.length, 0, 'not the reporting window')

  showWorktreeInstallToast(failed, { report: true })
  assert.equal(published.diagnostics.length, 1)
  assert.equal(published.diagnostics[0].details, 'npm ERR! code E401')
  assert.deepEqual(published.diagnostics[0].navigationTarget, { kind: 'settings', ref: 'worktrees' })
})

test('an install its chat shows is not toasted while it runs or once it succeeds, only if it fails', () => {
  const quiet = { ...RUNNING, quiet: true }
  showWorktreeInstallToast(quiet, { report: true })
  assert.equal(toast(), undefined)
  showWorktreeInstallToast({ ...quiet, state: 'succeeded', endedAt: 4_000, exitCode: 0 }, { report: true })
  assert.equal(toast(), undefined)
  showWorktreeInstallToast({ ...quiet, state: 'failed', endedAt: 4_000, exitCode: 1 }, { report: true })
  assert.equal(toast()?.title, 'Dependencies did not install')
  assert.equal(published.diagnostics.length, 1)
})
