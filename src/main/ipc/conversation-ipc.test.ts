import assert from 'node:assert/strict'

import { createHarnessCliCheck, registerConversationIpc, type HarnessCliCheckDeps } from './conversation-ipc'
import {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENT_BYTES,
} from '../../shared/conversation-attachments'
import type { ConversationIpcHandlers } from './conversation-ipc'
import type {
  CliAvailability,
  CliDetectResult,
  ConversationProviderListResult,
  ConversationSecretStatusResult,
} from '../../shared/electron-api'
import type {
  ConversationEvent,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSessionFrame,
  ConversationStartSessionResult,
} from '../../shared/conversation-runtime'
import { test } from 'vitest'

test('conversation-ipc', async () => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown

  function createIpcMain(): { handle(channel: string, handler: Handler): void; handlers: Map<string, Handler> } {
    const handlers = new Map<string, Handler>()
    return {
      handle(channel, handler): void {
        handlers.set(channel, handler)
      },
      handlers,
    }
  }

  async function main(): Promise<void> {
    await testRegistersProviderListChannel()
    await testRegistersSecretChannels()
    await testRegistersSessionChannelsAndEventSubscription()
    await testSendTurnValidatesImageAttachments()
    await testAttachmentLimitsAreTheSharedOnes()
    await testSendTurnCarriesASteer()
    await testSetPermissionValidatesThePreset()
    await testFailureIsExplicit()

    console.log('conversation-ipc tests passed')
  }

  async function testRegistersProviderListChannel(): Promise<void> {
    const response: ConversationProviderListResult = {
      ok: true,
      providers: [
        {
          id: 'openai-compatible',
          displayName: 'OpenAI Compatible',
          source: 'bundled',
          version: 1,
          providerType: 'model-provider',
          models: [{ id: 'gpt-5' }],
          supportsDynamicModels: false,
          credentialSource: 'api-key',
          adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
        },
      ],
    }

    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => response,
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      ...runtimeHandlerStubs(),
    })

    const handler = ipcMain.handlers.get('conversation:providers:list')
    assert.ok(handler, 'conversation:providers:list should be registered')
    assert.deepEqual(await handler?.(null), response)
  }

  async function testRegistersSecretChannels(): Promise<void> {
    const calls: string[] = []
    const response: ConversationSecretStatusResult = {
      ok: true,
      status: {
        providerId: 'openai-compatible',
        configured: true,
        source: 'settings',
        persistence: 'encrypted',
        encryptionAvailable: true,
        label: 'API key',
      },
    }

    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => ({ ok: true, providers: [] }),
      getSecretStatus: async (input) => {
        calls.push(`status:${input.providerId}`)
        return response
      },
      setSecret: async (input) => {
        calls.push(`set:${input.providerId}:${input.value}`)
        return response
      },
      clearSecret: async (input) => {
        calls.push(`clear:${input.providerId}`)
        return response
      },
      ...runtimeHandlerStubs(),
    })

    assert.deepEqual(
      await ipcMain.handlers.get('conversation:secrets:status')?.(null, { providerId: 'openai-compatible' }),
      response,
    )
    assert.deepEqual(
      await ipcMain.handlers.get('conversation:secrets:set')?.(null, {
        providerId: 'openai-compatible',
        value: 'sk-test-secret',
      }),
      response,
    )
    assert.deepEqual(
      await ipcMain.handlers.get('conversation:secrets:clear')?.(null, { providerId: 'openai-compatible' }),
      response,
    )
    assert.deepEqual(calls, [
      'status:openai-compatible',
      'set:openai-compatible:sk-test-secret',
      'clear:openai-compatible',
    ])
  }

  async function testRegistersSessionChannelsAndEventSubscription(): Promise<void> {
    const calls: string[] = []
    const runtimeListeners: Array<(event: ConversationEvent) => void> = []
    let unsubscribed = 0
    const startResult: ConversationStartSessionResult = {
      ok: true,
      session: {
        sessionId: 'conv_1',
        workspaceId: 'workspace',
        agentId: 'agent',
        providerId: 'mock-provider',
        modelId: 'mock-model',
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      },
    }
    const actionResult: ConversationSessionActionResult = startResult
    const sent: { channel: string; payload: unknown }[] = []
    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => ({ ok: true, providers: [] }),
      listProviderModels: async () => ({ ok: true, models: [] }),
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      startSession: async (input) => {
        calls.push(`start:${input.providerId}`)
        return startResult
      },
      sendTurn: async (input) => {
        calls.push(`send:${input.sessionId}:${input.message}`)
        return actionResult
      },
      interrupt: async (input) => {
        calls.push(`interrupt:${input.sessionId}`)
        return actionResult
      },
      respondToRequest: async (input) => {
        calls.push(`respond:${input.sessionId}:${input.requestId}:${input.approved}`)
        return actionResult
      },
      setPermission: async (input) => {
        calls.push(`permission:${input.sessionId}:${input.permissionPreset}`)
        return actionResult
      },
      readTranscript: async () => ({ ok: false, message: 'unused' }),
      stopSession: async (input) => {
        calls.push(`stop:${input.sessionId}`)
        return actionResult
      },
      suspendSession: async (input) => {
        calls.push(`suspend:${input.sessionId}`)
        return actionResult
      },
      terminalHandoff: async (input) => {
        calls.push(
          `terminal-handoff:${'sessionId' in input ? input.sessionId : `${input.workspaceId}/${input.agentId}`}`,
        )
        return { ok: true, workspaceId: 'workspace', agentId: 'agent-claude-code-abc123' }
      },
      listSessions: () => ({ ok: true, sessions: [startResult.session] }),
      onEvent: (cb) => {
        runtimeListeners.push(cb)
        return () => {
          unsubscribed += 1
          const index = runtimeListeners.indexOf(cb)
          if (index >= 0) runtimeListeners.splice(index, 1)
        }
      },
    })

    await ipcMain.handlers.get('conversation:sessions:start')?.(null, {
      workspaceRoot: '/workspace',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'mock-provider',
      modelId: 'mock-model',
    })
    await ipcMain.handlers.get('conversation:sessions:send-turn')?.(null, { sessionId: 'conv_1', message: 'hello' })
    await ipcMain.handlers.get('conversation:sessions:interrupt')?.(null, { sessionId: 'conv_1' })
    await ipcMain.handlers.get('conversation:sessions:respond-to-request')?.(null, {
      sessionId: 'conv_1',
      requestId: 'approval_1',
      approved: true,
    })
    await ipcMain.handlers.get('conversation:sessions:set-permission')?.(null, {
      sessionId: 'conv_1',
      permissionPreset: 'bypass',
    })
    await ipcMain.handlers.get('conversation:sessions:stop')?.(null, { sessionId: 'conv_1' })
    await ipcMain.handlers.get('conversation:sessions:suspend')?.(null, { sessionId: 'conv_1' })
    assert.deepEqual(await ipcMain.handlers.get('conversation:sessions:suspend')?.(null, {}), {
      ok: false,
      message: 'sessionId is required.',
    })
    assert.deepEqual(
      await ipcMain.handlers.get('conversation:sessions:terminal-handoff')?.(null, { sessionId: 'conv_1' }),
      {
        ok: true,
        workspaceId: 'workspace',
        agentId: 'agent-claude-code-abc123',
      },
    )
    // A tab's menu names the chat, not a session.
    assert.equal(
      (
        (await ipcMain.handlers.get('conversation:sessions:terminal-handoff')?.(null, {
          workspaceId: 'workspace',
          agentId: 'agent',
        })) as { ok: boolean }
      ).ok,
      true,
    )
    assert.deepEqual(await ipcMain.handlers.get('conversation:sessions:terminal-handoff')?.(null, {}), {
      ok: false,
      message: 'sessionId is required.',
    })
    assert.deepEqual(await ipcMain.handlers.get('conversation:sessions:list')?.(null, {}), {
      ok: true,
      sessions: [startResult.session],
    })

    const sender = createConversationSender(sent)
    const firstSubscription = await ipcMain.handlers.get('conversation:events:subscribe')?.({ sender })
    assert.deepEqual(firstSubscription, { ok: true, subscriptionId: 'conversation-subscription-1' })
    assert.equal(runtimeListeners.length, 1)
    assert.equal(sender.destroyedListenerCount(), 1)
    runtimeListeners[0]?.({
      id: 'event_1',
      sessionId: 'conv_1',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'mock-provider',
      modelId: 'mock-model',
      type: 'session_ready',
      createdAt: 1,
    })
    assert.equal(sent[0]?.channel, 'conversation:event')
    assert.deepEqual(
      await ipcMain.handlers.get('conversation:events:unsubscribe')?.(null, {
        subscriptionId: 'conversation-subscription-1',
      }),
      { ok: true },
    )
    assert.equal(runtimeListeners.length, 0)
    assert.equal(unsubscribed, 1)
    assert.equal(sender.destroyedListenerCount(), 0)

    const secondSubscription = await ipcMain.handlers.get('conversation:events:subscribe')?.({ sender })
    assert.deepEqual(secondSubscription, { ok: true, subscriptionId: 'conversation-subscription-2' })
    assert.equal(runtimeListeners.length, 1)
    assert.equal(sender.destroyedListenerCount(), 1)
    assert.deepEqual(
      await ipcMain.handlers.get('conversation:events:unsubscribe')?.(null, {
        subscriptionId: 'conversation-subscription-2',
      }),
      { ok: true },
    )
    assert.equal(runtimeListeners.length, 0)
    assert.equal(unsubscribed, 2)
    assert.equal(sender.destroyedListenerCount(), 0)
    assert.deepEqual(calls, [
      'start:mock-provider',
      'send:conv_1:hello',
      'interrupt:conv_1',
      'respond:conv_1:approval_1:true',
      'permission:conv_1:bypass',
      'stop:conv_1',
      'suspend:conv_1',
      'terminal-handoff:conv_1',
      'terminal-handoff:workspace/agent',
    ])
  }

  // The set-permission boundary accepts the two presets, reads a retired one
  // from an older window as `none`, and keeps anything else from the runtime.
  async function testSetPermissionValidatesThePreset(): Promise<void> {
    const captured: string[] = []
    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => ({ ok: true, providers: [] }),
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      ...runtimeHandlerStubs(),
      setPermission: async (input) => {
        captured.push(input.permissionPreset)
        return { ok: true, session: { ...SENT_SESSION, permissionPreset: input.permissionPreset } }
      },
    })
    const setPermission = ipcMain.handlers.get('conversation:sessions:set-permission')
    assert.ok(setPermission, 'conversation:sessions:set-permission should be registered')

    assert.deepEqual(await setPermission?.(null, { sessionId: 'conv_1', permissionPreset: 'bypass' }), {
      ok: true,
      session: { ...SENT_SESSION, permissionPreset: 'bypass' },
    })
    for (const [sent, preset] of [
      ['manual', 'manual'],
      ['auto', 'auto'],
      ['default', 'manual'],
    ] as const)
      assert.deepEqual(await setPermission?.(null, { sessionId: 'conv_1', permissionPreset: sent }), {
        ok: true,
        session: { ...SENT_SESSION, permissionPreset: preset },
      })
    assert.deepEqual(captured, ['bypass', 'manual', 'auto', 'manual'])

    const presetError = { ok: false, message: 'permissionPreset must be none or manual or auto or bypass.' }
    assert.deepEqual(await setPermission?.(null, { sessionId: 'conv_1', permissionPreset: 'yolo' }), presetError)
    assert.deepEqual(await setPermission?.(null, { sessionId: 'conv_1' }), presetError)
    assert.deepEqual(await setPermission?.(null, { permissionPreset: 'none' }), {
      ok: false,
      message: 'sessionId is required.',
    })
    assert.equal(captured.length, 4, 'no invalid preset reached the runtime')
  }

  // The send-turn boundary guards image attachments: valid images pass through
  // (with a server-derived byteLength), bad media type / size / encoding / count
  // are rejected with a clear message before the runtime is touched.
  async function testSendTurnValidatesImageAttachments(): Promise<void> {
    const captured: ConversationSendTurnInput[] = []
    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => ({ ok: true, providers: [] }),
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      ...runtimeHandlerStubs(),
      sendTurn: async (input) => {
        captured.push(input)
        return { ok: true, session: SENT_SESSION }
      },
    })
    const sendTurn = ipcMain.handlers.get('conversation:sessions:send-turn')

    // A valid PNG attachment flows through; byteLength is derived from the data.
    const okResult = await sendTurn?.(null, {
      sessionId: 'conv_1',
      message: 'look',
      attachments: [{ id: 'img-1', mediaType: 'image/png', dataBase64: 'Zm9v', name: 'shot.png', byteLength: 999 }],
    })
    assert.deepEqual(okResult, { ok: true, session: SENT_SESSION })
    assert.equal(captured.length, 1)
    assert.deepEqual(captured[0]?.attachments, [
      {
        id: 'img-1',
        mediaType: 'image/png',
        dataBase64: 'Zm9v',
        name: 'shot.png',
        byteLength: 3,
      },
    ])

    // Image-only sends (empty text) are allowed at the boundary; the runtime owns
    // the payload-required check.
    await sendTurn?.(null, {
      sessionId: 'conv_1',
      message: '',
      attachments: [{ id: 'img-2', mediaType: 'image/jpeg', dataBase64: 'YmFy' }],
    })
    assert.equal(captured[1]?.attachments?.length, 1)

    const rejects: Array<[string, unknown]> = [
      ['bad media type', [{ id: 'x', mediaType: 'image/tiff', dataBase64: 'Zm9v' }]],
      ['non-base64 data', [{ id: 'x', mediaType: 'image/png', dataBase64: 'not base64!!' }]],
      ['oversized image', [{ id: 'x', mediaType: 'image/png', dataBase64: 'A'.repeat(8 * 1024 * 1024) }]],
      [
        'too many attachments',
        Array.from({ length: 17 }, (_, i) => ({ id: `x${i}`, mediaType: 'image/png', dataBase64: 'Zm9v' })),
      ],
      ['non-array attachments', { id: 'x', mediaType: 'image/png', dataBase64: 'Zm9v' }],
    ]
    for (const [label, attachments] of rejects) {
      const result = (await sendTurn?.(null, { sessionId: 'conv_1', message: 'hi', attachments })) as { ok: boolean }
      assert.equal(result.ok, false, `expected rejection: ${label}`)
    }
  }

  // The boundary's accepted set is the shared declaration the composer stages
  // against (1810), not a second copy of the same values. Asserted through the
  // real handler: every shared media type passes, the cap admits exactly
  // MAX_ATTACHMENTS_PER_TURN, and the ceiling admits exactly MAX_ATTACHMENT_BYTES
  // — so a limit raised on one side and not the other fails here rather than
  // mid-send in front of the user.
  async function testAttachmentLimitsAreTheSharedOnes(): Promise<void> {
    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => ({ ok: true, providers: [] }),
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      ...runtimeHandlerStubs(),
      sendTurn: async () => ({ ok: true, session: SENT_SESSION }),
    })
    const sendTurn = ipcMain.handlers.get('conversation:sessions:send-turn')
    const send = async (attachments: unknown): Promise<boolean> =>
      ((await sendTurn?.(null, { sessionId: 'conv_1', message: 'hi', attachments })) as { ok: boolean }).ok

    for (const mediaType of ATTACHABLE_IMAGE_TYPES) {
      assert.equal(await send([{ id: 'x', mediaType, dataBase64: 'Zm9v' }]), true, `${mediaType} is accepted`)
    }
    assert.equal(
      await send([{ id: 'x', mediaType: 'image/svg+xml', dataBase64: 'Zm9v' }]),
      false,
      'a type outside the shared set is refused, so the composer must not offer it',
    )

    const image = (i: number) => ({ id: `x${i}`, mediaType: 'image/png', dataBase64: 'Zm9v' })
    assert.equal(
      await send(Array.from({ length: MAX_ATTACHMENTS_PER_TURN }, (_, i) => image(i))),
      true,
      'a turn filled exactly to the shared cap passes',
    )
    assert.equal(
      await send(Array.from({ length: MAX_ATTACHMENTS_PER_TURN + 1 }, (_, i) => image(i))),
      false,
      'one past the shared cap is refused',
    )

    assert.equal(
      await send([{ id: 'x', mediaType: 'image/png', dataBase64: base64OfBytes(MAX_ATTACHMENT_BYTES) }]),
      true,
      'an image exactly at the shared ceiling fits',
    )
    assert.equal(
      await send([{ id: 'x', mediaType: 'image/png', dataBase64: base64OfBytes(MAX_ATTACHMENT_BYTES + 1) }]),
      false,
      'one byte past the shared ceiling is refused',
    )
  }

  // A steer crosses the boundary as a strict boolean; anything else is refused
  // rather than read as truthy, and an ordinary send carries no flag at all.
  async function testSendTurnCarriesASteer(): Promise<void> {
    const captured: ConversationSendTurnInput[] = []
    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => ({ ok: true, providers: [] }),
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      ...runtimeHandlerStubs(),
      sendTurn: async (input) => {
        captured.push(input)
        return { ok: true, session: SENT_SESSION }
      },
    })
    const sendTurn = ipcMain.handlers.get('conversation:sessions:send-turn')
    await sendTurn?.(null, { sessionId: 'conv_1', message: 'use the other file', steer: true })
    await sendTurn?.(null, { sessionId: 'conv_1', message: 'plain' })
    assert.equal(captured[0]?.steer, true)
    assert.equal('steer' in (captured[1] ?? {}), false)
    const refused = (await sendTurn?.(null, { sessionId: 'conv_1', message: 'x', steer: 'yes' })) as { ok: boolean }
    assert.equal(refused.ok, false)
    assert.equal(captured.length, 2)
  }

  // Well-formed base64 that decodes to exactly `bytes`: 4 chars per 3 bytes, with
  // '=' padding dropping the remainder. Derived rather than hardcoded so the byte
  // assertions stay exact if the ceiling moves.
  function base64OfBytes(bytes: number): string {
    const groups = Math.ceil(bytes / 3)
    const padding = groups * 3 - bytes
    return 'A'.repeat(groups * 4 - padding) + '='.repeat(padding)
  }

  const SENT_SESSION = {
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
    status: 'ready' as const,
    createdAt: 1,
    updatedAt: 1,
  }

  function createConversationSender(sent: { channel: string; payload: unknown }[]): {
    isDestroyed(): boolean
    send(channel: string, payload: unknown): void
    once(channel: 'destroyed', listener: () => void): void
    on(channel: 'did-navigate', listener: () => void): void
    removeListener(channel: 'destroyed', listener: () => void): void
    destroyedListenerCount(): number
  } {
    const destroyedListeners = new Set<() => void>()
    return {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
      once: (_channel, listener) => {
        destroyedListeners.add(listener)
      },
      on: () => undefined,
      removeListener: (_channel, listener) => {
        destroyedListeners.delete(listener)
      },
      destroyedListenerCount: () => destroyedListeners.size,
    }
  }

  async function testFailureIsExplicit(): Promise<void> {
    const ipcMain = createIpcMain()
    registerConversationIpc(ipcMain as unknown as Parameters<typeof registerConversationIpc>[0], {
      listProviders: async () => {
        throw new Error('provider registry load failed')
      },
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      ...runtimeHandlerStubs(),
    })

    const result = (await ipcMain.handlers.get('conversation:providers:list')?.(null)) as ConversationProviderListResult
    assert.deepEqual(result, { ok: false, message: 'provider registry load failed' })
    assert.deepEqual(await ipcMain.handlers.get('conversation:secrets:status')?.(null, null), {
      ok: false,
      message: 'providerId is required.',
    })
    assert.deepEqual(await ipcMain.handlers.get('conversation:events:unsubscribe')?.(null, null), {
      ok: false,
      message: 'subscriptionId is required.',
    })
  }

  function runtimeHandlerStubs(): Pick<
    ConversationIpcHandlers,
    | 'listProviderModels'
    | 'startSession'
    | 'sendTurn'
    | 'interrupt'
    | 'respondToRequest'
    | 'setPermission'
    | 'stopSession'
    | 'listSessions'
    | 'readTranscript'
    | 'onEvent'
  > {
    return {
      listProviderModels: async () => ({ ok: true, models: [] }),
      startSession: async () => ({ ok: false, message: 'unused' }),
      sendTurn: async () => ({ ok: false, message: 'unused' }),
      interrupt: async () => ({ ok: false, message: 'unused' }),
      respondToRequest: async () => ({ ok: false, message: 'unused' }),
      setPermission: async () => ({ ok: false, message: 'unused' }),
      stopSession: async () => ({ ok: false, message: 'unused' }),
      listSessions: () => ({ ok: true, sessions: [] }),
      readTranscript: async () => ({ ok: false, message: 'unused' }),
      onEvent: () => () => undefined,
    }
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exit(1)
  })

  await suiteRun
})

