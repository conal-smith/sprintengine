import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { test } from 'vitest'

// Every IPC registration in the main process goes through app-ipc.ts's
// guarded `ipcMain`. That holds as long as nothing else takes Electron's own:
// registration modules are handed an `ipcMain` by their caller, and the
// callers import it from app-ipc.ts. This reads the tree for any other way in
// (a named or namespace import, a require, a WebContents' own `ipc`).

const ROOT = join(__dirname, '..', '..', '..')
const SCANNED = ['src/main', 'src/server']
const GUARD = 'src/main/ipc/app-ipc.ts'

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts'))
      out.push(path)
  }
  return out
}

/** The ways a file could reach an unguarded registration, by line. */
function bareIpcUses(source: string): string[] {
  const found: string[] = []
  const imports = source.matchAll(/import\s+(type\s+)?([^;]*?)\s+from\s+['"]electron['"]/g)
  for (const match of imports) {
    if (match[1]) continue
    const clause = match[2] ?? ''
    // `{ ipcMain }`, `{ ipcMain as x }`, but not a type-only `{ type IpcMain }`.
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? ''
    if (named.split(',').some((part) => /^\s*ipcMain\b/.test(part))) found.push('imports ipcMain from electron')
    // `import * as electron from 'electron'` or `import electron from 'electron'`, then `electron.ipcMain`.
    const whole = /^(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/.exec(clause.trim())?.[1]
    if (whole && new RegExp(`\\b${whole}\\.ipcMain\\b`).test(source)) found.push(`reads ${whole}.ipcMain`)
  }
  if (/require\(\s*['"]electron['"]\s*\)\s*\.ipcMain\b/.test(source)) found.push("reads require('electron').ipcMain")
  if (/\{[^}]*\bipcMain\b[^}]*\}\s*=\s*require\(\s*['"]electron['"]\s*\)/.test(source))
    found.push("destructures ipcMain from require('electron')")
  if (/\.ipc\s*\.\s*(handle|handleOnce|on|once|addListener)\s*\(/.test(source))
    found.push("registers on a WebContents' own ipc")
  return found
}

test('nothing in main or the server registers IPC around the sender check', () => {
  const offenders: string[] = []
  for (const dir of SCANNED) {
    for (const file of sources(join(ROOT, dir))) {
      const name = relative(ROOT, file).split(sep).join('/')
      if (name === GUARD) continue
      for (const why of bareIpcUses(readFileSync(file, 'utf8'))) offenders.push(`${name}: ${why}`)
    }
  }
  assert.deepEqual(offenders, [], 'register through src/main/ipc/app-ipc.ts, or take the ipcMain your caller hands you')
})

test('the check itself bites', () => {
  assert.deepEqual(bareIpcUses("import { app, ipcMain } from 'electron'"), ['imports ipcMain from electron'])
  assert.deepEqual(bareIpcUses("import { ipcMain as main } from 'electron'"), ['imports ipcMain from electron'])
  assert.deepEqual(bareIpcUses("import * as electron from 'electron'\nelectron.ipcMain.handle('x', f)"), [
    'reads electron.ipcMain',
  ])
  assert.deepEqual(bareIpcUses("const { ipcMain } = require('electron')"), [
    "destructures ipcMain from require('electron')",
  ])
  assert.deepEqual(bareIpcUses("win.webContents.ipc.handle('x', f)"), ["registers on a WebContents' own ipc"])
  // A type, and an ipcMain handed in, are fine.
  assert.deepEqual(bareIpcUses("import type { IpcMain } from 'electron'\nipcMain.handle('x', f)"), [])
  assert.deepEqual(bareIpcUses("import { BrowserWindow, type IpcMain } from 'electron'"), [])
})
