import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { parseBacklogFrontmatter } from '../shared/backlog/frontmatter'
import {
  addOrUpdateBacklogLink,
  createBacklogEpic,
  createBacklogItem,
  listBacklogItems,
  moveBacklogObjectSource,
  readBacklogItem,
  repairBacklogIntegrity,
  planBacklogStoreMigration,
  readBacklogFrontmatterFields,
  readBacklogObjectStore,
  removeBacklogLink,
  resolveBacklogLocation,
  setBacklogRoot,
  updateBacklogDependencies,
  updateBacklogDependenciesPlanned,
  updateBacklogMockups,
  updateBacklogEpic,
  updateBacklogEpicColor,
  updateBacklogHighlight,
  updateBacklogModuleMetadata,
  updateBacklogStatus,
  updateBacklogTriage,
  updateBacklogType,
} from './backlog-service'
import { workspaceStorePath } from './workspace-store'
import { test } from 'vitest'

test('backlog-service', async () => {
  const PRECISE_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

  async function main(): Promise<void> {
    const tempRoot = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-service-'))
    const itemPath = join(tempRoot, 'backlog', 'checkout.md')
    const storePath = workspaceStorePath(tempRoot, 'backlog', 'cache', 'links.json')

    // The exact body the lifecycle/triage writes must preserve byte-for-byte.
    const body = '# Checkout\n\nSpeed up the checkout flow.\n\n- step one\n- step two\n'

    const readItem = async (): Promise<ReturnType<typeof parseBacklogFrontmatter>> =>
      parseBacklogFrontmatter(await readFile(itemPath, 'utf-8'))

    try {
      const missing = await readBacklogObjectStore(tempRoot)
      assert.equal(missing.ok, true)
      assert.deepEqual(missing.ok ? missing.store : null, { schemaVersion: 1, items: [] })

      await mkdir(join(tempRoot, 'backlog'), { recursive: true })
      await writeFile(itemPath, body, 'utf-8')

      // Lifecycle status writes the markdown frontmatter, never the link cache.
      const statusUpdated = await updateBacklogStatus({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        status: 'in_progress',
      })
      assert.equal(statusUpdated.ok, true)
      const afterStatus = await readItem()
      assert.equal(afterStatus.fields.status, 'in_progress')
      assert.match(
        afterStatus.fields.updated ?? '',
        PRECISE_ISO_TIMESTAMP,
        'a mutation must stamp a precise UTC instant',
      )
      assert.equal(afterStatus.body, body, 'status write must preserve the document body byte-for-byte')
      // Writing frontmatter must not create or touch the sidecar object store.
      await assert.rejects(() => stat(storePath), /ENOENT/, 'frontmatter writes must not create the link cache')

      // An agent blocked on a human decision parks the item as needs_input — the
      // lifecycle signal the Backlog panel surfaces with the warn glyph.
      const awaitingInput = await updateBacklogStatus({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        status: 'needs_input',
      })
      assert.equal(awaitingInput.ok, true)
      assert.equal((await readItem()).fields.status, 'needs_input')

      const resumed = await updateBacklogStatus({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        status: 'in_progress',
      })
      assert.equal(resumed.ok, true)
      assert.equal((await readItem()).fields.status, 'in_progress')

      // Type is frontmatter-sourced too; null clears the key and preserves order.
      const typed = await updateBacklogType({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        type: 'bug',
      })
      assert.equal(typed.ok, true)
      const afterType = await readItem()
      assert.equal(afterType.fields.type, 'bug')
      assert.equal(afterType.fields.status, 'in_progress', 'type write must leave status untouched')
      assert.equal(afterType.body, body)

      const clearedType = await updateBacklogType({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        type: null,
      })
      assert.equal(clearedType.ok, true)
      assert.equal('type' in (await readItem()).fields, false, 'clearing type must remove the frontmatter line')

      // `epic` is a valid type (an item declared as an epic container) and writes
      // to frontmatter like any other type, body preserved.
      const epicTyped = await updateBacklogType({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        type: 'epic',
      })
      assert.equal(epicTyped.ok, true)
      const afterEpic = await readItem()
      assert.equal(afterEpic.fields.type, 'epic')
      assert.equal(afterEpic.body, body, 'epic type write must preserve the document body byte-for-byte')
      // Clear it again so the triage assertions below start from a no-type state.
      await updateBacklogType({ workspaceRoot: tempRoot, relativePath: 'backlog/checkout.md', type: null })

      // Triage writes the three effort/impact/risk axes to frontmatter together.
      const triaged = await updateBacklogTriage({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        difficulty: 'm',
        criticality: 'high',
        risk: 'normal',
      })
      assert.equal(triaged.ok, true)
      const afterTriage = await readItem()
      assert.equal(afterTriage.fields.difficulty, 'm')
      assert.equal(afterTriage.fields.criticality, 'high')
      assert.equal(afterTriage.fields.risk, 'normal')
      assert.equal(afterTriage.body, body, 'triage write must preserve the document body byte-for-byte')

      // A null axis clears only that key; omitted axes are left exactly as written.
      const clearedDifficulty = await updateBacklogTriage({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        difficulty: null,
      })
      assert.equal(clearedDifficulty.ok, true)
      const afterClear = await readItem()
      assert.equal('difficulty' in afterClear.fields, false, 'clearing difficulty must remove its line')
      assert.equal(afterClear.fields.criticality, 'high', 'omitted criticality must survive a difficulty clear')
      assert.equal(afterClear.fields.risk, 'normal', 'omitted risk must survive a difficulty clear')

      // Invalid axis values are rejected explicitly and never mutate the file.
      const beforeInvalid = await readFile(itemPath, 'utf-8')
      const rejectedRisk = await updateBacklogTriage({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        risk: 'extreme' as unknown as 'high',
      })
      assert.equal(rejectedRisk.ok, false)
      assert.match(rejectedRisk.ok ? '' : rejectedRisk.message, /risk/)
      const rejectedDifficulty = await updateBacklogTriage({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        difficulty: 'xxl' as unknown as 'l',
      })
      assert.equal(rejectedDifficulty.ok, false)
      assert.match(rejectedDifficulty.ok ? '' : rejectedDifficulty.message, /difficulty/)
      const rejectedStatus = await updateBacklogStatus({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        status: 'shipping' as unknown as 'completed',
      })
      assert.equal(rejectedStatus.ok, false)
      assert.match(rejectedStatus.ok ? '' : rejectedStatus.message, /status/)
      const rejectedType = await updateBacklogType({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        type: 'chore' as unknown as 'bug',
      })
      assert.equal(rejectedType.ok, false)
      assert.match(rejectedType.ok ? '' : rejectedType.message, /type/)
      assert.equal(await readFile(itemPath, 'utf-8'), beforeInvalid, 'rejected values must not mutate the item file')

      // Epic membership is the child-side write: the `epic:` frontmatter slug, set
      // and cleared via the shared helper, body preserved, sidecar untouched.
      const epicAssigned = await updateBacklogEpic({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        epic: 'auth-revamp',
      })
      assert.equal(epicAssigned.ok, true)
      const afterEpicAssign = await readItem()
      assert.equal(afterEpicAssign.fields.epic, 'auth-revamp')
      assert.equal(afterEpicAssign.body, body, 'epic assign must preserve the document body byte-for-byte')

      const epicCleared = await updateBacklogEpic({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        epic: null,
      })
      assert.equal(epicCleared.ok, true)
      assert.equal('epic' in (await readItem()).fields, false, 'clearing epic must remove the frontmatter line')

      // An invalid epic slug (whitespace/separators) is rejected and mutates nothing.
      const beforeBadEpic = await readFile(itemPath, 'utf-8')
      const rejectedEpic = await updateBacklogEpic({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        epic: 'has spaces' as string,
      })
      assert.equal(rejectedEpic.ok, false)
      assert.match(rejectedEpic.ok ? '' : rejectedEpic.message, /epic slug/)
      assert.equal(
        await readFile(itemPath, 'utf-8'),
        beforeBadEpic,
        'a rejected epic slug must not mutate the item file',
      )

      // Epic assignment against a path outside backlog/ is rejected explicitly.
      const rejectedEpicPath = await updateBacklogEpic({
        workspaceRoot: tempRoot,
        relativePath: 'notes/checkout.md',
        epic: 'auth-revamp',
      })
      assert.equal(rejectedEpicPath.ok, false)
      assert.match(rejectedEpicPath.ok ? '' : rejectedEpicPath.message, /under backlog/)

      // Epic identity colour: the epic file's `color:` frontmatter, set and cleared
      // through the same shared helper (body preserved), validated against the
      // colour vocabulary so a bad payload can't land an unknown hue.
      const colorSet = await updateBacklogEpicColor({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        color: 'blue',
      })
      assert.equal(colorSet.ok, true)
      assert.equal((await readItem()).fields.color, 'blue')
      assert.equal((await readItem()).body, body, 'epic colour write must preserve the body byte-for-byte')

      const colorCleared = await updateBacklogEpicColor({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        color: null,
      })
      assert.equal(colorCleared.ok, true)
      assert.equal(
        'color' in (await readItem()).fields,
        false,
        'clearing the epic colour must remove the frontmatter line',
      )

      const beforeBadColor = await readFile(itemPath, 'utf-8')
      const rejectedEpicColor = await updateBacklogEpicColor({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        color: 'magenta' as unknown as 'red',
      })
      assert.equal(rejectedEpicColor.ok, false)
      assert.match(rejectedEpicColor.ok ? '' : rejectedEpicColor.message, /colour/)
      assert.equal(
        await readFile(itemPath, 'utf-8'),
        beforeBadColor,
        'a rejected epic colour must not mutate the item file',
      )

      // Prerequisites are the dependent-side write: the single comma-separated
      // `dependsOn:` frontmatter line, set/cleared via the shared CSV + slug
      // helpers, body + unrelated keys preserved, sidecar untouched. A dedicated
      // file with an unknown key proves the round-trip independent of the churn above.
      const depsPath = join(tempRoot, 'backlog', 'deps.md')
      const depsBody = '# Deps\n\nBody stays put.\n'
      const depsOriginal = `---\nstatus: idea\ncustom: keep-me\n---\n${depsBody}`
      await writeFile(depsPath, depsOriginal, 'utf-8')
      const readDeps = async (): Promise<ReturnType<typeof parseBacklogFrontmatter>> =>
        parseBacklogFrontmatter(await readFile(depsPath, 'utf-8'))

      // Set a list: surrounding whitespace is trimmed and duplicates dropped,
      // first-seen order kept, so the stored line matches what the reader parses.
      const depsSet = await updateBacklogDependencies({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/deps.md',
        dependsOn: ['alpha', ' beta ', 'alpha'],
      })
      assert.equal(depsSet.ok, true)
      const afterDepsSet = await readDeps()
      assert.equal(afterDepsSet.fields.dependson, 'alpha, beta')
      assert.equal(afterDepsSet.fields.custom, 'keep-me', 'an unrelated frontmatter key must be preserved')
      assert.equal(afterDepsSet.body, depsBody, 'dependsOn write must preserve the document body byte-for-byte')

      // An invalid slug rejects the whole write and mutates nothing.
      const beforeBadDeps = await readFile(depsPath, 'utf-8')
      const rejectedDeps = await updateBacklogDependencies({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/deps.md',
        dependsOn: ['ok', 'has spaces'],
      })
      assert.equal(rejectedDeps.ok, false)
      assert.match(rejectedDeps.ok ? '' : rejectedDeps.message, /prerequisite/)
      assert.equal(await readFile(depsPath, 'utf-8'), beforeBadDeps, 'a rejected slug must not mutate the item file')

      // Clearing with an empty list removes the line while retaining the mutation timestamp.
      const depsCleared = await updateBacklogDependencies({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/deps.md',
        dependsOn: [],
      })
      assert.equal(depsCleared.ok, true)
      assert.equal(
        'dependson' in (await readDeps()).fields,
        false,
        'clearing dependsOn must remove the frontmatter line',
      )
      assert.equal((await readDeps()).fields.custom, 'keep-me')
      assert.equal((await readDeps()).body, depsBody)
      assert.match((await readDeps()).fields.updated ?? '', PRECISE_ISO_TIMESTAMP)

      // null clears too (the serializer treats an empty string as a set, so the
      // service must pass null, not '').
      await updateBacklogDependencies({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/deps.md',
        dependsOn: ['gamma'],
      })
      const nullCleared = await updateBacklogDependencies({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/deps.md',
        dependsOn: null,
      })
      assert.equal(nullCleared.ok, true)
      assert.equal('dependson' in (await readDeps()).fields, false)
      assert.equal((await readDeps()).body, depsBody)

      // The written line keeps the field's documented spelling, and the main-side
      // reader (the main-process dependency axis) actually sees it —
      // reading `fields.dependsOn` against a lowercasing parser silently returned
      // nothing for every item.
      await updateBacklogDependencies({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/deps.md',
        dependsOn: ['alpha', 'beta'],
      })
      assert.match(await readFile(depsPath, 'utf-8'), /^dependsOn: alpha, beta$/m)
      assert.deepEqual(
        readBacklogFrontmatterFields(await readFile(depsPath, 'utf-8')).dependsOn,
        ['alpha', 'beta'],
        'the frontmatter reader must expose the prerequisites it parsed',
      )

      await rm(depsPath)

      // The epic ordering mark: true writes the line, false removes it
      // (absent IS false), body and unrelated keys preserved. Nothing validates
      // WHERE it is set — it is an assertion of intent, not a computed property.
      const epicOrderPath = join(tempRoot, 'backlog', 'epics', 'ordering.md')
      const epicOrderBody = '# Ordering\n\nEpic body stays put.\n'
      await mkdir(join(tempRoot, 'backlog', 'epics'), { recursive: true })
      await writeFile(epicOrderPath, `---\ntype: epic\ncustom: keep-me\n---\n${epicOrderBody}`, 'utf-8')
      const readEpicOrder = async (): Promise<ReturnType<typeof parseBacklogFrontmatter>> =>
        parseBacklogFrontmatter(await readFile(epicOrderPath, 'utf-8'))

      const marked = await updateBacklogDependenciesPlanned({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/epics/ordering.md',
        dependenciesPlanned: true,
      })
      assert.equal(marked.ok, true)
      assert.match(await readFile(epicOrderPath, 'utf-8'), /^dependenciesPlanned: true$/m)
      assert.equal((await readEpicOrder()).fields.custom, 'keep-me')
      assert.equal((await readEpicOrder()).body, epicOrderBody, 'the mark must preserve the body byte-for-byte')
      assert.equal(readBacklogFrontmatterFields(await readFile(epicOrderPath, 'utf-8')).dependenciesPlanned, true)

      const unmarked = await updateBacklogDependenciesPlanned({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/epics/ordering.md',
        dependenciesPlanned: false,
      })
      assert.equal(unmarked.ok, true)
      assert.equal(
        'dependenciesplanned' in (await readEpicOrder()).fields,
        false,
        'clearing the mark removes the line rather than writing a negative assertion',
      )
      assert.equal(readBacklogFrontmatterFields(await readFile(epicOrderPath, 'utf-8')).dependenciesPlanned, undefined)

      const rejectedMark = await updateBacklogDependenciesPlanned({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/epics/ordering.md',
        dependenciesPlanned: 'true' as unknown as boolean,
      })
      assert.equal(rejectedMark.ok, false, 'a stringy "true" is not the assertion')
      await rm(epicOrderPath)

      // Mockup attachments are the item-side write: the single comma-separated
      // `mockups:` frontmatter line, set/cleared via the shared CSV formatter, body
      // + unrelated keys preserved, sidecar untouched. Same shape as dependsOn, but
      // the paths carry slashes (a stored attachment is a project-relative path).
      const mockPath = join(tempRoot, 'backlog', 'mock.md')
      const mockBody = '# Mock\n\nBody stays put.\n'
      const mockOriginal = `---\nstatus: idea\ncustom: keep-me\n---\n${mockBody}`
      await writeFile(mockPath, mockOriginal, 'utf-8')
      const readMock = async (): Promise<ReturnType<typeof parseBacklogFrontmatter>> =>
        parseBacklogFrontmatter(await readFile(mockPath, 'utf-8'))

      // Set a list: backslashes normalized, duplicates dropped, first-seen order kept.
      const mockSet = await updateBacklogMockups({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/mock.md',
        mockups: ['backlog/mockups/a.html', 'mockups\\b.html', 'backlog/mockups/a.html'],
      })
      assert.equal(mockSet.ok, true)
      const afterMockSet = await readMock()
      assert.equal(afterMockSet.fields.mockups, 'backlog/mockups/a.html, mockups/b.html')
      assert.equal(afterMockSet.fields.custom, 'keep-me', 'an unrelated frontmatter key must be preserved')
      assert.equal(afterMockSet.body, mockBody, 'mockups write must preserve the document body byte-for-byte')

      // A `..` escape rejects the whole write and mutates nothing.
      const beforeBadMock = await readFile(mockPath, 'utf-8')
      const rejectedMock = await updateBacklogMockups({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/mock.md',
        mockups: ['mockups/ok.html', '../escape.html'],
      })
      assert.equal(rejectedMock.ok, false)
      assert.match(rejectedMock.ok ? '' : rejectedMock.message, /mockup/)
      assert.equal(
        await readFile(mockPath, 'utf-8'),
        beforeBadMock,
        'a rejected mockup path must not mutate the item file',
      )

      // Clearing with an empty list removes the line while retaining the mutation timestamp.
      const mockCleared = await updateBacklogMockups({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/mock.md',
        mockups: [],
      })
      assert.equal(mockCleared.ok, true)
      assert.equal('mockups' in (await readMock()).fields, false, 'clearing mockups must remove the frontmatter line')
      assert.equal((await readMock()).fields.custom, 'keep-me')
      assert.equal((await readMock()).body, mockBody)
      assert.match((await readMock()).fields.updated ?? '', PRECISE_ISO_TIMESTAMP)

      await rm(mockPath)

      // All lifecycle/type/triage/epic/dependsOn work so far must have stayed off the sidecar.
      await assert.rejects(() => stat(storePath), /ENOENT/, 'frontmatter mutations must never create the link cache')

      // Module metadata is app-owned churn and still writes the sidecar store.
      const metadataUpdated = await updateBacklogModuleMetadata({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        moduleId: 'weather-deck',
        value: { lastForecastId: 'checkout' },
      })
      assert.equal(metadataUpdated.ok, true)
      assert.deepEqual(metadataUpdated.ok ? metadataUpdated.store.items[0]?.metadata?.['weather-deck'] : null, {
        lastForecastId: 'checkout',
      })

      const beforeHighlightUpdatedAt = metadataUpdated.ok ? metadataUpdated.store.items[0]?.updatedAt : undefined
      const highlighted = await updateBacklogHighlight({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        starred: true,
        color: 'amber',
      })
      assert.equal(highlighted.ok, true)
      // The star is durable, so it lands in the item's own frontmatter rather than
      // the cache — that is what makes it survive losing the cache and travel with
      // the file. The read model recomposes it (see backlog.test.ts).
      {
        const item = await readItem()
        assert.equal(item.fields.starred, 'true')
        assert.equal(item.fields.highlight, 'amber')
        assert.equal(item.body, body, 'the body is byte-preserved')
      }
      assert.ok(beforeHighlightUpdatedAt, 'the cache still carries its own churn timestamp')

      // Unknown color names are rejected explicitly, never coerced or persisted.
      const beforeInvalidColor = await readFile(itemPath, 'utf-8')
      const rejectedColor = await updateBacklogHighlight({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        starred: true,
        color: 'magenta' as unknown as 'red',
      })
      assert.equal(rejectedColor.ok, false)
      assert.match(rejectedColor.ok ? '' : rejectedColor.message, /highlight color/)
      assert.equal(
        await readFile(itemPath, 'utf-8'),
        beforeInvalidColor,
        'rejected highlight colors must not touch the item file',
      )

      const rejectedStarred = await updateBacklogHighlight({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        starred: 1 as unknown as boolean,
        color: null,
      })
      assert.equal(rejectedStarred.ok, false)
      assert.match(rejectedStarred.ok ? '' : rejectedStarred.message, /highlight star/)

      // Starred with no color is a valid state.
      const starredOnly = await updateBacklogHighlight({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        starred: true,
        color: null,
      })
      assert.equal(starredOnly.ok, true)
      {
        const item = await readItem()
        assert.equal(item.fields.starred, 'true')
        assert.equal(item.fields.highlight, undefined, 'no colour writes no colour key')
      }

      // Clearing both star and colour removes BOTH keys, so an un-highlighted item
      // reads exactly as it did before these keys existed — no empty leftovers.
      const clearedHighlight = await updateBacklogHighlight({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        starred: false,
        color: null,
      })
      assert.equal(clearedHighlight.ok, true)
      {
        const item = await readItem()
        assert.equal(item.fields.starred, undefined, 'cleared star removes its line')
        assert.equal(item.fields.highlight, undefined, 'cleared colour removes its line')
        assert.equal(item.body, body, 'the body is still byte-preserved')
      }

      const linked = await addOrUpdateBacklogLink({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        status: 'in_progress',
        link: {
          id: 'weather-deck:checkout',
          moduleId: 'weather-deck',
          type: 'execution',
          label: 'Weather Deck forecast',
          target: {
            kind: 'weather-deck.forecast',
            id: 'checkout',
            path: '.sprintengine/weather-deck/checkout/forecast.yaml',
          },
          status: 'active',
        },
      })
      assert.equal(linked.ok, true)
      assert.equal(
        linked.ok ? linked.store.items[0]?.links?.[0]?.target.path : null,
        '.sprintengine/weather-deck/checkout/forecast.yaml',
      )
      assert.equal(
        linked.ok ? linked.store.items[0]?.status : null,
        undefined,
        'link lifecycle must not leak into the link cache',
      )
      assert.equal(
        (await readItem()).fields.status,
        'in_progress',
        'link lifecycle writes the frontmatter source of truth',
      )

      // Manual lifecycle control clears stale v1/link-written sidecar status so a
      // subsequent migration cannot restore completed over the user's Ready.
      const withStaleStatus = JSON.parse(await readFile(storePath, 'utf-8')) as {
        schemaVersion: 1
        items: Array<Record<string, unknown>>
      }
      withStaleStatus.items[0].status = 'completed'
      await writeFile(storePath, `${JSON.stringify(withStaleStatus, null, 2)}\n`, 'utf-8')
      const manuallyReady = await updateBacklogStatus({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        status: 'ready',
      })
      assert.equal(manuallyReady.ok, true)
      assert.equal((await readItem()).fields.status, 'ready')
      assert.equal(manuallyReady.ok ? manuallyReady.store.items[0]?.status : 'missing', undefined)

      const unlinked = await removeBacklogLink({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        linkId: 'weather-deck:checkout',
      })
      assert.equal(unlinked.ok, true)
      assert.deepEqual(
        unlinked.ok ? unlinked.store.items[0]?.links : null,
        [],
        'unlink removes only the selected association',
      )
      assert.equal((await readItem()).fields.status, 'ready', 'unlink leaves manually controlled lifecycle unchanged')

      const persisted = JSON.parse(await readFile(storePath, 'utf-8')) as {
        items: Array<{ source: { relativePath: string } }>
      }
      assert.equal(persisted.items[0]?.source.relativePath, 'backlog/checkout.md')

      // Main-owned creation paths stamp the exact UTC instant into frontmatter so
      // recency remains portable instead of depending on checkout-time mtimes.
      const createdItem = await createBacklogItem({ workspaceRoot: tempRoot, title: 'Precise timestamp' })
      assert.equal(createdItem.ok, true)
      const createdItemFile = parseBacklogFrontmatter(
        await readFile(join(tempRoot, createdItem.ok ? createdItem.relativePath : ''), 'utf-8'),
      )
      assert.equal(createdItemFile.fields.id, '1', 'main-owned creation allocates the display id before writing')
      assert.match(createdItemFile.fields.updated ?? '', PRECISE_ISO_TIMESTAMP)
      const createdItemRecord = createdItem.ok
        ? createdItem.store.items.find((record) => record.source.relativePath === createdItem.relativePath)
        : undefined
      assert.equal(createdItemFile.fields.updated, createdItemRecord?.createdAt)

      // Concurrent Studio MCP creates share one per-project allocation/write lane:
      // both the display ids and collision-safe files are unique, and neither
      // sidecar registration is lost to a stale read-modify-write.
      const [concurrentA, concurrentB] = await Promise.all([
        createBacklogItem({ workspaceRoot: tempRoot, title: 'Concurrent create' }),
        createBacklogItem({ workspaceRoot: tempRoot, title: 'Concurrent create' }),
      ])
      assert.equal(concurrentA.ok, true)
      assert.equal(concurrentB.ok, true)
      if (concurrentA.ok && concurrentB.ok) {
        assert.notEqual(concurrentA.relativePath, concurrentB.relativePath)
        const ids = await Promise.all(
          [concurrentA.relativePath, concurrentB.relativePath].map(async (relativePath) => {
            const parsed = parseBacklogFrontmatter(await readFile(join(tempRoot, relativePath), 'utf-8'))
            return parsed.fields.id
          }),
        )
        assert.deepEqual(ids.sort(), ['2', '3'])
        const persisted = JSON.parse(await readFile(storePath, 'utf-8')) as {
          items: Array<{ source: { relativePath: string } }>
        }
        assert.equal(
          persisted.items.filter((record) => record.source.relativePath.includes('concurrent-create')).length,
          2,
          'both concurrent creates remain registered',
        )
      }

      // Create-epic writes a new concept file under backlog/epics/ with type: epic
      // and the title heading; it never adds a link-cache membership record.
      const storeBeforeEpicCreate = await readFile(storePath, 'utf-8')
      const createdEpic = await createBacklogEpic({ workspaceRoot: tempRoot, title: 'Auth Revamp' })
      assert.equal(createdEpic.ok, true)
      assert.equal(createdEpic.ok ? createdEpic.slug : '', 'auth-revamp')
      assert.equal(createdEpic.ok ? createdEpic.relativePath : '', 'backlog/epics/auth-revamp.md')
      const epicFile = parseBacklogFrontmatter(
        await readFile(join(tempRoot, 'backlog', 'epics', 'auth-revamp.md'), 'utf-8'),
      )
      assert.equal(epicFile.fields.type, 'epic')
      assert.match(epicFile.fields.updated ?? '', PRECISE_ISO_TIMESTAMP)
      assert.match(epicFile.body, /^# Auth Revamp$/m)
      assert.equal(
        await readFile(storePath, 'utf-8'),
        storeBeforeEpicCreate,
        'creating an epic must not touch the link cache',
      )

      // A second epic with the same title gets a collision-safe slug, not a clobber.
      const createdEpic2 = await createBacklogEpic({ workspaceRoot: tempRoot, title: 'Auth Revamp' })
      assert.equal(createdEpic2.ok, true)
      assert.equal(createdEpic2.ok ? createdEpic2.slug : '', 'auth-revamp-2')
      assert.equal(createdEpic2.ok ? createdEpic2.relativePath : '', 'backlog/epics/auth-revamp-2.md')

      // An empty title is rejected rather than producing an untitled epic file.
      const rejectedEpicTitle = await createBacklogEpic({ workspaceRoot: tempRoot, title: '   ' })
      assert.equal(rejectedEpicTitle.ok, false)
      assert.match(rejectedEpicTitle.ok ? '' : rejectedEpicTitle.message, /title/)

      // Path validation: absolute item paths are rejected and mutate nothing.
      const beforeAbsoluteFile = await readFile(itemPath, 'utf-8')
      const beforeAbsoluteStore = await readFile(storePath, 'utf-8')
      const rejectedAbsoluteItem = await updateBacklogStatus({
        workspaceRoot: tempRoot,
        relativePath: '/backlog/absolute.md',
        status: 'completed',
      })
      assert.equal(rejectedAbsoluteItem.ok, false)
      assert.match(rejectedAbsoluteItem.ok ? '' : rejectedAbsoluteItem.message, /relative paths under backlog/)
      assert.equal(await readFile(itemPath, 'utf-8'), beforeAbsoluteFile, 'absolute paths must not mutate an item file')
      assert.equal(
        await readFile(storePath, 'utf-8'),
        beforeAbsoluteStore,
        'absolute paths must not mutate the sidecar',
      )

      const absoluteFreshRoot = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-absolute-'))
      try {
        const rejectedFreshAbsoluteItem = await updateBacklogStatus({
          workspaceRoot: absoluteFreshRoot,
          relativePath: '/backlog/fresh.md',
          status: 'completed',
        })
        assert.equal(rejectedFreshAbsoluteItem.ok, false)
        await assert.rejects(
          () => stat(workspaceStorePath(absoluteFreshRoot, 'backlog', 'cache', 'links.json')),
          /ENOENT/,
          'absolute backlog item paths must not create a missing sidecar',
        )
      } finally {
        await rm(absoluteFreshRoot, { force: true, recursive: true })
      }

      const beforeAbsoluteLink = await readFile(storePath, 'utf-8')
      const rejectedAbsoluteLink = await addOrUpdateBacklogLink({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/checkout.md',
        link: {
          id: 'absolute-target',
          moduleId: 'test',
          type: 'external',
          label: 'Absolute target',
          target: { kind: 'file', id: 'absolute-target', path: '/tmp/outside' },
        },
      })
      assert.equal(rejectedAbsoluteLink.ok, false)
      assert.match(rejectedAbsoluteLink.ok ? '' : rejectedAbsoluteLink.message, /project-relative/)
      assert.equal(
        await readFile(storePath, 'utf-8'),
        beforeAbsoluteLink,
        'absolute link target paths must not mutate the sidecar',
      )

      const rejectedTraversal = await updateBacklogStatus({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/../outside.md',
        status: 'completed',
      })
      assert.equal(rejectedTraversal.ok, false)
      assert.match(rejectedTraversal.ok ? '' : rejectedTraversal.message, /under backlog/)

      const rejectedOutsideBacklog = await updateBacklogStatus({
        workspaceRoot: tempRoot,
        relativePath: 'notes/checkout.md',
        status: 'completed',
      })
      assert.equal(rejectedOutsideBacklog.ok, false)
      assert.match(rejectedOutsideBacklog.ok ? '' : rejectedOutsideBacklog.message, /under backlog/)

      const rejectedRelativeRoot = await updateBacklogStatus({
        workspaceRoot: 'relative/root',
        relativePath: 'backlog/checkout.md',
        status: 'completed',
      })
      assert.equal(rejectedRelativeRoot.ok, false)
      assert.match(rejectedRelativeRoot.ok ? '' : rejectedRelativeRoot.message, /absolute path/)

      // A lifecycle write against a missing item file fails explicitly rather than
      // inventing a file or a success.
      const missingFile = await updateBacklogStatus({
        workspaceRoot: tempRoot,
        relativePath: 'backlog/ghost.md',
        status: 'completed',
      })
      assert.equal(missingFile.ok, false)
      assert.match(missingFile.ok ? '' : missingFile.message, /read Backlog item/)

      await writeFile(storePath, '{broken', 'utf-8')
      const corrupt = await readBacklogObjectStore(tempRoot)
      assert.equal(corrupt.ok, false)
      assert.match(corrupt.ok ? '' : corrupt.message, /parse Backlog metadata/)

      // A read-only item file surfaces a write failure instead of a silent success.
      const writeFailureRoot = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-write-failure-'))
      const writeFailureItemPath = join(writeFailureRoot, 'backlog', 'write.md')
      try {
        await mkdir(join(writeFailureRoot, 'backlog'), { recursive: true })
        await writeFile(writeFailureItemPath, '---\nstatus: idea\n---\n# Write\n', 'utf-8')
        await chmod(writeFailureItemPath, 0o444)
        const writeFailure = await updateBacklogStatus({
          workspaceRoot: writeFailureRoot,
          relativePath: 'backlog/write.md',
          status: 'completed',
        })
        assert.equal(writeFailure.ok, false)
        assert.match(writeFailure.ok ? '' : writeFailure.message, /write Backlog item/)
      } finally {
        await chmod(writeFailureItemPath, 0o644).catch(() => {})
        await rm(writeFailureRoot, { force: true, recursive: true })
      }
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }

    await assertLazyMigrationMatrix()
    await assertArchiveLeavesSidecarLifecycleFree()
  }

  // Archiving an item is a pure source-path move: it must never write a lifecycle
  // field (status/type/difficulty/criticality/risk/epic) into the sidecar record.
  // Archived-ness is path-derived by the reader (isArchivedBacklogPath), so a
  // sidecar status would be orphaned data — and since status is migratable under
  // sidecar-wins precedence, a later readBacklogObjectStore pass would clobber the
  // archived file's true pre-archive frontmatter status with 'archived'. Regression
  // guard for T23 (T21 live-verification F-1).
  async function assertArchiveLeavesSidecarLifecycleFree(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-archive-'))
    const storePath = workspaceStorePath(root, 'backlog', 'cache', 'links.json')
    const lifecycleKeys = ['status', 'type', 'difficulty', 'criticality', 'risk', 'epic']
    try {
      // The file has already been moved on disk to its archived path, carrying its
      // true pre-archive frontmatter status: ready.
      const body = '# Checkout\n\nSpeed up checkout.\n'
      const archivedFile = '---\nstatus: ready\n---\n' + body
      await mkdir(join(root, 'backlog', 'archived'), { recursive: true })
      await writeFile(join(root, 'backlog', 'archived', 'checkout.md'), archivedFile, 'utf-8')

      // Re-point the sidecar source from the live path to the archived path.
      const moved = await moveBacklogObjectSource({
        workspaceRoot: root,
        relativePath: 'backlog/checkout.md',
        nextRelativePath: 'backlog/archived/checkout.md',
      })
      assert.equal(moved.ok, true)
      const movedRecord = moved.ok ? moved.store.items[0] : null
      assert.equal(
        movedRecord?.source.relativePath,
        'backlog/archived/checkout.md',
        'archive must rewrite the sidecar source path',
      )
      // The normalized in-memory record carries lifecycle keys as `undefined`;
      // JSON.stringify drops them, so the value (not key presence) is the invariant.
      for (const key of lifecycleKeys) {
        assert.equal(
          (movedRecord as Record<string, unknown>)[key],
          undefined,
          `archive must not write ${key} into the sidecar record`,
        )
      }
      const persisted = JSON.parse(await readFile(storePath, 'utf-8')) as { items: Array<Record<string, unknown>> }
      for (const key of lifecycleKeys) {
        assert.equal(key in persisted.items[0], false, `persisted sidecar must not carry ${key} after archive`)
      }

      // A subsequent lazy-migration pass must inject nothing: with no lifecycle key
      // in the sidecar there is nothing to migrate, so the archived file's true
      // status survives instead of being overwritten with 'archived'.
      const fileBefore = await readFile(join(root, 'backlog', 'archived', 'checkout.md'), 'utf-8')
      const read = await readBacklogObjectStore(root)
      assert.equal(read.ok, true)
      const reloaded = read.ok ? read.store.items[0] : null
      assert.equal(
        reloaded?.status as unknown,
        undefined,
        'migration must not synthesize a sidecar status for an archived record',
      )
      const afterMigrate = parseBacklogFrontmatter(
        await readFile(join(root, 'backlog', 'archived', 'checkout.md'), 'utf-8'),
      )
      assert.equal(afterMigrate.fields.status, 'ready', 'archive must not clobber the archived file frontmatter status')
      assert.equal(
        await readFile(join(root, 'backlog', 'archived', 'checkout.md'), 'utf-8'),
        fileBefore,
        'a migration pass over an archived record must not rewrite the item file',
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }

  // Lazy v1 -> v2 migration: the pure planner plus the on-disk migration that
  // readBacklogObjectStore performs (sidecar wins, body preserved, orphan GC,
  // unknown values tolerated, idempotent re-run).
  async function assertLazyMigrationMatrix(): Promise<void> {
    // --- Pure planner ---------------------------------------------------------
    const plan = planBacklogStoreMigration({
      schemaVersion: 1,
      items: [
        {
          id: 'a',
          source: { type: 'file', relativePath: 'backlog/a.md' },
          status: 'ready',
          type: 'saga',
          metadata: { x: 1 },
        },
        { id: 'b', source: { type: 'file', relativePath: 'backlog/b.md' }, difficulty: 7, links: [] },
        { id: 'c', source: { type: 'file', relativePath: 'backlog/c.md' }, metadata: {} },
      ],
    })
    assert.equal(plan.changed, true)
    // 'a' migrates status + an unknown type string; both are preserved, not dropped.
    const aMig = plan.migrations.find((m) => m.relativePath === 'backlog/a.md')
    assert.deepEqual(aMig?.updates, { status: 'ready', type: 'saga' })
    // 'b' carried only a non-string difficulty: stripped, but nothing to migrate.
    assert.equal(
      plan.migrations.some((m) => m.relativePath === 'backlog/b.md'),
      false,
    )
    // 'c' had no migratable fields and produces no migration.
    assert.equal(
      plan.migrations.some((m) => m.relativePath === 'backlog/c.md'),
      false,
    )
    // Every record is slimmed of the lightweight fields.
    assert.ok(plan.slimRecords.every((r) => !('status' in r) && !('type' in r) && !('difficulty' in r)))
    assert.deepEqual((plan.slimRecords[0] as { metadata?: unknown }).metadata, { x: 1 })
    // An already-migrated store is a no-op.
    assert.equal(
      planBacklogStoreMigration({
        schemaVersion: 1,
        items: [{ id: 'a', source: { type: 'file', relativePath: 'backlog/a.md' } }],
      }).changed,
      false,
    )
    // sec F1: a crafted multi-line cache scalar is flattened before it can
    // reach the frontmatter writer, so it cannot inject extra keys.
    const injected = planBacklogStoreMigration({
      schemaVersion: 1,
      items: [
        { id: 'x', source: { type: 'file', relativePath: 'backlog/x.md' }, status: 'idea\ntype: epic\norder: -999' },
      ],
    }).migrations.find((m) => m.relativePath === 'backlog/x.md')
    assert.deepEqual(injected?.updates, { status: 'idea type: epic order: -999' })

    // --- On-disk migration via readBacklogObjectStore -------------------------
    const root = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-migrate-'))
    const storePath = workspaceStorePath(root, 'backlog', 'cache', 'links.json')
    try {
      const body = '# Checkout\n\nSpeed up checkout.\n'
      await mkdir(join(root, 'backlog'), { recursive: true })
      // The file already carries a status; the sidecar must WIN over it on migrate.
      await writeFile(join(root, 'backlog', 'a.md'), `---\nstatus: idea\n---\n${body}`, 'utf-8')
      await mkdir(workspaceStorePath(root, 'backlog', 'cache'), { recursive: true })
      await writeFile(
        storePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            items: [
              {
                id: 'a',
                source: { type: 'file', relativePath: 'backlog/a.md' },
                status: 'ready',
                type: 'saga',
                difficulty: 'm',
                criticality: 'high',
                risk: 'low',
                metadata: { jira: 'P-1' },
                links: [],
              },
              // Orphan: no file on disk -> must be pruned.
              { id: 'ghost', source: { type: 'file', relativePath: 'backlog/ghost.md' }, status: 'in_progress' },
            ],
          },
          null,
          2,
        )}\n`,
        'utf-8',
      )

      const read = await readBacklogObjectStore(root)
      assert.equal(read.ok, true)
      const records = read.ok ? read.store.items : []
      // Orphan pruned; only the real item's record survives, slimmed of triage but
      // keeping its app-owned churn.
      assert.deepEqual(
        records.map((r) => r.source.relativePath),
        ['backlog/a.md'],
      )
      assert.equal(records[0]?.status, undefined)
      assert.equal(records[0]?.type, undefined)
      assert.equal(records[0]?.risk as unknown, undefined)
      assert.deepEqual(records[0]?.metadata, { jira: 'P-1' })

      // Frontmatter now holds the sidecar-won values; an unknown type is preserved;
      // the body is byte-identical.
      const migrated = parseBacklogFrontmatter(await readFile(join(root, 'backlog', 'a.md'), 'utf-8'))
      assert.equal(migrated.fields.status, 'ready', 'sidecar status wins over the file value')
      assert.equal(migrated.fields.type, 'saga', 'unknown type preserved, not dropped')
      assert.equal(migrated.fields.difficulty, 'm')
      assert.equal(migrated.fields.criticality, 'high')
      assert.equal(migrated.fields.risk, 'low')
      assert.equal(migrated.body, body, 'migration preserves the document body byte-for-byte')

      // The persisted sidecar is slim (fields stripped, churn kept).
      const persisted = JSON.parse(await readFile(storePath, 'utf-8')) as { items: Array<Record<string, unknown>> }
      assert.equal(persisted.items.length, 1)
      assert.equal('status' in persisted.items[0], false)
      assert.equal('type' in persisted.items[0], false)

      // Idempotent: a second read moves nothing and rewrites neither file.
      const fileBefore = await readFile(join(root, 'backlog', 'a.md'), 'utf-8')
      const storeBefore = await readFile(storePath, 'utf-8')
      const reread = await readBacklogObjectStore(root)
      assert.equal(reread.ok, true)
      assert.equal(
        await readFile(join(root, 'backlog', 'a.md'), 'utf-8'),
        fileBefore,
        're-run must not rewrite the item',
      )
      assert.equal(await readFile(storePath, 'utf-8'), storeBefore, 're-run must not rewrite the sidecar')
    } finally {
      await rm(root, { force: true, recursive: true })
    }

    // A not-yet-migrated workspace with no sidecar at all reads cleanly and leaves
    // its item files untouched (nothing to migrate).
    const freshRoot = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-migrate-fresh-'))
    try {
      await mkdir(join(freshRoot, 'backlog'), { recursive: true })
      const fresh = '---\nstatus: ready\n---\n# Fresh\n'
      await writeFile(join(freshRoot, 'backlog', 'fresh.md'), fresh, 'utf-8')
      const read = await readBacklogObjectStore(freshRoot)
      assert.equal(read.ok, true)
      assert.deepEqual(read.ok ? read.store.items : null, [])
      assert.equal(
        await readFile(join(freshRoot, 'backlog', 'fresh.md'), 'utf-8'),
        fresh,
        'no sidecar -> no migration, file untouched',
      )
    } finally {
      await rm(freshRoot, { force: true, recursive: true })
    }
  }

  async function testBacklogIntegrityRepairsAreNarrowAndIdempotent(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-repair-'))
    try {
      await mkdir(join(root, 'backlog'), { recursive: true })
      await writeFile(join(root, 'backlog', 'keep.md'), '---\nid: 41\n---\n# Keep\n', 'utf-8')
      await writeFile(join(root, 'backlog', 'duplicate.md'), '---\nid: 41\n---\n# Reallocate\n', 'utf-8')
      await writeFile(join(root, 'backlog', 'highest.md'), '---\nid: 43\n---\n# Highest\n', 'utf-8')
      await mkdir(join(root, 'backlog', 'archived'), { recursive: true })
      await writeFile(
        join(root, 'backlog', 'archived', 'highest.md'),
        '---\nid: 45\n---\n# Archived highest\n',
        'utf-8',
      )
      await writeFile(join(root, 'backlog', 'nul.md'), "---\nid: 42\n---\n# NUL\n\nUse the '\0' escape.\n", 'utf-8')

      const nul = await repairBacklogIntegrity({
        workspaceRoot: root,
        relativePath: 'backlog/nul.md',
        issue: 'embedded_nul',
      })
      assert.deepEqual(nul, {
        ok: true,
        relativePath: 'backlog/nul.md',
        issue: 'embedded_nul',
        replacements: 1,
      })
      const sanitized = await readFile(join(root, 'backlog', 'nul.md'), 'utf-8')
      assert.equal(sanitized.includes('\0'), false)
      assert.match(sanitized, /Use the '\\0' escape\./)
      assert.match(parseBacklogFrontmatter(sanitized).fields.updated ?? '', PRECISE_ISO_TIMESTAMP)
      const nulRetry = await repairBacklogIntegrity({
        workspaceRoot: root,
        relativePath: 'backlog/nul.md',
        issue: 'embedded_nul',
      })
      assert.equal(nulRetry.ok, false, 'a repaired file is refused rather than rewritten again')

      const duplicate = await repairBacklogIntegrity({
        workspaceRoot: root,
        relativePath: 'backlog/duplicate.md',
        issue: 'duplicate_id',
      })
      assert.equal(duplicate.ok, true)
      assert.deepEqual(
        duplicate.ok
          ? {
              previousNumericId: duplicate.previousNumericId,
              numericId: duplicate.numericId,
            }
          : null,
        { previousNumericId: 41, numericId: 46 },
      )
      const repaired = parseBacklogFrontmatter(await readFile(join(root, 'backlog', 'duplicate.md'), 'utf-8'))
      assert.equal(repaired.fields.id, '46', 'allocation includes nested/archived Backlog sources')
      assert.match(repaired.fields.updated ?? '', PRECISE_ISO_TIMESTAMP)
      assert.equal(parseBacklogFrontmatter(await readFile(join(root, 'backlog', 'keep.md'), 'utf-8')).fields.id, '41')
      const duplicateRetry = await repairBacklogIntegrity({
        workspaceRoot: root,
        relativePath: 'backlog/duplicate.md',
        issue: 'duplicate_id',
      })
      assert.equal(duplicateRetry.ok, false, 'a non-duplicate id cannot be arbitrarily changed')
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }

  // Read-only listing/reading for the automation server's backlog tools: files +
  // frontmatter are the whole read model, and neither call may create or touch
  // the app's state (an external read tool must not mutate the app's stores).
  async function testListAndReadBacklogItemsAreReadOnly(): Promise<void> {
    const tempRoot = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-list-'))
    try {
      await mkdir(join(tempRoot, 'backlog', 'epics'), { recursive: true })
      await writeFile(
        join(tempRoot, 'backlog', '2026-07-08-ship-thing.md'),
        '---\ntype: feature\nstatus: ready\ndifficulty: m\ncriticality: high\nrisk: low\nepic: things\nid: 12\n---\n\n# Ship the thing\n\nBody text.\n',
        'utf-8',
      )
      await writeFile(join(tempRoot, 'backlog', 'no-frontmatter.md'), '# Bare capture\n', 'utf-8')
      await writeFile(join(tempRoot, 'backlog', 'old.md'), '---\nstatus: archived\n---\n# Old\n', 'utf-8')
      await writeFile(join(tempRoot, 'backlog', 'epics', 'things.md'), '---\ntype: epic\n---\n# Things\n', 'utf-8')
      // A roadmap is discovered from backlog/roadmaps/ and tagged type: roadmap.
      await mkdir(join(tempRoot, 'backlog', 'roadmaps'), { recursive: true })
      await writeFile(
        join(tempRoot, 'backlog', 'roadmaps', 'payments.md'),
        '---\ntype: roadmap\nstatus: ready\n---\n# Payments roadmap\n\n## Backend\n- backlog/2026-07-08-ship-thing.md\n',
        'utf-8',
      )

      const listed = await listBacklogItems(tempRoot)
      assert.equal(listed.ok, true)
      if (!listed.ok) return
      assert.equal(listed.key, null, 'no config.json yet -> key is null')
      assert.deepEqual(listed.items, [
        {
          relativePath: 'backlog/2026-07-08-ship-thing.md',
          title: 'Ship the thing',
          id: 12,
          isEpic: false,
          status: 'ready',
          type: 'feature',
          difficulty: 'm',
          criticality: 'high',
          risk: 'low',
          epic: 'things',
        },
        { relativePath: 'backlog/epics/things.md', title: 'Things', isEpic: true, status: 'idea', type: 'epic' },
        { relativePath: 'backlog/no-frontmatter.md', title: 'Bare capture', isEpic: false, status: 'idea' },
        {
          relativePath: 'backlog/roadmaps/payments.md',
          title: 'Payments roadmap',
          isEpic: false,
          isRoadmap: true,
          status: 'ready',
        },
      ])
      // Read-only means read-only: listing registers nothing and persists no key.
      await assert.rejects(
        () => stat(join(tempRoot, '.sprintengine')),
        /ENOENT/,
        'listing must not create .sprintengine',
      )

      await assert.rejects(
        () => stat(workspaceStorePath(tempRoot, 'backlog', 'config.json')),
        /ENOENT/,
        'listing persists no key in the store either',
      )

      await mkdir(workspaceStorePath(tempRoot, 'backlog'), { recursive: true })
      await writeFile(workspaceStorePath(tempRoot, 'backlog', 'config.json'), '{"key":"MC"}\n', 'utf-8')
      const keyed = await listBacklogItems(tempRoot)
      assert.equal(keyed.ok && keyed.key, 'MC')

      const read = await readBacklogItem(tempRoot, 'backlog/2026-07-08-ship-thing.md')
      assert.equal(read.ok, true)
      if (read.ok) {
        assert.equal(read.item.title, 'Ship the thing')
        assert.equal(read.item.id, 12)
        assert.equal(read.item.status, 'ready')
        assert.match(read.body, /^# Ship the thing/m)
        assert.doesNotMatch(read.body, /^---/, 'body excludes the frontmatter block')
      }

      const missing = await readBacklogItem(tempRoot, 'backlog/gone.md')
      assert.equal(missing.ok, false)
      assert.match(missing.ok ? '' : missing.message, /does not exist/)

      for (const bad of ['backlog/../package.json', '/etc/passwd', 'src/main/index.ts']) {
        const denied = await readBacklogItem(tempRoot, bad)
        assert.equal(denied.ok, false, `path "${bad}" is rejected`)
      }
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  }

  // The sidecar was tracked and ~550KB in a real project, and a scan or a link
  // re-resolve that confirms what is already stored must not touch it. Two guards
  // hold that line: the record keeps its prior `updatedAt` when nothing else moved,
  // and saveStore skips a write whose bytes match the file. Asserted on mtime AND
  // content, because only the pair proves no write happened at all.
  async function testConfirmingRewritesLeaveTheSidecarAlone(): Promise<void> {
    const tempRoot = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-nochurn-'))
    const storePath = workspaceStorePath(tempRoot, 'backlog', 'cache', 'links.json')
    try {
      const created = await createBacklogItem({ workspaceRoot: tempRoot, title: 'Churn guard' })
      assert.equal(created.ok, true)
      const relativePath = created.ok ? created.relativePath : ''

      const link = {
        id: 'backlog:pull-request',
        moduleId: 'backlog',
        type: 'external' as const,
        label: 'Pull request',
        target: { kind: 'backlog.pullRequest', id: 'https://example.test/pull/1' },
        status: 'active' as const,
        updatedAt: '2026-09-01T00:00:00.000Z',
      }
      const first = await addOrUpdateBacklogLink({ workspaceRoot: tempRoot, relativePath, link })
      assert.equal(first.ok, true, 'the first link write lands')

      const afterFirst = await readFile(storePath, 'utf-8')
      const mtimeFirst = (await stat(storePath)).mtimeMs

      // Re-persisting the identical link is what the live status sync does on every
      // tick. It must be a complete no-op.
      await new Promise((resolve) => setTimeout(resolve, 12))
      const again = await addOrUpdateBacklogLink({ workspaceRoot: tempRoot, relativePath, link })
      assert.equal(again.ok, true, 'a confirming re-write still reports success')

      assert.equal(await readFile(storePath, 'utf-8'), afterFirst, 'no field changed, updatedAt included')
      assert.equal((await stat(storePath)).mtimeMs, mtimeFirst, 'the file was not rewritten at all')

      // The cache is kept in the project's store, so nothing of it is written
      // into the project: no cache folder, and no ignore file for one.
      await assert.rejects(() => stat(join(tempRoot, '.sprintengine')), /ENOENT/, 'nothing lands in the project')

      // A real change must still land, or the guard would be silently swallowing writes.
      const changed = await addOrUpdateBacklogLink({
        workspaceRoot: tempRoot,
        relativePath,
        link: { ...link, status: 'completed' as const },
      })
      assert.equal(changed.ok, true)
      const afterChange = await readFile(storePath, 'utf-8')
      assert.notEqual(afterChange, afterFirst, 'a genuine status change is persisted')
      assert.match(afterChange, /"status": "completed"/)
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  }

  // The one-time drain off the committed sidecar. It is the only step that deletes
  // user data, so it is pinned on all four outcomes: durable facts reach the file,
  // volatile ones reach the cache, orphans are dropped, and the sidecar goes.
  async function testLegacySidecarMigration(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-legacy-'))
    const legacyPath = join(root, '.sprintengine', 'backlog', 'items.json')
    const cachePath = workspaceStorePath(root, 'backlog', 'cache', 'links.json')
    try {
      const body = '# Worked item\n\nBody text that must survive byte-for-byte.\n'
      await mkdir(join(root, 'backlog'), { recursive: true })
      await writeFile(join(root, 'backlog', 'worked.md'), `---\nstatus: completed\nid: 7\n---\n${body}`, 'utf-8')
      await mkdir(join(root, '.sprintengine', 'backlog'), { recursive: true })
      await writeFile(
        legacyPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            items: [
              {
                id: 'backlog_worked',
                source: { type: 'file', relativePath: 'backlog/worked.md' },
                highlight: { starred: true, color: 'amber' },
                metadata: { 'agent-runtime': { agentId: 'agent-x' } },
                links: [
                  // Durable: belongs in the file.
                  {
                    id: 'backlog:pull-request',
                    moduleId: 'backlog',
                    type: 'external',
                    label: 'Pull request',
                    target: { kind: 'backlog.pullRequest', id: 'https://x.test/pull/9', url: 'https://x.test/pull/9' },
                    status: 'active',
                  },
                  // Volatile: a terminal id, meaningless after a restart.
                  {
                    id: 'agent-runtime:working-agent',
                    moduleId: 'agent-runtime',
                    type: 'agent',
                    label: 'Agent: Someone',
                    target: { kind: 'agent.terminal', id: 'ws1/agent-x' },
                  },
                ],
              },
              // Orphan: the markdown is gone, so the record describes nothing.
              { id: 'ghost', source: { type: 'file', relativePath: 'backlog/ghost.md' }, links: [] },
            ],
          },
          null,
          2,
        )}\n`,
        'utf-8',
      )

      const read = await readBacklogObjectStore(root)
      assert.equal(read.ok, true, 'the migration runs on the first read')

      // 1. Durable facts landed in the item's own frontmatter, body untouched.
      const migrated = parseBacklogFrontmatter(await readFile(join(root, 'backlog', 'worked.md'), 'utf-8'))
      assert.equal(migrated.fields.pr, 'https://x.test/pull/9')
      assert.equal(migrated.fields.starred, 'true')
      assert.equal(migrated.fields.highlight, 'amber')
      assert.equal(migrated.fields.status, 'completed', 'existing frontmatter is preserved')
      assert.equal(migrated.body, body, 'the body is byte-preserved')
      assert.doesNotMatch(migrated.fields.pr ?? '', /active/, 'no resolved status reaches the file')

      // 2. The sidecar is gone, so the migration cannot run twice.
      await assert.rejects(() => stat(legacyPath), /ENOENT/, 'the legacy sidecar is removed')

      // 3. Volatile state survives in the gitignored cache, orphan dropped.
      const cache = JSON.parse(await readFile(cachePath, 'utf-8')) as {
        items: Array<{ source: { relativePath: string }; links?: Array<{ id: string }>; highlight?: unknown }>
      }
      assert.equal(cache.items.length, 1, 'the orphan record is dropped, not carried over')
      assert.equal(cache.items[0].source.relativePath, 'backlog/worked.md')
      assert.ok(
        cache.items[0].links?.some((link) => link.id === 'agent-runtime:working-agent'),
        'the agent link stays cached',
      )
      assert.equal(cache.items[0].highlight, undefined, 'the star moved to the file and is not duplicated')

      // 4. Idempotent: a second read changes nothing.
      const fileAfterFirst = await readFile(join(root, 'backlog', 'worked.md'), 'utf-8')
      const again = await readBacklogObjectStore(root)
      assert.equal(again.ok, true)
      assert.equal(
        await readFile(join(root, 'backlog', 'worked.md'), 'utf-8'),
        fileAfterFirst,
        're-reading rewrites nothing',
      )
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }

  // A folder under `backlog/` is an epic and its children are the items in it, so a
  // new item has to be born in the right one — otherwise the structure decays back
  // to a flat directory one creation at a time.
  async function testNewItemsAreFiledUnderTheirEpic(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-filing-'))
    try {
      const filed = await createBacklogItem({ workspaceRoot: root, title: 'Filed item', epic: 'auth-revamp' })
      assert.equal(filed.ok, true)
      assert.equal(
        filed.ok ? filed.relativePath : '',
        `backlog/auth-revamp/${filed.ok ? filed.relativePath.split('/').pop() : ''}`,
      )
      assert.match(filed.ok ? filed.relativePath : '', /^backlog\/auth-revamp\/\d{4}-\d{2}-\d{2}-filed-item\.md$/)
      assert.equal(
        (await readBacklogItem(root, filed.ok ? filed.relativePath : '')).ok,
        true,
        'and it is readable where it landed',
      )

      // No epic still needs a home, and the top level is reserved for epic folders.
      const unfiled = await createBacklogItem({ workspaceRoot: root, title: 'Loose item' })
      assert.equal(unfiled.ok, true)
      assert.match(unfiled.ok ? unfiled.relativePath : '', /^backlog\/unfiled\/\d{4}-\d{2}-\d{2}-loose-item\.md$/)

      // An epic slug can never escape its folder, whatever the caller passes.
      const escaped = await createBacklogItem({ workspaceRoot: root, title: 'Escapee', epic: '../../etc' })
      assert.equal(escaped.ok, true, 'an invalid slug is dropped, not fatal')
      assert.match(escaped.ok ? escaped.relativePath : '', /^backlog\/unfiled\//, 'and the item falls back to unfiled')

      // Stems stay unique ACROSS folders, because dependsOn and epic pointers
      // address an item by its stem alone — two items sharing one would collide on
      // every pointer aimed at either.
      const sameTitleElsewhere = await createBacklogItem({
        workspaceRoot: root,
        title: 'Filed item',
        epic: 'other-epic',
      })
      assert.equal(sameTitleElsewhere.ok, true)
      const firstStem = (filed.ok ? filed.relativePath : '').split('/').pop()
      const secondStem = (sameTitleElsewhere.ok ? sameTitleElsewhere.relativePath : '').split('/').pop()
      assert.notEqual(secondStem, firstStem, 'a colliding stem is suffixed even in a different folder')
      assert.match(sameTitleElsewhere.ok ? sameTitleElsewhere.relativePath : '', /^backlog\/other-epic\//)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }

  // listBacklogItems named three directories (`backlog/`, `epics/`, `roadmaps/`)
  // and listed each one flat. Once items moved into their epic's folder that saw
  // only the epics and roadmaps, and the MCP `backlog_list` tool answered with a
  // backlog that had no items in it — while the renderer's own scan, which always
  // walked the tree, showed all of them. The fixtures here are nested for exactly
  // that reason: a flat one cannot fail this way, which is why nothing caught it.
  async function testListingWalksNestedEpicFolders(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-nested-'))
    try {
      const write = async (relativePath: string, front: string): Promise<void> => {
        await mkdir(join(root, dirname(relativePath)), { recursive: true })
        await writeFile(join(root, relativePath), `---\n${front}\n---\n\n# ${basename(relativePath, '.md')}\n`, 'utf-8')
      }
      await write('backlog/epics/auth-revamp.md', 'type: epic\nstatus: in_progress\nid: 1')
      await write(
        'backlog/auth-revamp/2026-09-01-token-rotation.md',
        'type: bug\nstatus: ready\nepic: auth-revamp\nid: 2',
      )
      await write(
        'backlog/auth-revamp/2026-09-02-session-expiry.md',
        'type: feature\nstatus: idea\nepic: auth-revamp\nid: 3',
      )
      await write('backlog/unfiled/2026-09-03-loose-thought.md', 'type: spike\nstatus: idea\nid: 4')
      await write('backlog/roadmaps/2026-09-04-a-plan.md', 'status: idea\nid: 5')
      // Archived stays excluded, wherever it lives.
      await write('backlog/archived/2026-08-01-done-with.md', 'status: archived\nid: 6')

      const listed = await listBacklogItems(root)
      assert.equal(listed.ok, true)
      const paths = listed.ok ? listed.items.map((item) => item.relativePath).sort() : []
      assert.deepEqual(
        paths,
        [
          'backlog/auth-revamp/2026-09-01-token-rotation.md',
          'backlog/auth-revamp/2026-09-02-session-expiry.md',
          'backlog/epics/auth-revamp.md',
          'backlog/roadmaps/2026-09-04-a-plan.md',
          'backlog/unfiled/2026-09-03-loose-thought.md',
        ],
        'items inside epic folders are listed, and archived is not',
      )

      const nested = listed.ok
        ? listed.items.find((item) => item.relativePath.endsWith('token-rotation.md'))
        : undefined
      assert.equal(nested?.epic, 'auth-revamp', 'a nested item keeps its epic membership')
      assert.equal(nested?.id, 2)
      assert.equal(nested?.isEpic, false, 'an item in an epic folder is not itself an epic')
      const epic = listed.ok
        ? listed.items.find((item) => item.relativePath === 'backlog/epics/auth-revamp.md')
        : undefined
      assert.equal(epic?.isEpic, true)
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  }

  // A workspace can point its backlog at a folder outside the checkout. The items
  // land there, and their identity — the `backlog/<...>` relative path every id,
  // durable link and module link keys on — is exactly what it would have been
  // inside the checkout. That equivalence is the whole reason a backlog can move
  // without rewriting anything that points at it.
  async function testABacklogCanLiveOutsideTheCheckout(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-redirect-ws-'))
    const elsewhere = await mkdtemp(join(tmpdir(), 'sprintengine-backlog-redirect-store-'))
    try {
      await mkdir(workspaceStorePath(root, 'backlog'), { recursive: true })
      await writeFile(
        workspaceStorePath(root, 'backlog', 'config.json'),
        JSON.stringify({ schemaVersion: 2, key: 'MC', root: elsewhere }, null, 2),
        'utf-8',
      )

      const created = await createBacklogItem({ workspaceRoot: root, title: 'Token rotation', epic: 'auth-revamp' })
      assert.equal(created.ok, true, 'creating an item in a redirected backlog must succeed')
      const relativePath = created.ok ? created.relativePath : ''
      assert.ok(
        relativePath.startsWith('backlog/auth-revamp/'),
        `identity stays backlog/-prefixed wherever the root is, got ${relativePath}`,
      )

      // The file is in the external folder, under the path the logical one implies,
      // and nothing was written into the checkout's own backlog/ folder.
      const within = relativePath.slice('backlog/'.length)
      await stat(join(elsewhere, within))
      await assert.rejects(stat(join(root, relativePath)), 'nothing may be written inside the checkout')

      // Reads, writes and listings all resolve through the configured root.
      const read = await readBacklogItem(root, relativePath)
      assert.equal(read.ok, true, 'an item in a redirected backlog must be readable')

      const status = await updateBacklogStatus({ workspaceRoot: root, relativePath, status: 'ready' })
      assert.equal(status.ok, true, 'an item in a redirected backlog must be writable')
      const onDisk = parseBacklogFrontmatter(await readFile(join(elsewhere, within), 'utf-8'))
      assert.equal(onDisk.fields.status, 'ready', 'the write must land in the external folder')

      const listed = await listBacklogItems(root)
      assert.equal(listed.ok, true)
      assert.deepEqual(
        listed.ok ? listed.items.map((item) => item.relativePath) : [],
        [relativePath],
        'the listing reports logical paths, not paths relative to the checkout',
      )

      // The cache stays in the project's store: it is app state about this
      // project, not backlog content, and a shared backlog folder must not collect it.
      const store = JSON.parse(await readFile(workspaceStorePath(root, 'backlog', 'cache', 'links.json'), 'utf-8')) as {
        items: Array<{ source: { relativePath: string } }>
      }
      assert.equal(store.items[0]?.source.relativePath, relativePath)

      // And the display key survives a config rewrite rather than being clobbered
      // by a whole-object write from the key path.
      const config = JSON.parse(await readFile(workspaceStorePath(root, 'backlog', 'config.json'), 'utf-8')) as Record<
        string,
        unknown
      >
      assert.equal(config['root'], elsewhere, 'persisting the key must not drop the configured root')
      assert.equal(config['key'], 'MC')
    } finally {
      await rm(root, { force: true, recursive: true })
      await rm(elsewhere, { force: true, recursive: true })
    }
  }

  // The surface that points a backlog somewhere. Its refusals matter more than its
  // successes: a backlog root that swallows the checkout would make every file in
  // the repository a backlog item and put the watcher on a tree that size.
  async function testSettingABacklogRootValidatesWhatItIsGiven(): Promise<void> {
    // realpath because the service stores resolved paths, the same way it resolves
    // the workspace root — on macOS `/var` is a symlink to `/private/var`, and a
    // root that changes meaning when a symlink moves is not one worth storing.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-backlog-setroot-ws-')))
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-backlog-setroot-store-')))
    try {
      const before = await resolveBacklogLocation(root)
      assert.equal(before.ok, true)
      assert.equal(before.ok && before.location.isDefault, true, 'a fresh workspace is on the default root')
      assert.equal(before.ok && before.location.exists, false, 'and its backlog folder does not exist yet')

      const set = await setBacklogRoot({ workspaceRoot: root, root: elsewhere })
      assert.equal(set.ok, true, set.ok ? '' : set.message)
      assert.equal(set.ok && set.location.isDefault, false)
      assert.equal(set.ok && set.location.exists, true)

      const after = await resolveBacklogLocation(root)
      assert.equal(after.ok && after.location.root, elsewhere, 'the root survives a reload')

      // Refusals.
      for (const [candidate, why] of [
        [join(elsewhere, 'nope'), 'a folder that does not exist'],
        ['relative/path', 'a relative path'],
        [root, 'the workspace itself'],
        [dirname(root), 'a folder containing the workspace'],
      ] as Array<[string, string]>) {
        const refused = await setBacklogRoot({ workspaceRoot: root, root: candidate })
        assert.equal(refused.ok, false, `${why} must be refused`)
      }

      // A refusal leaves the previous root in place rather than clearing it.
      const unchanged = await resolveBacklogLocation(root)
      assert.equal(
        unchanged.ok && unchanged.location.root,
        elsewhere,
        'a refused change must not drop the current root',
      )

      // Resetting returns to the default and drops the field from the config.
      const reset = await setBacklogRoot({ workspaceRoot: root, root: null })
      assert.equal(reset.ok, true)
      assert.equal(reset.ok && reset.location.isDefault, true)
      const config = JSON.parse(await readFile(workspaceStorePath(root, 'backlog', 'config.json'), 'utf-8')) as Record<
        string,
        unknown
      >
      assert.equal('root' in config, false, 'resetting removes the field rather than writing an empty one')
      await assert.rejects(() => stat(join(root, '.sprintengine')), /ENOENT/, 'nothing is written into the project')
    } finally {
      await rm(root, { force: true, recursive: true })
      await rm(elsewhere, { force: true, recursive: true })
    }
  }

  // A project that committed an older build's `.sprintengine/backlog/config.json`
  // keeps it: the store's one-time move leaves a tracked file where it is, and
  // the service reads it while the store has no config of its own, so the
  // committed key is the one a clone starts from. The first change is written
  // to the store, seeded from it, and the committed file is never rewritten.
  async function testACommittedConfigIsReadAndNeverWritten(): Promise<void> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-backlog-committed-')))
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-backlog-committed-store-')))
    const committed = join(root, '.sprintengine', 'backlog', 'config.json')
    const committedText = `${JSON.stringify({ schemaVersion: 2, key: 'ACME' }, null, 2)}\n`
    try {
      await mkdir(dirname(committed), { recursive: true })
      await writeFile(committed, committedText, 'utf-8')
      const listed = await listBacklogItems(root)
      assert.equal(listed.ok && listed.key, 'ACME', 'the committed key is read')

      const set = await setBacklogRoot({ workspaceRoot: root, root: elsewhere })
      assert.equal(set.ok, true, set.ok ? '' : set.message)
      const stored = JSON.parse(await readFile(workspaceStorePath(root, 'backlog', 'config.json'), 'utf-8')) as Record<
        string,
        unknown
      >
      assert.equal(stored['key'], 'ACME', 'the store’s config starts from the committed one')
      assert.equal(stored['root'], elsewhere)
      assert.equal(await readFile(committed, 'utf-8'), committedText, 'the committed file is never written')
    } finally {
      await rm(root, { force: true, recursive: true })
      await rm(elsewhere, { force: true, recursive: true })
    }
  }

  const suiteRun = main()
    .then(() => testBacklogIntegrityRepairsAreNarrowAndIdempotent())
    .then(() => testListAndReadBacklogItemsAreReadOnly())
    .then(() => testConfirmingRewritesLeaveTheSidecarAlone())
    .then(() => testLegacySidecarMigration())
    .then(() => testNewItemsAreFiledUnderTheirEpic())
    .then(() => testListingWalksNestedEpicFolders())
    .then(() => testABacklogCanLiveOutsideTheCheckout())
    .then(() => testSettingABacklogRootValidatesWhatItIsGiven())
    .then(() => testACommittedConfigIsReadAndNeverWritten())
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })

  await suiteRun
})
