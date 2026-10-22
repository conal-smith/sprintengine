import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

import { desktopContentSecurityPolicy, HTML_PREVIEW_SCHEME, withDesktopContentSecurityPolicy } from './desktop-csp'

function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) out.set(name, sources)
  }
  return out
}

// A source that is the app's own: a keyword, or a scheme only the app's
// process answers. Anything else (a host, a scheme with a network behind it)
// would let another origin's script in.
const LOCAL_SCRIPT_SOURCE = /^('self'|'wasm-unsafe-eval'|blob:|studio-module:)$/

test('scripts come only from the app, and no string becomes code', () => {
  const policy = directives(desktopContentSecurityPolicy())
  const scripts = policy.get('script-src') ?? []
  assert.deepEqual(
    scripts.filter((source) => !LOCAL_SCRIPT_SOURCE.test(source)),
    [],
  )
  assert.ok(!scripts.includes("'unsafe-eval'"))
  assert.ok(!scripts.includes("'unsafe-inline'"))
  for (const name of ['worker-src', 'connect-src', 'font-src', 'frame-src', 'default-src']) {
    const sources = policy.get(name) ?? []
    assert.ok(sources.length > 0, `${name} is declared`)
    assert.deepEqual(
      sources.filter((source) => /^(https?:|wss?:|\*)/.test(source)),
      [],
      `${name} reaches no server`,
    )
  }
  assert.deepEqual(policy.get('object-src'), ["'none'"])
  assert.deepEqual(policy.get('base-uri'), ["'none'"])
  assert.ok(policy.get('frame-src')?.includes(`${HTML_PREVIEW_SCHEME}:`))
})

test("the dev server's policy adds its preamble and its socket, and nothing else", () => {
  const packaged = directives(desktopContentSecurityPolicy())
  const dev = directives(desktopContentSecurityPolicy({ devServerOrigin: 'http://localhost:5173/' }))
  assert.deepEqual(dev.get('script-src'), [...(packaged.get('script-src') ?? []), "'unsafe-inline'"])
  assert.deepEqual(dev.get('connect-src'), [...(packaged.get('connect-src') ?? []), 'ws://localhost:5173'])
  for (const [name, sources] of packaged) {
    if (name !== 'script-src' && name !== 'connect-src') assert.deepEqual(dev.get(name), sources)
  }
})

test('the app document carries the policy right after its charset', () => {
  const html = readFileSync(join(__dirname, '..', 'renderer', 'index.html'), 'utf8')
  const built = withDesktopContentSecurityPolicy(html)
  const charset = built.indexOf('<meta charset="UTF-8" />')
  const meta = built.indexOf('<meta http-equiv="Content-Security-Policy"')
  assert.ok(charset >= 0 && meta > charset, 'the policy follows the charset')
  assert.ok(charset < 1024, 'the charset stays in the first 1024 bytes')
  // Before anything the document loads.
  assert.ok(meta < built.indexOf('<script'))
  assert.ok(built.includes(`content="${desktopContentSecurityPolicy()}"`))
  assert.throws(() => withDesktopContentSecurityPolicy('<html><head></head></html>'), /charset/)
})
