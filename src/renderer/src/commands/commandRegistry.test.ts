import assert from 'node:assert/strict'
import { COMMAND_REGISTRY, getCommandDefinition } from './commandRegistry'
import { keydownMatchesKeybindings } from './commandDispatcher'
import { findKeybindingConflicts, hasBlockingKeybindingConflict } from './conflicts'
import { normalizeKeybinding } from './keybindings'
import type { CommandScope, ShellCommandScope } from './types'
import { test } from 'vitest'

test('commandRegistry', async () => {
  const ids = new Set<string>()
  for (const command of COMMAND_REGISTRY) {
    assert.equal(ids.has(command.id), false, `duplicate command id: ${command.id}`)
    ids.add(command.id)
    assert.equal(command.title.length > 0, true, `missing title: ${command.id}`)
    assert.equal(command.scopes.length > 0, true, `missing scope: ${command.id}`)
    for (const keybinding of command.defaultKeybindings ?? []) {
      assert.notEqual(normalizeKeybinding(keybinding), null, `invalid keybinding ${keybinding} on ${command.id}`)
    }
  }

  for (const id of [
    'app.settings.open',
    'commandPalette.open',
    'search.everywhere',
    'panel.files.toggle',
    'panel.knowledge-graph.toggle',
    'panel.canvas.toggle',
    'git.worktrees.open',
    'git.refresh',
    'git.fetch',
    'git.commit',
    'terminal.new',
    'terminal.focus',
    'terminal.stop',
  ]) {
    assert.ok(getCommandDefinition(id), `missing expected real command ${id}`)
  }

  // Every registry command is user-bindable through the Shortcuts settings tab
  // (KeyboardShortcutsTab.buildShortcutRows maps the whole registry), so each one
  // must declare a concrete dispatch adapter that the keyboard path
  // (RendererCommandDispatcher -> WorkspaceManager.runCommand or the panel-command
  // bridge) can actually route. The 'command-palette' kind is palette-only and has
  // no keybinding route, so a bound shortcut would silently no-op — the
  // git.worktrees.open defect from T8 review finding A10. This guard fails if any
  // future command is added as palette-only while remaining user-bindable.
  const DISPATCHABLE_HANDLER_KINDS = new Set(['workspace-manager', 'context-bound', 'app-menu', 'panel-event'])
  for (const command of COMMAND_REGISTRY) {
    assert.equal(
      DISPATCHABLE_HANDLER_KINDS.has(command.handlerPath.kind),
      true,
      `user-bindable command ${command.id} lacks a concrete dispatch adapter (handlerPath.kind=${command.handlerPath.kind})`,
    )
  }

  assert.equal(getCommandDefinition('quickOpen.open'), undefined)
  assert.equal(getCommandDefinition('git.discardAll'), undefined)
  assert.equal(
    getCommandDefinition('editor.save'),
    undefined,
    'editor save remains Monaco-owned and is not registry-backed in T3',
  )

  // Search Everywhere is a command of its own rather than a third binding on the
  // palette (skills-everywhere, 2026-09-10). Disable and rebind are PER COMMAND,
  // so while `Shift Shift` rode `commandPalette.open`, turning the gesture off
  // turned ⌘K off with it. The two raise the same overlay; only their identity
  // differs, and that identity is the whole point.
  const palette = getCommandDefinition('commandPalette.open')
  const everywhere = getCommandDefinition('search.everywhere')
  assert.deepEqual(palette?.defaultKeybindings, ['primary+k', 'primary+shift+p'])
  assert.deepEqual(everywhere?.defaultKeybindings, ['shift shift'])
  assert.equal(
    (palette?.defaultKeybindings ?? []).includes('shift shift'),
    false,
    'the double-tap gesture must not also ride the palette command, or disabling one disables both',
  )
  assert.equal(everywhere?.scopes.includes('global'), true, 'the gesture is global, like the palette')
  assert.deepEqual(
    everywhere?.handlerPath,
    palette?.handlerPath,
    'both commands raise the same overlay — they differ only in what a user can rebind',
  )

  // Layout tabs use the physical Control key even on macOS, where Primary is
  // Command and Command+Tab is reserved for switching applications. These
  // commands also have to cross the editable-target guard because agent tabs
  // are normally focused inside xterm, Monaco, or a composer.
  const nextLayoutTab = getCommandDefinition('layout.tab.next')
  const previousLayoutTab = getCommandDefinition('layout.tab.previous')
  assert.deepEqual(nextLayoutTab?.defaultKeybindings, ['ctrl+tab', 'shift+meta+]'])
  assert.deepEqual(previousLayoutTab?.defaultKeybindings, ['ctrl+shift+tab', 'shift+meta+['])
  assert.equal(nextLayoutTab?.allowInEditableTarget, true)
  assert.equal(previousLayoutTab?.allowInEditableTarget, true)
  assert.deepEqual(nextLayoutTab?.scopes, ['global'])
  assert.deepEqual(previousLayoutTab?.scopes, ['global'])
  assert.equal(nextLayoutTab?.availability, undefined)
  assert.equal(previousLayoutTab?.availability, undefined)
})