type Handler = (event: unknown, ...args: unknown[]) => unknown

function registerWithRuntimeListeners(extra: Partial<ConversationIpcHandlers> = {}) {
  const handlers = new Map<string, Handler>()
  const listeners = new Set<(event: ConversationEvent) => void>()
  const scoped = new Set<(frame: ConversationSessionFrame) => void>()
  registerConversationIpc(
    { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) } as unknown as Parameters<
      typeof registerConversationIpc
    >[0],
    {
      listProviders: async () => ({ ok: true, providers: [] }),
      getSecretStatus: async () => ({ ok: false, message: 'unused' }),
      setSecret: async () => ({ ok: false, message: 'unused' }),
      clearSecret: async () => ({ ok: false, message: 'unused' }),
      listProviderModels: async () => ({ ok: true, models: [] }),
      startSession: async () => ({ ok: false, message: 'unused' }),
      sendTurn: async () => ({ ok: false, message: 'unused' }),
      interrupt: async () => ({ ok: false, message: 'unused' }),
      respondToRequest: async () => ({ ok: false, message: 'unused' }),
      setPermission: async () => ({ ok: false, message: 'unused' }),
      stopSession: async () => ({ ok: false, message: 'unused' }),
      listSessions: () => ({ ok: true, sessions: [] }),
      readTranscript: async () => ({ ok: false, message: 'unused' }),
      onEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      subscribe: (_input, listener) => {
        scoped.add(listener)
        return { dispose: () => scoped.delete(listener), ready: Promise.resolve() }
      },
      ...extra,
    },
  )
  const sent: Array<{ channel: string; payload: unknown }> = []
  const navigation = new Set<() => void>()
  const sender = {
    id: 7,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    once: () => undefined,
    on: (channel: string, listener: () => void) => {
      if (channel === 'did-navigate') navigation.add(listener)
    },
    removeListener: () => undefined,
  }
  return {
    handlers,
    listeners,
    scoped,
    sent,
    sender,
    navigate: () => {
      for (const listener of navigation) listener()
    },
    navigationListeners: () => navigation.size,
  }
}

