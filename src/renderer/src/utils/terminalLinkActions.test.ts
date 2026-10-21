import assert from 'node:assert/strict'
import {
  backlogRelativePath,
  isHtmlPath,
  projectRelativePath,
  terminalLinkActions,
  type TerminalLinkActionId,
} from './terminalLinkActions'
import { test } from 'vitest'

test('terminalLinkActions', async () => {
  const ROOT = '/Users/dev/workspace/sprintengine'

  function fileMenu(resolvedPath: string, isDirectory = false): TerminalLinkActionId[] {
    return terminalLinkActions({
      kind: 'file',
      resolvedPath,
      isDirectory,
      workspaceRoot: ROOT,
    }).map((action) => action.id)
  }

  // ---------- projectRelativePath ----------

  assert.equal(projectRelativePath(`${ROOT}/src/App.tsx`, ROOT), 'src/App.tsx')
  assert.equal(projectRelativePath(`${ROOT}/`, ROOT), null, 'the root itself is not relative to itself')
  assert.equal(projectRelativePath('/elsewhere/src/App.tsx', ROOT), null, 'outside the root')
  assert.equal(projectRelativePath(`${ROOT}/src/App.tsx`, null), null, 'no root')
  assert.equal(
    projectRelativePath(`${ROOT}-two/src/App.tsx`, ROOT),
    null,
    'a sibling root sharing a prefix is not inside',
  )
  assert.equal(
    projectRelativePath(`${ROOT}/src/App.tsx`, `${ROOT}/`),
    'src/App.tsx',
    'a trailing separator on the root is tolerated',
  )
  assert.equal(
    projectRelativePath('C:\\repo\\src\\App.tsx', 'C:\\repo'),
    'src/App.tsx',
    'windows separators normalize to /',
  )

  // ---------- backlogRelativePath ----------

  assert.equal(backlogRelativePath(`${ROOT}/backlog/2026-07-26-thing.md`, ROOT), 'backlog/2026-07-26-thing.md')
  assert.equal(
    backlogRelativePath(`${ROOT}/backlog/archived/2026-06-13-thing.md`, ROOT),
    'backlog/archived/2026-06-13-thing.md',
    'archived items are still items',
  )
  assert.equal(
    backlogRelativePath(`${ROOT}/backlog/mockups/2026-07-26-thing.html`, ROOT),
    null,
    'mockup attachments are not Backlog items',
  )
  assert.equal(
    backlogRelativePath(`${ROOT}/backlog/mockups/notes.md`, ROOT),
    null,
    'nothing under backlog/mockups/ is an item, whatever its extension',
  )
  assert.equal(backlogRelativePath(`${ROOT}/backlog/items.json`, ROOT), null, 'only markdown files are items')
  assert.equal(backlogRelativePath(`${ROOT}/src/backlog/x.md`, ROOT), null, 'must be the top-level backlog/')
  assert.equal(backlogRelativePath('/elsewhere/backlog/x.md', ROOT), null, 'outside the workspace')

  // ---------- isHtmlPath ----------

  assert.equal(isHtmlPath('/a/b/page.html'), true)
  assert.equal(isHtmlPath('/a/b/page.HTM'), true)
  assert.equal(isHtmlPath('/a/b/page.html.bak'), false)
  assert.equal(isHtmlPath('/a/b/page.md'), false)

  // ---------- the menu, one case per row of the item's table ----------

  assert.deepEqual(
    fileMenu(`${ROOT}/backlog/2026-07-26-thing.md`),
    ['open-backlog', 'open-editor', 'open-popout', 'reveal-files', 'copy-path'],
    'a Backlog item leads with Open in Backlog',
  )

  assert.deepEqual(
    fileMenu(`${ROOT}/backlog/mockups/2026-07-26-thing.html`),
    ['open-browser', 'open-editor', 'open-popout', 'reveal-files', 'copy-path'],
    'a mockup takes the HTML menu, not the Backlog menu',
  )

  assert.deepEqual(
    fileMenu(`${ROOT}/docs/report.html`),
    ['open-browser', 'open-editor', 'open-popout', 'reveal-files', 'copy-path'],
    'any HTML file leads with Open in browser',
  )

  assert.deepEqual(
    fileMenu(`${ROOT}/src/App.tsx`),
    ['open-editor', 'open-popout', 'reveal-files', 'copy-path'],
    'a plain file leads with Open in editor',
  )

  assert.deepEqual(
    fileMenu(`${ROOT}/src/renderer`, true),
    ['reveal-files', 'copy-path'],
    'a directory can only be located — no editor or pop-out row',
  )

  assert.deepEqual(
    terminalLinkActions({ kind: 'url', url: 'https://example.com' }).map((a) => a.id),
    ['open-url', 'copy-url'],
  )

  // A file outside any workspace root still gets the generic file menu — it just
  // cannot be a Backlog item.
  assert.deepEqual(
    terminalLinkActions({
      kind: 'file',
      resolvedPath: '/elsewhere/backlog/thing.md',
      isDirectory: false,
      workspaceRoot: ROOT,
    }).map((a) => a.id),
    ['open-editor', 'open-popout', 'reveal-files', 'copy-path'],
  )

  // ---------- grouping ----------

  const backlogMenu = terminalLinkActions({
    kind: 'file',
    resolvedPath: `${ROOT}/backlog/2026-07-26-thing.md`,
    isDirectory: false,
    workspaceRoot: ROOT,
  })
  assert.deepEqual(
    backlogMenu.filter((action) => action.startsGroup).map((action) => action.id),
    ['reveal-files'],
    'exactly one divider, above the locate group',
  )

  const directoryMenu = terminalLinkActions({
    kind: 'file',
    resolvedPath: `${ROOT}/src`,
    isDirectory: true,
    workspaceRoot: ROOT,
  })
  assert.deepEqual(
    directoryMenu.filter((action) => action.startsGroup).map((action) => action.id),
    [],
    'a menu that is only the locate group has no leading divider',
  )

  // Every action carries a non-empty label.
  for (const target of [
    { kind: 'file' as const, resolvedPath: `${ROOT}/src/App.tsx`, isDirectory: false, workspaceRoot: ROOT },
    { kind: 'url' as const, url: 'https://example.com' },
  ]) {
    for (const action of terminalLinkActions(target)) {
      assert.ok(action.label.trim().length > 0, `${action.id} has a label`)
    }
  }

  console.log('terminalLinkActions tests passed')
})

