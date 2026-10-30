// Helpers the extension dev-loop scripts share (validate.mjs, dev-install.mjs).
//
// Everything here reads the project's OWN installed @sprintengine/module-sdk,
// never a copy of its rules: the validator, the host API check and the signing
// CLI are the code the app itself runs, so a project these scripts accept is
// one the app accepts.

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SDK_PACKAGE = '@sprintengine/module-sdk'

/** `--project <dir>` (default: the current folder, which is what `npm run` uses). */
export function projectDirFrom(argv) {
  const index = argv.indexOf('--project')
  return resolve(index === -1 ? process.cwd() : (argv[index + 1] ?? '.'))
}

export function flagValue(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Where the installable module lives: the folder plugin.json's module
 * component names (`module` in every template). Everything in it is what gets
 * installed, digested and signed; everything outside it is source.
 */
export function moduleDirOf(projectDir) {
  const pluginPath = join(projectDir, 'plugin.json')
  if (existsSync(pluginPath)) {
    const path = readJson(pluginPath)?.components?.module?.path
    if (typeof path === 'string' && path.length > 0) return join(projectDir, path)
  }
  return join(projectDir, 'module')
}

/** The project's installed SDK: its root entry, its signing entry, and its CLI. */
export async function loadSdk(projectDir) {
  const require = createRequire(join(projectDir, 'package.json'))
  let indexPath
  try {
    indexPath = require.resolve(SDK_PACKAGE)
  } catch {
    fail(`${SDK_PACKAGE} is not installed in ${projectDir}. Run \`npm install\` first.`)
  }
  const sdk = await import(pathToFileURL(indexPath).href)
  const signing = await import(pathToFileURL(require.resolve(`${SDK_PACKAGE}/signing`)).href)
  return { sdk, signing, cliPath: join(dirname(indexPath), 'cli.js') }
}

/**
 * sha256 of every file the module ships, keyed by POSIX path relative to the
 * module folder, manifest.json aside (it carries the map). This is the
 * manifest's `files` map: the app will not load a module whose folder does
 * not match it exactly.
 *
 * The SDK's own walk (`computeModuleFileDigestsSync` from its ./signing entry),
 * the one `sprintengine-module sign` records, so the two can never disagree.
 */
export function computeFileDigests(moduleDir, signing) {
  if (typeof signing.computeModuleFileDigestsSync !== 'function') {
    fail(
      'This @sprintengine/module-sdk cannot digest module files, and the app will not load a module without them. ' +
        'Update the SDK (`npm install @sprintengine/module-sdk@latest`).',
    )
  }
  const result = signing.computeModuleFileDigestsSync(moduleDir, { walk: 'pack' })
  if (!result.ok) fail(`Some files in ${moduleDir} cannot be part of a module:`, result.issues)
  return result.files
}

/** Files that differ between two digest maps, as readable lines. */
export function digestDrift(expected, actual) {
  const lines = []
  for (const path of Object.keys(expected)) {
    if (actual[path] === undefined) lines.push(`${path}: listed but missing`)
    else if (actual[path] !== expected[path]) lines.push(`${path}: changed`)
  }
  for (const path of Object.keys(actual)) {
    if (expected[path] === undefined) lines.push(`${path}: not listed`)
  }
  return lines
}

export function printIssues(issues) {
  for (const issue of issues ?? []) {
    console.error(`  - ${issue.path === '' ? 'manifest' : issue.path}: ${issue.message}`)
  }
}

export function fail(message, issues) {
  console.error(message)
  printIssues(issues)
  process.exit(1)
}
