import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin, UserConfig } from 'vite'
import type { BuildStamp } from './src/shared/build-stamp'
import { withDesktopContentSecurityPolicy } from './src/shared/desktop-csp'
import { readStudioEnv } from './src/shared/studio-env'

// The renderer's Vite config, shared by the desktop build (electron.vite.config.ts)
// and the web client's (vite.web.config.ts), so the two bundles are built from
// one description of the renderer: the same plugins, aliases, minifier and
// pre-bundling. What differs is which documents are built, where they go, and
// `import.meta.env.STUDIO_CLIENT`, which says which `window.api` a document
// installs at boot (phase 9 spec, 3.1).

const BUILD_STAMP_ID = 'virtual:sprintengine-build-stamp'
const RESOLVED_BUILD_STAMP_ID = `\0${BUILD_STAMP_ID}`

// One stamp per production build, shared by main/preload/renderer — they are
// three rollup runs in one process, and a packaged app whose halves disagreed
// would nag forever. In dev the halves are built at different moments on
// purpose, so each one is stamped when it is actually generated.
let productionBuildStamp: BuildStamp | null = null

function mintBuildStamp(isDevBuild: boolean): BuildStamp {
  let commit: string | null = null
  try {
    commit =
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
  } catch {
    // No git, or not a checkout (a source tarball). The stamp says so rather
    // than inventing an identity — main skips the comparison instead of
    // comparing two unknowns and calling them equal.
    commit = null
  }
  return {
    commit,
    source: commit ? 'git' : 'unavailable',
    builtAt: new Date().toISOString(),
    mode: isDevBuild ? 'development' : 'production',
  }
}

// Mints `virtual:sprintengine-build-stamp`. Rollup re-runs `load` on every
// watch rebuild, so main's stamp follows the bundle it is about to boot; the dev
// server caches its transform instead, so the module is invalidated on any hot
// update and re-minted the next time a document loads it. That makes a window's
// stamp the commit it loaded from, which is what main compares against.
// See src/shared/build-stamp.ts.
export function buildStampPlugin(isDevBuild: boolean): Plugin {
  return {
    name: 'sprintengine-build-stamp',
    resolveId(id) {
      return id === BUILD_STAMP_ID ? RESOLVED_BUILD_STAMP_ID : null
    },
    load(id) {
      if (id !== RESOLVED_BUILD_STAMP_ID) return null
      const stamp = isDevBuild ? mintBuildStamp(true) : (productionBuildStamp ??= mintBuildStamp(false))
      return `export const buildStamp = ${JSON.stringify(stamp)}\n`
    },
    handleHotUpdate({ server }) {
      const module = server.moduleGraph.getModuleById(RESOLVED_BUILD_STAMP_ID)
      // Invalidate only — deliberately not added to the update set, so a hot
      // update stays a hot update and the page is not reloaded to re-read a
      // diagnostic. The fresh stamp lands with the next document load.
      if (module) server.moduleGraph.invalidateModule(module)
      return undefined
    },
  }
}

// The build's identity in the window's own HTML, for the classic boot scripts
// that run before any module can import the stamp above. The static New chat
// box (public/boot-composer.js) is a capture of markup this build drew, and a
// capture from any other build may name classes this stylesheet lacks, so it is
// only shown under the stamp it was captured under. Production only: the dev
// server injects its stylesheet from script, so no capture could be drawn
// styled before the bundle there anyway.
function buildIdMetaPlugin(): Plugin {
  return {
    name: 'sprintengine-build-id-meta',
    apply: 'build',
    transformIndexHtml(_html, context) {
      if (!context.filename.endsWith('index.html')) return undefined
      const stamp = (productionBuildStamp ??= mintBuildStamp(false))
      return [
        {
          tag: 'meta',
          attrs: { name: 'sprintengine-build', content: `${stamp.commit ?? 'nogit'}:${stamp.builtAt}` },
          injectTo: 'head-prepend',
        },
      ]
    },
  }
}

// The desktop app window's Content-Security-Policy, in its document right after
// the charset, so it governs everything the document loads, and the charset is
// still in the first 1024 bytes where it has to be (src/shared/desktop-csp.ts
// says what the policy allows and why). The web client's page has its own,
// sent by the server that serves it.
function desktopCspMetaPlugin(): Plugin {
  return {
    name: 'sprintengine-desktop-csp-meta',
    transformIndexHtml(html, context) {
      if (!context.filename.endsWith('index.html')) return undefined
      const devServerOrigin = context.server
        ? (context.server.resolvedUrls?.local[0] ?? `http://localhost:${context.server.config.server.port}`)
        : null
      return withDesktopContentSecurityPolicy(html, devServerOrigin)
    },
  }
}

