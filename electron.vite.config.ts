import { readFileSync } from 'node:fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { buildStampPlugin, rendererViteConfig } from './renderer.vite.config'

// electron-vite sets this before it loads this config: `development` for
// `electron-vite dev`, `production` for `electron-vite build`.
const isDevBuild = process.env['NODE_ENV_ELECTRON_VITE'] === 'development'

// Build-time default for the account service main talks to (src/main/service-endpoints.ts).
// Set MULTIAUTH_BASE_URL in the build environment to bake a fork's own deployment in;
// unset, the shipped default is used. It stays overridable at runtime by the same env
// name, so this only moves where the fallback comes from.
function serviceEndpointDefines(): Record<string, string> {
  const defines: Record<string, string> = {}
  const accountService = process.env['MULTIAUTH_BASE_URL']?.trim()
  if (accountService) defines['__MULTIAUTH_BASE_URL__'] = JSON.stringify(accountService)
  return defines
}

// `build.publish` in package.json is what electron-builder turns into
// app-update.yml, and app-update.yml is what electron-updater follows. The app
// also shows a "releases" link, which has to point at the same repository or it
// sends people somewhere the updater is not looking — a wrong value there is
// invisible at runtime, which is how builds up to 0.1.7 shipped pointing at a
// private repo and silently never updated. So the constant the app links to is
// checked against the manifest here, and a disagreement fails the build.
function assertReleasesRepoMatchesManifest(): void {
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as {
    build?: { publish?: { owner?: string; repo?: string } }
  }
  const publish = manifest.build?.publish
  if (!publish?.owner || !publish?.repo) {
    throw new Error('package.json build.publish must name an owner and a repo.')
  }
  const fromManifest = `${publish.owner}/${publish.repo}`
  const source = readFileSync(resolve('src/shared/releases-repo.ts'), 'utf-8')
  const declared = /export const RELEASES_REPO = '([^']+)'/u.exec(source)?.[1]
  if (declared !== fromManifest) {
    throw new Error(
      `RELEASES_REPO is '${declared}' but package.json build.publish names '${fromManifest}'. ` +
        'Update src/shared/releases-repo.ts so the in-app link and the updater follow the same repository.',
    )
  }
}

assertReleasesRepoMatchesManifest()

export default defineConfig({
  main: {
    plugins: [
      // Bundled rather than loaded from app.asar: Export chat reads replies
      // with the renderer's own Markdown parser and sets their math with its
      // typesetter, and bundling keeps main from depending on where those
      // renderer packages are listed (or whether app.asar carries them).
      externalizeDepsPlugin({ exclude: ['remark-gfm', 'remark-math', 'katex'] }),
      buildStampPlugin(isDevBuild),
    ],
    define: serviceEndpointDefines(),
    build: {
      rollupOptions: {
        // Two entries: the app's main process, and the Studio server it forks
        // as a utility process when the server runs in a process of its own
        // (src/server/desktop-main.ts). One build, so both carry one stamp,
        // and the server is packed in app.asar beside main.
        input: {
          index: resolve('src/main/index.ts'),
          'studio-server': resolve('src/server/desktop-main.ts'),
          // The usage scan's worker thread (src/main/usage/usage-service.ts
          // starts it from beside main's entry), so reading gigabytes of agent
          // session logs never runs on the main thread.
          'usage-scan-worker': resolve('src/main/usage/usage-scan-worker.ts'),
        },
        // Every chunk beside the entries, as with one entry: main's code finds
        // the renderer and the resources relative to its own `__dirname`, which
        // a `chunks/` folder would move one level down.
        output: { chunkFileNames: '[name]-[hash].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Two preloads: the app's, and the browser guest's element picker
        // (browser-pane epic), which main hands to the <webview> as a file
        // URL and pins in `will-attach-webview`.
        // A third: the launch plate's, which exposes one channel and so need
        // not evaluate the app's whole API surface in a second renderer at boot.
        input: {
          index: resolve('src/preload/index.ts'),
          'browser-guest': resolve('src/preload/browser-guest.ts'),
          splash: resolve('src/preload/splash.ts'),
        },
      },
    },
  },
  // The renderer's config is shared with the web client's build (vite.web.config.ts).
  renderer: rendererViteConfig({ client: 'desktop', devBuild: isDevBuild }),
})
