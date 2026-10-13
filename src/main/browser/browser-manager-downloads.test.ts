import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

// The pane's session and its guest, reduced to what registering a tab and
// routing a download touch.
const browserSession = Object.assign(new EventEmitter(), {
  getUserAgent: () => 'Mozilla/5.0 Chrome/140.0',
  setUserAgent: () => {},
  setPermissionRequestHandler: () => {},
  setPermissionCheckHandler: () => {},
})
const host = { id: 1, isDestroyed: () => false, send: () => {} }
const guest = Object.assign(new EventEmitter(), {
  id: 7,
  session: browserSession,
  hostWebContents: host,
  getType: () => 'webview',
  isDestroyed: () => false,
  isLoading: () => false,
  isDevToolsOpened: () => false,
  getURL: () => 'http://localhost:5173/exports',
  getTitle: () => 'Exports',
  navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  setWindowOpenHandler: () => {},
  setZoomFactor: () => {},
})

vi.mock('electron', () => ({
  session: { fromPartition: () => browserSession },
  webContents: { fromId: (id: number) => (id === guest.id ? guest : undefined) },
}))

const { createBrowserManager } = await import('./browser-manager')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'browser-downloads-')))
  roots.push(root)
  const manager = createBrowserManager({
    listTerminalRoots: () => [],
    isHostWindow: () => true,
    broadcast: () => {},
    resolveWorkspaceRoot: () => root,
  })
  const registered = manager.register({ tabId: 't1', workspaceId: 'w1', webContentsId: guest.id }, host as never)
  expect(registered.ok).toBe(true)
  const told: Array<{ tabId: string; path: string; state: string }> = []
  manager.onDownload((tabId, download) => told.push({ tabId, path: download.path, state: download.state }))
  const download = (filename: string) => {
    const done = new EventEmitter()
    const item = {
      savedTo: null as string | null,
      getFilename: () => filename,
      getURL: () => `http://localhost:5173/files/${filename}`,
      setSavePath(path: string) {
        item.savedTo = path
      },
      once: (event: string, listener: (...args: unknown[]) => void) => done.once(event, listener),
      finish: (state: string) => done.emit('done', {}, state),
    }
    browserSession.emit('will-download', {}, item, guest)
    return item
  }
  return { root, manager, told, download, close: () => manager.unregister('t1') }
}

test('a download the agent’s tab sets off is saved to the workspace’s browser sidecar, with no dialog', () => {
  const f = fixture()
  f.manager.noteAgentActivity('t1')
  const item = f.download('../report.csv')
  const directory = join(f.root, '.sprintengine', 'browser', 'downloads')
  expect(item.savedTo).toBe(join(directory, 'report.csv'))
  expect(readFileSync(join(f.root, '.sprintengine', 'browser', '.gitignore'), 'utf8')).toBe('*\n')
  item.finish('completed')
  expect(f.told).toEqual([
    { tabId: 't1', path: join(directory, 'report.csv'), state: 'started' },
    { tabId: 't1', path: join(directory, 'report.csv'), state: 'completed' },
  ])
  f.close()
})

test('two agent downloads of one name are saved under different names', () => {
  const f = fixture()
  f.manager.noteAgentActivity('t1')
  const first = f.download('report.csv')
  const second = f.download('report.csv')
  expect(first.savedTo).not.toBeNull()
  expect(second.savedTo).not.toBeNull()
  expect(second.savedTo).not.toBe(first.savedTo)
  f.close()
})

test('a download the person sets off is left to the save dialog', () => {
  const f = fixture()
  const item = f.download('report.csv')
  expect(item.savedTo).toBeNull()
  expect(f.told).toEqual([])
  f.close()
})
