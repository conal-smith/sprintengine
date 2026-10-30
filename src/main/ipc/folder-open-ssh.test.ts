// A folder on an SSH machine opens in an editor here that reaches it over SSH
// itself, from its Remote - SSH link, and never touches this computer's disk.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { registerFolderOpenIpc, type FolderOpenIpcDependencies } from './folder-open-ipc'
import { sshRemoteFolderUrl, type FolderOpenResult } from '../../shared/folder-open-targets'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

function harness(destinations: Record<string, string>) {
  const handlers = new Map<string, Handler>()
  const opened: string[] = []
  const touched: string[] = []
  const deps: FolderOpenIpcDependencies = {
    showItemInFolder: async (path) => void touched.push(path),
    resolveLauncher: (target) =>
      target === 'finder' ? { kind: 'reveal' } : { kind: 'command', command: 'code', args: [] },
    runLauncher: async (command, args) => {
      touched.push([command, ...args].join(' '))
      return { ok: true }
    },
    assertPathReachable: async (path) => void touched.push(path),
    openExternal: async (url) => void opened.push(url),
    sshDestination: (id) => destinations[id] ?? null,
  }
  registerFolderOpenIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as never,
    deps,
  )
  const open = (target: string, path: string) =>
    handlers.get('fs:open-folder-in-target')!({}, { target, path }) as Promise<FolderOpenResult>
  return { open, opened, touched }
}

test('a folder on an SSH machine opens in VS Code from its Remote - SSH link', async () => {
  const h = harness({ m1: 'build-box' })
  assert.deepEqual(await h.open('vscode', 'ssh://m1/home/dev/my app'), { ok: true, target: 'vscode' })
  assert.deepEqual(h.opened, ['vscode://vscode-remote/ssh-remote+build-box/home/dev/my%20app'])
  assert.deepEqual(h.touched, [], 'nothing on this computer is opened or read')
})

test('an editor without Remote - SSH, or a machine not saved here, is refused in words', async () => {
  const h = harness({ m1: 'build-box' })
  const zed = await h.open('zed', 'ssh://m1/home/dev/app')
  assert.equal(zed.ok, false)
  const finder = await h.open('finder', 'ssh://m1/home/dev/app')
  assert.equal(finder.ok, false)
  const unknown = await h.open('vscode', 'ssh://m9/home/dev/app')
  assert.equal(unknown.ok, false)
  assert.deepEqual(h.opened, [])
  assert.deepEqual(h.touched, [])
})

test('the Remote - SSH link carries an alias or user@host, and refuses a port', () => {
  assert.deepEqual(sshRemoteFolderUrl('vscode-insiders', 'dev@build-box', '/srv/app'), {
    ok: true,
    url: 'vscode-insiders://vscode-remote/ssh-remote+dev@build-box/srv/app',
  })
  assert.equal(sshRemoteFolderUrl('vscode', 'build-box:2222', '/srv/app').ok, false)
  assert.equal(sshRemoteFolderUrl('vscode', 'build-box', 'srv/app').ok, false)
  assert.equal(sshRemoteFolderUrl('cursor', 'build-box', '/srv/app').ok, false)
})
