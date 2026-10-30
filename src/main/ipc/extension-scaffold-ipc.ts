// "Build an extension" (the New chat door's extension mode): see whether a
// name is free where the extension goes, and scaffold the project there.
//
// The project is written by the SDK's own scaffolder — the one
// `sprintengine-module init` runs — from the templates the app ships beside
// itself (`sdk-templates` in package.json `build.extraResources`), so a project
// made here and one made on the command line are the same project. The
// extension guide ships beside them (`sdk-guide`), for the `extension.*` tools
// (automation/extension-tools.ts), which make projects through these same
// handlers. The SDK version it
// depends on is this checkout's, fixed at build time.
//
// The SDK itself ships beside the app too, as the tarball `npm run sdk:bundle`
// packs (`module-sdk` in extraResources). The project gets a copy in vendor/
// and depends on it by `file:`, so `npm install` needs no registry — the SDK is
// not on npm yet, and a company registry may never carry it. A build without
// the tarball (a checkout that never ran sdk:bundle) depends on the npm release.
//
// Where it goes: by default a NEW folder, `<extensions home>/<id>`, in a home
// for extensions made the first time one is (Documents/SprintEngine/Extensions).
// The person may pick the folder instead, and then the folder is the
// extension's and its name is the id. The id is held to the module-id rule
// (no separators, no dots), so a new folder cannot land anywhere but directly
// inside its parent, and a folder already there is never written into: an
// empty one is filled, one holding an extension is handed back as it is,
// anything else is refused. So nothing that exists is ever overwritten.

import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, type Stats } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { app, type IpcMain } from 'electron'

import {
  scaffoldModuleProject,
  type ScaffoldModuleOptions,
  type ScaffoldModuleResult,
} from '../../../packages/module-sdk/src/scaffold'
import sdkPackage from '../../../packages/module-sdk/package.json'
import {
  EXTENSION_START_TEMPLATE_ID,
  extensionDisplayName,
  extensionIdProblem,
  type ExtensionScaffoldCreateInput,
  type ExtensionScaffoldCreateResult,
  type ExtensionScaffoldTarget,
  type ExtensionScaffoldTargetInput,
  type ExtensionScaffoldTargetState,
} from '../../shared/extension-scaffold'
import { defaultUserModuleRoot } from '../modules/user-module-registry'
import { assertAppSender } from './ipc-sender'

export const EXTENSION_SCAFFOLD_TARGET_CHANNEL = 'extensions:scaffold:target'
export const EXTENSION_SCAFFOLD_CREATE_CHANNEL = 'extensions:scaffold:create'
export const EXTENSION_SCAFFOLD_HOME_CHANNEL = 'extensions:scaffold:home'

/** The SDK version a scaffolded project depends on: this build's own. */
export const SCAFFOLD_SDK_VERSION: string = sdkPackage.version

/** npm's name for this version's tarball, as scripts/pack-module-sdk.mjs packs it. */
export const SCAFFOLD_SDK_TARBALL = `sprintengine-module-sdk-${SCAFFOLD_SDK_VERSION}.tgz`

// An IDEA.md longer than this is not a brief.
const MAX_IDEA_CHARS = 20_000

export type ScaffoldRoots = {
  templatesRoot: string
  /** The extension guide's topics (packages/module-sdk/guide), which `extension.guide` serves. */
  guideRoot: string
  /** Where the SDK tarball would be; the scaffold uses it only when it is there. */
  sdkTarball: string
}

/**
 * Where the templates, the guide and the SDK tarball are: beside the app when
 * packaged; the SDK package, and the tarball sdk:bundle packs, in a checkout.
 */
