// `@sprintengine/module-sdk/testing`: the fake hosts hold a module to the
// host's rules, and the pass-through kit renders a door in Node.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildSync } from 'esbuild'
import { createElement, lazy } from 'react'
import { describe, test } from 'vitest'

import { getActivityService, getUsageService } from '../src/activity.js'
import { getBacklogService } from '../src/backlog.js'
import { getConversationService, getTextGenerationService } from '../src/conversation.js'
import { getGitHubService, getSecretsService } from '../src/brokers.js'
import {
  getCompanionAgentsService,
  getModuleStorage,
  getScheduledAgentsService,
  WorkspaceContextToken,
  WorkspaceServiceToken,
  type ScheduledAgentDraft,
} from '../src/index.js'
import { MODULE_SERVICE_REQUIREMENTS } from '../src/services.js'
import { createFakeMainHost, createFakeRendererHost, renderToHtml } from '../src/testing.js'
import { SERVICE_FAKES } from '../src/testing-services.js'
import * as kit from '../src/testing-kit.js'

const ROOT = '/Users/dev/projects/app'

describe('createFakeMainHost', () => {
  test('has a fake for every service the SDK publishes, and nothing else', () => {
    assert.deepEqual(
      Object.keys(SERVICE_FAKES).sort(),
      MODULE_SERVICE_REQUIREMENTS.map((requirement) => requirement.key).sort(),
    )
  })

  test('storage applies the host’s key pattern, root rule and 1 MB cap', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['storage'], storage: { global: { seeded: 1 } } })
    const storage = getModuleStorage(fake.host)
    assert.deepEqual(await storage.get({ key: 'seeded' }), { ok: true, value: 1, found: true })
    assert.equal((await storage.get({ key: 'Bad Key' })).ok, false)
    assert.equal(((await storage.set({ key: 'Bad Key', value: 1 })) as { code?: string }).code, 'invalid_key')
    assert.equal(((await storage.set({ key: 'con', value: 1 })) as { code?: string }).code, 'invalid_key')
    assert.equal(
      ((await storage.set({ key: 'a', value: 1, workspaceRoot: 'relative/root' })) as { code?: string }).code,
      'invalid_workspace_root',
    )
    assert.equal(
      ((await storage.set({ key: 'big', value: 'x'.repeat(1024 * 1024) })) as { code?: string }).code,
      'value_too_large',
    )
    assert.equal(((await storage.set({ key: 'undef', value: undefined })) as { code?: string }).code, 'invalid_value')

    const value = { list: [1, 2] }
    assert.deepEqual(await storage.set({ key: 'doc', value, workspaceRoot: ROOT }), { ok: true })
    value.list.push(3)
    assert.deepEqual(fake.services.storage.peek('doc', ROOT), { list: [1, 2] }, 'stored as JSON, not by reference')
    assert.deepEqual(await storage.list({ workspaceRoot: ROOT }), { ok: true, keys: ['doc'] })
    assert.deepEqual(await storage.list(), { ok: true, keys: ['seeded'] }, 'the global store is its own scope')
    assert.deepEqual(await storage.delete({ key: 'doc', workspaceRoot: ROOT }), { ok: true, deleted: true })
    assert.deepEqual(fake.undeclared, [])
  })

  test('a service used without its permission is reported, and the host’s checked ones refuse', async () => {
    const fake = createFakeMainHost({ moduleId: 'quiet', permissions: [] })
    getModuleStorage(fake.host)
    assert.deepEqual(fake.undeclared, [{ what: 'core.module-storage', needs: ['storage'], checked: false }])

    const conversations = getConversationService(fake.host)
    const created = await conversations.create({ workspaceId: 'ws-app' })
    assert.equal(created.ok, false)
    assert.equal(!created.ok && created.code, 'permission_missing')
    assert.throws(() => conversations.list(), /must declare the "conversation:read" permission/)

    const github = await getGitHubService(fake.host).request({ route: '/user' })
    assert.equal(!github.ok && github.code, 'permission_missing')
    const secret = await getSecretsService(fake.host).set('key', 'v', { allowedOrigins: ['https://api.example.com'] })
    assert.equal(!secret.ok && secret.code, 'permission_missing')
    assert.throws(
      () =>
        getCompanionAgentsService(fake.host).attach({
          workspaceId: 'ws-app',
          agentId: 'guide',
          name: 'Guide',
          workspaceRoot: ROOT,
          systemPrompt: 'Help.',
        }),
      /must declare the "agents:companion" permission/,
    )
  })

  test('only published services resolve, and a removed provider throws as the host does', () => {
    const fake = createFakeMainHost({ moduleId: 'notes', services: { 'github.module-service': null } })
    assert.throws(
      () => fake.host.requireService({ key: 'core.terminal-runtime' }),
      /Service "core.terminal-runtime" is not available to third-party modules/,
    )
    assert.throws(
      () => fake.host.requireService({ key: 'github.module-service' }),
      /requires service "github.module-service", which no enabled module provides/,
    )
    assert.equal(fake.host.getService({ key: 'github.module-service' }), undefined)
    const own = fake.host.provideService({ key: 'notes.index' }, () => ({ size: 3 }))
    assert.equal(fake.host.requireService({ key: 'notes.index' }), own)
  })

  test('the bridge reaches own channels only, with module:bridge, and clones like IPC', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: [] })
    fake.host.registerIpc('notes:echo', (_event, payload) => ({ got: payload }))
    await assert.rejects(fake.ipc.invoke('other:echo'), /may only invoke its own channels/)
    await assert.rejects(
      fake.ipc.invoke('notes:missing'),
      (error: Error & { code?: string }) => error.code === 'unknown_channel',
    )
    await assert.rejects(
      fake.ipc.invoke('notes:echo', 1),
      (error: Error & { code?: string }) => error.code === 'permission_missing' && /module:bridge/.test(error.message),
    )
    fake.permissions.add('module:bridge')
    assert.deepEqual(await fake.ipc.invoke('notes:echo', { a: 1 }), { got: { a: 1 } })
    fake.permissions.delete('module:bridge')
    fake.permissions.add('ipc:invoke')
    assert.deepEqual(await fake.ipc.invoke('notes:echo', 2), { got: 2 }, 'the broad legacy scope still opens it')
    fake.host.registerIpc('notes:fn', () => ({ run() {} }))
    await assert.rejects(fake.ipc.invoke('notes:fn'), /could not be cloned/, 'a result IPC cannot carry fails')
  })

  test('MCP tools need mcp:tools, and a call reaches the handler with agent metadata', async () => {
    const tools = [
      {
        name: 'notes_count',
        description: 'Count notes',
        inputSchema: { type: 'object' },
        mutates: false,
        handler: async (args: Record<string, unknown>, context?: { metadata: { workspaceId?: string } }) => ({
          content: [{ type: 'text' as const, text: `${String(args.prefix)}:${context?.metadata.workspaceId}` }],
        }),
      },
    ]
    assert.throws(
      () => createFakeMainHost({ moduleId: 'notes' }).host.registerMcpTools(tools),
      /must declare the "mcp:tools" permission/,
    )
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['mcp:tools'] })
    fake.host.registerMcpTools(tools)
    assert.deepEqual(await fake.tools.call('notes_count', { prefix: 'n' }), {
      content: [{ type: 'text', text: 'n:ws-app' }],
    })
    await assert.rejects(fake.tools.call('nope'), /No MCP tool "nope"/)
  })

  test('conversations: owned chats, events, presets capped, retries answered once', async () => {
    const fake = createFakeMainHost({ moduleId: 'board', permissions: ['conversation:operate'] })
    const chats = getConversationService(fake.host)
    const lists: number[] = []
    chats.watch(undefined, (list) => lists.push(list.length))

    const missing = await chats.create({ workspaceId: 'nowhere' })
    assert.equal(!missing.ok && missing.code, 'unknown_workspace')
    const created = await chats.create({
      workspaceId: 'ws-app',
      prompt: 'Plan it',
      permissionPreset: 'bypass',
      commandId: 'c1',
    })
    assert.ok(created.ok)
    const again = await chats.create({ workspaceId: 'ws-app', prompt: 'Plan it', commandId: 'c1' })
    assert.ok(
      again.ok && again.conversation.agentId === created.conversation.agentId,
      'a retried create finds the first chat',
    )
    assert.equal(created.conversation.permissionPreset, 'auto', 'bypass is lowered to the auto ceiling')

    const ref = { workspaceId: created.conversation.workspaceId, agentId: created.conversation.agentId }
    const seen: string[] = []
    chats.subscribe(ref, (event) => seen.push(event.type))
    fake.services.conversations.emitEvent(ref, { type: 'turn_started' })
    fake.services.conversations.emitEvent(ref, { type: 'content_delta', payload: { text: 'Done' } })
    fake.services.conversations.emitEvent(ref, { type: 'turn_completed' })
    assert.deepEqual(seen, ['turn_started', 'content_delta', 'turn_completed'])
    assert.equal(chats.list()[0]?.status, 'ready')
    const transcript = await chats.transcript(ref)
    assert.ok(transcript.ok)
    assert.deepEqual(
      transcript.events.map((event) => event.type),
      ['session_started', 'user_message', 'turn_started', 'content_delta', 'turn_completed'],
    )
    assert.ok(lists.length >= 3, 'watchers hear creates and status changes')

    const frames: string[] = []
    chats.follow(ref, { afterSeq: 3 }, (frame) => frames.push(frame.type))
    assert.deepEqual(frames, ['event', 'event', 'synchronized'], 'a known cursor gets only what came after it')

    fake.services.conversations.addForeign({ workspaceId: 'ws-app', agentId: 'person-chat' })
    const overheard: string[] = []
    chats.subscribe({ workspaceId: 'ws-app', agentId: 'person-chat' }, (event) => overheard.push(event.type))
    assert.throws(
      () =>
        fake.services.conversations.emitEvent(
          { workspaceId: 'ws-app', agentId: 'person-chat' },
          { type: 'turn_started' },
        ),
      /not the module's own/,
    )
    assert.deepEqual(overheard, [], 'a chat the module does not own delivers nothing')
    assert.throws(
      () => chats.subscribe({ workspaceId: '', agentId: 'x' }, () => {}),
      /needs a workspaceId and an agentId/,
    )
    const foreignSend = await chats.send({ workspaceId: 'ws-app', agentId: 'person-chat' }, { message: 'hi' })
    assert.equal(!foreignSend.ok && foreignSend.code, 'not_owned')

    assert.deepEqual(await chats.send(ref, { message: 'And then?' }), { ok: true })
    assert.deepEqual(fake.services.conversations.get(ref)?.sent, ['And then?'])
    fake.services.conversations.failNextCreate('no_cli_selected')
    const refused = await chats.create({ workspaceId: 'ws-app' })
    assert.equal(!refused.ok && refused.code, 'no_cli_selected')
  })

  test('scheduled agents: owned, validated, fired, and a one-time schedule closes after its run', async () => {
    let clock = Date.parse('2026-10-09T10:00:00Z')
    const fake = createFakeMainHost({ moduleId: 'board', permissions: ['scheduled-agents.manage'], now: () => clock })
    const scheduled = getScheduledAgentsService(fake.host)
    const changes: number[] = []
    scheduled.onChanged((agents) => changes.push(agents.length))
    const draft: ScheduledAgentDraft = {
      prompt: 'Standup',
      schedule: { cron: '0 9 * * 1-5', timezone: 'UTC' },
      folderPath: ROOT,
      hostId: 'local',
      cli: 'claude',
      cliModel: null,
      permissionPreset: null,
      skills: [],
      mcpServers: [],
      worktree: null,
    }
    const created = await scheduled.create(draft)
    assert.ok(created.ok && created.agent.ownerModuleId === 'board')
    const past = await scheduled.create({ ...draft, schedule: { ...draft.schedule, once: clock - 1 } })
    assert.deepEqual(past, { ok: false, message: 'That time has already passed.' })
    const once = await scheduled.create({ ...draft, schedule: { ...draft.schedule, once: clock + 60_000 } })
    assert.ok(once.ok)
    clock += 60_000
    const run = fake.services.scheduledAgents.fire(once.agent.id)
    assert.ok(run.ok)
    assert.deepEqual(
      (await scheduled.list()).map((agent) => agent.id),
      [created.agent.id],
    )
    assert.deepEqual(changes, [1, 2, 1])
    assert.deepEqual(await scheduled.remove('scheduled-99'), {
      ok: false,
      message: 'No scheduled agent "scheduled-99".',
    })
  })

  test('secrets go only to their origins over https, and an echoed value comes back redacted', async () => {
    const fake = createFakeMainHost({ moduleId: 'radar', permissions: ['secrets'] })
    const secrets = getSecretsService(fake.host)
    const http = await secrets.set('token', 'abc', { allowedOrigins: ['http://api.example.com'] })
    assert.equal(!http.ok && http.code, 'origin_not_allowed')
    assert.deepEqual(await secrets.set('token', 'abc', { allowedOrigins: ['https://api.example.com'] }), { ok: true })
    assert.equal(await secrets.has('token'), true)
    fake.services.secrets.respond((request) => ({ status: 200, body: `you sent ${request.headers.Authorization}` }))
    const elsewhere = await secrets.fetchWithSecret('token', 'https://evil.example/x', {
      placement: { header: 'Authorization' },
    })
    assert.equal(!elsewhere.ok && elsewhere.code, 'origin_not_allowed')
    const sent = await secrets.fetchWithSecret('token', 'https://api.example.com/me', {
      placement: { header: 'Authorization', scheme: 'Bearer' },
    })
    assert.deepEqual(sent, { ok: true, status: 200, headers: {}, body: 'you sent Bearer [redacted]' })
    assert.equal(fake.services.secrets.requests[0]?.headers.Authorization, 'Bearer abc')
  })

  test('GitHub answers what was scripted, 404 otherwise, and not_signed_in when signed out', async () => {
    const fake = createFakeMainHost({ moduleId: 'radar', permissions: ['github'] })
    const github = getGitHubService(fake.host)
    fake.services.github.respond('GET', '/repos/{owner}/{repo}/pulls', { ok: true, status: 200, data: [{ number: 1 }] })
    assert.deepEqual(
      await github.request({ route: '/repos/{owner}/{repo}/pulls', params: { owner: 'acme', repo: 'app' } }),
      {
        ok: true,
        status: 200,
        data: [{ number: 1 }],
        headers: {},
      },
    )
    const unscripted = await github.request({ route: '/user' })
    assert.equal(!unscripted.ok && unscripted.status, 404)
    fake.services.github.setSignedIn(false)
    const signedOut = await github.request({ route: '/repos/{owner}/{repo}/pulls' })
    assert.equal(!signedOut.ok && signedOut.code, 'not_signed_in')
    assert.deepEqual(await github.status(), { signedIn: false })
  })

  test('companions attach once per id and retry an invalid structured answer', async () => {
    const fake = createFakeMainHost({ moduleId: 'review', permissions: ['agents:companion'] })
    const companions = getCompanionAgentsService(fake.host)
    const spec = { workspaceId: 'ws-app', agentId: 'guide', name: 'Guide', workspaceRoot: ROOT, systemPrompt: 'Help.' }
    const handle = companions.attach(spec)
    assert.equal(companions.attach(spec), handle)
    assert.equal(handle.status(), 'absent', 'attach never spawns')
    fake.services.companions.respond(({ attempt }) => (attempt === 0 ? { wrong: true } : { score: 3 }))
    const score = await handle.runStructured({
      prompt: 'Rate it',
      validate: (raw) =>
        typeof (raw as { score?: unknown }).score === 'number'
          ? { ok: true, value: (raw as { score: number }).score }
          : { ok: false, errors: ['score must be a number'] },
    })
    assert.equal(score, 3)
    assert.equal(fake.services.companions.prompts.length, 2)
  })

  test('workspaces answer null before hydration, as after launch', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['ipc:workspace-read', 'ipc:workspace-write'] })
    const context = fake.host.requireService(WorkspaceContextToken)
    fake.services.workspaces.setHydrated(false)
    assert.equal(await context.get('ws-app'), null)
    fake.services.workspaces.setHydrated(true)
    assert.equal((await context.get('ws-app'))?.folderPath, ROOT)
    const created = await fake.host
      .requireService(WorkspaceServiceToken)
      .create({ name: 'Docs', folderPath: '/Users/dev/docs' })
    assert.ok(created.ok)
    assert.equal((await context.list()).length, 2)
  })

  test('notify and emit are validated as the host validates them; hooks run in order', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes' })
    fake.host.notify({ severity: 'info', title: '  Saved  ' })
    assert.deepEqual(fake.notifications, [{ severity: 'info', title: 'Saved' }])
    assert.throws(() => fake.host.notify({ severity: 'loud' as never, title: 'x' }), /severity/)
    assert.throws(() => fake.host.emit(''), /needs a topic/)
    assert.throws(() => fake.host.emit('changed', { fn() {} }), /could not be cloned/)
    fake.host.emit('changed', { id: 1 })
    assert.deepEqual(fake.emitted, [{ topic: 'changed', payload: { id: 1 } }])
    const order: string[] = []
    fake.host.onShutdown(() => void order.push('shutdown-1'))
    fake.host.onShutdown(() => void order.push('shutdown-2'))
    fake.host.onShutdownBegin(() => void order.push('begin'))
    fake.host.onStartup(() => void order.push('startup'))
    await fake.startup()
    await fake.shutdown()
    assert.deepEqual(order, ['startup', 'begin', 'shutdown-2', 'shutdown-1'])
  })
})

