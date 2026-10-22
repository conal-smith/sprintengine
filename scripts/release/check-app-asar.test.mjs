import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createPackage, createPackageWithOptions, getRawHeader } from '@electron/asar'

import {
  ALLOWED_PACKAGES,
  ASAR_BUDGET_BYTES,
  checkAsar,
  checkUnpacked,
  fileEntries,
  filesUnder,
  findAsars,
  isAllowedPackage,
  topLevelPackages,
} from './check-app-asar.mjs'

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-app-asar-'))
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), contents)
  }
  return dir
}

test('the packages main loads, and their dependencies, are allowed', () => {
  for (const name of ['@anthropic-ai/claude-agent-sdk', 'node-pty', 'electron-updater', 'zod', 'graceful-fs']) {
    assert.equal(isAllowedPackage(name), true, name)
  }
})

test("ripgrep's binary package is allowed for whichever platform packages", () => {
  for (const platform of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']) {
    assert.equal(isAllowedPackage(`@vscode/ripgrep-${platform}`), true, platform)
  }
  assert.equal(isAllowedPackage('@vscode/other'), false)
})

test("the renderer's packages are not allowed", () => {
  for (const name of ['monaco-editor', 'mermaid', '@excalidraw/excalidraw', 'katex', 'shiki', '@xterm/xterm', 'react']) {
    assert.equal(isAllowedPackage(name), false, name)
  }
})

test('a scope is matched by its full name, not by the scope alone', () => {
  assert.equal(isAllowedPackage('@xterm/headless'), true)
  assert.equal(isAllowedPackage('@xterm/addon-webgl'), false)
  assert.equal(isAllowedPackage('@anthropic-ai/claude-agent-sdk-darwin-arm64'), false)
})

test('top-level packages are read from the header, scoped ones under their scope', () => {
  const header = {
    files: {
      out: { files: { main: { files: {} } } },
      node_modules: {
        files: {
          '.bin': { files: {} },
          ignore: { files: { 'package.json': { size: 1 } } },
          '@xterm': { files: { headless: { files: {} }, 'addon-serialize': { files: {} } } },
          'node-pty': { files: { 'node_modules': { files: { nested: { files: {} } } } } },
        },
      },
    },
  }
  assert.deepEqual(topLevelPackages(header), ['@xterm/addon-serialize', '@xterm/headless', 'ignore', 'node-pty'])
  assert.deepEqual(topLevelPackages({ files: { out: { files: {} } } }), [])
})

test('an archive of allowed packages within the budget passes', () => {
  assert.deepEqual(checkAsar({ packages: [...ALLOWED_PACKAGES], size: ASAR_BUDGET_BYTES }), [])
})

test('an unexpected package fails and is named', () => {
  const problems = checkAsar({ packages: ['ignore', 'monaco-editor', 'mermaid'], size: 1 })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /2 package\(s\)/)
  assert.match(problems[0], /monaco-editor, mermaid/)
  assert.doesNotMatch(problems[0], /ignore,/)
})

test('an archive over its budget fails', () => {
  const problems = checkAsar({ packages: ['ignore'], size: ASAR_BUDGET_BYTES + 1 })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /over its 64\.0 MiB budget/)
  assert.deepEqual(checkAsar({ packages: [], size: 2048 }, { budget: 1024 }).length, 1)
})

test('a packaged archive is found and read end to end', async () => {
  const source = tree({
    'package.json': '{}',
    'out/main/index.js': '',
    'node_modules/ignore/index.js': '',
    'node_modules/@xterm/headless/index.js': '',
    'node_modules/monaco-editor/index.js': '',
  })
  const dist = mkdtempSync(join(tmpdir(), 'check-app-asar-dist-'))
  try {
    const resources = join(dist, 'mac-arm64', 'App.app', 'Contents', 'Resources')
    mkdirSync(resources, { recursive: true })
    await createPackage(source, join(resources, 'app.asar'))
    mkdirSync(join(dist, 'win-unpacked', 'resources', 'app.asar.unpacked'), { recursive: true })

    const archives = findAsars(dist)
    assert.deepEqual(archives, [join(resources, 'app.asar')])
    const packages = topLevelPackages(getRawHeader(archives[0]).header)
    assert.deepEqual(packages, ['@xterm/headless', 'ignore', 'monaco-editor'])
    assert.match(checkAsar({ packages, size: 1 })[0], /monaco-editor/)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(dist, { recursive: true, force: true })
  }
})

function entry(path, { size = 10, unpacked = false, packed = !unpacked } = {}) {
  return { path, size, unpacked, packed }
}

