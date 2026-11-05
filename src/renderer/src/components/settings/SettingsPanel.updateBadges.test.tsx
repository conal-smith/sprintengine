// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { AppUpdateState, CliVersionAdvisory, CliVersionHostAdvisories } from '../../../../shared/electron-api'
import type { ExecutionHostId, HostsListResult } from '../../../../shared/execution-host'

// The update badges inside Settings (owner ruling 2026-09-25), through the real
// panel: General wears the app update, Agents the CLI updates of every machine,
// each machine's switcher segment its own, and each appears and clears with the
// update. Also the other half of "links now open Settings ▸ Agents": an
// opener that names a machine lands on it.
//
// Every IPC the panel reaches for on mount answers "nothing" unless named here.

let listing: HostsListResult
let appUpdate: AppUpdateState
// What a WSL machine's list reads back; nothing unless a case says so.
let wslAvailability: Record<string, unknown>
const discoverInputs: Array<{ force?: boolean }> = []
const detectInputs: unknown[] = []
const advisoryInputs: unknown[] = []
let pushState: ((state: AppUpdateState) => void) | null = null

function appState(over: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: 'not_available',
    version: '0.6.0',
    channel: 'stable',
    buildChannel: 'stable',
    packaged: true,
    updateVersion: null,
    releaseName: null,
    releaseNotes: null,
    releaseNotesUrl: null,
    downloaded: false,
    progress: null,
    errorMessage: null,
    lastCheckedAt: null,
    autoDownload: false,
    installRequiresAdmin: false,
    installOutcome: null,
    ...over,
  }
}

