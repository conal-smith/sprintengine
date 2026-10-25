// @vitest-environment jsdom
//
// The local servers menu, opened from the chat's strip and the sidebar's mark:
// which actions a server offers (Run again only when stopped and the agent
// gave a command, Stop only for a run the Studio started, tailnet sharing only
// for a loopback URL while Tailscale is up), and that the rows do what they
// say.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { StudioLocalServer } from '../../../../../packages/studio-protocol/src/public'
import { EMPTY_TAILNET_SHARE_STATUS, type TailnetShareStatus } from '../../../../shared/tailnet-share'

const calls = vi.hoisted(() => ({
  run: [] as unknown[],
  stop: [] as unknown[],
  remove: [] as unknown[],
  pane: [] as unknown[],
}))

vi.mock('./useLocalServers', () => ({
  runLocalServer: async (...args: unknown[]) => {
    calls.run.push(args)
    return { ok: true }
  },
  stopLocalServer: async (...args: unknown[]) => {
    calls.stop.push(args)
    return { ok: true }
  },
  removeLocalServer: async (...args: unknown[]) => {
    calls.remove.push(args)
    return { ok: true }
  },
}))

vi.mock('./pane/browser/openInPane', () => ({
  openUrlInPane: (...args: unknown[]) => {
    calls.pane.push(args)
    return true
  },
}))

const { GhostButton } = await import('../ui')
const { ConfirmDialogProvider } = await import('../ui/ConfirmDialog')
const { LocalServersMenu, NO_COMMAND_REASON, localServerActions, localServerExitLine } =
  await import('./LocalServersMenu')

function server(overrides: Partial<StudioLocalServer> = {}): StudioLocalServer {
  return {
    id: 'srv-1',
    agentId: 'agent-1',
    url: 'http://localhost:5173/',
    title: 'localhost:5173',
    port: 5173,
    state: 'running',
    linkedAt: 1,
    stateAt: 1,
    command: 'npm run dev',
    cwd: '/Users/dev/app',
    ...overrides,
  }
}

const UP: TailnetShareStatus = { available: true, dnsName: 'mac-mini.tail1234.ts.net', shares: [], ladderFull: false }
const OWNER = { workspaceId: 'ws-1', agentId: 'agent-1' }
const FULL = { tailnet: null, canOpenInPane: true }
const ids = (list: ReturnType<typeof localServerActions>) => list.map((action) => action.id)

test('a running server the agent started can be opened, copied and removed, and not stopped or run', () => {
  expect(ids(localServerActions(server(), FULL))).toEqual(['open', 'open-external', 'copy-link', 'remove'])
})

test('Run again is offered only for a stopped server, and is off with a reason when it has no command', () => {
  expect(ids(localServerActions(server({ state: 'starting' }), FULL))).not.toContain('run')
  const stopped = localServerActions(server({ state: 'stopped' }), FULL).find((action) => action.id === 'run')
  expect(stopped).toEqual({ id: 'run', label: 'Run again' })
  const noCommand = localServerActions(server({ state: 'stopped', command: undefined }), FULL).find(
    (action) => action.id === 'run',
  )
  expect(noCommand?.disabled).toBe(true)
  expect(noCommand?.reason).toBe(NO_COMMAND_REASON)
})

test('Stop is offered for as long as a run the Studio started lives, and only for one', () => {
  expect(ids(localServerActions(server({ startedByStudio: true }), FULL))).toContain('stop')
  expect(ids(localServerActions(server({ startedByStudio: true, state: 'starting' }), FULL))).toContain('stop')
  // Its port never opened (another port, or slower than the Studio waits):
  // still the Studio's process, still stoppable, and not run a second time.
  const quiet = ids(localServerActions(server({ startedByStudio: true, state: 'stopped' }), FULL))
  expect(quiet).toContain('stop')
  expect(quiet).not.toContain('run')
  expect(ids(localServerActions(server(), FULL))).not.toContain('stop')
})

