// `extension.create` and `extension.guide`: the project an agent asks for is
// the real scaffolder's, written into a temporary folder, and the guide is the
// SDK's own topics.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, test, vi } from 'vitest'

vi.mock('electron', () => import('../../../tests/stubs/electron'))

import { EXTENSION_GUIDE_TOPICS } from '../../../packages/module-sdk/src/guide'
import { listModuleParts, listModuleTemplates } from '../../../packages/module-sdk/src/scaffold'
import type { McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import { createExtensionScaffoldHandlers } from '../ipc/extension-scaffold-ipc'
import { createExtensionTools, EXTENSION_PART_IDS, EXTENSION_TEMPLATE_IDS } from './extension-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'
import { localOnlyGatewayToolReason } from './tailnet/tailnet-scopes'

const SDK = join(process.cwd(), 'packages', 'module-sdk')

let work = ''
let home = ''

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'extension-tools-'))
  home = join(work, 'Documents', 'SprintEngine', 'Extensions')
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

function tools(guideRoot = join(SDK, 'guide')): Record<'create' | 'guide', McpToolRegistration> {
  const [create, guide] = createExtensionTools({
    scaffold: createExtensionScaffoldHandlers({
      roots: () => ({
        templatesRoot: join(SDK, 'templates'),
        guideRoot,
        sdkTarball: join(work, 'no-tarball.tgz'),
      }),
      moduleRoot: () => join(work, 'installed-modules'),
      home: () => home,
    }),
    guideRoot: () => guideRoot,
  })
  return { create: create!, guide: guide! }
}

const call = (tool: McpToolRegistration, args: Record<string, unknown>) =>
  tool.handler(args, { metadata: { kind: 'external-local' } }) as Promise<McpToolResult>

const structured = (result: McpToolResult) => result.structuredContent as Record<string, unknown>
const errorCode = (result: McpToolResult) =>
  result.isError ? (structured(result).error as { code: string }).code : null