function conversationEvent(type: ConversationEvent['type'], payload?: Record<string, unknown>): ConversationEvent {
  return {
    id: `event_${type}`,
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
    type,
    createdAt: 1,
    ...(payload ? { payload } : {}),
  }
}

test('the all-conversations channel carries lifecycle events and never the token stream', async () => {
  const ipc = registerWithRuntimeListeners()
  await ipc.handlers.get('conversation:events:subscribe')!({ sender: ipc.sender })
  const publish = (event: ConversationEvent) => {
    for (const listener of ipc.listeners) listener(event)
  }
  publish(conversationEvent('user_message', { turnId: 't', text: 'hi' }))
  publish(conversationEvent('turn_started', { turnId: 't' }))
  publish(conversationEvent('content_delta', { turnId: 't', text: 'Hel' }))
  publish(conversationEvent('reasoning_delta', { turnId: 't', text: 'thinking' }))
  publish(conversationEvent('tool_started', { turnId: 't', toolUseId: 'tool', name: 'Bash' }))
  publish(conversationEvent('tool_output', { turnId: 't', toolUseId: 'tool', partial: true, output: 'line' }))
  publish(conversationEvent('tool_output', { turnId: 't', toolUseId: 'tool', output: 'done' }))
  publish(conversationEvent('subagent_status', { toolUseId: 'task', status: 'running' }))
  publish(conversationEvent('turn_completed', { turnId: 't' }))
  publish(conversationEvent('session_updated', { conversationTitle: 'Title' }))
  assert.deepEqual(
    ipc.sent.map(({ channel, payload }) => [channel, (payload as ConversationEvent).type]),
    [
      ['conversation:event', 'user_message'],
      ['conversation:event', 'turn_started'],
      ['conversation:event', 'tool_started'],
      ['conversation:event', 'tool_output'],
      ['conversation:event', 'subagent_status'],
      ['conversation:event', 'turn_completed'],
      ['conversation:event', 'session_updated'],
    ],
  )
  // Which chat moved and how, without the step itself: its reader asks for
  // the sessions list again, and a tool's result is no business of every window's.
  const ended = ipc.sent[3]?.payload as ConversationEvent
  assert.equal(ended.workspaceId, 'workspace')
  assert.equal(ended.payload, undefined)
})

