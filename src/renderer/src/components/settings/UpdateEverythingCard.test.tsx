// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { CliUpdateAllItem } from '../../../../shared/ipc/cli-update-all'

const fixtures = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: Object.assign((select: (state: Record<string, unknown>) => unknown) => select(fixtures.state), {
    getState: () => fixtures.state,
  }),
}))

const { UpdateEverythingCard, groupByMachine } = await import('./UpdateEverythingCard')

const behind = (cli: string, hostId: string) => ({
  cli,
  hostId,
  status: 'behind_latest',
  currentVersion: '1.0.0',
  latestVersion: '2.0.0',
  updateCommand: { kind: 'npm' },
  checkedAt: '',
})

let root: Root
let host: HTMLDivElement
let progress: ((items: CliUpdateAllItem[]) => void) | null
let finish: ((items: CliUpdateAllItem[]) => void) | null
const refreshed: string[] = []

beforeEach(() => {
  progress = null
  finish = null
  refreshed.length = 0
  fixtures.state = {
    cliVersionAdvisories: {
      local: {
        codex: behind('codex', 'local'),
        'claude-code': { ...behind('claude-code', 'local'), status: 'current' },
      },
      'wsl:Ubuntu': { codex: behind('codex', 'wsl:Ubuntu') },
    },
    pluginCatalogEntries: [{ id: 'codex', displayName: 'Codex' }],
    appSettings: { cliRuntimes: {} },
    refreshCliAvailability: async () => void refreshed.push('availability'),
    refreshCliVersionAdvisories: async () => void refreshed.push('advisories'),
  }
  Object.assign(window, {
    api: {
      platform: 'darwin',
      cliUpdateAll: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = (items) => resolve({ ok: true, items })
          }),
      ),
      onCliUpdateAllProgress: (cb: (items: CliUpdateAllItem[]) => void) => {
        progress = cb
        return () => {
          progress = null
        }
      },
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const button = () => host.querySelector('button')!

test('it counts the updates across machines, and shows each machine’s as they go', async () => {
  await act(async () => root.render(<UpdateEverythingCard />))
  expect(host.textContent).toContain('2 updates on 2 machines')
  await act(async () => button().click())
  expect(button().textContent).toBe('Updating…')
  expect(button().disabled).toBe(true)
  const items: CliUpdateAllItem[] = [
    { hostId: 'local', cli: 'codex', from: '1.0.0', latest: '2.0.0', state: 'updating' },
    { hostId: 'wsl:Ubuntu', cli: 'codex', from: '1.0.0', latest: '2.0.0', state: 'queued' },
  ]
  await act(async () => progress?.(items))
  expect(host.textContent).toContain('This Mac')
  expect(host.textContent).toContain('WSL: Ubuntu')
  expect(host.textContent).toContain('Updating… 1.0.0 → 2.0.0')
  expect(host.textContent).toContain('Waiting 1.0.0 → 2.0.0')
  await act(async () =>
    finish?.([
      { ...items[0]!, state: 'updated', to: '2.0.0' },
      { ...items[1]!, state: 'failed', error: 'npm ERR! EACCES' },
    ]),
  )
  expect(host.textContent).toContain('Updated to 2.0.0')
  expect(host.textContent).toContain('Did not update: npm ERR! EACCES')
  expect(refreshed).toEqual(['availability', 'advisories'])
})

test('with nothing outdated there is no card', async () => {
  fixtures.state = { ...fixtures.state, cliVersionAdvisories: {} }
  await act(async () => root.render(<UpdateEverythingCard />))
  expect(host.textContent).toBe('')
})

test('this machine is listed first', () => {
  const item = (hostId: string): CliUpdateAllItem =>
    ({ hostId, cli: 'codex', from: null, latest: null, state: 'queued' }) as CliUpdateAllItem
  expect(groupByMachine([item('wsl:Ubuntu'), item('local'), item('wsl:Debian')]).map(([id]) => id)).toEqual([
    'local',
    'wsl:Debian',
    'wsl:Ubuntu',
  ])
})
