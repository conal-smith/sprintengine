import { app, BrowserWindow, ipcMain, Notification, protocol, safeStorage } from 'electron'
import { MODULE_ASSET_SCHEME } from '../shared/modules/assets'
import { installStudioPlatform } from '../server/platform/platform'
import { claimAppInstance, configureDevUserData } from './app-instance'
import { createElectronPlatform } from './platform/electron-platform'
import { attachStartupTimeline } from './startup-timeline'
import { avoidHyprlandColorManagerCrash } from './hyprland-color-manager'
import { ensureGuiLocale } from './gui-locale'
import { REMOVE_INTEGRATIONS_FLAG } from '../shared/integration-removal'
import { buildStamp } from 'virtual:sprintengine-build-stamp'
import { COMPILE_CACHE_PRUNE_DELAY_MS, compileCacheBuildKey, enableMainCompileCache } from './compile-cache'

// The entry, kept deliberately small. Everything it imports is evaluated before
// its first line runs, so the only things here are what must happen before the
// single-instance lock and the lock itself; the app proper (services, modules,
// IPC, lifecycle) lives in `app-main.ts` and is loaded only by the process that
// holds the lock. A second launch — a person reopening the app, a deep link, a
// hook or bridge script that reached the binary without ELECTRON_RUN_AS_NODE —
// used to build the whole service graph (and copy the plugin home, and write
// into every known workspace) before discovering it was not wanted. Now it
// exits here, and the first instance hears it through `second-instance`
// (registered in app-lifecycle.ts), which still sorts script launches from
// people.

// Boot measurement, off unless SPRINTENGINE_STARTUP_TIMELINE=1 or the
// diagnostics flag is set. Attached before anything else registers so the
// renderer's marks have somewhere to land the moment it starts sending them.
attachStartupTimeline(ipcMain)

// Before the lock: Electron keys it on the userData directory, so a dev build
// pinned to its own profile must have moved there first.
configureDevUserData(app)

// What the server-bound code takes from Electron (paths, the secret cipher,
// window broadcasts, OS notifications, the app version), installed before
// either branch below can build anything: the headless integration removal
// reaches the plugin registry and the MCP config store too. Every member reads
// Electron when it is used, so nothing here touches `app` before it may be.
installStudioPlatform(createElectronPlatform({ app, safeStorage, BrowserWindow, Notification }))

// `--remove-integrations` (the Windows uninstaller, or a person scripting an
// uninstall): the removal Settings runs, with no window and none of the app's
// services, so nothing writes an integration back while it is taken out. A
// running Studio holds the lock; the removal refuses rather than race it.
const headlessRemoval = process.argv.includes(REMOVE_INTEGRATIONS_FLAG)

if (!claimAppInstance(app)) {
  if (headlessRemoval) process.stdout.write('failed\tremoval\tSprintEngine Studio is running. Quit it first.\n')
  // `exit`, not `quit`: nothing has been built, so there is nothing for the
  // quit path to shut down, and no window may flash up on the way out.
  app.exit(headlessRemoval ? 4 : 0)
} else if (headlessRemoval) {
  import('./integrations/remove-integrations-cli')
    .then(({ runHeadlessRemoval }) => runHeadlessRemoval(app))
    .catch(() => app.exit(3))
} else {
  // Chromium features are fixed once the app is ready.
  avoidHyprlandColorManagerCrash(app)
  // Before the app is imported, so every terminal and agent it spawns inherits it.
  ensureGuiLocale()
  // Must be registered before the app is ready.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MODULE_ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ])
  // Before the app is imported, so its chunks are compiled from the cache this
  // build left on disk (compile-cache.ts). The cache is written out a minute
  // in, when boot has compiled what it needs, and again on the way out, which
  // covers whatever was first loaded after that.
  const compileCache = enableMainCompileCache(app.getPath('userData'), compileCacheBuildKey(buildStamp.builtAt))
  if (compileCache) {
    setTimeout(() => {
      compileCache.flush()
      void compileCache.prunePreviousBuilds()
    }, COMPILE_CACHE_PRUNE_DELAY_MS).unref()
    app.once('will-quit', () => compileCache.flush())
  }
  // A dynamic import, so the bundler emits the app as its own chunk and a
  // second launch never evaluates it. It still runs before `ready`: the chunk
  // is required in the microtask that follows this script, ahead of any event.
  import('./app-main').catch((error: unknown) => {
    // Thrown back out of the promise so a broken build fails the way an entry
    // that throws does — Electron's uncaught-exception dialog and a nonzero
    // exit — rather than as an unhandled rejection nobody sees.
    process.nextTick(() => {
      throw error
    })
  })
}
