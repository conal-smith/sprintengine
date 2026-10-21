import assert from 'node:assert/strict'
import type { ILink, Terminal } from '@xterm/xterm'
import {
  createTerminalFileLinkProvider,
  findTerminalFileReferences,
  rangeForTerminalFileReference,
  readWrappedLogicalLine,
  resolveTerminalFileReferencePath,
} from './terminalFileLinks'
import { test } from 'vitest'

test('terminalFileLinks', async () => {
  const roots = {
    workspaceRoot: '/repo',
    executionRoot: '/repo/packages/app',
  }

  const relative = findTerminalFileReferences(
    'Open src/renderer/src/components/panels/TerminalView.tsx:274:7 for details.',
    roots,
  )
  assert.equal(relative.length, 1)
  assert.equal(relative[0]?.text, 'src/renderer/src/components/panels/TerminalView.tsx:274:7')
  assert.equal(relative[0]?.path, 'src/renderer/src/components/panels/TerminalView.tsx')
  assert.equal(relative[0]?.resolvedPath, '/repo/packages/app/src/renderer/src/components/panels/TerminalView.tsx')
  assert.equal(relative[0]?.line, 274)
  assert.equal(relative[0]?.column, 7)

  const dotRelative = findTerminalFileReferences('Edited ./src/App.tsx:42.', roots)
  assert.equal(dotRelative.length, 1)
  assert.equal(dotRelative[0]?.resolvedPath, '/repo/packages/app/src/App.tsx')
  assert.equal(dotRelative[0]?.line, 42)

  const parentRelative = findTerminalFileReferences('See ../shared/types.ts', roots)
  assert.equal(parentRelative.length, 1)
  assert.equal(parentRelative[0]?.resolvedPath, '/repo/packages/shared/types.ts')

  const absolute = findTerminalFileReferences('Failure at /repo/src/main.ts:8', roots)
  assert.equal(absolute.length, 1)
  assert.equal(absolute[0]?.resolvedPath, '/repo/src/main.ts')
  assert.equal(absolute[0]?.line, 8)

  const urls = findTerminalFileReferences('Docs: https://example.com/src/main.ts and file://ignored', roots)
  assert.equal(urls.length, 0)

  const bare = findTerminalFileReferences(
    'Do not link package.json or TerminalView.tsx without a path separator.',
    roots,
  )
  assert.equal(bare.length, 0)

  assert.equal(resolveTerminalFileReferencePath('src/../README.md', roots), '/repo/packages/app/README.md')
  assert.equal(resolveTerminalFileReferencePath('~/notes.md', roots), null)

  const wrappedFirstSegment = 'Failure in src/renderer/src/components/panels/'
  const wrappedSecondSegment = 'TerminalView.tsx:274:7'
  const wrappedSegments = [
    { y: 10, startIndex: 0, startColumn: 1, text: wrappedFirstSegment },
    { y: 11, startIndex: wrappedFirstSegment.length, startColumn: 1, text: wrappedSecondSegment },
  ]
  const wrappedReferences = findTerminalFileReferences(wrappedSegments.map((segment) => segment.text).join(''), roots)
  assert.equal(wrappedReferences.length, 1)
  assert.equal(wrappedReferences[0]?.text, 'src/renderer/src/components/panels/TerminalView.tsx:274:7')
  assert.deepEqual(rangeForTerminalFileReference(wrappedReferences[0]!, wrappedSegments), {
    start: { x: 12, y: 10 },
    end: { x: wrappedSecondSegment.length, y: 11 },
  })

  // A buffer of plain rows, for the soft-wrap reader and the provider.
  type MockLine = { text: string; isWrapped: boolean }

  function makeTerminal(cols: number, lines: MockLine[]): Terminal {
    const padded = lines.map((line) => ({
      isWrapped: line.isWrapped,
      raw: line.text.length >= cols ? line.text.slice(0, cols) : line.text.padEnd(cols, ' '),
      /** How far the stream actually wrote; past this the cells were never touched. */
      written: Math.min(line.text.length, cols),
    }))
    const buffer = {
      active: {
        getLine(index: number) {
          const line = padded[index]
          if (!line) return undefined
          return {
            isWrapped: line.isWrapped,
            length: cols,
            translateToString(trimRight?: boolean, startColumn = 0, endColumn = cols) {
              const slice = line.raw.slice(startColumn, endColumn)
              return trimRight ? slice.replace(/\s+$/u, '') : slice
            },
            // A cell, not a character: `readWrappedLogicalLine` reads widths to
            // map string offsets back onto columns, and every character in these
            // fixtures is narrow. The written/unwritten distinction is xterm's:
            // a cell the stream never reached reports '' (and is what
            // trimRight trims to), while a space the stream actually wrote
            // reports ' '.
            getCell(x: number) {
              if (x < 0 || x >= line.raw.length) return undefined
              return {
                getChars: () => (x < line.written ? (line.raw[x] ?? '') : ''),
                getWidth: () => 1,
              }
            },
          }
        },
      },
    }
    return { cols, buffer } as unknown as Terminal
  }

  // The logical line is xterm's soft wrap and nothing more. A path a program
  // broke onto an indented row itself is joined by the provider, which checks
  // the joined path exists first (`terminalWrappedFileLinks.test.ts`); the
  // reader must not guess at it, because its text is also what a single row's
  // own matches are read from.
  const hangingPathHead = '    future-plans/2026-06-07-targeted-review-gate-'
  const hangingTerminal = makeTerminal(hangingPathHead.length, [
    { text: hangingPathHead, isWrapped: false },
    { text: '    rechecks.md', isWrapped: false },
  ])
  const hangingLogical = readWrappedLogicalLine(hangingTerminal, 1)
  assert.ok(hangingLogical)
  assert.equal(hangingLogical.text, hangingPathHead)
  assert.equal(hangingLogical.segments.length, 1)

  // ---------------------------------------------------------------------------
  // The reported drop (item `terminal-relative-links-dropped`, 2026-09-08): a
  // `[file] …` line in an agent pane was not clickable. The line below is the one
  // that was reported, verbatim, including Claude Code's `⎿` gutter.
  //
  // The pattern, the resolution and the cell geometry all handle it — proved
  // below at a wide width and at a width that soft-wraps it. What does NOT handle
  // it is a pane with no root: `resolveTerminalFileReferencePath` returns null and
  // the match is discarded. That stays the behaviour (guessing a base opens the
  // wrong file), but it is now reported instead of silent.
  // ---------------------------------------------------------------------------

  const reportedLine = '  ⎿  [file] resources/studio-plugin/skills/studio-backlog/SKILL.md'
  const reportedPath = 'resources/studio-plugin/skills/studio-backlog/SKILL.md'

  type Drop = { reason: string; text: string }

  // The bare resolver, which is where the null originates.
  assert.equal(resolveTerminalFileReferencePath(reportedPath, {}), null)
  assert.equal(resolveTerminalFileReferencePath(reportedPath, { workspaceRoot: null, executionRoot: null }), null)

  const rootlessDrops: Drop[] = []
  const rootless = findTerminalFileReferences(reportedLine, { workspaceRoot: null, executionRoot: null }, (drop) =>
    rootlessDrops.push(drop),
  )
  assert.equal(rootless.length, 0)
  assert.deepEqual(rootlessDrops, [{ reason: 'no-root', text: reportedPath }])

  // Either root alone is enough, and a resolved reference reports no drop.
  for (const knownRoots of [
    { workspaceRoot: '/repo', executionRoot: null },
    { workspaceRoot: null, executionRoot: '/repo' },
    // The execution root wins when both are known — an agent in a worktree
    // resolves its own relative paths against the worktree, not the checkout.
    { workspaceRoot: '/checkout', executionRoot: '/repo' },
  ]) {
    const drops: Drop[] = []
    const found = findTerminalFileReferences(reportedLine, knownRoots, (drop) => drops.push(drop))
    assert.equal(found.length, 1)
    assert.equal(found[0]?.text, reportedPath)
    assert.equal(found[0]?.resolvedPath, `/repo/${reportedPath}`)
    assert.deepEqual(drops, [])
  }

  // An absolute path still resolves with no roots at all, so a rootless pane is
  // not link-dead — only its relative references are.
  const rootlessAbsoluteDrops: Drop[] = []
  const rootlessAbsolute = findTerminalFileReferences(
    'Failure at /repo/src/main.ts:8',
    { workspaceRoot: null, executionRoot: null },
    (drop) => rootlessAbsoluteDrops.push(drop),
  )
  assert.equal(rootlessAbsolute.length, 1)
  assert.deepEqual(rootlessAbsoluteDrops, [])

  // A URL or a `~/…` path is a deliberate non-match, not a drop. Counting these
  // would fire the diagnostic on output that contains no local path at all —
  // including when a root IS known, which would make the counter meaningless.
  for (const roots of [
    { workspaceRoot: null, executionRoot: null },
    { workspaceRoot: '/repo', executionRoot: null },
  ]) {
    const remoteDrops: Drop[] = []
    const remote = findTerminalFileReferences(
      'Docs: https://example.com/src/main.ts and ~/notes.md and ~/notes.md:12',
      roots,
      (drop) => remoteDrops.push(drop),
    )
    assert.equal(remote.length, 0)
    assert.deepEqual(remoteDrops, [])
  }

  // `no-range` is the tripwire for match offsets and segment tiling coming apart.
  // It cannot be reached through the provider (the references are matched against
  // the very text the segments tile), so it is exercised where it is reachable.
  assert.equal(
    rangeForTerminalFileReference({ startIndex: 100, endIndex: 140 }, [
      { y: 1, startIndex: 0, startColumn: 1, text: 'src/a.ts' },
    ]),
    null,
  )
  assert.equal(rangeForTerminalFileReference({ startIndex: 0, endIndex: 4 }, []), null)

  // End to end through the provider, at a width that fits the reported line and
  // at a width that soft-wraps it — the wrap is what put the tail of the path on
  // a second buffer row in the pane it was reported from.
  function provideLinksFor(
    terminal: Terminal,
    bufferLineNumber: number,
    roots: { workspaceRoot: string | null; executionRoot: string | null },
  ): { links: ILink[] | undefined; drops: Drop[] } {
    const drops: Drop[] = []
    let links: ILink[] | undefined
    let called = false
    createTerminalFileLinkProvider({
      terminal,
      workspaceRoot: roots.workspaceRoot,
      executionRoot: roots.executionRoot,
      inspectPath: async () => ({ exists: true, isDirectory: false }),
      onActivate: () => {},
      onDrop: (drop) => drops.push(drop),
    }).provideLinks(bufferLineNumber, (provided) => {
      called = true
      links = provided
    })
    assert.ok(called, 'provideLinks must always answer its callback')
    return { links, drops }
  }

  const wideTerminal = makeTerminal(120, [{ text: reportedLine, isWrapped: false }])
  const wide = provideLinksFor(wideTerminal, 1, { workspaceRoot: '/repo', executionRoot: null })
  assert.equal(wide.links?.length, 1)
  assert.equal(wide.links?.[0]?.text, reportedPath)
  assert.deepEqual(wide.links?.[0]?.range, {
    start: { x: 13, y: 1 },
    end: { x: 13 + reportedPath.length - 1, y: 1 },
  })
  assert.deepEqual(wide.drops, [])

  // Soft-wrapped across two rows: hovering either row must yield the same link.
  const wrappedTerminal = makeTerminal(40, [
    { text: reportedLine.slice(0, 40), isWrapped: false },
    { text: reportedLine.slice(40), isWrapped: true },
  ])
  for (const hoveredRow of [1, 2]) {
    const wrapped = provideLinksFor(wrappedTerminal, hoveredRow, {
      workspaceRoot: '/repo',
      executionRoot: null,
    })
    assert.equal(wrapped.links?.length, 1)
    assert.equal(wrapped.links?.[0]?.text, reportedPath)
    assert.deepEqual(wrapped.links?.[0]?.range, {
      start: { x: 13, y: 1 },
      end: { x: reportedLine.length - 40, y: 2 },
    })
    assert.deepEqual(wrapped.drops, [])
  }

  // The same pane with no folder configured: no link, and a counted drop rather
  // than silence. This is the acceptance criterion of the item.
  const rootlessProvider = provideLinksFor(makeTerminal(120, [{ text: reportedLine, isWrapped: false }]), 1, {
    workspaceRoot: null,
    executionRoot: null,
  })
  assert.equal(rootlessProvider.links, undefined)
  assert.deepEqual(rootlessProvider.drops, [{ reason: 'no-root', text: reportedPath }])

  // A thunk root is read on every provideLinks call, not captured at
  // registration. This is what lets a `cd` (OSC 7) or the async spawn-cwd
  // resolution reach links already on screen: the provider is registered
  // synchronously, right after `term.open`, long before either value is known.
  // Baking one in produced the quietest possible bug — the same relative path
  // exists in the stale tree too, so the link opened the WRONG COPY.
  const movingTerminal = makeTerminal(120, [{ text: reportedLine, isWrapped: false }])
  let liveExecutionRoot: string | null = null
  const movingDrops: Drop[] = []
  const activated: string[] = []
  const movingProvider = createTerminalFileLinkProvider({
    terminal: movingTerminal,
    workspaceRoot: null,
    executionRoot: () => liveExecutionRoot,
    inspectPath: async () => ({ exists: true, isDirectory: false }),
    onActivate: ({ resolvedPath }) => {
      activated.push(resolvedPath)
    },
    onDrop: (drop) => movingDrops.push(drop),
  })

  async function clickTheLink(): Promise<string | undefined> {
    let links: ILink[] | undefined
    movingProvider.provideLinks(1, (provided) => {
      links = provided
    })
    const link = links?.[0]
    if (!link) return undefined
    const before = activated.length
    link.activate({ clientX: 0, clientY: 0 } as MouseEvent, link.text)
    // The activate path stats the path before it reports; give it its turns.
    for (let tick = 0; tick < 5 && activated.length === before; tick += 1) await Promise.resolve()
    return activated.at(-1)
  }

  async function main(): Promise<void> {
    // Nothing known yet: the decision of record still holds — unlinked, counted.
    assert.equal(await clickTheLink(), undefined)
    assert.deepEqual(movingDrops, [{ reason: 'no-root', text: reportedPath }])

    // The spawn cwd lands. The SAME provider instance now resolves against it.
    liveExecutionRoot = '/repo'
    assert.equal(await clickTheLink(), `/repo/${reportedPath}`)

    // And a `cd` moves it again, with nothing re-registered.
    liveExecutionRoot = '/repo/worktrees/feature'
    assert.equal(await clickTheLink(), `/repo/worktrees/feature/${reportedPath}`)

    console.log('ok - terminalFileLinks')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})

// A compiler's diagnostic: the colon after the position starts the message.
// Read as part of the path, it named a file that does not exist, so the link
// opened "File does not exist" instead of the file at that line.
for (const [line, path, position] of [
  ['./main.go:10:5: undefined: x', './main.go', [10, 5]],
  ['src/app.ts:12:3: error TS2304', 'src/app.ts', [12, 3]],
  ['src/app.ts:12: warning', 'src/app.ts', [12, undefined]],
  ['in src/app.ts: no exports', 'src/app.ts', [undefined, undefined]],
  ['/repo/README.md:', '/repo/README.md', [undefined, undefined]],
] as const) {
  test(`a path ending in a colon links without it: ${line}`, () => {
    const [reference] = findTerminalFileReferences(line, { workspaceRoot: '/repo' })
    assert.equal(reference?.path, path)
    assert.equal(
      reference?.text,
      `${path}${position[0] ? `:${position[0]}` : ''}${position[1] ? `:${position[1]}` : ''}`,
    )
    assert.equal(reference?.line, position[0])
    assert.equal(reference?.column, position[1])
  })
}

test('a web address after a path is not taken into the path', () => {
  const references = findTerminalFileReferences('see src/app.ts: https://example.com/a:b', { workspaceRoot: '/repo' })
  assert.deepEqual(
    references.map((reference) => reference.text),
    ['src/app.ts'],
  )
})

test('a quoted path with spaces in it is one reference, its line inside or after the quotes', () => {
  const roots = { workspaceRoot: '/repo', executionRoot: null }
  const [inside, ...more] = findTerminalFileReferences('Error in "/Users/dev/My Project/src/index.ts:12:3"', roots)
  assert.equal(more.length, 0)
  assert.equal(inside?.path, '/Users/dev/My Project/src/index.ts')
  assert.equal(inside?.line, 12)
  assert.equal(inside?.column, 3)
  assert.equal(inside?.startIndex, 'Error in "'.length)
  assert.equal(inside?.text, '/Users/dev/My Project/src/index.ts:12:3')

  const [after] = findTerminalFileReferences("at 'C:\\Program Files\\app\\main.ts':7", roots)
  assert.equal(after?.path, 'C:\\Program Files\\app\\main.ts')
  assert.equal(after?.line, 7)

  const [relative] = findTerminalFileReferences('"docs/My Notes/a.md"', roots)
  assert.equal(relative?.resolvedPath, '/repo/docs/My Notes/a.md')
})

test('a quoted path without a space, and quoted prose, read as before', () => {
  const roots = { workspaceRoot: '/repo', executionRoot: null }
  const plain = findTerminalFileReferences('"src/index.ts:4" and "lib/a.ts"', roots)
  assert.deepEqual(
    plain.map((reference) => [reference.path, reference.line]),
    [
      ['src/index.ts', 4],
      ['lib/a.ts', undefined],
    ],
  )
  // A quote that holds no separator is not a path, and the path after it still links.
  const prose = findTerminalFileReferences('said "hello there" then src/b.ts', roots)
  assert.deepEqual(
    prose.map((reference) => reference.path),
    ['src/b.ts'],
  )
  // Apostrophes inside words quote nothing.
  assert.deepEqual(
    findTerminalFileReferences("it's in src/main.ts and that's it", roots).map((reference) => reference.path),
    ['src/main.ts'],
  )
  // A quoted URL with a space is still the web-link provider's.
  assert.equal(findTerminalFileReferences('"https://example.com/a b"', roots).length, 0)
})

// A folder or file named outside ASCII is still a path. `\w` stopped at the
// first accented letter, so these printed as plain text with no link.
for (const [line, path, position] of [
  ['wrote données/rapport.md:3 just now', 'données/rapport.md', 3],
  ['see src/日本語.ts for the strings', 'src/日本語.ts', undefined],
  ['moved docs/ünits/a.md', 'docs/ünits/a.md', undefined],
  ['in src/café.ts:12', 'src/café.ts', 12],
  ['żółć\\main.ts:7 failed', 'żółć\\main.ts', 7],
] as const) {
  test(`a relative path with non-ASCII names links whole: ${path}`, () => {
    const references = findTerminalFileReferences(line, { workspaceRoot: '/repo' })
    assert.equal(references.length, 1)
    assert.equal(references[0]?.path, path)
    assert.equal(references[0]?.line, position)
    assert.equal(references[0]?.startIndex, line.indexOf(path))
  })
}

test('a word with non-ASCII letters and no separator is still not a path', () => {
  assert.equal(findTerminalFileReferences('le rapport était prêt.md', { workspaceRoot: '/repo' }).length, 0)
})