describe('createFakeRendererHost', () => {
  test('records registrations, renders a door with the kit, and bridges to the main fake', async () => {
    const main = createFakeMainHost({ moduleId: 'notes', permissions: ['module:bridge', 'conversation:operate'] })
    main.host.registerIpc('notes:list', () => ['First note'])
    const renderer = createFakeRendererHost({ main })
    const Door = () =>
      createElement(
        kit.GlobalSurfaceShell,
        { ariaLabel: 'Notes', bar: { title: 'Notes' } },
        createElement(kit.SurfaceCanvasState, { kind: 'empty', glyph: null, title: 'Nothing yet' }),
      )
    renderer.host.registerGlobalSurface({
      id: 'notes',
      label: 'Notes',
      Component: lazy(async () => ({ default: Door })),
    })
    renderer.host.registerCommand({
      id: 'notes.open',
      title: 'Open notes',
      category: 'Notes',
      scopes: ['global'],
      run() {
        renderer.host.openGlobalSurface('notes')
      },
    })

    const html = await renderer.render.surface('notes')
    assert.match(html, /data-kit="GlobalSurfaceShell"/)
    assert.match(html, /Nothing yet/)
    await renderer.runCommand('notes.open')
    assert.deepEqual(renderer.openedSurfaces, [{ kind: 'global', id: 'notes' }])

    assert.deepEqual(await renderer.host.invoke('notes:list'), ['First note'])
    const heard: unknown[] = []
    renderer.host.subscribe('changed', (payload) => heard.push(payload))
    main.host.emit('changed', { id: 2 })
    assert.deepEqual(heard, [{ id: 2 }])

    const opened = await renderer.host.openChat({ workspaceId: 'ws-app', prompt: 'Draft', send: false })
    assert.ok(opened.ok)
    assert.equal(main.services.conversations.all().length, 1, 'an openChat chat is the module’s own')
  })

  test('a component that throws fails the render', async () => {
    const renderer = createFakeRendererHost({ moduleId: 'notes' })
    renderer.host.registerTopBarItem({
      id: 'timer',
      order: 1,
      Component: () => {
        throw new Error('timer exploded')
      },
    })
    await assert.rejects(renderer.render.topBar('timer'), /timer exploded/)
  })

  test('disclosure permissions used without being declared are reported', async () => {
    const renderer = createFakeRendererHost({ moduleId: 'notes', permissions: [] })
    await renderer.host.listWorkspaces()
    renderer.host.setModuleAppState('draft', 'x')
    const chat = await renderer.host.openChat({ workspaceId: 'ws-app' })
    assert.equal(!chat.ok && chat.code, 'permission_missing')
    assert.deepEqual(
      renderer.undeclared.map((use) => [use.what, use.checked]),
      [
        ['listWorkspaces', false],
        ['setModuleAppState', false],
        ['openChat', true],
      ],
    )
  })
})