export function resolveScaffoldRoots(
  env: { isPackaged: boolean; resourcesPath: string; appPath: string } = {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  },
): ScaffoldRoots {
  if (env.isPackaged) {
    return {
      templatesRoot: join(env.resourcesPath, 'sdk-templates'),
      guideRoot: join(env.resourcesPath, 'sdk-guide'),
      sdkTarball: join(env.resourcesPath, 'module-sdk', SCAFFOLD_SDK_TARBALL),
    }
  }
  const sdk = join(env.appPath, 'packages', 'module-sdk')
  return {
    templatesRoot: join(sdk, 'templates'),
    guideRoot: join(sdk, 'guide'),
    sdkTarball: join(env.appPath, 'resources', 'module-sdk', SCAFFOLD_SDK_TARBALL),
  }
}

export type ExtensionScaffoldDeps = {
  roots: () => ScaffoldRoots
  /** Where extensions are installed on this computer, one folder per id. */
  moduleRoot: () => string
  /** Where a new extension's folder is made when the person picks none. */
  home: () => string
  sdkVersion: string
  scaffold: (options: ScaffoldModuleOptions) => Promise<ScaffoldModuleResult>
}

function defaultDeps(): ExtensionScaffoldDeps {
  return {
    roots: () => resolveScaffoldRoots(),
    moduleRoot: () => defaultUserModuleRoot(),
    home: () => defaultExtensionsHome(),
    sdkVersion: SCAFFOLD_SDK_VERSION,
    scaffold: scaffoldModuleProject,
  }
}

/**
 * Documents/SprintEngine/Extensions: beside the person's other projects, where
 * a Finder or an editor finds it, and not in the hidden folder installed
 * extensions are copied into.
 */