test('files flagged unpacked are read from the header with no bytes in the archive', () => {
  const header = {
    files: {
      'package.json': { size: 2, offset: '0' },
      'node_modules': {
        files: {
          'node-pty': {
            unpacked: true,
            files: { build: { unpacked: true, files: { 'pty.node': { size: 40, unpacked: true } } } },
          },
          link: { link: 'node_modules/node-pty' },
        },
      },
    },
  }
  assert.deepEqual(fileEntries(header), [
    { path: 'package.json', size: 2, unpacked: false, packed: true },
    { path: 'node_modules/node-pty/build/pty.node', size: 40, unpacked: true, packed: false },
  ])
})

test('an archive whose unpacked files are only unpacked passes', () => {
  const entries = [entry('out/main/index.js', { size: 30 }), entry('node_modules/node-pty/pty.node', { size: 40, unpacked: true })]
  assert.deepEqual(checkUnpacked({ entries, dataBytes: 30, unpackedOnDisk: ['node_modules/node-pty/pty.node'] }), [])
})

test('a file flagged unpacked that also has bytes in the archive fails', () => {
  const entries = [entry('out/main/index.js', { size: 30 }), entry('node_modules/node-pty/pty.node', { size: 40, unpacked: true, packed: true })]
  const problems = checkUnpacked({ entries, dataBytes: 70, unpackedOnDisk: ['node_modules/node-pty/pty.node'] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^1 file\(s\) flagged unpacked also have bytes in app\.asar .*node-pty\/pty\.node\.$/u)
})

test('a file in app.asar.unpacked that the archive also packs fails', () => {
  const entries = [entry('node_modules/@vscode/ripgrep-darwin-arm64/bin/rg', { size: 4_000_000 })]
  const problems = checkUnpacked({ entries, dataBytes: 4_000_000, unpackedOnDisk: ['node_modules/@vscode/ripgrep-darwin-arm64/bin/rg'] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^1 file\(s\) in app\.asar\.unpacked are packed in app\.asar as well \(3\.8 MiB\): .*bin\/rg\.$/u)
})

test('archive bytes no entry points to, or too few, fail', () => {
  const entries = [entry('out/main/index.js', { size: 30 }), entry('node_modules/node-pty/pty.node', { size: 40, unpacked: true })]
  assert.match(checkUnpacked({ entries, dataBytes: 70, unpackedOnDisk: [] })[0], /holds 70 bytes of file data, but its packed files account for 30/u)
  assert.match(checkUnpacked({ entries, dataBytes: 20, unpackedOnDisk: [] })[0], /cut short/u)
})

test('a long list of duplicates is cut to ten names', () => {
  const entries = Array.from({ length: 12 }, (_, i) => entry(`f${i}`, { size: 1, unpacked: true, packed: true }))
  const [problem] = checkUnpacked({ entries, dataBytes: 12, unpackedOnDisk: [] })
  assert.match(problem, /f9 and 2 more\.$/u)
})

test('an archive packed with unpacked files is checked end to end', async () => {
  const source = tree({
    'package.json': '{}',
    'out/main/index.js': 'console.log(1)',
    'node_modules/node-pty/build/Release/pty.node': 'binary',
    'node_modules/node-pty/lib/index.js': 'module.exports = {}',
  })
  const dist = mkdtempSync(join(tmpdir(), 'check-app-asar-dist-'))
  try {
    const archive = join(dist, 'linux-unpacked', 'resources', 'app.asar')
    mkdirSync(dirname(archive), { recursive: true })
    await createPackageWithOptions(source, archive, { unpack: '*.node' })
    const read = () => {
      const { header, headerSize } = getRawHeader(archive)
      return checkUnpacked({
        entries: fileEntries(header),
        dataBytes: statSync(archive).size - 8 - headerSize,
        unpackedOnDisk: filesUnder(`${archive}.unpacked`),
      })
    }
    assert.deepEqual(filesUnder(`${archive}.unpacked`), ['node_modules/node-pty/build/Release/pty.node'])
    assert.deepEqual(read(), [])

    // A copy of a packed file left in app.asar.unpacked, and bytes appended to the archive.
    mkdirSync(join(`${archive}.unpacked`, 'node_modules', 'node-pty', 'lib'))
    writeFileSync(join(`${archive}.unpacked`, 'node_modules', 'node-pty', 'lib', 'index.js'), 'module.exports = {}')
    appendFileSync(archive, 'binary')
    const problems = read()
    assert.equal(problems.length, 2)
    assert.match(problems[0], /app\.asar\.unpacked are packed in app\.asar as well .*lib\/index\.js\./u)
    assert.match(problems[1], /bytes no entry points to/u)
    assert.deepEqual(filesUnder(join(dist, 'missing')), [])
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(dist, { recursive: true, force: true })
  }
})