test('a file offered the system reveal lists it after Reveal in Files', () => {
  const ids = terminalLinkActions(
    { kind: 'file', resolvedPath: '/Users/dev/app/src/App.tsx', isDirectory: false, workspaceRoot: '/Users/dev/app' },
    { revealInSystemLabel: 'Reveal in Finder' },
  ).map((action) => [action.id, action.label])
  assert.deepEqual(ids.slice(-3), [
    ['reveal-files', 'Reveal in Files'],
    ['reveal-system', 'Reveal in Finder'],
    ['copy-path', 'Copy path'],
  ])
})

test('a folder offered the system reveal keeps it in its locate group', () => {
  const ids = terminalLinkActions(
    { kind: 'file', resolvedPath: '/Users/dev/app/src', isDirectory: true, workspaceRoot: '/Users/dev/app' },
    { revealInSystemLabel: 'Show in Explorer' },
  ).map((action) => action.id)
  assert.deepEqual(ids, ['reveal-files', 'reveal-system', 'copy-path'])
})

test('without the option there is no system reveal, as in a terminal', () => {
  const ids = terminalLinkActions({
    kind: 'file',
    resolvedPath: '/Users/dev/app/src/App.tsx',
    isDirectory: false,
    workspaceRoot: '/Users/dev/app',
  }).map((action) => action.id)
  assert.equal(ids.includes('reveal-system'), false)
})