describe('the pass-through kit', () => {
  test('draws text props, elements, nested rows, and nothing for a closed drawer', async () => {
    const html = await renderToHtml(
      createElement(
        'main',
        null,
        createElement(kit.EmptyState, { title: 'No boards', body: createElement('em', null, 'Make one') }),
        createElement(kit.SurfaceRail, {
          label: 'Boards',
          rows: [{ id: 'a', title: 'Alpha', stateLine: 'Open' }],
          selectedId: null,
          onSelect() {},
          newAffordance: { label: 'New board', onActivate() {} },
        }),
        createElement(kit.Drawer, { open: false, onClose() {}, title: 'Hidden', ariaLabel: 'Hidden' }, 'secret'),
      ),
    )
    assert.match(html, /No boards/)
    assert.match(html, /<em>Make one<\/em>/)
    assert.match(html, /Alpha/)
    assert.match(html, /New board/)
    assert.doesNotMatch(html, /secret/)
  })

  test('installTestingKit routes the host-provided specifiers, so a built bundle renders in Node', () => {
    // Built the way the package ships (ESM beside each other), into the repo
    // so `react` resolves from its node_modules, and run in a child process
    // so the resolve hook does not outlive the test.
    const out = join(process.cwd(), 'node_modules', '.cache', 'sprintengine', 'testing-kit-check')
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    const sdk = join(process.cwd(), 'packages', 'module-sdk', 'src')
    buildSync({
      entryPoints: [join(sdk, 'testing.ts'), join(sdk, 'testing-kit.ts')],
      outdir: out,
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'node',
      packages: 'external',
      outExtension: { '.js': '.js' },
      logLevel: 'silent',
    })
    writeFileSync(join(out, 'package.json'), '{"type":"module"}\n')
    writeFileSync(
      join(out, 'door.mjs'),
      [
        "import { createElement } from 'react'",
        "import { EmptyState } from '@sprintengine/module-sdk/ui'",
        "import { GlobalSurfaceShell } from '@sprintengine/module-sdk/surface'",
        'export const Door = () => createElement(GlobalSurfaceShell, { ariaLabel: "Door" }, createElement(EmptyState, { title: "Rendered in Node" }))',
      ].join('\n'),
    )
    writeFileSync(
      join(out, 'run.mjs'),
      [
        "import { createElement } from 'react'",
        "import { installTestingKit, renderToHtml } from './testing.js'",
        'installTestingKit()',
        "const { Door } = await import('./door.mjs')",
        'console.log(await renderToHtml(createElement(Door)))',
      ].join('\n'),
    )
    const run = spawnSync(process.execPath, [join(out, 'run.mjs')], { encoding: 'utf8' })
    rmSync(out, { recursive: true, force: true })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /data-kit="GlobalSurfaceShell"/)
    assert.match(run.stdout, /Rendered in Node/)
  })
})

