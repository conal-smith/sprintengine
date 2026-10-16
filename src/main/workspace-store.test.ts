import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'

import {
  conversationConfinementRoot,
  ensureWorkspaceStore,
  migrateWorkspaceStoreInBackground,
  projectRootOf,
  setWorkspaceStoreMigrator,
  storeRootContaining,
  workspaceStoreProject,
  workspaceStoreReady,
  workspaceStoreRoot,
  workspaceStoresRoot,
} from './workspace-store'

const made: string[] = []
let home = ''

function folder(prefix = 'se-store-'): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  made.push(dir)
  return dir
}

beforeEach(() => {
  home = folder('se-store-home-')
  process.env.SPRINTENGINE_STORE_HOME = home
})

afterEach(() => {
  setWorkspaceStoreMigrator(null)
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A main checkout with a git directory, and a worktree of it laid out the way git lays one out. */
function repoWithWorktree(): { main: string; worktree: string } {
  const parent = folder()
  const main = join(parent, 'acme')
  mkdirSync(join(main, '.git', 'worktrees', 'chat-1'), { recursive: true })
  const worktree = join(parent, '.sprintengine-worktrees', 'acme', 'chat-1')
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'chat-1')}\n`)
  writeFileSync(join(main, '.git', 'worktrees', 'chat-1', 'commondir'), '../..\n')
  writeFileSync(join(main, '.git', 'worktrees', 'chat-1', 'gitdir'), `${join(worktree, '.git')}\n`)
  return { main, worktree }
}

test('a project keeps its store in the home folder, named for it and keyed by its path', () => {
  const project = join(folder(), 'My Project')
  mkdirSync(project)
  const store = workspaceStoreRoot(project)
  assert.equal(storeRootContaining(store), store)
  assert.match(store.slice(workspaceStoresRoot(home).length + 1), /^my-project-[0-9a-f]{16}$/u)
  assert.ok(store.startsWith(join(home, '.sprintengine', 'workspaces')))
  // The same folder however it is spelled: a trailing separator, a link to it.
  assert.equal(workspaceStoreRoot(`${project}/`), store)
  const alias = join(folder(), 'alias')
  symlinkSync(project, alias)
  assert.equal(workspaceStoreRoot(alias), store)
  // Another folder of the same name is another project.
  const other = join(folder(), 'My Project')
  mkdirSync(other)
  assert.notEqual(workspaceStoreRoot(other), store)
})

test('a worktree keeps its store with the checkout it was cut from', () => {
  const { main, worktree } = repoWithWorktree()
  assert.equal(projectRootOf(worktree), main)
  assert.equal(workspaceStoreProject(worktree), main)
  assert.equal(workspaceStoreRoot(worktree), workspaceStoreRoot(main))
})

test('a worktree whose folder is gone still finds its project from the container layout', () => {
  const parent = folder()
  const main = join(parent, 'acme')
  mkdirSync(main)
  const gone = join(parent, '.sprintengine-worktrees', 'acme', 'pool-03')
  assert.equal(projectRootOf(gone), main)
  assert.equal(workspaceStoreRoot(gone), workspaceStoreRoot(main))
})

test('a submodule, whose git directory has no common one, is a project of its own', () => {
  const main = folder()
  const submodule = join(main, 'vendor', 'lib')
  mkdirSync(join(main, '.git', 'modules', 'lib'), { recursive: true })
  mkdirSync(submodule, { recursive: true })
  writeFileSync(join(submodule, '.git'), 'gitdir: ../../.git/modules/lib\n')
  assert.equal(projectRootOf(submodule), submodule)
  assert.notEqual(workspaceStoreRoot(submodule), workspaceStoreRoot(main))
})

test('the chats started without a project share the one store of the "No project" root', () => {
  const chats = join(home, '.sprintengine', 'chats')
  mkdirSync(join(chats, '2026-10-16-tidy-the-photos-3f9a2c1d'), { recursive: true })
  mkdirSync(join(chats, '2026-10-16-convert-pngs-8b7e6d5c'), { recursive: true })
  assert.equal(
    workspaceStoreRoot(join(chats, '2026-10-16-tidy-the-photos-3f9a2c1d')),
    workspaceStoreRoot(join(chats, '2026-10-16-convert-pngs-8b7e6d5c')),
  )
  assert.equal(workspaceStoreRoot(join(chats, '2026-10-16-convert-pngs-8b7e6d5c')), workspaceStoreRoot(chats))
})

test('a folder on another machine, or no absolute folder at all, has no store here', () => {
  assert.throws(() => workspaceStoreRoot('ssh://build-box/home/dev/acme'))
  assert.throws(() => workspaceStoreRoot('acme'))
  assert.throws(() => workspaceStoreRoot(''))
})

test('making a store notes the project and every folder it was reached from', () => {
  const { main, worktree } = repoWithWorktree()
  const store = ensureWorkspaceStore(worktree)
  ensureWorkspaceStore(main)
  const manifest = JSON.parse(readFileSync(join(store, 'workspace.json'), 'utf8')) as {
    projectRoot: string
    aliases: string[]
  }
  assert.equal(manifest.projectRoot, main)
  assert.deepEqual(manifest.aliases, [worktree])
})

test('a conversation file in the store is confined to the store; any other to the folder given', async () => {
  const project = folder()
  const store = workspaceStoreRoot(project)
  assert.equal(await conversationConfinementRoot(project, join(store, 'conversations', 'c1', 'claude.jsonl')), store)
  assert.equal(
    await conversationConfinementRoot(
      join(store, 'conversations', 'c1'),
      join(store, 'conversations', 'c1', 'a.jsonl'),
    ),
    store,
  )
  assert.equal(await conversationConfinementRoot(project, join(project, 'notes.md')), project)
  // Another project's store is not this one's to reach.
  const other = workspaceStoreRoot(folder())
  assert.equal(await conversationConfinementRoot(project, join(other, 'conversations', 'x.jsonl')), project)
})

test('a folder an older build wrote into starts the move, and a reader waits for it to finish', async () => {
  const project = folder()
  mkdirSync(join(project, '.sprintengine', 'conversations'), { recursive: true })
  const started: string[] = []
  let finish!: () => void
  setWorkspaceStoreMigrator((root) => {
    started.push(root)
    return new Promise<void>((resolve) => (finish = resolve))
  })
  const ready = workspaceStoreReady(project)
  let settled = false
  void ready.then(() => (settled = true))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, [project])
  assert.equal(settled, false, 'the reader waits while the move runs')
  // A second ask while it runs joins it rather than starting another.
  void migrateWorkspaceStoreInBackground(project)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.length, 1)
  finish()
  assert.equal(await ready, workspaceStoreRoot(project))
})

test('a folder with nothing of an older build in it starts no move', async () => {
  const project = folder()
  const started: string[] = []
  setWorkspaceStoreMigrator(async (root) => {
    started.push(root)
  })
  await workspaceStoreReady(project)
  assert.deepEqual(started, [])
})
