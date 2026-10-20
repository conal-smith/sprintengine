// Fail a package whose app.asar ships more than the main process loads.
//
// electron-builder copies every `dependencies` entry of package.json into
// app.asar, whole, with everything those packages depend on. The renderer
// does not need any of it: Vite bundles the renderer into out/renderer, and
// only main and preload `require` from node_modules at runtime. Up to 0.8.0
// the renderer's editor, diagram, canvas and math packages sat in
// `dependencies` anyway, and each installer carried some 330 MB of
// node_modules nothing loaded. Moving them to devDependencies fixed that; this
// keeps them from coming back. A package added to `dependencies` for the
// renderer packages green and only costs every download, so it has to fail
// somewhere, and this is the step that sees the packaged archive.
//
// Two checks, over every app.asar under the directory given:
//
// - Each top-level package in the archive's node_modules is on the allowlist
//   below: the packages main and preload load, and what those depend on.
// - The archive is within a size budget, with headroom over what it is now,
//   so a large file reaching it some other way is caught too.
//
// When main really does start loading a new package, add it and its
// dependencies to ALLOWED_PACKAGES in the same change. When only the renderer
// uses it, it belongs in devDependencies instead.
//
//   node scripts/release/check-app-asar.mjs [dist]

import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRawHeader } from '@electron/asar'

// What `require`s and `import()`s in out/main and out/preload name, then the
// closure of their dependencies as npm lays them out. zod is a peer of the ACP
// SDK that npm installs but electron-builder does not follow, which is why it
// is a dependency of the app in its own right; shipped-peers.test.mjs keeps
// every peer like it in `dependencies`, and so on this list.
export const ALLOWED_PACKAGES = new Set([
  '@agentclientprotocol/sdk',
  '@anthropic-ai/claude-agent-sdk',
  '@vscode/ripgrep',
  '@xterm/addon-serialize',
  '@xterm/addon-unicode11',
  '@xterm/headless',
  'electron-updater',
  'ignore',
  'node-pty',
  'zod',
  // electron-updater's
  'argparse',
  'builder-util-runtime',
  'debug',
  'fs-extra',
  'graceful-fs',
  'js-yaml',
  'jsonfile',
  'lazy-val',
  'lodash.escaperegexp',
  'lodash.isequal',
  'ms',
  'sax',
  'semver',
  'tiny-typed-emitter',
  'universalify',
  // node-pty's
  'node-addon-api',
])

// ripgrep's binary comes in one optional package per platform, and npm
// installs the one for the machine that packages.
const ALLOWED_PATTERNS = [/^@vscode\/ripgrep-[a-z0-9-]+$/u]

// 48 MiB on macOS arm64 when this was written: out/ is 40 MB of it, and the
// node_modules above are about 10 MB. The budget leaves room for the app to grow
// and none for one of the renderer's packages, the smallest of which by
// itself would not fit (excalidraw's 46 MB, mermaid's 75 MB, Monaco's 104 MB).
export const ASAR_BUDGET_BYTES = 64 * 1024 * 1024

export function isAllowedPackage(name, allowed = ALLOWED_PACKAGES, patterns = ALLOWED_PATTERNS) {
  return allowed.has(name) || patterns.some((pattern) => pattern.test(name))
}

/** The top-level package names in an archive header's node_modules, scoped ones as `@scope/name`. */
export function topLevelPackages(header) {
  const modules = header?.files?.node_modules?.files
  if (!modules) return []
  const names = []
  for (const [name, entry] of Object.entries(modules)) {
    if (name.startsWith('.')) continue
    if (name.startsWith('@')) {
      for (const scoped of Object.keys(entry.files ?? {})) names.push(`${name}/${scoped}`)
    } else {
      names.push(name)
    }
  }
  return names.sort()
}

/** What is wrong with one archive, as sentences; empty when it passes. */
export function checkAsar({ packages, size }, { allowed = ALLOWED_PACKAGES, budget = ASAR_BUDGET_BYTES } = {}) {
  const problems = []
  const unexpected = packages.filter((name) => !isAllowedPackage(name, allowed))
  if (unexpected.length > 0) {
    problems.push(
      `${unexpected.length} package(s) in node_modules that main and preload do not load: ${unexpected.join(', ')}. ` +
        'Move a package only the renderer uses to devDependencies; add one main now loads to ALLOWED_PACKAGES.',
    )
  }
  if (size > budget) {
    problems.push(`app.asar is ${mebibytes(size)}, over its ${mebibytes(budget)} budget.`)
  }
  return problems
}

/** Every app.asar under a directory: dist/mac-arm64/<App>.app/…, dist/win-unpacked/…, dist/linux-unpacked/…. */
export function findAsars(dir) {
  const found = []
  const walk = (current, depth) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.name === 'app.asar' && entry.isFile()) found.push(path)
      else if (entry.isDirectory() && depth < 6 && entry.name !== 'node_modules' && !entry.name.endsWith('.unpacked')) {
        walk(path, depth + 1)
      }
    }
  }
  walk(dir, 0)
  return found.sort()
}

function mebibytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? 'dist')
  const archives = findAsars(dir)
  if (archives.length === 0) {
    process.stderr.write(`No app.asar under ${dir}; run electron-builder first.\n`)
    process.exit(1)
  }
  let failed = false
  for (const archive of archives) {
    const packages = topLevelPackages(getRawHeader(archive).header)
    const size = statSync(archive).size
    const problems = checkAsar({ packages, size })
    const fromHere = relative(process.cwd(), archive)
    const name = fromHere && !fromHere.startsWith('..') ? fromHere : archive
    if (problems.length === 0) {
      process.stdout.write(`${name}: ${mebibytes(size)}, ${packages.length} packages in node_modules, all expected.\n`)
    } else {
      failed = true
      for (const problem of problems) process.stderr.write(`${name}: ${problem}\n`)
    }
  }
  process.exit(failed ? 1 : 0)
}