describe('createFakeMainHost: Backlog, usage and activity', () => {
  test('the Backlog checks backlog.read and backlog.write, validates as the host does, and is shared with the renderer', async () => {
    const main = createFakeMainHost({ moduleId: 'board', permissions: ['backlog.read'] })
    const backlog = getBacklogService(main.host)
    const refused = await backlog.create('ws-app', { title: 'Ship it' })
    assert.equal(!refused.ok && refused.code, 'permission_missing')
    main.permissions.add('backlog.write')

    main.services.backlog.setKey('ws-app', 'MC')
    const created = await backlog.create('ws-app', { title: 'Ship it', body: 'Before Friday.', type: 'feature' })
    assert.ok(created.ok)
    assert.equal(created.id, 'backlog/ship-it.md')
    assert.equal(created.displayId, 'MC-1')
    assert.equal(created.path, `${ROOT}/backlog/ship-it.md`)
    const invalid = await backlog.create('ws-app', { title: 'x', type: 'chore' })
    assert.equal(!invalid.ok && invalid.code, 'invalid_input')
    const unknown = await backlog.create('nowhere', { title: 'x' })
    assert.equal(!unknown.ok && unknown.code, 'unknown_workspace')

    const renderer = createFakeRendererHost({ main })
    const seen: number[] = []
    renderer.host.watchBacklogItems('ws-app', (items) => seen.push(items.length))
    const fromWindow = await renderer.host.createBacklogItem('ws-app', { title: 'From the window' })
    assert.ok(fromWindow.ok && fromWindow.numericId === 2)
    assert.deepEqual(await backlog.updateStatus('ws-app', created.id, 'ready'), { ok: true })
    assert.equal((await backlog.updateStatus('ws-app', 'backlog/nope.md', 'ready')).ok, false)
    assert.deepEqual(
      await backlog.addLink('ws-app', created.id, {
        id: 'pr-1',
        type: 'review',
        label: 'PR #1',
        target: { kind: 'pull-request', id: '1' },
      }),
      { ok: true },
    )
    const foreign = await backlog.addLink('ws-app', created.id, {
      id: 'x',
      moduleId: 'someone-else',
      type: 'review',
      label: 'x',
      target: { kind: 'x', id: 'x' },
    })
    assert.equal(!foreign.ok && foreign.code, 'invalid_input')
    assert.deepEqual(await backlog.updateModuleMetadata('ws-app', created.id, { lane: 2 }), { ok: true })
    assert.deepEqual(await backlog.updateTriage('ws-app', created.id, { difficulty: 'm', risk: null }), { ok: true })

    const [item] = (await renderer.host.listBacklogItems('ws-app')).filter((entry) => entry.id === created.id)
    assert.equal(item?.status, 'ready')
    assert.equal(item?.difficulty, 'm')
    assert.deepEqual(item?.metadata, { board: { lane: 2 } })
    assert.equal(item?.links[0]?.moduleId, 'board', 'the host stamps the owner')
    assert.match(item?.sourceContent ?? '', /status: ready/)
    assert.deepEqual(seen, [1, 2, 2, 2, 2, 2], 'the watch heard every change')

    main.permissions.delete('backlog.read')
    await assert.rejects(renderer.host.listBacklogItems('ws-app'), /"backlog.read" permission/)
    assert.throws(() => renderer.host.watchBacklogItems('ws-app', () => {}), /"backlog.read" permission/)
  })

  test('a Backlog watch hears why it cannot deliver, and stays open', () => {
    const renderer = createFakeRendererHost({
      moduleId: 'board',
      permissions: ['backlog.read'],
      workspaces: [
        { id: 'ws-app', name: 'App', folderPath: ROOT, mode: 'standard' },
        { id: 'ws-scratch', name: 'Scratch', folderPath: null, mode: 'standard' },
      ],
      backlogItems: { 'ws-app': [{ title: 'Seeded' }] },
    })
    const errors: string[] = []
    const counts: number[] = []
    renderer.host.watchBacklogItems('ws-scratch', () => {}, { onError: (error) => errors.push(error.code) })
    renderer.host.watchBacklogItems('ws-app', (items) => counts.push(items.length), {
      onError: (error) => errors.push(error.code),
    })
    renderer.services.backlog.failScan('ws-app', 'backlog/broken.md: bad frontmatter')
    renderer.services.backlog.failScan('ws-app', null)
    assert.deepEqual(errors, ['workspace_folder_missing', 'scan_failed'])
    assert.deepEqual(counts, [1, 1])
  })

  test('usage sums what was recorded over the window and the dimensions asked for, behind usage:read', async () => {
    const hour = Date.parse('2026-10-09T09:00:00Z')
    const main = createFakeMainHost({ moduleId: 'meter', permissions: [] })
    const usage = getUsageService(main.host)
    const refused = await usage.query({ from: hour, to: hour + 3_600_000 })
    assert.equal(!refused.ok && refused.code, 'permission_missing')
    assert.throws(() => usage.onChanged(() => {}), /"usage:read" permission/)
    main.permissions.add('usage:read')

    let changes = 0
    usage.onChanged(() => (changes += 1))
    main.services.usage.record(
      { at: hour + 60_000, model: 'opus', tokens: { input: 10, output: 5 } },
      { at: hour + 120_000, model: 'opus', tokens: { input: 1 }, reportedCostUsd: 0.5 },
      { at: hour + 60_000, model: 'haiku', tokens: { output: 2 } },
      { at: hour + 7_200_000, model: 'opus', tokens: { input: 100 } },
    )
    assert.equal(changes, 1)
    const byModel = await usage.query({ from: hour, to: hour + 3_600_000, groupBy: ['model'] })
    assert.ok(byModel.ok)
    assert.deepEqual(
      byModel.rows.map((row) => [row.model, row.tokens.input + row.tokens.output, row.requests, row.reportedCostUsd]),
      [
        ['opus', 16, 2, 0.5],
        ['haiku', 2, 1, null],
      ],
    )
    const backwards = await usage.query({ from: hour, to: hour })
    assert.equal(!backwards.ok && backwards.code, 'invalid_input')
    const renderer = createFakeRendererHost({ main })
    const total = await renderer.host.queryUsage({ from: hour, to: hour + 10_800_000 })
    assert.ok(total.ok && total.rows.length === 1 && total.rows[0]?.tokens.input === 111)
  })

  test('activity lists the chats of open workspaces and the prompts in a window, newest kept', async () => {
    const main = createFakeMainHost({ moduleId: 'standup', permissions: ['conversation:read-all'] })
    const activity = getActivityService(main.host)
    main.services.activity.addChat({ workspaceId: 'ws-app', agentId: 'a1', title: 'Plan', updatedAt: 200 })
    main.services.activity.addChat({ workspaceId: 'ws-gone', agentId: 'a2', title: 'Closed' })
    for (const at of [100, 150, 300]) {
      main.services.activity.addPrompt({ at, workspaceId: 'ws-app', agentId: 'a1', text: `at ${at}` })
    }
    const chats = await activity.listChats()
    assert.ok(chats.ok)
    assert.deepEqual(
      chats.chats.map((chat) => chat.title),
      ['Plan'],
      'a chat in a workspace that is not open is not reachable',
    )
    const prompts = await activity.prompts({ from: 0, to: 250, limit: 1 })
    assert.ok(prompts.ok)
    assert.deepEqual(
      prompts.prompts.map((prompt) => prompt.text),
      ['at 150'],
    )
    assert.equal(prompts.truncated, true)
    const bad = await activity.prompts({ from: 0, to: 250, limit: 5000 })
    assert.equal(!bad.ok && bad.code, 'invalid_input')
    main.permissions.clear()
    const refused = await activity.listChats()
    assert.equal(!refused.ok && refused.code, 'permission_missing')
  })
})

