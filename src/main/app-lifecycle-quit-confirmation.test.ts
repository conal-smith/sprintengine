import assert from 'node:assert/strict'
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest'

import { standIn } from '../../tests/stand-in'
import { createQuitConfirmation, QUIT_SIGNALS, type QuitConfirmation, type QuitDecision } from './quit-confirmation'

// The lifecycle's half of the quit question, with Electron replaced: which
// quits are asked, what each answer does, and which quits are never asked.
// The question's own rules are quit-confirmation.test.ts's.

type Handler = (...args: unknown[]) => unknown

const appEvents = new Map<string, Handler[]>()
const exitCalls: number[] = []
let quitCalls = 0
// Electron's `app.quit()` emits `before-quit`; the tests that follow a quit
// all the way to the exit turn this on.
let quitEmitsBeforeQuit = false
const windowsCreated: unknown[] = []

const mockApp = {
  isPackaged: false,
  on(event: string, handler: Handler) {
    appEvents.set(event, [...(appEvents.get(event) ?? []), handler])
    return mockApp
  },
  once(event: string, handler: Handler) {
    return mockApp.on(event, handler)
  },
  whenReady: () => new Promise<void>(() => {}),
  quit: () => {
    quitCalls += 1
    if (quitEmitsBeforeQuit)
      for (const handler of appEvents.get('before-quit') ?? []) handler({ preventDefault: () => {} })
  },
  relaunch: () => undefined,
  exit: (code: number) => {
    exitCalls.push(code)
  },
  getPath: () => '/tmp/sprintengine-lifecycle-quit-test',
  getAppPath: () => '/tmp/sprintengine-lifecycle-quit-test',
  setAppLogsPath: () => undefined,
  setAsDefaultProtocolClient: () => true,
}

const mockElectron = {
  app: mockApp,
  BrowserWindow: { getAllWindows: () => [] as unknown[] },
  ipcMain: { on: () => undefined, once: () => undefined, handle: () => undefined },
  Menu: { setApplicationMenu: () => undefined, buildFromTemplate: () => ({}) },
  net: { isOnline: () => false },
  Tray: class {},
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  shell: { openExternal: async () => undefined },
  dialog: {},
  powerMonitor: { on: () => undefined },
  session: { defaultSession: { webRequest: { onHeadersReceived: () => undefined } } },
  nativeTheme: { on: () => undefined, shouldUseDarkColors: false },
  powerSaveBlocker: { start: () => 0, stop: () => undefined, isStarted: () => false },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
}

let registerAppLifecycle: typeof import('./app-lifecycle').registerAppLifecycle

beforeAll(async () => {
  standIn({ electron: mockElectron })
  // Cancel after the last window closed opens a new one; what is opened is
  // the window factory's business, not this suite's.
  vi.doMock('./window-factory', () => ({
    createMainWindow: (options: unknown) => void windowsCreated.push(options),
    isWorkspaceWindowWebContents: () => false,
    listWorkspaceWindows: () => [],
    markAppQuitInProgressForWindowClose: () => undefined,
    revealMainWindow: () => undefined,
    workspaceWindowIdOf: () => 'primary',
  }))
  ;({ registerAppLifecycle } = await import('./app-lifecycle'))
})

// Every registration listens for the quit signals on the real `process`.
let signalListenersBefore = new Map<string, Set<unknown>>()
beforeEach(() => {
  appEvents.clear()
  exitCalls.length = 0
  quitCalls = 0
  quitEmitsBeforeQuit = false
  windowsCreated.length = 0
  signalListenersBefore = new Map(QUIT_SIGNALS.map((signal) => [signal, new Set(process.listeners(signal))]))
})
afterEach(() => {
  for (const signal of QUIT_SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!signalListenersBefore.get(signal)?.has(listener)) process.off(signal, listener)
    }
  }
})

const settle = async () => {
  for (let pass = 0; pass < 30; pass += 1) await new Promise((resolve) => setImmediate(resolve))
}

function register(
  decision: QuitDecision | Pick<QuitConfirmation, 'confirm' | 'quitWithoutAsking'>,
  options: { allowMultipleInstances?: boolean; terminalShutdown?: () => Promise<void> } = {},
) {
  const calls = { confirm: 0, quitWithoutAsking: 0, terminals: 0 }
  let prepareForInstall: (() => Promise<void>) | null = null
  registerAppLifecycle({
    diagnosticsEnabled: false,
    allowMultipleInstances: options.allowMultipleInstances ?? true,
    terminalRuntime: {
      shutdown: async () => {
        calls.terminals += 1
        await options.terminalShutdown?.()
      },
    },
    quitConfirmation:
      typeof decision === 'string'
        ? {
            confirm: async () => {
              calls.confirm += 1
              return decision
            },
            quitWithoutAsking: () => {
              calls.quitWithoutAsking += 1
            },
          }
        : decision,
    updateService: {
      checkForUpdates: async () => undefined,
      setPrepareForInstall: (prepare: () => Promise<void>) => {
        prepareForInstall = prepare
      },
    } as unknown as Parameters<typeof registerAppLifecycle>[0]['updateService'],
    handleAuthCallback: () => undefined,
  })
  const beforeQuit = () => {
    let prevented = false
    appEvents.get('before-quit')?.[0]?.({ preventDefault: () => (prevented = true) })
    return prevented
  }
  return { calls, beforeQuit, prepareForInstall: () => prepareForInstall!() }
}

