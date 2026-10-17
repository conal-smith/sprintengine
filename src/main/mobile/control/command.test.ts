import assert from 'node:assert/strict'
import { workspaceStorePath } from '../../workspace-store'
import { standIn } from '../../../../tests/stand-in'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { mobileControlProtocolVersion, MobileControlCommandService, type MobileControlCommand } from './command'
import { defaultMobileSnapshotCommands } from './snapshot'
import { deriveWorkspaceId } from './workspace-id'
import { parseBacklogFrontmatter } from '../../../shared/backlog/frontmatter'
import { test } from 'vitest'

test('command', async () => {
  const now = new Date('2026-04-28T19:45:00.000Z')

  const suiteRun = main()

  async function main(): Promise<void> {
    await assertRetiredSprintCommandIsRefusedCleanly()
    await assertEveryRetiredSprintCommandIsRefusedCleanly()
    await assertSameIdempotencyKeyAndBodyReplaysCachedResult()
    await assertSameIdempotencyKeyWithDifferentBodyIsRejected()
    await assertIdempotencyReplaySurvivesServiceRecreation()
    await assertBacklogUpdateWritesFrontmatter()
    await assertBacklogCreateWritesFileAndRecord()
    await assertBacklogCreateRejectsEmptyTitle()
    await assertBacklogCreateKeepsGeneratedPathUnderBacklog()
    await assertFilesystemMutationHandlersRoundTripOrdinaryPaths()
    await assertAutomationsControlIsRefusedAndNotAdvertised()
  }

  // INVERTED at protocol v3. The Sprint Engine's removal required these to be refused as
  // `command_not_supported` — the envelope validator had to ACCEPT them so a phone
  // paired before the Sprint Engine left got an honest refusal from the service
  // rather than a "malformed" answer to a message that was not malformed.
  //
  // The wire no longer defines them, so that is no longer the truth to tell. A
  // sender of one is speaking a version outside the window, and `invalid_payload`
  // from the envelope validator is now the accurate answer: this build cannot read
  // the message. What must NOT change is that something comes back at all — a
  // dropped command is a phone spinning until its own timeout, which was the real
  // failure that rule was guarding against, and it is still guarded here.
  async function assertRetiredSprintCommandIsRefusedCleanly(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-mobile-command-retired-'))
    const service = new MobileControlCommandService({ workspaceRoot, now: () => now })

    const result = await service.dispatch(
      command(
        'task.start' as MobileControlCommand['type'],
        {
          sprintEngineId: 'team',
          taskId: 'T1',
          role: 'developer',
          worktreeIsolation: 'preferred',
        } as MobileControlCommand['payload'],
      ),
    )

    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.error.code : '', 'invalid_payload')
    assert.equal(result.ok === false ? result.error.retryable : true, false)
    // Still audited, so the desktop's own log says a phone asked for something the
    // wire no longer carries.
    const audit = service.getAuditLog()[0]
    assert.equal(audit.status, 'rejected')
    assert.equal(audit.code, 'invalid_payload')
  }

  async function assertEveryRetiredSprintCommandIsRefusedCleanly(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-mobile-command-retired-all-'))
    const service = new MobileControlCommandService({ workspaceRoot, now: () => now })

    // Every payload here is one a live phone really sent at v2. None of the nine
    // types is a member of `MobileControlCommandType` any more, which is why each
    // is cast in rather than declared — the cast IS the assertion.
    const retired: Array<[string, Record<string, unknown>]> = [
      ['sprintengine.create', { workspacePath: workspaceRoot, productPrompt: 'Build it' }],
      ['task.start', { sprintEngineId: 'team', taskId: 'T1', role: 'developer', worktreeIsolation: 'preferred' }],
      ['agent.followUp', { sprintEngineId: 'team', agentId: 'developer-1', text: 'carry on' }],
      ['artifact.approve', { sprintEngineId: 'team', artifactId: 'A1' }],
      ['artifact.requestChanges', { sprintEngineId: 'team', artifactId: 'A1', feedback: 'more detail' }],
      ['artifact.read', { sprintEngineId: 'team', artifactId: 'A1', previewMode: 'markdown' }],
      ['backlog.startSprintEngine', { workspacePath: workspaceRoot, relativePath: 'backlog/idea.md' }],
      ['sprintengine.openPullRequest', { sprintEngineId: 'team' }],
      ['sprintengine.setAutomationMode', { sprintEngineId: 'team', mode: 'run_agents' }],
    ]

    for (const [type, payload] of retired) {
      const result = await service.dispatch(
        command(type as MobileControlCommand['type'], payload as MobileControlCommand['payload'], {
          commandId: `cmd_${type}`,
          idempotencyKey: `mobile:device_1:${type}`,
        }),
      )
      assert.equal(result.ok, false, `${type} must be refused`)
      assert.equal(
        result.ok === false ? result.error.code : '',
        'invalid_payload',
        `${type} is no longer a command this wire defines`,
      )
    }

    // And none of them is advertised, so no phone draws the control.
    for (const [type] of retired) {
      assert.equal(
        (defaultMobileSnapshotCommands as readonly string[]).includes(type),
        false,
        `${type} must not be advertised`,
      )
    }
  }

  // The idempotency ledger used to be exercised through `artifact.approve`. Its
  // vehicle is now `backlog.create`, which has the same property that made the
  // artifact command a good one: a visible side effect on disk, so a replay that
  // re-executed would be caught by the item count rather than by a spy.
  async function assertSameIdempotencyKeyAndBodyReplaysCachedResult(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-mobile-command-replay-'))
    const service = new MobileControlCommandService({ workspaceRoot, now: () => now })
    const mobileCommand = command(
      'backlog.create',
      {
        workspacePath: workspaceRoot,
        title: 'Replay me once',
      },
      {
        idempotencyKey: 'mobile:device_1:replay',
      },
    )

    const first = await service.dispatch(mobileCommand)
    const second = await service.dispatch({ ...mobileCommand, commandId: 'cmd_replay' })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    // The cached replay is a JSON clone, so compare the serialized bodies: a key
    // whose value was `undefined` does not survive the round trip and never
    // reached the phone in the first place.
    assert.equal(JSON.stringify(second.ok ? second.data : null), JSON.stringify(first.ok ? first.data : null))
    assert.equal((await readBacklogStoreItems(workspaceRoot)).length, 1)
    assert.equal(service.getAuditLog()[0].status, 'accepted')
    assert.equal(service.getAuditLog()[0].deviceId, 'device_1')
    assert.equal(service.getAuditLog()[0].commandId, 'cmd_replay')
  }

  async function assertSameIdempotencyKeyWithDifferentBodyIsRejected(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-mobile-command-replay-conflict-'))
    const service = new MobileControlCommandService({ workspaceRoot, now: () => now })

    const first = await service.dispatch(
      command(
        'backlog.create',
        {
          workspacePath: workspaceRoot,
          title: 'The first body',
        },
        {
          idempotencyKey: 'mobile:device_1:replay-conflict',
        },
      ),
    )
    const second = await service.dispatch(
      command(
        'backlog.create',
        {
          workspacePath: workspaceRoot,
          title: 'This different body must not be executed',
        },
        {
          commandId: 'cmd_replay_conflict',
          idempotencyKey: 'mobile:device_1:replay-conflict',
        },
      ),
    )

    assert.equal(first.ok, true)
    assert.equal(second.ok, false)
    assert.equal(second.ok === false ? second.error.code : '', 'duplicate_idempotency_key')
    assert.equal((await readBacklogStoreItems(workspaceRoot)).length, 1)
    const audit = service.getAuditLog()[0]
    assert.equal(audit.status, 'rejected')
    assert.equal(audit.deviceId, 'device_1')
    assert.equal(audit.commandId, 'cmd_replay_conflict')
    assert.equal(audit.code, 'duplicate_idempotency_key')
    assert.equal(JSON.stringify(audit).includes('This different body'), false)
  }

  async function assertIdempotencyReplaySurvivesServiceRecreation(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-mobile-command-replay-recreate-'))
    const mobileCommand = command(
      'backlog.create',
      {
        workspacePath: workspaceRoot,
        title: 'Survive a restart',
      },
      {
        idempotencyKey: 'mobile:device_1:replay-recreate',
      },
    )

    const first = await new MobileControlCommandService({ workspaceRoot, now: () => now }).dispatch(mobileCommand)
    const second = await new MobileControlCommandService({ workspaceRoot, now: () => now }).dispatch({
      ...mobileCommand,
      commandId: 'cmd_replay_recreate',
    })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(JSON.stringify(second.ok ? second.data : null), JSON.stringify(first.ok ? first.data : null))
    assert.equal((await readBacklogStoreItems(workspaceRoot)).length, 1)
  }

  // Automations left the phone on 2026-09-29. The command service no longer
  // knows the command, so the envelope validator answers it as a message this
  // wire does not define — audited, and answered rather than dropped — and no
  // snapshot advertises it, so no phone draws the control.
  async function assertAutomationsControlIsRefusedAndNotAdvertised(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-mobile-command-automations-'))
    const service = new MobileControlCommandService({ workspaceRoot, now: () => now })

    const result = await service.dispatch(
      command(
        'automations.control' as MobileControlCommand['type'],
        {
          workspacePath: deriveWorkspaceId(workspaceRoot),
          automationId: 'nightly',
          action: 'runNow',
        } as unknown as MobileControlCommand['payload'],
      ),
    )
    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.error.code : '', 'invalid_payload')
    assert.equal(service.getAuditLog()[0]?.status, 'rejected')
    assert.equal((defaultMobileSnapshotCommands as readonly string[]).includes('automations.control'), false)
  }

  async function assertBacklogUpdateWritesFrontmatter(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-mobile-backlog-update-'))
    await mkdir(join(workspaceRoot, 'backlog'), { recursive: true })
    const body = '# A rough idea\n\nDo the thing.\n'
    await writeFile(join(workspaceRoot, 'backlog', 'idea.md'), body, 'utf8')
    const service = new MobileControlCommandService({
      workspaceRoot,
      now: () => now,
    })

    const result = await service.dispatch(
      command(
        'backlog.update',
        {
          workspacePath: workspaceRoot,
          relativePath: 'backlog/idea.md',
          status: 'ready',
          difficulty: 'm',
          criticality: 'high',
        },
        {
          commandId: 'cmd_backlog_update',
          idempotencyKey: 'mobile:device_1:backlog-update',
        },
      ),
    )

    assert.equal(result.ok, true)
    // Lifecycle/triage now live in the item's markdown frontmatter (v2), not the
    // sidecar; the body is preserved byte-for-byte and the link cache is never created.
    const updated = parseBacklogFrontmatter(await readFile(join(workspaceRoot, 'backlog', 'idea.md'), 'utf8'))
    assert.equal(updated.fields.status, 'ready')
    assert.equal(updated.fields.difficulty, 'm')
    assert.equal(updated.fields.criticality, 'high')
    assert.equal(updated.body, body, 'backlog.update must preserve the document body')
    await assert.rejects(
      () => readFile(workspaceStorePath(workspaceRoot, 'backlog', 'cache', 'links.json'), 'utf8'),
      /ENOENT/,
      'backlog.update must not write the link cache for lifecycle/triage',
    )

    const invalid = await service.dispatch(
      command(
        'backlog.update',
        {
          workspacePath: workspaceRoot,
          relativePath: 'backlog/idea.md',
          // @ts-expect-error deliberately invalid status to exercise the dispatcher's runtime invalid_payload rejection
          status: 'not-a-status',
        },
        {
          commandId: 'cmd_backlog_update_invalid',
          idempotencyKey: 'mobile:device_1:backlog-update-invalid',
        },
      ),
    )
    assert.equal(invalid.ok, false)
    assert.equal(invalid.ok === false ? invalid.error.code : '', 'invalid_payload')
  }

  type BacklogStoreItem = {
    source: { relativePath: string }
    status?: string
    metadata?: Record<string, unknown>
    links?: Array<{
      id: string
      type: string
      label: string
      target: { kind: string; id: string; path?: string; url?: string }
    }>
  }

  async function readBacklogStoreItems(workspaceRoot: string): Promise<BacklogStoreItem[]> {
    const store = JSON.parse(
      await readFile(workspaceStorePath(workspaceRoot, 'backlog', 'cache', 'links.json'), 'utf8'),
    ) as { items: BacklogStoreItem[] }
    return store.items
  }

  async function assertBacklogCreateWritesFileAndRecord(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-mobile-backlog-create-'))
    const service = new MobileControlCommandService({
      workspaceRoot,
      now: () => now,
    })

    const result = await service.dispatch(
      command(
        'backlog.create',
        {
          workspacePath: workspaceRoot,
          title: 'Ship the phone widget',
          description: 'Users need the widget on the phone.',
          type: 'spike',
          difficulty: 'm',
          criticality: 'high',
        },
        {
          commandId: 'cmd_backlog_create',
          idempotencyKey: 'mobile:device_1:backlog-create',
        },
      ),
    )

    assert.equal(result.ok, true)
    const data = result.ok ? (result.data as { id: string; relativePath: string }) : null
    assert.ok(data?.relativePath?.startsWith('backlog/'), 'create returns a backlog/-relative path')
    // A folder under `backlog/` is an epic, so an item created without one is filed
    // in `unfiled/` rather than landing at the top level among the epic folders.
    assert.match(data!.relativePath, /^backlog\/unfiled\/\d{4}-\d{2}-\d{2}-ship-the-phone-widget\.md$/)
    assert.ok(data!.id.startsWith('backlog_'), 'create returns a stable backlog id')

    // v2-native create: lifecycle/triage live in the new file's frontmatter (the
    // source of truth), the sidecar record stays minimal app-owned churn.
    const fileBody = await readFile(join(workspaceRoot, data!.relativePath), 'utf8')
    // Main-owned create allocates the item number and stamps `updated` inside
    // the create transaction, so a fresh workspace's first item is id 1 with a
    // wall-clock timestamp — match the frontmatter structurally.
    assert.match(
      fileBody,
      /^---\nid: 1\ntype: spike\nstatus: idea\ndifficulty: m\ncriticality: high\nupdated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n---\n\n# Ship the phone widget\n\nUsers need the widget on the phone\.\n$/,
    )

    const store = JSON.parse(
      await readFile(workspaceStorePath(workspaceRoot, 'backlog', 'cache', 'links.json'), 'utf8'),
    ) as {
      items: Array<{
        id: string
        source: { relativePath: string }
        status?: string
        type?: string
        difficulty?: string
        criticality?: string
      }>
    }
    const record = store.items.find((item) => item.source.relativePath === data!.relativePath)
    assert.ok(record, 'backlog.create should upsert a real link-cache record')
    assert.equal(record?.status, undefined, 'lifecycle must not be seeded into the sidecar record')
    assert.equal(record?.type, undefined)
    assert.equal(record?.difficulty, undefined)
    assert.equal(record?.criticality, undefined)
    assert.equal(record?.id, data!.id)
  }

  async function assertBacklogCreateRejectsEmptyTitle(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-mobile-backlog-create-empty-'))
    const service = new MobileControlCommandService({
      workspaceRoot,
      now: () => now,
    })

    const result = await service.dispatch(
      command(
        'backlog.create',
        {
          workspacePath: workspaceRoot,
          title: '   ',
        },
        {
          commandId: 'cmd_backlog_create_empty',
          idempotencyKey: 'mobile:device_1:backlog-create-empty',
        },
      ),
    )

    assert.equal(result.ok, false)
    assert.equal(result.ok === false ? result.error.code : '', 'invalid_payload')
  }

  async function assertBacklogCreateKeepsGeneratedPathUnderBacklog(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-mobile-backlog-create-escape-'))
    const service = new MobileControlCommandService({
      workspaceRoot,
      now: () => now,
    })

    // A title full of path-traversal characters must not escape backlog/.
    const result = await service.dispatch(
      command(
        'backlog.create',
        {
          workspacePath: workspaceRoot,
          title: '../../etc/passwd',
        },
        {
          commandId: 'cmd_backlog_create_escape',
          idempotencyKey: 'mobile:device_1:backlog-create-escape',
        },
      ),
    )

    assert.equal(result.ok, true)
    const data = result.ok ? (result.data as { relativePath: string }) : null
    assert.ok(data?.relativePath?.startsWith('backlog/'), 'title traversal is slugified under backlog/')
    assert.equal(data!.relativePath.includes('..'), false, 'generated path cannot escape the backlog folder')
    await readFile(join(workspaceRoot, data!.relativePath), 'utf8')
  }

  // The filesystem mutation IPC is what the file tree and the phone both write
  // through, so its write/rename/copy/delete round trip is asserted end to end on
  // real paths rather than mocked: a handler that silently resolved a path
  // somewhere else would still return a plausible-looking string.
  async function assertFilesystemMutationHandlersRoundTripOrdinaryPaths(): Promise<void> {
    const handlers = await importMainProcessIpcHandlers()
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'sprintengine-fs-guard-'))

    const safeDirectory = join(workspaceRoot, 'safe')
    const safeCopyDestination = join(workspaceRoot, 'safe-copy')
    await mkdir(safeDirectory)
    await mkdir(safeCopyDestination)

    const safeFilePath = join(safeDirectory, 'notes.txt')
    await handlers.writeFile(safeFilePath, 'safe write\n')
    assert.equal(await readFile(safeFilePath, 'utf8'), 'safe write\n')

    const renamedSafeFilePath = await handlers.rename(safeFilePath, 'renamed.txt')
    assert.equal(renamedSafeFilePath, join(safeDirectory, 'renamed.txt'))
    assert.equal(await readFile(renamedSafeFilePath, 'utf8'), 'safe write\n')

    const copiedSafeFilePath = await handlers.copy(renamedSafeFilePath, safeCopyDestination)
    assert.equal(await readFile(copiedSafeFilePath, 'utf8'), 'safe write\n')

    await handlers.delete(copiedSafeFilePath)
    await assert.rejects(() => access(copiedSafeFilePath))

    const safeNestedDirectory = join(workspaceRoot, 'safe-dir')
    await mkdir(join(safeNestedDirectory, 'nested'), { recursive: true })
    await writeFile(join(safeNestedDirectory, 'nested', 'notes.txt'), 'safe nested write\n', 'utf8')

    const renamedSafeDirectoryPath = await handlers.rename(safeNestedDirectory, 'safe-dir-renamed')
    assert.equal(await readFile(join(renamedSafeDirectoryPath, 'nested', 'notes.txt'), 'utf8'), 'safe nested write\n')

    const copiedSafeDirectoryPath = await handlers.copy(renamedSafeDirectoryPath, safeCopyDestination)
    assert.equal(await readFile(join(copiedSafeDirectoryPath, 'nested', 'notes.txt'), 'utf8'), 'safe nested write\n')

    await handlers.delete(copiedSafeDirectoryPath)
    await assert.rejects(() => access(copiedSafeDirectoryPath))
    await handlers.delete(renamedSafeDirectoryPath)
    await assert.rejects(() => access(renamedSafeDirectoryPath))
  }

  type FilesystemMutationHandlers = {
    writeFile: (filePath: string, content: string) => Promise<void>
    rename: (sourcePath: string, nextName: string) => Promise<string>
    copy: (sourcePath: string, destinationDir: string) => Promise<string>
    delete: (targetPath: string) => Promise<void>
  }

  async function importMainProcessIpcHandlers(): Promise<FilesystemMutationHandlers> {
    const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const restoreModules = standIn({
      electron: {
        app: {
          defaultApp: false,
          getAppPath: () => process.cwd(),
          getPath: (name: string) => join(tmpdir(), `sprintengine-electron-${name}`),
          getVersion: () => '0.0.0',
          isPackaged: false,
          on: () => undefined,
          quit: () => undefined,
          requestSingleInstanceLock: () => true,
          setAppLogsPath: () => undefined,
          setAppUserModelId: () => undefined,
          setAsDefaultProtocolClient: () => true,
          whenReady: () => new Promise(() => undefined),
        },
        BrowserWindow: class {
          static getAllWindows(): unknown[] {
            return []
          }
        },
        dialog: {},
        ipcMain: {
          handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
            ipcHandlers.set(channel, handler)
          },
          on: () => undefined,
        },
        Menu: {
          buildFromTemplate: () => ({}),
          setApplicationMenu: () => undefined,
        },
        protocol: {
          registerSchemesAsPrivileged: () => undefined,
        },
        safeStorage: {
          decryptString: () => '',
          encryptString: (value: string) => Buffer.from(value),
          isEncryptionAvailable: () => true,
        },
        shell: {
          openExternal: async () => undefined,
          openPath: async () => '',
          showItemInFolder: () => undefined,
          trashItem: async (targetPath: string) => {
            await rm(targetPath, { force: true, recursive: true })
          },
        },
      },
      'electron-updater': { autoUpdater: { checkForUpdatesAndNotify: async () => undefined } },
      'node-pty': {
        spawn: () => {
          throw new Error('node-pty should not be used in filesystem IPC tests')
        },
      },
      '@vscode/ripgrep': { rgPath: 'rg' },
      // The build stamp is minted by a Vite plugin at build time, so there is no
      // module on disk for the test bundle's `require` to find. Stubbing it here
      // keeps this test's existing interception the single place main's build-only
      // dependencies are stood in for.
      'virtual:sprintengine-build-stamp': {
        buildStamp: {
          commit: null,
          source: 'unavailable' as const,
          builtAt: '2026-01-01T00:00:00.000Z',
          mode: 'development' as const,
        },
      },
    })

    try {
      // The app proper, which is what registers the IPC handlers; the entry
      // (index.ts) only installs the Electron platform (as `standIn` does over
      // the stand-in), takes the single-instance lock and loads it.
      await import('../../app-main')
    } finally {
      restoreModules()
    }

    const getHandler = (channel: string): ((...args: unknown[]) => Promise<unknown>) => {
      const handler = ipcHandlers.get(channel)
      assert.ok(handler, `${channel} handler should be registered`)
      return async (...args) => handler(null, ...args) as Promise<unknown>
    }

    return {
      writeFile: async (filePath, content) => {
        await getHandler('fs:writefile')(filePath, content)
      },
      rename: async (sourcePath, nextName) => {
        return (await getHandler('fs:rename')(sourcePath, nextName)) as string
      },
      copy: async (sourcePath, destinationDir) => {
        return (await getHandler('fs:copy')(sourcePath, destinationDir)) as string
      },
      delete: async (targetPath) => {
        await getHandler('fs:delete')(targetPath)
      },
    }
  }

  function command(
    type: MobileControlCommand['type'],
    payload: MobileControlCommand['payload'],
    overrides: Partial<MobileControlCommand> = {},
  ): MobileControlCommand {
    return {
      protocolVersion: mobileControlProtocolVersion,
      commandId: 'cmd_1',
      type,
      issuedAt: now.toISOString(),
      deviceId: 'device_1',
      idempotencyKey: 'mobile:device_1:cmd_1',
      payload,
      ...overrides,
    } as MobileControlCommand
  }

  await suiteRun
})