test('a reload ends the subscriptions the page it replaced held', async () => {
  const ipc = registerWithRuntimeListeners()
  const key = { workspaceRoot: '/workspace', workspaceId: 'workspace', agentId: 'agent' }
  await ipc.handlers.get('conversation:events:subscribe')!({ sender: ipc.sender })
  await ipc.handlers.get('conversation:session:subscribe')!({ sender: ipc.sender }, { subscriptionId: 'pane', key })
  assert.equal(ipc.listeners.size, 1)
  assert.equal(ipc.scoped.size, 1)
  // One navigation listener per webContents, however many subscriptions it holds.
  assert.equal(ipc.navigationListeners(), 1)

  ipc.navigate()
  assert.equal(ipc.listeners.size, 0)
  assert.equal(ipc.scoped.size, 0)

  // The reloaded page subscribes afresh and is served once.
  await ipc.handlers.get('conversation:events:subscribe')!({ sender: ipc.sender })
  await ipc.handlers.get('conversation:session:subscribe')!({ sender: ipc.sender }, { subscriptionId: 'pane', key })
  assert.equal(ipc.listeners.size, 1)
  assert.equal(ipc.scoped.size, 1)
  assert.equal(ipc.navigationListeners(), 1)
  for (const listener of ipc.listeners) listener(conversationEvent('turn_completed', { turnId: 't' }))
  assert.equal(ipc.sent.length, 1)
})

