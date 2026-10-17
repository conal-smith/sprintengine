// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { ExecutionHostId, ExecutionHostSettings } from '../../../../shared/execution-host'
import type { AgentsMachine, MachineCliAvailability } from './agentsMachine'

const fixtures = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}))
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: Object.assign((select: (state: Record<string, unknown>) => unknown) => select(fixtures.state), {
    getState: () => fixtures.state,
  }),
}))

const { AgentClisSection, AgentsMachineSwitcher, useAgentCliRuns } = await import('./AgentClisSection')

// The panel holds the runs; so does this harness.
const NO_BADGES: ReadonlySet<string> = new Set()

const reloads = { count: 0 }

function Section({
  machine,
  availability,
  updateBadgeClis = NO_BADGES,
}: {
  machine: AgentsMachine
  availability: MachineCliAvailability | null
  updateBadgeClis?: ReadonlySet<string>
}) {
  const runs = useAgentCliRuns()
  return (
    <AgentClisSection
      machine={machine}
      machineAvailability={availability}
      onMachineReload={() => {
        reloads.count += 1
      }}
      showMachine
      runs={runs}
      updateBadgeClis={updateBadgeClis}
    />
  )
}

const plugin = (id: string, displayName: string) => ({
  id,
  kind: 'cli',
  displayName,
  binary: id,
  source: 'bundled',
})

const LOCAL: AgentsMachine = { id: 'local', label: 'This PC (Windows)' }
const UBUNTU: AgentsMachine = { id: 'wsl:Ubuntu', label: 'WSL: Ubuntu' }

let root: Root
let host: HTMLDivElement
const hostWrites: Array<[string, ExecutionHostSettings | null]> = []
const runtimeWrites: Array<[string, unknown]> = []
const detectCalls: unknown[][] = []
const updateCalls: unknown[][] = []
const availabilityReads: unknown[] = []
const advisoryReads: unknown[] = []

