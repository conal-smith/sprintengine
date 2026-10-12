import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, test, vi } from 'vitest'

import type { CommitMessageResult } from '../../../../../shared/text-generation/contract'
import { commitMessageDraftUnavailableReason, runCommitMessageDraft } from './commitMessageDraft'

// "Write commit message": when it can draft, and what a draft does to the box
// — fills an empty one, asks before replacing a written one, and leaves it as
// it was when the draft fails, is stopped, or lands after the panel moved on.

const ENGINE = { cli: 'claude-code', model: 'claude-haiku-4-5' }
const READY = {
  canDraft: true,
  repoRoot: '/Users/dev/app',
  textGenerationEnabled: true,
  engine: ENGINE,
  hasStaged: true,
}
const DRAFTED: CommitMessageResult = {
  ok: true,
  value: { subject: 'fix: keep the marks', body: 'Why.', message: 'fix: keep the marks\n\nWhy.' },
  ms: 1,
}

function box(initial: string) {
  let text = initial
  const asked: string[] = []
  return {
    get text() {
      return text
    },
    asked,
    current: () => text,
    fill: (next: string) => {
      text = next
    },
    confirm: (answer: boolean) => async () => {
      asked.push(text)
      return answer
    },
  }
}

// ── When it can draft ─────────────────────────────────────────────────────────

test('ready: something checked, text generation on, a CLI to run it', () => {
  assert.equal(commitMessageDraftUnavailableReason(READY), null)
})

test('nothing checked says to check the files first', () => {
  assert.equal(commitMessageDraftUnavailableReason({ ...READY, hasStaged: false }), 'check the files to commit first')
})

test('text generation off says where to turn it on, ahead of the files', () => {
  assert.equal(
    commitMessageDraftUnavailableReason({ ...READY, textGenerationEnabled: false, hasStaged: false }),
    'text generation is off in Settings → Agents',
  )
})

test('no supported CLI says which ones would do', () => {
  assert.equal(commitMessageDraftUnavailableReason({ ...READY, engine: null }), 'needs Claude Code or Codex installed')
})

test('a checkout on an SSH machine, or a window with no CLI of its own, cannot draft', () => {
  assert.equal(
    commitMessageDraftUnavailableReason({ ...READY, repoRoot: 'ssh://build-box/home/dev/app' }),
    'not available for a checkout on another machine',
  )
  assert.equal(commitMessageDraftUnavailableReason({ ...READY, canDraft: false }), 'available in the desktop app')
  assert.equal(commitMessageDraftUnavailableReason({ ...READY, repoRoot: null }), 'no repository here')
})

// ── What a draft does to the box ─────────────────────────────────────────────

test('an empty box is filled without asking', async () => {
  const message = box('  ')
  const outcome = await runCommitMessageDraft({
    current: message.current,
    confirmReplace: message.confirm(true),
    request: async () => DRAFTED,
    stillCurrent: () => true,
    fill: message.fill,
  })
  assert.deepEqual(outcome, { kind: 'filled', message: 'fix: keep the marks\n\nWhy.' })
  assert.equal(message.text, 'fix: keep the marks\n\nWhy.')
  assert.deepEqual(message.asked, [])
})

test('a written message is asked about first, and kept when the person says so, with no CLI run', async () => {
  const message = box('My own words')
  let requested = false
  const outcome = await runCommitMessageDraft({
    current: message.current,
    confirmReplace: message.confirm(false),
    request: async () => {
      requested = true
      return DRAFTED
    },
    stillCurrent: () => true,
    fill: message.fill,
  })
  assert.deepEqual(outcome, { kind: 'kept' })
  assert.equal(message.text, 'My own words')
  assert.deepEqual(message.asked, ['My own words'])
  assert.equal(requested, false)
})

test('a written message is replaced when the person agrees', async () => {
  const message = box('My own words')
  const outcome = await runCommitMessageDraft({
    current: message.current,
    confirmReplace: message.confirm(true),
    request: async () => DRAFTED,
    stillCurrent: () => true,
    fill: message.fill,
  })
  assert.equal(outcome.kind, 'filled')
  assert.equal(message.text, 'fix: keep the marks\n\nWhy.')
})

test('a failure keeps what the person had and says why', async () => {
  const message = box('My own words')
  const outcome = await runCommitMessageDraft({
    current: message.current,
    confirmReplace: message.confirm(true),
    request: async () => ({ ok: false, code: 'timeout', message: 'claude-code did not answer in time.' }),
    stillCurrent: () => true,
    fill: message.fill,
  })
  assert.deepEqual(outcome, { kind: 'failed', reason: 'claude-code did not answer in time.' })
  assert.equal(message.text, 'My own words')
})

test('a bridge that throws is a failure in words, not an unhandled rejection', async () => {
  const message = box('')
  const outcome = await runCommitMessageDraft({
    current: message.current,
    confirmReplace: message.confirm(true),
    request: async () => {
      throw new Error('No handler registered for commit-message:draft')
    },
    stillCurrent: () => true,
    fill: message.fill,
  })
  assert.deepEqual(outcome, { kind: 'failed', reason: 'No handler registered for commit-message:draft' })
  assert.equal(message.text, '')
})

test('a stopped draft leaves the box alone', async () => {
  const message = box('')
  const outcome = await runCommitMessageDraft({
    current: message.current,
    confirmReplace: message.confirm(true),
    request: async () => ({ ok: false, code: 'cancelled', message: 'claude-code was stopped.' }),
    stillCurrent: () => true,
    fill: message.fill,
  })
  assert.deepEqual(outcome, { kind: 'stopped' })
  assert.equal(message.text, '')
})

