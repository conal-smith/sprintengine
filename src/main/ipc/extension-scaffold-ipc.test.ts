// The door's two questions to main: what is at <project>/<name> as the name is
// typed, and make the project there — always a new folder, never written over.
//
// The templates are the SDK's real ones and the scaffold is the real
// scaffolder, writing into a temporary folder.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, test, vi } from 'vitest'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

import {
  createExtensionScaffoldHandlers,
  EXTENSION_SCAFFOLD_CREATE_CHANNEL,
  EXTENSION_SCAFFOLD_TARGET_CHANNEL,
  registerExtensionScaffoldIpc,
  resolveScaffoldRoots,
  SCAFFOLD_SDK_TARBALL,
  SCAFFOLD_SDK_VERSION,
} from './extension-scaffold-ipc'

const SDK = join(process.cwd(), 'packages', 'module-sdk')

let parent = ''
let sdkTarball = ''

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'extension-scaffold-ipc-'))
  // Not written unless a test ships it.
  sdkTarball = join(parent, 'shipped', SCAFFOLD_SDK_TARBALL)
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

function handlers() {
  return createExtensionScaffoldHandlers({
    roots: () => ({ templatesRoot: join(SDK, 'templates'), guideRoot: join(SDK, 'guide'), sdkTarball }),
    moduleRoot: () => join(parent, 'installed-modules'),
    home: () => join(parent, 'Documents', 'SprintEngine', 'Extensions'),
  })
}

describe('extensions:scaffold:target', () => {
  test('says whether the name is free, an extension to carry on, or taken', async () => {
    const h = handlers()
    assert.deepEqual(h.target({ parentDir: parent, id: 'pr-radar' }), {
      state: 'free',
      folder: join(parent, 'pr-radar'),
    })

    mkdirSync(join(parent, 'empty'))
    assert.equal(h.target({ parentDir: parent, id: 'empty' })?.state, 'free', 'an empty folder is filled')

    mkdirSync(join(parent, 'notes'))
    writeFileSync(join(parent, 'notes', 'README.md'), 'mine')
    assert.equal(h.target({ parentDir: parent, id: 'notes' })?.state, 'taken')

    mkdirSync(join(parent, 'focus-timer', 'module'), { recursive: true })
    writeFileSync(join(parent, 'focus-timer', 'module', 'manifest.json'), '{}')
    assert.equal(h.target({ parentDir: parent, id: 'focus-timer' })?.state, 'extension')

    assert.equal(h.target({ parentDir: join(parent, 'gone'), id: 'pr-radar' })?.state, 'no_parent')

    mkdirSync(join(parent, 'elsewhere'))
    symlinkSync(join(parent, 'elsewhere'), join(parent, 'linked'))
    assert.equal(h.target({ parentDir: parent, id: 'linked' })?.state, 'taken', 'a link is never filled')
  })

  test('a free name an installed extension already holds is said, and not made', async () => {
    const h = handlers()
    mkdirSync(join(parent, 'installed-modules', 'weather-deck'), { recursive: true })
    assert.equal(h.target({ parentDir: parent, id: 'weather-deck' })?.state, 'installed')
    mkdirSync(join(parent, 'weather-deck'))
    assert.equal(h.target({ parentDir: parent, id: 'weather-deck' })?.state, 'installed', 'nor its empty folder')
    const made = await h.create({ parentDir: parent, id: 'weather-deck' })
    assert.equal(made.ok === false && made.code, 'installed')
    assert.equal(existsSync(join(parent, 'weather-deck', 'module')), false, 'nothing is written')

    // The project that made it is carried on as before.
    mkdirSync(join(parent, 'weather-deck', 'module'), { recursive: true })
    writeFileSync(join(parent, 'weather-deck', 'module', 'manifest.json'), '{}')
    assert.equal(h.target({ parentDir: parent, id: 'weather-deck' })?.state, 'extension')
  })

  test('a name that is not an id yet has no answer', () => {
    const h = handlers()
    assert.equal(h.target({ parentDir: parent, id: '' }), null)
    assert.equal(h.target({ parentDir: parent, id: '../escape' }), null)
    assert.equal(h.target({ parentDir: parent, id: 'pr-' }), null)
  })
})

