// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SettledChatDeletionOutcome, SettledChatDeletionPlan } from '../../../../shared/ipc/settled-chats'

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

const fixtures = vi.hoisted(() => ({
  state: {
    workspaces: [] as unknown[],
    appSettings: { modules: undefined as unknown, keepChatsWithOpenPullRequest: true },
    setWorkspaceSettled: () => {},
    setKeepChatsWithOpenPullRequest: () => {},
  },
  toasts: [] as Array<{ tone: string; title: string; description?: string }>,
}))
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: Object.assign((select: (state: typeof fixtures.state) => unknown) => select(fixtures.state), {
    getState: () => fixtures.state,
  }),
}))
vi.mock('../../store/toastStore', () => ({
  showToast: (toast: { tone: string; title: string; description?: string }) => void fixtures.toasts.push(toast),
}))

const { SettledChatsSettingsTab } = await import('./SettledChatsSettingsTab')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')

let root: Root
let host: HTMLDivElement
let previousApi: unknown
const planned: string[][] = []
const deleted: string[][] = []
let plans: (ids: string[]) => SettledChatDeletionPlan[]

beforeEach(() => {
  planned.length = 0
  deleted.length = 0
  fixtures.toasts.length = 0
  fixtures.state.workspaces = [
    { id: 'w1', name: 'Still going', mode: 'standard', folderPath: '/code/apples', createdAt: now },
    {
      id: 'w2',
      name: 'Fix the login banner',
      mode: 'standard',
      folderPath: '/code/.sprintengine-worktrees/apples/fix-login',
      createdAt: now - 10 * DAY,
      settledAt: now - 5 * DAY,
    },
    {
      id: 'w3',
      name: 'Tidy the release notes',
      mode: 'standard',
      folderPath: '/code/pears',
      createdAt: now - 10 * DAY,
      settledAt: now - DAY,
    },
    {
      id: 'w4',
      name: 'Look at the flaky test',
      mode: 'standard',
      folderPath: '/Users/dev/app',
      createdAt: now - 10 * DAY,
      settledAt: now - 2 * DAY,
      remoteOrigin: {
        connectionId: 'c1',
        machineName: 'mac-mini',
        workspaceId: 'remote-w4',
        workspaceName: 'Look at the flaky test',
        workspaceRoot: '/Users/dev/app',
      },
    },
  ]
  plans = (ids) =>
    ids.map((workspaceId) => ({
      workspaceId,
      remoteMachine: workspaceId === 'w4' ? 'mac-mini' : null,
      worktrees:
        workspaceId === 'w2'
          ? [
              {
                path: '/code/.sprintengine-worktrees/apples/fix-login',
                name: 'fix-login',
                branch: 'agent/fix-login',
                pooled: false,
                changedPaths: 0,
                unpushedCommits: 2,
                fate: 'remove' as const,
              },
            ]
          : [],
    }))
  previousApi = (window as { api?: unknown }).api
  ;(window as { api?: unknown }).api = {
    planSettledChatDeletion: async (ids: string[]) => {
      planned.push(ids)
      return plans(ids)
    },
    deleteSettledChats: async (ids: string[]): Promise<SettledChatDeletionOutcome[]> => {
      deleted.push(ids)
      // Main removes the records; the store hears it on the broadcast.
      fixtures.state.workspaces = (fixtures.state.workspaces as Array<{ id: string }>).filter(
        (workspace) => !ids.includes(workspace.id),
      )
      return ids.map((workspaceId) => ({ workspaceId, ok: true, worktrees: [] }))
    },
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  ;(window as { api?: unknown }).api = previousApi
})

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <SettledChatsSettingsTab onOpenChat={() => {}} />
      </ConfirmDialogProvider>,
    ),
  )
}

const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')
const dialogButton = (text: string) =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (candidate) => candidate.textContent === text,
  )
const flush = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)))

