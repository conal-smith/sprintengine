import assert from 'node:assert/strict'
import {
  clampPaletteSelection,
  commandMatchesQuery,
  comparePaletteMatches,
  composeRestingPage,
  RESTING_RECENT_CONVERSATIONS,
  workspaceSwitchRowId,
  groupInScope,
  PALETTE_SCOPE_ORDER,
  orderPaletteCommands,
  PALETTE_GROUP_ORDER,
  PALETTE_SCORE,
  paletteGroupRank,
  paletteScopeForCommand,
  scoreCommandMatch,
  stepPaletteSelection,
  workspaceKeywordsFromDefinition,
  type PaletteCommandGroup,
  type PaletteRankable,
} from './commandPaletteSearch'
import { createRendererHost } from '../modules/renderer-host'
import { test } from 'vitest'

test('commandPaletteSearch', async () => {
  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  run('workspaceKeywordsFromDefinition joins label + curated search terms', () => {
    assert.equal(
      workspaceKeywordsFromDefinition({ label: 'Notebook', searchTerms: ['pages', 'kanban'] }, 'notebook'),
      'Notebook pages kanban',
    )
  })

  run('workspaceKeywordsFromDefinition tolerates a definition with no search terms', () => {
    assert.equal(workspaceKeywordsFromDefinition({ label: 'Standard' }, 'standard'), 'Standard')
  })

  run('workspaceKeywordsFromDefinition falls back to the raw mode id when unregistered', () => {
    assert.equal(workspaceKeywordsFromDefinition(null, 'future-plugin-mode'), 'future-plugin-mode')
    assert.equal(workspaceKeywordsFromDefinition(undefined, 'shell-mode'), 'shell-mode')
  })

  // The switch row's keyword field is where a workspace's mode terms live, so
  // these assert the C2/C3 regression fix: typing a mode term surfaces the row
  // even though neither the name (label) nor folder path (description) contains it.
  const kanbanRow = {
    label: 'Switch to: API cleanup',
    description: '/Users/dev/work/acme-platform',
    keywords: workspaceKeywordsFromDefinition(
      { label: 'Notebook', searchTerms: ['pages', 'kanban', 'inbox'] },
      'notebook',
    ),
  }

  run('commandMatchesQuery matches a mode search term carried in keywords', () => {
    assert.equal(commandMatchesQuery(kanbanRow, 'kanban'), true)
    assert.equal(commandMatchesQuery(kanbanRow, 'inbox'), true)
    assert.equal(commandMatchesQuery(kanbanRow, 'notebook'), true)
  })

  run('commandMatchesQuery matches on the visible name and folder path too', () => {
    assert.equal(commandMatchesQuery(kanbanRow, 'api cleanup'), true)
    assert.equal(commandMatchesQuery(kanbanRow, 'acme-platform'), true)
  })

  run('commandMatchesQuery is case-insensitive and trims the query', () => {
    assert.equal(commandMatchesQuery(kanbanRow, '  KANBAN  '), true)
  })

  run('commandMatchesQuery returns false when nothing matches', () => {
    assert.equal(commandMatchesQuery(kanbanRow, 'nonexistent-term'), false)
  })

  run('commandMatchesQuery treats an empty query as matching every command', () => {
    assert.equal(commandMatchesQuery({ label: 'anything' }, ''), true)
    assert.equal(commandMatchesQuery({ label: 'anything' }, '   '), true)
  })

  run('commandMatchesQuery tolerates a command with no description or keywords', () => {
    assert.equal(commandMatchesQuery({ label: 'New Chat' }, 'chat'), true)
    assert.equal(commandMatchesQuery({ label: 'New Chat' }, 'kanban'), false)
  })

  // Search modes are registry-derived — a module's REAL registered
  // workspace type carries the terms the old hardcoded palette entries provided,
  // so behavior for the existing modes is identical with the arrays gone.
  run('workspace mode search terms derive from the live registry registration', () => {
    const kernel = createRendererHost()
    kernel.hostFor('tide-tables').registerWorkspaceType({
      id: 'tide-tables',
      label: 'Tide tables',
      description: 'A workspace type registered for this check alone.',
      icon: () => null,
      searchTerms: ['tides', 'harbour', 'almanac'],
      createTemplate: () => ({
        id: 'tide-tables',
        name: 'Tide tables',
        description: 'A workspace type registered for this check alone.',
        previewSlots: [],
        layout: { global: {}, borders: [], layout: { type: 'row', children: [] } },
      }),
    } as never)
    const keywords = workspaceKeywordsFromDefinition(kernel.getWorkspaceType('tide-tables'), 'tide-tables')
    const row = { label: 'Switch to: Spring tides', keywords }
    assert.equal(commandMatchesQuery(row, 'harbour'), true)
    assert.equal(commandMatchesQuery(row, 'almanac'), true)
    assert.equal(commandMatchesQuery(row, 'kanban'), false)
  })

  // The ⌘⇧F scope. `all` and `files` are one list filtered two ways, so the
  // predicate is the whole difference between the launcher and Find-in-Path —
  // and a group silently falling out of `all` would make ⌘K lose a source.
  const ALL_GROUPS: PaletteCommandGroup[] = [
    'agents',
    'skills',
    'extensions',
    'commands',
    'actions',
    'files',
    'content',
  ]

  run('the all scope admits every group, so ⌘K stays the full launcher', () => {
    ALL_GROUPS.forEach((group) => {
      assert.equal(groupInScope(group, 'all'), true, `${group} must be visible under the all scope`)
    })
  })

  run('the files scope admits exactly file names', () => {
    assert.deepEqual(
      ALL_GROUPS.filter((group) => groupInScope(group, 'files')),
      ['files'],
    )
  })

  // ⌘⇧F and "Search project contents": a snippet of code is ranked against
  // nothing but other lines of code — not a file whose name it happens to share
  // letters with, and not a command.
  run('the text scope admits exactly text in files', () => {
    assert.deepEqual(
      ALL_GROUPS.filter((group) => groupInScope(group, 'text')),
      ['content'],
    )
  })

  run('the files scope hides the launcher groups a code snippet would compete with', () => {
    assert.equal(groupInScope('commands', 'files'), false)
    assert.equal(groupInScope('actions', 'files'), false)
    assert.equal(groupInScope('agents', 'files'), false)
    assert.equal(groupInScope('skills', 'files'), false)
    assert.equal(groupInScope('extensions', 'files'), false)
  })

  // The terminal star's scope. It asks one question — "is there a skill or a
  // plugin for this" — so it admits exactly the two groups that answer it and
  // nothing a workspace name or a line of source could win.
  run('the skills scope admits exactly the skill and plugin groups', () => {
    assert.deepEqual(
      ALL_GROUPS.filter((group) => groupInScope(group, 'skills')),
      ['skills', 'extensions'],
    )
  })

  run('the conversations scope admits exactly the chats-and-workspaces group', () => {
    assert.deepEqual(
      ALL_GROUPS.filter((group) => groupInScope(group, 'conversations')),
      ['agents'],
    )
  })

  run('the actions scope admits exactly what the product can do', () => {
    assert.deepEqual(
      ALL_GROUPS.filter((group) => groupInScope(group, 'actions')),
      ['commands', 'actions'],
    )
  })

  // The tab strip is a partition of the launcher, not a set of overlapping
  // views: a group in two tabs would be found twice and a group in none would be
  // findable only from All — and the strip exists so the person never has to
  // wonder which tab a thing is under.
  run('the narrowings partition the launcher: every group under exactly one tab', () => {
    const narrowings = PALETTE_SCOPE_ORDER.filter((scope) => scope !== 'all')
    ALL_GROUPS.forEach((group) => {
      const tabs = narrowings.filter((scope) => groupInScope(group, scope))
      assert.deepEqual(tabs.length, 1, `${group} must sit under exactly one tab, found ${tabs.join(', ') || 'none'}`)
    })
    assert.equal(PALETTE_SCOPE_ORDER[0], 'all', 'the launcher is the first tab')
    assert.equal(new Set(PALETTE_SCOPE_ORDER).size, PALETTE_SCOPE_ORDER.length)
  })

  // The resting page: what ⌘K shows before a keystroke. Actions first, then the
  // chats in the order the sidebar keeps them — most recently spoken in first —
  // and only a screen's worth of them.
  run('the resting page is the actions, then the chats most recently spoken in, capped', () => {
    const workspace = (id: string, lastUserMessageAt: number) =>
      ({ id, lastUserMessageAt, createdAt: 0 }) as unknown as Parameters<typeof composeRestingPage>[1][number]
    const workspaces = Array.from({ length: RESTING_RECENT_CONVERSATIONS + 3 }, (_, index) =>
      workspace(`ws-${index}`, index),
    )
    const rows = [
      { id: 'toggle-git', group: 'commands' as const },
      { id: 'new-chat', group: 'actions' as const },
      ...workspaces.map((entry) => ({ id: workspaceSwitchRowId(entry.id), group: 'agents' as const })),
      { id: 'spawn-reviewer', group: 'actions' as const },
      { id: 'skill-debug', group: 'skills' as const },
    ]
    const page = composeRestingPage(rows, workspaces)
    assert.deepEqual(
      page.actions.map((row) => row.id),
      ['new-chat', 'spawn-reviewer'],
      'the actions group, whole, in its own order — commands and skills are a tab away',
    )
    assert.equal(page.recent.length, RESTING_RECENT_CONVERSATIONS, 'a screen of chats, not the sidebar again')
    assert.equal(page.recent[0]?.id, workspaceSwitchRowId('ws-10'), 'the chat most recently spoken in leads')
    assert.equal(page.recent[RESTING_RECENT_CONVERSATIONS - 1]?.id, workspaceSwitchRowId('ws-3'))
  })

  run('a workspace with no switch row is skipped, not blanked', () => {
    const workspaces = [
      { id: 'hidden', lastUserMessageAt: 9, createdAt: 0 },
      { id: 'shown', lastUserMessageAt: 1, createdAt: 0 },
    ] as unknown as Parameters<typeof composeRestingPage>[1]
    const page = composeRestingPage([{ id: workspaceSwitchRowId('shown'), group: 'agents' as const }], workspaces)
    assert.deepEqual(
      page.recent.map((row) => row.id),
      [workspaceSwitchRowId('shown')],
    )
  })

  run('every group is in the canonical order exactly once', () => {
    assert.deepEqual([...PALETTE_GROUP_ORDER].sort(), [...ALL_GROUPS].sort())
    assert.equal(new Set(PALETTE_GROUP_ORDER).size, PALETTE_GROUP_ORDER.length)
    assert.ok(paletteGroupRank('skills') < paletteGroupRank('content'))
  })

  // ── The scorer ───────────────────────────────────────────────────────────────
  // The palette used to order by group alone, so an exact skill-name match sat
  // wherever its group happened to fall, under a workspace whose folder path
  // merely contained the letters. These are the four tiers that fixed it.

  const scored = (
    fields: { label: string; searchLabel?: string; description?: string; keywords?: string },
    query: string,
  ) => scoreCommandMatch(fields, query)

  run('an exact name beats a prefix beats a word start beats a buried match', () => {
    assert.equal(scored({ label: 'backlog' }, 'backlog'), PALETTE_SCORE.labelExact)
    assert.equal(scored({ label: 'backlog triage' }, 'backlog'), PALETTE_SCORE.labelPrefix)
    assert.equal(scored({ label: 'Team backlog' }, 'backlog'), PALETTE_SCORE.labelWord)
    assert.equal(scored({ label: 'nobacklogging' }, 'backlog'), PALETTE_SCORE.labelSubstring)
  })

  run('a word start is a match after a separator, not one inside a word', () => {
    // "git" after a slash and after a dash starts a word; inside "digit" it does not.
    assert.equal(scored({ label: 'repo/git' }, 'git'), PALETTE_SCORE.labelWord)
    assert.equal(scored({ label: 'super-git' }, 'git'), PALETTE_SCORE.labelWord)
    assert.equal(scored({ label: 'digit' }, 'git'), PALETTE_SCORE.labelSubstring)
  })

  run('the visible name outranks every hidden field', () => {
    const inName = { label: 'Deploy notes' }
    const inDetail = { label: 'Something else', description: 'deploy notes for the release' }
    assert.ok(scored(inName, 'deploy') > scored(inDetail, 'deploy'))
    assert.equal(scored(inDetail, 'deploy'), PALETTE_SCORE.detailPrefix)
    assert.equal(scored({ label: 'x', keywords: 'kanban pages' }, 'pages'), PALETTE_SCORE.detailWord)
  })

  run('no match scores zero, and that is exactly what the matcher reads', () => {
    assert.equal(scored({ label: 'New Chat' }, 'kanban'), PALETTE_SCORE.none)
    assert.equal(commandMatchesQuery({ label: 'New Chat' }, 'kanban'), false)
    assert.equal(commandMatchesQuery({ label: 'New Chat' }, 'chat'), true)
  })

  run('an empty query scores every row the same, so the preview stays in group order', () => {
    assert.equal(scored({ label: 'anything' }, ''), PALETTE_SCORE.empty)
    assert.equal(scored({ label: 'other' }, '   '), PALETTE_SCORE.empty)
  })

  // ── Ordering ─────────────────────────────────────────────────────────────────

  const row = (
    label: string,
    group: PaletteCommandGroup,
    extra: Partial<PaletteRankable> = {},
  ): PaletteRankable & { label: string } => ({ label, group, ...extra })

  run('score wins over group order', () => {
    const exactSkill = row('telegram', 'skills')
    const commandWithItBuried = row('Open telegraph settings', 'commands')
    assert.deepEqual(
      orderPaletteCommands([commandWithItBuried, exactSkill], 'telegram').map((entry) => entry.label),
      ['telegram', 'Open telegraph settings'],
    )
  })

  run('what you already have comes before what you would have to install', () => {
    const available = row('review', 'skills', { installed: false })
    const installed = row('review', 'skills', { installed: true })
    assert.deepEqual(
      orderPaletteCommands([available, installed], 'review').map((entry) => entry.installed),
      [true, false],
    )
  })

  run('a row with no notion of installed is not ranked as though it were missing', () => {
    const command = row('review', 'commands')
    const installedSkill = row('review', 'skills', { installed: true })
    // Same score, neither sinks: the group order decides, and skills come first.
    assert.deepEqual(
      orderPaletteCommands([command, installedSkill], 'review').map((entry) => entry.group),
      ['skills', 'commands'],
    )
  })

  run('an available skill sinks below installed skills, not below the whole palette', () => {
    const available = row('review', 'skills', { installed: false })
    const plugin = row('review', 'extensions')
    // Both score the same; the plugin declares nothing about installation, so the
    // canonical group order decides and Skills still comes first.
    assert.deepEqual(
      orderPaletteCommands([plugin, available], 'review').map((entry) => entry.group),
      ['skills', 'extensions'],
    )
  })

  run('group order is the last tie-break, not the first', () => {
    const a = row('same', 'content')
    const b = row('same', 'agents')
    assert.equal(comparePaletteMatches(a, b, 'same') > 0, true, 'content sorts after agents on a tie')
    assert.equal(comparePaletteMatches(b, a, 'same') < 0, true)
  })

  run("ordering is stable, so a provider's own order survives a tie", () => {
    const rows = ['one', 'two', 'three'].map((label) => row(label, 'skills'))
    assert.deepEqual(
      orderPaletteCommands(rows, '').map((entry) => entry.label),
      ['one', 'two', 'three'],
    )
  })

  // What the scorer must NOT have changed for the people who already use the
  // palette: with nothing typed it is the launcher it was — canonical group
  // order, insertion order inside a group — and the obvious query for each of
  // the old first rows still puts that row first (review, 2026-09-10).
  run("an empty query keeps the old group order and each group's insertion order", () => {
    const rows = [
      row('Toggle File Explorer', 'commands'),
      row('Switch to: beta', 'agents'),
      row('New Chat', 'actions'),
      row('Switch to: alpha', 'agents'),
      row('README.md', 'files'),
      row('review', 'skills', { installed: true }),
      row('Toggle Git Panel', 'commands'),
      row('const x = 1', 'content'),
    ]
    assert.deepEqual(
      orderPaletteCommands(rows, '').map((entry) => entry.label),
      [
        'Switch to: beta',
        'Switch to: alpha',
        'review',
        'Toggle File Explorer',
        'Toggle Git Panel',
        'New Chat',
        'README.md',
        'const x = 1',
      ],
    )
  })

  run('the old first rows still come first for their obvious queries', () => {
    const rows = [
      row('a line that mentions switch to nothing', 'content'),
      row('switch.ts', 'files'),
      row('Switch to: alpha', 'agents', { description: '/Users/me/new-chat-notes' }),
      row('Toggle Git Panel', 'commands'),
      row('New Chat', 'actions'),
      row('.gitignore', 'files'),
      row('git status', 'content'),
    ]
    const first = (query: string) => orderPaletteCommands(rows, query)[0].label
    // Same tier as the file (both prefixes); the canonical order breaks the tie.
    assert.equal(first('switch'), 'Switch to: alpha')
    // "New Chat" is a label prefix; the workspace whose PATH contains it is a
    // detail match — which is the regression the scorer was written to fix.
    assert.equal(first('new chat'), 'New Chat')
    // `.gitignore` and `git status` are a word start and a prefix on things that
    // are not commands; the command's own word start ties the file and the
    // canonical order keeps Commands ahead of Files — but a CONTENT line that
    // begins with the query is a prefix, and outranks the command's word start.
    assert.equal(first('git'), 'git status')
  })

  run("a row's own name is scored at the label bands, past the palette's own verb", () => {
    const switchRow = { label: 'Switch to: croissant', searchLabel: 'croissant' }
    // Without `searchLabel` this is a word start (600), because "Switch to: "
    // sits in front of the only word anyone would type.
    assert.equal(scored(switchRow, 'croissant'), PALETTE_SCORE.labelExact)
    assert.equal(scored({ label: 'Toggle Git Panel', searchLabel: 'Git Panel' }, 'git panel'), PALETTE_SCORE.labelExact)
    // Both strings are scored, not one instead of the other, so the verb is
    // still a way to find the row.
    assert.equal(scored(switchRow, 'switch'), PALETTE_SCORE.labelPrefix)
    // And the better of the two wins rather than whichever is checked first.
    assert.equal(scored({ label: 'croissant', searchLabel: 'a croissant' }, 'croissant'), PALETTE_SCORE.labelExact)
  })

  run("typing a workspace's own name puts its switch row above a file that merely starts with it", () => {
    const rows: PaletteRankable[] = [
      { label: 'croissant.config.ts', group: 'files' },
      { label: 'croissantry helper', group: 'content' },
      { label: 'Switch to: croissant', searchLabel: 'croissant', group: 'agents' },
    ]
    assert.equal(orderPaletteCommands(rows, 'croissant')[0].label, 'Switch to: croissant')
    // The same rule for the other two verb-prefixed kinds.
    const panels: PaletteRankable[] = [
      { label: 'git-panel.tsx', group: 'files' },
      { label: 'Toggle Git Panel', searchLabel: 'Git Panel', group: 'commands' },
    ]
    assert.equal(orderPaletteCommands(panels, 'git panel')[0].label, 'Toggle Git Panel')
  })

  run('the decorated sort agrees with comparePaletteMatches on every pair', () => {
    const rows = [
      row('review', 'skills', { installed: false }),
      row('review', 'skills', { installed: true }),
      row('review', 'commands'),
      row('code review', 'content'),
      row('previews', 'files'),
      row('x', 'agents', { keywords: 'review' }),
    ]
    const ordered = orderPaletteCommands(rows, 'review')
    for (let i = 0; i < ordered.length - 1; i += 1) {
      assert.ok(
        comparePaletteMatches(ordered[i], ordered[i + 1], 'review') <= 0,
        `${ordered[i].label} must not sort after ${ordered[i + 1].label}`,
      )
    }
  })

  run('clampPaletteSelection pulls a stale index back onto the rows on screen', () => {
    // Arrowed to row 10 of a long list, then a three-row list arrived.
    assert.equal(clampPaletteSelection(10, 3), 2)
    assert.equal(clampPaletteSelection(1, 3), 1)
    assert.equal(clampPaletteSelection(-1, 3), 0)
    // Nothing on screen yet: the first row to arrive is the one highlighted.
    assert.equal(clampPaletteSelection(4, 0), 0)
    assert.equal(clampPaletteSelection(-1, 0), 0)
  })

  run('stepPaletteSelection moves from the highlighted row and stops at either end', () => {
    assert.equal(stepPaletteSelection(0, 3, 1), 1)
    assert.equal(stepPaletteSelection(2, 3, 1), 2)
    assert.equal(stepPaletteSelection(0, 3, -1), 0)
    // From a stale index the first ArrowUp lands on the row above the last
    // one, not on a row that is no longer there.
    assert.equal(stepPaletteSelection(10, 3, -1), 1)
    assert.equal(stepPaletteSelection(10, 3, 1), 2)
    // An empty list is a no-op, never -1.
    assert.equal(stepPaletteSelection(0, 0, 1), 0)
    assert.equal(stepPaletteSelection(0, 0, -1), 0)
  })

  console.log('commandPaletteSearch: all assertions passed')
})

test('Go to file opens the palette on the Files tab', () => {
  assert.equal(paletteScopeForCommand('search.goToFile'), 'files')
})

test('the other palette commands keep the scope they open on', () => {
  assert.equal(paletteScopeForCommand('commandPalette.open'), 'all')
  assert.equal(paletteScopeForCommand('search.everywhere'), 'all')
  assert.equal(paletteScopeForCommand('search.files.open'), 'text')
  assert.equal(paletteScopeForCommand('chat.new'), null)
})
