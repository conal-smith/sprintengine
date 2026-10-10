import { JSDOM } from 'jsdom'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BranchPullRequest } from '../../../../../shared/git/pull-request'

// The open chat's "Open PR" button on the composer's strip (owner ruling
// 2026-10-04): what it says for each state, that it is drawn only for a
// conversation that opened a pull request, and that it opens the pull request
// in the browser.

const NOW = Date.parse('2026-10-04T12:00:00.000Z')

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
const previous = Object.getOwnPropertyDescriptors(globalThis)
const opened: string[] = []
const GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
]

beforeAll(() => {
  ;(dom.window as unknown as { api: unknown }).api = {
    openExternal: async (url: string) => {
      opened.push(url)
    },
  }
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
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

function pr(overrides: Partial<BranchPullRequest> & { number: number }): BranchPullRequest {
  return {
    url: `https://github.com/acme/app/pull/${overrides.number}`,
    repoKey: 'github.com/acme/app',
    repoName: 'app',
    title: `Change ${overrides.number}`,
    state: 'open',
    isDraft: false,
    openedAt: NOW - 3_600_000 + overrides.number,
    stateAt: NOW,
    ...overrides,
  }
}

async function mount(node: React.ReactNode) {
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(node))
  return {
    container,
    act,
    async unmount() {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

test('the words carry the state, and a pull request closed unmerged is left off as the sidebar leaves it off', async () => {
  const { stripPullRequestCopy } = await import('../../workspace/PullRequestMark')
  const text = (list: BranchPullRequest[]) => stripPullRequestCopy(list, NOW)?.text ?? null
  expect(text([])).toBe(null)
  expect(text([pr({ number: 12 })])).toBe('Open PR #12')
  expect(text([pr({ number: 12, isDraft: true })])).toBe('Open draft PR #12')
  expect(text([pr({ number: 12, state: 'merged' })])).toBe('Merged PR #12')
  expect(text([pr({ number: 12, state: 'closed' })])).toBe(null)
  expect(
    text([
      pr({
        number: 5,
        url: 'https://gitlab.com/acme/app/-/merge_requests/5',
        repoKey: 'gitlab.com/acme/app',
        forge: 'gitlab',
      }),
    ]),
  ).toBe('Opened PR #5')
  // The mark's own pull request: the newest still open beats a newer merged one.
  expect(text([pr({ number: 9, state: 'merged', openedAt: NOW }), pr({ number: 8, openedAt: NOW - 1 })])).toBe(
    'Open PR #8',
  )
  // Several repositories: the button says which.
  expect(
    text([
      pr({ number: 3, openedAt: NOW }),
      pr({ number: 4, url: 'https://github.com/acme/site/pull/4', repoKey: 'github.com/acme/site', repoName: 'site' }),
    ]),
  ).toBe('Open PR app #3')
})

test('the strip draws the button only for a conversation that opened a pull request, and it opens it', async () => {
  const { ConversationComposerStrip } = await import('./conversationStrip')
  const none = await mount(
    <ConversationComposerStrip machine={null} branch={null} changes={null} context={null} now={NOW} />,
  )
  expect(none.container.innerHTML).toBe('')
  await none.unmount()

  const closedOnly = await mount(
    <ConversationComposerStrip
      machine={null}
      branch={null}
      changes={null}
      context={null}
      pullRequests={[pr({ number: 2, state: 'closed' })]}
      now={NOW}
    />,
  )
  expect(closedOnly.container.querySelector('[data-strip-pull-request]')).toBe(null)
  await closedOnly.unmount()

  const one = await mount(
    <ConversationComposerStrip
      machine={null}
      branch={{ name: 'feature/marks', worktree: false, onOpen: null }}
      changes={null}
      context={{ used: 40_000, total: 200_000 }}
      pullRequests={[pr({ number: 12 })]}
      now={NOW}
    />,
  )
  const button = one.container.querySelector<HTMLButtonElement>('[data-strip-pull-request]')
  expect(button?.textContent).toContain('Open PR #12')
  expect(button?.getAttribute('aria-label')).toMatch(
    /^Open PR #12\. Pull request 12, open: Change 12\. Open it on GitHub$/,
  )
  // The button sits before the ring, at the strip's right end.
  const slots = [...one.container.querySelectorAll('[data-strip-pull-request-slot], [data-strip-context]')]
  expect(slots.map((slot) => slot.hasAttribute('data-strip-context'))).toEqual([false, true])
  await one.act(async () => button?.click())
  expect(opened).toEqual(['https://github.com/acme/app/pull/12'])
  await one.unmount()
})

test('one slot: an open pull request wins, then Create PR, then a merged one', async () => {
  const { pullRequestSlotChoice } = await import('./createPullRequest')
  expect(pullRequestSlotChoice([pr({ number: 1 })], true)).toBe('open')
  expect(pullRequestSlotChoice([pr({ number: 1, isDraft: true })], true)).toBe('open')
  expect(pullRequestSlotChoice([pr({ number: 1, state: 'merged' })], true)).toBe('create')
  expect(pullRequestSlotChoice([pr({ number: 1, state: 'merged' })], false)).toBe('merged')
  expect(pullRequestSlotChoice([pr({ number: 1, state: 'closed' })], false)).toBe(null)
  expect(pullRequestSlotChoice([], true)).toBe('create')
  expect(pullRequestSlotChoice([], false)).toBe(null)
})

test('Create PR takes the slot, drafts, pushes, creates, and says on the strip why it could not finish', async () => {
  const calls: string[] = []
  const api = (dom.window as unknown as { api: Record<string, unknown> }).api
  Object.assign(api, {
    draftPullRequestText: async () => {
      calls.push('draft')
      return { ok: true, value: { title: 'feat: marks', body: 'Body' }, ms: 1 }
    },
    pushForPullRequest: async () => {
      calls.push('push')
      return { ok: true, pushed: true }
    },
    createPullRequest: async (input: { title: string }) => {
      calls.push(`create:${input.title}`)
      return { ok: true, kind: 'created', url: 'https://github.com/acme/app/pull/40' }
    },
  })
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.setState((state) => ({
    ...state,
    appSettings: { ...state.appSettings, textGeneration: { enabled: true, engine: { cli: 'claude-code', model: '' } } },
    pluginCatalogEntries: [{ id: 'claude-code' }] as never,
  }))
  const { ConversationComposerStrip } = await import('./conversationStrip')
  let settled = 0
  const holds: boolean[] = []
  const mounted = await mount(
    <ConversationComposerStrip
      machine={null}
      branch={{ name: 'feature/marks', worktree: false, onOpen: null }}
      changes={null}
      context={null}
      pullRequests={[pr({ number: 2, state: 'merged' })]}
      createPullRequest={{
        cwd: '/Users/dev/app',
        conversation: { workspaceId: 'ws-1', agentId: 'agent-1' },
        onSettled: () => (settled += 1),
        onHoldChange: (held) => holds.push(held),
      }}
      now={NOW}
    />,
  )
  expect(mounted.container.querySelector('[data-strip-pull-request]')).toBe(null)
  const button = [...mounted.container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Create PR'),
  )
  expect(button?.getAttribute('aria-label')).toBe('Create a pull request from this branch')
  await mounted.act(async () => button?.click())
  // The confirm step shows the draft, editable, before anything is sent.
  const title = await waitFor(() => dom.window.document.querySelector<HTMLInputElement>('input[maxlength="300"]'))
  await waitFor(() => (title.value === 'feat: marks' ? title : null))
  expect(calls).toEqual(['draft'])
  const create = [...dom.window.document.querySelectorAll('button')].find((node) => node.textContent === 'Create')
  await mounted.act(async () => create?.click())
  // No Studio here to record it: the strip says so, with the pull request's address.
  const error = await waitFor(() => mounted.container.querySelector('[data-create-pull-request-error]'))
  expect(calls).toEqual(['draft', 'push', 'create:feat: marks'])
  expect(error.textContent).toContain('https://github.com/acme/app/pull/40')
  expect(settled).toBe(1)
  // The failure holds the slot: the pull request now exists, so the checkout
  // stops reading as ready, and the control must stay to say what happened.
  expect(holds.at(-1)).toBe(true)
  await mounted.unmount()
  expect(holds.at(-1)).toBe(false)
})

test('a held Create PR failure on a checkout no longer ready is dismissed, not retried', async () => {
  const api = (dom.window as unknown as { api: Record<string, unknown> }).api
  Object.assign(api, {
    draftPullRequestText: async () => ({ ok: true, value: { title: 'feat: marks', body: 'Body' }, ms: 1 }),
    pushForPullRequest: async () => ({ ok: false, message: 'The push was refused.' }),
  })
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.setState((state) => ({
    ...state,
    appSettings: { ...state.appSettings, textGeneration: { enabled: true, engine: { cli: 'claude-code', model: '' } } },
    pluginCatalogEntries: [{ id: 'claude-code' }] as never,
  }))
  const { CreatePullRequestControl } = await import('./createPullRequest')
  const holds: boolean[] = []
  const props = {
    cwd: '/Users/dev/app',
    conversation: { workspaceId: 'ws-1', agentId: 'agent-1' },
    onSettled: () => {},
    onHoldChange: (held: boolean) => holds.push(held),
  }
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(<CreatePullRequestControl {...props} ready />))
  const buttonNamed = (text: string) =>
    [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text))
  await act(async () => buttonNamed('Create PR')?.click())
  const title = await waitFor(() => dom.window.document.querySelector<HTMLInputElement>('input[maxlength="300"]'))
  await waitFor(() => (title.value === 'feat: marks' ? title : null))
  const create = [...dom.window.document.querySelectorAll('button')].find((node) => node.textContent === 'Create')
  await act(async () => create?.click())
  await waitFor(() => container.querySelector('[data-create-pull-request-error]'))
  // Still ready: the failure stays beside Create PR, which tries again.
  expect(buttonNamed('Create PR')).toBeTruthy()
  // No longer ready: Create PR could only fail, so the failure is dismissed.
  await act(async () => root.render(<CreatePullRequestControl {...props} ready={false} />))
  expect(buttonNamed('Create PR')).toBe(undefined)
  await act(async () => buttonNamed('Dismiss')?.click())
  expect(container.querySelector('[data-create-pull-request-error]')).toBe(null)
  // The slot goes back to what the checkout says.
  expect(holds.at(-1)).toBe(false)
  await act(async () => root.unmount())
  container.remove()
})

test('a pull request the branch already had is opened, not claimed for this chat', async () => {
  const pins: unknown[] = []
  const api = (dom.window as unknown as { api: Record<string, unknown> }).api
  Object.assign(api, {
    draftPullRequestText: async () => ({ ok: true, value: { title: 'feat: marks', body: 'Body' }, ms: 1 }),
    // The branch and commit the dialog opens on ride the push and the creation.
    createPullRequestState: async () => ({ branch: 'feature/marks', headSha: 'abc1234def' }),
    pushForPullRequest: async (_cwd: string, pin: unknown) => {
      pins.push(pin)
      return { ok: true, pushed: false }
    },
    createPullRequest: async (input: { pin?: unknown }) => {
      pins.push(input.pin)
      return { ok: true, kind: 'existing', url: 'https://github.com/acme/app/pull/41' }
    },
  })
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.setState((state) => ({
    ...state,
    appSettings: { ...state.appSettings, textGeneration: { enabled: true, engine: { cli: 'claude-code', model: '' } } },
    pluginCatalogEntries: [{ id: 'claude-code' }] as never,
  }))
  const { CreatePullRequestControl } = await import('./createPullRequest')
  let settled = 0
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <CreatePullRequestControl
        cwd="/Users/dev/app"
        conversation={{ workspaceId: 'ws-1', agentId: 'agent-1' }}
        onSettled={() => (settled += 1)}
        ready
      />,
    ),
  )
  const buttonNamed = (text: string) =>
    [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text))
  await act(async () => buttonNamed('Create PR')?.click())
  const title = await waitFor(() => dom.window.document.querySelector<HTMLInputElement>('input[maxlength="300"]'))
  await waitFor(() => (title.value === 'feat: marks' ? title : null))
  const create = [...dom.window.document.querySelectorAll('button')].find((node) => node.textContent === 'Create')
  await act(async () => create?.click())
  await waitFor(() => (settled > 0 ? true : null))
  expect(opened).toContain('https://github.com/acme/app/pull/41')
  const pin = { branch: 'feature/marks', headSha: 'abc1234def' }
  expect(pins).toEqual([pin, pin])
  // Nothing was recorded, so there is no failure to record it either.
  expect(container.querySelector('[data-create-pull-request-error]')).toBe(null)
  await act(async () => root.unmount())
  container.remove()
})