test('tailnet sharing is offered only for a loopback URL while Tailscale is up here', () => {
  expect(ids(localServerActions(server(), { ...FULL, tailnet: UP }))).toContain('share-tailnet')
  expect(ids(localServerActions(server(), { ...FULL, tailnet: EMPTY_TAILNET_SHARE_STATUS }))).not.toContain(
    'share-tailnet',
  )
  expect(ids(localServerActions(server(), FULL))).not.toContain('share-tailnet')
  const lan = server({ url: 'http://192.168.1.20:5173/' })
  expect(ids(localServerActions(lan, { ...FULL, tailnet: UP }))).not.toContain('share-tailnet')
})

test('a port already on the tailnet offers its link instead of sharing it again', () => {
  const shared: TailnetShareStatus = {
    ...UP,
    shares: [{ localPort: 5173, servePort: 8443, url: 'https://mac-mini.tail1234.ts.net:8443/' }],
  }
  const list = ids(localServerActions(server(), { ...FULL, tailnet: shared }))
  expect(list).toContain('copy-tailnet-link')
  expect(list).not.toContain('share-tailnet')
})

test('a full share ladder keeps Share on tailnet, off, with the reason', () => {
  const share = localServerActions(server(), { ...FULL, tailnet: { ...UP, ladderFull: true } }).find(
    (action) => action.id === 'share-tailnet',
  )
  expect(share?.disabled).toBe(true)
  expect(share?.reason).toBeTruthy()
})

test('without the pane, Open is left out', () => {
  expect(ids(localServerActions(server(), { ...FULL, canOpenInPane: false }))).not.toContain('open')
})

test("a paired machine's server opens from here only where its address reaches here, and offers nothing that acts on it", () => {
  const elsewhere = { ...FULL, tailnet: UP, elsewhere: { machineName: 'mac-mini' } }
  const loopback = localServerActions(server({ state: 'stopped', startedByStudio: true }), elsewhere)
  expect(ids(loopback)).toEqual(['open', 'copy-link'])
  expect(loopback[0]).toMatchObject({
    disabled: true,
    reason: 'It listens on mac-mini only, so it opens there, not here.',
  })
  for (const url of ['http://127.0.0.2:3000/', 'http://app.localhost:3000/'])
    expect(localServerActions(server({ url }), elsewhere)[0]?.disabled).toBe(true)
  const reachable = server({ url: 'http://mac-mini.tail1234.ts.net:5173/' })
  expect(ids(localServerActions(reachable, elsewhere))).toEqual(['open', 'open-external', 'copy-link'])
  expect(ids(localServerActions(reachable, { ...elsewhere, canOpenInPane: false }))).toEqual([
    'open-external',
    'copy-link',
  ])
})

test('how a run ended is said only for a stopped server', () => {
  const exit = { code: 1, at: 2, output: 'Error: port in use' }
  expect(localServerExitLine(server({ state: 'stopped', lastExit: exit }))).toBe('Exited with code 1')
  expect(localServerExitLine(server({ state: 'stopped', lastExit: { ...exit, code: null } }))).toBe('Ended by a signal')
  expect(localServerExitLine(server({ state: 'running', lastExit: exit }))).toBe(null)
  expect(localServerExitLine(server({ state: 'stopped' }))).toBe(null)
})

// ── The menu itself ─────────────────────────────────────────────────────────

