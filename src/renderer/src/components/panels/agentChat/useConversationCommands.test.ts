import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'
import type { ConversationCommand, ConversationCommandCatalog } from '../../../../../shared/conversation/commands'
import { mergeConversationCommands, studioAppCommands } from './useConversationCommands'
import { chatOverStudioUnderTest, installStudioLoopback } from '../../../../../../tests/studio-chat-loopback'

const CWD = '/Users/dev/project'
const catalog = (commands: ConversationCommand[], extra: Partial<ConversationCommandCatalog> = {}) => ({
  cli: 'claude-code',
  cwd: CWD,
  commands,
  fetchedAt: Date.now(),
  ...extra,
})

test('Studio’s commands come first and win a name the CLI also reports', () => {
  const app = studioAppCommands({ model: true, effort: true })
  expect(app.map((entry) => [entry.name, entry.source])).toEqual([
    ['model', 'app'],
    ['effort', 'app'],
  ])
  const merged = mergeConversationCommands(app, [
    { name: 'Model', description: 'The CLI’s own', source: 'cli' },
    { name: '/compact', source: 'cli' },
    { name: 'compact', source: 'custom' },
    { name: ' ', source: 'cli' },
  ])
  expect(merged.map((entry) => [entry.name, entry.source])).toEqual([
    ['model', 'app'],
    ['effort', 'app'],
    ['compact', 'cli'],
  ])
})

test('a chat with no effort control is not offered /effort', () => {
  expect(studioAppCommands({ model: true, effort: false }).map((entry) => entry.name)).toEqual(['model'])
  expect(studioAppCommands({ model: false, effort: false })).toEqual([])
  expect(studioAppCommands({ model: false, effort: false, terminal: true }).map((entry) => entry.name)).toEqual([
    'terminal',
  ])
})

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
  await cleanup?.()
  cleanup = null
  vi.useRealTimers()
})

async function mountHook(api: Record<string, unknown>) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true }
  Object.assign(globalThis, globals)
  Object.assign(dom.window, { api })
  installStudioLoopback(dom.window as unknown as { api: Record<string, unknown> })
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const hook = await import('./useConversationCommands')
  hook.resetConversationCommandsCache()
  let state!: ReturnType<typeof hook.useConversationCommands>
  let renders = 0
  const appCommands = hook.studioAppCommands({ model: true, effort: false })
  function Harness({ cli, cwd, discover }: { cli: string | null; cwd: string | null; discover: boolean }) {
    state = hook.useConversationCommands(cli, cwd, { appCommands, discover })
    renders += 1
    return null
  }
  let root = createRoot(dom.window.document.createElement('div'))
  const render = (cli: string | null = 'claude-code', cwd: string | null = CWD, discover = true) =>
    act(async () => root.render(createElement(Harness, { cli, cwd, discover })))
  cleanup = async () => {
    await act(async () => root.unmount())
    hook.resetConversationCommandsCache()
    dom.window.close()
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name])
      else Reflect.deleteProperty(globalThis, name)
    }
  }
  return {
    act,
    state: () => state,
    renders: () => renders,
    render,
    async remount() {
      await act(async () => root.unmount())
      root = createRoot(dom.window.document.createElement('div'))
    },
  }
}

test('a chat reads what main holds as it mounts, and asks the CLI only once the menu opens', async () => {
  let answer!: (value: ConversationCommandCatalog) => void
  const conversationCommands = vi.fn((input: { probe?: false }) =>
    input.probe === false
      ? Promise.resolve(catalog([], { fetchedAt: 0 }))
      : new Promise<ConversationCommandCatalog>((resolve) => (answer = resolve)),
  )
  const hook = await mountHook({ conversationCommands, onConversationCommandsChanged: () => () => undefined })
  await hook.render()
  expect(conversationCommands).toHaveBeenCalledExactlyOnceWith({ cli: 'claude-code', cwd: CWD, probe: false })
  expect(hook.state().loading).toBe(false)
  // Studio's own commands are there before the CLI has said anything.
  expect(hook.state().commands.map((entry) => entry.name)).toEqual(['model'])
  await hook.act(async () => hook.state().refreshIfStale())
  expect(conversationCommands).toHaveBeenLastCalledWith({ cli: 'claude-code', cwd: CWD })
  expect(hook.state().loading).toBe(true)
  await hook.act(async () => answer(catalog([{ name: 'compact', source: 'cli' }])))
  expect(hook.state().loading).toBe(false)
  expect(hook.state().commands.map((entry) => entry.name)).toEqual(['model', 'compact'])
})

