// Fails the build when a sandboxed preload requires anything but `electron`.
// A sandboxed preload's `require` only reaches Electron's own modules, so a
// relative chunk (or a dependency left external) stops the script loading at
// all: the browser guest's element picker silently never starts.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SANDBOXED = ['browser-guest.js', 'splash.js']
const ALLOWED = new Set(['electron'])

const problems = []
for (const name of SANDBOXED) {
  const file = resolve('out/preload', name)
  const source = readFileSync(file, 'utf8')
  for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
    if (!ALLOWED.has(match[1])) problems.push(`out/preload/${name} requires "${match[1]}"`)
  }
}

if (problems.length > 0) {
  console.error('A sandboxed preload must be one standalone file that requires only electron:')
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
