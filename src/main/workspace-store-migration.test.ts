import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import { migrateWorkspaceStore, storePathOfLegacy } from './workspace-store-migration'
import { workspaceStoreRoot } from './workspace-store'

const made: string[] = []

function folder(prefix = 'se-migrate-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  made.push(dir)
  return dir
}

beforeEach(() => {
  process.env.SPRINTENGINE_STORE_HOME = folder('se-migrate-home-')
})

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** A project folder that is no repository: git tracks nothing in it. */
const untracked = { trackedFiles: async () => new Set<string>() }

/** Every file under a folder, `/`-separated and sorted. */
function filesUnder(root: string, at = ''): string[] {
  if (!existsSync(join(root, at))) return []
  return readdirSync(join(root, at), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = at ? `${at}/${entry.name}` : entry.name
      return entry.isDirectory() ? filesUnder(root, rel) : [rel]
    })
    .sort()
}

test('everything the store keeps is moved out, the ignore stubs go, and so does the emptied folder', async () => {
  const project = folder()
  const sidecar = join(project, '.sprintengine')
  put(join(sidecar, 'conversations', '.gitignore'), '*\n')
  put(join(sidecar, 'conversations', 'chat-1', 'claude.jsonl'), '{"seq":1}\n')
  put(join(sidecar, 'conversations', 'chat-1', 'claude.tools', 'tool-1.json'), '{}')
  put(join(sidecar, 'backlog', 'config.json'), '{"key":"MC"}\n')
  put(join(sidecar, 'backlog', 'cache', '.gitignore'), '*\n')
  put(join(sidecar, 'backlog', 'cache', 'links.json'), '{"items":[]}\n')
  put(join(sidecar, 'browser', '.gitignore'), '*\n')
  put(join(sidecar, 'browser', 'screenshot-example.png'), 'png')
  put(join(sidecar, 'browser', 'recordings', 'recording-1.webm'), 'webm')
  put(join(sidecar, 'modules', 'acme.notes', 'list.json'), '[]')
  put(join(sidecar, 'automations', 'nightly.json'), '{}')
  put(join(sidecar, 'review', 'pr-1.json'), '{}')

  const report = await migrateWorkspaceStore(project, untracked)
  const store = workspaceStoreRoot(project)
  assert.equal(report.store, store)
  assert.equal(existsSync(sidecar), false, 'the emptied sidecar is gone')
  assert.deepEqual(
    filesUnder(store).filter((path) => !path.startsWith('.migrate') && path !== 'workspace.json'),
    [
      'backlog/cache/links.json',
      'backlog/config.json',
      'browser/recordings/recording-1.webm',
      'browser/screenshot-example.png',
      'conversations/chat-1/claude.jsonl',
      'conversations/chat-1/claude.tools/tool-1.json',
      'legacy/automations/nightly.json',
      'legacy/review/pr-1.json',
      'modules/acme.notes/list.json',
    ],
  )
  assert.equal(readFileSync(join(store, 'conversations', 'chat-1', 'claude.jsonl'), 'utf8'), '{"seq":1}\n')
  assert.equal(report.moved, 9)
  assert.ok(existsSync(join(store, '.migrate.journal')), 'what the run did is journalled')
  assert.equal(existsSync(join(store, '.migrate.lock')), false, 'the lock is released')
})

test('what the store does not keep, a link, and a person’s own ignore file stay where they are', async () => {
  const project = folder()
  const sidecar = join(project, '.sprintengine')
  const elsewhere = folder()
  put(join(elsewhere, 'secret.txt'), 'not ours')
  put(join(sidecar, 'hooks', 'agent-state.mjs'), '// hook')
  put(join(sidecar, 'browser', '.gitignore'), '*.png\n')
  put(join(sidecar, 'browser', 'shot.png'), 'png')
  mkdirSync(join(sidecar, 'conversations'), { recursive: true })
  symlinkSync(elsewhere, join(sidecar, 'conversations', 'linked'))
  const logged: string[] = []

  const report = await migrateWorkspaceStore(project, { ...untracked, log: (line) => logged.push(line) })
  assert.ok(existsSync(join(sidecar, 'hooks', 'agent-state.mjs')))
  assert.equal(readFileSync(join(sidecar, 'browser', '.gitignore'), 'utf8'), '*.png\n')
  assert.ok(existsSync(join(workspaceStoreRoot(project), 'browser', 'shot.png')))
  assert.ok(existsSync(join(elsewhere, 'secret.txt')), 'nothing is read or removed through a link')
  assert.equal(existsSync(join(workspaceStoreRoot(project), 'conversations', 'linked')), false)
  assert.equal(report.left.length, 3)
  assert.ok(logged.some((line) => line.includes('hooks') && line.includes('left in place')))
})