test('what the renderer reads off the all-conversations channel all arrives, with its workspace', async () => {
  const ipc = registerWithRuntimeListeners()
  await ipc.handlers.get('conversation:events:subscribe')!({ sender: ipc.sender })
  const needed: Array<[ConversationEvent['type'], Record<string, unknown>?]> = [
    ['session_started'],
    ['session_ready'],
    ['session_updated', { providerSessionId: 'provider' }],
    ['session_closed'],
    ['user_message', { turnId: 't', text: 'hi' }],
    ['turn_started', { turnId: 't' }],
    ['approval_requested', { turnId: 't', requestId: 'r' }],
    ['approval_resolved', { turnId: 't', requestId: 'r', approved: true }],
    ['tool_output', { turnId: 't', toolUseId: 'tool', output: 'final' }],
    ['turn_completed', { turnId: 't' }],
    ['turn_failed', { turnId: 't', reason: 'interrupted' }],
  ]
  for (const [type, payload] of needed)
    for (const listener of ipc.listeners) listener({ ...conversationEvent(type, payload), createdAt: 42 })
  const received = ipc.sent.map(({ payload }) => payload as ConversationEvent)
  assert.deepEqual(
    received.map((event) => event.type),
    needed.map(([type]) => type),
  )
  assert.ok(received.every((event) => event.workspaceId === 'workspace' && event.createdAt === 42))
})

