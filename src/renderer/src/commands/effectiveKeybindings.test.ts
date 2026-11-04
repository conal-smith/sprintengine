import assert from 'node:assert/strict'
import {
  getEffectiveKeybindingLabel,
  getEffectiveKeybindings,
  getElectronAccelerator,
  platformKeybindingsFromApiPlatform,
} from './effectiveKeybindings'
import { test } from 'vitest'

test('effectiveKeybindings', async () => {
  assert.deepEqual(
    getEffectiveKeybindings('panel.git.toggle', {
      overrides: { 'panel.git.toggle': ['primary+shift+h'] },
      disabled: {},
    }),
    ['primary+shift+h'],
  )
  assert.equal(
    getEffectiveKeybindingLabel(
      'panel.git.toggle',
      {
        overrides: { 'panel.git.toggle': ['primary+shift+h'] },
        disabled: {},
      },
      'darwin',
    ),
    '⌘⇧H',
  )
  assert.equal(
    getElectronAccelerator('panel.git.toggle', {
      overrides: { 'panel.git.toggle': ['primary+shift+h'] },
      disabled: {},
    }),
    'CmdOrCtrl+Shift+H',
  )
  assert.deepEqual(
    getEffectiveKeybindings('panel.git.toggle', {
      overrides: { 'panel.git.toggle': ['primary+shift+h'] },
      disabled: { 'panel.git.toggle': true },
    }),
    [],
  )
  assert.equal(getElectronAccelerator('panel.git.toggle', { disabled: { 'panel.git.toggle': true } }), null)
  // A module-contributed command id is not in the shell registry, so it never
  // resolves to a native menu accelerator.
  assert.equal(getElectronAccelerator('notebook.goto.inbox', { overrides: {}, disabled: {} }), null)
  assert.equal(platformKeybindingsFromApiPlatform('darwin'), 'darwin')
  assert.equal(platformKeybindingsFromApiPlatform('win32'), 'windows')
  assert.equal(platformKeybindingsFromApiPlatform('linux'), 'linux')

  // Double Shift never reaches the native menu: it is a two-stroke chord, and
  // `commandPalette.open` still advertises ⌘K as its accelerator.
  assert.equal(getElectronAccelerator('commandPalette.open', { overrides: {}, disabled: {} }), 'CmdOrCtrl+K')
  assert.equal(
    getElectronAccelerator('commandPalette.open', {
      overrides: { 'commandPalette.open': ['Shift Shift'] },
      disabled: {},
    }),
    null,
  )
  assert.equal(
    getEffectiveKeybindingLabel(
      'commandPalette.open',
      { overrides: { 'commandPalette.open': ['Shift Shift'] }, disabled: {} },
      'darwin',
    ),
    '⇧ ⇧',
  )
  // A hand-edited one-stroke `Shift` override does not parse, so it can never
  // reach the menu as the invalid Electron accelerator "shift".
  assert.equal(
    getElectronAccelerator('commandPalette.open', { overrides: { 'commandPalette.open': ['Shift'] }, disabled: {} }),
    null,
  )
  assert.deepEqual(getEffectiveKeybindings('commandPalette.open', { overrides: {}, disabled: {} }), [
    'primary+k',
    'primary+shift+p',
  ])
  // `Shift Shift` moved onto `search.everywhere`, so disabling the gesture leaves
  // ⌘K standing (skills-everywhere, 2026-09-10).
  assert.deepEqual(getEffectiveKeybindings('search.everywhere', { overrides: {}, disabled: {} }), ['shift shift'])
})
