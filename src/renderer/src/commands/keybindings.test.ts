import assert from 'node:assert/strict'
import {
  keybindingSearchText,
  collapseDuplicateKeybindings,
  isModifierTapChord,
  keybindingToKbdKeys,
  normalizeKeybinding,
  parseKeybinding,
  renderKeybinding,
} from './keybindings'
import { test } from 'vitest'

test('keybindings', async () => {
  assert.equal(normalizeKeybinding('CmdOrCtrl + Shift + P'), 'primary+shift+p')
  assert.equal(normalizeKeybinding('Command + Option + ArrowLeft'), 'alt+meta+arrowleft')
  assert.equal(normalizeKeybinding('Ctrl + ,'), 'ctrl+,')
  assert.equal(normalizeKeybinding('Primary++'), 'primary++')
  assert.equal(normalizeKeybinding('Ctrl + +'), 'ctrl++')
  assert.equal(normalizeKeybinding('Primary+plus'), 'primary++')
  assert.equal(normalizeKeybinding("Control + Shift + '"), "ctrl+shift+'")
  assert.equal(normalizeKeybinding('F12'), 'f12')
  assert.equal(normalizeKeybinding('Space'), 'space')
  assert.equal(normalizeKeybinding('G then I'), 'g i')
  assert.equal(normalizeKeybinding('Ctrl+K, Ctrl+S'), 'ctrl+k ctrl+s')

  assert.deepEqual(collapseDuplicateKeybindings(['CmdOrCtrl+K', 'Primary + K', 'Ctrl+K', 'Ctrl + K']), [
    'primary+k',
    'ctrl+k',
  ])

  assert.equal(parseKeybinding('Ctrl+K then Ctrl+S then Ctrl+P').ok, false)
  assert.equal(parseKeybinding('Ctrl+K+S').ok, false)
  assert.equal(parseKeybinding('Ctrl+Shift').ok, false)
  assert.equal(parseKeybinding('Hyper+K').ok, false)

  assert.equal(renderKeybinding('Primary+K', 'darwin'), '⌘K')
  assert.equal(renderKeybinding('Primary+K', 'windows'), 'Ctrl+K')
  assert.equal(renderKeybinding('Alt+ArrowLeft', 'darwin'), '⌥←')
  assert.equal(renderKeybinding('Primary++', 'windows'), 'Ctrl++')
  assert.equal(renderKeybinding('g i', 'linux'), 'G then I')
  assert.deepEqual(keybindingToKbdKeys('Primary+Shift+P then Enter', 'darwin'), [['⌘', '⇧', 'P'], ['↩']])
  assert.deepEqual(keybindingToKbdKeys('Primary++', 'windows'), [['Ctrl', '+']])
  // Search finds a glyph by its name: "cmd" and "shift" reach "⌘⇧P".
  assert.ok(keybindingSearchText('Primary+Shift+P', 'darwin').includes('cmd'))
  assert.ok(keybindingSearchText('Primary+Shift+P', 'darwin').includes('shift'))
  assert.equal(keybindingSearchText('Primary+K', 'windows'), 'Ctrl+K')

  // --- Lone-modifier tap chords (Search Everywhere) ---------------------------
  // A modifier standing alone as a whole stroke is the key of that stroke, so
  // `Shift Shift` is a two-stroke chord of two bare Shift taps and round-trips
  // through the canonical form.
  assert.equal(normalizeKeybinding('Shift Shift'), 'shift shift')
  assert.equal(normalizeKeybinding('shift shift'), 'shift shift')
  assert.equal(normalizeKeybinding('Shift then Shift'), 'shift shift')
  assert.equal(normalizeKeybinding(normalizeKeybinding('Shift Shift') ?? ''), 'shift shift')
  const tapChord = parseKeybinding('Shift Shift')
  assert.equal(tapChord.ok, true)
  assert.deepEqual(tapChord.ok ? tapChord.chord.strokes : null, [
    { modifiers: [], key: 'shift' },
    { modifiers: [], key: 'shift' },
  ])
  assert.equal(normalizeKeybinding('Ctrl Ctrl'), 'ctrl ctrl')

  // A modifier is only a key when it is the WHOLE stroke: a decorated stroke
  // still needs a key of its own, and the abstract `Primary` modifier is never a
  // physical key anyone can tap.
  assert.equal(parseKeybinding('Ctrl+Shift').ok, false)
  assert.equal(parseKeybinding('Shift+Shift').ok, false)
  assert.equal(parseKeybinding('Primary Primary').ok, false)
  assert.equal(parseKeybinding('Shift Shift Shift').ok, false)

  // A lone modifier is legal ONLY as a double tap of the same modifier. Anything
  // else the dispatcher could never fire: a one-stroke `Shift` is never a
  // stroke, `Shift Ctrl` is two different taps, and `Primary+K then Shift`
  // would swallow ⌘K as a pending chord whose second stroke never arrives.
  assert.equal(parseKeybinding('Shift').ok, false)
  assert.equal(parseKeybinding('Meta').ok, false)
  assert.equal(parseKeybinding('Shift Ctrl').ok, false)
  assert.equal(parseKeybinding('Primary+K then Shift').ok, false)
  assert.equal(parseKeybinding('Shift then Primary+K').ok, false)
  assert.equal(normalizeKeybinding('Shift'), null)
  assert.deepEqual(collapseDuplicateKeybindings(['Shift', 'Shift Shift', 'shift shift']), ['shift shift'])

  // Display: a modifier-as-key wears the modifier's own platform label, and a
  // tap chord joins with a space rather than the two-stroke "then".
  assert.equal(renderKeybinding('Shift Shift', 'darwin'), '⇧ ⇧')
  assert.equal(renderKeybinding('Shift Shift', 'windows'), 'Shift Shift')
  assert.equal(renderKeybinding('Alt Alt', 'darwin'), '⌥ ⌥')
  assert.deepEqual(keybindingToKbdKeys('Shift Shift', 'darwin'), [['⇧'], ['⇧']])
  assert.equal(isModifierTapChord('Shift Shift'), true)
  assert.equal(isModifierTapChord('g i'), false)
  assert.equal(isModifierTapChord('Primary+K'), false)

  console.log('keybinding tests passed')
})