let root: Root | null = null
let host: HTMLElement | null = null
const api = {
  tailnetShareStatus: vi.fn(async (): Promise<TailnetShareStatus> => UP),
  clipboardWriteText: vi.fn(async (_text: string) => undefined),
  openExternal: vi.fn(async (_url: string) => ({ ok: true })),
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = api
  api.tailnetShareStatus.mockClear()
  api.clipboardWriteText.mockClear()
  api.openExternal.mockClear()
  calls.run.length = 0
  calls.stop.length = 0
  calls.remove.length = 0
  calls.pane.length = 0
  window.localStorage.clear()
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function openMenu(servers: StudioLocalServer[], elsewhere?: { machineName: string }): Promise<void> {
  await act(async () => root?.unmount())
  host?.remove()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root!.render(
      <ConfirmDialogProvider>
        <LocalServersMenu
          workspaceId="ws-1"
          servers={servers}
          ariaLabel="Local servers"
          {...(elsewhere ? { elsewhere } : {})}
          renderTrigger={({ ref, togglePopover, triggerProps }) => (
            <GhostButton ref={ref} onClick={togglePopover} {...triggerProps} data-test-trigger="">
              Servers
            </GhostButton>
          )}
        />
      </ConfirmDialogProvider>,
    ),
  )
  await act(async () => {
    host!.querySelector<HTMLButtonElement>('[data-test-trigger]')!.click()
  })
  for (let i = 0; i < 3; i += 1) await act(async () => await Promise.resolve())
}

function action(id: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`[data-local-server-action="${id}"]`)
}

test('one server lists its state and its actions in the menu, and reads Tailscale only when it opens', async () => {
  expect(api.tailnetShareStatus).not.toHaveBeenCalled()
  await openMenu([server()])
  expect(api.tailnetShareStatus).toHaveBeenCalledTimes(1)
  const section = document.querySelector('[data-local-server="srv-1"]')
  expect(section?.textContent).toContain('localhost:5173')
  expect(section?.textContent).toContain('Running')
  expect(action('open')).not.toBe(null)
  expect(action('share-tailnet')).not.toBe(null)
  expect(action('run')).toBe(null)
})

test("a reopened menu offers nothing tailnet until this opening's read answers", async () => {
  await openMenu([server()])
  expect(action('share-tailnet')).not.toBe(null)
  const toggle = async () =>
    act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-test-trigger]')!.click()
    })
  await toggle()
  // Tailscale went down since; its answer is slow to come.
  let answer: (status: TailnetShareStatus) => void = () => undefined
  api.tailnetShareStatus.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
  await toggle()
  for (let i = 0; i < 3; i += 1) await act(async () => await Promise.resolve())
  expect(action('open')).not.toBe(null)
  expect(action('share-tailnet')).toBe(null)
  await act(async () => answer(EMPTY_TAILNET_SHARE_STATUS))
  expect(action('share-tailnet')).toBe(null)
})

/** The dialog's button labelled `label`, once the question is up. */
function dialogButton(label: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  )
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await act(async () => await Promise.resolve())
}

test('Run again runs the server for its conversation, once the person agrees to its command', async () => {
  await openMenu([server({ state: 'stopped' })])
  await act(async () => action('run')!.click())
  await settle()
  expect(calls.run).toEqual([])
  await act(async () => dialogButton('Run')!.click())
  await settle()
  expect(calls.run).toEqual([[OWNER, 'srv-1']])
})

test('the first run of a command shows it and its folder, and asks; the same command runs without asking again', async () => {
  await openMenu([server({ state: 'stopped', command: 'npm run dev -- --port 4000', cwd: '/Users/dev/app/web' })])
  await act(async () => action('run')!.click())
  await settle()
  const question = document.querySelector('[data-local-server-confirm]')?.textContent
  expect(question).toContain('$ npm run dev -- --port 4000')
  expect(question).toContain('in /Users/dev/app/web')
  // Not agreed: nothing runs, and the next click asks again.
  await act(async () => dialogButton('Cancel')!.click())
  await settle()
  expect(calls.run).toEqual([])

  await openMenu([server({ state: 'stopped', command: 'npm run dev -- --port 4000', cwd: '/Users/dev/app/web' })])
  await act(async () => action('run')!.click())
  await settle()
  await act(async () => dialogButton('Run')!.click())
  await settle()
  expect(calls.run).toHaveLength(1)

  // Agreed once: the same command in the same folder runs at once.
  await openMenu([server({ state: 'stopped', command: 'npm run dev -- --port 4000', cwd: '/Users/dev/app/web' })])
  await act(async () => action('run')!.click())
  await settle()
  expect(document.querySelector('[data-local-server-confirm]')).toBe(null)
  expect(calls.run).toHaveLength(2)
})

