import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

// How the packaged app is locked down: the Electron fuses electron-builder
// flips in the binary (package.json build.electronFuses), and the macOS
// entitlements it signs with. Neither can be seen from inside a test run of the
// app, so the configuration itself is what is held here.

const ROOT = join(__dirname, '..', '..')
const build = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).build as {
  electronFuses?: Record<string, boolean>
  asar?: boolean
}

function entitlements(file: string): string[] {
  const plist = readFileSync(join(ROOT, 'build', file), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  return [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((match) => match[1]!)
}

test('the binary takes no Node options from the environment or the command line, and loads only its checked asar', () => {
  const fuses = build.electronFuses
  assert.ok(fuses, 'package.json build.electronFuses is set')
  assert.equal(fuses.enableNodeOptionsEnvironmentVariable, false)
  assert.equal(fuses.enableNodeCliInspectArguments, false)
  assert.equal(fuses.onlyLoadAppFromAsar, true)
  assert.equal(fuses.enableEmbeddedAsarIntegrityValidation, true)
  // The integrity check is over app.asar, so the app must be packed into one.
  assert.notEqual(build.asar, false)
})

test('the binary still runs as Node: the app starts its own children that way', () => {
  // The managed runtime, the MCP bridge written into each agent CLI's config,
  // the hooks, the SSH askpass helper and the integrations launcher all run
  // Studio's own executable with ELECTRON_RUN_AS_NODE=1 (managed-runtime.ts).
  // Turning the fuse off would stop every one of them.
  assert.equal(build.electronFuses?.runAsNode, true)
  const source = readFileSync(join(ROOT, 'src', 'main', 'managed-runtime.ts'), 'utf8')
  assert.match(source, /ELECTRON_RUN_AS_NODE: '1'/)
})

test('the app is signed without the DYLD environment entitlement', () => {
  const app = entitlements('entitlements.mac.plist')
  const helpers = entitlements('entitlements.mac.inherit.plist')
  for (const granted of [app, helpers]) {
    assert.ok(!granted.includes('com.apple.security.cs.allow-dyld-environment-variables'))
    assert.ok(!granted.includes('com.apple.security.get-task-allow'))
  }
  // JIT is V8's; library validation stays off for the addons agent CLIs and
  // modules load into the app's Node (see the comment in the plist).
  assert.deepEqual(app.sort(), [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-library-validation',
  ])
})
