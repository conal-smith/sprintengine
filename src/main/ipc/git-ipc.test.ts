import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { afterAll, test } from 'vitest'

import { setAgentWorktreeLockProfile } from '../agent-worktree-lock'
import { worktreeLeases } from '../worktree-leases'
import { registerGitIpc } from './git-ipc'

const scratch: string[] = []

afterAll(async () => {
  setAgentWorktreeLockProfile(null)
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })))
})

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

// A window bringing a chat's worktree back is a start like a turn's: it holds
// the path shared, so a return or removal of it waits its turn.
test('a window’s restore of a worktree waits for a removal of its path under way, holding it shared', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'git-ipc-'))
  scratch.push(userDataDir)
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }
  registerGitIpc(
    ipcMain as unknown as IpcMain,
    { enabled: false, logMainPerfEvent: () => undefined, withIpcDiagnostics: (_scope, _name, _details, run) => run() },
    { userDataDir },
  )
  const restore = handlers.get('git:worktree:restore')
  assert.ok(restore)
  // Not one of the app's worktrees, so the restore itself refuses at once.
  const path = join(userDataDir, 'elsewhere', 'app-01')
  const removing = await worktreeLeases.tryExclusive(path, 'this worktree is being removed')
  assert.ok('release' in removing)
  let done = false
  const restoring = restore({}, { repoRoot: userDataDir, path, branchName: 'agent/app' }).finally(() => (done = true))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(done, false, 'waits while the removal runs')
  assert.deepEqual(
    (await worktreeLeases.holders(path)).map(({ kind, reason, waiting }) => ({ kind, reason, waiting })),
    [
      { kind: 'exclusive', reason: 'this worktree is being removed', waiting: false },
      { kind: 'shared', reason: 'its chat is bringing it back', waiting: true },
    ],
  )
  removing.release()
  const restored = (await restoring) as { ok: boolean; message?: string }
  assert.equal(restored.ok, false)
  assert.match(restored.message ?? '', /not one of the app's worktrees/)
  assert.deepEqual(await worktreeLeases.holders(path), [], 'let go once it is done')
})
