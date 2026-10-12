import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import type { PullRequestTextRequest, PullRequestTextResult } from '../../shared/text-generation/contract'
import type { PullRequestCreator } from '../pull-request-create'
import { registerPullRequestCreateIpc } from './pull-request-create-ipc'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

// Closing the "Create PR" dialog while its draft is being written stops the
// drafting CLI: the cancel channel aborts the signal the draft runs under.

test('cancelling a draft by its id aborts the drafting run', async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, input: unknown) => unknown) => handlers.set(channel, fn),
  }
  let seen: AbortSignal | undefined
  const creator = {
    draftInput: async () => ({
      ok: true,
      input: {
        base: 'main',
        head: 'feature/marks',
        commits: '',
        diffStat: '',
        patch: '',
        template: null,
        conventionalCommits: false,
      },
    }),
  } as unknown as PullRequestCreator
  registerPullRequestCreateIpc(ipcMain as unknown as Parameters<typeof registerPullRequestCreateIpc>[0], {
    creator,
    generate: (request: PullRequestTextRequest) =>
      new Promise<PullRequestTextResult>((resolve) => {
        seen = request.signal
        request.signal?.addEventListener('abort', () =>
          resolve({ ok: false, code: 'cancelled', message: 'claude-code was stopped.' }),
        )
      }),
  })
  const draft = handlers.get('pull-request-create:draft')
  const cancel = handlers.get('pull-request-create:draft-cancel')
  assert.ok(draft && cancel, 'both channels are registered')
  const running = draft(
    {},
    {
      cwd: '/Users/dev/app',
      draftId: 'draft-1',
      engine: { cli: 'claude-code', model: 'claude-haiku-4-5' },
    },
  ) as Promise<PullRequestTextResult>
  await vi.waitFor(() => assert.ok(seen))
  await cancel({}, 'draft-1')
  assert.equal(seen?.aborted, true)
  assert.deepEqual(await running, { ok: false, code: 'cancelled', message: 'claude-code was stopped.' })
})

test("the draft is written in the person's writing style, and in the default one when none is sent", async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
  const ipcMain = {
    handle: (channel: string, fn: (event: unknown, input: unknown) => unknown) => handlers.set(channel, fn),
  }
  const styles: unknown[] = []
  const creator = {
    draftInput: async () => ({
      ok: true,
      input: {
        base: 'main',
        head: 'feature/marks',
        commits: '',
        diffStat: '',
        patch: '',
        template: null,
        conventionalCommits: true,
      },
    }),
  } as unknown as PullRequestCreator
  registerPullRequestCreateIpc(ipcMain as unknown as Parameters<typeof registerPullRequestCreateIpc>[0], {
    creator,
    generate: async (request: PullRequestTextRequest) => {
      styles.push(request.input.style)
      return { ok: true, value: { title: 'feat: marks', body: '' }, ms: 1 }
    },
  })
  const draft = handlers.get('pull-request-create:draft')
  assert.ok(draft)
  const engine = { cli: 'claude-code', model: 'claude-haiku-4-5' }
  await draft({}, { cwd: '/Users/dev/app', engine, writingStyle: { mode: 'conventional', instructions: '' } })
  await draft({}, { cwd: '/Users/dev/app', engine })
  assert.deepEqual(styles, [
    { mode: 'conventional', instructions: '' },
    { mode: 'repository', instructions: '' },
  ])
})