describe('where the extension goes', () => {
  test('with no folder named, a new one in the extensions home, which is made when first needed', async () => {
    const h = handlers()
    const home = join(parent, 'Documents', 'SprintEngine', 'Extensions')
    assert.equal(h.home(), home)
    assert.deepEqual(h.target({ id: 'pr-radar' }), { state: 'free', folder: join(home, 'pr-radar') })
    assert.equal(existsSync(home), false, 'asking makes nothing')
    const made = await h.create({ id: 'pr-radar' })
    assert.equal(made.ok, true, JSON.stringify(made))
    if (made.ok) assert.equal(made.folder, join(home, 'pr-radar'))
    assert.equal(existsSync(join(home, 'pr-radar', 'module', 'manifest.json')), true)
    assert.equal(h.target({ id: 'pr-radar' })?.state, 'extension', 'and is carried on after')
  })

  test('a folder the person picked is the extension’s own: filled when empty, refused when not', async () => {
    const h = handlers()
    const picked = join(parent, 'weekly-summary')
    mkdirSync(picked)
    assert.deepEqual(h.target({ id: 'weekly-summary', folder: picked }), { state: 'free', folder: picked })
    const made = await h.create({ id: 'weekly-summary', folder: picked })
    assert.equal(made.ok, true, JSON.stringify(made))
    if (made.ok) assert.equal(made.folder, picked, 'in the folder itself, not a new one inside it')
    assert.equal(existsSync(join(picked, 'module', 'manifest.json')), true)

    const notes = join(parent, 'notes')
    mkdirSync(notes)
    writeFileSync(join(notes, 'README.md'), 'mine')
    assert.equal(h.target({ id: 'notes', folder: notes })?.state, 'taken')
    const refused = await h.create({ id: 'notes', folder: notes })
    assert.equal(refused.ok === false && refused.code, 'dir_not_empty')
    assert.match(refused.ok === false ? refused.message : '', /Choose an empty folder/)
    assert.equal(existsSync(join(notes, 'package.json')), false)
  })
})