describe('createFakeMainHost: settings, workspaces, storage, GitHub and skills', () => {
  test('storage lists by prefix, reads many at once, and its watch hears own writes and outside changes', async () => {
    const fake = createFakeMainHost({ moduleId: 'notes', permissions: ['storage'] })
    const storage = getModuleStorage(fake.host)
    const heard: string[][] = []
    const stop = storage.watch({ workspaceRoot: ROOT }, (change) => heard.push(change.keys))
    assert.throws(() => storage.watch({ workspaceRoot: 'relative' }, () => {}), /absolute path/)
    await storage.set({ key: 'decision.1', value: 'a', workspaceRoot: ROOT })
    await storage.set({ key: 'decision.2', value: 'b', workspaceRoot: ROOT })
    await storage.set({ key: 'index', value: [], workspaceRoot: ROOT })
    await storage.delete({ key: 'never-set', workspaceRoot: ROOT })
    await storage.set({ key: 'elsewhere', value: 1 })
    fake.services.storage.changeExternally('decision.3', 'c', ROOT)
    assert.deepEqual(heard, [['decision.1'], ['decision.2'], ['index'], ['decision.3']])
    stop()
    assert.deepEqual(await storage.list({ workspaceRoot: ROOT, prefix: 'decision.' }), {
      ok: true,
      keys: ['decision.1', 'decision.2', 'decision.3'],
    })
    assert.deepEqual(await storage.getMany({ keys: ['decision.1', 'missing'], workspaceRoot: ROOT }), {
      ok: true,
      values: { 'decision.1': 'a' },
    })
    const tooMany = await storage.getMany({ keys: Array.from({ length: 1001 }, (_, index) => `k${index}`) })
    assert.equal(!tooMany.ok && tooMany.code, 'invalid_key')
  })

  test('GitHub keeps the readable headers, answers 304 to a matching etag, refuses a mutation and downloads', async () => {
    const fake = createFakeMainHost({ moduleId: 'radar', permissions: ['github'] })
    const github = getGitHubService(fake.host)
    fake.services.github.respond('GET', '/repos/{owner}/{repo}/pulls', {
      ok: true,
      data: [],
      headers: { ETag: '"abc"', 'X-RateLimit-Remaining': '42', 'Content-Type': 'application/json' },
    })
    const first = await github.request({ route: '/repos/{owner}/{repo}/pulls' })
    assert.deepEqual(first, {
      ok: true,
      status: 200,
      data: [],
      headers: { etag: '"abc"', 'x-ratelimit-remaining': '42' },
    })
    const again = await github.request({ route: '/repos/{owner}/{repo}/pulls', ifNoneMatch: '"abc"' })
    assert.ok(again.ok && again.status === 304 && again.data === null)
    const badAccept = await github.request({ route: '/user', accept: 'text/html' as never })
    assert.equal(!badAccept.ok && badAccept.code, 'invalid_route')

    const mutation = await github.graphql('mutation { addStar(input: {}) { clientMutationId } }')
    assert.equal(!mutation.ok && mutation.code, 'invalid_query')
    assert.equal(fake.services.github.graphqlRequests.length, 0, 'a refused query is never sent')
    fake.services.github.respondGraphql(({ variables }) => ({ ok: true, data: { data: { viewer: variables } } }))
    const viewer = await github.graphql('query($login: String!) { user(login: $login) { name } }', { login: 'dev' })
    assert.ok(viewer.ok)
    assert.deepEqual(viewer.data, { data: { viewer: { login: 'dev' } } })

    fake.services.github.respondDownload('/repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
      ok: true,
      body: 'step 1\nstep 2',
      contentType: 'text/plain',
    })
    const logs = await github.download({ route: '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs' })
    assert.ok(logs.ok && logs.data === 'step 1\nstep 2' && logs.encoding === 'utf8')
    const encoded = await github.download({
      route: '/repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
      encoding: 'base64',
    })
    assert.ok(encoded.ok && Buffer.from(encoded.data, 'base64').toString('utf8') === 'step 1\nstep 2')
    const unscripted = await github.download({ route: '/repos/acme/app/zipball' })
    assert.equal(!unscripted.ok && unscripted.status, 404)
  })

  test('workspaces keep a closed history and answer git info, behind ipc:workspace-read on both hosts', async () => {
    let clock = 1_000
    const main = createFakeMainHost({
      moduleId: 'vcs',
      permissions: [],
      now: () => clock,
      workspaces: [
        { id: 'ws-app', name: 'App', folderPath: ROOT, mode: 'standard' },
        { id: 'ws-docs', name: 'Docs', folderPath: '/Users/dev/projects/docs', mode: 'standard' },
      ],
    })
    const context = main.host.requireService(WorkspaceContextToken)
    main.services.workspaces.close('ws-docs')
    clock = 2_000
    assert.deepEqual(await context.list(), [
      { id: 'ws-app', name: 'App', folderPath: ROOT, mode: 'standard', open: true },
    ])
    assert.deepEqual(
      (await context.list({ includeClosed: true })).map((entry) => [entry.id, entry.open, entry.closedAt]),
      [
        ['ws-app', true, undefined],
        ['ws-docs', false, 1_000],
      ],
    )

    const refused = await main.host.getWorkspaceGitInfo('ws-app')
    assert.equal(!refused.ok && refused.code, 'permission_missing')
    assert.deepEqual(main.undeclared.at(-1), {
      what: 'getWorkspaceGitInfo',
      needs: ['ipc:workspace-read'],
      checked: true,
    })
    main.permissions.add('ipc:workspace-read')
    const plain = await main.host.getWorkspaceGitInfo('ws-app')
    assert.equal(!plain.ok && plain.code, 'not_a_repository')
    main.services.workspaces.setGitInfo('ws-app', {
      branch: 'main',
      remotes: [{ name: 'origin', url: 'git@github.com:acme/app.git', github: 'acme/app' }],
    })
    const renderer = createFakeRendererHost({ main })
    const info = await renderer.host.getWorkspaceGitInfo('ws-app')
    assert.ok(info.ok && info.branch === 'main' && info.remotes[0]?.github === 'acme/app')
    const closed = await renderer.host.getWorkspaceGitInfo('ws-docs')
    assert.equal(!closed.ok && closed.code, 'unknown_workspace')
  })

  test('module app state is the windows’ to set and main’s to read; a data dir, asset paths and skill status', async () => {
    const fake = createFakeMainHost({ moduleId: 'pulse', permissions: ['storage'], appState: { pollMinutes: 15 } })
    assert.equal(fake.host.getModuleAppState('pollMinutes'), 15)
    const heard: unknown[] = []
    fake.host.watchModuleAppState((values) => heard.push(values.pollMinutes))
    assert.deepEqual(heard, [], 'main hears changes, not the current value')
    const renderer = createFakeRendererHost({ main: fake })
    renderer.host.setModuleAppState('pollMinutes', 5)
    fake.setAppState('pollMinutes', 30)
    assert.deepEqual(heard, [5, 30])
    assert.equal(renderer.host.getModuleAppState('pollMinutes'), 30)

    const dir = fake.host.getModuleDataDir()
    assert.ok(existsSync(dir) && dir.endsWith('pulse'))
    assert.equal(fake.host.getModuleDataDir(), dir)
    fake.dispose()
    assert.equal(existsSync(dir), false, 'dispose removes the temporary folder')
    assert.throws(
      () =>
        createFakeMainHost({ moduleId: 'pulse', services: { 'core.module-storage': null } }).host.getModuleDataDir(),
      /no storage service is provided/,
    )

    const root = join(process.cwd(), 'packages', 'module-sdk')
    const assets = createFakeMainHost({ moduleId: 'pulse', moduleRoot: root, verifiedFiles: ['package.json'] })
    assert.equal(assets.host.getAssetPath('package.json'), join(root, 'package.json'))
    assert.throws(() => assets.host.getAssetPath('README.md'), /not among module "pulse"'s verified files/)
    assert.throws(() => assets.host.getAssetPath('../package.json'), /module-relative file path/)

    fake.host.registerSkills([{ id: 'pulse-guide', sourceDir: 'skills/pulse-guide', description: 'Guide' }])
    assert.deepEqual(await fake.host.getSkillStatus(ROOT, 'pulse-guide'), { ok: false, status: 'missing' })
    assert.deepEqual(await fake.host.ensureSkillInstalled(ROOT, 'pulse-guide'), { ok: true, status: 'installed' })
    assert.deepEqual(await fake.host.getSkillStatus(ROOT, 'pulse-guide'), { ok: true, status: 'installed' })
    fake.skills.setStatus(ROOT, 'pulse-guide', 'update-available')
    assert.deepEqual(await fake.host.ensureSkillInstalled(ROOT, 'pulse-guide'), { ok: true, status: 'updated' })
    fake.skills.setStatus(ROOT, 'pulse-guide', 'modified')
    assert.deepEqual(await fake.host.ensureSkillInstalled(ROOT, 'pulse-guide'), { ok: true, status: 'modified' })
    assert.equal((await fake.host.getSkillStatus(ROOT, 'nobody')).status, 'unknown-skill')
  })

  test('notify keeps a valid target, refuses a malformed one and clips as the host clips', () => {
    const fake = createFakeMainHost({ moduleId: 'notes' })
    fake.host.notify({ severity: 'info', title: 'x'.repeat(250), target: { surfaceId: ' notes ', viewId: 'inbox' } })
    assert.equal(fake.notifications[0]?.title.length, 200)
    assert.deepEqual(fake.notifications[0]?.target, { surfaceId: 'notes', viewId: 'inbox' })
    assert.throws(() => fake.host.notify({ severity: 'info', title: 'x', target: { surfaceId: '' } }), /surfaceId/)
  })

  test('the fakes support every capability HostCapability names', () => {
    const source = readFileSync(join(process.cwd(), 'packages', 'module-sdk', 'src', 'host-api.ts'), 'utf8')
    const union = source.slice(
      source.indexOf('export type HostCapability'),
      source.indexOf('export type HostApiCompatibility'),
    )
    const named = [...union.matchAll(/^\s*\|\s*'([^']+)'/gm)].map((match) => match[1]!)
    assert.ok(named.length > 30, `found only ${named.length} capabilities; is the scan broken?`)
    const main = createFakeMainHost({ moduleId: 'probe' }).host
    const renderer = createFakeRendererHost({ moduleId: 'probe' }).host
    assert.deepEqual(
      named.filter((capability) => !main.supports(capability) || !renderer.supports(capability)),
      [],
      'add the capability to KNOWN_CAPABILITIES in testing.ts (and fake what it gates)',
    )
  })
})

