import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { DesignSystemBundleIdentity } from '../../../../../../shared/design-system/bundle-view'
import { DesignRail } from './DesignRail'
import {
  buildDesignRailGroups,
  designFailureLine,
  designRowMatchesSearch,
  designRowStateLine,
  designRowTitle,
  libraryRowId,
  projectRowId,
  resolveDesignProjectPath,
  type DesignRailEntry,
} from './designRailState'
import { test } from 'vitest'

test('designRail', async () => {
  // The Design door's rail (item 2002). Two halves: the pure grouping/search model,
  // and the markup contracts the shared door anatomy fixes — the house New
  // affordance, one divider, sentence-case headings that DROP to a single group,
  // and an identity chip that is a rounded square rather than the status circle.

  function run(name: string, body: () => void): void {
    try {
      body()
      console.log(`ok - ${name}`)
    } catch (error) {
      console.error(`not ok - ${name}`)
      throw error
    }
  }

  function identity(overrides: Partial<DesignSystemBundleIdentity> = {}): DesignSystemBundleIdentity {
    return {
      path: '/work/brand/design-system',
      name: 'sprintengine',
      version: '2.4.0',
      summary: 'The in-house system.',
      // design-tokens-allow: a PREVIEWED bundle's own accent is content under test, not app chrome — the whole point is that it is not one of our tokens.
      accent: { light: '#2f6a4a', dark: '#4daf7d' },
      ...overrides,
    }
  }

  function entry(overrides: Partial<DesignRailEntry> = {}): DesignRailEntry {
    const path = overrides.path ?? '/work/brand/design-system'
    return {
      id: libraryRowId(path),
      group: 'library',
      path,
      identity: identity({ path }),
      failure: null,
      ...overrides,
    }
  }

  function markup(node: Parameters<typeof renderToStaticMarkup>[0]): string {
    return renderToStaticMarkup(node)
  }

  function railMarkup(
    entries: DesignRailEntry[],
    selectedId: string | null = null,
    newCounts?: Record<string, number>,
  ): string {
    return markup(
      <DesignRail
        entries={entries}
        selectedId={selectedId}
        accentMode="dark"
        newCounts={newCounts}
        search=""
        onSearch={() => {}}
        status="all"
        onStatus={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        newSelected={false}
      />,
    )
  }

  // ── The pure model ───────────────────────────────────────────────────────────

  run('row ids separate the attached copy from the same folder in the library', () => {
    // A bundle attached to the shown project and the same bundle registered in the
    // library are two rows for one folder; selecting one must not light the other.
    assert.notEqual(projectRowId('/work/brand/design-system'), libraryRowId('/work/brand/design-system'))
    assert.equal(libraryRowId('/a/b'), 'lib:/a/b')
    // Keyed on the FOLDER, not a workspace id: the project can be a folder the
    // user browsed to, which no open workspace claims.
    assert.equal(projectRowId('/a/b/design-system'), projectRowId('/a/b/design-system/'))
    assert.notEqual(projectRowId('/a/b/design-system'), projectRowId('/c/d/design-system'))
  })

  run('the door shows the project the user picked, and remembers it', () => {
    // Default: no pick yet, so the door follows the active workspace — which is
    // what it did before it had a chip at all.
    assert.equal(
      resolveDesignProjectPath({ storedPath: null, storedPathExists: null, activeWorkspaceFolderPath: '/work/active' }),
      '/work/active',
    )
    // A stored pick wins over the active workspace. This is the whole point:
    // pointing the app at another project must not silently move the door.
    assert.equal(
      resolveDesignProjectPath({
        storedPath: '/work/picked',
        storedPathExists: true,
        activeWorkspaceFolderPath: '/work/active',
      }),
      '/work/picked',
    )
    // A folder the user browsed to has no workspace behind it, and is still the
    // door's project.
    assert.equal(
      resolveDesignProjectPath({
        storedPath: '/elsewhere/brand',
        storedPathExists: true,
        activeWorkspaceFolderPath: null,
      }),
      '/elsewhere/brand',
    )
    // Gone from disk: fall back rather than showing a project that is not there.
    assert.equal(
      resolveDesignProjectPath({
        storedPath: '/work/gone',
        storedPathExists: false,
        activeWorkspaceFolderPath: '/work/active',
      }),
      '/work/active',
    )
    // Still being probed counts as present, so the door does not flash onto the
    // active workspace and back on every open.
    assert.equal(
      resolveDesignProjectPath({
        storedPath: '/work/picked',
        storedPathExists: null,
        activeWorkspaceFolderPath: '/work/active',
      }),
      '/work/picked',
    )
    // Nothing stored, nothing open: no group, exactly as before.
    assert.equal(
      resolveDesignProjectPath({ storedPath: null, storedPathExists: null, activeWorkspaceFolderPath: null }),
      null,
    )
    assert.equal(
      resolveDesignProjectPath({ storedPath: '/work/gone', storedPathExists: false, activeWorkspaceFolderPath: null }),
      null,
    )
  })

  run('a group with no rows is dropped, so one group means no headings', () => {
    // SurfaceRail hides its headings below two groups, so dropping empties is what
    // makes "only one group has rows → both headings drop" fall out.
    const libraryOnly = buildDesignRailGroups([entry()], '')
    assert.deepEqual(
      libraryOnly.map((group) => group.key),
      ['library'],
    )

    const both = buildDesignRailGroups(
      [entry({ group: 'project', id: projectRowId('/proj/design-system') }), entry({ path: '/other/design-system' })],
      '',
    )
    assert.deepEqual(
      both.map((group) => group.key),
      ['project', 'library'],
    )
    // In this project leads Library — the attached one is the one you are working in.
    assert.deepEqual(
      both.map((group) => group.label),
      ['In this project', 'Library'],
    )
  })

  run('search matches name, summary and path — and never hides a broken row', () => {
    const readable = entry()
    assert.equal(designRowMatchesSearch(readable, 'sprint'), true, 'by name')
    assert.equal(designRowMatchesSearch(readable, 'in-house'), true, 'by summary')
    assert.equal(designRowMatchesSearch(readable, '/work/brand'), true, 'by folder')
    assert.equal(designRowMatchesSearch(readable, 'nothing'), false)

    // A row whose identity never resolved is matched on its path, so a system
    // whose folder broke cannot vanish behind a search box.
    const broken = entry({ identity: null, failure: 'missing', path: '/gone/design-system' })
    assert.equal(designRowMatchesSearch(broken, 'gone'), true)
    assert.equal(designRowMatchesSearch(broken, ''), true)
  })

  run('the status lens separates readable from broken', () => {
    const rows = [entry(), entry({ path: '/gone', identity: null, failure: 'missing' })]
    assert.equal(buildDesignRailGroups(rows, '', 'all')[0].entries.length, 2)
    assert.equal(buildDesignRailGroups(rows, '', 'readable')[0].entries.length, 1)
    const broken = buildDesignRailGroups(rows, '', 'broken')
    assert.equal(broken[0].entries.length, 1)
    assert.equal(broken[0].entries[0].path, '/gone')
  })

  run('every failure names its own kind AND its path', () => {
    // A folder we cannot read must never render identically to a system with no
    // components, and the path is what makes the row actionable.
    const kinds = ['missing', 'no-manifest', 'invalid-manifest', 'unreadable'] as const
    const lines = kinds.map((kind) => designFailureLine(kind, '/work/gone'))
    assert.equal(new Set(lines).size, kinds.length, 'four distinct states, four distinct lines')
    for (const line of lines) assert.ok(line.includes('/work/gone'), line)
  })

  run('a row still being read says so rather than showing a blank version', () => {
    assert.equal(designRowStateLine(entry({ identity: null })), 'Reading…')
    assert.equal(designRowStateLine(entry()), '2.4.0')
    // An unresolved row falls back to its folder name rather than going untitled.
    assert.equal(designRowTitle(entry({ identity: null, path: '/work/harbor' })), 'harbor')
    assert.equal(designRowTitle(entry()), 'sprintengine')
  })

  // ── The rendered anatomy ─────────────────────────────────────────────────────

  run('the New affordance is the house dashed row, never an accent-filled button', () => {
    const html = railMarkup([entry()])
    assert.match(html, /New design system/)
    const newRow = html.slice(0, html.indexOf('New design system'))
    assert.match(newRow, /border-dashed/, 'the shared dashed treatment')
    assert.ok(
      !/bg-\[color:var\(--accent-primary\)\]/.test(newRow),
      'an accent fill would make this door a stranger beside Automations',
    )
  })

  run('the identity chip is a rounded square in the system’s own accent', () => {
    const html = railMarkup([entry()])
    // The 6px dot is the status idiom; identity gets a rounded square.
    assert.match(html, /(^|\s)rounded-xs(\s|")/, 'rounded square')
    assert.ok(!/rounded-full/.test(html), 'never the status circle')
    // Dark mode was asked for, so the bundle's dark accent is what paints.
    // design-tokens-allow: asserting the fixture bundle's own colour reached the chip.
    assert.match(html, /background:#4daf7d/, 'the previewed system’s own colour, per mode')
  })

  run('a bundle with no resolvable accent gets an outline, never a fabricated colour', () => {
    const html = railMarkup([entry({ identity: identity({ accent: { light: null, dark: null } }) })])
    assert.match(html, /border-dashed border-\[color:var\(--border-default\)\]/)
    // design-tokens-allow: asserting the ABSENCE of any painted colour.
    assert.ok(!/background:#/.test(html), 'no invented colour')
  })

  run('headings appear only when both groups have rows', () => {
    const oneGroup = railMarkup([entry()])
    assert.ok(!/In this project/.test(oneGroup), 'a heading must separate something from something')
    const twoGroups = railMarkup([
      entry({ group: 'project', id: projectRowId('/proj/design-system'), path: '/proj/design-system' }),
      entry(),
    ])
    assert.match(twoGroups, /In this project/)
    assert.match(twoGroups, /Library/)
    // Sentence case, not uppercase letter-spaced labels.
    assert.ok(!/IN THIS PROJECT/.test(twoGroups))
    assert.ok(!/uppercase/.test(twoGroups), 'no uppercase utility on the headings')
  })

  run('the filter glyph is offered only once something is actually broken', () => {
    const allReadable = railMarkup([entry()])
    assert.ok(
      !/aria-label="Filter design systems"/.test(allReadable),
      'a lens that narrows nothing is a control that does nothing',
    )
    const withBroken = railMarkup([entry(), entry({ path: '/gone', identity: null, failure: 'missing' })])
    assert.match(withBroken, /aria-label="Filter design systems"/)
  })

  run('the project chip rides the rail head, so an empty project can still change it', () => {
    // A group with no rows is dropped, so a chip in the "In this project" heading
    // would vanish exactly when a person needs it: the project they are pointed at
    // has no design system, and changing the project is the only move left.
    const html = markup(
      <DesignRail
        entries={[]}
        selectedId={null}
        accentMode="light"
        projectScope={<span data-project-scope="true">sprintengine</span>}
        search=""
        onSearch={() => {}}
        status="all"
        onStatus={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        newSelected={false}
      />,
    )
    assert.match(html, /data-project-scope="true"/, 'the chip renders with no rows at all')
    assert.ok(
      html.indexOf('data-project-scope="true"') < html.indexOf('New design system'),
      'and above the New affordance, where the head puts what the door is showing',
    )
  })

  run('a search that matches nothing says so instead of reading as an empty library', () => {
    const html = markup(
      <DesignRail
        entries={[entry()]}
        selectedId={null}
        accentMode="light"
        search="zzz"
        onSearch={() => {}}
        status="all"
        onStatus={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        newSelected={false}
      />,
    )
    assert.match(html, /No design systems match\./)
  })

  run('while New holds the selection, no row is current', () => {
    const selectedRow = railMarkup([entry()], libraryRowId('/work/brand/design-system'))
    assert.match(selectedRow, /aria-current="true"/)
    const newHolds = markup(
      <DesignRail
        entries={[entry()]}
        selectedId={libraryRowId('/work/brand/design-system')}
        accentMode="light"
        search=""
        onSearch={() => {}}
        status="all"
        onStatus={() => {}}
        onSelect={() => {}}
        onCreate={() => {}}
        newSelected
      />,
    )
    // Exactly one focused selection across rail and canvas: New took it, so the
    // row that was selected must not stay lit alongside it.
    const rowRegion = newHolds.slice(newHolds.indexOf('New design system'))
    assert.ok(!/aria-current="true"/.test(rowRegion), 'the row released the selection')
  })

  // ── "New since you last looked" ──────────────────────────────────────────────
  //
  // The rail's rows are SYSTEMS, so the per-entry markers live on the canvas and
  // the row carries the roll-up. Each case below is a way the roll-up lies: a
  // count nobody can read out, a chip on a system with nothing new in it, or a
  // mark that eats the name it is qualifying.

  run('a system with arrivals wears the roll-up, and it reads as a sentence', () => {
    const brand = entry()
    const html = railMarkup([brand], null, { [brand.id]: 3 })
    // The word is in the markup, not implied by a bare number: "3" beside a
    // system name means nothing to anyone reading the row out.
    assert.match(html, /3 new/)
    assert.ok(!/>3</.test(html), 'never a naked count')
    // And the name is still there — the mark joins the title, it does not replace it.
    assert.match(html, /sprintengine/)
  })

  run('the roll-up is the kit’s New mark, the same one the model picker wears', () => {
    const brand = entry()
    const html = railMarkup([brand], null, { [brand.id]: 1 })
    // Accent ink on the soft accent fill, pill, no hairline. A second drawing of
    // "New" one door away from the first is the thing this is preventing.
    assert.match(html, /bg-\[color:var\(--accent-primary-soft\)\]/)
    assert.match(html, /text-\[color:var\(--accent-primary\)\]/)
    assert.match(html, /rounded-full/)
    // design-tokens-allow: asserting the ABSENCE of a hairline on the mark.
    const mark = html.slice(html.indexOf('accent-primary-soft'))
    assert.ok(!/border-\[color:var\(--border/.test(mark.slice(0, 200)), 'no border: this is not a state chip')
  })

  run('a system with nothing new wears nothing at all', () => {
    const brand = entry()
    // A "0 new" chip is a chip that says nothing, and the absence is the answer.
    assert.ok(!/new/i.test(rowRegion(railMarkup([brand], null, { [brand.id]: 0 }))), 'zero is silent')
    assert.ok(!/new/i.test(rowRegion(railMarkup([brand], null, {}))), 'absent is silent')
    assert.ok(!/new/i.test(rowRegion(railMarkup([brand]))), 'no map at all is silent')
  })

  run('the roll-up lands on the row it belongs to, and only that row', () => {
    const brand = entry()
    const other = entry({
      path: '/work/other/design-system',
      identity: identity({ path: '/work/other/design-system', name: 'harbor' }),
    })
    const html = railMarkup([brand, other], null, { [other.id]: 2 })
    const brandRow = html.slice(html.indexOf('sprintengine'), html.indexOf('harbor'))
    assert.ok(!/new/i.test(brandRow), 'the untouched system stays quiet')
    assert.match(html.slice(html.indexOf('harbor')), /2 new/)
  })

  run('the name truncates before the mark does, and the state line is untouched', () => {
    const brand = entry()
    const html = railMarkup([brand], null, { [brand.id]: 4 })
    const title = html.slice(html.indexOf('sprintengine') - 200, html.indexOf('sprintengine'))
    assert.match(title, /min-w-0 flex-1/, 'the name is what gives way')
    const mark = html.slice(html.indexOf('accent-primary-soft') - 120, html.indexOf('accent-primary-soft'))
    assert.match(mark, /shrink-0/, 'a long name can never push the mark out of the row')
    // The version still rides its own line: the mark joined the title, it did not
    // take the row over.
    assert.match(html, /2\.4\.0/)
  })

  run('a row with no mark keeps the markup every other door’s rail already had', () => {
    // The shared row grew an optional slot. A door that never passes one must
    // render byte-identically to what it rendered before the slot existed.
    const brand = entry()
    const withoutMark = railMarkup([brand])
    assert.ok(!/flex min-w-0 items-center gap-1\.5"><span class="truncate min-w-0 flex-1 text-body/.test(withoutMark))
    assert.match(withoutMark, /<span class="truncate text-body font-medium/, 'the plain title, unwrapped')
  })

  /** The rows, without the head — "New design system" contains the word too. */
  function rowRegion(html: string): string {
    const index = html.indexOf('New design system')
    return index === -1 ? html : html.slice(index + 'New design system'.length)
  }

  console.log('designRail.test.tsx: ok')
})