// The provider list every opening chat asks for, read off the app's held CLI
// availability rather than a `--version` per harness CLI per ask.
function harnessCheck(held: CliAvailability | undefined, found: Partial<CliDetectResult> = {}) {
  const calls = { availability: 0, detect: 0, recorded: [] as CliDetectResult[] }
  let clock = 1_000
  const detected: CliDetectResult = {
    cli: 'codex',
    binary: 'codex',
    installed: false,
    version: null,
    resolvedPath: null,
    hostId: 'local',
    error: null,
    ...found,
  }
  const deps: HarnessCliCheckDeps = {
    availability: async () => {
      calls.availability += 1
      return held
    },
    detect: async () => {
      calls.detect += 1
      return detected
    },
    record: (_runtime, result) => calls.recorded.push(result),
    now: () => clock,
  }
  return { check: createHarnessCliCheck(deps), calls, advance: (ms: number) => (clock += ms) }
}

const INSTALLED: CliAvailability = {
  cli: 'codex',
  installed: true,
  resolvedPath: '/usr/local/bin/codex',
  version: '1.0.0',
}
const MISSING: CliAvailability = { cli: 'codex', installed: false, resolvedPath: null, version: null }

test('a CLI the app already found is listed without a probe, however many chats ask', async () => {
  const { check, calls } = harnessCheck(INSTALLED)
  const answers = await Promise.all([check('codex'), check('codex'), check('codex')])
  assert.deepEqual(answers, [true, true, true])
  assert.equal(calls.detect, 0)
})