describe('createFakeRendererHost: toasts, links and the window', () => {
  test('toasts, links, the active workspace, surface views and the command context', async () => {
    const renderer = createFakeRendererHost({
      moduleId: 'board',
      workspaces: [
        { id: 'ws-app', name: 'App', folderPath: ROOT, mode: 'standard' },
        { id: 'ws-board', name: 'Board', folderPath: ROOT, mode: 'board' },
      ],
    })
    assert.equal(renderer.host.moduleId, 'board')

    const dismiss = renderer.host.toast({ tone: 'good', message: '  Saved  ', action: { label: 'Undo', run() {} } })
    assert.equal(renderer.toasts[0]?.message, 'Saved')
    assert.equal(renderer.toasts[0]?.action?.label, 'Undo')
    dismiss()
    assert.equal(renderer.toasts[0]?.dismissed, true)
    assert.throws(() => renderer.host.toast({ tone: 'loud' as never, message: 'x' }), /tone/)
    assert.throws(() => renderer.host.toast({ tone: 'good', message: ' ' }), /non-empty message/)

    assert.deepEqual(await renderer.host.openExternal('https://example.com/a b'), { ok: true })
    assert.deepEqual(renderer.openedUrls, ['https://example.com/a%20b'])
    const refused = await renderer.host.openExternal('file:///etc/passwd')
    assert.equal(!refused.ok && refused.code, 'invalid_url')

    const active: Array<string | null> = []
    renderer.host.watchActiveWorkspace((id) => active.push(id))
    renderer.setActiveWorkspace('ws-board')
    renderer.setActiveWorkspace('ws-board')
    renderer.setActiveWorkspace(null)
    assert.deepEqual(active, ['ws-app', 'ws-board', null])

    renderer.host.registerGlobalSurface({
      id: 'board',
      label: 'Board',
      views: [{ id: 'lanes', label: 'Lanes' }],
      Component: () => null,
    })
    assert.equal(renderer.host.setSurfaceView('board', 'lanes'), true)
    assert.equal(renderer.host.setSurfaceView('board', 'missing'), false)
    assert.equal(renderer.host.setSurfaceView('someone-else', null), false)
    assert.deepEqual(renderer.surfaceViews, { board: 'lanes' })

    const contexts: unknown[] = []
    renderer.host.registerCommand({
      id: 'refresh',
      title: 'Refresh',
      category: 'Board',
      scopes: ['global'],
      availability: (context) => context.activeWorkspaceMode === 'board',
      run: (context) => void contexts.push(context),
    })
    await assert.rejects(renderer.runCommand('refresh'), /not available/)
    renderer.setActiveWorkspace('ws-board')
    await renderer.runCommand('refresh')
    assert.deepEqual(contexts, [{ activeWorkspaceId: 'ws-board', activeWorkspaceMode: 'board' }])

    const older = createFakeRendererHost({ moduleId: 'board', capabilities: ['notifications'] })
    older.host.toast({ tone: 'good', message: 'Nobody sees this' })
    assert.deepEqual(older.toasts, [])
    const unavailable = await older.host.openExternal('https://example.com')
    assert.equal(!unavailable.ok && unavailable.code, 'unavailable')
  })

  test('a notification provider is for the module’s own rows, and a door badge row is claimed once', () => {
    const renderer = createFakeRendererHost({ moduleId: 'board' })
    assert.throws(
      () => renderer.host.registerNotificationActionProvider({ source: 'backlog', resolveActions: () => [] }),
      /only register a notification action provider for its own rows/,
    )
    renderer.host.registerNotificationActionProvider({ source: 'board', resolveActions: () => [] })
    const badge = { rowId: 'board', getWaitingCount: () => 2, subscribe: () => () => {} }
    renderer.host.registerDoorBadge(badge)
    assert.throws(() => renderer.host.registerDoorBadge(badge), /already registered/)
  })
})

