import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createPackage, getRawHeader } from '@electron/asar'

import {
  ALLOWED_PACKAGES,
  ASAR_BUDGET_BYTES,
  checkAsar,
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