test('a CLI whose probe could not decide stays listed, with no probe of its own', async () => {
  const { check, calls } = harnessCheck(undefined)
  assert.equal(await check('codex'), true)
  assert.equal(calls.detect, 0)
})

test('a CLI held as missing is looked at again at most every 30 seconds', async () => {
  const { check, calls, advance } = harnessCheck(MISSING)
  assert.deepEqual(await Promise.all([check('codex'), check('codex')]), [false, false])
  assert.equal(calls.detect, 1)
  advance(29_000)
  assert.equal(await check('codex'), false)
  assert.equal(calls.detect, 1)
  advance(2_000)
  assert.equal(await check('codex'), false)
  assert.equal(calls.detect, 2)
})

test('a CLI installed since it was held as missing is listed, and the app learns of it', async () => {
  const { check, calls } = harnessCheck(MISSING, { installed: true, resolvedPath: '/usr/local/bin/codex' })
  assert.equal(await check('codex'), true)
  assert.equal(calls.recorded.length, 1)
  assert.equal(calls.recorded[0].installed, true)
})

test('each command and machine is looked at again on its own', async () => {
  const { check, calls } = harnessCheck(MISSING)
  await check('codex')
  await check('codex', { codex: { command: '/opt/codex' } })
  await check('codex', { codex: { hostId: 'wsl:Ubuntu' } })
  assert.equal(calls.detect, 3)
})