test('a quit the person confirms runs the shutdown and exits', async () => {
  const { calls, beforeQuit } = register('quit')
  assert.equal(beforeQuit(), true, 'held while the question is up')
  await settle()
  assert.equal(calls.confirm, 1)
  assert.equal(calls.terminals, 1)
  assert.deepEqual(exitCalls, [0])
})

test('a relaunch while the shutdown runs opens no window', async () => {
  let finishTerminals = () => {}
  const terminalsStopping = new Promise<void>((resolve) => (finishTerminals = resolve))
  const { calls, beforeQuit } = register('quit', {
    allowMultipleInstances: false,
    terminalShutdown: () => terminalsStopping,
  })
  beforeQuit()
  await settle()
  assert.equal(calls.terminals, 1, 'the shutdown is running')
  appEvents.get('second-instance')?.[0]?.({}, ['/opt/SprintEngine Studio/sprintengine-studio'])
  assert.equal(windowsCreated.length, 0, 'a window opened now would be gone when the app exits')
  finishTerminals()
  await settle()
  assert.deepEqual(exitCalls, [0])
})

test('a relaunch with no window open, and no quit under way, opens one', () => {
  register('quit', { allowMultipleInstances: false })
  appEvents.get('second-instance')?.[0]?.({}, ['/opt/SprintEngine Studio/sprintengine-studio'])
  assert.equal(windowsCreated.length, 1)
})

test('Cancel keeps the app: no shutdown, no exit', async () => {
  const { calls, beforeQuit } = register('stay')
  assert.equal(beforeQuit(), true)
  await settle()
  assert.equal(calls.confirm, 1)
  assert.equal(calls.terminals, 0)
  assert.deepEqual(exitCalls, [])
})

test('a second quit while the question is up does nothing of its own', async () => {
  const { calls, beforeQuit } = register('pending')
  beforeQuit()
  await settle()
  assert.equal(calls.terminals, 0)
  assert.deepEqual(exitCalls, [])
})

test('"Restart to update" is never asked: its quit joins the shutdown it already ran', async () => {
  const { calls, beforeQuit, prepareForInstall } = register('stay')
  await prepareForInstall()
  assert.equal(calls.quitWithoutAsking, 1)
  assert.equal(calls.terminals, 1)
  beforeQuit()
  await settle()
  assert.equal(calls.confirm, 0, 'the updater’s own quit is not a question')
  assert.deepEqual(exitCalls, [0])
})

test('a logout or shutdown on Windows marks the quit as the OS’s', () => {
  const { calls } = register('quit')
  const windowEvents = new Map<string, Handler>()
  appEvents.get('browser-window-created')?.[0]?.(
    {},
    { on: (event: string, handler: Handler) => void windowEvents.set(event, handler) },
  )
  windowEvents.get('query-session-end')?.()
  windowEvents.get('session-end')?.()
  assert.equal(calls.quitWithoutAsking, 2)
})

test('closing the last window where that quits asks first, and quits on Quit', async () => {
  // Not macOS and no background mode: the last window closing is a quit.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'linux' })
  let calls: ReturnType<typeof register>['calls']
  try {
    ;({ calls } = register('quit'))
    appEvents.get('window-all-closed')?.[0]?.()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
  await settle()
  assert.equal(calls.confirm, 1)
  assert.equal(quitCalls, 1)
})

test('Cancel after the last window closed brings a window back, and does not quit', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'linux' })
  let calls: ReturnType<typeof register>['calls']
  try {
    ;({ calls } = register('stay'))
    appEvents.get('window-all-closed')?.[0]?.()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
  await settle()
  assert.equal(calls.confirm, 1)
  assert.equal(quitCalls, 0)
  assert.equal(windowsCreated.length, 1, 'a process with nothing on screen is not left behind')
  assert.equal(calls.terminals, 0)
  assert.deepEqual(exitCalls, [])
})

test('a signal quits without asking, and the ordered shutdown runs before the exit', async () => {
  quitEmitsBeforeQuit = true
  const asked: number[] = []
  const confirmation = createQuitConfirmation({
    isEnabled: () => true,
    stopAsking: () => undefined,
    countWorkingAgents: async () => 3,
    ask: ({ count }) => {
      asked.push(count)
      return new Promise(() => {})
    },
  })
  const { calls } = register(confirmation)
  process.emit('SIGTERM')
  await settle()
  assert.deepEqual(asked, [], 'nobody is there to answer')
  assert.equal(quitCalls, 1)
  assert.equal(calls.terminals, 1, 'the shutdown legs ran')
  assert.deepEqual(exitCalls, [0])
  // A second signal while it leaves is the same quit.
  process.emit('SIGINT')
  await settle()
  assert.equal(quitCalls, 1)
  assert.equal(calls.terminals, 1)
})

test('a signal while the question is up takes it down and quits', async () => {
  quitEmitsBeforeQuit = true
  const signals: AbortSignal[] = []
  const confirmation = createQuitConfirmation({
    isEnabled: () => true,
    stopAsking: () => undefined,
    countWorkingAgents: async () => 1,
    ask: ({ signal }) => {
      signals.push(signal)
      return new Promise((resolve) =>
        signal.addEventListener('abort', () => resolve({ quit: false, dontAskAgain: false })),
      )
    },
  })
  const { calls, beforeQuit } = register(confirmation)
  beforeQuit()
  await settle()
  assert.equal(signals.length, 1, 'Cmd+Q put the question up')
  process.emit('SIGHUP')
  await settle()
  assert.equal(signals[0]?.aborted, true)
  assert.equal(calls.terminals, 1)
  assert.deepEqual(exitCalls, [0])
})
