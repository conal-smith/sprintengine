#!/usr/bin/env node
// Vendors the self-contained runtime the studio ships so its own features work
// with no user-installed Node:
//
//   resources/runtime/npm — npm's pure-JS CLI, run via Electron's embedded Node
//                           (ELECTRON_RUN_AS_NODE) for `npm install -g` of agent
//                           CLIs such as Codex.
//
// Run before packaging (wired into the `dist:*` scripts). npm is pure JS, so
// the payload is the same on every target; --platform/--arch are accepted so
// CI cross-builds can keep passing the target they build for.
//
//   node scripts/fetch-runtimes.mjs [--platform <p>] [--arch <a>] [--force]
//
// This script is deliberately self-contained (no new npm deps): it downloads
// over https and extracts via the system `tar`, which is present on macOS,
// Linux, and modern Windows.
//
// The tarball becomes the npm every user's CLI installs run with, inside a
// signed app, so it is checked against the registry's own integrity for the
// pinned version before anything is extracted, and a vendored copy of any
// other version is replaced rather than kept.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_DIR = join(REPO_ROOT, 'resources', 'runtime')

// --- pinned versions -------------------------------------------------------
// npm is pure JS and runs on any Node, including Electron's embedded one
// (npm 11 needs Node ^20.17.0 || >=22.9.0; Electron 44 embeds Node 24).
export const NPM_VERSION = '11.21.1'
// The registry's `dist.integrity` for that version
// (`npm view npm@<version> dist.integrity`). Change both together.
export const NPM_INTEGRITY =
  'sha512-YTzL6QBEJXyHcTu0JiUc7RKMp+mzlJtl7rGLmERaXUQeFHIMc9atdr6G9M9C8vDWbv40epoTQAzNL2/PtZVDhQ=='

function parseArgs(argv) {
  const opts = { platform: process.platform, arch: process.arch, force: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--platform') opts.platform = argv[(i += 1)]
    else if (arg === '--arch') opts.arch = argv[(i += 1)]
    else if (arg === '--force') opts.force = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return opts
}

function log(msg) {
  console.log(`[fetch-runtimes] ${msg}`)
}

async function download(url, destFile) {
  log(`downloading ${url}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} ${response.statusText}): ${url}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destFile))
}

/**
 * Throws unless `bytes` hash to `integrity`, a Subresource Integrity string
 * (`sha512-<base64>`) as the npm registry publishes it.
 */
export function verifyIntegrity(bytes, integrity, label = 'download') {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity)
  if (!match) throw new Error(`unsupported integrity for ${label}: ${integrity}`)
  const actual = createHash('sha512').update(bytes).digest('base64')
  if (actual !== match[1]) {
    throw new Error(`integrity mismatch for ${label}: expected sha512-${match[1]}, got sha512-${actual}`)
  }
}

/** The version of the npm vendored at `npmDir`, or null when there is none or it cannot be read. */
export function vendoredNpmVersion(npmDir) {
  if (!existsSync(join(npmDir, 'bin', 'npm-cli.js'))) return null
  try {
    const version = JSON.parse(readFileSync(join(npmDir, 'package.json'), 'utf8')).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

function extractTarGz(archive, destDir) {
  mkdirSync(destDir, { recursive: true })
  const result = spawnSync('tar', ['-xzf', archive, '-C', destDir], { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`tar extraction failed for ${archive} (exit ${result.status ?? 'signal'})`)
  }
}

async function fetchNpm(tmp) {
  const url = `https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`
  const archive = join(tmp, `npm-${NPM_VERSION}.tgz`)
  await download(url, archive)
  verifyIntegrity(await readFile(archive), NPM_INTEGRITY, `npm-${NPM_VERSION}.tgz`)
  // The tarball extracts to `package/`; relocate it to resources/runtime/npm.
  // Use fs.cpSync rather than shelling out to cp/move so it works the same on
  // every OS and across volumes (the OS tempdir is frequently on a different
  // volume than the checkout, where a Windows directory `move` would fail).
  const stage = join(tmp, 'npm-stage')
  extractTarGz(archive, stage)
  const npmDest = join(RUNTIME_DIR, 'npm')
  rmSync(npmDest, { recursive: true, force: true })
  mkdirSync(dirname(npmDest), { recursive: true })
  cpSync(join(stage, 'package'), npmDest, { recursive: true })
  const cli = join(npmDest, 'bin', 'npm-cli.js')
  if (!existsSync(cli)) throw new Error(`npm-cli.js not found after extraction: ${cli}`)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  log(`target ${opts.platform}-${opts.arch} (npm ${NPM_VERSION})`)

  // Only the pinned version counts as present: a runner or checkout that
  // vendored another one (an older pin) fetches the pinned one over it.
  const present = vendoredNpmVersion(join(RUNTIME_DIR, 'npm'))
  if (present === NPM_VERSION && !opts.force) {
    log('runtime already present (use --force to refetch); nothing to do')
    return
  }
  if (present) log(`replacing vendored npm ${present}`)

  mkdirSync(RUNTIME_DIR, { recursive: true })
  const tmp = await mkdtemp(join(tmpdir(), 'sprintengine-runtimes-'))
  try {
    await fetchNpm(tmp)
    log('done')
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

// Run as a script; imported (by its test), it only defines.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[fetch-runtimes] FAILED: ${error?.message ?? error}`)
    process.exitCode = 1
  })
}