test('a stop for one agent reaches the runtime by its lane, and one that names no lane is refused', async () => {
  const asked: Array<{ sessionId: string; toolUseId: string }> = []
  const ipc = registerWithRuntimeListeners({
    stopSubagent: async (input) => {
      asked.push(input)
      return { ok: false, message: 'That agent is not running any more.' }
    },
  })
  const stop = ipc.handlers.get('conversation:sessions:stop-subagent')!
  assert.deepEqual(await stop(null, { sessionId: 'conv_1', toolUseId: ' toolu_agent ' }), {
    ok: false,
    message: 'That agent is not running any more.',
  })
  assert.deepEqual(asked, [{ sessionId: 'conv_1', toolUseId: 'toolu_agent' }])
  assert.deepEqual(await stop(null, { sessionId: 'conv_1' }), { ok: false, message: 'toolUseId is required.' })
  assert.deepEqual(await stop(null, { toolUseId: 'toolu_agent' }), { ok: false, message: 'sessionId is required.' })
  assert.equal(asked.length, 1)
})

test('a backend that cannot stop one agent says so', async () => {
  const ipc = registerWithRuntimeListeners()
  assert.deepEqual(
    await ipc.handlers.get('conversation:sessions:stop-subagent')!(null, { sessionId: 'conv_1', toolUseId: 'toolu_a' }),
    { ok: false, message: 'Stopping one agent is unavailable.' },
  )
})
