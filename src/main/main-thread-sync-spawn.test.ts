import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'vitest'

// A guardrail on the main thread. Main and the in-process server share it with
// every window's IPC, so a child process run synchronously there holds all of
// them until it exits. The editor probe used to run `mdfind` that way during
// boot discovery, which delayed the new window's document by the length of
// the lookup. Every remaining synchronous spawn is listed here with why it may
// stay; adding one means saying so in this list.
const ALLOWED: Record<string, string> = {
  // Windows only, on the write of a secret file, never at boot: the file must
  // not be readable by anyone else before the write returns.
  'server/platform/secret-cipher.ts': 'icacls on Windows when a secret file is written',
  // Linux only, before the app is ready and before any window exists, and only
  // on a native Wayland Hyprland session: Chromium's features are fixed at
  // `ready`, so the compositor's version has to be known first. Bounded at 1s.
  'main/hyprland-color-manager.ts': 'hyprctl version on a Hyprland Wayland session, before ready',
}

const SYNC_SPAWN = /\b(execFileSync|execSync|spawnSync)\s*\(/

const SRC = join(import.meta.dirname, '..')

function sourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__fixtures__') continue
      files.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      files.push(path)
    }
  }
  return files
}

test('main and the server spawn no child process synchronously, outside the listed exceptions', () => {
  const found = [...sourceFiles(join(SRC, 'main')), ...sourceFiles(join(SRC, 'server'))]
    .filter((path) => SYNC_SPAWN.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC, path).split('\\').join('/'))
    .sort()
  assert.deepEqual(found, Object.keys(ALLOWED).sort())
})
