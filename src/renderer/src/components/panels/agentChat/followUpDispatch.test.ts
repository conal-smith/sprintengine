import assert from 'node:assert/strict'
import { test } from 'vitest'

import { renderKeybinding } from '../../../commands/keybindings'
import { followUpSendPresentation, primaryClickModifier, resolveComposerDispatch } from './followUpDispatch'

const running = { busy: true, canSteer: true, sendNowAvailable: true }

test('an idle chat sends, whatever the choice and the chord', () => {
  for (const behavior of ['queue', 'steer'] as const)
    for (const alternate of [false, true])
      assert.equal(resolveComposerDispatch({ ...running, busy: false, behavior, alternate }), 'send')
})

test('queue by choice: Enter queues, the alternate steers', () => {
  assert.equal(resolveComposerDispatch({ ...running, behavior: 'queue', alternate: false }), 'queue')
  assert.equal(resolveComposerDispatch({ ...running, behavior: 'queue', alternate: true }), 'steer')
})

test('steer by choice: Enter steers, the alternate queues', () => {
  assert.equal(resolveComposerDispatch({ ...running, behavior: 'steer', alternate: false }), 'steer')
  assert.equal(resolveComposerDispatch({ ...running, behavior: 'steer', alternate: true }), 'queue')
})

test('a provider that cannot steer queues on Enter, and never steers', () => {
  for (const behavior of ['queue', 'steer'] as const) {
    assert.equal(resolveComposerDispatch({ ...running, canSteer: false, behavior, alternate: false }), 'queue')
    assert.equal(
      resolveComposerDispatch({ ...running, canSteer: false, behavior, alternate: true }),
      'stop-and-send',
      'the alternate stops the turn, as Primary+Enter always did there',
    )
  }
})

test('a turn that cannot be acted on now queues, whatever was asked', () => {
  for (const behavior of ['queue', 'steer'] as const)
    for (const alternate of [false, true])
      for (const canSteer of [false, true])
        assert.equal(
          resolveComposerDispatch({ busy: true, sendNowAvailable: false, canSteer, behavior, alternate }),
          'queue',
        )
})

test('the button names its action and the chord for the other', () => {
  const shown = followUpSendPresentation({
    behavior: 'queue',
    canSteer: true,
    sendNowAvailable: true,
    clickModifier: 'Cmd',
    shortcutLabel: 'Cmd+Enter',
  })
  assert.equal(shown.action, 'queue')
  assert.equal(shown.alternate, 'steer')
  assert.equal(shown.labels[shown.action], 'Queue message')
  assert.equal(shown.tooltip, 'Click to queue, Cmd-click or Cmd+Enter to steer')
  assert.equal(
    shown.heldTooltip,
    'Cmd-click to steer, or let go of Cmd to queue',
    'what a click does with the key down',
  )
  const steering = followUpSendPresentation({
    behavior: 'steer',
    canSteer: true,
    sendNowAvailable: true,
    clickModifier: 'Ctrl',
    shortcutLabel: 'Ctrl+Enter',
  })
  assert.equal(steering.labels[steering.action], 'Steer message')
  assert.equal(steering.tooltip, 'Click to steer, Ctrl-click or Ctrl+Enter to queue')
})

test('a provider that cannot steer is never offered a steer by the button', () => {
  const shown = followUpSendPresentation({
    behavior: 'steer',
    canSteer: false,
    sendNowAvailable: true,
    clickModifier: 'Cmd',
    shortcutLabel: 'Cmd+Enter',
  })
  assert.equal(shown.action, 'queue')
  assert.equal(shown.alternate, 'stop-and-send')
  assert.doesNotMatch(shown.tooltip, /steer/)
  assert.equal(shown.tooltip, 'Click to queue, Cmd-click or Cmd+Enter to stop and send')
})

test('with no choice to make now, the button says the message queues and why', () => {
  const shown = followUpSendPresentation({
    behavior: 'steer',
    canSteer: true,
    sendNowAvailable: false,
    unavailableReason: 'The turn is still starting.',
    clickModifier: 'Cmd',
    shortcutLabel: 'Cmd+Enter',
  })
  assert.equal(shown.action, 'queue')
  assert.equal(shown.alternate, 'queue')
  assert.equal(shown.tooltip, 'Queue: it goes when this turn ends. The turn is still starting.')
  assert.equal(shown.heldTooltip, shown.tooltip, 'holding the key changes nothing where there is no choice')
})

test('the click modifier is the platform’s Primary key, named as its shortcut labels name it', () => {
  assert.equal(primaryClickModifier('darwin'), 'Cmd')
  assert.ok(renderKeybinding('Primary+Enter', 'darwin').startsWith(`${primaryClickModifier('darwin')}+`))
  assert.ok(renderKeybinding('Primary+Enter', 'windows').startsWith(`${primaryClickModifier('win32')}+`))
  assert.equal(primaryClickModifier('win32'), 'Ctrl')
  assert.equal(primaryClickModifier('linux'), 'Ctrl')
})