test('the confirm step says how many uncommitted changes the pull request leaves out, and still creates', async () => {
  const calls: string[] = []
  const api = (dom.window as unknown as { api: Record<string, unknown> }).api
  Object.assign(api, {
    draftPullRequestText: async () => ({ ok: true, value: { title: 'feat: marks', body: 'Body' }, ms: 1 }),
    createPullRequestState: async () => ({ branch: 'feature/marks', headSha: 'abc1234def', uncommittedChanges: 3 }),
    pushForPullRequest: async () => {
      calls.push('push')
      return { ok: true, pushed: true }
    },
    createPullRequest: async () => {
      calls.push('create')
      return { ok: true, kind: 'existing', url: 'https://github.com/acme/app/pull/42' }
    },
  })
  const { useWorkspaceStore } = await import('../../../store/workspaceStore')
  useWorkspaceStore.setState((state) => ({
    ...state,
    appSettings: { ...state.appSettings, textGeneration: { enabled: true, engine: { cli: 'claude-code', model: '' } } },
    pluginCatalogEntries: [{ id: 'claude-code' }] as never,
  }))
  const { CreatePullRequestControl } = await import('./createPullRequest')
  let settled = 0
  const mounted = await mount(
    <CreatePullRequestControl
      cwd="/Users/dev/app"
      conversation={{ workspaceId: 'ws-1', agentId: 'agent-1' }}
      onSettled={() => (settled += 1)}
      ready
    />,
  )
  const button = [...mounted.container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Create PR'),
  )
  await mounted.act(async () => button?.click())
  const note = await waitFor(() => dom.window.document.querySelector('[data-create-pull-request-uncommitted]'))
  expect(note.textContent).toBe('3 uncommitted changes won’t be included: only the branch’s commits are pushed.')
  const title = await waitFor(() => dom.window.document.querySelector<HTMLInputElement>('input[maxlength="300"]'))
  await waitFor(() => (title.value === 'feat: marks' ? title : null))
  const create = [...dom.window.document.querySelectorAll('button')].find((node) => node.textContent === 'Create')
  expect(create?.disabled).toBe(false)
  await mounted.act(async () => create?.click())
  await waitFor(() => (settled > 0 ? true : null))
  expect(calls).toEqual(['push', 'create'])
  await mounted.unmount()
})

test('one uncommitted change is said in the singular', async () => {
  const { uncommittedNote } = await import('./createPullRequest')
  expect(uncommittedNote(1)).toBe('1 uncommitted change won’t be included: only the branch’s commits are pushed.')
})

async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (value) return value
    if (Date.now() - start > 3_000) throw new Error('timed out')
    const { act } = await import('react')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}