function stubApi(): void {
  const named: Record<string, unknown> = {
    hostsList: async () => listing,
    onHostsChanged: () => () => {},
    // Codex is installed here; a WSL probe finds what the case put there.
    cliModelsDiscover: async (input: { force?: boolean }) => {
      discoverInputs.push(input)
      return { entries: [], startedAt: '', finishedAt: '' }
    },
    pluginsDetectAvailability: async (input: { cliRuntimes?: Record<string, { hostId?: string }> }) => {
      detectInputs.push(input)
      const wsl = JSON.stringify(input).includes('"hostId":"wsl:')
      return {
        ok: true,
        availability: wsl
          ? wslAvailability
          : { codex: { cli: 'codex', installed: true, resolvedPath: '/usr/local/bin/codex', version: '0.40.0' } },
      }
    },
    cliVersionAdvisories: async (input: unknown) => {
      advisoryInputs.push(input)
      return { ok: true, advisories: useWorkspaceStore.getState().cliVersionAdvisories, checkedAt: 'now' }
    },
    pluginsList: async () => ({ ok: true, plugins: [] }),
    getGitHubTokenStatus: async () => ({ configured: false }),
    updateGetState: async () => appUpdate,
    onUpdateStateChanged: (cb: (state: AppUpdateState) => void) => {
      pushState = cb
      return () => {
        pushState = null
      }
    },
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(named, {
    get(target, key) {
      if (key === 'platform') return 'win32'
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      return key.startsWith('on') ? () => () => {} : async () => undefined
    },
  })
}

const { default: SettingsPanel } = await import('./SettingsPanel')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
const { useWorkspaceStore } = await import('../../store/workspaceStore')
const { useNotificationStore } = await import('../../store/notificationStore')
const { useAppUpdateStore } = await import('../../store/appUpdateStore')
const { rememberAgentsMachine } = await import('./agentsMachine')

function Panel({
  initialTab,
  request,
}: {
  initialTab: string
  request?: { hostId: ExecutionHostId; requestId: number }
}): React.JSX.Element {
  return (
    <ConfirmDialogProvider>
      <SettingsPanel onClose={() => {}} initialTab={initialTab} agentsMachineRequest={request} />
    </ConfirmDialogProvider>
  )
}

const BEHIND_CODEX: CliVersionAdvisory = {
  cli: 'codex',
  hostId: 'local',
  status: 'behind_latest',
  currentVersion: '0.40.0',
  latestVersion: '0.41.0',
  updateCommand: null,
  checkedAt: '2026-09-25T00:00:00.000Z',
}
const BEHIND: CliVersionHostAdvisories = { local: { codex: BEHIND_CODEX } }

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  rememberAgentsMachine('local')
  wslAvailability = {}
  detectInputs.length = 0
  advisoryInputs.length = 0
  appUpdate = appState()
  useAppUpdateStore.setState({ state: null })
  useNotificationStore.setState({ dismissedUpdates: [] })
  useWorkspaceStore.getState().setHostSettings('wsl:Ubuntu', { enabled: true, cliCommands: {}, env: {} })
  useWorkspaceStore.setState({
    pluginCatalogStatus: 'ready',
    pluginCatalogEntries: [
      { id: 'codex', kind: 'cli', displayName: 'Codex', binary: 'codex', source: 'bundled' },
    ] as unknown as ReturnType<typeof useWorkspaceStore.getState>['pluginCatalogEntries'],
    cliAvailability: {
      codex: { cli: 'codex', installed: true, resolvedPath: '/usr/local/bin/codex', version: '0.40.0' },
    } as ReturnType<typeof useWorkspaceStore.getState>['cliAvailability'],
    cliAvailabilityStatus: 'ready',
    checkCliVersions: true,
    cliVersionAdvisories: {},
  })
  listing = {
    hosts: [
      { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
      { id: 'wsl:Ubuntu', kind: 'wsl', label: 'WSL: Ubuntu', pathStyle: 'wsl', state: 'ready', enabled: true },
    ],
    wsl: { available: true },
  }
  stubApi()
  window.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
}

const navTab = (id: string): HTMLElement => host.querySelector<HTMLElement>(`#settings-tab-${id}`)!
const navBadge = (id: string): Element | null => navTab(id).querySelector('[role="status"]')
const segments = (): HTMLButtonElement[] =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Machine"] [role="radio"]'))
const checkedMachine = (): string | null | undefined =>
  segments().find((segment) => segment.getAttribute('aria-checked') === 'true')?.textContent

test('a CLI update badges Agents, This PC’s segment and the row, and clears when installed', async () => {
  useWorkspaceStore.setState({ cliVersionAdvisories: BEHIND })
  await act(async () => root.render(<Panel initialTab="agents" />))
  await settle()

  expect(navTab('agents').getAttribute('aria-label')).toBe('Agents, 1 CLI update available')
  expect(navBadge('agents')?.textContent).toBe('1')
  expect(navBadge('general')).toBe(null)

  const [thisPc, ubuntu] = segments()
  expect(thisPc.getAttribute('aria-label')).toBe('This PC (Windows), 1 CLI update available')
  expect(ubuntu.querySelector('[role="status"]')).toBe(null)

  expect(host.querySelector('[aria-label="Codex — update available: 0.41.0"]')).toBeTruthy()

  // Installed: the advisory stops saying behind.
  await act(async () =>
    useWorkspaceStore.setState({ cliVersionAdvisories: { local: { codex: { ...BEHIND_CODEX, status: 'current' } } } }),
  )
  expect(navBadge('agents')).toBe(null)
  expect(navTab('agents').getAttribute('aria-label')).toBe(null)
  expect(segments()[0].querySelector('[role="status"]')).toBe(null)
  expect(host.querySelector('[aria-label="Codex — update available: 0.41.0"]')).toBe(null)
})

test('a WSL machine’s CLI update rolls up to the gear’s Agents and its own segment, and clears when installed', async () => {
  wslAvailability = {
    codex: { cli: 'codex', installed: true, resolvedPath: '/home/dev/.local/bin/codex', version: '0.39.0' },
  }
  const wslCodex: CliVersionAdvisory = { ...BEHIND_CODEX, hostId: 'wsl:Ubuntu', currentVersion: '0.39.0' }
  useWorkspaceStore.setState({ cliVersionAdvisories: { ...BEHIND, 'wsl:Ubuntu': { codex: wslCodex } } })
  await act(async () => root.render(<Panel initialTab="agents" />))
  await settle()

  expect(navTab('agents').getAttribute('aria-label')).toBe('Agents, 2 CLI updates available')
  const [thisPc, ubuntu] = segments()
  expect(thisPc.getAttribute('aria-label')).toBe('This PC (Windows), 1 CLI update available')
  expect(ubuntu.getAttribute('aria-label')).toBe('WSL: Ubuntu, 1 CLI update available')

  await act(async () => ubuntu.click())
  await settle()
  // The segment's text carries its badge's count after the label.
  expect(checkedMachine()).toBe('WSL: Ubuntu1')
  expect(host.querySelector('[aria-label="Codex — update available: 0.41.0"]')).toBeTruthy()
  expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Update')).toBe(true)

  // Dismissing the WSL notice leaves this PC's update counted.
  await act(async () => useNotificationStore.getState().dismissUpdate('cli:wsl:Ubuntu|codex@0.41.0'))
  expect(navTab('agents').getAttribute('aria-label')).toBe('Agents, 1 CLI update available')
  expect(segments()[1].querySelector('[role="status"]')).toBe(null)
  expect(segments()[0].querySelector('[role="status"]')?.textContent).toBe('1')

  // Installed on the distribution: its advisory stops saying behind.
  await act(async () => useNotificationStore.setState({ dismissedUpdates: [] }))
  await act(async () =>
    useWorkspaceStore.setState({
      cliVersionAdvisories: { ...BEHIND, 'wsl:Ubuntu': { codex: { ...wslCodex, status: 'current' } } },
    }),
  )
  expect(segments()[1].querySelector('[role="status"]')).toBe(null)
  expect(navTab('agents').getAttribute('aria-label')).toBe('Agents, 1 CLI update available')
})

test('Re-check asks main to detect every machine again, then reads both lists back without forcing', async () => {
  await act(async () => root.render(<Panel initialTab="agents" />))
  await settle()
  await act(async () => segments()[1].click())
  await settle()
  detectInputs.length = 0
  const recheck = host.querySelector<HTMLButtonElement>('button[aria-label="Re-check every CLI now"]')
  expect(recheck).toBeTruthy()
  await act(async () => recheck!.click())
  await settle()
  expect(advisoryInputs.at(-1)).toEqual({ detect: true, force: true })
  expect(detectInputs.length).toBeGreaterThanOrEqual(2)
  expect(detectInputs.every((input) => !(input as { force?: boolean }).force)).toBe(true)
  // The models too, once the CLIs have been found again.
  expect(discoverInputs.some((input) => input.force === true)).toBe(true)
})

test('a dismissed CLI update loses every badge but keeps its Update button', async () => {
  useWorkspaceStore.setState({ cliVersionAdvisories: BEHIND })
  await act(async () => root.render(<Panel initialTab="agents" />))
  await settle()
  expect(navBadge('agents')).toBeTruthy()

  await act(async () => useNotificationStore.getState().dismissUpdate('cli:codex@0.41.0'))
  expect(navBadge('agents')).toBe(null)
  expect(segments()[0].querySelector('[role="status"]')).toBe(null)
  expect(host.querySelector('[aria-label="Codex — update available: 0.41.0"]')).toBe(null)
  expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Update')).toBe(true)
})

test('an app update badges General and fills the version row; it clears when installed or dismissed', async () => {
  appUpdate = appState({ status: 'available', updateVersion: '0.7.0' })
  await act(async () => root.render(<Panel initialTab="general" />))
  await settle()

  expect(navTab('general').getAttribute('aria-label')).toBe('General, Update available')
  expect(navBadge('general')?.textContent).toBe('1')
  expect(navBadge('agents')).toBe(null)
  expect(host.textContent).toContain('0.7.0 available')
  expect(host.querySelector('button[aria-label="Download SprintEngine Studio 0.7.0"]')).toBeTruthy()

  // Downloading, then ready: the badge stays through both.
  await act(async () =>
    pushState?.(
      appState({
        status: 'downloading',
        updateVersion: '0.7.0',
        progress: { percent: 50, transferred: 1, total: 2, bytesPerSecond: 1 },
      }),
    ),
  )
  expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50')
  expect(navBadge('general')).toBeTruthy()
  await act(async () => pushState?.(appState({ status: 'downloaded', downloaded: true, updateVersion: '0.7.0' })))
  expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Restart to update')).toBe(true)
  expect(navTab('general').getAttribute('aria-label')).toBe('General, Update ready to install')

  // Installing: still waiting on the restart, still badged.
  await act(async () => pushState?.(appState({ status: 'installing', downloaded: true, updateVersion: '0.7.0' })))
  expect(navBadge('general')).toBeTruthy()

  // Refused: back to ready with the reason — still an update to take.
  await act(async () =>
    pushState?.(
      appState({ status: 'downloaded', downloaded: true, updateVersion: '0.7.0', errorMessage: 'Installer busy.' }),
    ),
  )
  expect(navBadge('general')).toBeTruthy()
  expect(host.textContent).toContain('Installer busy.')

  // Dismissed at this step (Later on the ready toast).
  await act(async () => useNotificationStore.getState().dismissUpdate('app@0.7.0:ready'))
  expect(navBadge('general')).toBe(null)
  expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Restart to update')).toBe(true)

  // Installed: a new start reports the new version and nothing pending.
  await act(async () => useNotificationStore.setState({ dismissedUpdates: [] }))
  await act(async () => pushState?.(appState({ version: '0.7.0' })))
  expect(navBadge('general')).toBe(null)
  expect(host.textContent).toContain('SprintEngine Studio 0.7.0')
})

test('a download that failed keeps General badged and the row offers Download again', async () => {
  appUpdate = appState({ status: 'error', updateVersion: '0.7.0', errorMessage: 'net::ERR_CONNECTION_RESET' })
  await act(async () => root.render(<Panel initialTab="general" />))
  await settle()
  expect(navBadge('general')?.textContent).toBe('1')
  expect(host.querySelector('button[aria-label="Download SprintEngine Studio 0.7.0"]')).toBeTruthy()
  // The offer waved off: gone until the next step or the next release.
  await act(async () => useNotificationStore.getState().dismissUpdate('app@0.7.0:offer'))
  expect(navBadge('general')).toBe(null)
})

test('an opener that names a machine lands on it, even when the tab last showed another', async () => {
  rememberAgentsMachine('wsl:Ubuntu')
  await act(async () => root.render(<Panel initialTab="agents" request={{ hostId: 'local', requestId: 1 }} />))
  await settle()
  expect(host.querySelector('#settings-panel-agents')).toBeTruthy()
  expect(checkedMachine()).toBe('This PC (Windows)')

  // Moved away, then asked again (a second CLI update toast's Settings).
  await act(async () => segments()[1].click())
  expect(checkedMachine()).toBe('WSL: Ubuntu')
  await act(async () => root.render(<Panel initialTab="agents" request={{ hostId: 'local', requestId: 2 }} />))
  await settle()
  expect(checkedMachine()).toBe('This PC (Windows)')
})