test('the chat turn chords share the terminal prompt chords without a blocking conflict', () => {
  const previous = getCommandDefinition('chat.turn.previous')
  const next = getCommandDefinition('chat.turn.next')
  assert.deepEqual(previous?.defaultKeybindings, ['primary+shift+arrowup'])
  assert.deepEqual(next?.defaultKeybindings, ['primary+shift+arrowdown'])
  // Outside editable targets only: in the composer the chord is the text
  // field's select-to-start/end.
  assert.equal(previous?.allowInEditableTarget, undefined)
  for (const command of [previous!, next!]) {
    assert.equal(hasBlockingKeybindingConflict(findKeybindingConflicts(command, COMMAND_REGISTRY)), false)
  }
})

test('send and start a new chat ships on Primary+Alt+Enter, free of conflicts', () => {
  const sendAndNew = getCommandDefinition('chat.sendAndNew')
  assert.deepEqual(sendAndNew?.defaultKeybindings, ['primary+alt+enter'])
  assert.equal(sendAndNew?.allowInEditableTarget, true, 'the composer is where it is pressed')
  assert.equal(
    sendAndNew?.handlerPath.kind,
    'context-bound',
    'the composer resolves it; the window dispatcher runs nothing',
  )
  assert.deepEqual(findKeybindingConflicts(sendAndNew!, COMMAND_REGISTRY), [])
})

test('the New chat chord and the waiting-chats chord ship free of conflicts on every platform', () => {
  const stay = getCommandDefinition('chat.new.launchInBackground')
  const waiting = getCommandDefinition('chat.nextWaiting')
  assert.deepEqual(stay?.defaultKeybindings, ['primary+enter'])
  assert.deepEqual(stay?.scopes, ['new-chat'], 'resolved by the composer, never by the window dispatcher')
  assert.deepEqual(waiting?.defaultKeybindings, ['primary+shift+j'])
  assert.deepEqual(waiting?.scopes, ['global'])
  assert.equal(waiting?.allowInEditableTarget, true, 'a person reaches for it from a composer')
  for (const command of [stay!, waiting!]) {
    assert.deepEqual(findKeybindingConflicts(command, COMMAND_REGISTRY), [], `${command.id} collides with nothing`)
  }
})

test('one keydown matches a binding exactly as the dispatcher would', () => {
  const enter = { key: 'Enter', code: 'Enter' }
  assert.equal(keydownMatchesKeybindings({ ...enter, metaKey: true }, ['Primary+Enter'], 'darwin'), true)
  assert.equal(keydownMatchesKeybindings({ ...enter, ctrlKey: true }, ['Primary+Enter'], 'windows'), true)
  assert.equal(keydownMatchesKeybindings({ ...enter, ctrlKey: true }, ['Primary+Enter'], 'darwin'), false)
  assert.equal(keydownMatchesKeybindings(enter, ['Primary+Enter'], 'darwin'), false, 'plain Enter is not it')
  assert.equal(
    keydownMatchesKeybindings({ ...enter, metaKey: true, shiftKey: true }, ['Primary+Enter'], 'darwin'),
    false,
    'an extra modifier is another chord',
  )
  assert.equal(keydownMatchesKeybindings({ ...enter, metaKey: true }, [], 'darwin'), false, 'disabled: nothing')
  assert.equal(keydownMatchesKeybindings({ ...enter, metaKey: true }, ['Primary+K Enter'], 'darwin'), false)
})

test("the shell's scopes are a closed list, and New chat's stays the shell's own", () => {
  const scopes: readonly ShellCommandScope[] = [
    'global',
    'new-chat',
    // @ts-expect-error a misspelt scope fails to compile rather than matching nothing
    'new-chats',
  ]
  // Every shell scope is a scope a dispatcher can be asked about; the open
  // `CommandScope` the module SDK mirrors does not name `new-chat`.
  const published: readonly CommandScope[] = scopes
  assert.equal(published.length, 3)
})