describe('the pass-through kit: board, menu, input and Markdown components', () => {
  test('draws the newer components with their text', async () => {
    const html = await renderToHtml(
      createElement(
        kit.BoardLane,
        { label: 'Ready', count: 1, flipKey: 'a' },
        createElement(kit.TaskCard, { tone: 'accent', identifier: 'MC-240', title: 'Ship it' }),
        createElement(kit.SafeMarkdown, { text: '**Before** Friday' }),
        createElement(kit.ContextMenu, { x: 1, y: 2, ariaLabel: 'Card', onClose() {} }, [
          createElement(kit.MenuItem, { key: 'a', onClick() {} }, 'Archive'),
          createElement(kit.MenuDivider, { key: 'b' }),
        ]),
        createElement(kit.Toggle, { checked: true, onChange() {}, ariaLabel: 'Auto' }),
        createElement(kit.Chip, null, 'Pinned'),
      ),
    )
    for (const text of ['data-kit="BoardLane"', 'MC-240', 'Ship it', 'Before', 'Archive', 'data-kit="MenuDivider"']) {
      assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    assert.match(html, /data-kit="Toggle" data-checked="true"/)
    assert.match(html, /Pinned/)
  })
})

describe('createFakeMainHost: agents, conversations and scheduled agents', () => {
  test('text generation needs agents:generate, answers what was scripted, and refuses as the host does', async () => {
    const fake = createFakeMainHost({ moduleId: 'digest', permissions: [] })
    const text = getTextGenerationService(fake.host)
    const refused = await text.generate({ prompt: 'Summarise' })
    assert.equal(!refused.ok && refused.code, 'permission_missing')
    fake.permissions.add('agents:generate')

    const unscripted = await text.generate({ prompt: 'Summarise' })
    assert.equal(!unscripted.ok && unscripted.code, 'invalid_output')
    fake.services.textGeneration.respond(({ input, cli }) =>
      input.json ? 'Here you go:\n```json\n{"score": 3}\n```' : { text: `on ${cli}`, usage: { outputTokens: 4 } },
    )
    assert.deepEqual(await text.generate({ prompt: 'Summarise' }), {
      ok: true,
      text: 'on claude-code',
      usage: { outputTokens: 4 },
      model: 'claude-haiku-5-5',
    })
    const codex = await text.generate({ prompt: 'Summarise', cli: 'codex' })
    assert.ok(codex.ok && codex.model === 'gpt-5.6-luna' && codex.text === 'on codex')
    const json = await text.generate({ prompt: 'Rate it', json: true })
    assert.ok(json.ok && json.text === '{"score":3}')
    const cursor = await text.generate({ prompt: 'x', cli: 'cursor' })
    assert.equal(!cursor.ok && cursor.code, 'unsupported')
    const tooLong = await text.generate({ prompt: 'x', maxOutputTokens: 64_001 })
    assert.equal(!tooLong.ok && tooLong.code, 'invalid_input')

    // Two run, eight wait, and the eleventh is told the lane is full.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    fake.services.textGeneration.respond(async () => {
      await held
      return 'done'
    })
    const pending = Array.from({ length: 10 }, () => text.generate({ prompt: 'wait' }))
    const busy = await text.generate({ prompt: 'one more' })
    assert.equal(!busy.ok && busy.code, 'busy')
    release()
    assert.ok((await Promise.all(pending)).every((answer) => answer.ok))
    assert.equal(fake.services.textGeneration.calls.at(-1)?.input.prompt, 'wait')
  })

  test('companion runs deny tools by default, refuse auto without conversation:bypass, and leave ask to the person', async () => {
    const fake = createFakeMainHost({ moduleId: 'review', permissions: ['agents:companion'] })
    const handle = getCompanionAgentsService(fake.host).attach({
      workspaceId: 'ws-app',
      agentId: 'guide',
      name: 'Guide',
      workspaceRoot: ROOT,
      systemPrompt: 'Help.',
    })
    const companions = fake.services.companions
    const validate = (raw: unknown) => ({ ok: true as const, value: raw })

    companions.respond(async ({ tools }) => ({ tools, asked: await companions.requestApproval('ws-app', 'guide') }))
    assert.deepEqual(await handle.runStructured({ prompt: 'Read the log', validate }), { tools: 'none', asked: 'deny' })
    assert.match(companions.prompts[0]?.prompt ?? '', /You have no tools for this task/)
    await assert.rejects(
      handle.runStructured({ prompt: 'Fix it', validate, tools: 'auto' }),
      /"conversation:bypass" permission/,
    )
    fake.permissions.add('conversation:bypass')
    assert.deepEqual(await handle.runStructured({ prompt: 'Fix it', validate, tools: 'auto' }), {
      tools: 'auto',
      asked: 'once',
    })

    // `ask`: the request reaches onEvent and waits for the person's answer.
    handle.onEvent((event) => {
      if (event.type !== 'approval_requested') return
      const requestId = String(event.payload?.requestId)
      void handle.respondToApproval({ requestId, decision: 'once' }).then(async (allowed) => {
        assert.match(allowed.ok ? '' : allowed.message, /"conversation:operate" permission/)
        await handle.respondToApproval({ requestId, decision: 'deny' })
      })
    })
    assert.deepEqual(await handle.runStructured({ prompt: 'Ask first', validate, tools: 'ask' }), {
      tools: 'ask',
      asked: 'deny',
    })
    assert.deepEqual(await handle.respondToApproval({ requestId: 'nope', decision: 'deny' }), {
      ok: false,
      message: 'No approval request "nope" is waiting on this companion.',
    })
    assert.deepEqual(
      companions.approvals.map((approval) => [approval.decision, approval.by]),
      [
        ['deny', 'host'],
        ['once', 'host'],
        ['deny', 'module'],
      ],
    )
  })

  test('conversations: reply reads a turn’s text, a worktree chat gets a workspace of its own, and a follow waits for a chat', async () => {
    const fake = createFakeMainHost({ moduleId: 'board', permissions: ['conversation:operate'] })
    const chats = getConversationService(fake.host)
    const created = await chats.create({ workspaceId: 'ws-app', prompt: 'Plan it' })
    assert.ok(created.ok)
    const ref = { workspaceId: created.conversation.workspaceId, agentId: created.conversation.agentId }
    assert.equal(created.conversation.cli, 'claude-code')
    const none = await chats.reply(ref)
    assert.equal(!none.ok && none.code, 'no_reply')
    fake.services.conversations.emitEvent(ref, { type: 'turn_started' })
    fake.services.conversations.emitEvent(ref, { type: 'content_delta', payload: { text: 'Thinking… ' } })
    const done = fake.services.conversations.emitEvent(ref, {
      type: 'turn_completed',
      payload: { text: 'Ship Friday.', usage: { inputTokens: 10, outputTokens: 3 } },
    })
    const turnId = String(done.payload?.turnId)
    assert.deepEqual(await chats.reply(ref), { ok: true, turnId, text: 'Ship Friday.' })
    const unknownTurn = await chats.reply(ref, 'turn-99')
    assert.equal(!unknownTurn.ok && unknownTurn.code, 'no_reply')

    const notRepo = await chats.create({ workspaceId: 'ws-app', worktree: { name: 'fix-ci' } })
    assert.equal(!notRepo.ok && notRepo.code, 'worktree_unavailable')
    fake.services.workspaces.setGitInfo('ws-app', { branch: 'main', remotes: [] })
    const isolated = await chats.create({ workspaceId: 'ws-app', worktree: { name: 'fix-ci' } })
    assert.ok(isolated.ok && isolated.conversation.workspaceId !== 'ws-app')
    fake.permissions.add('ipc:workspace-read')
    const git = await fake.host.getWorkspaceGitInfo(isolated.conversation.workspaceId)
    assert.ok(git.ok && git.branch?.startsWith('agent/fix-ci-'))

    // At launch a saved chat's workspace may not be loaded yet.
    const saved = { workspaceId: 'ws-app', agentId: 'saved-chat' }
    const frames: string[] = []
    const events: string[] = []
    chats.follow(saved, undefined, (frame) => frames.push(frame.type))
    chats.subscribe(saved, (event) => events.push(event.type))
    assert.deepEqual(frames, [])
    fake.services.conversations.restore({ ...saved, events: [{ type: 'user_message', payload: { text: 'Hi' } }] })
    fake.services.conversations.emitEvent(saved, { type: 'turn_started' })
    assert.deepEqual(frames, ['snapshot', 'synchronized', 'event'])
    assert.deepEqual(events, ['turn_started'])
  })

  test('scheduled agents carry name and tag, a run starts a chat the module owns, and onRun hears it', async () => {
    let clock = Date.parse('2026-10-09T10:00:00Z')
    const fake = createFakeMainHost({
      moduleId: 'board',
      permissions: ['scheduled-agents.manage', 'conversation:read'],
      now: () => clock,
    })
    const scheduled = getScheduledAgentsService(fake.host)
    const draft: ScheduledAgentDraft = {
      name: 'Standup',
      tag: 'card-42',
      prompt: 'Write the standup',
      schedule: { cron: '0 9 * * 1-5', timezone: 'UTC', once: clock + 60_000 },
      folderPath: ROOT,
      hostId: 'local',
      cli: 'claude-code',
      cliModel: null,
      permissionPreset: null,
      skills: [],
      mcpServers: [],
      worktree: null,
    }
    const tooLong = await scheduled.create({ ...draft, tag: 'x'.repeat(201) })
    assert.equal(tooLong.ok, false)
    const created = await scheduled.create(draft)
    assert.ok(created.ok && created.agent.name === 'Standup' && created.agent.tag === 'card-42')
    const { name: _name, ...unnamed } = draft
    const kept = await scheduled.update(created.agent.id, unnamed)
    assert.ok(kept.ok && kept.agent.name === 'Standup', 'a draft without a name keeps the one there')

    const runs: Array<[string | undefined, string]> = []
    scheduled.onRun((agent, run) => runs.push([agent.tag, run.agentId]))
    clock += 60_000
    const lastRun = fake.services.scheduledAgents.fire(created.agent.id)
    assert.ok(lastRun.ok && lastRun.agentId)
    assert.deepEqual(runs, [['card-42', lastRun.agentId]], 'a one-time schedule is heard before it closes')
    const [chat] = getConversationService(fake.host).list({ workspaceId: lastRun.workspaceId })
    assert.equal(chat?.scheduledAgentId, created.agent.id)
    assert.equal(chat?.scheduledAgentTag, 'card-42')
    assert.deepEqual(await scheduled.list(), [])
  })

  test('listChatRuntimes answers runtime ids, and the test can change them', async () => {
    const fake = createFakeMainHost({ moduleId: 'board' })
    assert.deepEqual(
      (await fake.host.listChatRuntimes()).map((runtime) => runtime.id),
      ['claude-code', 'codex'],
    )
    fake.setChatRuntimes([{ id: 'codex', label: 'Codex', available: true, models: [], lastSelected: true }])
    assert.equal((await fake.host.listChatRuntimes())[0]?.id, 'codex')
    assert.equal(createFakeRendererHost({ main: fake }).host.listChatRuntimes()[0]?.id, 'codex')
  })
})

