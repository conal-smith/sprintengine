import assert from 'node:assert/strict'

import { createRendererHost, type WorkspaceTypeDefinition } from './renderer-host'
import type { NotificationActionContext } from './renderer-host'
import type { AppNotification, LayoutTemplate } from '../types/workspace'
import { COMMAND_REGISTRY } from '../commands/commandRegistry'
import { test } from 'vitest'

test('renderer-host', async () => {
  const template: LayoutTemplate = {
    id: 'workspace-type-test',
    name: 'Workspace Type Test',
    description: 'Test template',
    previewSlots: [],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: false },
      borders: [],
      layout: {
        type: 'row',
        children: [],
      },
    },
  }

  function workspaceType(id: string, pickerOrder?: number): WorkspaceTypeDefinition {
    return {
      id,
      label: id,
      description: `${id} workspace`,
      icon() {
        throw new Error('icon component should not be evaluated during registration')
      },
      accentToken: `--tool-${id}`,
      searchTerms: [`${id}-term`],
      createTemplate() {
        return template
      },
      topBarViews: {
        label: id,
        views: [{ component: `${id}-view`, name: id }],
      },
      supervisors: [],
      creationStepsId: id,
      pickerOrder,
    }
  }

  const host = createRendererHost()
  const calendarType = workspaceType('calendar', 20)
  const notesType = workspaceType('notes', 10)
  const notebookType = workspaceType('notebook', 10)

  host.hostFor('calendar').registerWorkspaceType(calendarType)
  host.hostFor('notes').registerWorkspaceType(notesType)
  host.hostFor('notebook').registerWorkspaceType(notebookType)

  assert.throws(
    () => host.hostFor('other').registerWorkspaceType(workspaceType('calendar')),
    /Workspace type "calendar" is already registered/,
    'duplicate workspace type ids fail clearly',
  )
  assert.throws(
    () => host.hostFor('core').registerWorkspaceType(workspaceType('standard')),
    /shell-owned/,
    'standard stays owned by the workspace shell',
  )
  assert.throws(
    () => host.hostFor('blank').registerWorkspaceType(workspaceType('')),
    /non-empty string/,
    'blank workspace type ids are rejected before registration',
  )
  assert.throws(
    () => host.hostFor('blank').registerWorkspaceType(workspaceType('   ')),
    /non-empty string/,
    'whitespace-only workspace type ids are rejected before registration',
  )

  assert.equal(host.getWorkspaceType('calendar')?.moduleId, 'calendar')
  assert.equal(host.getWorkspaceType('calendar')?.createTemplate(), template)
  assert.equal(host.getWorkspaceTypeModule('notes'), 'notes')
  assert.equal(host.getWorkspaceType('missing'), undefined)
  assert.equal(host.getWorkspaceTypeModule('missing'), undefined)

  assert.deepEqual(
    host.getWorkspaceTypes().map((definition) => definition.id),
    ['notebook', 'notes', 'calendar'],
    'workspace types sort by pickerOrder, then id',
  )
  assert.deepEqual(
    host.getWorkspaceTypes((moduleId) => moduleId !== 'notes').map((definition) => definition.id),
    ['notebook', 'calendar'],
    'disabled modules are filtered from workspace type listings',
  )

  console.log('renderer host workspace type tests passed')

  // --- File Explorer action registry ------------------------------------------

  const fileActionHost = createRendererHost()
  fileActionHost.hostFor('weather-deck').registerFileAction({
    id: 'weather-deck.open-notes',
    label: 'Open forecast notes…',
    order: 10,
    isVisible: (context) => context.entries.some((entry) => entry.name.endsWith('.md')),
    run() {},
  })
  fileActionHost.hostFor('weather-deck').registerFileAction({
    id: 'weather-deck.open-html',
    label: 'Open forecast page…',
    order: 20,
    run() {},
  })
  fileActionHost.hostFor('notes').registerFileAction({
    id: 'notes.archive',
    label: 'Archive note',
    order: 5,
    run() {},
  })

  const registeredFileActions = fileActionHost.getFileActions()
  assert.deepEqual(
    registeredFileActions.map((action) => action.id),
    ['notes.archive', 'weather-deck.open-notes', 'weather-deck.open-html'],
    'file actions sort by order then label across modules',
  )
  assert.equal(registeredFileActions[1]?.moduleId, 'weather-deck', 'owning module is recorded for enablement gating')

  assert.throws(
    () =>
      fileActionHost.hostFor('weather-deck').registerFileAction({
        id: 'weather-deck.open-notes',
        label: 'Duplicate',
        run() {},
      }),
    /File action "weather-deck\.open-notes" is already registered/,
    'duplicate file-action ids fail clearly',
  )
  assert.throws(
    () =>
      fileActionHost.hostFor('weather-deck').registerFileAction({
        id: '   ',
        label: 'Blank',
        run() {},
      }),
    /File action id must be a non-empty string/,
    'blank file-action ids are rejected before registration',
  )

  console.log('renderer host file action tests passed')

  // --- Module command registry -------------------------------------------------

  const commandHost = createRendererHost()
  let helloRuns = 0
  commandHost.hostFor('demo-module').registerCommand({
    id: 'hello',
    title: 'Say Hello',
    category: 'Demo Module',
    scopes: ['global'],
    defaultKeybindings: ['Primary+Alt+H', 'Primary+Alt+H'],
    run() {
      helloRuns += 1
    },
  })
  commandHost.hostFor('other-module').registerCommand({
    id: 'hello',
    title: 'Other Hello',
    category: 'Other Module',
    scopes: ['workspace'],
    run() {},
  })

  const registeredHello = commandHost.getModuleCommand('demo-module.hello')
  assert.ok(registeredHello, 'module command registers under its namespaced id')
  assert.equal(registeredHello.moduleId, 'demo-module', 'owning module is recorded for enablement gating')
  assert.deepEqual(
    registeredHello.defaultKeybindings,
    ['primary+alt+h'],
    'default keybindings are normalized and de-duplicated like the shell registry',
  )
  const suiteRun1 = registeredHello.run({ activeWorkspaceId: null, activeWorkspaceMode: null })
  assert.equal(helloRuns, 1, 'the registered handler is the module-provided callback')

  assert.equal(
    commandHost.getModuleCommand('other-module.hello')?.title,
    'Other Hello',
    'the same bare id under another module is a distinct command',
  )

  assert.throws(
    () =>
      commandHost.hostFor('demo-module').registerCommand({
        id: 'hello',
        title: 'Say Hello Again',
        category: 'Demo Module',
        scopes: ['global'],
        run() {},
      }),
    /Module command "demo-module\.hello" is already registered/,
    'duplicate command-id registration is an explicit error',
  )
  // `chat.settle`, not the `workspace.new` or `workspace.close` this named until
  // the shell retired each of them. A test that names a command nothing
  // registers any more asserts nothing — and this one threw, which killed the
  // whole file: every assertion below it, the surface contracts included,
  // stopped running the day the shell's command list moved. Pinned against the
  // registry so it says so next time.
  assert.ok(
    COMMAND_REGISTRY.some((command) => command.id === 'chat.settle'),
    'the shadowing test has to name a command the shell actually registers, or it proves nothing',
  )
  assert.throws(
    () =>
      commandHost.hostFor('chat').registerCommand({
        id: 'settle',
        title: 'Shadow Settle Chat',
        category: 'Shadow',
        scopes: ['global'],
        run() {},
      }),
    /already registered by the application command registry/,
    'a module cannot take over a shell command id',
  )
  assert.throws(
    () =>
      commandHost.hostFor('demo-module').registerCommand({
        id: '   ',
        title: 'Blank',
        category: 'Demo Module',
        scopes: ['global'],
        run() {},
      }),
    /non-empty string/,
    'blank command ids are rejected',
  )
  assert.throws(
    () =>
      commandHost.hostFor('demo-module').registerCommand({
        id: 'untitled',
        title: '  ',
        category: 'Demo Module',
        scopes: ['global'],
        run() {},
      }),
    /non-empty title/,
    'blank titles are rejected',
  )
  assert.throws(
    () =>
      commandHost.hostFor('demo-module').registerCommand({
        id: 'scopeless',
        title: 'No Scope',
        category: 'Demo Module',
        scopes: [],
        run() {},
      }),
    /at least one scope/,
    'commands must declare a scope so dispatch and the palette can gate them',
  )

  assert.deepEqual(
    commandHost.getModuleCommands().map((command) => command.id),
    ['demo-module.hello', 'other-module.hello'],
    'module command listing is deterministic',
  )
  assert.deepEqual(
    commandHost.getModuleCommands((moduleId) => moduleId !== 'demo-module').map((command) => command.id),
    ['other-module.hello'],
    'disabled modules are filtered from module command listings',
  )

  const merged = commandHost.getCommandContributions()
  assert.equal(merged[0]?.id, 'app.settings.open', 'merge point keeps shell commands first (dispatch priority)')
  assert.ok(
    merged.some((command) => command.id === 'demo-module.hello'),
    'merge point includes enabled module commands',
  )
  const mergedWithoutDemo = commandHost.getCommandContributions((moduleId) => moduleId !== 'demo-module')
  assert.equal(
    mergedWithoutDemo.some((command) => command.id === 'demo-module.hello'),
    false,
    'merge point drops commands of disabled modules',
  )
  assert.ok(
    mergedWithoutDemo.some((command) => command.id === 'other-module.hello'),
    'other modules stay merged when one module is disabled',
  )
  // Re-enabling restores the contribution from the same registration — nothing
  // is torn down on disable, so user keybinding overrides stored by command id
  // re-attach without a reload.
  assert.ok(
    commandHost.getCommandContributions(() => true).some((command) => command.id === 'demo-module.hello'),
    're-enabling restores the registered command',
  )

  console.log('renderer host module command tests passed')

  // --- Settings section registry -----------------------------------------------

  const sectionHost = createRendererHost()
  const sectionIcon = () => {
    throw new Error('icon component should not be evaluated during registration')
  }
  const sectionComponent = () => {
    throw new Error('section component should not be evaluated during registration')
  }
  sectionHost.hostFor('demo-module').registerSettingsSection({
    id: 'demo-general',
    label: 'Demo Module',
    icon: sectionIcon,
    Component: sectionComponent,
    order: 20,
  })
  sectionHost.hostFor('other-module').registerSettingsSection({
    id: 'other-general',
    label: 'Other Module',
    description: 'Other module preferences',
    icon: sectionIcon,
    Component: sectionComponent,
    order: 10,
  })

  assert.equal(
    sectionHost.getSettingsSections().find((section) => section.id === 'demo-general')?.moduleId,
    'demo-module',
    'settings sections record their owning module for enablement gating',
  )
  assert.throws(
    () =>
      sectionHost.hostFor('third-module').registerSettingsSection({
        id: 'demo-general',
        label: 'Impostor',
        icon: sectionIcon,
        Component: sectionComponent,
      }),
    /Settings section "demo-general" is already registered by module "demo-module"/,
    'duplicate section ids fail with an explicit error naming the owner',
  )
  assert.throws(
    () =>
      sectionHost.hostFor('demo-module').registerSettingsSection({
        id: '   ',
        label: 'Blank',
        icon: sectionIcon,
        Component: sectionComponent,
      }),
    /non-empty string/,
    'blank section ids are rejected',
  )
  assert.deepEqual(
    sectionHost.getSettingsSections().map((section) => section.id),
    ['other-general', 'demo-general'],
    'sections sort by order hint then id — stable across reloads',
  )
  assert.deepEqual(
    sectionHost.getSettingsSections((moduleId) => moduleId !== 'demo-module').map((section) => section.id),
    ['other-general'],
    "a disabled module's section is filtered out reactively",
  )
  assert.deepEqual(
    sectionHost.getSettingsSections(() => true).map((section) => section.id),
    ['other-general', 'demo-general'],
    're-enabling restores the registered section without re-registration',
  )

  console.log('renderer host settings section tests passed')

  // --- Sidebar nav entries (the top-nav host contribution point) ----------------

  const navHost = createRendererHost()
  const navComponent = () => {
    throw new Error('nav entry component should not be evaluated during registration')
  }
  // A first-party door and a third-party module's door register through the same
  // contract — this is what lets an SDK module contribute an instance-level door.
  navHost.hostFor('roadmap').registerSidebarNavEntry({ id: 'roadmap', order: 40, Component: navComponent })
  navHost.hostFor('acme.compass').registerSidebarNavEntry({ id: 'compass', order: 15, Component: navComponent })

  assert.equal(
    navHost.getSidebarNavEntries().find((entry) => entry.id === 'roadmap')?.moduleId,
    'roadmap',
    'sidebar nav entries record their owning module for enablement gating',
  )
  assert.throws(
    () => navHost.hostFor('impostor').registerSidebarNavEntry({ id: 'roadmap', order: 1, Component: navComponent }),
    /Sidebar nav entry "roadmap" is already registered by module "roadmap"/,
    'duplicate nav entry ids fail with an explicit error naming the owner',
  )
  assert.throws(
    () => navHost.hostFor('roadmap').registerSidebarNavEntry({ id: '  ', order: 1, Component: navComponent }),
    /non-empty string/,
    'blank nav entry ids are rejected',
  )
  assert.deepEqual(
    navHost.getSidebarNavEntries().map((entry) => entry.id),
    ['compass', 'roadmap'],
    'nav entries sort by order then id — deterministic across reloads',
  )
  assert.deepEqual(
    navHost.getSidebarNavEntries((moduleId) => moduleId !== 'roadmap').map((entry) => entry.id),
    ['compass'],
    "a disabled module's nav door is filtered out reactively — the toggle needs no reload",
  )
  assert.deepEqual(
    navHost.getSidebarNavEntries(() => true).map((entry) => entry.id),
    ['compass', 'roadmap'],
    're-enabling restores the door without re-registration',
  )

  console.log('renderer host sidebar nav entry tests passed')

  // --- Door / nav-entry badge contributions --------------------------

  const doorBadgeHost = createRendererHost()
  doorBadgeHost.hostFor('calendar').registerDoorBadge({
    rowId: 'calendar',
    notificationSource: 'agents',
    getWaitingCount: () => 2,
    subscribe: () => () => undefined,
  })
  doorBadgeHost.hostFor('calendar').registerDoorBadge({
    rowId: 'agenda',
    getWaitingCount: () => 1,
    subscribe: () => () => undefined,
  })
  assert.deepEqual(
    doorBadgeHost.getDoorBadges().map((badge) => [badge.rowId, badge.moduleId, badge.getWaitingCount()]),
    [
      ['calendar', 'calendar', 2],
      ['agenda', 'calendar', 1],
    ],
    'both doors contribute waiting counts under the owning module',
  )
  assert.equal(
    doorBadgeHost.getDoorBadges().find((badge) => badge.rowId === 'calendar')?.notificationSource,
    'agents',
    'an unnamed notice of that source falls to the row via the contribution, not a core mapping',
  )
  assert.throws(
    () =>
      doorBadgeHost.hostFor('other').registerDoorBadge({
        rowId: 'calendar',
        getWaitingCount: () => 0,
        subscribe: () => () => undefined,
      }),
    /already registered by module "calendar"/,
    'one badge per row — a duplicate rowId fails with the holder named',
  )
  assert.throws(
    () =>
      createRendererHost()
        .hostFor('calendar')
        .registerDoorBadge({
          rowId: '  ',
          getWaitingCount: () => 0,
          subscribe: () => () => undefined,
        }),
    /row id must be a non-empty string/,
  )
  assert.deepEqual(
    doorBadgeHost.getDoorBadges((moduleId) => moduleId !== 'calendar').map((badge) => badge.rowId),
    [],
    "a disabled module's door badges are filtered out reactively",
  )

  console.log('renderer host door badge tests passed')

  // --- Top bar items (the title-strip host contribution point) ---------

  const topBarHost = createRendererHost()
  const topBarComponent = () => {
    throw new Error('top bar item component should not be evaluated during registration')
  }
  topBarHost
    .hostFor('fixture-module')
    .registerTopBarItem({ id: 'fixture-module', order: 10, Component: topBarComponent })
  topBarHost.hostFor('acme.compass').registerTopBarItem({ id: 'compass', order: 5, Component: topBarComponent })

  assert.equal(
    topBarHost.getTopBarItems().find((item) => item.id === 'fixture-module')?.moduleId,
    'fixture-module',
    'top bar items record their owning module for enablement gating',
  )
  assert.throws(
    () =>
      topBarHost.hostFor('impostor').registerTopBarItem({ id: 'fixture-module', order: 1, Component: topBarComponent }),
    /Top bar item "fixture-module" is already registered by module "fixture-module"/,
    'duplicate top bar item ids fail with an explicit error naming the owner',
  )
  assert.throws(
    () => topBarHost.hostFor('fixture-module').registerTopBarItem({ id: '  ', order: 1, Component: topBarComponent }),
    /non-empty string/,
    'blank top bar item ids are rejected',
  )
  assert.deepEqual(
    topBarHost.getTopBarItems().map((item) => item.id),
    ['compass', 'fixture-module'],
    'top bar items sort by order then id — deterministic across reloads',
  )
  assert.deepEqual(
    topBarHost.getTopBarItems((moduleId) => moduleId !== 'fixture-module').map((item) => item.id),
    ['compass'],
    "a disabled module's top bar control is filtered out reactively — the toggle needs no reload",
  )
  assert.deepEqual(
    topBarHost.getTopBarItems(() => true).map((item) => item.id),
    ['compass', 'fixture-module'],
    're-enabling restores the control without re-registration',
  )

  console.log('renderer host top bar item tests passed')

  // --- One module's contributions across surfaces -------------------
  // A module that registers a top-bar control, a command and a settings section
  // through the host is gated by the enablement filter alone: disabling it
  // removes every entry point, with no selectModuleEnabled(...) checks in core
  // consumers.

  const fixtureKernel = createRendererHost()
  const fixtureHost = fixtureKernel.hostFor('fixture-module')
  fixtureHost.registerTopBarItem({ id: 'fixture-module', order: 10, Component: topBarComponent })
  fixtureHost.registerCommand({
    id: 'toggle',
    title: 'Toggle Fixture',
    category: 'Fixture',
    scopes: ['global'],
    defaultKeybindings: ['Primary+Shift+1'],
    run: () => undefined,
  })
  fixtureHost.registerSettingsSection({
    id: 'fixture-module',
    label: 'Fixture',
    icon: sectionIcon,
    Component: sectionComponent,
  })

  const fixtureEnabled = () => true
  const fixtureDisabled = (moduleId: string) => moduleId !== 'fixture-module'
  assert.equal(
    fixtureKernel.getTopBarItems(fixtureEnabled).some((item) => item.id === 'fixture-module'),
    true,
    'the module contributes its top-bar control',
  )
  assert.equal(
    fixtureKernel.getModuleCommands(fixtureEnabled).some((command) => command.id === 'fixture-module.toggle'),
    true,
    'the module contributes its command under the namespaced id',
  )
  assert.deepEqual(
    fixtureKernel.getModuleCommand('fixture-module.toggle')?.defaultKeybindings,
    ['primary+shift+1'],
    'the command keeps its default binding through the module path (host-normalized form)',
  )
  assert.equal(
    fixtureKernel.getSettingsSections(fixtureEnabled).some((section) => section.id === 'fixture-module'),
    true,
    'the module contributes its settings section',
  )
  assert.equal(
    [
      ...fixtureKernel.getTopBarItems(fixtureDisabled),
      ...fixtureKernel.getModuleCommands(fixtureDisabled),
      ...fixtureKernel.getSettingsSections(fixtureDisabled),
    ].length,
    0,
    'disabling the module removes the control, the shortcut, and the settings tab because nothing registered them',
  )

  console.log('module contribution gating tests passed')

  // --- Global surfaces (door-routed full-page surface registry, epic 1704) -------

  const surfaceHost = createRendererHost()
  const surfaceComponent = () => {
    throw new Error('surface component should not be evaluated during registration')
  }
  // A first-party surface and a third-party module's surface register through the
  // same contract — the seam that lets Automations (and SDK
  // modules) contribute a full page without editing WorkspaceManager. ('roadmap'
  // below is an arbitrary module id; the door of that name is long gone.)
  surfaceHost.hostFor('roadmap').registerGlobalSurface({ id: 'roadmap', Component: surfaceComponent })
  surfaceHost.hostFor('acme.compass').registerGlobalSurface({ id: 'compass', Component: surfaceComponent })

  assert.equal(
    surfaceHost.getGlobalSurface('roadmap')?.moduleId,
    'roadmap',
    'a global surface records its owning module so the mount can gate on enablement',
  )
  assert.equal(surfaceHost.getGlobalSurface('missing'), undefined, 'an unregistered surface id resolves to undefined')
  assert.throws(
    () => surfaceHost.hostFor('impostor').registerGlobalSurface({ id: 'roadmap', Component: surfaceComponent }),
    /Global surface "roadmap" is already registered by module "roadmap"/,
    'duplicate surface ids fail with an explicit error naming the owner',
  )
  assert.throws(
    () => surfaceHost.hostFor('roadmap').registerGlobalSurface({ id: '  ', Component: surfaceComponent }),
    /non-empty string/,
    'blank surface ids are rejected before registration',
  )
  assert.deepEqual(
    surfaceHost.getGlobalSurfaces().map((surface) => surface.id),
    ['compass', 'roadmap'],
    'global surfaces list in a stable id order',
  )
  // The mount reads getGlobalSurface(id) then gates on the owning module: a
  // disabled module's surface is filtered out reactively, so a stale open flag
  // after a module toggle can never strand the card region on a blank page.
  assert.deepEqual(
    surfaceHost.getGlobalSurfaces((moduleId) => moduleId !== 'roadmap').map((surface) => surface.id),
    ['compass'],
    "a disabled module's surface is filtered out reactively",
  )
  assert.deepEqual(
    surfaceHost.getGlobalSurfaces(() => true).map((surface) => surface.id),
    ['compass', 'roadmap'],
    're-enabling restores the surface without re-registration',
  )

  // A door carries the chrome that OFFERS it (Extensions drawer ruling,
  // 2026-09-05): a name and a glyph for the drawer row or rail square that opens
  // it, `views` when one surface is several destinations to the person, and where
  // its own rail goes. All optional — a module that draws its own nav-entry row
  // names itself there — and validated here, where a module can see the failure,
  // rather than silently producing a row nothing can select.
  {
    const chromeIcon = () => {
      throw new Error('surface icon should not be evaluated during registration')
    }
    const doorHost = createRendererHost()
    doorHost.hostFor('acme.compass').registerGlobalSurface({
      id: 'compass',
      label: 'Compass',
      Icon: chromeIcon,
      railPlacement: 'inline',
      views: [{ id: 'near', label: 'Near', Icon: chromeIcon, open() {} }],
      Component: surfaceComponent,
    })
    const compass = doorHost.getGlobalSurface('compass')
    assert.equal(compass?.label, 'Compass', 'a door’s name reaches the chrome that offers it')
    assert.equal(compass?.railPlacement, 'inline', 'and so does where its rail goes')
    assert.deepEqual(
      compass?.views?.map((view) => view.id),
      ['near'],
      'a registered door carries its views through to the drawer that places them',
    )
    assert.throws(
      () =>
        doorHost.hostFor('acme.compass').registerGlobalSurface({
          id: 'blank-label',
          label: '  ',
          Component: surfaceComponent,
        }),
      /empty label/,
      'a door with a blank label is rejected — omitting it is how a door says it names itself elsewhere',
    )
    // A view id is what the surface publishes to say which row is showing, so a
    // blank or duplicated one would light two rows at once — or none — instead of
    // failing here.
    assert.throws(
      () =>
        doorHost.hostFor('acme.compass').registerGlobalSurface({
          id: 'blank-view-id',
          Component: surfaceComponent,
          views: [{ id: '  ', label: 'A', Icon: chromeIcon, open() {} }],
        }),
      /view with an empty id/,
      'a view without an id is rejected: nothing could ever publish it',
    )
    assert.throws(
      () =>
        doorHost.hostFor('acme.compass').registerGlobalSurface({
          id: 'blank-view-label',
          Component: surfaceComponent,
          views: [{ id: 'a', label: '  ', Icon: chromeIcon, open() {} }],
        }),
      /non-empty label/,
      'a view without a label is rejected — the label is the drawer row’s name',
    )
    assert.throws(
      () =>
        doorHost.hostFor('acme.compass').registerGlobalSurface({
          id: 'dupe-views',
          Component: surfaceComponent,
          views: [
            { id: 'a', label: 'A', Icon: chromeIcon, open() {} },
            { id: 'a', label: 'Also A', Icon: chromeIcon, open() {} },
          ],
        }),
      /registers view "a" twice/,
      'two views cannot share an id, or the published view would select both rows',
    )
    // The id is STORED as it was validated. A padded id passed the trim check and
    // was then kept untrimmed, so the drawer's lookup missed it and the row could
    // never be selected — with nothing on screen to explain why.
    doorHost.hostFor('acme.compass').registerGlobalSurface({
      id: 'padded-views',
      Component: surfaceComponent,
      views: [{ id: '  near  ', label: 'Near', Icon: chromeIcon, open() {} }],
    })
    assert.deepEqual(
      doorHost.getGlobalSurface('padded-views')?.views?.map((view) => view.id),
      ['near'],
      'a view id is stored normalised, so the registry and the drawer agree character for character',
    )
    // The SURFACE's own id is normalised for the same reason its views' are: a
    // padded id passed the check, was stored padded, and then matched nothing —
    // not the drawer's lookup, not `activeGlobalSurface`, not the door that opens
    // it. The mount would simply never happen.
    doorHost.hostFor('acme.compass').registerGlobalSurface({
      id: '  padded-surface  ',
      Component: surfaceComponent,
    })
    assert.equal(
      doorHost.getGlobalSurface('padded-surface')?.id,
      'padded-surface',
      'a surface id is stored normalised, so the door that opens it and the registry agree',
    )
    // `railPlacement` decides whether the door TAKES the sidebar column, and an
    // unknown value fell through to the more destructive default: a drawer row
    // that meant `inline` would have deleted the drawer that opened it, silently.
    assert.throws(
      () =>
        doorHost.hostFor('acme.compass').registerGlobalSurface({
          id: 'bad-placement',
          Component: surfaceComponent,
          railPlacement: 'floating' as never,
        }),
      /unknown railPlacement/,
      'an unrecognised railPlacement is rejected rather than defaulting to taking the column',
    )
    assert.throws(
      () =>
        doorHost.hostFor('acme.compass').registerGlobalSurface({
          id: 'extensions-home',
          Component: surfaceComponent,
        }),
      /reserved for the app/,
      'the "extensions-home" id is reserved — the Extensions home is the app\'s own, never a module\'s to claim',
    )
  }

  console.log('renderer host global surface tests passed')

  // --- Modal surfaces (doors→modals, 2026-09-01) --------------------------------

  // A first-party modal surface and a third-party module's register through the
  // same contract — the seam that lets an SDK module contribute a modal surface
  // without editing the shell. The body is all of it now: the settings-cluster
  // trigger glyph the doors→modals ruling put beside each one went with that
  // ruling (Extensions drawer, 2026-09-05), so a modal surface is opened from
  // inside the content it floats over and `order`/`Icon` are optional leftovers.
  const modalHost = createRendererHost()
  const modalComponent = () => {
    throw new Error('modal surface component should not be evaluated during registration')
  }
  const modalIcon = () => {
    throw new Error('modal surface icon should not be evaluated during registration')
  }
  modalHost.hostFor('design').registerModalSurface({
    id: 'design',
    order: 30,
    label: 'Design',
    Icon: modalIcon,
    Component: modalComponent,
  })
  modalHost.hostFor('acme.compass').registerModalSurface({
    id: 'compass',
    order: 15,
    label: 'Compass',
    Icon: modalIcon,
    Component: modalComponent,
  })

  assert.equal(
    modalHost.getModalSurface('design')?.moduleId,
    'design',
    'a modal surface records its owning module so trigger and mount can gate on enablement',
  )
  assert.equal(
    modalHost.getModalSurface('missing'),
    undefined,
    'an unregistered modal surface id resolves to undefined',
  )
  assert.throws(
    () =>
      modalHost.hostFor('impostor').registerModalSurface({
        id: 'design',
        order: 1,
        label: 'Design',
        Icon: modalIcon,
        Component: modalComponent,
      }),
    /Modal surface "design" is already registered by module "design"/,
    'duplicate modal surface ids fail with an explicit error naming the owner',
  )
  assert.throws(
    () =>
      modalHost.hostFor('design').registerModalSurface({
        id: '  ',
        order: 1,
        label: 'X',
        Icon: modalIcon,
        Component: modalComponent,
      }),
    /non-empty string/,
    'blank modal surface ids are rejected before registration',
  )
  assert.throws(
    () =>
      modalHost.hostFor('design').registerModalSurface({
        id: 'blank-label',
        order: 1,
        label: '  ',
        Icon: modalIcon,
        Component: modalComponent,
      }),
    /non-empty label/,
    'a modal surface without a label is rejected — the label is the trigger tooltip and the dialog name',
  )
  // `views` is deliberately NOT part of the modal contract (Extensions drawer
  // ruling, 2026-09-05): a view is a row of the Extensions drawer, and the drawer
  // is made of doors. It lives on `registerGlobalSurface` instead, asserted above.

  assert.throws(
    () =>
      modalHost.hostFor('acme.compass').registerModalSurface({
        id: 'settings',
        order: 1,
        label: 'Settings',
        Icon: modalIcon,
        Component: modalComponent,
      }),
    /reserved for the app/,
    'the "settings" id is reserved — core Settings never registers here, so without this a module could claim it',
  )
  assert.throws(
    () =>
      modalHost.hostFor('acme.compass').registerModalSurface({
        id: 'usage',
        order: 1,
        label: 'Usage',
        Icon: modalIcon,
        Component: modalComponent,
      }),
    /reserved for the app/,
    'the "usage" id is reserved — the usage dashboard is the app\'s own and opens from the same cluster',
  )
  // The Diff popout is gone (git-commit-window T3): a diff opens in its own OS
  // window or in the pane's Diff tab, so nothing core answers to `diff` any more
  // and the id is a module's to claim like any other. Asserted on a host of its
  // own so the ordering assertions below still read the two surfaces above.
  {
    const diffIdHost = createRendererHost()
    diffIdHost.hostFor('acme.compass').registerModalSurface({
      id: 'diff',
      order: 1,
      label: 'Diff',
      Icon: modalIcon,
      Component: modalComponent,
    })
    assert.equal(
      diffIdHost.getModalSurface('diff')?.moduleId,
      'acme.compass',
      'the retired "diff" reservation no longer refuses a module that wants the id',
    )
  }
  assert.deepEqual(
    modalHost.getModalSurfaces().map((surface) => surface.id),
    ['compass', 'design'],
    'modal surfaces sort by order then id — the trigger cluster reads the same across reloads',
  )
  assert.deepEqual(
    modalHost.getModalSurfaces((moduleId) => moduleId !== 'design').map((surface) => surface.id),
    ['compass'],
    "a disabled module's modal surface is filtered out reactively — trigger and mount leave together",
  )
  assert.deepEqual(
    modalHost.getModalSurfaces(() => true).map((surface) => surface.id),
    ['compass', 'design'],
    're-enabling restores the modal surface without re-registration',
  )

  // --- The contributed pane row (D7) --------------------------------------------
  // A modal surface may carry the workspace-pane row that opens it. That row is
  // the ONE trigger the shell draws for a modal, so its fields are validated at
  // registration: a malformed launcher would otherwise be a row whose shortcut
  // silently never fires, or a card with nothing drawn in it.
  {
    const launcherHost = createRendererHost()
    const glyph = () => {
      throw new Error('launcher glyph should not be evaluated during registration')
    }
    launcherHost.hostFor('acme.reviews').registerModalSurface({
      id: 'reviews',
      label: 'Reviews',
      launcher: { label: '  Reviews  ', letter: 'r', Glyph: glyph },
      Component: modalComponent,
    })
    launcherHost.hostFor('design').registerModalSurface({
      id: 'design',
      order: 30,
      label: 'Design',
      Component: modalComponent,
    })

    assert.deepEqual(
      launcherHost.getModalSurfaceLaunchers().map((launcher) => ({
        surfaceId: launcher.surfaceId,
        moduleId: launcher.moduleId,
        label: launcher.label,
        letter: launcher.letter,
      })),
      [{ surfaceId: 'reviews', moduleId: 'acme.reviews', label: 'Reviews', letter: 'R' }],
      'a launcher is normalised (trimmed label, uppercased letter) and carries its surface + module; a surface without one contributes no row',
    )
    assert.deepEqual(
      launcherHost.getModalSurfaceLaunchers((moduleId) => moduleId !== 'acme.reviews'),
      [],
      "a disabled module's row leaves the pane with the module",
    )
    assert.equal(
      launcherHost.getModalSurfaceLaunchers()[0]?.Glyph,
      glyph,
      "the glyph is handed through by reference — the pane draws the module's own mark",
    )

    const bad =
      (launcher: unknown): (() => void) =>
      () =>
        launcherHost.hostFor('acme.reviews').registerModalSurface({
          id: `bad-${Math.random()}`,
          label: 'Bad',
          launcher: launcher as { label: string; letter: string; Glyph: typeof glyph },
          Component: modalComponent,
        })
    assert.throws(
      bad({ label: '   ', letter: 'X', Glyph: glyph }),
      /launcher with an empty label/,
      'a row with no name is refused — the label IS the row',
    )
    assert.throws(
      bad({ label: 'Bad', letter: 'XY', Glyph: glyph }),
      /must be exactly one character/,
      'a multi-character letter is refused: the menu compares a single keypress',
    )
    assert.throws(
      bad({ label: 'Bad', letter: '', Glyph: glyph }),
      /must be exactly one character/,
      "and so is an empty one — losing the shortcut is the host's call on collision, not the module's",
    )
    assert.throws(bad({ label: 'Bad', letter: 'X' }), /without a Glyph/, 'a row with no mark is refused')
  }

  console.log('renderer host modal surface tests passed')

  // --- Notification action providers ---

  function notification(overrides: Partial<AppNotification> = {}): AppNotification {
    return {
      id: 'n1',
      timestamp: '2026-06-16T00:00:00.000Z',
      level: 'warning',
      source: 'agents',
      title: 'Needs input',
      message: 'A task is waiting.',
      read: false,
      workspaceId: 'ws-1',
      ...overrides,
    }
  }

  const notificationHost = createRendererHost()
  let revealed: string | null = null
  const context: NotificationActionContext = {
    notification: notification({ navigationTarget: { kind: 'task', ref: 'T-7' } }),
    revealWorkspace: (id) => {
      revealed = id
    },
  }

  notificationHost.hostFor('calendar').registerNotificationActionProvider({
    source: 'agents',
    resolveActions: ({ notification: entry, revealWorkspace }) => {
      const target = entry.navigationTarget
      if (!entry.workspaceId || target?.kind !== 'task' || !target.ref) return []
      return [
        {
          id: 'open-task',
          label: 'Open',
          run: () => revealWorkspace(entry.workspaceId as string),
        },
      ]
    },
  })

  assert.throws(
    () =>
      notificationHost.hostFor('other').registerNotificationActionProvider({
        source: 'agents',
        resolveActions: () => [],
      }),
    /Notification action provider for source "agents" is already registered by module "calendar"/,
    'one provider per source — a duplicate source registration fails clearly',
  )

  const providers = notificationHost.getNotificationActionProviders()
  assert.equal(providers.length, 1, 'the registered provider is returned')
  assert.equal(providers[0]?.moduleId, 'calendar', 'the provider records its owning module')

  const actions = providers[0]!.resolveActions(context)
  assert.deepEqual(
    actions.map((action) => action.id),
    ['open-task'],
    'resolveActions surfaces the deep-link action for a task-targeted notification',
  )
  const suiteRun2 = actions[0]!.run(context)
  assert.equal(revealed, 'ws-1', 'running the action composes the shell revealWorkspace capability')

  assert.deepEqual(
    providers[0]!.resolveActions({
      notification: notification({ navigationTarget: undefined }),
      revealWorkspace: () => {},
    }),
    [],
    'a notification with no task target yields no provider action (shell reveal fallback covers it)',
  )

  assert.deepEqual(
    notificationHost.getNotificationActionProviders((moduleId) => moduleId !== 'calendar'),
    [],
    "a disabled module's provider is filtered out reactively",
  )

  console.log('renderer host notification action provider tests passed')

  // ── Renderer→module-main bridge invoke ───────────────────────────────────────
  // invoke validates the module-id prefix before any IPC and unwraps the
  // structured bridge result from window.api.moduleBridgeInvoke.

  async function testBridgeInvoke(): Promise<void> {
    const bridgeCalls: Array<{ channel: string; payload: unknown }> = []
    let bridgeOutcome: { ok: true; result: unknown } | { ok: false; code: string; message: string } = {
      ok: true,
      result: { summary: 'clear' },
    }
    ;(globalThis as { window?: unknown }).window = {
      api: {
        moduleBridgeInvoke: async (channel: string, payload?: unknown) => {
          bridgeCalls.push({ channel, payload })
          return bridgeOutcome
        },
      },
    }

    try {
      const invokeHost = createRendererHost().hostFor('weather-deck')

      await assert.rejects(
        () => invokeHost.invoke('automations:list'),
        /Module "weather-deck" may only invoke its own channels \("weather-deck:\*"\); got "automations:list"\./,
        'invoking outside the module namespace throws before IPC',
      )
      assert.equal(bridgeCalls.length, 0, 'prefix validation happens before any bridge call')

      const result = await invokeHost.invoke('weather-deck:forecast', 'Dublin')
      assert.deepEqual(result, { summary: 'clear' }, 'a successful bridge result is unwrapped')
      assert.deepEqual(
        bridgeCalls,
        [{ channel: 'weather-deck:forecast', payload: 'Dublin' }],
        'invoke forwards channel and payload to the preload bridge',
      )

      bridgeOutcome = {
        ok: false,
        code: 'permission_missing',
        message: 'Module "weather-deck" does not declare "module:bridge".',
      }
      await assert.rejects(
        () => invokeHost.invoke('weather-deck:forecast'),
        (error: unknown) =>
          error instanceof Error &&
          /does not declare "module:bridge"/.test(error.message) &&
          (error as Error & { code?: string }).code === 'permission_missing',
        'a refusal surfaces as a thrown Error carrying the message and the structured code',
      )
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
    console.log('renderer host bridge invoke tests passed')
  }

  const suiteRun3 = testBridgeInvoke().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })

  // ── Backlog reader seam ──────────────────────────────────────────────────────
  // The kernel owns the slot and the gating; the backlog module owns the
  // implementation. Errors name the actual cause (no reader vs disabled).

  async function testBacklogReaderSeam(): Promise<void> {
    const kernel = createRendererHost()
    const consumer = kernel.hostFor('weather-deck')

    await assert.rejects(
      () => consumer.listBacklogItems('ws-1'),
      /No Backlog reader is registered/,
      'a missing reader is named as the cause',
    )
    assert.throws(
      () => consumer.watchBacklogItems('ws-1', () => {}),
      /No Backlog reader is registered/,
      'watch fails the same way synchronously',
    )

    const listed: string[] = []
    const watched: string[] = []
    const fakeItems = [{ id: 'item-1' }, { id: 'item-2' }] as unknown as Awaited<
      ReturnType<typeof consumer.listBacklogItems>
    >
    kernel.hostFor('backlog').provideBacklogReader({
      list: async (workspaceId) => {
        listed.push(workspaceId)
        return fakeItems
      },
      watch: (workspaceId, cb) => {
        watched.push(workspaceId)
        cb(fakeItems)
        return () => watched.push(`off:${workspaceId}`)
      },
    })

    assert.throws(
      () => kernel.hostFor('impostor').provideBacklogReader({ list: async () => [], watch: () => () => {} }),
      /only the backlog module can/,
      'only the backlog module may serve the Backlog read API',
    )
    assert.throws(
      () => kernel.hostFor('backlog').provideBacklogReader({ list: async () => [], watch: () => () => {} }),
      /already provided by module "backlog"/,
      'the reader slot is single-occupancy with a named owner',
    )

    assert.deepEqual(await consumer.listBacklogItems('ws-1'), fakeItems, 'list routes through the provided reader')
    assert.deepEqual(listed, ['ws-1'])

    let seen: unknown = null
    const off = consumer.watchBacklogItems('ws-2', (items) => {
      seen = items
    })
    assert.deepEqual(seen, fakeItems, 'watch fires immediately with the current snapshot')
    off()
    assert.deepEqual(watched, ['ws-2', 'off:ws-2'], 'the unsubscribe closure reaches the reader')

    // Live enablement gates both methods once a resolver is wired.
    kernel.setModuleEnablementResolver((moduleId) => moduleId !== 'backlog')
    await assert.rejects(
      () => consumer.listBacklogItems('ws-1'),
      /Backlog module is disabled/,
      'a disabled backlog module is named as the cause',
    )
    assert.throws(() => consumer.watchBacklogItems('ws-1', () => {}), /Backlog module is disabled/)
    kernel.setModuleEnablementResolver(() => true)
    assert.equal((await consumer.listBacklogItems('ws-3')).length, 2, 're-enabling restores access')

    // An active watch is re-gated per delivery: disabling stops the stream
    // mid-subscription (and re-enabling resumes it) instead of the watch
    // outliving the toggle.
    const liveEmitters: Array<(items: typeof fakeItems) => void> = []
    const emitToAll = (): void => liveEmitters.forEach((emit) => emit(fakeItems))
    const gatedKernel = createRendererHost()
    gatedKernel.hostFor('backlog').provideBacklogReader({
      list: async () => fakeItems,
      watch: (_workspaceId, cb) => {
        liveEmitters.push(cb)
        return () => {}
      },
    })
    let backlogEnabled = true
    gatedKernel.setModuleEnablementResolver((moduleId) => moduleId !== 'backlog' || backlogEnabled)
    const delivered: number[] = []
    gatedKernel.hostFor('weather-deck').watchBacklogItems('ws-1', (items) => delivered.push(items.length))
    emitToAll()
    backlogEnabled = false
    emitToAll()
    backlogEnabled = true
    emitToAll()
    assert.deepEqual(delivered, [2, 2], 'deliveries stop while the backlog module is disabled and resume after')

    // A throwing module callback never breaks the shared emit loop: the exploding
    // subscriber is contained by the kernel wrapper, and the healthy subscriber
    // still receives the same emit.
    const explodingOff = gatedKernel.hostFor('weather-deck').watchBacklogItems('ws-1', () => {
      throw new Error('module bug')
    })
    emitToAll()
    assert.deepEqual(
      delivered,
      [2, 2, 2],
      'the healthy subscriber still receives the emit the throwing one broke out of',
    )
    explodingOff()

    console.log('renderer host backlog reader seam tests passed')
  }

  const suiteRun4 = testBacklogReaderSeam().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })

  // ── The module-boundary surfaces ──────────────────────────────────

  function testModuleAppState(): void {
    // Unwired (early boot, tests): reads are undefined, writes report false, and a
    // watch is a working no-op \u2014 never a throw, so module code needs no guard.
    const bare = createRendererHost()
    assert.equal(bare.hostFor('notebooks').getModuleAppState('run-defaults'), undefined)
    assert.equal(bare.hostFor('notebooks').setModuleAppState('run-defaults', { depth: 'brief' }), false)
    assert.doesNotThrow(() => bare.hostFor('notebooks').watchModuleAppState(() => {})())

    const kernel = createRendererHost()
    const store = new Map<string, Record<string, unknown>>()
    const listeners = new Set<{ moduleId: string; cb: (values: Readonly<Record<string, unknown>>) => void }>()
    const empty: Readonly<Record<string, unknown>> = Object.freeze({})
    // Registered BEFORE the store is wired: modules register synchronously at
    // import, the store lands a microtask later, and a watch made in that window
    // must attach when it does rather than silently dying.
    const early: unknown[] = []
    kernel.hostFor('notebooks').watchModuleAppState((values) => early.push(values['run-defaults']))
    kernel.setModuleAppStateStore({
      get: (moduleId) => store.get(moduleId) ?? empty,
      set: (moduleId, key, value) => {
        const next = { ...store.get(moduleId) }
        if (value === undefined) delete next[key]
        else next[key] = value
        store.set(moduleId, next)
        for (const listener of listeners) if (listener.moduleId === moduleId) listener.cb(next)
        return true
      },
      subscribe: (moduleId, cb) => {
        const entry = { moduleId, cb }
        listeners.add(entry)
        return () => listeners.delete(entry)
      },
    })

    const notebooks = kernel.hostFor('notebooks')
    const weather = kernel.hostFor('weather-deck')
    notebooks.setModuleAppState('run-defaults', { depth: 'brief' })
    assert.deepEqual(early, [{ depth: 'brief' }], 'a watch made before the store was wired still fires')
    assert.equal(notebooks.setModuleAppState('run-defaults', { depth: 'thorough' }), true)
    assert.deepEqual(notebooks.getModuleAppState('run-defaults'), { depth: 'thorough' })
    assert.equal(
      weather.getModuleAppState('run-defaults'),
      undefined,
      'the scope is per module \u2014 one module can never read another\u2019s key',
    )

    const seen: unknown[] = []
    const off = notebooks.watchModuleAppState((values) => seen.push(values['run-defaults']))
    weather.setModuleAppState('last-outlook', 'clear')
    assert.deepEqual(seen, [], 'a sibling module\u2019s write never wakes this module\u2019s watch')
    notebooks.setModuleAppState('run-defaults', { depth: 'brief' })
    assert.deepEqual(seen, [{ depth: 'brief' }], 'the module\u2019s own write does')
    off()
    notebooks.setModuleAppState('run-defaults', { depth: 'standard' })
    assert.equal(seen.length, 1, 'and the unsubscriber stops delivery')
    assert.deepEqual(notebooks.getModuleAppState('run-defaults'), { depth: 'standard' })
  }

  function testModuleEventSubscription(): void {
    const kernel = createRendererHost()
    const sinks = new Set<
      (envelope: { sourceModuleId: string; topic: string; payload?: unknown; emittedAt: number }) => void
    >()
    let sourceAttachments = 0
    const wireSource = (): void => {
      kernel.setModuleEventSource((cb) => {
        sourceAttachments += 1
        sinks.add(cb)
        return () => sinks.delete(cb)
      })
    }
    const emit = (sourceModuleId: string, topic: string, payload?: unknown): void => {
      for (const sink of [...sinks]) sink({ sourceModuleId, topic, payload, emittedAt: 0 })
    }

    // Modules register synchronously at import; the source is wired a microtask
    // later. A subscribe made in that window must still receive — the kernel owns
    // the subscriber set, so an early subscription is not silently dead.
    const received: unknown[] = []
    const off = kernel.hostFor('notebooks').subscribe('run-status', (payload) => received.push(payload))
    wireSource()
    assert.equal(sourceAttachments, 1, 'wiring the source attaches exactly one listener')
    emit('notebooks', 'run-status', { phase: 'done' })
    assert.deepEqual(received, [{ phase: 'done' }], 'a module receives its own topic')
    emit('notebooks', 'other-topic', { phase: 'done' })
    emit('weather-deck', 'run-status', { phase: 'done' })
    assert.equal(
      received.length,
      1,
      'another topic, and another module\u2019s event on the same topic, are both filtered out',
    )

    // Enablement is live on every delivery, not just at subscribe.
    let notebooksEnabled = false
    kernel.setModuleEnablementResolver((moduleId) => moduleId !== 'notebooks' || notebooksEnabled)
    emit('notebooks', 'run-status', { phase: 'failed' })
    assert.equal(received.length, 1, 'a disabled module stops receiving')
    notebooksEnabled = true
    emit('notebooks', 'run-status', { phase: 'failed' })
    assert.deepEqual(received[1], { phase: 'failed' }, 'and resumes when it is re-enabled')

    // A throwing subscriber is contained: the shared preload listener must keep
    // dispatching to every other module.
    const healthy: unknown[] = []
    kernel.hostFor('notebooks').subscribe('run-status', () => {
      throw new Error('module bug')
    })
    kernel.hostFor('notebooks').subscribe('run-status', (payload) => healthy.push(payload))
    emit('notebooks', 'run-status', { phase: 'reading' })
    assert.deepEqual(healthy, [{ phase: 'reading' }], 'a sibling subscriber still receives the emit')

    // One source listener backs every subscription, however many there are: the
    // preload channel is shared, and a listener per subscriber would fan the same
    // envelope out N times.
    kernel.hostFor('weather-deck').subscribe('outlook-refreshed', () => {})
    assert.equal(sourceAttachments, 1, 'a second module\u2019s subscribe adds no second source listener')

    const beforeOff = received.length
    off()
    emit('notebooks', 'run-status', { phase: 'done' })
    assert.equal(received.length, beforeOff, 'the returned closure stops delivery to that subscriber')
    assert.deepEqual(healthy.length, 2, 'while the siblings that did not unsubscribe keep receiving')
  }

  function testModuleBoundarySurfaces(): void {
    testModuleAppState()
    testModuleEventSubscription()
    console.log('renderer host module-boundary surface tests passed')
  }

  testModuleBoundarySurfaces()

  // --- The whole workspace list, and the app's light/dark surface (WP-C) -------
  // Both are for a module surface that is NOT mounted inside one workspace — a
  // modal floating over the window. Both answer before the shell wires them
  // rather than throwing or hanging: a module renders its empty state at early
  // boot instead of waiting for a first delivery that cannot come.

  async function testWorkspaceListAndColorScheme(): Promise<void> {
    const kernel = createRendererHost()
    const host = kernel.hostFor('acme.reviews')

    assert.deepEqual(await host.listWorkspaces(), [], 'unwired, the list reads empty')
    const earlyLists: unknown[] = []
    const stopEarly = host.watchWorkspaces((workspaces) => earlyLists.push(workspaces))
    assert.deepEqual(earlyLists, [[]], 'and an unwired watch still fires once, with nothing')
    stopEarly()
    const earlySchemes: string[] = []
    const stopEarlyScheme = host.watchColorScheme((scheme) => earlySchemes.push(scheme))
    assert.deepEqual(earlySchemes, ['dark'], 'an unwired colour watch answers once with the app default')
    stopEarlyScheme()

    let workspaces = [
      { id: 'ws-1', name: 'Studio', folderPath: '/repo', mode: 'default' },
      { id: 'ws-2', name: 'Docs', folderPath: null, mode: 'default' },
    ]
    const listListeners = new Set<() => void>()
    kernel.setWorkspaceListSource({
      list: () => workspaces.map((workspace) => ({ ...workspace })),
      watch: (cb) => {
        let last = ''
        const emit = (): void => {
          const next = JSON.stringify(workspaces)
          if (next === last) return
          last = next
          cb(workspaces.map((workspace) => ({ ...workspace })))
        }
        listListeners.add(emit)
        emit()
        return () => listListeners.delete(emit)
      },
    })

    assert.deepEqual(
      (await host.listWorkspaces()).map((workspace) => workspace.id),
      ['ws-1', 'ws-2'],
      'wired, the list is the open workspaces in shell order',
    )
    const lists: Array<Array<{ id: string }>> = []
    const stopList = host.watchWorkspaces((next) => lists.push(next))
    assert.equal(lists.length, 1, 'a watch fires once with the current list')
    listListeners.forEach((emit) => emit())
    assert.equal(lists.length, 1, 'an unchanged list does not re-fire')
    workspaces = [...workspaces, { id: 'ws-3', name: 'Spike', folderPath: '/spike', mode: 'default' }]
    listListeners.forEach((emit) => emit())
    assert.deepEqual(
      lists[1]?.map((workspace) => workspace.id),
      ['ws-1', 'ws-2', 'ws-3'],
      'a change delivers the new list',
    )
    stopList()
    assert.equal(listListeners.size, 0, 'the returned closure detaches the watch')

    let scheme: 'light' | 'dark' = 'light'
    const schemeListeners = new Set<() => void>()
    kernel.setColorSchemeWatcher((cb) => {
      let last: string | null = null
      const emit = (): void => {
        if (scheme === last) return
        last = scheme
        cb(scheme)
      }
      schemeListeners.add(emit)
      emit()
      return () => schemeListeners.delete(emit)
    })
    const schemes: string[] = []
    const stopScheme = host.watchColorScheme((next) => schemes.push(next))
    assert.deepEqual(schemes, ['light'], 'fires immediately with the current scheme')
    scheme = 'dark'
    schemeListeners.forEach((emit) => emit())
    assert.deepEqual(schemes, ['light', 'dark'], 'then on every change')
    stopScheme()
    assert.equal(schemeListeners.size, 0, 'and the closure detaches it')
    console.log('renderer host workspace-list + colour-scheme tests passed')
  }

  const suiteRun5 = testWorkspaceListAndColorScheme().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await Promise.all([suiteRun1, suiteRun2, suiteRun3, suiteRun4, suiteRun5])
})