// Sentence case everywhere (design-system/foundations/principles.md): a
// command's title is copy, read in the palette and the Shortcuts list, and
// only a proper noun (or a surface's own name) and the word after a "Group:"
// prefix are capitalised. Markdown and Word are the names of the formats
// Export chat writes, not words in a sentence.
const PROPER_NOUNS = new Set(['Git', 'New', 'Markdown', 'Word'])
test('command titles are in sentence case', () => {
  for (const command of COMMAND_REGISTRY) {
    for (const clause of command.title.split(': ')) {
      const words = clause.split(' ').slice(1)
      // A title that opens a dialog ends in an ellipsis, which is not part of its last word.
      const capitalised = words.filter(
        (word) => /^\(?[A-Z][a-z]/.test(word) && !PROPER_NOUNS.has(word.replace(/…$/u, '')),
      )
      assert.deepEqual(capitalised, [], `"${command.title}" is not in sentence case`)
    }
  }
})

test('the settle chord ships free of conflicts and reaches the chat from its composer', () => {
  const settle = getCommandDefinition('chat.settle')
  assert.deepEqual(settle?.defaultKeybindings, ['primary+shift+s'])
  assert.deepEqual(settle?.availability, ['activeWorkspace'])
  assert.equal(settle?.allowInEditableTarget, true)
  assert.deepEqual(findKeybindingConflicts(settle!, COMMAND_REGISTRY), [])
})

test('Find in chat shares ⌘F with Find in terminal without a blocking conflict', () => {
  const chat = getCommandDefinition('chat.find')
  const terminal = getCommandDefinition('terminal.find')
  assert.deepEqual(chat?.defaultKeybindings, ['primary+f'])
  assert.deepEqual(terminal?.defaultKeybindings, ['primary+f'])
  // The terminal's sits on the narrower scope, which outranks the chat's
  // inside a terminal; keyTargetGate keeps the chat's to the chat.
  assert.deepEqual(chat?.scopes, ['workspace'])
  assert.deepEqual(terminal?.scopes, ['terminal'])
  assert.equal(chat?.allowInEditableTarget, true, 'it is reached for from the composer')
  assert.deepEqual(chat?.handlerPath, { kind: 'panel-event', eventId: 'chat.find' })
  assert.equal(hasBlockingKeybindingConflict(findKeybindingConflicts(chat!, COMMAND_REGISTRY)), false)
})

test('the pane "+" chord ships free of conflicts', () => {
  const add = getCommandDefinition('pane.add')
  assert.deepEqual(add?.defaultKeybindings, ['primary+t'])
  assert.equal(add?.allowInEditableTarget, true, 'reaches the composer; keyTargetGate narrows it')
  assert.deepEqual(findKeybindingConflicts(add!, COMMAND_REGISTRY), [])
})

test('Go to file is bound to Primary+P and raises the palette on its Files tab', () => {
  const goToFile = getCommandDefinition('search.goToFile')
  assert.ok(goToFile, 'search.goToFile is a registry command, so the Shortcuts tab lists and rebinds it')
  assert.deepEqual(goToFile.defaultKeybindings, ['primary+p'])
  assert.deepEqual(goToFile.scopes, ['global'])
  assert.equal(goToFile.handlerPath.kind, 'workspace-manager')
  assert.notEqual(goToFile.allowInEditableTarget, true, 'a terminal and the editor keep the chord')
})

test('Primary+P is bound to no other registry command', () => {
  const goToFile = getCommandDefinition('search.goToFile')!
  assert.deepEqual(findKeybindingConflicts(goToFile, COMMAND_REGISTRY), [])
})

test('Primary+S stashes from a composer and is resolved there, never by the window', () => {
  const stash = getCommandDefinition('chat.stash')
  assert.ok(stash, 'chat.stash is a registry command, so the Shortcuts tab lists and rebinds it')
  assert.deepEqual(stash.defaultKeybindings, ['primary+s'])
  assert.deepEqual(stash.scopes, ['workspace', 'new-chat'])
  // Context-bound: the window dispatcher's match runs nothing, so ⌘S pressed
  // in the code editor still reaches the editor's own save.
  assert.equal(stash.handlerPath.kind, 'context-bound')
  assert.deepEqual(findKeybindingConflicts(stash, COMMAND_REGISTRY), [])
})
