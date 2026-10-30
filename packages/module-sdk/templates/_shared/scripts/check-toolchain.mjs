#!/usr/bin/env node
// Is this machine, and this project, ready to build a SprintEngine Studio
// extension? Run it before anything else:
//
//   node scripts/check-toolchain.mjs [--project <dir>]
//
// Prints one line per check and what to do about each failure. Exit 1 when
// something blocks the build; notes alone exit 0.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const projectIndex = argv.indexOf('--project')
const projectDir = resolve(projectIndex === -1 ? process.cwd() : (argv[projectIndex + 1] ?? '.'))

let blocked = false
const ok = (message) => console.log(`ok     ${message}`)
const note = (message) => console.log(`note   ${message}`)
const bad = (message) => {
  blocked = true
  console.log(`FAIL   ${message}`)
}

const version = (command, args = ['--version']) => {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' })
  return result.status === 0 ? result.stdout.trim().split('\n')[0] : null
}

// The smoke test uses node:module registerHooks (Node 22.15 / 23.5 and newer).
const [major, minor] = process.versions.node.split('.').map(Number)
if (major > 23 || (major === 23 && minor >= 5) || (major === 22 && minor >= 15)) ok(`node ${process.versions.node}`)
else bad(`node ${process.versions.node} is too old: install Node 22.15 or newer (https://nodejs.org).`)

const npm = version('npm')
if (npm) ok(`npm ${npm}`)
else bad('npm is not on PATH; it ships with Node.')

const git = version('git')
if (git) ok(git)
else note('git is not on PATH; you need it to publish from a GitHub repository.')

// ── The project ──────────────────────────────────────────────────────────────

const packagePath = join(projectDir, 'package.json')
if (!existsSync(packagePath)) {
  note(`${projectDir} has no package.json; run this from an extension project for the project checks.`)
} else {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  const wanted = pkg.devDependencies?.['@sprintengine/module-sdk'] ?? pkg.dependencies?.['@sprintengine/module-sdk']
  if (!wanted) bad('package.json does not depend on @sprintengine/module-sdk.')
  else ok(`depends on @sprintengine/module-sdk ${wanted}`)

  if (!existsSync(join(projectDir, 'node_modules'))) {
    bad('node_modules is missing: run `npm install`.')
  } else {
    const require = createRequire(packagePath)
    try {
      const indexPath = require.resolve('@sprintengine/module-sdk')
      const sdk = await import(pathToFileURL(indexPath).href)
      const installed = JSON.parse(readFileSync(join(dirname(indexPath), '..', 'package.json'), 'utf8')).version
      ok(`@sprintengine/module-sdk ${installed} installed (host API ${sdk.HOST_API_VERSION ?? 'unknown'})`)
      const manifestPath = join(projectDir, 'module', 'manifest.json')
      if (existsSync(manifestPath)) {
        const declared = JSON.parse(readFileSync(manifestPath, 'utf8')).engines?.hostApi
        if (declared === undefined) bad('module/manifest.json has no "engines": { "hostApi": … }; Studio refuses it.')
        else if (sdk.HOST_API_VERSION !== undefined && declared !== sdk.HOST_API_VERSION) {
          note(`module/manifest.json declares host API ${declared}; this SDK describes ${sdk.HOST_API_VERSION}.`)
        } else ok(`module/manifest.json declares host API ${declared}`)
      }
    } catch {
      bad('@sprintengine/module-sdk is not installed: run `npm install`.')
    }
    for (const tool of ['esbuild', 'typescript']) {
      try {
        require.resolve(`${tool}/package.json`)
        ok(`${tool} installed`)
      } catch {
        bad(`${tool} is not installed: run \`npm install\`.`)
      }
    }
  }
}

// ── Where Studio looks ───────────────────────────────────────────────────────

const modulesRoot = process.env.SPRINTENGINE_USER_MODULE_ROOT ?? join(homedir(), '.sprintengine', 'modules')
if (existsSync(modulesRoot)) ok(`Studio's module folder: ${modulesRoot}`)
else note(`${modulesRoot} does not exist yet; Studio creates it on first launch, and dev:install creates it too.`)

const keysDir = join(homedir(), '.sprintengine', 'keys')
if (existsSync(keysDir)) ok(`signing keys folder: ${keysDir}`)
else note(`no ${keysDir} yet; \`npm run keygen\` makes a key there when you want to sign.`)

process.exit(blocked ? 1 : 0)