describe('extensions:scaffold:create', () => {
  test('writes a new project into <project>/<name>, on this build’s SDK version, with the brief', async () => {
    const result = await handlers().create({
      parentDir: parent,
      id: 'pr-radar',
      ideaMarkdown: '# Pr radar\n\nA count of the PRs waiting on me.',
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    assert.equal(result.folder, join(parent, 'pr-radar'))
    assert.equal(result.existing, false)
    const manifest = JSON.parse(readFileSync(join(result.folder, 'module', 'manifest.json'), 'utf8'))
    assert.equal(manifest.id, 'pr-radar')
    assert.equal(manifest.displayName, 'Pr radar', 'the display name comes from the id')
    const pkg = JSON.parse(readFileSync(join(result.folder, 'package.json'), 'utf8'))
    assert.equal(
      pkg.devDependencies['@sprintengine/module-sdk'],
      `^${SCAFFOLD_SDK_VERSION}`,
      'with no tarball shipped, the npm release',
    )
    assert.equal(existsSync(join(result.folder, 'vendor')), false)
    assert.equal(
      readFileSync(join(result.folder, 'IDEA.md'), 'utf8'),
      '# Pr radar\n\nA count of the PRs waiting on me.\n',
    )
    assert.equal(existsSync(join(result.folder, '.claude')), false, 'no skill: the extension guide is served by Studio')
  })

  test('depends on the SDK the app ships, copied into vendor/, so npm install needs no registry', async () => {
    mkdirSync(join(parent, 'shipped'))
    writeFileSync(sdkTarball, 'the packed SDK')
    const result = await handlers().create({ parentDir: parent, id: 'pr-radar' })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    const pkg = JSON.parse(readFileSync(join(result.folder, 'package.json'), 'utf8'))
    assert.equal(pkg.devDependencies['@sprintengine/module-sdk'], `file:vendor/${SCAFFOLD_SDK_TARBALL}`)
    assert.equal(readFileSync(join(result.folder, 'vendor', SCAFFOLD_SDK_TARBALL), 'utf8'), 'the packed SDK')
  })

  test('an extension already there is handed back as it is, with nothing written', async () => {
    const h = handlers()
    const first = await h.create({ parentDir: parent, id: 'pr-radar', ideaMarkdown: 'first' })
    assert.equal(first.ok, true)
    const again = await h.create({ parentDir: parent, id: 'pr-radar', ideaMarkdown: 'second' })
    assert.deepEqual(again, { ok: true, folder: join(parent, 'pr-radar'), existing: true })
    assert.equal(readFileSync(join(parent, 'pr-radar', 'IDEA.md'), 'utf8'), 'first\n')
  })

  test('a folder with other things in it is refused, not written into', async () => {
    mkdirSync(join(parent, 'notes'))
    writeFileSync(join(parent, 'notes', 'README.md'), 'mine')
    const clash = await handlers().create({ parentDir: parent, id: 'notes' })
    assert.equal(clash.ok, false)
    if (!clash.ok) assert.equal(clash.code, 'dir_not_empty')
    assert.equal(readFileSync(join(parent, 'notes', 'README.md'), 'utf8'), 'mine')
    assert.equal(existsSync(join(parent, 'notes', 'package.json')), false)
  })

  test('checks the name and the project before anything is written', async () => {
    const h = handlers()
    for (const id of ['../escape', 'pr/radar', 'backlog', '']) {
      const refused = await h.create({ parentDir: parent, id })
      assert.equal(refused.ok, false, id)
      if (!refused.ok) assert.equal(refused.code, 'invalid_id', id)
    }
    const gone = await h.create({ parentDir: join(parent, 'gone'), id: 'pr-radar' })
    assert.equal(gone.ok, false)
    if (!gone.ok) assert.equal(gone.code, 'no_parent')
    assert.equal(existsSync(join(parent, 'gone')), false)
  })
})

test('reads the shipped copies when packaged and the SDK package in a checkout', () => {
  assert.equal(SCAFFOLD_SDK_TARBALL, `sprintengine-module-sdk-${SCAFFOLD_SDK_VERSION}.tgz`)
  assert.deepEqual(resolveScaffoldRoots({ isPackaged: true, resourcesPath: '/App/Resources', appPath: '/x' }), {
    templatesRoot: join('/App/Resources', 'sdk-templates'),
    guideRoot: join('/App/Resources', 'sdk-guide'),
    sdkTarball: join('/App/Resources', 'module-sdk', SCAFFOLD_SDK_TARBALL),
  })
  assert.deepEqual(resolveScaffoldRoots({ isPackaged: false, resourcesPath: '/x', appPath: '/repo' }), {
    templatesRoot: join('/repo', 'packages', 'module-sdk', 'templates'),
    guideRoot: join('/repo', 'packages', 'module-sdk', 'guide'),
    sdkTarball: join('/repo', 'resources', 'module-sdk', SCAFFOLD_SDK_TARBALL),
  })
})

describe('registerExtensionScaffoldIpc', () => {
  test('writing the project answers only the app’s own window', async () => {
    type Handler = (event: unknown, ...args: unknown[]) => unknown
    const registered = new Map<string, Handler>()
    const ipcMain = { handle: (channel: string, handler: Handler) => registered.set(channel, handler) }
    registerExtensionScaffoldIpc(ipcMain as unknown as Parameters<typeof registerExtensionScaffoldIpc>[0], handlers())

    const appEvent = {
      sender: {},
      senderFrame: { parent: null, url: pathToFileURL('/Applications/Studio.app/out/renderer/index.html').href },
    }
    const subframe = { ...appEvent, senderFrame: { ...appEvent.senderFrame, parent: {} } }

    const create = registered.get(EXTENSION_SCAFFOLD_CREATE_CHANNEL)!
    await assert.rejects(
      async () => create(subframe, { parentDir: parent, id: 'x' }),
      /did not come from a SprintEngine Studio window/,
    )
    assert.equal(existsSync(join(parent, 'x')), false)
    const target = registered.get(EXTENSION_SCAFFOLD_TARGET_CHANNEL)!
    assert.equal(((await target(appEvent, { parentDir: parent, id: 'x' })) as { state: string }).state, 'free')
  })
})