// The canvas editor's scene fonts. `@excalidraw/excalidraw` does not import
// these files — it builds `<window.EXCALIDRAW_ASSET_PATH>fonts/<Family>/<file>`
// at runtime and hands it to the FontFace API, appending a public CDN as the
// last candidate for anything that misses (see src/renderer/src/canvasAssetPath.ts).
// Nothing in the module graph points at them, so the bundler never sees them,
// and an offline desktop app that leaned on the fallback would draw in the
// wrong face. They are therefore placed next to the renderer documents by hand.
//
// Read out of node_modules rather than copied into the tree: these are ~500 KB
// of binaries that belong to the dependency, and a checked-in copy is a second
// thing to remember on every upgrade. The one plugin covers dev and build, and
// every renderer HTML entry with them, because each document resolves the same
// `fonts/` directory beside itself.
const CANVAS_FONTS_DIR = resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts')

// The CJK family (Xiaolai) is ~12 MB, about twenty-five times the rest of that
// directory together, in some two hundred unicode-range subsets of which a
// page fetches only the ones its text needs. R48 (owner ruling 2026-10-02)
// bundles it in both clients that draw boards. The web client carries it: its
// bundle is served by a Studio server, not shipped in an installer, and a
// browser's last-resort source for it, a public CDN, is refused by the page's
// policy, so without it CJK labels fall back to the browser's own face. The
// desktop renderer does not carry it yet; adding twelve megabytes to every
// installer is that ruling's own change, not the web client's.
const CANVAS_FONTS_CJK_FAMILY = 'Xiaolai'

// The three families the agent format can ask for, by the directory name the
// package gives them (src/renderer/src/canvasWorker/skeletonMap.ts maps the
// file format's numeric ids onto their CSS names). The worker waits for these
// and only these before it answers, so a rename in the dependency has to fail
// the build rather than ship a worker that measures every label in a fallback
// face — the one degradation nothing on screen shows.
const CANVAS_FONTS_REQUIRED_FAMILIES = ['Excalifont', 'Nunito', 'ComicShanns']

// No family we ship is anywhere near this but the CJK one, which is named. So
// this catches the case the name cannot: a family renamed in the dependency,
// which would fall through and quietly put twelve megabytes in every
// installer.
const CANVAS_FONTS_MAX_FAMILY_BYTES = 3 * 1024 * 1024