test('a command or folder the agent changed since the person agreed is asked about again', async () => {
  window.localStorage.setItem(
    'sprintengine.localServers.confirmedRuns',
    JSON.stringify({ ['ws-1\0agent-1\0srv-1']: { command: 'npm run dev', cwd: '/Users/dev/app' } }),
  )
  for (const changed of [{ command: 'npm run dev && curl example.test' }, { cwd: '/Users/dev' }]) {
    await openMenu([server({ state: 'stopped', ...changed })])
    await act(async () => action('run')!.click())
    await settle()
    expect(document.querySelector('[data-local-server-confirm]')).not.toBe(null)
    await act(async () => dialogButton('Cancel')!.click())
    await settle()
  }
  expect(calls.run).toEqual([])
})

test("each server's actions name the conversation that linked it, which a sidebar row's can differ in", async () => {
  await openMenu([server({ state: 'stopped', agentId: 'agent-2', id: 'srv-9' })])
  await act(async () => action('remove')!.click())
  expect(calls.remove).toEqual([[{ workspaceId: 'ws-1', agentId: 'agent-2' }, 'srv-9']])
})

test('the command Run again runs, and its folder, are shown before it is run', async () => {
  await openMenu([server({ state: 'stopped', command: 'npm run dev', cwd: '/Users/dev/app' })])
  const command = document.querySelector('[data-local-server-command]')?.textContent
  expect(command).toContain('$ npm run dev')
  expect(command).toContain('in /Users/dev/app')
})

test('Open opens the URL in the workspace pane, and Copy link copies it', async () => {
  await openMenu([server()])
  await act(async () => action('open')!.click())
  expect(calls.pane).toEqual([['ws-1', 'http://localhost:5173/']])
  await openMenu([server()])
  await act(async () => action('copy-link')!.click())
  expect(api.clipboardWriteText).toHaveBeenCalledWith('http://localhost:5173/')
})

test('a stopped run says how it ended, and its output is a click away', async () => {
  await openMenu([server({ state: 'stopped', lastExit: { code: 1, at: 2, output: 'Error: port 5173 in use\n' } })])
  expect(document.querySelector('[data-local-server-exit]')?.textContent).toBe('Exited with code 1')
  expect(document.querySelector('[data-local-server-output]')).toBe(null)
  const show = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-menu-item]')).find(
    (item) => item.textContent === 'Show output',
  )
  await act(async () => show!.click())
  expect(document.querySelector('[data-local-server-output]')?.textContent).toBe('Error: port 5173 in use')
})

test('several servers list one row each, with its state', async () => {
  await openMenu([
    server(),
    server({ id: 'srv-2', title: 'Storybook', url: 'http://localhost:6006/', port: 6006, state: 'stopped' }),
  ])
  const rows = Array.from(document.querySelectorAll('[aria-haspopup="menu"][data-menu-item]')).map(
    (row) => row.textContent,
  )
  expect(rows).toEqual(['localhost:5173Running', 'StorybookStopped'])
})

test("a paired machine's server says where it runs, and asks Tailscale here nothing", async () => {
  await openMenu([server()], { machineName: 'mac-mini' })
  expect(document.querySelector('[data-local-server-elsewhere]')?.textContent).toBe('On mac-mini')
  expect(api.tailnetShareStatus).not.toHaveBeenCalled()
  expect(action('open')?.disabled).toBe(true)
  expect(action('remove')).toBe(null)
  await act(async () => action('copy-link')!.click())
  expect(api.clipboardWriteText).toHaveBeenCalledWith('http://localhost:5173/')
  await openMenu([server({ url: 'http://mac-mini.tail1234.ts.net:5173/' })], { machineName: 'mac-mini' })
  await act(async () => action('open')!.click())
  expect(calls.pane).toEqual([['ws-1', 'http://mac-mini.tail1234.ts.net:5173/']])
})
