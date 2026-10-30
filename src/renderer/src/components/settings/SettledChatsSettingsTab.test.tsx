// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

const fixtures = vi.hoisted(() => ({
  state: {
    workspaces: [] as unknown[],
    appSettings: { modules: undefined as unknown, keepChatsWithOpenPullRequest: true },
    setWorkspaceSettled: (() => {}) as (id: string, settled: boolean) => void,
    setKeepChatsWithOpenPullRequest: (() => {}) as (enabled: boolean) => void,
  },
}))
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: Object.assign((select: (state: typeof fixtures.state) => unknown) => select(fixtures.state), {
    getState: () => fixtures.state,
  }),
}))

const { SettledChatsSettingsTab } = await import('./SettledChatsSettingsTab')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')

let root: Root
let host: HTMLDivElement
const unsettled: string[] = []
const opened: string[] = []

beforeEach(() => {
  unsettled.length = 0
  opened.length = 0
  fixtures.state.workspaces = [
    { id: 'w1', name: 'Still going', mode: 'standard', folderPath: '/code/apples', createdAt: now },
    {
      id: 'w2',
      name: 'Fix the login banner',
      mode: 'standard',
      folderPath: '/code/apples',
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
  ]
  fixtures.state.setWorkspaceSettled = (id, settled) => {
    if (!settled) unsettled.push(id)
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function render(): Promise<void> {
  await act(async () =>
    root.render(
      <ConfirmDialogProvider>
        <SettledChatsSettingsTab onOpenChat={(id) => opened.push(id)} />
      </ConfirmDialogProvider>,
    ),
  )
}

const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('ul[aria-label="Settled chats"] > li')]

test('lists every settled chat, most recently settled first, with its project and when', async () => {
  await render()
  const text = rows().map((row) => row.textContent ?? '')
  expect(text).toHaveLength(2)
  expect(text[0]).toContain('Tidy the release notes')
  expect(text[0]).toContain('pears · Settled 1d ago')
  expect(text[1]).toContain('Fix the login banner')
  expect(text[1]).toContain('apples · Settled 5d ago')
  expect(host.textContent).not.toContain('Still going')
  expect(host.textContent).not.toContain('Automations')
})

test('Un-settle puts a chat back, and Open leaves Settings for it', async () => {
  await render()
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  await act(async () => button('Un-settle Fix the login banner')?.click())
  expect(unsettled).toEqual(['w2'])
  await act(async () => button('Open Tidy the release notes')?.click())
  expect(opened).toEqual(['w3'])
})

test('a chat opened from a paired machine is brought back there first, then here', async () => {
  const asked: unknown[] = []
  let answer: (value: { ok: true; workspaceId: string; settledAt: null }) => void = () => {}
  const workspaces = fixtures.state.workspaces as Array<Record<string, unknown>>
  workspaces[1] = {
    ...workspaces[1],
    remoteOrigin: {
      connectionId: 'c1',
      machineName: 'mac-mini',
      workspaceId: 'remote-w2',
      workspaceName: 'Fix the login banner',
      workspaceRoot: '/Users/dev/app',
      sessionId: 'remote-w2:agent-1',
    },
  }
  const previous = (window as { api?: unknown }).api
  ;(window as { api?: unknown }).api = {
    meshSettleConversation: (input: unknown) => {
      asked.push(input)
      return new Promise((resolve) => {
        answer = resolve
      })
    },
  }
  try {
    await render()
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Un-settle Fix the login banner"]')?.click(),
    )
    expect(asked).toEqual([{ connectionId: 'c1', workspaceId: 'remote-w2', settled: false }])
    expect(unsettled).toEqual([])
    await act(async () => answer({ ok: true, workspaceId: 'remote-w2', settledAt: null }))
    expect(unsettled).toEqual(['w2'])
  } finally {
    ;(window as { api?: unknown }).api = previous
  }
})

test('with nothing settled, the page says how a chat gets here', async () => {
  fixtures.state.workspaces = [{ id: 'w1', name: 'Still going', mode: 'standard', folderPath: '/a', createdAt: now }]
  await render()
  expect(rows()).toHaveLength(0)
  expect(host.textContent).toContain('No settled chats.')
  expect(host.textContent).toContain('3 days without activity')
})

test('the list keeps its identity through a write to another workspace', async () => {
  const { createSettledChatsSelector } = await import('./settledChatsModel')
  const select = createSettledChatsSelector()
  const workspaces = fixtures.state.workspaces as Parameters<typeof select>[0]
  const first = select(workspaces)
  expect(first.map((chat) => chat.id)).toEqual(['w3', 'w2'])
  // The chat still going turns over; nothing settled moved.
  const busier = [{ ...workspaces[0]!, lastTurnEndedAt: now } as (typeof workspaces)[number], ...workspaces.slice(1)]
  expect(select(busier)).toBe(first)
  // A settled chat's own write that changes nothing listed keeps its entry.
  const touched = [...busier]
  touched[1] = { ...touched[1]!, lastTurnEndedAt: now } as (typeof workspaces)[number]
  expect(select(touched)).toBe(first)
  // Renaming one moves only that entry.
  const renamed = [...touched]
  renamed[2] = { ...renamed[2]!, name: 'Tidy the changelog' } as (typeof workspaces)[number]
  const next = select(renamed)
  expect(next).not.toBe(first)
  expect(next[0]!.title).toBe('Tidy the changelog')
  expect(next[1]).toBe(first[1])
})

test('a long list draws the most recent hundred and folds the rest', async () => {
  fixtures.state.workspaces = Array.from({ length: 130 }, (_, index) => ({
    id: `s${index}`,
    name: `Settled ${index}`,
    mode: 'standard',
    folderPath: '/code/apples',
    createdAt: now - 10 * DAY,
    settledAt: now - index * 60_000,
  }))
  await render()
  expect(rows()).toHaveLength(100)
  const more = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Show 30 more')
  expect(more).toBeDefined()
  await act(async () => more!.click())
  expect(rows()).toHaveLength(130)
})

test('the page offers to keep chats with an open pull request, on, and turning it off says so', async () => {
  const set: boolean[] = []
  fixtures.state.setKeepChatsWithOpenPullRequest = (enabled) => void set.push(enabled)
  await render()
  const toggle = [...host.querySelectorAll<HTMLElement>('[role="switch"]')].find((element) => {
    const label = document.getElementById(element.getAttribute('aria-labelledby') ?? '')
    return label?.textContent === 'Keep chats with an open pull request'
  })
  expect(toggle?.getAttribute('aria-checked')).toBe('true')
  await act(async () => toggle?.click())
  expect(set).toEqual([false])
})