function canvasSceneFontFiles(options: { cjk: boolean }): Array<{ urlPath: string; filePath: string }> {
  const families = readdirSync(CANVAS_FONTS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  const present = new Set(families.map((family) => family.name))
  const missing = CANVAS_FONTS_REQUIRED_FAMILIES.filter((family) => !present.has(family))
  if (missing.length > 0) {
    throw new Error(
      `The canvas scene fonts are missing ${missing.join(', ')} in ${CANVAS_FONTS_DIR}. ` +
        `The editor package's font directories have been renamed; update CANVAS_FONTS_REQUIRED_FAMILIES ` +
        `and the family names in src/renderer/src/canvasWorker/skeletonMap.ts together.`,
    )
  }

  const files: Array<{ urlPath: string; filePath: string }> = []
  for (const family of families) {
    const cjk = family.name === CANVAS_FONTS_CJK_FAMILY
    if (cjk && !options.cjk) continue
    let familyBytes = 0
    const inFamily: Array<{ urlPath: string; filePath: string }> = []
    for (const file of readdirSync(join(CANVAS_FONTS_DIR, family.name))) {
      if (!file.endsWith('.woff2')) continue
      const filePath = join(CANVAS_FONTS_DIR, family.name, file)
      familyBytes += statSync(filePath).size
      inFamily.push({ urlPath: `fonts/${family.name}/${file}`, filePath })
    }
    if (!cjk && familyBytes > CANVAS_FONTS_MAX_FAMILY_BYTES) {
      throw new Error(
        `The canvas scene font family ${family.name} is ${Math.round(familyBytes / (1024 * 1024))} MB, ` +
          `over the ${CANVAS_FONTS_MAX_FAMILY_BYTES / (1024 * 1024)} MB one family may be. ` +
          `A large family is left out of the installer by name, as ${CANVAS_FONTS_CJK_FAMILY} is.`,
      )
    }
    files.push(...inFamily)
  }
  return files
}

function canvasSceneFontsPlugin(options: { cjk: boolean }): Plugin {
  return {
    name: 'sprintengine-canvas-scene-fonts',
    // Dev: the renderer root is src/renderer, which has no fonts directory, so
    // the requests are answered from node_modules. The table doubles as the
    // allowlist — a request that is not one of the files the build emits falls
    // through to the rest of the dev server rather than reaching the disk.
    configureServer(server) {
      const byUrlPath = new Map(canvasSceneFontFiles(options).map((f) => [`/${f.urlPath}`, f.filePath]))
      server.middlewares.use((req, res, next) => {
        const filePath = byUrlPath.get((req.url ?? '').split('?')[0])
        if (!filePath) {
          next()
          return
        }
        res.setHeader('Content-Type', 'font/woff2')
        res.end(readFileSync(filePath))
      })
    },
    // Build: emitted at the bundle root, not under `assets/`, and unhashed —
    // the URL the editor builds names the family and file itself, so these two
    // are the parts of the layout that are not ours to choose.
    generateBundle() {
      for (const { urlPath, filePath } of canvasSceneFontFiles(options)) {
        this.emitFile({ type: 'asset', fileName: urlPath, source: readFileSync(filePath) })
      }
    },
  }
}

function rendererDevPort(): number {
  const value = readStudioEnv('SPRINTENGINE_RENDERER_PORT')?.trim()
  if (!value) return 5173

  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 5173
}

/** Which client a renderer build is for: the Electron window, or a browser tab served by a Studio server. */
export type StudioClient = 'desktop' | 'web'

// The HTML entries. `index` is the app in both. The desktop's `splash` is the
// standalone launch plate, which loads no bundle at all — without naming it
// here the packaged build simply would not emit it, since electron-vite
// otherwise infers the single implicit `src/renderer/index.html`. The web's
// `pair` is the pairing page a browser sees before it holds a session, also
// standalone, and `embed` is the read-only conversation view another page
// frames. The hidden canvas worker document is in both: the desktop's
// worker window loads it, and the web client loads it in a hidden frame to
// offer the `canvas` toolset. It needs nothing else from this config, since
// the scene fonts sit beside every document and the asset-path bootstrap is a
// module it imports for itself.
function rendererInputs(client: StudioClient): Record<string, string> {
  return client === 'desktop'
    ? {
        index: resolve('src/renderer/index.html'),
        splash: resolve('src/renderer/splash.html'),
        'canvas-worker': resolve('src/renderer/canvas-worker.html'),
      }
    : {
        index: resolve('src/renderer/index.html'),
        pair: resolve('src/renderer/pair.html'),
        embed: resolve('src/renderer/embed.html'),
        'canvas-worker': resolve('src/renderer/canvas-worker.html'),
      }
}

export function rendererViteConfig(options: { client: StudioClient; devBuild: boolean }): UserConfig {
  return {
    server: {
      port: rendererDevPort(),
      strictPort: readStudioEnv('SPRINTENGINE_RENDERER_STRICT_PORT') === '1',
    },
    build: {
      // React 19 publishes unminified production builds and leaves minifying to
      // the bundler; React 18's pre-minified files had hidden that this build
      // never minified. `keepNames` keeps `fn.name` and class names intact for
      // anything that reads them at runtime.
      minify: 'oxc',
      rollupOptions: {
        output: { keepNames: true },
        input: rendererInputs(options.client),
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
      },
    },
    optimizeDeps: {
      // Pre-bundled up front rather than on the first Canvas tab: the editor's
      // graph is large enough (it carries its own diagram importer) that
      // discovering it mid-session costs a full dev-server reload.
      include: ['@excalidraw/excalidraw'],
      rolldownOptions: {
        // The dep optimizer pre-bundles against Vite's browser matrix, which is
        // well below what Electron runs and makes it down-level a graph this
        // size on every cold start. The renderer has exactly one browser, so
        // the transform buys nothing here.
        transform: { target: 'es2022' },
      },
    },
    define: {
      // Read once, at boot, to choose which `window.api` to install; every
      // other branch asks a client capability instead.
      'import.meta.env.STUDIO_CLIENT': JSON.stringify(options.client),
    },
    plugins: [
      react(),
      tailwindcss(),
      buildStampPlugin(options.devBuild),
      ...(options.client === 'desktop' ? [buildIdMetaPlugin(), desktopCspMetaPlugin()] : []),
      canvasSceneFontsPlugin({ cjk: options.client === 'web' }),
    ],
  }
}