test('a file git tracks stays in the project', async () => {
  const project = folder()
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=dev', '-c', 'user.email=dev@example.com', ...args], {
      cwd: project,
      stdio: 'pipe',
    })
  git('init', '-q')
  put(join(project, '.sprintengine', 'backlog', 'config.json'), '{"key":"MC"}\n')
  git('add', '.sprintengine/backlog/config.json')
  git('commit', '-q', '-m', 'commit the key')
  put(join(project, '.sprintengine', 'backlog', 'cache', 'links.json'), '{}')

  const report = await migrateWorkspaceStore(project)
  assert.equal(readFileSync(join(project, '.sprintengine', 'backlog', 'config.json'), 'utf8'), '{"key":"MC"}\n')
  assert.equal(existsSync(join(project, '.sprintengine', 'backlog', 'cache')), false)
  assert.ok(existsSync(join(workspaceStoreRoot(project), 'backlog', 'cache', 'links.json')))
  assert.equal(existsSync(join(workspaceStoreRoot(project), 'backlog', 'config.json')), false)
  assert.deepEqual(report.left, [join(project, '.sprintengine', 'backlog', 'config.json')])
})

test('across disks a file is copied, checked, and only then removed, with its time kept', async () => {
  const project = folder()
  const source = join(project, '.sprintengine', 'conversations', 'chat-1', 'codex.jsonl')
  put(source, '{"seq":1}\n{"seq":2}\n')
  const then = new Date('2026-10-01T12:00:00Z')
  utimesSync(source, then, then)
  const crossDevice = async () => {
    throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
  }

  await migrateWorkspaceStore(project, { ...untracked, rename: crossDevice })
  const moved = join(workspaceStoreRoot(project), 'conversations', 'chat-1', 'codex.jsonl')
  assert.equal(readFileSync(moved, 'utf8'), '{"seq":1}\n{"seq":2}\n')
  assert.equal(statSync(moved).mtime.getTime(), then.getTime())
  assert.equal(existsSync(source), false)
  assert.deepEqual(
    readdirSync(dirname(moved)).filter((name) => name.includes('.migrating-')),
    [],
    'no temporary copy is left',
  )
})

test('every worktree of the project is moved into the one store, and two copies of a transcript are both kept', async () => {
  const parent = folder()
  const project = join(parent, 'acme')
  const worktree = join(parent, '.sprintengine-worktrees', 'acme', 'pool-01')
  mkdirSync(project)
  // The same chat in both checkouts (it moved between them): the longer one
  // keeps the name; the other is kept beside it, under a name the thread
  // index does not list as an agent.
  put(join(project, '.sprintengine', 'conversations', 'chat-1', 'claude.jsonl'), '{"seq":1}\n')
  put(join(worktree, '.sprintengine', 'conversations', 'chat-1', 'claude.jsonl'), '{"seq":1}\n{"seq":2}\n')
  // A chat only the worktree ran, and one file both hold the same bytes of.
  put(join(worktree, '.sprintengine', 'conversations', 'chat-2', 'codex.jsonl'), '{"seq":1}\n')
  put(join(project, '.sprintengine', 'browser', 'same.png'), 'png')
  put(join(worktree, '.sprintengine', 'browser', 'same.png'), 'png')
  // Differing captures under one name: both kept, the second openable.
  put(join(project, '.sprintengine', 'browser', 'shot.png'), 'first')
  put(join(worktree, '.sprintengine', 'browser', 'shot.png'), 'second')

  const report = await migrateWorkspaceStore(project, untracked)
  const store = workspaceStoreRoot(project)
  assert.equal(workspaceStoreRoot(worktree), store)
  assert.equal(report.sources.length, 2)
  const chat = readdirSync(join(store, 'conversations', 'chat-1')).sort()
  assert.equal(chat.length, 2)
  assert.equal(chat[0], 'claude.jsonl')
  assert.match(chat[1], /^claude\.jsonl\.conflict-[0-9a-f]{8}$/u)
  assert.equal(readFileSync(join(store, 'conversations', 'chat-1', 'claude.jsonl'), 'utf8'), '{"seq":1}\n{"seq":2}\n')
  assert.ok(existsSync(join(store, 'conversations', 'chat-2', 'codex.jsonl')))
  const browser = readdirSync(join(store, 'browser')).sort()
  assert.equal(browser.filter((name) => name.startsWith('same')).length, 1, 'identical copies become one')
  assert.equal(readFileSync(join(store, 'browser', 'shot.png'), 'utf8'), 'first')
  assert.ok(browser.some((name) => /^shot\.conflict-[0-9a-f]{8}\.png$/u.test(name)))
  assert.equal(existsSync(join(project, '.sprintengine')), false)
  assert.equal(existsSync(join(worktree, '.sprintengine')), false)
  const manifest = JSON.parse(readFileSync(join(store, 'workspace.json'), 'utf8')) as { aliases: string[] }
  assert.ok(manifest.aliases.includes(worktree))
})

