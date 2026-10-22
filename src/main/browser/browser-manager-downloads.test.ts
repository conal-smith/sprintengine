import { EventEmitter } from 'node:events'
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import { workspaceStorePath } from '../workspace-store'

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
  const urls: string[] = []
  manager.onDownload((tabId, download) => {
    told.push({ tabId, path: download.path, state: download.state })
    urls.push(download.url)
  })
  const download = (filename: string, url = `http://localhost:5173/files/${filename}`) => {
    const done = new EventEmitter()
    const item = {
      savedTo: null as string | null,
      getFilename: () => filename,
      getURL: () => url,
      setSavePath(path: string) {
        item.savedTo = path
      },
      once: (event: string, listener: (...args: unknown[]) => void) => done.once(event, listener),
      finish: (state: string) => done.emit('done', {}, state),
    }
    browserSession.emit('will-download', {}, item, guest)
    return item
  }
  return { root, manager, told, urls, download, close: () => manager.unregister('t1') }
}

test('a download the agent’s tab sets off is saved to the project’s store, with no dialog', () => {
  const f = fixture()
  f.manager.noteAgentActivity('t1')
  const item = f.download('../report.csv')
  const directory = workspaceStorePath(f.root, 'browser', 'downloads')
  expect(item.savedTo).toBe(join(directory, 'report.csv'))
  expect(readdirSync(f.root)).toEqual([])
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

test('a download from a data: URL is told by its type alone, never its bytes', () => {
  const f = fixture()
  f.manager.noteAgentActivity('t1')
  f.download('export.csv', `data:text/csv;base64,${'QUJD'.repeat(10_000)}`)
  f.download('report.csv')
  expect(f.urls).toEqual(['data:text/csv,…', 'http://localhost:5173/files/report.csv'])
  f.close()
})

test.skipIf(process.platform === 'win32')('the downloads folder is the person’s alone', () => {
  const f = fixture()
  f.manager.noteAgentActivity('t1')
  f.download('report.csv')
  expect(statSync(workspaceStorePath(f.root, 'browser', 'downloads')).mode & 0o777).toBe(0o700)
  f.close()
})
