import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import type { CommitMessageRequest, CommitMessageResult } from '../../shared/text-generation/contract'
import type { TextGenerationWritingStyle } from '../../shared/text-generation/writing-style'
import type { CommitMessageDraftInputOutcome } from '../commit-message-draft'
import { registerCommitMessageIpc, type CommitMessageIpcDeps } from './commit-message-ipc'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

// The Git panel's "Write commit message", over IPC: the window names the
// checkout, the engine and the style; main reads the staged changes and runs
// the drafting CLI; stopping the draft by its id stops the CLI.

type Handler = (event: unknown, input: unknown) => unknown

const ENGINE = { cli: 'claude-code', model: 'claude-haiku-4-5' }
const DRAFTED: CommitMessageResult = {
  ok: true,
  value: { subject: 'fix: keep the marks', body: '', message: 'fix: keep the marks' },
  ms: 1,
}

function gathered(style: TextGenerationWritingStyle): CommitMessageDraftInputOutcome {
  return {
    ok: true,
    input: {
      branch: 'feature/marks',
      diffStat: ' a.ts | 1 +',
      patch: '+a',
      recentSubjects: [],
      conventionalCommits: false,
      style,
    },
  }
}

function register(deps: CommitMessageIpcDeps): { draft: Handler; cancel: Handler } {
  const handlers = new Map<string, Handler>()
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }
  registerCommitMessageIpc(ipcMain as unknown as Parameters<typeof registerCommitMessageIpc>[0], deps)
  const draft = handlers.get('commit-message:draft')
  const cancel = handlers.get('commit-message:draft-cancel')
  assert.ok(draft && cancel, 'both channels are registered')
  return { draft, cancel }
}

test('a draft reads the checkout with the style the window sent, and answers with the message', async () => {
  const seen: Array<{ repoRoot: string; style: TextGenerationWritingStyle }> = []
  const requests: CommitMessageRequest[] = []
  const { draft } = register({
    gather: async (repoRoot, style) => {
      seen.push({ repoRoot, style })
      return gathered(style)
    },
    generate: async (request) => {
      requests.push(request)
      return DRAFTED
    },
  })
  const result = await draft(
    {},
    {
      repoRoot: '/Users/dev/app',
      engine: ENGINE,
      cliRuntimes: { 'claude-code': { command: '/opt/claude' } },
      writingStyle: { mode: 'custom', instructions: 'Past tense.' },
    },
  )
  assert.deepEqual(result, DRAFTED)
  assert.deepEqual(seen, [{ repoRoot: '/Users/dev/app', style: { mode: 'custom', instructions: 'Past tense.' } }])
  assert.deepEqual(requests[0].engine, ENGINE)
  assert.deepEqual(requests[0].cliRuntimes, { 'claude-code': { command: '/opt/claude' } })
  assert.equal(requests[0].input.style.mode, 'custom')
})

test('a request with no style, or an unreadable one, drafts in the default style', async () => {
  const styles: TextGenerationWritingStyle[] = []
  const { draft } = register({
    gather: async (_repoRoot, style) => {
      styles.push(style)
      return gathered(style)
    },
    generate: async () => DRAFTED,
  })
  await draft({}, { repoRoot: '/Users/dev/app', engine: ENGINE })
  await draft({}, { repoRoot: '/Users/dev/app', engine: ENGINE, writingStyle: { mode: 'yaml' } })
  assert.deepEqual(styles, [
    { mode: 'repository', instructions: '' },
    { mode: 'repository', instructions: '' },
  ])
})

test('a malformed request, or a checkout that is not on this computer, is refused before git is asked', async () => {
  let asked = false
  const { draft } = register({
    gather: async (_repoRoot, style) => {
      asked = true
      return gathered(style)
    },
    generate: async () => DRAFTED,
  })
  assert.deepEqual(await draft({}, null), {
    ok: false,
    code: 'unsupported',
    message: 'Malformed commit message request.',
  })
  assert.deepEqual(await draft({}, { repoRoot: '/Users/dev/app', engine: { cli: 'codex' } }), {
    ok: false,
    code: 'unsupported',
    message: 'Malformed commit message request.',
  })
  assert.deepEqual(await draft({}, { repoRoot: 'ssh://build-box/home/dev/app', engine: ENGINE }), {
    ok: false,
    code: 'unsupported',
    message: 'Only a checkout on this computer can be read.',
  })
  assert.equal(asked, false)
})

test('nothing staged is said in words, and no CLI runs', async () => {
  let generated = false
  const { draft } = register({
    gather: async () => ({ ok: false, message: 'Nothing is staged to commit.' }),
    generate: async () => {
      generated = true
      return DRAFTED
    },
  })
  assert.deepEqual(await draft({}, { repoRoot: '/Users/dev/app', engine: ENGINE }), {
    ok: false,
    code: 'unsupported',
    message: 'Nothing is staged to commit.',
  })
  assert.equal(generated, false)
})

test('stopping a draft by its id aborts the drafting run', async () => {
  let seen: AbortSignal | undefined
  const { draft, cancel } = register({
    gather: async (_repoRoot, style) => gathered(style),
    generate: (request) =>
      new Promise<CommitMessageResult>((resolve) => {
        seen = request.signal
        request.signal?.addEventListener('abort', () =>
          resolve({ ok: false, code: 'cancelled', message: 'claude-code was stopped.' }),
        )
      }),
  })
  const running = draft(
    {},
    { repoRoot: '/Users/dev/app', engine: ENGINE, draftId: 'draft-1' },
  ) as Promise<CommitMessageResult>
  await vi.waitFor(() => assert.ok(seen))
  await cancel({}, 'draft-1')
  assert.equal(seen?.aborted, true)
  assert.deepEqual(await running, { ok: false, code: 'cancelled', message: 'claude-code was stopped.' })
})