describe('extension.create', () => {
  test('makes the project in the folder the agent chose, and answers with how to build it', async () => {
    const folder = join(work, 'code', 'pr-radar')
    mkdirSync(join(work, 'code'))
    const result = await call(tools().create, {
      name: 'pr-radar',
      folder,
      brief: 'A badge counting the pull requests waiting on me.',
    })
    assert.equal(result.isError, undefined, result.content[0]?.type === 'text' ? result.content[0].text : '')
    const answer = structured(result)
    assert.equal(answer.folder, folder)
    assert.equal(answer.template, 'blank')
    assert.deepEqual(
      (answer.topics as Array<{ id: string }>).map((topic) => topic.id),
      EXTENSION_GUIDE_TOPICS.map((topic) => topic.id),
    )
    // The guide's start, as Markdown the agent reads as written.
    const markdown = result.content[1]
    assert.equal(markdown?.type, 'text')
    assert.match(markdown?.type === 'text' ? markdown.text : '', /^# Building a SprintEngine Studio extension/)

    const manifest = JSON.parse(readFileSync(join(folder, 'module', 'manifest.json'), 'utf8'))
    assert.equal(manifest.id, 'pr-radar')
    assert.equal(manifest.displayName, 'Pr radar')
    assert.match(readFileSync(join(folder, 'IDEA.md'), 'utf8'), /> A badge counting the pull requests waiting on me\./)
    assert.match(readFileSync(join(folder, 'AGENTS.md'), 'utf8'), /`extension\.guide`/)
    for (const file of ['plugin.json', 'package.json', 'scripts/check-toolchain.mjs', 'test/smoke.test.mjs']) {
      assert.ok(existsSync(join(folder, file)), `${file} is written`)
    }
    assert.equal(existsSync(join(folder, '.claude')), false, 'no skill is vendored')
    assert.equal(existsSync(join(folder, '.agents')), false, 'no skill is vendored')
  })

  test('starts from a template, adds parts, and defaults to the extensions home', async () => {
    const result = await call(tools().create, { name: 'focus-board', template: 'global-surface', parts: ['main'] })
    assert.equal(result.isError, undefined)
    const folder = join(home, 'focus-board')
    assert.equal(structured(result).folder, folder)
    assert.deepEqual(structured(result).parts, ['main'])
    const manifest = JSON.parse(readFileSync(join(folder, 'module', 'manifest.json'), 'utf8'))
    assert.equal(manifest.entry.main, 'dist/main.cjs', 'the main part is wired in')
    assert.ok(existsSync(join(folder, 'src', 'main.ts')))

    const parent = join(work, 'projects')
    mkdirSync(parent)
    const inParent = await call(tools().create, { name: 'notes-door', parentDir: parent })
    assert.equal(structured(inParent).folder, join(parent, 'notes-door'))
  })

  test('never writes over anything, and hands an existing extension back as it is', async () => {
    const t = tools()
    const taken = join(work, 'taken')
    mkdirSync(taken)
    writeFileSync(join(taken, 'notes.txt'), 'mine')
    assert.equal(errorCode(await call(t.create, { name: 'taken', folder: taken })), 'dir_not_empty')
    assert.equal(readFileSync(join(taken, 'notes.txt'), 'utf8'), 'mine')

    const folder = join(work, 'weather')
    assert.equal((await call(t.create, { name: 'weather', folder })).isError, undefined)
    writeFileSync(join(folder, 'IDEA.md'), 'my edits')
    const again = await call(t.create, { name: 'weather', folder, brief: 'something else' })
    assert.equal(again.isError, undefined)
    assert.equal(structured(again).existing, true)
    assert.equal(readFileSync(join(folder, 'IDEA.md'), 'utf8'), 'my edits', 'carried on, not rewritten')

    mkdirSync(join(work, 'installed-modules', 'deck'), { recursive: true })
    assert.equal(errorCode(await call(t.create, { name: 'deck' })), 'installed', 'an installed id is not reused')
  })

  test('refuses names, paths and options it cannot use, before writing', async () => {
    const t = tools()
    const refused: Array<[Record<string, unknown>, string]> = [
      [{}, 'invalid_arguments'],
      [{ name: 'PR Radar' }, 'invalid_name'],
      [{ name: 'backlog' }, 'invalid_name'],
      [{ name: 'radar', folder: 'relative/radar' }, 'invalid_arguments'],
      [{ name: 'radar', parentDir: '~/code' }, 'invalid_arguments'],
      [{ name: 'radar', folder: join(work, 'a'), parentDir: work }, 'invalid_arguments'],
      [{ name: 'radar', template: 'nope' }, 'invalid_arguments'],
      [{ name: 'radar', parts: ['nope'] }, 'invalid_arguments'],
      [{ name: 'radar', folder: join(work, 'missing', 'radar') }, 'no_parent'],
    ]
    for (const [args, code] of refused) {
      assert.equal(errorCode(await call(t.create, args)), code, JSON.stringify(args))
    }
    assert.equal(existsSync(home), false, 'nothing was made')
  })

  test('offers exactly the scaffolder’s templates and parts', () => {
    assert.deepEqual(
      [...EXTENSION_TEMPLATE_IDS],
      listModuleTemplates(join(SDK, 'templates')).map((template) => template.id),
    )
    assert.deepEqual(
      [...EXTENSION_PART_IDS],
      listModuleParts(join(SDK, 'templates')).map((part) => part.id),
    )
  })
})

describe('extension.guide', () => {
  test('lists the topics, reads one, and refuses anything else', async () => {
    const t = tools()
    const index = await call(t.guide, {})
    assert.deepEqual(
      (structured(index).topics as Array<{ id: string }>).map((topic) => topic.id),
      EXTENSION_GUIDE_TOPICS.map((topic) => topic.id),
    )
    for (const { id } of EXTENSION_GUIDE_TOPICS) {
      const topic = await call(t.guide, { topic: id })
      assert.equal(topic.isError, undefined, id)
      assert.equal(
        topic.content[0]?.type === 'text' && topic.content[0].text,
        readFileSync(join(SDK, 'guide', `${id}.md`), 'utf8'),
      )
    }
    assert.equal(errorCode(await call(t.guide, { topic: '../package' })), 'unknown_topic')
    assert.equal(errorCode(await call(tools(join(work, 'nowhere')).guide, { topic: 'start' })), 'guide_unavailable')
  })
})

test('the family is served on this machine only, and making a project is audited as a change', () => {
  assert.ok(localOnlyGatewayToolReason('extension.create'))
  assert.ok(localOnlyGatewayToolReason('extension.guide'))
  assert.equal(isStudioGatewayMutation('extension.create'), true)
  assert.equal(isStudioGatewayMutation('extension.guide'), false)
})