test("a row's Delete asks first, saying what goes and what stays, and deletes only once confirmed", async () => {
  await render()
  await act(async () => button('Delete Fix the login banner')?.click())
  await flush()
  expect(planned).toEqual([['w2']])
  expect(dialog()?.textContent).toContain('Delete “Fix the login banner”?')
  expect(dialog()?.textContent).toContain("Its history is deleted for good. A deleted chat can't be brought back.")
  expect(dialog()?.textContent).toContain(
    "Its worktree fix-login is removed. The branch agent/fix-login is kept. Its 2 commits that aren't pushed stay on that branch.",
  )
  expect(deleted).toEqual([])

  await act(async () => dialogButton('Delete')?.click())
  await flush()
  expect(deleted).toEqual([['w2']])
  expect(fixtures.toasts).toEqual([{ tone: 'good', title: 'Deleted “Fix the login banner”' }])
})

test('Cancel deletes nothing', async () => {
  await render()
  await act(async () => button('Delete Tidy the release notes')?.click())
  await flush()
  await act(async () => dialogButton('Cancel')?.click())
  await flush()
  expect(dialog()).toBeNull()
  expect(deleted).toEqual([])
})

test('Select all and Delete takes every settled chat in one confirmation that counts them', async () => {
  await render()
  const selectAll = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
    (input) => input.closest('label')?.textContent === 'Select all',
  )
  await act(async () => selectAll?.click())
  expect(host.textContent).toContain('3 selected')
  const bulk = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === 'Delete 3 chats',
  )
  await act(async () => bulk?.click())
  await flush()
  expect(planned).toEqual([['w3', 'w4', 'w2']])
  expect(dialog()?.textContent).toContain('Delete 3 settled chats?')
  expect(dialog()?.textContent).toContain('1 of them runs on a paired machine')
  await act(async () => dialogButton('Delete 3 chats')?.click())
  await flush()
  expect(deleted).toEqual([['w3', 'w4', 'w2']])
  expect(fixtures.toasts.at(-1)).toEqual({ tone: 'good', title: 'Deleted 3 chats' })
})

test('ticking rows deletes just those', async () => {
  await render()
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[aria-label="Select Tidy the release notes"]')?.click(),
  )
  await act(async () =>
    host.querySelector<HTMLInputElement>('input[aria-label="Select Fix the login banner"]')?.click(),
  )
  const bulk = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === 'Delete 2 chats',
  )
  await act(async () => bulk?.click())
  await flush()
  await act(async () => dialogButton('Delete 2 chats')?.click())
  await flush()
  expect(deleted).toEqual([['w3', 'w2']])
  expect(host.textContent).not.toContain('selected')
})

test("a paired machine's chat offers Remove, says it stays on that machine, and asks before removing it here", async () => {
  await render()
  const remove = button('Remove Look at the flaky test')
  expect(remove?.textContent).toBe('Remove')
  // The tooltip says what the button does before it is pressed.
  await act(async () => {
    remove?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 260))
  })
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    'Removes this chat from this computer only. The chat, its history and its worktree stay on mac-mini',
  )
  await act(async () => remove?.click())
  await flush()
  expect(dialog()?.textContent).toContain('Remove “Look at the flaky test” from this computer?')
  expect(dialog()?.textContent).toContain('stay on mac-mini')
  await act(async () => dialogButton('Remove')?.click())
  await flush()
  expect(deleted).toEqual([['w4']])
})

test('a chat main will not delete is not offered a confirmation; the toast says why', async () => {
  plans = (ids) =>
    ids.map((workspaceId) => ({
      workspaceId,
      remoteMachine: null,
      worktrees: [],
      refused: 'An agent in it is working.',
    }))
  await render()
  await act(async () => button('Delete Tidy the release notes')?.click())
  await flush()
  expect(dialog()).toBeNull()
  expect(deleted).toEqual([])
  expect(fixtures.toasts).toEqual([
    { tone: 'error', title: 'The chat was not deleted', description: 'An agent in it is working.' },
  ])
})
