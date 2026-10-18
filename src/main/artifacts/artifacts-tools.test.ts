import assert from 'node:assert/strict'
import { test } from 'vitest'

import { localOnlyGatewayToolReason, requiredScopeForTool } from '../automation/tailnet/tailnet-scopes'
import { isStudioGatewayMutation } from '../automation/studio-gateway-tools'
import type { ArtifactsService } from './artifacts-service'
import { createArtifactsTools } from './artifacts-tools'

/** A service that records what it was asked and answers ok. */
function recordingService() {
  const calls: Array<[string, unknown]> = []
  const answer = (name: string) => async (input: unknown) => {
    calls.push([name, input])
    return { ok: true as const, echoed: input }
  }
  const service = {
    publish: answer('publish'),
    update: answer('update'),
    remove: answer('remove'),
    list: answer('list'),
    get: answer('get'),
  } as unknown as ArtifactsService
  return { service, calls }
}

function tool(name: string, service: ArtifactsService) {
  const found = createArtifactsTools({ service }).find((registration) => registration.name === name)
  assert.ok(found, name)
  return found
}

function errorOf(result: Awaited<ReturnType<ReturnType<typeof tool>['handler']>>): string | null {
  const structured = result.structuredContent as { ok?: boolean; error?: { code: string } } | undefined
  return result.isError ? (structured?.error?.code ?? 'error') : null
}

test('the family is publish, list, search, get, update and delete, and only the writes mutate', () => {
  const { service } = recordingService()
  const tools = createArtifactsTools({ service })
  assert.deepEqual(
    tools.map((registration) => [registration.name, registration.mutates === true]),
    [
      ['artifacts.publish', true],
      ['artifacts.list', false],
      ['artifacts.search', false],
      ['artifacts.get', false],
      ['artifacts.update', true],
      ['artifacts.delete', true],
    ],
  )
  for (const registration of tools) assert.match(registration.description, /Settings ▸ Artifacts/)
})

test('a publish needs an absolute path and a title, and checks every field it is given', async () => {
  const { service, calls } = recordingService()
  const publish = tool('artifacts.publish', service)
  const refused: Array<Record<string, unknown>> = [
    {},
    { path: 'relative/page.html', title: 'x' },
    { path: '/Users/dev/p.html' },
    { path: '/Users/dev/p.html', title: '   ' },
    { path: '/Users/dev/p.html', title: 'x', tags: 'mockup' },
    { path: '/Users/dev/p.html', title: 'x', tags: [1] },
    { path: '/Users/dev/p.html', title: 'x', commit: 'not-a-sha' },
    { path: '/Users/dev/p.html', title: 'x', slug: '../escape' },
    { path: '/Users/dev/p.html', title: 'x', entry: '../outside.html' },
    { path: '/Users/dev/p.html', title: 'x', stylesheets: ['fonts.css'] },
    { path: '/Users/dev/p.html', title: 'x', thumbnail: 'thumb.png' },
    { path: '/Users/dev/p.html', title: 'x'.repeat(201) },
    { path: '/Users/dev/p\0.html', title: 'x' },
  ]
  for (const args of refused)
    assert.equal(errorOf(await publish.handler(args)), 'invalid_arguments', JSON.stringify(args))
  assert.equal(calls.length, 0)
  const ok = await publish.handler({ path: '/Users/dev/p.html', title: ' Stars ', tags: ['mockup'], commit: 'B004AD8' })
  assert.equal(errorOf(ok), null)
  assert.deepEqual(calls[0], [
    'publish',
    {
      path: '/Users/dev/p.html',
      title: 'Stars',
      tags: ['mockup'],
      commit: 'B004AD8',
      entry: undefined,
      stylesheets: undefined,
      description: undefined,
      project: undefined,
      repo: undefined,
      branch: undefined,
      thumbnail: undefined,
    },
  ])
})

test('search needs words; list and search take a limit from 1 to 200', async () => {
  const { service, calls } = recordingService()
  assert.equal(errorOf(await tool('artifacts.search', service).handler({})), 'invalid_arguments')
  assert.equal(errorOf(await tool('artifacts.search', service).handler({ query: '  ' })), 'invalid_arguments')
  for (const limit of [0, 201, 1.5, '10']) {
    assert.equal(errorOf(await tool('artifacts.list', service).handler({ limit })), 'invalid_arguments', String(limit))
  }
  assert.equal(
    errorOf(await tool('artifacts.search', service).handler({ query: 'stars', tags: ['mockup'], limit: 5 })),
    null,
  )
  assert.deepEqual(calls, [['list', { query: 'stars', tags: ['mockup'], limit: 5 }]])
})

test('get, update and delete take only a slug that names a folder of the site', async () => {
  const { service, calls } = recordingService()
  for (const name of ['artifacts.get', 'artifacts.update', 'artifacts.delete']) {
    for (const slug of [undefined, '', '..', '../x', 'a/b', 'A', 'x'.repeat(65)]) {
      assert.equal(errorOf(await tool(name, service).handler({ slug })), 'invalid_arguments', `${name} ${String(slug)}`)
    }
  }
  assert.equal(calls.length, 0)
  assert.equal(errorOf(await tool('artifacts.delete', service).handler({ slug: 'your-stars' })), null)
  assert.deepEqual(calls, [['remove', 'your-stars']])
})

test('a service failure is the tool’s error, with its code and message', async () => {
  const service = {
    list: async () => ({ ok: false, code: 'not_configured', message: 'Choose a host on Settings ▸ Artifacts.' }),
  } as unknown as ArtifactsService
  const result = await tool('artifacts.list', service).handler({})
  assert.equal(errorOf(result), 'not_configured')
  assert.match(result.content[0]?.type === 'text' ? result.content[0].text : '', /Settings ▸ Artifacts/)
})

test('a paired device may read artifacts, but publishing, changing and removing stay on this machine', () => {
  for (const name of ['artifacts.publish', 'artifacts.update', 'artifacts.delete']) {
    assert.ok(localOnlyGatewayToolReason(name), name)
    assert.equal(isStudioGatewayMutation(name), true, name)
  }
  for (const name of ['artifacts.list', 'artifacts.search', 'artifacts.get']) {
    assert.equal(localOnlyGatewayToolReason(name), null, name)
    assert.equal(requiredScopeForTool(name, isStudioGatewayMutation(name)), 'workspace:read', name)
  }
})