describe('createFakeRendererHost: openChat', () => {
  test('a draft needs chat:draft, sending needs conversation:operate, and a dedupeKey focuses the chat it opened', async () => {
    const main = createFakeMainHost({ moduleId: 'board', permissions: ['chat:draft'] })
    const renderer = createFakeRendererHost({ main })
    const sent = await renderer.host.openChat({ workspaceId: 'ws-app', prompt: 'Go', send: true })
    assert.equal(!sent.ok && sent.code, 'permission_missing')
    assert.deepEqual(renderer.undeclared.at(-1), { what: 'openChat', needs: ['conversation:operate'], checked: true })

    const first = await renderer.host.openChat({
      workspaceId: 'ws-app',
      prompt: 'Look at card 42',
      name: 'Card 42',
      dedupeKey: 'card-42',
    })
    assert.ok(first.ok && first.existing === undefined)
    assert.equal(main.services.conversations.all()[0]?.summary.name, 'Card 42')
    const again = await renderer.host.openChat({ workspaceId: 'ws-app', prompt: 'Different', dedupeKey: 'card-42' })
    assert.deepEqual(again, { ok: true, agentId: first.agentId, existing: true })
    assert.equal(renderer.openedChats.length, 1, 'nothing else is applied to the chat it focused')
    const badName = await renderer.host.openChat({ workspaceId: 'ws-app', name: 'x'.repeat(121) })
    assert.equal(!badName.ok && badName.code, 'invalid_input')
  })
})