test('config: the project’s own checkout wins over a worktree’s and over the store’s; a cache keeps the store’s', async () => {
  const parent = folder()
  const project = join(parent, 'acme')
  const worktree = join(parent, '.sprintengine-worktrees', 'acme', 'chat-1')
  mkdirSync(project)
  const store = workspaceStoreRoot(project)
  put(join(store, 'backlog', 'config.json'), '{"key":"NEW"}\n')
  put(join(store, 'backlog', 'cache', 'links.json'), '{"fresh":true}\n')
  put(join(project, '.sprintengine', 'backlog', 'config.json'), '{"key":"MC"}\n')
  put(join(project, '.sprintengine', 'backlog', 'cache', 'links.json'), '{"stale":true}\n')
  put(join(worktree, '.sprintengine', 'backlog', 'config.json'), '{"key":"CHAT"}\n')

  await migrateWorkspaceStore(project, untracked)
  assert.equal(readFileSync(join(store, 'backlog', 'config.json'), 'utf8'), '{"key":"MC"}\n')
  const aside = readdirSync(join(store, 'backlog')).filter((name) => name.startsWith('config.json.conflict-'))
  assert.equal(aside.length, 1, 'the store’s own config is kept aside, not lost')
  assert.equal(readFileSync(join(store, 'backlog', aside[0]), 'utf8'), '{"key":"NEW"}\n')
  assert.equal(readFileSync(join(store, 'backlog', 'cache', 'links.json'), 'utf8'), '{"fresh":true}\n')
  assert.equal(existsSync(join(worktree, '.sprintengine')), false)
})

test('running the move again changes nothing', async () => {
  const project = folder()
  put(join(project, '.sprintengine', 'conversations', 'chat-1', 'claude.jsonl'), '{"seq":1}\n')
  put(join(project, '.sprintengine', 'hooks', 'agent-state.mjs'), '// hook')
  await migrateWorkspaceStore(project, untracked)
  const store = workspaceStoreRoot(project)
  const before = filesUnder(store).filter((path) => !path.startsWith('.migrate'))
  const again = await migrateWorkspaceStore(project, untracked)
  assert.equal(again.moved, 0)
  assert.equal(again.conflicts.length, 0)
  assert.deepEqual(
    filesUnder(store).filter((path) => !path.startsWith('.migrate')),
    before,
  )
  assert.ok(existsSync(join(project, '.sprintengine', 'hooks', 'agent-state.mjs')))
  // A run that stopped after its copy and before removing the source: the
  // source is the same bytes the store holds, so it is dropped.
  put(join(project, '.sprintengine', 'conversations', 'chat-1', 'claude.jsonl'), '{"seq":1}\n')
  const resumed = await migrateWorkspaceStore(project, untracked)
  assert.equal(resumed.dropped, 1)
  assert.equal(existsSync(join(project, '.sprintengine', 'conversations')), false)
})

test('a lock another live run holds is respected; one a dead run left is taken over', async () => {
  const project = folder()
  put(join(project, '.sprintengine', 'browser', 'shot.png'), 'png')
  const store = workspaceStoreRoot(project)
  const { hostname } = await import('node:os')
  put(join(store, '.migrate.lock'), JSON.stringify({ pid: process.pid, host: hostname(), startedAt: Date.now() }))
  const held = await migrateWorkspaceStore(project, untracked)
  assert.equal(held.skipped, 'locked')
  assert.ok(existsSync(join(project, '.sprintengine', 'browser', 'shot.png')))

  put(join(store, '.migrate.lock'), JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), startedAt: Date.now() }))
  const taken = await migrateWorkspaceStore(project, untracked)
  assert.equal(taken.skipped, undefined)
  assert.ok(existsSync(join(store, 'browser', 'shot.png')))
})

test('an older path under the sidecar is found in the store', () => {
  assert.deepEqual(storePathOfLegacy(['browser', 'recordings', 'a.webm']), ['browser', 'recordings', 'a.webm'])
  assert.deepEqual(storePathOfLegacy(['review', 'pr-1.json']), ['legacy', 'review', 'pr-1.json'])
  assert.equal(storePathOfLegacy(['hooks', 'agent-state.mjs']), null)
  assert.equal(storePathOfLegacy([]), null)
})
