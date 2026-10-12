import assert from 'node:assert/strict'
import {
  availableFolderOpenTargets,
  folderOpenTargetLabel,
  offersFolderOpenMenu,
  resolveFolderOpenPrimary,
} from './openInEditorTargets'
import { FOLDER_OPEN_TARGET_IDS, type FolderOpenTargetAvailability } from '../../../../shared/folder-open-targets'
import { test } from 'vitest'

test('openInEditorTargets', async () => {
  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  const probe = (
    entries: Partial<Record<FolderOpenTargetAvailability['id'], boolean>>,
  ): FolderOpenTargetAvailability[] =>
    (Object.entries(entries) as [FolderOpenTargetAvailability['id'], boolean][]).map(([id, available]) => ({
      id,
      available,
    }))

  run('an uninstalled editor is absent from the menu, not disabled in it', () => {
    const available = availableFolderOpenTargets(probe({ vscode: true, intellij: false, finder: true }))
    assert.deepEqual(available, ['vscode', 'finder'])
  })

  run('a target missing from the probe result is treated as unavailable', () => {
    assert.deepEqual(availableFolderOpenTargets(probe({ finder: true })), ['finder'])
  })

  run('targets keep the shared preference order regardless of probe order', () => {
    const available = availableFolderOpenTargets([
      { id: 'finder', available: true },
      { id: 'intellij', available: true },
      { id: 'vscode', available: true },
    ])
    assert.deepEqual(available, ['vscode', 'intellij', 'finder'])
  })

  run('an unprobed control offers nothing, so it does not render', () => {
    assert.deepEqual(availableFolderOpenTargets(null), [])
    assert.equal(resolveFolderOpenPrimary([], null), null)
  })

  run('first run with only the vscode target installed defaults to vscode', () => {
    const available = availableFolderOpenTargets(probe({ vscode: true, intellij: false, finder: true }))
    assert.equal(resolveFolderOpenPrimary(available, null), 'vscode')
  })

  run('first run with no editor installed defaults to the file manager', () => {
    const available = availableFolderOpenTargets(probe({ vscode: false, intellij: false, finder: true }))
    assert.equal(resolveFolderOpenPrimary(available, null), 'finder')
  })

  run('a remembered target wins over the preference order', () => {
    const available = availableFolderOpenTargets(probe({ vscode: true, intellij: true, finder: true }))
    assert.equal(resolveFolderOpenPrimary(available, 'intellij'), 'intellij')
  })

  run('a remembered target uninstalled since the pick falls back, never arms a dead click', () => {
    const available = availableFolderOpenTargets(probe({ vscode: true, intellij: false, finder: true }))
    assert.equal(resolveFolderOpenPrimary(available, 'intellij'), 'vscode')
  })

  run('with only the file manager resolving there is no menu to offer', () => {
    const available = availableFolderOpenTargets(probe({ vscode: false, intellij: false, finder: true }))
    assert.deepEqual(available, ['finder'])
    assert.equal(offersFolderOpenMenu(available), false)
  })

  run('a second target is what earns the menu', () => {
    assert.equal(offersFolderOpenMenu(availableFolderOpenTargets(probe({ vscode: true, finder: true }))), true)
    assert.equal(offersFolderOpenMenu([]), false)
  })

  run('the file manager is named by the OS, not by us', () => {
    assert.equal(folderOpenTargetLabel('finder', true), 'Finder')
    assert.equal(folderOpenTargetLabel('finder', false), 'File manager')
    assert.equal(folderOpenTargetLabel('vscode', false), 'VS Code')
    assert.equal(folderOpenTargetLabel('intellij', true), 'IntelliJ IDEA')
  })

  run('every editor has its product name', () => {
    assert.equal(folderOpenTargetLabel('cursor', true), 'Cursor')
    assert.equal(folderOpenTargetLabel('windsurf', true), 'Windsurf')
    assert.equal(folderOpenTargetLabel('zed', true), 'Zed')
    assert.equal(folderOpenTargetLabel('sublime', true), 'Sublime Text')
    assert.equal(folderOpenTargetLabel('webstorm', true), 'WebStorm')
    assert.equal(folderOpenTargetLabel('pycharm', true), 'PyCharm')
    assert.equal(folderOpenTargetLabel('goland', true), 'GoLand')
  })

  run('only the installed editors are offered, in the shared order', () => {
    const available = availableFolderOpenTargets(
      probe({ goland: true, zed: true, cursor: true, vscode: false, sublime: false, finder: true }),
    )
    assert.deepEqual(available, ['cursor', 'zed', 'goland', 'finder'])
    assert.equal(resolveFolderOpenPrimary(available, null), 'cursor')
  })

  if (failures > 0) {
    console.error(`openInEditorTargets.test.ts: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log('openInEditorTargets.test.ts: ok')
})

test('every target is called by a name no other target shares', () => {
  const labels = FOLDER_OPEN_TARGET_IDS.map((id) => folderOpenTargetLabel(id, true))
  assert.equal(new Set(labels).size, labels.length)
  assert.equal(folderOpenTargetLabel('vscode-insiders', true), 'VS Code Insiders')
  assert.equal(folderOpenTargetLabel('vscodium', true), 'VSCodium')
  assert.equal(folderOpenTargetLabel('antigravity', true), 'Antigravity')
  assert.equal(folderOpenTargetLabel('rustrover', true), 'RustRover')
})

test('a newer editor is offered beside its family, not at the end of the menu', () => {
  const available = availableFolderOpenTargets([
    { id: 'finder', available: true },
    { id: 'datagrip', available: true },
    { id: 'intellij', available: true },
    { id: 'kiro', available: true },
    { id: 'vscode-insiders', available: true },
    { id: 'vscode', available: true },
  ])
  assert.deepEqual(available, ['vscode', 'vscode-insiders', 'kiro', 'intellij', 'datagrip', 'finder'])
})

test('with only the Insiders build installed, it is the primary target', () => {
  const available = availableFolderOpenTargets([
    { id: 'vscode', available: false },
    { id: 'vscode-insiders', available: true },
    { id: 'finder', available: true },
  ])
  assert.equal(resolveFolderOpenPrimary(available, null), 'vscode-insiders')
})