beforeEach(() => {
  hostWrites.length = 0
  runtimeWrites.length = 0
  detectCalls.length = 0
  updateCalls.length = 0
  availabilityReads.length = 0
  advisoryReads.length = 0
  reloads.count = 0
  fixtures.state = {
    appSettings: {
      cliRuntimes: { claude: { command: '/usr/local/bin/claude' } },
      cliModelCatalog: {},
      hosts: { 'wsl:Ubuntu': { enabled: true, cliCommands: { codex: '/home/dev/.local/bin/codex' }, env: {} } },
    },
    setHostSettings: (id: string, settings: ExecutionHostSettings | null) => hostWrites.push([id, settings]),
    // Registry order: Claude Code, Codex, Gemini.
    pluginCatalogEntries: [plugin('claude', 'Claude Code'), plugin('codex', 'Codex'), plugin('gemini', 'Gemini')],
    pluginCatalogStatus: 'ready',
    pluginCatalogError: null,
    refreshPluginCatalog: async () => {},
    refreshCliAvailability: async (options: unknown) => void availabilityReads.push(options),
    // This PC has Gemini and Codex; Claude Code is not installed here.
    cliAvailability: {
      claude: { cli: 'claude', installed: false, resolvedPath: null, version: null },
      codex: { cli: 'codex', installed: true, resolvedPath: 'C:\\bin\\codex.exe', version: '0.40.0' },
      gemini: { cli: 'gemini', installed: true, resolvedPath: 'C:\\bin\\gemini.exe', version: '1.2.0' },
    },
    cliAvailabilityStatus: 'ready',
    cliAvailabilityError: null,
    cliVersionAdvisories: {},
    refreshCliVersionAdvisories: async (options: unknown) => void advisoryReads.push(options),
    checkCliVersions: false,
    setCliRuntime: (cli: string, update: unknown) => runtimeWrites.push([cli, update]),
    forgetCliModels: () => {},
    setCliModelCatalog: () => {},
  }
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'win32',
    cliDetect: async (...args: unknown[]) => {
      detectCalls.push(args)
      return { installed: false }
    },
    cliInstallMethods: async () => [],
    cliUpdate: async (...args: unknown[]) => {
      updateCalls.push(args)
      return { ok: true, cli: args[0], installed: true, version: '0.41.0', resolvedPath: null, log: '', error: null }
    },
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

// Ubuntu has Claude Code only.
const ubuntuProbe: MachineCliAvailability = {
  hostId: 'wsl:Ubuntu',
  map: {
    claude: { cli: 'claude', installed: true, resolvedPath: '/home/dev/.local/bin/claude', version: '2.0.1' },
    codex: { cli: 'codex', installed: false, resolvedPath: null, version: null },
    gemini: { cli: 'gemini', installed: false, resolvedPath: null, version: null },
  },
  status: 'ready',
  error: null,
  checkedAt: 1,
}

async function renderSection(
  machine: AgentsMachine,
  availability: MachineCliAvailability | null,
  updateBadgeClis?: ReadonlySet<string>,
): Promise<void> {
  await act(async () =>
    root.render(<Section machine={machine} availability={availability} updateBadgeClis={updateBadgeClis} />),
  )
}

function rowNames(): string[] {
  return Array.from(host.querySelectorAll('li')).map(
    (row) => row.querySelector('span.truncate.font-semibold')?.textContent ?? '',
  )
}

function nameSpan(name: string): HTMLElement {
  const span = Array.from(host.querySelectorAll<HTMLElement>('span.truncate.font-semibold')).find(
    (candidate) => candidate.textContent === name,
  )
  expect(span).toBeTruthy()
  return span!
}

async function openRow(name: string): Promise<void> {
  const chevron = host.querySelector<HTMLElement>(`[aria-label="${name} details"]`)
  expect(chevron).toBeTruthy()
  await act(async () => chevron!.click())
}

test('installed CLIs come first in registry order, and the missing ones follow, receded', async () => {
  await renderSection(LOCAL, null)
  expect(rowNames()).toEqual(['Codex', 'Gemini', 'Claude Code'])
  // Receded: the name drops to the muted ink, the state line says why in words.
  expect(nameSpan('Claude Code').className).toMatch(/text-\[color:var\(--text-muted\)\]/)
  expect(nameSpan('Codex').className).toMatch(/text-\[color:var\(--text-strong\)\]/)
  const claudeRow = nameSpan('Claude Code').closest('li')!
  expect(claudeRow.textContent).toContain('Not installed')
  // Still installable: dimming is contrast, not a disabled state.
  const install = Array.from(claudeRow.querySelectorAll('button')).find((button) => button.textContent === 'Install')
  expect(install).toBeTruthy()
  expect(install!.disabled).toBe(false)
  // ...and quiet: the outline secondary, not an accent fill pulling the eye back.
  expect(install!.className).toMatch(/border-\[color:var\(--border-strong\)\]/)
  expect(install!.className).not.toMatch(/bg-\[color:var\(--accent-primary\)\]/)
  // The mark recedes with the name; a present CLI's keeps its ink.
  expect(claudeRow.querySelector('svg')?.getAttribute('class')).toMatch(/text-\[color:var\(--text-muted\)\]/)
  const codexRow = nameSpan('Codex').closest('li')!
  expect(codexRow.querySelector('svg')?.getAttribute('class')).toMatch(/text-\[color:var\(--text-default\)\]/)
  expect(claudeRow.querySelector('[aria-disabled]')).toBe(null)
})

test('a probe that never answered is not absence, and does not move a row down', async () => {
  ;(fixtures.state as { cliAvailability: Record<string, unknown> }).cliAvailability = {
    codex: { cli: 'codex', installed: false, resolvedPath: null, version: null },
  }
  await renderSection(LOCAL, null)
  expect(rowNames()).toEqual(['Claude Code', 'Gemini', 'Codex'])
  expect(nameSpan('Claude Code').className).toMatch(/text-\[color:var\(--text-strong\)\]/)
})

test('switching machines shows that machine’s CLIs and its own command overrides', async () => {
  await renderSection(LOCAL, null)
  await openRow('Codex')
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Codex command override"]')).toBeTruthy()

  await renderSection(UBUNTU, ubuntuProbe)
  // Ubuntu's answer, not this PC's: Claude Code is the one installed there.
  expect(rowNames()).toEqual(['Claude Code', 'Codex', 'Gemini'])
  const claudeRow = nameSpan('Claude Code').closest('li')!
  expect(claudeRow.textContent).toContain('2.0.1')
  expect(claudeRow.textContent).toContain('WSL: Ubuntu')
  expect(nameSpan('Codex').className).toMatch(/text-\[color:var\(--text-muted\)\]/)
  // The open row belonged to the other machine, and closed with it.
  expect(host.querySelector('input[aria-label^="Codex command override"]')).toBe(null)

  await openRow('Codex')
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Codex command override on WSL: Ubuntu"]')
  expect(field).toBeTruthy()
  expect(field!.value).toBe('/home/dev/.local/bin/codex')
  // Detect and install run on that machine, with its command.
  expect(detectCalls.at(-1)).toEqual(['codex', { command: '/home/dev/.local/bin/codex', hostId: 'wsl:Ubuntu' }])
  // Only what is the machine's: the CLI-wide rows stay with this PC.
  expect(host.textContent).not.toContain('Model list')

  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(field, '/opt/codex')
    field!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(hostWrites).toEqual([['wsl:Ubuntu', { enabled: true, cliCommands: { codex: '/opt/codex' }, env: {} }]])
  expect(runtimeWrites).toEqual([])
})

test('this PC’s override still writes the CLI runtime, as it always did', async () => {
  await renderSection(LOCAL, null)
  await openRow('Claude Code')
  const field = host.querySelector<HTMLInputElement>('input[aria-label="Claude Code command override"]')
  expect(field!.value).toBe('/usr/local/bin/claude')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(field, 'claude-dev')
    field!.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(runtimeWrites).toEqual([['claude', { command: 'claude-dev' }]])
  expect(hostWrites).toEqual([])
})

test('an open row keeps its place when its own probe answers "missing"', async () => {
  await renderSection(LOCAL, null)
  await openRow('Codex')
  // A half-typed override probes as missing; the row being edited stays put.
  ;(fixtures.state as { cliAvailability: Record<string, unknown> }).cliAvailability = {
    ...(fixtures.state as { cliAvailability: Record<string, unknown> }).cliAvailability,
    codex: { cli: 'codex', installed: false, resolvedPath: null, version: null },
  }
  await renderSection(LOCAL, null)
  expect(rowNames()).toEqual(['Codex', 'Gemini', 'Claude Code'])
  expect(host.querySelector('input[aria-label="Codex command override"]')).toBeTruthy()
  // Closed, the list takes its order again.
  await openRow('Codex')
  expect(rowNames()).toEqual(['Gemini', 'Claude Code', 'Codex'])
})

test('a WSL probe that failed is said once, naming the machine', async () => {
  await renderSection(UBUNTU, { ...ubuntuProbe, map: {}, status: 'error', error: 'wsl.exe timed out', checkedAt: null })
  expect(host.textContent).toContain('Agent CLIs could not be checked on WSL: Ubuntu: wsl.exe timed out')
})

test('a WSL machine still being asked reads as checking, not as missing', async () => {
  await renderSection(UBUNTU, { ...ubuntuProbe, map: {}, status: 'loading', checkedAt: null })
  expect(host.textContent).toContain('Checking…')
  expect(host.textContent).not.toContain('Not installed')
})

// ---------------------------------------------------------------------------
// CLI updates (owner ruling 2026-09-25)
// ---------------------------------------------------------------------------

function behind(cli: string, hostId: ExecutionHostId, currentVersion: string) {
  return {
    cli,
    hostId,
    status: 'behind_latest',
    currentVersion,
    latestVersion: '0.41.0',
    updateCommand: null,
    checkedAt: '2026-09-25T00:00:00.000Z',
  }
}

function behindCodex(): void {
  Object.assign(fixtures.state, {
    checkCliVersions: true,
    cliVersionAdvisories: { local: { codex: behind('codex', 'local', '0.40.0') } },
  })
}

test('a CLI with a newer release wears its count beside its Update button', async () => {
  behindCodex()
  await renderSection(LOCAL, null, new Set(['codex']))
  const codexRow = nameSpan('Codex').closest('li')!
  const update = Array.from(codexRow.querySelectorAll('button')).find((button) => button.textContent === 'Update')
  expect(update).toBeTruthy()
  const badge = codexRow.querySelector('[role="status"][aria-label="Codex — update available: 0.41.0"]')
  expect(badge?.textContent).toBe('1')
  // Beside the button, not on the mark: the two share one wrapper.
  expect(badge?.parentElement).toBe(update!.parentElement)
  // Named, never colour alone — and only on the row that is behind.
  const geminiRow = nameSpan('Gemini').closest('li')!
  expect(geminiRow.querySelector('[role="status"]')).toBe(null)
})

test('a dismissed update keeps its Update button and loses only the badge', async () => {
  behindCodex()
  await renderSection(LOCAL, null, new Set())
  const codexRow = nameSpan('Codex').closest('li')!
  expect(Array.from(codexRow.querySelectorAll('button')).some((button) => button.textContent === 'Update')).toBe(true)
  expect(codexRow.querySelector('[role="status"]')).toBe(null)
})

test('this PC’s update runs this PC’s command and reads the result back without a re-scan', async () => {
  behindCodex()
  await renderSection(LOCAL, null, new Set(['codex']))
  const codexRow = nameSpan('Codex').closest('li')!
  const update = Array.from(codexRow.querySelectorAll('button')).find((button) => button.textContent === 'Update')
  await act(async () => update!.click())
  expect(updateCalls).toEqual([['codex', { command: '' }]])
  // Main recorded what the update found; nothing here forces a probe.
  expect(availabilityReads).toEqual([{ cliRuntimes: { claude: { command: '/usr/local/bin/claude' } } }])
  expect(advisoryReads).toEqual([undefined])
  expect(reloads.count).toBe(0)
})

test('a WSL machine’s own advisories: its rows offer Update, wear their badge, and update on that machine', async () => {
  Object.assign(fixtures.state, {
    checkCliVersions: true,
    cliVersionAdvisories: {
      // This PC's codex is behind; that is not Ubuntu's news.
      local: { codex: behind('codex', 'local', '0.40.0') },
      'wsl:Ubuntu': { claude: behind('claude', 'wsl:Ubuntu', '2.0.1') },
    },
  })
  await renderSection(UBUNTU, ubuntuProbe, new Set(['claude']))
  const claudeRow = nameSpan('Claude Code').closest('li')!
  expect(claudeRow.textContent).toContain('0.41.0 available')
  expect(claudeRow.querySelector('[role="status"][aria-label="Claude Code — update available: 0.41.0"]')).toBeTruthy()
  const buttons = Array.from(host.querySelectorAll('button')).filter((button) => button.textContent === 'Update')
  expect(buttons).toHaveLength(1)
  // Codex is not installed on Ubuntu, so this PC's advisory for it does not leak in.
  expect(nameSpan('Codex').closest('li')!.textContent).not.toContain('available')

  await act(async () => buttons[0].click())
  expect(updateCalls).toEqual([['claude', { command: '', hostId: 'wsl:Ubuntu' }]])
  expect(reloads.count).toBe(1)
  // This PC's list is not read again for a WSL update.
  expect(availabilityReads).toEqual([])
})

// ---------------------------------------------------------------------------
// The switcher
// ---------------------------------------------------------------------------

async function renderSwitcher(machines: AgentsMachine[], onChange: (id: ExecutionHostId) => void): Promise<void> {
  await act(async () => root.render(<AgentsMachineSwitcher machines={machines} value="local" onChange={onChange} />))
}

test('one machine draws no switcher at all', async () => {
  await renderSwitcher([LOCAL], () => {})
  expect(host.innerHTML).toBe('')
})

test('two machines draw the segmented control, and a pick names the machine', async () => {
  const picks: ExecutionHostId[] = []
  await renderSwitcher([LOCAL, UBUNTU], (id) => picks.push(id))
  const group = host.querySelector('[role="radiogroup"][aria-label="Machine"]')
  expect(group).toBeTruthy()
  const options = Array.from(group!.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
  expect(options.map((option) => option.textContent)).toEqual(['This PC (Windows)', 'WSL: Ubuntu'])
  expect(options[0].getAttribute('aria-checked')).toBe('true')
  await act(async () => options[1].click())
  expect(picks).toEqual(['wsl:Ubuntu'])
})

test('each machine with a CLI update wears its own count on its segment', async () => {
  await act(async () =>
    root.render(
      <AgentsMachineSwitcher
        machines={[LOCAL, UBUNTU]}
        value="wsl:Ubuntu"
        onChange={() => {}}
        badges={{
          local: {
            count: 2,
            tone: 'accent',
            label: 'Agents: 2 CLI updates available',
            detail: '2 CLI updates available',
          },
          'wsl:Ubuntu': {
            count: 1,
            tone: 'accent',
            label: 'Agents: 1 CLI update available',
            detail: '1 CLI update available',
          },
        }}
      />,
    ),
  )
  const options = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]'))
  expect(options[0].getAttribute('aria-label')).toBe('This PC (Windows), 2 CLI updates available')
  expect(options[0].querySelector('[role="status"]')?.textContent).toBe('2')
  expect(options[1].getAttribute('aria-label')).toBe('WSL: Ubuntu, 1 CLI update available')
  expect(options[1].querySelector('[role="status"]')?.textContent).toBe('1')
})

test('the bare shell row shows no version, not the shell banner', async () => {
  fixtures.state = {
    ...fixtures.state,
    pluginCatalogEntries: [plugin('codex', 'Codex'), plugin('generic-shell', 'Generic Shell')],
    cliAvailability: {
      codex: { cli: 'codex', installed: true, resolvedPath: 'C:\\bin\\codex.exe', version: '0.40.0' },
      'generic-shell': {
        cli: 'generic-shell',
        installed: true,
        resolvedPath: '/bin/sh',
        version: 'GNU bash, version 3.2.57(1)-release (arm64-apple-darwin)',
      },
    },
  }
  await renderSection(LOCAL, null)
  expect(host.textContent).toContain('0.40.0')
  expect(host.textContent).not.toContain('GNU bash')
})
