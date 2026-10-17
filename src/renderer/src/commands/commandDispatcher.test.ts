import assert from 'node:assert/strict'
import { RendererCommandDispatcher, type CommandDispatcherKeyEvent } from './commandDispatcher'
import { COMMAND_REGISTRY } from './commandRegistry'
import { LEGACY_COMMAND_ID_ALIASES } from './keybindings'
import type { KeybindingSettings } from '../types/workspace'
import type { CommandContribution } from './types'
import { test } from 'vitest'

test('commandDispatcher', async () => {
  // A capability module's panel commands, standing in for the enabled-module
  // contributions the shell merges into the dispatcher's command universe. They
  // carry a panel scope, a panel-scoped Primary+, that shadows the global
  // settings binding, and `G then X` chords — exactly the shapes the chord and
  // revalidation cases below exercise.
  const notebookContributions: CommandContribution[] = [
    {
      id: 'notebook.open.settings',
      title: 'Notebook: Settings',
      category: 'Notebook',
      scopes: ['panel:notebook'],
      defaultKeybindings: ['Primary+,'],
      availability: ['notebookWorkspace'],
    },
    {
      id: 'notebook.goto.inbox',
      title: 'Notebook: Go to Inbox',
      category: 'Notebook',
      scopes: ['panel:notebook'],
      defaultKeybindings: ['G then I'],
      availability: ['notebookWorkspace'],
    },
    {
      id: 'notebook.goto.recent',
      title: 'Notebook: Go to Recent',
      category: 'Notebook',
      scopes: ['panel:notebook'],
      defaultKeybindings: ['G then R'],
      availability: ['notebookWorkspace'],
    },
    {
      id: 'notebook.goto.kanban',
      title: 'Notebook: Go to Kanban',
      category: 'Notebook',
      scopes: ['panel:notebook'],
      defaultKeybindings: ['G then K'],
      availability: ['notebookWorkspace'],
    },
  ]
  const withNotebook = [...COMMAND_REGISTRY, ...notebookContributions]

  function key(event: Partial<CommandDispatcherKeyEvent>): CommandDispatcherKeyEvent {
    return {
      key: event.key ?? '',
      code: event.code,
      ctrlKey: event.ctrlKey ?? false,
      metaKey: event.metaKey ?? false,
      altKey: event.altKey ?? false,
      shiftKey: event.shiftKey ?? false,
      target: event.target,
      defaultPrevented: event.defaultPrevented ?? false,
      repeat: event.repeat ?? false,
      isComposing: event.isComposing ?? false,
    }
  }

  const settings: KeybindingSettings = {
    overrides: {},
    disabled: {},
  }

  const dispatcher = new RendererCommandDispatcher(500)

  let result = dispatcher.resolve(key({ key: 'k', code: 'KeyK', ctrlKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    keybindingOverrides: settings.overrides,
    disabledCommandIds: new Set(),
    now: 0,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'commandPalette.open')

  result = dispatcher.resolve(key({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    now: 10,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'commandPalette.open')

  result = dispatcher.resolve(key({ key: 'p', code: 'KeyP', ctrlKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    now: 20,
  })
  // Plain Ctrl+P is Go to file, a command of its own beside the palette.
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'search.goToFile')

  result = dispatcher.resolve(key({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true, altKey: true }), {
    activeScopes: ['global', 'workspace', 'workspace-navigation'],
    platform: 'darwin',
    availability: { activeWorkspace: true },
    now: 25,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'workspace.switch.next')

  // Agent tabs are usually focused inside a terminal, editor, or composer —
  // all targets the shell normally suppresses. Physical Control+Tab must cross
  // that guard on macOS (where Primary means Command), in both directions.
  result = dispatcher.resolve(key({ key: 'Tab', code: 'Tab', ctrlKey: true }), {
    activeScopes: ['global'],
    platform: 'darwin',
    isSuppressedTarget: () => true,
    now: 26,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'layout.tab.next')

  result = dispatcher.resolve(key({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }), {
    activeScopes: ['global'],
    platform: 'darwin',
    isSuppressedTarget: () => true,
    now: 27,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'layout.tab.previous')

  result = dispatcher.resolve(key({ key: ',', code: 'Comma', ctrlKey: true }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: { activeWorkspace: true, notebookWorkspace: true },
    commands: withNotebook,
    now: 30,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'notebook.open.settings')

  result = dispatcher.resolve(key({ key: ',', code: 'Comma', ctrlKey: true }), {
    activeScopes: ['global', 'workspace'],
    platform: 'linux',
    now: 40,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'app.settings.open')

  result = dispatcher.resolve(key({ key: 'k', code: 'KeyK', ctrlKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    disabledCommandIds: new Set(['commandPalette.open']),
    now: 50,
  })
  assert.equal(result.kind, 'unmatched')

  result = dispatcher.resolve(key({ key: 'l', code: 'KeyL', ctrlKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    keybindingOverrides: { 'commandPalette.open': ['Primary+L'] },
    now: 60,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'commandPalette.open')

  const suppressed = () => true
  result = dispatcher.resolve(key({ key: 'k', code: 'KeyK', ctrlKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    isSuppressedTarget: suppressed,
    now: 70,
  })
  assert.equal(result.kind, 'unmatched')

  // A module contribution matches only when the enabled-module contribution
  // list carries it, and its allowInEditableTarget flag keeps it firing in
  // suppressed (editable) targets.
  const fixtureModuleContribution = {
    id: 'fixture-module.toggle',
    title: 'Toggle Fixture',
    category: 'Fixture',
    scopes: ['global'] as const,
    defaultKeybindings: ['Primary+Shift+1'],
    allowInEditableTarget: true,
  }
  result = dispatcher.resolve(key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    commands: [...COMMAND_REGISTRY, fixtureModuleContribution],
    isSuppressedTarget: suppressed,
    now: 80,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'fixture-module.toggle')

  // The binding stays unmatched when the module is disabled (its contribution
  // is filtered out of the command universe), so the keystroke falls through
  // instead of firing a silent no-op.
  result = dispatcher.resolve(key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    isSuppressedTarget: suppressed,
    now: 85,
  })
  assert.equal(result.kind, 'unmatched')

  const notebookChord = { activeWorkspace: true, notebookWorkspace: true }
  const chordDispatcher = new RendererCommandDispatcher(500)
  result = chordDispatcher.resolve(key({ key: 'g', code: 'KeyG' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 100,
  })
  assert.equal(result.kind, 'pending')
  result = chordDispatcher.resolve(key({ key: 'i', code: 'KeyI' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 300,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'notebook.goto.inbox')

  // G then R resolves to the second navigation chord in the same panel.
  result = chordDispatcher.resolve(key({ key: 'g', code: 'KeyG' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 320,
  })
  assert.equal(result.kind, 'pending')
  result = chordDispatcher.resolve(key({ key: 'r', code: 'KeyR' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 360,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'notebook.goto.recent')

  const timedOutDispatcher = new RendererCommandDispatcher(100)
  result = timedOutDispatcher.resolve(key({ key: 'g', code: 'KeyG' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 1000,
  })
  assert.equal(result.kind, 'pending')
  result = timedOutDispatcher.resolve(key({ key: 'i', code: 'KeyI' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 1201,
  })
  assert.equal(result.kind, 'unmatched')

  // The module chord stays inert outside the panel scope even with the
  // availability flags set.
  result = chordDispatcher.resolve(key({ key: 'g', code: 'KeyG' }), {
    activeScopes: ['global', 'workspace'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 1300,
  })
  assert.equal(result.kind, 'unmatched')

  // Chord revalidation against the live context. A chord started in the module
  // panel must NOT complete after the active scopes change within the
  // timeout — the second stroke re-derives candidates from the current context
  // rather than reusing the set captured on the first stroke.
  const scopeLostMidChord = new RendererCommandDispatcher(500)
  result = scopeLostMidChord.resolve(key({ key: 'g', code: 'KeyG' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 2000,
  })
  assert.equal(result.kind, 'pending')
  result = scopeLostMidChord.resolve(key({ key: 'r', code: 'KeyR' }), {
    activeScopes: ['global', 'workspace'],
    platform: 'linux',
    availability: { activeWorkspace: true },
    now: 2100,
  })
  assert.equal(result.kind, 'unmatched')

  // Same protection when the command is disabled between strokes.
  const disabledMidChord = new RendererCommandDispatcher(500)
  result = disabledMidChord.resolve(key({ key: 'g', code: 'KeyG' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 2200,
  })
  assert.equal(result.kind, 'pending')
  result = disabledMidChord.resolve(key({ key: 'r', code: 'KeyR' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    disabledCommandIds: new Set(['notebook.goto.recent']),
    now: 2300,
  })
  assert.equal(result.kind, 'unmatched')

  // And when availability is lost mid-chord while the scope is still active.
  const availabilityLostMidChord = new RendererCommandDispatcher(500)
  result = availabilityLostMidChord.resolve(key({ key: 'g', code: 'KeyG' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 2400,
  })
  assert.equal(result.kind, 'pending')
  result = availabilityLostMidChord.resolve(key({ key: 'r', code: 'KeyR' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: {},
    commands: withNotebook,
    now: 2500,
  })
  assert.equal(result.kind, 'unmatched')

  // T13: git.worktrees.open must be reachable by a bound shortcut, not only the
  // command palette. A user-configured override resolves to the registry id so the
  // WorkspaceManager.runCommand route added in T13 actually fires instead of
  // silently no-opping (T8 review finding A10).
  const worktreeDispatcher = new RendererCommandDispatcher(500)
  result = worktreeDispatcher.resolve(key({ key: 'w', code: 'KeyW', ctrlKey: true, altKey: true }), {
    activeScopes: ['global', 'workspace'],
    platform: 'linux',
    availability: { activeWorkspace: true },
    keybindingOverrides: { 'git.worktrees.open': ['Primary+Alt+W'] },
    now: 4000,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'git.worktrees.open')

  // Without an active workspace the binding stays unmatched, so the shortcut never
  // fires a silent no-op in a workspace-less window (availability: activeWorkspace).
  result = worktreeDispatcher.resolve(key({ key: 'w', code: 'KeyW', ctrlKey: true, altKey: true }), {
    activeScopes: ['global', 'workspace'],
    platform: 'linux',
    keybindingOverrides: { 'git.worktrees.open': ['Primary+Alt+W'] },
    now: 4100,
  })
  assert.equal(result.kind, 'unmatched')

  // A still-valid chord completes normally after the revalidation refactor.
  const stillValidChord = new RendererCommandDispatcher(500)
  result = stillValidChord.resolve(key({ key: 'g', code: 'KeyG' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 2600,
  })
  assert.equal(result.kind, 'pending')
  result = stillValidChord.resolve(key({ key: 'k', code: 'KeyK' }), {
    activeScopes: ['global', 'workspace', 'panel:notebook'],
    platform: 'linux',
    availability: notebookChord,
    commands: withNotebook,
    now: 2650,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'notebook.goto.kanban')

  // --- Module-contributed commands (merged via context.commands) --------------
  // The dispatcher matches against the merge-point output (shell registry +
  // enabled module commands). These cases pin the enablement-reactive behavior
  // and the no-silent-shadowing rule.

  const moduleCommand: CommandContribution = {
    id: 'demo-module.hello',
    title: 'Say Hello',
    category: 'Demo Module',
    scopes: ['global'],
    defaultKeybindings: ['Primary+Alt+H'],
  }
  const enabledCommands: readonly CommandContribution[] = [...COMMAND_REGISTRY, moduleCommand]

  const moduleDispatcher = new RendererCommandDispatcher(500)
  result = moduleDispatcher.resolve(key({ key: 'h', code: 'KeyH', ctrlKey: true, altKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    commands: enabledCommands,
    now: 5000,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(
    result.kind === 'matched' ? result.commandId : null,
    'demo-module.hello',
    'a module command keybinding dispatches like a built-in',
  )

  // Module disabled -> the merge point omits the command, so the binding is gone
  // from key dispatch without any dispatcher-side special case.
  result = moduleDispatcher.resolve(key({ key: 'h', code: 'KeyH', ctrlKey: true, altKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    commands: COMMAND_REGISTRY,
    now: 5100,
  })
  assert.equal(result.kind, 'unmatched', 'disabling the module removes its key dispatch')

  // User override persisted by command id re-attaches when the module returns.
  result = moduleDispatcher.resolve(key({ key: 'j', code: 'KeyJ', ctrlKey: true, altKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    commands: enabledCommands,
    keybindingOverrides: { 'demo-module.hello': ['Primary+Alt+J'] },
    now: 5200,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(
    result.kind === 'matched' ? result.commandId : null,
    'demo-module.hello',
    'a customized module binding works after re-enable',
  )

  // A module command that duplicates a built-in binding at the same scope
  // specificity cannot silently shadow it: shell commands sort first in the
  // merge point, so the built-in keeps firing (and the Shortcuts tab surfaces
  // the conflict like any other duplicate binding).
  const shadowingCommand: CommandContribution = {
    id: 'demo-module.shadow',
    title: 'Shadow Palette',
    category: 'Demo Module',
    scopes: ['global'],
    defaultKeybindings: ['Primary+K'],
  }
  result = moduleDispatcher.resolve(key({ key: 'k', code: 'KeyK', ctrlKey: true }), {
    activeScopes: ['global'],
    platform: 'linux',
    commands: [...COMMAND_REGISTRY, shadowingCommand],
    now: 5300,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(
    result.kind === 'matched' ? result.commandId : null,
    'commandPalette.open',
    'a built-in keeps priority over a module command bound to the same keys',
  )

  // Predicate-gated module command: matches only when the published module
  // context satisfies the predicate; with no context wired it never matches
  // (fail closed), and a module-derived panel scope gets panel specificity.
  const predicateCommand: CommandContribution = {
    id: 'calendar.open.settings',
    title: 'Calendar Settings',
    category: 'Calendar',
    scopes: ['panel:calendar'],
    defaultKeybindings: ['Primary+9'],
    availabilityPredicate: (context) => context.activeWorkspaceMode === 'calendar',
  }
  const predicateDispatcher = new RendererCommandDispatcher()
  result = predicateDispatcher.resolve(key({ key: '9', code: 'Digit9', ctrlKey: true }), {
    activeScopes: ['global', 'workspace', 'panel:calendar'],
    platform: 'linux',
    commands: [predicateCommand],
    moduleContext: { activeWorkspaceId: 'ws-1', activeWorkspaceMode: 'calendar' },
    now: 6000,
  })
  assert.equal(result.kind, 'matched')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'calendar.open.settings')
  result = predicateDispatcher.resolve(key({ key: '9', code: 'Digit9', ctrlKey: true }), {
    activeScopes: ['global', 'workspace', 'panel:calendar'],
    platform: 'linux',
    commands: [predicateCommand],
    moduleContext: { activeWorkspaceId: 'ws-1', activeWorkspaceMode: 'standard' },
    now: 6100,
  })
  assert.equal(result.kind, 'unmatched', 'predicate false refuses the binding')
  result = predicateDispatcher.resolve(key({ key: '9', code: 'Digit9', ctrlKey: true }), {
    activeScopes: ['global', 'workspace', 'panel:calendar'],
    platform: 'linux',
    commands: [predicateCommand],
    now: 6200,
  })
  assert.equal(result.kind, 'unmatched', 'no module context wired fails closed')

  // Persisted overrides keyed by a migrated command's LEGACY id keep firing the
  // re-namespaced id (the module-path migration). No command is migrating
  // today, so a fixture alias stands in for one.
  const migratedCommand: CommandContribution = {
    id: 'fixture-module.toggle',
    title: 'Toggle Fixture',
    category: 'Fixture',
    scopes: ['global'],
  }
  LEGACY_COMMAND_ID_ALIASES['fixture-module.toggle'] = 'fixture.toggle'
  try {
    result = predicateDispatcher.resolve(key({ key: 'r', code: 'KeyR', ctrlKey: true, shiftKey: true }), {
      activeScopes: ['global', 'workspace'],
      platform: 'linux',
      commands: [migratedCommand],
      keybindingOverrides: { 'fixture.toggle': ['Primary+Shift+R'] },
      now: 6300,
    })
  } finally {
    delete LEGACY_COMMAND_ID_ALIASES['fixture-module.toggle']
  }
  assert.equal(result.kind, 'matched', 'legacy-id override still binds')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'fixture-module.toggle')

  // --- Double Shift: the Search Everywhere gesture ----------------------------
  // A lone Shift TAP is press-then-release with nothing in between, so the
  // gesture completes on keyup. Every case below is about the one rule that
  // matters: it must never fire while a person is typing capitals.
  const shiftDown = (over: Partial<CommandDispatcherKeyEvent> = {}) =>
    key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true, ...over })
  const shiftUp = (over: Partial<CommandDispatcherKeyEvent> = {}) =>
    key({ key: 'Shift', code: 'ShiftLeft', shiftKey: false, ...over })
  const globalAt = (now: number, extra: Record<string, unknown> = {}) => ({
    activeScopes: ['global'] as const,
    platform: 'linux' as const,
    now,
    ...extra,
  })

  // Two taps inside the window open the palette.
  const tapDispatcher = new RendererCommandDispatcher(500, 400)
  result = tapDispatcher.resolve(shiftDown(), globalAt(0))
  assert.equal(result.kind, 'unmatched', 'the first Shift is not a stroke of its own')
  assert.equal(result.preventDefault, false, 'the first Shift is never swallowed — capitals depend on it')
  result = tapDispatcher.resolveKeyUp(shiftUp(), globalAt(60))
  assert.equal(result.kind, 'unmatched', 'one tap only arms the gesture')
  result = tapDispatcher.resolve(shiftDown(), globalAt(200))
  assert.equal(result.kind, 'unmatched')
  assert.equal(result.preventDefault, false, 'the second Shift keydown is not swallowed either')
  result = tapDispatcher.resolveKeyUp(shiftUp(), globalAt(260))
  assert.equal(result.kind, 'matched', 'two Shift taps inside the window fire')
  assert.equal(
    result.kind === 'matched' ? result.commandId : null,
    'search.everywhere',
    'the gesture is its own command, so it can be rebound without touching ⌘K',
  )

  // Taps further apart than the window re-arm instead of firing.
  const slowTaps = new RendererCommandDispatcher(500, 400)
  slowTaps.resolve(shiftDown(), globalAt(1000))
  assert.equal(slowTaps.resolveKeyUp(shiftUp(), globalAt(1010)).kind, 'unmatched')
  slowTaps.resolve(shiftDown(), globalAt(1500))
  assert.equal(
    slowTaps.resolveKeyUp(shiftUp(), globalAt(1510)).kind,
    'unmatched',
    'taps 500ms apart are two separate taps, not a double tap',
  )

  // Typing a capital: Shift down, letter, Shift up. The letter disqualifies the
  // release, so no amount of capitals accumulates into the gesture.
  const capitals = new RendererCommandDispatcher(500, 400)
  capitals.resolve(shiftDown(), globalAt(2000))
  capitals.resolve(key({ key: 'A', code: 'KeyA', shiftKey: true }), globalAt(2010))
  assert.equal(capitals.resolveKeyUp(shiftUp(), globalAt(2020)).kind, 'unmatched')
  capitals.resolve(shiftDown(), globalAt(2030))
  capitals.resolve(key({ key: 'B', code: 'KeyB', shiftKey: true }), globalAt(2040))
  assert.equal(
    capitals.resolveKeyUp(shiftUp(), globalAt(2050)).kind,
    'unmatched',
    'typing "AB" with Shift held never completes the double tap',
  )

  // Shift+A and then a clean Shift tap: the armed state was cleared by the A, so
  // the tap only re-arms.
  const shiftedThenTap = new RendererCommandDispatcher(500, 400)
  shiftedThenTap.resolve(shiftDown(), globalAt(3000))
  shiftedThenTap.resolve(key({ key: 'A', code: 'KeyA', shiftKey: true }), globalAt(3005))
  assert.equal(shiftedThenTap.resolveKeyUp(shiftUp(), globalAt(3010)).kind, 'unmatched')
  shiftedThenTap.resolve(shiftDown(), globalAt(3020))
  assert.equal(
    shiftedThenTap.resolveKeyUp(shiftUp(), globalAt(3030)).kind,
    'unmatched',
    'Shift+A then Shift is one tap, not two',
  )

  // An ordinary key pressed BETWEEN two clean taps cancels the armed state.
  const interrupted = new RendererCommandDispatcher(500, 400)
  interrupted.resolve(shiftDown(), globalAt(4000))
  assert.equal(interrupted.resolveKeyUp(shiftUp(), globalAt(4010)).kind, 'unmatched')
  interrupted.resolve(key({ key: 'a', code: 'KeyA' }), globalAt(4020))
  interrupted.resolve(shiftDown(), globalAt(4030))
  assert.equal(
    interrupted.resolveKeyUp(shiftUp(), globalAt(4040)).kind,
    'unmatched',
    'a key struck between the taps cancels the gesture',
  )

  // Shift+Tab: the Tab keydown cancels, so a following tap cannot complete.
  const shiftTab = new RendererCommandDispatcher(500, 400)
  shiftTab.resolve(shiftDown(), globalAt(5000))
  shiftTab.resolve(key({ key: 'Tab', code: 'Tab', shiftKey: true }), globalAt(5005))
  assert.equal(shiftTab.resolveKeyUp(shiftUp(), globalAt(5010)).kind, 'unmatched')

  // A Shift pressed while another modifier is held is not a lone tap.
  const decorated = new RendererCommandDispatcher(500, 400)
  decorated.resolve(shiftDown({ metaKey: true }), globalAt(6000))
  assert.equal(decorated.resolveKeyUp(shiftUp({ metaKey: true }), globalAt(6010)).kind, 'unmatched')
  decorated.resolve(shiftDown(), globalAt(6020))
  assert.equal(decorated.resolveKeyUp(shiftUp(), globalAt(6030)).kind, 'unmatched')

  // The whole point of the gesture: it fires with focus inside a terminal or an
  // editor, where target suppression withholds ⌘K.
  const inTerminal = new RendererCommandDispatcher(500, 400)
  inTerminal.resolve(shiftDown(), globalAt(7000, { isSuppressedTarget: suppressed }))
  inTerminal.resolveKeyUp(shiftUp(), globalAt(7010, { isSuppressedTarget: suppressed }))
  inTerminal.resolve(shiftDown(), globalAt(7100, { isSuppressedTarget: suppressed }))
  result = inTerminal.resolveKeyUp(shiftUp(), globalAt(7110, { isSuppressedTarget: suppressed }))
  assert.equal(result.kind, 'matched', 'double Shift fires inside .xterm, where ⌘K is suppressed')
  assert.equal(result.kind === 'matched' ? result.commandId : null, 'search.everywhere')
  // ⌘K in that same suppressed target stays withheld — the exemption is the
  // gesture's, not the command's.
  assert.equal(
    inTerminal.resolve(
      key({ key: 'k', code: 'KeyK', ctrlKey: true }),
      globalAt(7200, { isSuppressedTarget: suppressed }),
    ).kind,
    'unmatched',
  )

  // Disabling the command disables the gesture with it.
  const disabledTap = new RendererCommandDispatcher(500, 400)
  disabledTap.resolve(shiftDown(), globalAt(8000))
  disabledTap.resolveKeyUp(shiftUp(), globalAt(8010))
  disabledTap.resolve(shiftDown(), globalAt(8100))
  assert.equal(
    disabledTap.resolveKeyUp(shiftUp(), globalAt(8110, { disabledCommandIds: new Set(['search.everywhere']) })).kind,
    'unmatched',
  )
  // …and disabling the gesture leaves ⌘K alone, which is the whole reason the
  // two are separate commands (skills-everywhere, 2026-09-10).
  assert.equal(
    new RendererCommandDispatcher().resolve(key({ key: 'k', code: 'KeyK', metaKey: true }), {
      activeScopes: ['global'],
      platform: 'darwin',
      disabledCommandIds: new Set(['search.everywhere']),
      now: 8200,
    }).kind,
    'matched',
  )

  // reset() (the shell calls it when the window loses focus) drops a half-made
  // gesture, so a modifier released while another app had focus cannot complete.
  const blurred = new RendererCommandDispatcher(500, 400)
  blurred.resolve(shiftDown(), globalAt(9000))
  blurred.resolveKeyUp(shiftUp(), globalAt(9010))
  blurred.reset()
  blurred.resolve(shiftDown(), globalAt(9020))
  assert.equal(blurred.resolveKeyUp(shiftUp(), globalAt(9030)).kind, 'unmatched')

  // A non-modifier keyup is never the gesture.
  assert.equal(blurred.resolveKeyUp(key({ key: 'a', code: 'KeyA' }), globalAt(9100)).kind, 'unmatched')

  // A held Shift auto-repeats its keydown on Windows and Linux. A repeat is not a
  // fresh press: after a letter typed under the held Shift has disarmed the tap,
  // the repeats that follow must not arm it again before the release.
  const repeating = new RendererCommandDispatcher(500, 400)
  repeating.resolve(shiftDown(), globalAt(10000))
  repeating.resolveKeyUp(shiftUp(), globalAt(10010))
  repeating.resolve(shiftDown(), globalAt(10100))
  repeating.resolve(key({ key: 'A', code: 'KeyA', shiftKey: true }), globalAt(10110))
  repeating.resolve(shiftDown({ repeat: true }), globalAt(10150))
  repeating.resolve(shiftDown({ repeat: true }), globalAt(10200))
  assert.equal(
    repeating.resolveKeyUp(shiftUp(), globalAt(10250)).kind,
    'unmatched',
    'a repeat keydown after Shift+A cannot re-arm the tap',
  )
  // A repeat with no fresh press before it (the window gained focus with Shift
  // already held) never arms either.
  repeating.resolve(shiftDown({ repeat: true }), globalAt(10300))
  assert.equal(repeating.resolveKeyUp(shiftUp(), globalAt(10310)).kind, 'unmatched')
  repeating.resolve(shiftDown(), globalAt(10400))
  assert.equal(repeating.resolveKeyUp(shiftUp(), globalAt(10410)).kind, 'unmatched', 'only one clean tap was armed')
  // Repeats between a fresh press and its release are harmless: still one tap.
  const heldTap = new RendererCommandDispatcher(500, 400)
  heldTap.resolve(shiftDown(), globalAt(11000))
  heldTap.resolve(shiftDown({ repeat: true }), globalAt(11050))
  assert.equal(heldTap.resolveKeyUp(shiftUp(), globalAt(11100)).kind, 'unmatched')
  heldTap.resolve(shiftDown(), globalAt(11200))
  heldTap.resolve(shiftDown({ repeat: true }), globalAt(11250))
  assert.equal(
    heldTap.resolveKeyUp(shiftUp(), globalAt(11300)).kind,
    'matched',
    'two taps, each with repeats inside, still fire',
  )

  // Inside an IME composition a Shift release belongs to the IME, not to us.
  const composing = new RendererCommandDispatcher(500, 400)
  composing.resolve(shiftDown(), globalAt(12000))
  composing.resolveKeyUp(shiftUp(), globalAt(12010))
  composing.resolve(shiftDown({ isComposing: true }), globalAt(12100))
  assert.equal(
    composing.resolveKeyUp(shiftUp({ isComposing: true }), globalAt(12110)).kind,
    'unmatched',
    'a composing Shift release never completes the gesture',
  )
  composing.resolve(shiftDown(), globalAt(12200))
  assert.equal(
    composing.resolveKeyUp(shiftUp(), globalAt(12210)).kind,
    'unmatched',
    'and it disarmed the tap before it, so the next clean tap is a first tap',
  )

  console.log('command dispatcher module command tests passed')
})