test('reopening a chat shows the last list at once, without asking again', async () => {
  const conversationCommands = vi.fn(async () => catalog([{ name: 'compact', source: 'cli' }]))
  const hook = await mountHook({ conversationCommands, onConversationCommandsChanged: () => () => undefined })
  await hook.render()
  await hook.remount()
  await hook.render()
  expect(hook.state().loading).toBe(false)
  expect(hook.state().catalog?.commands.map((entry) => entry.name)).toEqual(['compact'])
  expect(conversationCommands).toHaveBeenCalledOnce()
})

test('a list main pushes replaces the one on screen, and one for another folder is kept for later', async () => {
  let push!: (value: ConversationCommandCatalog) => void
  const conversationCommands = vi.fn(async () => catalog([]))
  const hook = await mountHook({
    conversationCommands,
    onConversationCommandsChanged: (listener: (value: ConversationCommandCatalog) => void) => {
      push = listener
      return () => undefined
    },
  })
  await hook.render()
  await hook.act(async () => push(catalog([{ name: 'review', source: 'custom' }])))
  expect(hook.state().catalog?.commands.map((entry) => entry.name)).toEqual(['review'])
  await hook.act(async () => push(catalog([{ name: 'deploy', source: 'skill' }], { cwd: '/Users/dev/other' })))
  expect(hook.state().catalog?.commands.map((entry) => entry.name)).toEqual(['review'])
  await hook.render('claude-code', '/Users/dev/other')
  expect(hook.state().catalog?.commands.map((entry) => entry.name)).toEqual(['deploy'])
  expect(conversationCommands).toHaveBeenCalledOnce()
})

test('opening the menu asks again with refresh only once the list is a few minutes old', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
  const conversationCommands = vi.fn(async () => catalog([{ name: 'compact', source: 'cli' }]))
  const hook = await mountHook({ conversationCommands, onConversationCommandsChanged: () => () => undefined })
  await hook.render()
  await hook.act(async () => hook.state().refreshIfStale())
  expect(conversationCommands).toHaveBeenCalledOnce()
  vi.setSystemTime(1_000_000 + 6 * 60_000)
  await hook.act(async () => hook.state().refreshIfStale())
  expect(conversationCommands).toHaveBeenCalledTimes(2)
  expect(conversationCommands).toHaveBeenLastCalledWith({ cli: 'claude-code', cwd: CWD, refresh: true })
})

test('a restarted session asks again with refresh at once, however fresh the list', async () => {
  const conversationCommands = vi.fn(async () => catalog([{ name: 'compact', source: 'cli' }]))
  const hook = await mountHook({ conversationCommands, onConversationCommandsChanged: () => () => undefined })
  await hook.render()
  await hook.act(async () => hook.state().refreshIfStale())
  expect(conversationCommands).toHaveBeenCalledOnce()
  await hook.act(async () => hook.state().refresh())
  expect(conversationCommands).toHaveBeenCalledTimes(2)
  expect(conversationCommands).toHaveBeenLastCalledWith({ cli: 'claude-code', cwd: CWD, refresh: true })
})