test('an answer that lands after the panel moved to another checkout is dropped', async () => {
  const message = box('')
  let current = true
  const outcome = await runCommitMessageDraft({
    current: message.current,
    confirmReplace: message.confirm(true),
    request: async () => {
      current = false
      return DRAFTED
    },
    stillCurrent: () => current,
    fill: message.fill,
  })
  assert.deepEqual(outcome, { kind: 'stale' })
  assert.equal(message.text, '')
})

// ── The panel's hook, end to end over a stand-in bridge ──────────────────────

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const previous = Object.getOwnPropertyDescriptors(globalThis)
const GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
]

beforeAll(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
})

afterAll(() => {
  dom.window.close()
  for (const key of GLOBALS) {
    if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
    else Reflect.deleteProperty(globalThis, key)
  }
})

test('the hook drafts with the stored style and engine, says it is working, and fills the box', async () => {
  const requests: unknown[] = []
  let answer: (result: CommitMessageResult) => void = () => {}
  ;(dom.window as unknown as { api: unknown }).api = {
    draftCommitMessage: (request: unknown) => {
      requests.push(request)
      return new Promise<CommitMessageResult>((resolve) => (answer = resolve))
    },
    cancelCommitMessageDraft: async () => undefined,
  }
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.setState((state) => ({
    ...state,
    appSettings: {
      ...state.appSettings,
      textGeneration: {
        enabled: true,
        engine: { cli: 'claude-code', model: '' },
        writingStyle: { mode: 'conventional', instructions: '' },
      },
    },
    pluginCatalogEntries: [{ id: 'claude-code' }] as never,
  }))
  const { act, useEffect } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useCommitMessageDraft } = await import('./commitMessageDraft')

  let message = ''
  const reports: Array<string | null> = []
  const seen: Array<{ drafting: boolean; unavailableReason: string | null }> = []
  let control: ReturnType<typeof useCommitMessageDraft> | null = null
  function Harness({ hasStaged }: { hasStaged: boolean }) {
    const draft = useCommitMessageDraft({
      repoRoot: '/Users/dev/app',
      scopeKey: 'main',
      hasStaged,
      readMessage: () => message,
      writeMessage: (text) => {
        message = text
      },
      confirmReplace: async () => true,
      report: (next) => reports.push(next?.text ?? null),
      focusMessage: () => {},
    })
    control = draft
    useEffect(() => {
      seen.push({ drafting: draft.drafting, unavailableReason: draft.unavailableReason })
    })
    return null
  }
  const container = dom.window.document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(<Harness hasStaged={false} />))
  assert.equal(seen.at(-1)?.unavailableReason, 'check the files to commit first')
  await act(async () => root.render(<Harness hasStaged />))
  assert.equal(seen.at(-1)?.unavailableReason, null)

  await act(async () => control?.start())
  assert.equal(seen.at(-1)?.drafting, true, 'busy while it runs')
  assert.deepEqual(reports, ['Writing a commit message from the staged changes…'])
  assert.deepEqual(requests, [
    {
      repoRoot: '/Users/dev/app',
      engine: { cli: 'claude-code', model: 'claude-haiku-4-5', reasoning: 'low' },
      draftId: (requests[0] as { draftId: string }).draftId,
      writingStyle: { mode: 'conventional', instructions: '' },
      cliRuntimes: useWorkspaceStore.getState().appSettings.cliRuntimes,
    },
  ])

  await act(async () => answer(DRAFTED))
  await vi.waitFor(() => assert.equal(seen.at(-1)?.drafting, false))
  assert.equal(message, 'fix: keep the marks\n\nWhy.')
  assert.equal(reports.at(-1), 'Drafted a commit message. Edit it before you commit.')
  await act(async () => root.unmount())
})

test('the hook stops a running draft by its id when asked, and when the panel moves on', async () => {
  const cancelled: string[] = []
  const ids: string[] = []
  ;(dom.window as unknown as { api: unknown }).api = {
    draftCommitMessage: (request: { draftId: string }) => {
      ids.push(request.draftId)
      return new Promise<CommitMessageResult>(() => {})
    },
    cancelCommitMessageDraft: async (draftId: string) => {
      cancelled.push(draftId)
    },
  }
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useCommitMessageDraft } = await import('./commitMessageDraft')
  let control: ReturnType<typeof useCommitMessageDraft> | null = null
  function Harness({ scopeKey }: { scopeKey: string }) {
    control = useCommitMessageDraft({
      repoRoot: '/Users/dev/app',
      scopeKey,
      hasStaged: true,
      readMessage: () => '',
      writeMessage: () => {},
      confirmReplace: async () => true,
      report: () => {},
      focusMessage: () => {},
    })
    return null
  }
  const container = dom.window.document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(<Harness scopeKey="main" />))
  await act(async () => control?.start())
  await act(async () => control?.stop())
  assert.deepEqual(cancelled, [ids[0]])
  await act(async () => root.render(<Harness scopeKey="worktree:/Users/dev/app-feature" />))
  assert.deepEqual(cancelled, [ids[0], ids[0]], 'a new checkout ends the draft that was for the old one')
  assert.equal(control!.drafting, false)
  await act(async () => root.unmount())
})