export function defaultExtensionsHome(): string {
  let documents: string
  try {
    documents = app.getPath('documents')
  } catch {
    documents = app.getPath('home')
  }
  return join(documents, 'SprintEngine', 'Extensions')
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * What is at `folder` inside `parent`, read from the disk as it is now. A
 * folder that would be free is `installed` when an extension with this id is
 * installed already: the new project's dev install copies into that id's
 * folder, and would replace an extension that came from somewhere else.
 */
function targetState(parent: string, folder: string, installed: () => boolean): ExtensionScaffoldTargetState {
  if (!isDirectory(parent)) return 'no_parent'
  let entry: Stats
  try {
    entry = lstatSync(folder)
  } catch {
    return installed() ? 'installed' : 'free'
  }
  // A link is never filled, even to an empty folder: a project is a cloned
  // repository's to fill, and one could point a likely name anywhere.
  if (entry.isSymbolicLink() || !entry.isDirectory()) return 'taken'
  if (existsSync(join(folder, 'module', 'manifest.json'))) return 'extension'
  try {
    if (readdirSync(folder).length !== 0) return 'taken'
  } catch {
    return 'taken'
  }
  return installed() ? 'installed' : 'free'
}

export function createExtensionScaffoldHandlers(overrides: Partial<ExtensionScaffoldDeps> = {}) {
  const deps: ExtensionScaffoldDeps = { ...defaultDeps(), ...overrides }
  const isInstalled = (id: string) => () => existsSync(join(deps.moduleRoot(), id))

  // Where the input puts the extension, or null when it names nowhere
  // usable. The home is the one parent that need not exist yet: `create`
  // makes it.
  const place = (input: ExtensionScaffoldTargetInput): { parent: string; folder: string; home: boolean } | null => {
    if (input.folder !== undefined) {
      if (!isString(input.folder) || input.folder.trim() === '') return null
      const folder = resolve(input.folder)
      return { parent: dirname(folder), folder, home: false }
    }
    if (input.parentDir !== undefined) {
      if (!isString(input.parentDir) || input.parentDir.trim() === '') return null
      const parent = resolve(input.parentDir)
      return { parent, folder: join(parent, input.id), home: false }
    }
    const parent = resolve(deps.home())
    return { parent, folder: join(parent, input.id), home: true }
  }
  const stateOf = (where: { parent: string; folder: string; home: boolean }, id: string) =>
    where.home && !existsSync(where.parent)
      ? isInstalled(id)()
        ? 'installed'
        : 'free'
      : targetState(where.parent, where.folder, isInstalled(id))

  return {
    home(): string {
      return resolve(deps.home())
    },

    target(input: ExtensionScaffoldTargetInput | undefined): ExtensionScaffoldTarget | null {
      if (!input || !isString(input.id) || extensionIdProblem(input.id)) return null
      const where = place(input)
      if (!where) return null
      return { state: stateOf(where, input.id), folder: where.folder }
    },

    /**
     * `start` is what the project starts as, for the `extension.create` tool;
     * the door always starts from `EXTENSION_START_TEMPLATE_ID` alone.
     */
    async create(
      input: ExtensionScaffoldCreateInput | undefined,
      start: { templateId?: string; parts?: readonly string[] } = {},
    ): Promise<ExtensionScaffoldCreateResult> {
      if (!input || typeof input !== 'object')
        return { ok: false, code: 'invalid_input', message: 'Nothing to create.' }
      const { id, ideaMarkdown } = input
      if (!isString(id)) return { ok: false, code: 'invalid_id', message: 'Name the extension.' }
      const idProblem = extensionIdProblem(id)
      if (idProblem) return { ok: false, code: 'invalid_id', message: idProblem }
      const where = place(input)
      if (!where) return { ok: false, code: 'no_parent', message: 'Choose the folder the extension goes in.' }
      if (ideaMarkdown !== undefined && (!isString(ideaMarkdown) || ideaMarkdown.length > MAX_IDEA_CHARS)) {
        return { ok: false, code: 'invalid_input', message: `The brief is longer than ${MAX_IDEA_CHARS} characters.` }
      }

      const { parent, folder } = where
      const state = stateOf(where, id)
      if (state === 'no_parent') {
        return { ok: false, code: 'no_parent', message: `${parent} is not a folder any more. Choose another folder.` }
      }
      if (state === 'extension') return { ok: true, folder, existing: true }
      if (state === 'taken') {
        return {
          ok: false,
          code: 'dir_not_empty',
          message: `${folder} already has files in it. ${
            input.folder !== undefined ? 'Choose an empty folder.' : 'Choose another name.'
          }`,
        }
      }
      if (state === 'installed') {
        return {
          ok: false,
          code: 'installed',
          message: `An extension named ${id} is already installed on this computer. Choose another name.`,
        }
      }

      if (where.home) {
        try {
          mkdirSync(parent, { recursive: true })
        } catch (caught) {
          const reason = caught instanceof Error ? caught.message : String(caught)
          return { ok: false, code: 'io_error', message: `${parent} could not be made: ${reason}` }
        }
      }

      const { templatesRoot, sdkTarball } = deps.roots()
      const result = await deps.scaffold({
        dir: folder,
        templateId: start.templateId ?? EXTENSION_START_TEMPLATE_ID,
        id,
        displayName: extensionDisplayName(id),
        sdkVersion: deps.sdkVersion,
        templatesRoot,
        ...(start.parts && start.parts.length > 0 ? { parts: start.parts } : {}),
        ...(existsSync(sdkTarball) ? { sdkTarballPath: sdkTarball } : {}),
        ...(ideaMarkdown !== undefined && ideaMarkdown.trim() !== '' ? { ideaMarkdown } : {}),
      })
      if (!result.ok) return result
      return { ok: true, folder, existing: false, ...(result.notes?.length ? { notes: result.notes } : {}) }
    },
  }
}

export function registerExtensionScaffoldIpc(
  ipcMain: IpcMain,
  handlers: ReturnType<typeof createExtensionScaffoldHandlers> = createExtensionScaffoldHandlers(),
): void {
  ipcMain.handle(EXTENSION_SCAFFOLD_HOME_CHANNEL, () => handlers.home())
  ipcMain.handle(EXTENSION_SCAFFOLD_TARGET_CHANNEL, (_event, input: ExtensionScaffoldTargetInput | undefined) =>
    handlers.target(input),
  )
  // Writing files answers only the app's own window.
  ipcMain.handle(EXTENSION_SCAFFOLD_CREATE_CHANNEL, (event, input: ExtensionScaffoldCreateInput | undefined) => {
    assertAppSender(event)
    return handlers.create(input)
  })
}
