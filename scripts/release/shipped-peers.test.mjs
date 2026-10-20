// Every package the app ships has to bring the packages it loads with it.
//
// electron-builder packs `dependencies` and their own `dependencies` into
// app.asar, and nothing else: a peer dependency is the installer's job, and an
// installed app has no installer. So a dependency whose peer is met only in the
// checkout (by a dev dependency, or by npm installing peers on its own) works
// in `npm run dev` and fails in the installed app. That is how every release from 0.7.0 on shipped
// `@agentclientprotocol/sdk` without `zod`, and every Cursor, OpenCode, Grok
// and Kimi chat failed to load with "Cannot find package 'zod'".
//
// The check reads package.json and the lockfile (which records each package's
// peers) and fails for a required peer of a dependency that is not itself a
// dependency, unless it is listed below with the reason it is not needed in
// app.asar.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')

// Peers any dependency may name without the app shipping them.
const PROVIDED_PEERS = {
  // The runtime itself: the app runs inside it, so it is never in app.asar.
  electron: 'provided by the Electron runtime',
  // The renderer is bundled by Vite, React with it, and loads nothing from
  // node_modules; React is a dev dependency for that reason.
  react: 'bundled into the renderer',
  'react-dom': 'bundled into the renderer',
  '@types/react': 'types only',
}

// Peers one dependency may name without the app shipping them.
const PROVIDED_PEERS_OF = {
  '@anthropic-ai/claude-agent-sdk': {
    // Its entry (sdk.mjs), the only one the app imports, inlines both; the
    // peers serve its type declarations and its `./core` entry. The test
    // below holds the entry to that.
    '@anthropic-ai/sdk': 'inlined in the entry the app loads',
    '@modelcontextprotocol/sdk': 'inlined in the entry the app loads',
  },
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// The required peers of `manifest.dependencies` that the app would not ship,
// as "dependency -> peer" strings.
function unshippedPeers(manifest, lockfile) {
  const shipped = new Set(Object.keys(manifest.dependencies ?? {}))
  const missing = []
  for (const name of shipped) {
    const entry = lockfile.packages?.[`node_modules/${name}`]
    assert.ok(entry, `${name} is in package.json dependencies but not in package-lock.json; run npm install.`)
    for (const peer of Object.keys(entry.peerDependencies ?? {})) {
      if (entry.peerDependenciesMeta?.[peer]?.optional === true) continue
      if (shipped.has(peer)) continue
      if (peer in PROVIDED_PEERS) continue
      if (PROVIDED_PEERS_OF[name] && peer in PROVIDED_PEERS_OF[name]) continue
      missing.push(`${name} -> ${peer}`)
    }
  }
  return missing
}

const manifest = readJson(join(ROOT, 'package.json'))
const lockfile = readJson(join(ROOT, 'package-lock.json'))

test('every required peer of a dependency ships in app.asar', () => {
  assert.deepEqual(
    unshippedPeers(manifest, lockfile),
    [],
    'Add each peer to package.json dependencies, or list it in this file with the reason the app does not need it.',
  )
})

test('the check catches the zod the ACP SDK shipped without', () => {
  const withoutZod = { ...manifest, dependencies: { ...manifest.dependencies } }
  delete withoutZod.dependencies.zod
  assert.ok(unshippedPeers(withoutZod, lockfile).includes('@agentclientprotocol/sdk -> zod'))
})

test('an optional peer is not required', () => {
  const lock = {
    packages: {
      'node_modules/a': { peerDependencies: { b: '*' }, peerDependenciesMeta: { b: { optional: true } } },
    },
  }
  assert.deepEqual(unshippedPeers({ dependencies: { a: '1.0.0' } }, lock), [])
})

test('the peers allowed per dependency are still peers of it', () => {
  for (const [name, peers] of Object.entries(PROVIDED_PEERS_OF)) {
    const entry = lockfile.packages[`node_modules/${name}`]
    assert.ok(entry, `${name} is no longer installed; drop it from PROVIDED_PEERS_OF.`)
    for (const peer of Object.keys(peers)) {
      assert.ok(peer in (entry.peerDependencies ?? {}), `${peer} is no longer a peer of ${name}; drop it.`)
    }
  }
})

test('the Claude agent SDK entry the app loads does not import its peers', () => {
  const entry = readFileSync(join(ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'), 'utf8')
  for (const peer of Object.keys(PROVIDED_PEERS_OF['@anthropic-ai/claude-agent-sdk'])) {
    assert.ok(
      !entry.includes(`"${peer}`) && !entry.includes(`'${peer}`),
      `@anthropic-ai/claude-agent-sdk/sdk.mjs now loads ${peer}; add it to package.json dependencies.`,
    )
  }
})