test('a failed ask keeps the last list and carries the error', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
  const conversationCommands = vi
    .fn<() => Promise<ConversationCommandCatalog>>()
    .mockResolvedValueOnce(catalog([{ name: 'compact', source: 'cli' }], { fetchedAt: 1 }))
    .mockRejectedValueOnce(new Error('probe timed out'))
  const hook = await mountHook({ conversationCommands, onConversationCommandsChanged: () => () => undefined })
  await hook.render()
  // The held list is that old, so opening the menu asks again…
  await hook.act(async () => hook.state().refreshIfStale())
  expect(conversationCommands).toHaveBeenCalledTimes(2)
  expect(hook.state().catalog).toMatchObject({ error: 'probe timed out', fetchedAt: 1 })
  expect(hook.state().commands.map((entry) => entry.name)).toEqual(['model', 'compact'])
  // …but a failed ask is not repeated at once.
  await hook.act(async () => hook.state().refreshIfStale())
  expect(conversationCommands).toHaveBeenCalledTimes(2)
})

test('a chat that must not discover never asks, and shows a list only once one reaches it', async () => {
  let push!: (value: ConversationCommandCatalog) => void
  const conversationCommands = vi.fn(async () => catalog([]))
  const hook = await mountHook({
    conversationCommands,
    onConversationCommandsChanged: (listener: (value: ConversationCommandCatalog) => void) => {
      push = listener
      return () => undefined
    },
  })
  await hook.render('claude-code', 'remote-root', false)
  await hook.act(async () => hook.state().refreshIfStale())
  expect(conversationCommands).not.toHaveBeenCalled()
  expect(hook.state().catalog).toBeNull()
  await hook.act(async () => push(catalog([{ name: 'compact', source: 'cli' }], { cwd: 'remote-root' })))
  expect(hook.state().catalog?.commands).toHaveLength(1)
})

// A window on the Studio protocol always has the list: its own Studio serves it.
test.skipIf(chatOverStudioUnderTest())('a preload without the command list leaves Studio’s own commands', async () => {
  const hook = await mountHook({})
  await hook.render()
  await hook.act(async () => hook.state().refreshIfStale())
  expect(hook.state().loading).toBe(false)
  expect(hook.state().catalog).toBeNull()
  expect(hook.state().commands.map((entry) => entry.name)).toEqual(['model'])
})

test('a list pushed under another spelling of the chat’s folder is the chat’s list', async () => {
  let push!: (value: ConversationCommandCatalog) => void
  const conversationCommands = vi.fn(async () => catalog([]))
  const hook = await mountHook({
    conversationCommands,
    onConversationCommandsChanged: (listener: (value: ConversationCommandCatalog) => void) => {
      push = listener
      return () => undefined
    },
  })
  await hook.render('claude-code', `${CWD}/`)
  await hook.act(async () => push(catalog([{ name: 'review', source: 'cli' }], { cwd: `${CWD}//.` })))
  expect(hook.state().catalog?.commands.map((entry) => entry.name)).toEqual(['review'])
})

test('a list for another folder does not re-render a chat reading this one', async () => {
  let push!: (value: ConversationCommandCatalog) => void
  const hook = await mountHook({
    conversationCommands: vi.fn(async () => catalog([])),
    onConversationCommandsChanged: (listener: (value: ConversationCommandCatalog) => void) => {
      push = listener
      return () => undefined
    },
  })
  await hook.render()
  const before = hook.renders()
  await hook.act(async () => push(catalog([{ name: 'deploy', source: 'skill' }], { cwd: '/Users/dev/other' })))
  expect(hook.renders()).toBe(before)
  await hook.act(async () => push(catalog([{ name: 'review', source: 'cli' }])))
  expect(hook.renders()).toBeGreaterThan(before)
})

test('Studio lists /btw only for a chat that answers side questions', () => {
  const names = (sideQuestion: boolean) =>
    studioAppCommands({ model: true, effort: false, sideQuestion }).map((command) => command.name)
  expect(names(true)).toContain('btw')
  expect(names(false)).not.toContain('btw')
})
