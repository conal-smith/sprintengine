import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import type { ConversationEvent } from '../../shared/conversation-runtime'
import {
  buildUserMessageContent,
  CLAUDE_AGENT_PROVIDER_ID,
  CLAUDE_AGENT_SESSION_ENV_KEY,
  createClaudeAgentProvider,
  mapSdkMessage,
  resultContextWindow,
  stripAnthropicAuthEnv,
  STRIPPED_ANTHROPIC_AUTH_ENV_KEYS,
  summarizeToolInput,
  sweepStaleSkillPlugins,
  type ClaudeAgentProviderAdapter,
} from './claude-agent-provider'
import type { MockAdapterTurnInput } from './mock-conversation-provider'
import { ConversationRuntime } from '../conversation-runtime'
import {
  conversationCommandsFor,
  onConversationCommandsChanged,
  publishConversationCommands,
} from '../conversation-commands/registry'
import { test } from 'vitest'

test('claude-agent-provider', async () => {
  async function main(): Promise<void> {
    testSummarizeToolInput()
    testStripAnthropicAuthEnv()
    testBuildUserMessageContent()
    testMapSdkMessageCoversCanonicalShapes()
    await testTurnStreamsDeltasToolsUsageAndCompletion()
    await testImageAttachmentsBecomeMultimodalContent()
    await testNativeSkillSelectionReachesSdk()
    await testWslChatRunsItsChildInTheDistribution()
    await testAskModeReadOnlyAndEffort()
    await testModeSwitchesReachTheLiveChild()
    await testLiveModelSwitch()
    await testResumeCursorIsPassedToTheSdkAndSessionUpdatesEmit()
    await testCanUseToolApprovalFlowApproveAndDeny()
    await testBypassAnswersSubagentAsksButKeepsSafetyAndRuleAsks()
    await testDeniedToolResultReadsAsDeclined()
    await testAskUserQuestionBecomesQuestionCardAndAnswersFlowBack()
    await testExitPlanModeBecomesPlanCard()
    await testPermissionPresetMapsToSdkPermissionMode()
    await testLivePermissionPresetReachesTheChildAndSurvivesRespawn()
    await testNoFlagWaitsForABackgroundAgentBeforeReplacingTheChild()
    await testNoFlagWaitsForAMonitorBeforeReplacingTheChild()
    await testStopBetweenTurnsEndsTheMonitorAndKeepsTheChild()
    await testAbortSignalEndsTheTurnStream()
    await testSpawnFailureSurfacesAsTurnFailed()
    await testStopDuringSpawnStartsNoChild()
    await testSuspendDuringSpawnStartsNoChild()
    await testDisposeChildKeepsSessionAndCursorForRespawn()
    await testToolAfterResultOpensContinuationInsteadOfDenying()
    await testSubagentStepsAfterResultRideTheSessionChannelWithoutATurn()
    await testAskUserQuestionAfterResultReachesTheUserAndAnswersFlowBack()
    await testTurnTakeoverEndsTheReplacedContinuationQueue()

    console.log('claude-agent-provider tests passed')
  }

  // ── Fake SDK plumbing ────────────────────────────────────────────────────────

  type FakeSdkMessage = Record<string, unknown>

  class FakeMessageQueue {
    private readonly queue: FakeSdkMessage[] = []
    private readonly resolvers: Array<(result: IteratorResult<FakeSdkMessage>) => void> = []
    private ended = false

    push(message: FakeSdkMessage): void {
      if (this.ended) return
      const resolve = this.resolvers.shift()
      if (resolve) resolve({ value: message, done: false })
      else this.queue.push(message)
    }

    end(): void {
      if (this.ended) return
      this.ended = true
      for (const resolve of this.resolvers.splice(0)) resolve({ value: undefined as never, done: true })
    }

    [Symbol.asyncIterator](): AsyncIterator<FakeSdkMessage> {
      return {
        next: (): Promise<IteratorResult<FakeSdkMessage>> => {
          const value = this.queue.shift()
          if (value !== undefined) return Promise.resolve({ value, done: false })
          if (this.ended) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((resolve) => this.resolvers.push(resolve))
        },
      }
    }
  }

  type FakeQueryContext = {
    options: Record<string, unknown>
    emit: (message: FakeSdkMessage) => void
    end: () => void
    interrupted: () => boolean
  }

  type FakeQueryHandler = (userMessage: Record<string, unknown>, context: FakeQueryContext) => void | Promise<void>

  // Live control requests the fake child records. `onSetPermissionMode` may throw
  // to stand in for a CLI that refuses the mode.
  type FakeSdkHooks = {
    onSetPermissionMode?: (mode: string) => void
  }

  function createFakeSdk(
    handler: FakeQueryHandler,
    hooks: FakeSdkHooks = {},
  ): {
    loadQuery: () => Promise<never>
    capturedOptions: Record<string, unknown>[]
    permissionModes: string[]
    models: Array<string | undefined>
    stoppedTasks: string[]
  } {
    const capturedOptions: Record<string, unknown>[] = []
    const permissionModes: string[] = []
    const models: Array<string | undefined> = []
    const stoppedTasks: string[] = []
    const queryFn = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
      capturedOptions.push(params.options)
      const output = new FakeMessageQueue()
      let interrupted = false
      const context: FakeQueryContext = {
        options: params.options,
        emit: (message) => output.push(message),
        end: () => output.end(),
        interrupted: () => interrupted,
      }
      void (async () => {
        for await (const userMessage of params.prompt) {
          await handler(userMessage, context)
        }
      })()
      return {
        [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
        interrupt: async () => {
          interrupted = true
          output.end()
        },
        setPermissionMode: async (mode: string) => {
          hooks.onSetPermissionMode?.(mode)
          permissionModes.push(mode)
        },
        setModel: async (model?: string) => {
          models.push(model)
        },
        // As the CLI does, a stopped task reports its end as stopped.
        stopTask: async (taskId: string) => {
          stoppedTasks.push(taskId)
          output.push({
            type: 'system',
            subtype: 'task_notification',
            session_id: 'fake',
            task_id: taskId,
            status: 'stopped',
            summary: '',
            output_file: '',
          })
        },
      }
    }
    return {
      loadQuery: (() => Promise.resolve(queryFn)) as () => Promise<never>,
      capturedOptions,
      permissionModes,
      models,
      stoppedTasks,
    }
  }

  function createAdapter(
    handler: FakeQueryHandler,
    hooks: FakeSdkHooks = {},
  ): {
    adapter: ClaudeAgentProviderAdapter
    capturedOptions: Record<string, unknown>[]
    permissionModes: string[]
    models: Array<string | undefined>
    stoppedTasks: string[]
  } {
    const sdk = createFakeSdk(handler, hooks)
    const adapter = createClaudeAgentProvider({
      loadQuery: sdk.loadQuery as never,
      resolveExecutable: async () => '/fake/bin/claude',
      buildEnv: (input) => ({ [CLAUDE_AGENT_SESSION_ENV_KEY]: input.sessionId, PATH: '/usr/bin' }),
      now: () => 1000,
    })
    return {
      adapter,
      capturedOptions: sdk.capturedOptions,
      permissionModes: sdk.permissionModes,
      models: sdk.models,
      stoppedTasks: sdk.stoppedTasks,
    }
  }

  // A chat on a WSL machine readies that machine, asks it for its `claude`,
  // and hands the SDK's spawn to the distribution instead of this PC.
  async function testWslChatRunsItsChildInTheDistribution(): Promise<void> {
    const sdk = createFakeSdk((_message, context) => {
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'wsl-chat' })
    })
    const prepared: string[] = []
    const resolvedWith: unknown[] = []
    const spawned: Array<{ target: unknown; request: { command: string; args: string[]; cwd?: string } }> = []
    const adapter = createClaudeAgentProvider({
      loadQuery: sdk.loadQuery as never,
      resolveExecutable: async (cliRuntimes) => {
        resolvedWith.push(cliRuntimes)
        return '/home/dev/.local/bin/claude'
      },
      buildEnv: (input) => ({ [CLAUDE_AGENT_SESSION_ENV_KEY]: input.sessionId }),
      now: () => 1000,
      prepareWslTarget: async (hostId) => {
        prepared.push(hostId)
        return { distro: 'Ubuntu', agentStateSocketPath: '/run/user/1000/agent.sock' }
      },
      spawnWslChild: (target, request) => {
        spawned.push({ target, request })
        const child = new EventEmitter() as EventEmitter & Record<string, unknown>
        Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
        Object.assign(child, { pid: 42, exitCode: null, killed: false, kill: () => true })
        return child as never
      },
    })
    const cliRuntimes = { 'claude-code': { command: '', hostId: 'wsl:Ubuntu' as const } }
    const input = turnInput({ workspaceRoot: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app', cliRuntimes })
    await adapter.startSession(input)
    for await (const _event of await adapter.sendTurn(input)) {
      /* drain the turn */
    }
    assert.deepEqual(prepared, ['wsl:Ubuntu'])
    assert.deepEqual(resolvedWith, [cliRuntimes])
    const options = sdk.capturedOptions[0] as { spawnClaudeCodeProcess: (request: unknown) => unknown }
    options.spawnClaudeCodeProcess({
      command: '/home/dev/.local/bin/claude',
      args: ['--output-format', 'stream-json'],
      cwd: input.workspaceRoot,
      env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
    })
    assert.equal(spawned.length, 1)
    assert.deepEqual(spawned[0].target, { distro: 'Ubuntu', agentStateSocketPath: '/run/user/1000/agent.sock' })
    assert.equal(spawned[0].request.command, '/home/dev/.local/bin/claude')
    assert.deepEqual(spawned[0].request.args, ['--output-format', 'stream-json'])
    assert.equal(adapter.listLiveSessions()[0]?.hasChildProcess, true)
    await adapter.disposeAll()
  }

  async function testNativeSkillSelectionReachesSdk(): Promise<void> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'claude-skills-'))
    try {
      await mkdir(join(workspaceRoot, '.claude', 'skills', 'example'), { recursive: true })
      await writeFile(
        join(workspaceRoot, '.claude', 'skills', 'example', 'SKILL.md'),
        '---\nname: example\n---\nDo it.',
      )
      await writeFile(join(workspaceRoot, 'CLAUDE.md'), 'Run the tests before committing.')
      const prompts: string[] = []
      const { adapter, capturedOptions } = createAdapter((message, context) => {
        prompts.push(JSON.stringify(message))
        context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'native-skills' })
      })
      const input = turnInput({ workspaceRoot })
      await adapter.startSession(input)
      for await (const _event of await adapter.sendTurn({ ...input, skills: ['example'] })) {
        /* drain the turn */
      }
      // The repository's settings files can pre-approve tools and run hooks,
      // so they are never loaded, with or without skills attached.
      assert.deepEqual(capturedOptions[0]?.settingSources, ['user'])
      assert.deepEqual(capturedOptions[0]?.skills, ['attached-skills:example'])
      const plugins = capturedOptions[0]?.plugins as Array<{ type: string; path: string; skipMcpDiscovery?: boolean }>
      assert.equal(plugins.length, 1)
      // `skipMcpDiscovery` becomes `--plugin-dir-no-mcp`, which an older
      // installed Claude Code rejects and exits on.
      assert.equal(plugins[0].skipMcpDiscovery, undefined)
      assert.equal(
        await readFile(join(plugins[0].path, 'skills', 'example', 'SKILL.md'), 'utf8'),
        '---\nname: example\n---\nDo it.',
      )
      assert.match(await readFile(join(plugins[0].path, '.claude-plugin', 'plugin.json'), 'utf8'), /attached-skills/)
      assert.match(prompts.join('\n'), /attached-skills:example/)
      // The project's instructions still reach the model, as prompt text.
      const systemPrompt = capturedOptions[0]?.systemPrompt as { append?: string }
      assert.match(systemPrompt.append ?? '', /Run the tests before committing\./)
      adapter.disposeAll?.()
      // The folder is removed once the child has gone, which a loaded machine
      // can take longer than a fixed beat to reach: wait for it, up to 5 s.
      for (let attempt = 0; attempt < 250; attempt++) {
        if (
          !(await stat(plugins[0].path).then(
            () => true,
            () => false,
          ))
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await assert.rejects(stat(plugins[0].path), 'the staged plugin is removed with its child')

      const plain = createAdapter((_message, context) => {
        context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'no-skills' })
      })
      await plain.adapter.startSession(turnInput())
      for await (const _event of await plain.adapter.sendTurn(turnInput())) {
        /* drain the turn */
      }
      assert.deepEqual(plain.capturedOptions[0]?.settingSources, ['user'])
      assert.equal(plain.capturedOptions[0]?.plugins, undefined)
      plain.adapter.disposeAll?.()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  }

  async function testAskModeReadOnlyAndEffort(): Promise<void> {
    const { adapter, capturedOptions } = createAdapter((_message, context) => {
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'ask-mode' })
    })
    const input = turnInput()
    await adapter.startSession(input)
    for await (const _event of await adapter.sendTurn({ ...input, mode: 'ask', reasoningEffort: 'high' })) {
      /* drain */
    }
    assert.equal(capturedOptions[0]?.permissionMode, 'plan')
    assert.equal(capturedOptions[0]?.effort, 'high')
    const hooks = capturedOptions[0]?.hooks as {
      PreToolUse: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>
    }
    const hook = hooks.PreToolUse[0].hooks[0]
    const denied = (await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })) as {
      hookSpecificOutput?: { permissionDecision: string }
    }
    assert.equal(denied.hookSpecificOutput?.permissionDecision, 'deny')
    assert.deepEqual(await hook({ hook_event_name: 'PreToolUse', tool_name: 'Read' }), {})
    await adapter.setPermissionPreset({ ...input, permissionPreset: 'bypass' })
    for await (const _event of await adapter.sendTurn({ ...input, turnId: 'default', mode: 'default' })) {
      /* drain */
    }
    assert.equal(capturedOptions[1]?.permissionMode, 'bypassPermissions')
    adapter.disposeAll()
  }

  // Plan and ask reach the live child as its native plan mode, and default
  // mode as bypass, over the control channel. Default under `none` is the
  // CLI's own configured mode, which no control-channel mode names, so that
  // one switch still respawns; so does a child that refuses the mode.
  async function testModeSwitchesReachTheLiveChild(): Promise<void> {
    const emitResult = (_message: Record<string, unknown>, context: FakeQueryContext): void => {
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'modes' })
    }
    const send = async (adapter: ClaudeAgentProviderAdapter, turnId: string, mode: MockAdapterTurnInput['mode']) =>
      collect(
        adapter.sendTurn(
          turnInput({ turnId, requestId: `approval_${turnId}`, mode }),
        ) as AsyncIterable<ConversationEvent>,
      )

    const bypass = createAdapter(emitResult)
    await collect(bypass.adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'bypass' }) as ConversationEvent[])
    await send(bypass.adapter, 't1', 'default')
    await send(bypass.adapter, 't2', 'plan')
    await send(bypass.adapter, 't3', 'ask')
    await send(bypass.adapter, 't4', 'default')
    assert.equal(bypass.capturedOptions.length, 1, 'no respawn for a mode switch under bypass')
    assert.deepEqual(bypass.permissionModes, ['plan', 'bypassPermissions'], 'plan to ask needs no switch')
    bypass.adapter.disposeAll()

    const none = createAdapter(emitResult)
    await collect(none.adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'none' }) as ConversationEvent[])
    await send(none.adapter, 't1', 'default')
    const last = await send(none.adapter, 't2', 'ask')
    assert.equal(last.at(-1)?.type, 'turn_completed')
    assert.equal(none.capturedOptions.length, 1, 'entering ask mode keeps the child')
    assert.deepEqual(none.permissionModes, ['plan'])
    await send(none.adapter, 't3', 'default')
    assert.equal(none.capturedOptions.length, 2, 'leaving it under none respawns into the configured default')
    assert.equal(none.capturedOptions[1]?.permissionMode, undefined)
    none.adapter.disposeAll()

    const refusing = createAdapter(emitResult, {
      onSetPermissionMode: () => {
        throw new Error('mode refused')
      },
    })
    await collect(
      refusing.adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'bypass' }) as ConversationEvent[],
    )
    await send(refusing.adapter, 't1', 'default')
    await send(refusing.adapter, 't2', 'plan')
    assert.equal(refusing.capturedOptions.length, 2, 'a refused switch respawns instead')
    assert.equal(refusing.capturedOptions[1]?.permissionMode, 'plan')
    refusing.adapter.disposeAll()
  }

  // A model switch reaches the live query through the SDK's setModel — no
  // respawn — and the CLI's own default row clears the model rather than
  // naming one. With no child yet, the next spawn simply starts on it.
  async function testLiveModelSwitch(): Promise<void> {
    const { adapter, capturedOptions, models } = createAdapter((_message, context) => {
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'switch' })
    })
    assert.equal(adapter.capabilities?.liveModelSwitch, true)
    const input = turnInput()
    await adapter.startSession(input)
    assert.deepEqual(await adapter.setModel({ ...input, nextModelId: 'haiku' }), { ok: true })
    for await (const _event of await adapter.sendTurn({ ...input, modelId: 'haiku' })) {
      /* drain */
    }
    assert.equal(capturedOptions[0]?.model, 'haiku', 'a switch before the child exists starts it on the new model')
    assert.deepEqual(await adapter.setModel({ ...input, nextModelId: 'opus' }), { ok: true })
    assert.deepEqual(await adapter.setModel({ ...input, nextModelId: 'default' }), { ok: true })
    assert.deepEqual(models, ['opus', undefined], 'the live query is switched in place, default clearing it')
    assert.equal(capturedOptions.length, 1, 'no respawn')
    adapter.disposeAll()
  }

  const SESSION_INPUT = {
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot: '/tmp/workspace',
  }

  function turnInput(overrides: Partial<MockAdapterTurnInput> = {}): MockAdapterTurnInput {
    return {
      ...SESSION_INPUT,
      turnId: 'turn_1',
      requestId: 'approval_1',
      message: 'hello',
      ...overrides,
    }
  }

  async function collect(
    stream: AsyncIterable<ConversationEvent> | ConversationEvent[],
    onEvent?: (event: ConversationEvent) => void | Promise<void>,
  ): Promise<ConversationEvent[]> {
    const events: ConversationEvent[] = []
    if (Array.isArray(stream)) return stream
    for await (const event of stream) {
      events.push(event)
      if (onEvent) await onEvent(event)
    }
    return events
  }

  // ── Tests ────────────────────────────────────────────────────────────────────

  function testSummarizeToolInput(): void {
    assert.equal(summarizeToolInput('Bash', { command: 'ls -la' }), 'Bash: ls -la')
    assert.equal(summarizeToolInput('Read', { file_path: '/tmp/a.txt' }), 'Read: /tmp/a.txt')
    assert.equal(summarizeToolInput('Weird', {}), 'Weird')
    assert.ok(summarizeToolInput('Edit', { other: 1 }).startsWith('Edit: {'))
  }

  // The subscription-auth guarantee: the child env this provider builds must
  // never carry an inherited API key or an endpoint redirect (the CLI would
  // prefer them over the stored `claude login` credentials and bill silently).
  function testStripAnthropicAuthEnv(): void {
    const stripped = stripAnthropicAuthEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-inherited',
      ANTHROPIC_AUTH_TOKEN: 'third-party-token',
      ANTHROPIC_BASE_URL: 'https://api.z.ai',
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3',
      SPRINTENGINE_WORKSPACE_ID: 'workspace',
    })
    for (const key of STRIPPED_ANTHROPIC_AUTH_ENV_KEYS) assert.equal(key in stripped, false)
    assert.equal(stripped.PATH, '/usr/bin')
    assert.equal(stripped.SPRINTENGINE_WORKSPACE_ID, 'workspace')
  }

  // Text-only turns keep the plain-string content shape (unchanged path);
  // attaching images turns it into a multimodal block array — text first, then a
  // base64 image block per attachment.
  function testBuildUserMessageContent(): void {
    assert.equal(buildUserMessageContent('hello', undefined), 'hello')
    assert.equal(buildUserMessageContent('hello', []), 'hello')

    const withImage = buildUserMessageContent('look', [
      { id: 'a1', mediaType: 'image/png', dataBase64: 'AAAA', byteLength: 3 },
    ])
    assert.deepEqual(withImage, [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])

    // An image-only send (no text) drops the text block entirely.
    const imageOnly = buildUserMessageContent('', [
      { id: 'a1', mediaType: 'image/jpeg', dataBase64: 'BBBB', byteLength: 3 },
    ])
    assert.deepEqual(imageOnly, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }])
  }

  function testMapSdkMessageCoversCanonicalShapes(): void {
    const state = {
      ...SESSION_INPUT,
      providerSessionId: null as string | null,
      turn: { turnId: 'turn_9' },
    }
    const init = mapSdkMessage(state, {
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-session-1',
      model: 'sonnet',
      apiKeySource: 'none',
    })
    assert.deepEqual(
      init.map((event) => event.type),
      ['session_updated'],
    )
    assert.equal(init[0]?.payload?.providerSessionId, 'sdk-session-1')
    assert.equal(init[0]?.payload?.apiKeySource, 'none')
    assert.equal(state.providerSessionId, 'sdk-session-1')

    // An init that binds an API key must surface the source even when the
    // session cursor did not change (e.g. a respawn resuming the same session).
    const keyedInit = mapSdkMessage(state, {
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-session-1',
      model: 'sonnet',
      apiKeySource: 'ANTHROPIC_API_KEY',
    })
    assert.deepEqual(
      keyedInit.map((event) => event.type),
      ['session_updated'],
    )
    assert.equal(keyedInit[0]?.payload?.apiKeySource, 'ANTHROPIC_API_KEY')

    // The source is written to the transcript unredacted, so a value outside
    // the SDK's labels is dropped instead of carried.
    const oddInit = mapSdkMessage(state, {
      type: 'system',
      subtype: 'init',
      session_id: 'sdk-session-1',
      model: 'sonnet',
      apiKeySource: 'sk-ant-not-a-label',
    })
    assert.deepEqual(oddInit, [])

    const text = mapSdkMessage(state, {
      type: 'stream_event',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
    })
    assert.deepEqual(
      text.map((event) => event.type),
      ['content_delta'],
    )
    assert.equal(text[0]?.payload?.text, 'Hi')
    assert.equal(text[0]?.payload?.turnId, 'turn_9')

    const thinking = mapSdkMessage(state, {
      type: 'stream_event',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    })
    assert.deepEqual(
      thinking.map((event) => event.type),
      ['reasoning_delta'],
    )
    // A new thinking block opens a new paragraph of the run.
    const blockStart = mapSdkMessage(state, {
      type: 'stream_event',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } },
    })
    assert.deepEqual(
      blockStart.map((event) => [event.type, event.payload?.text]),
      [['reasoning_delta', '\n\n']],
    )

    // Subagent text must not leak into the parent's streaming bubble.
    const subagent = mapSdkMessage(state, {
      type: 'stream_event',
      session_id: 'sdk-session-1',
      parent_tool_use_id: 'tool-1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'nested' } },
    })
    assert.deepEqual(subagent, [])

    const toolUse = mapSdkMessage(state, {
      type: 'assistant',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] },
    })
    assert.deepEqual(
      toolUse.map((event) => event.type),
      ['tool_started'],
    )
    assert.equal(toolUse[0]?.payload?.tool, 'Bash')
    assert.equal(toolUse[0]?.payload?.toolCallId, 'tu_1')
    assert.equal('addedLines' in (toolUse[0]?.payload ?? {}), false, 'non-edit tools ship no diff counts')

    // Edit-shaped tools ship added/removed line counts for the work timeline.
    const editUse = mapSdkMessage(state, {
      type: 'assistant',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tu_2',
            name: 'Edit',
            input: { file_path: 'a.ts', old_string: 'x\ny', new_string: 'x\ny\nz' },
          },
          { type: 'tool_use', id: 'tu_3', name: 'Write', input: { file_path: 'b.ts', content: 'one\ntwo\nthree' } },
        ],
      },
    })
    assert.equal(editUse[0]?.payload?.addedLines, 3)
    assert.equal(editUse[0]?.payload?.removedLines, 2)
    assert.equal(editUse[1]?.payload?.addedLines, 3)
    assert.equal('removedLines' in (editUse[1]?.payload ?? {}), false, 'Write has no removable baseline')

    const toolResult = mapSdkMessage(state, {
      type: 'user',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'file-a' }] }] },
    })
    assert.deepEqual(
      toolResult.map((event) => event.type),
      ['tool_output'],
    )
    assert.equal(toolResult[0]?.payload?.output, 'file-a')
    assert.equal('parentToolUseId' in (toolResult[0]?.payload ?? {}), false, 'top-level tools carry no parent link')
    assert.equal('subagentLane' in (toolUse[0]?.payload ?? {}), false, 'ordinary tools are not subagent lanes')

    // The Task call that spawns a subagent is the header of a lane.
    const laneHeader = mapSdkMessage(state, {
      type: 'assistant',
      session_id: 'sdk-session-1',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'task_1',
            name: 'Task',
            input: { subagent_type: 'Explore', description: 'map the router' },
          },
        ],
      },
    })
    assert.deepEqual(
      laneHeader.map((event) => event.type),
      ['tool_started'],
    )
    assert.equal(laneHeader[0]?.payload?.toolCallId, 'task_1')
    assert.equal(laneHeader[0]?.payload?.subagentLane, true)
    assert.equal(laneHeader[0]?.payload?.subagentType, 'Explore')
    assert.equal('parentToolUseId' in (laneHeader[0]?.payload ?? {}), false, 'a top-level lane header has no parent')

    // The subagent's own tool calls are emitted, linked to that lane, with both a
    // start and a completion so the lane shows live status and derivable elapsed
    // time. The lane header closes on its own top-level tool_result.
    const childStart = mapSdkMessage(state, {
      type: 'assistant',
      session_id: 'sdk-session-1',
      parent_tool_use_id: 'task_1',
      message: { content: [{ type: 'tool_use', id: 'child_1', name: 'Grep', input: { pattern: 'router' } }] },
    })
    assert.deepEqual(
      childStart.map((event) => event.type),
      ['tool_started'],
    )
    assert.equal(childStart[0]?.payload?.parentToolUseId, 'task_1')
    assert.equal(childStart[0]?.payload?.toolCallId, 'child_1')
    assert.equal(childStart[0]?.payload?.turnId, 'turn_9', 'child rows stay attached to the turn that owns the lane')

    const childOutput = mapSdkMessage(state, {
      type: 'user',
      session_id: 'sdk-session-1',
      parent_tool_use_id: 'task_1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'child_1', content: '12 matches' }] },
    })
    assert.deepEqual(
      childOutput.map((event) => event.type),
      ['tool_output'],
    )
    assert.equal(childOutput[0]?.payload?.parentToolUseId, 'task_1')
    assert.equal(childOutput[0]?.payload?.output, '12 matches')

    // A nested spawn is both a child row and a lane of its own.
    const nestedLane = mapSdkMessage(state, {
      type: 'assistant',
      session_id: 'sdk-session-1',
      parent_tool_use_id: 'task_1',
      message: {
        content: [{ type: 'tool_use', id: 'task_2', name: 'Agent', input: { description: 'check the tests' } }],
      },
    })
    assert.equal(nestedLane[0]?.payload?.parentToolUseId, 'task_1')
    assert.equal(nestedLane[0]?.payload?.subagentLane, true)
    assert.equal('subagentType' in (nestedLane[0]?.payload ?? {}), false, 'no invented type when the call names none')

    const success = mapSdkMessage(state, {
      total_cost_usd: 0.025,
      duration_ms: 1234,
      num_turns: 2,
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'sdk-session-1',
      usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
    })
    assert.deepEqual(
      success.map((event) => event.type),
      ['usage_updated', 'turn_completed'],
    )
    assert.equal(success[0]?.payload?.inputTokens, 15)
    assert.equal(success[0]?.payload?.cachedInputTokens, 5, 'the share the prompt cache served')
    assert.equal(success[0]?.payload?.outputTokens, 3)
    assert.deepEqual(success[1]?.payload, {
      turnId: 'turn_9',
      // The turn's spend by the turn-usage contract: fresh input apart from the cache's share.
      usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 5 },
      costUsd: 0.025,
      durationMs: 1234,
      numTurns: 2,
    })

    const failure = mapSdkMessage(state, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'sdk-session-1',
      usage: { input_tokens: 1, output_tokens: 1 },
      errors: ['boom'],
    })
    assert.deepEqual(
      failure.map((event) => event.type),
      ['usage_updated', 'turn_failed'],
    )
    assert.equal(failure[1]?.payload?.reason, 'error_during_execution')
    assert.equal(failure[1]?.payload?.message, 'boom')

    // Unknown message shapes are dropped, not crashed on.
    assert.deepEqual(mapSdkMessage(state, { type: 'rate_limit_event', session_id: 'sdk-session-1' }), [])
  }

  async function testTurnStreamsDeltasToolsUsageAndCompletion(): Promise<void> {
    const { adapter, capturedOptions } = createAdapter((userMessage, context) => {
      assert.deepEqual(userMessage.message, { role: 'user', content: 'hello' })
      context.emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'sonnet' })
      context.emit({
        type: 'stream_event',
        session_id: 's1',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
      })
      context.emit({
        type: 'assistant',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'a.txt' } }] },
      })
      context.emit({
        type: 'user',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'contents' }] },
      })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 7, output_tokens: 2 },
      })
    })

    const startEvents = await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    assert.deepEqual(
      startEvents.map((event) => event.type),
      ['session_started', 'session_ready'],
    )
    assert.equal(startEvents[0]?.payload?.resumed, false)

    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.deepEqual(
      events.map((event) => event.type),
      [
        'turn_started',
        'session_updated',
        'content_delta',
        'tool_started',
        'tool_output',
        'usage_updated',
        'turn_completed',
      ],
    )
    const options = capturedOptions[0]
    assert.equal(options?.cwd, '/tmp/workspace')
    assert.equal(options?.pathToClaudeCodeExecutable, '/fake/bin/claude')
    assert.equal(options?.model, 'sonnet')
    assert.equal(options?.includePartialMessages, true)
    // No preset named: no permission mode is pinned, so the CLI's own default
    // applies. The bypass opt-in only lets a live switch reach bypass later.
    assert.equal(options?.permissionMode, undefined)
    assert.equal(options?.allowDangerouslySkipPermissions, true)
    assert.equal(options?.resume, undefined)
    assert.equal((options?.env as Record<string, string>)[CLAUDE_AGENT_SESSION_ENV_KEY], 'conv_1')

    const live = adapter.listLiveSessions()
    assert.equal(live.length, 1)
    assert.equal(live[0]?.hasChildProcess, true)
    assert.equal(live[0]?.providerSessionId, 's1')
    assert.equal(live[0]?.turnActive, false)
  }

  // A turn carrying attachments must reach the SDK as a multimodal user message:
  // the text block plus one base64 image block per attachment.
  async function testImageAttachmentsBecomeMultimodalContent(): Promise<void> {
    let capturedContent: unknown
    const { adapter } = createAdapter((userMessage, context) => {
      capturedContent = (userMessage.message as { content: unknown }).content
      context.emit({ type: 'system', subtype: 'init', session_id: 's-img' })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's-img',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    const events = await collect(
      adapter.sendTurn(
        turnInput({
          message: 'describe this',
          attachments: [{ id: 'img-1', mediaType: 'image/png', dataBase64: 'Zm9v', byteLength: 3 }],
        }),
      ) as AsyncIterable<ConversationEvent>,
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['turn_started', 'session_updated', 'usage_updated', 'turn_completed'],
    )
    assert.deepEqual(capturedContent, [
      { type: 'text', text: 'describe this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Zm9v' } },
    ])
  }

  async function testResumeCursorIsPassedToTheSdkAndSessionUpdatesEmit(): Promise<void> {
    const { adapter, capturedOptions } = createAdapter((_userMessage, context) => {
      // Resume produces a fresh CLI session id; the adapter must surface it.
      context.emit({ type: 'system', subtype: 'init', session_id: 'resumed-2', model: 'sonnet' })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'resumed-2',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    const startEvents = await collect(
      adapter.startSession({ ...SESSION_INPUT, resumeSessionId: 'previous-1' }) as ConversationEvent[],
    )
    assert.equal(startEvents[0]?.payload?.providerSessionId, 'previous-1')
    assert.equal(startEvents[0]?.payload?.resumed, true)

    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(capturedOptions[0]?.resume, 'previous-1')
    const updated = events.find((event) => event.type === 'session_updated')
    assert.equal(updated?.payload?.providerSessionId, 'resumed-2')
  }

  // A tool the person refused comes back from the CLI as an ordinary error
  // result; it must read as declined, not as a command that failed.
  async function testDeniedToolResultReadsAsDeclined(): Promise<void> {
    const { adapter } = createAdapter(async (_message, context) => {
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal; toolUseID: string },
      ) => Promise<Record<string, unknown>>
      await canUseTool('Bash', { command: 'rm -rf build' }, { signal: undefined, toolUseID: 'toolu_denied' })
      context.emit({
        type: 'user',
        session_id: 'declined',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_denied', is_error: true, content: 'Denied.' }],
        },
      })
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'declined' })
    })
    await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>, (event) => {
      if (event.type === 'approval_requested')
        void collect(
          adapter.resolveApproval({
            ...SESSION_INPUT,
            turnId: 'turn_1',
            requestId: String(event.payload?.requestId),
            approved: false,
          }) as ConversationEvent[],
        )
    })
    assert.equal(events.find((event) => event.type === 'tool_output')?.payload?.status, 'declined')
    adapter.disposeAll()
  }

  async function testCanUseToolApprovalFlowApproveAndDeny(): Promise<void> {
    const decisions: Array<Record<string, unknown>> = []
    const { adapter } = createAdapter(async (userMessage, context) => {
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      const text = (userMessage.message as { content: string }).content
      const permissionContext = {
        signal: undefined,
        agentID: 'research-agent',
        defaultToNo: true,
        suppressAlwaysAllowRule: true,
      }
      const decision = await canUseTool('Bash', { command: `run ${text}` }, permissionContext)
      decisions.push(decision)
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])

    // Approve.
    const approvedEvents = await collect(
      adapter.sendTurn(turnInput({ message: 'first' })) as AsyncIterable<ConversationEvent>,
      (event) => {
        if (event.type === 'approval_requested') {
          assert.equal(event.payload?.requestId, 'approval_1')
          assert.equal(event.payload?.action, 'Bash')
          assert.equal(event.payload?.summary, 'Bash: run first')
          assert.equal(event.payload?.originAgentId, 'research-agent')
          assert.equal(event.payload?.defaultToNo, true)
          assert.equal(event.payload?.suppressAlwaysAllowRule, true)
          void collect(
            adapter.resolveApproval({
              ...SESSION_INPUT,
              turnId: 'turn_1',
              requestId: 'approval_1',
              approved: true,
            }) as ConversationEvent[],
          )
        }
      },
    )
    assert.deepEqual(
      approvedEvents.map((event) => event.type),
      ['turn_started', 'approval_requested', 'approval_resolved', 'usage_updated', 'turn_completed'],
    )
    assert.equal(approvedEvents[2]?.payload?.approved, true)
    assert.equal(decisions[0]?.behavior, 'allow')

    // Deny (second turn on the same live session).
    const deniedEvents = await collect(
      adapter.sendTurn(
        turnInput({ turnId: 'turn_2', requestId: 'approval_2', message: 'second' }),
      ) as AsyncIterable<ConversationEvent>,
      (event) => {
        if (event.type === 'approval_requested') {
          void collect(
            adapter.resolveApproval({
              ...SESSION_INPUT,
              turnId: 'turn_2',
              requestId: 'approval_2',
              approved: false,
            }) as ConversationEvent[],
          )
        }
      },
    )
    assert.equal(deniedEvents.find((event) => event.type === 'approval_resolved')?.payload?.approved, false)
    assert.equal(decisions[1]?.behavior, 'deny')
  }

  // Under bypass the CLI still asks for some subagent calls (an Explore
  // agent's compound Bash); those answer themselves. A safety check marked
  // defaultToNo and an ask forced by the user's own rule still show a card.
  async function testBypassAnswersSubagentAsksButKeepsSafetyAndRuleAsks(): Promise<void> {
    const decisions: Array<Record<string, unknown>> = []
    const { adapter } = createAdapter(async (_userMessage, context) => {
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>
      decisions.push(await canUseTool('Bash', { command: 'cd src; grep -rn x . | head' }, { agentID: 'explore-1' }))
      decisions.push(await canUseTool('Bash', { command: 'rm -rf /' }, { agentID: 'explore-1', defaultToNo: true }))
      decisions.push(
        await canUseTool('Bash', { command: 'git push' }, { matchedAskRule: { source: 'user', toolName: 'Bash' } }),
      )
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    await collect(adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'bypass' }) as ConversationEvent[])
    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>, (event) => {
      if (event.type === 'approval_requested')
        void collect(
          adapter.resolveApproval({
            ...SESSION_INPUT,
            turnId: 'turn_1',
            requestId: String(event.payload?.requestId),
            approved: false,
          }) as ConversationEvent[],
        )
    })
    const asked = events.filter((event) => event.type === 'approval_requested')
    assert.deepEqual(
      asked.map((event) => (event.payload?.input as { command?: string })?.command),
      ['rm -rf /', 'git push'],
    )
    assert.deepEqual(
      decisions.map((decision) => decision.behavior),
      ['allow', 'deny', 'deny'],
    )
    adapter.disposeAll()
  }

  async function testAskUserQuestionBecomesQuestionCardAndAnswersFlowBack(): Promise<void> {
    const decisions: Array<Record<string, unknown>> = []
    const questionInput = {
      questions: [
        {
          question: 'Which auth method?',
          header: 'Auth',
          multiSelect: false,
          options: [
            { label: 'OAuth', description: 'Redirect flow' },
            { label: 'API key', description: 'Static secret' },
          ],
        },
      ],
    }
    const { adapter } = createAdapter(async (_userMessage, context) => {
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      decisions.push(await canUseTool('AskUserQuestion', questionInput, {}))
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>, (event) => {
      if (event.type === 'approval_requested') {
        assert.equal(event.payload?.kind, 'question')
        assert.equal(event.payload?.summary, 'Which auth method?')
        const questions = event.payload?.questions as Array<Record<string, unknown>>
        assert.equal(questions.length, 1)
        assert.equal((questions[0]?.options as unknown[]).length, 2)
        assert.equal(questions[0]?.allowFreeText, true)
        void collect(
          adapter.resolveApproval({
            ...SESSION_INPUT,
            turnId: 'turn_1',
            requestId: 'approval_1',
            approved: true,
            answers: { 'Which auth method?': 'OAuth' },
          }) as ConversationEvent[],
        )
      }
    })
    const resolved = events.find((event) => event.type === 'approval_resolved')
    assert.deepEqual(resolved?.payload?.answers, { 'Which auth method?': 'OAuth' })
    assert.equal(decisions[0]?.behavior, 'allow')
    assert.deepEqual((decisions[0]?.updatedInput as Record<string, unknown>).answers, { 'Which auth method?': 'OAuth' })

    // Dismissal denies the tool so the model can move on.
    const dismissed: Array<Record<string, unknown>> = []
    const { adapter: adapter2 } = createAdapter(async (_userMessage, context) => {
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      dismissed.push(await canUseTool('AskUserQuestion', questionInput, {}))
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    await collect(adapter2.startSession(SESSION_INPUT) as ConversationEvent[])
    await collect(adapter2.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>, (event) => {
      if (event.type === 'approval_requested') {
        void collect(
          adapter2.resolveApproval({
            ...SESSION_INPUT,
            turnId: 'turn_1',
            requestId: 'approval_1',
            approved: false,
          }) as ConversationEvent[],
        )
      }
    })
    assert.equal(dismissed[0]?.behavior, 'deny')
  }

  async function testExitPlanModeBecomesPlanCard(): Promise<void> {
    const decisions: Array<Record<string, unknown>> = []
    const { adapter, permissionModes, capturedOptions } = createAdapter(async (_userMessage, context) => {
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      // Claude Code injects the plan and the file it keeps it in.
      decisions.push(
        await canUseTool(
          'ExitPlanMode',
          { plan: '## Plan\n1. Do the thing', planFilePath: '/Users/dev/.claude/plans/quiet-otter.md' },
          {},
        ),
      )
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    await collect(adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'bypass' }) as ConversationEvent[])
    const events = await collect(
      adapter.sendTurn(turnInput({ mode: 'plan' })) as AsyncIterable<ConversationEvent>,
      (event) => {
        if (event.type === 'approval_requested') {
          assert.equal(event.payload?.kind, 'plan')
          assert.equal(event.payload?.plan, '## Plan\n1. Do the thing')
          assert.equal(event.payload?.planFilePath, '/Users/dev/.claude/plans/quiet-otter.md')
          void collect(
            adapter.resolveApproval({
              ...SESSION_INPUT,
              turnId: 'turn_1',
              requestId: 'approval_1',
              approved: true,
            }) as ConversationEvent[],
          )
        }
      },
    )
    assert.equal(
      events.some((event) => event.type === 'approval_resolved' && event.payload?.approved === true),
      true,
    )
    assert.equal(decisions[0]?.behavior, 'allow')
    assert.equal(capturedOptions[0]?.permissionMode, 'plan')
    assert.equal(capturedOptions[0]?.allowDangerouslySkipPermissions, true, 'plan mode keeps the bypass opt-in')
    assert.deepEqual(
      permissionModes,
      ['bypassPermissions'],
      'accepting a plan restores the prior native permission mode',
    )
    await collect(
      adapter.sendTurn(
        turnInput({ turnId: 'turn_2', requestId: 'approval_2', mode: 'default' }),
      ) as AsyncIterable<ConversationEvent>,
      (event) => {
        if (event.type === 'approval_requested')
          void collect(
            adapter.resolveApproval({
              ...SESSION_INPUT,
              turnId: 'turn_2',
              requestId: 'approval_2',
              approved: false,
            }) as ConversationEvent[],
          )
      },
    )
    assert.equal(capturedOptions.length, 1, 'accepting the plan also exits the adapter mode without respawning')
    adapter.disposeAll()
  }

  async function testPermissionPresetMapsToSdkPermissionMode(): Promise<void> {
    const emitResult = (context: FakeQueryContext): void => {
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }

    const bypass = createAdapter((_userMessage, context) => emitResult(context))
    await collect(bypass.adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'bypass' }) as ConversationEvent[])
    await collect(bypass.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(bypass.capturedOptions[0]?.permissionMode, 'bypassPermissions')
    assert.equal(bypass.capturedOptions[0]?.allowDangerouslySkipPermissions, true)

    // `none` pins no mode at all: the SDK leaves the CLI on its own configured
    // default, rather than on 'default', which a user's settings can override.
    const none = createAdapter((_userMessage, context) => emitResult(context))
    await collect(none.adapter.startSession({ ...SESSION_INPUT, permissionPreset: 'none' }) as ConversationEvent[])
    await collect(none.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(none.capturedOptions[0]?.permissionMode, undefined)
    assert.equal(none.capturedOptions[0]?.allowDangerouslySkipPermissions, true)

    // Plan mode is a separate toggle, not a preset: it spawns 'plan' under any.
    for (const permissionPreset of ['none', 'manual', 'auto', 'bypass'] as const) {
      const plan = createAdapter((_userMessage, context) => emitResult(context))
      await collect(plan.adapter.startSession({ ...SESSION_INPUT, permissionPreset }) as ConversationEvent[])
      await collect(plan.adapter.sendTurn(turnInput({ mode: 'plan' })) as AsyncIterable<ConversationEvent>)
      assert.equal(plan.capturedOptions[0]?.permissionMode, 'plan', permissionPreset)
      plan.adapter.disposeAll()
    }
  }

  // The preset is switchable while the session runs. Before a child exists it
  // is only recorded; leaving bypass on an idle child replaces the child, since
  // `none` is the absence of a mode rather than one the control channel names,
  // and the next turn respawns into the same provider session.
  async function testLivePermissionPresetReachesTheChildAndSurvivesRespawn(): Promise<void> {
    const emitResult = (context: FakeQueryContext): void => {
      context.emit({ type: 'system', subtype: 'init', session_id: 'cursor-1', model: 'sonnet' })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'cursor-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }

    const live = createAdapter((_userMessage, context) => emitResult(context), {
      onSetPermissionMode: () => {
        throw new Error('an idle child leaving bypass is replaced, not asked')
      },
    })
    await collect(live.adapter.startSession(SESSION_INPUT) as ConversationEvent[])

    // Before the child exists the preset is only recorded — it lands at spawn,
    // including the bypass opt-in flag the SDK requires.
    assert.deepEqual(await live.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'bypass' }), {
      ok: true,
    })
    await collect(live.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(live.capturedOptions[0]?.permissionMode, 'bypassPermissions')
    assert.equal(live.capturedOptions[0]?.allowDangerouslySkipPermissions, true)

    // Choosing the preset already in force leaves the child alone.
    assert.deepEqual(await live.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'bypass' }), {
      ok: true,
    })
    assert.equal(live.adapter.listLiveSessions()[0]?.hasChildProcess, true)

    // Leaving bypass on an idle child replaces it, so no bypass grant lingers.
    assert.deepEqual(await live.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'none' }), {
      ok: true,
    })
    assert.deepEqual(live.permissionModes, [])
    assert.equal(live.adapter.listLiveSessions()[0]?.hasChildProcess, false)
    await collect(
      live.adapter.sendTurn(
        turnInput({ turnId: 'turn_2', requestId: 'approval_2' }),
      ) as AsyncIterable<ConversationEvent>,
    )
    assert.equal(live.capturedOptions[1]?.permissionMode, undefined)
    assert.equal(live.capturedOptions[1]?.resume, 'cursor-1')

    // The recorded preset carries into the respawn after idle disposal.
    assert.equal(live.adapter.disposeChildProcess('conv_1'), true)
    await collect(
      live.adapter.sendTurn(
        turnInput({ turnId: 'turn_3', requestId: 'approval_3' }),
      ) as AsyncIterable<ConversationEvent>,
    )
    assert.equal(live.capturedOptions[2]?.permissionMode, undefined)

    assert.deepEqual(
      await live.adapter.setPermissionPreset({
        ...SESSION_INPUT,
        sessionId: 'conv_missing',
        permissionPreset: 'bypass',
      }),
      {
        ok: false,
        message: 'Conversation session is not registered with the Claude provider.',
      },
    )
    await collect(live.adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  // A background agent works inside the child after its turn has ended, with
  // no turn open. Moving to No flag then waits for the next message, as it
  // does mid-reply, instead of replacing the child and ending the agent.
  async function testNoFlagWaitsForABackgroundAgentBeforeReplacingTheChild(): Promise<void> {
    const agentReports = createDeferred<void>()
    const bg = createAdapter(async (_userMessage, context) => {
      context.emit({ type: 'system', subtype: 'init', session_id: 'bg-1', model: 'sonnet' })
      context.emit({
        type: 'assistant',
        session_id: 'bg-1',
        parent_tool_use_id: null,
        message: {
          content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { subagent_type: 'Explore' } }],
        },
      })
      context.emit({
        type: 'system',
        subtype: 'task_started',
        session_id: 'bg-1',
        task_id: 'task_bg',
        tool_use_id: 'toolu_bg',
        task_type: 'local_agent',
        is_backgrounded: true,
      })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'bg-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      await agentReports.promise
      context.emit({
        type: 'system',
        subtype: 'task_notification',
        session_id: 'bg-1',
        task_id: 'task_bg',
        tool_use_id: 'toolu_bg',
        status: 'completed',
        summary: 'done',
      })
    })
    const sessionEvents: ConversationEvent[] = []
    await collect(
      bg.adapter.startSession({
        ...SESSION_INPUT,
        permissionPreset: 'bypass',
        onSessionEvent: (event) => sessionEvents.push(event),
      }) as ConversationEvent[],
    )
    await collect(bg.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)

    assert.deepEqual(await bg.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'none' }), {
      ok: true,
    })
    assert.equal(bg.adapter.listLiveSessions()[0]?.hasChildProcess, true, 'the agent keeps its child')
    assert.deepEqual(bg.permissionModes, ['default'], 'nothing looser than default carries on meanwhile')
    assert.equal(
      sessionEvents.some((event) => event.type === 'subagent_status' && event.payload?.status === 'stopped'),
      false,
    )

    // Once the agent has reported, the child is free, and the next change
    // replaces it as it would any idle child.
    agentReports.resolve()
    await waitForContinuationEvent(sessionEvents, 'tool_output')
    assert.deepEqual(await bg.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'none' }), {
      ok: true,
    })
    assert.equal(bg.adapter.listLiveSessions()[0]?.hasChildProcess, false)
    await collect(bg.adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  // A monitor runs in the child as a shell, and wakes the agent when it reports.
  // Replacing the child would end it before it ever did: a preset change
  // waits, as it does for a background agent, and a child that does end takes
  // the chat's list of background work with it.
  async function testNoFlagWaitsForAMonitorBeforeReplacingTheChild(): Promise<void> {
    const mon = createAdapter(async (_userMessage, context) => {
      context.emit({ type: 'system', subtype: 'init', session_id: 'mon-1', model: 'sonnet' })
      context.emit({
        type: 'assistant',
        session_id: 'mon-1',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_mon',
              name: 'Monitor',
              input: { description: 'CI checks', command: 'gh pr checks --watch', timeout_ms: 600000 },
            },
          ],
        },
      })
      context.emit({
        type: 'system',
        subtype: 'task_started',
        session_id: 'mon-1',
        task_id: 'task_mon',
        tool_use_id: 'toolu_mon',
        task_type: 'local_bash',
        description: 'CI checks',
        is_backgrounded: true,
      })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'mon-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })
    const sessionEvents: ConversationEvent[] = []
    await collect(
      mon.adapter.startSession({
        ...SESSION_INPUT,
        permissionPreset: 'bypass',
        onSessionEvent: (event) => sessionEvents.push(event),
      }) as ConversationEvent[],
    )
    const turn = await collect(mon.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.deepEqual(
      turn.flatMap((event) =>
        event.type === 'session_updated' && event.payload?.backgroundTasks ? [event.payload.backgroundTasks] : [],
      ),
      [[{ taskId: 'task_mon', kind: 'monitor', description: 'CI checks' }]],
    )

    assert.deepEqual(await mon.adapter.setPermissionPreset({ ...SESSION_INPUT, permissionPreset: 'none' }), {
      ok: true,
    })
    assert.equal(mon.adapter.listLiveSessions()[0]?.hasChildProcess, true, 'the monitor keeps its child')

    assert.equal(mon.adapter.disposeChildProcess(SESSION_INPUT.sessionId), true)
    assert.deepEqual(
      sessionEvents.filter((event) => event.type === 'session_updated').map((event) => event.payload),
      [{ backgroundTasks: [] }],
      'a monitor that ended with its child is not waited on any more',
    )
    assert.equal(await mon.adapter.stopBackgroundTasks(SESSION_INPUT.sessionId), false, 'nothing is left to stop')
    await collect(mon.adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  // Stop between turns ends what the turn left running, by name, and leaves the
  // child: each task reports that it stopped, which takes it off the list.
  async function testStopBetweenTurnsEndsTheMonitorAndKeepsTheChild(): Promise<void> {
    const mon = createAdapter(async (_userMessage, context) => {
      context.emit({ type: 'system', subtype: 'init', session_id: 'mon-2', model: 'sonnet' })
      context.emit({
        type: 'assistant',
        session_id: 'mon-2',
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_mon',
              name: 'Monitor',
              input: { description: 'CI checks', timeout_ms: 600000 },
            },
          ],
        },
      })
      context.emit({
        type: 'system',
        subtype: 'task_started',
        session_id: 'mon-2',
        task_id: 'task_mon',
        tool_use_id: 'toolu_mon',
        task_type: 'local_bash',
        description: 'CI checks',
        is_backgrounded: true,
      })
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'mon-2' })
    })
    const sessionEvents: ConversationEvent[] = []
    await collect(
      mon.adapter.startSession({
        ...SESSION_INPUT,
        onSessionEvent: (event) => sessionEvents.push(event),
      }) as ConversationEvent[],
    )
    await collect(mon.adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)

    assert.equal(await mon.adapter.stopBackgroundTasks(SESSION_INPUT.sessionId), true)
    assert.deepEqual(mon.stoppedTasks, ['task_mon'])
    await waitForContinuationEvent(sessionEvents, 'session_updated')
    assert.deepEqual(
      sessionEvents.filter((event) => event.type === 'session_updated').map((event) => event.payload),
      [{ backgroundTasks: [] }],
    )
    assert.equal(mon.adapter.listLiveSessions()[0]?.hasChildProcess, true, 'the session goes on in the same child')
    await collect(mon.adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  async function testAbortSignalEndsTheTurnStream(): Promise<void> {
    const { adapter } = createAdapter((_userMessage, context) => {
      context.emit({
        type: 'stream_event',
        session_id: 's1',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
      })
      // Never emits a result: the turn only ends via the abort signal.
    })

    await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    const abort = new AbortController()
    const events = await collect(
      adapter.sendTurn(turnInput({ signal: abort.signal })) as AsyncIterable<ConversationEvent>,
      (event) => {
        if (event.type === 'content_delta') abort.abort()
      },
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['turn_started', 'content_delta'],
    )
  }

  async function testSpawnFailureSurfacesAsTurnFailed(): Promise<void> {
    const adapter = createClaudeAgentProvider({
      loadQuery: (() => Promise.reject(new Error('sdk unavailable'))) as never,
      resolveExecutable: async () => {
        throw new Error('Claude Code CLI is not installed.')
      },
      buildEnv: () => ({}),
      now: () => 1000,
    })
    await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    const events = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.deepEqual(
      events.map((event) => event.type),
      ['turn_started', 'turn_failed'],
    )
    assert.equal(events[1]?.payload?.reason, 'spawn')
    assert.equal(events[1]?.payload?.message, 'Claude Code CLI is not installed.')
  }

  // A spawn awaits executable discovery (and more) before the child starts; a
  // stop in that window must not leave a child running that no session owns.
  function deferredExecutable(): {
    resolveExecutable: () => Promise<string>
    asked: Promise<void>
    release: () => void
  } {
    let release!: () => void
    let noteAsked!: () => void
    const asked = new Promise<void>((resolve) => {
      noteAsked = resolve
    })
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    return {
      resolveExecutable: async () => {
        noteAsked()
        await ready
        return '/fake/bin/claude'
      },
      asked,
      release,
    }
  }

  async function testStopDuringSpawnStartsNoChild(): Promise<void> {
    const sdk = createFakeSdk((_message, context) => {
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'late' })
    })
    const executable = deferredExecutable()
    const adapter = createClaudeAgentProvider({
      loadQuery: sdk.loadQuery as never,
      resolveExecutable: executable.resolveExecutable,
      buildEnv: () => ({}),
      now: () => 1000,
    })
    await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    const turn = collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    await executable.asked
    adapter.stopSession(SESSION_INPUT)
    executable.release()
    const events = await turn
    assert.equal(events.at(-1)?.type, 'turn_failed')
    assert.equal(sdk.capturedOptions.length, 0, 'no child is started for a stopped session')
    assert.deepEqual(adapter.listLiveSessions(), [])
  }

  async function testSuspendDuringSpawnStartsNoChild(): Promise<void> {
    const sdk = createFakeSdk((_message, context) => {
      context.emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'late' })
    })
    const executable = deferredExecutable()
    const adapter = createClaudeAgentProvider({
      loadQuery: sdk.loadQuery as never,
      resolveExecutable: executable.resolveExecutable,
      buildEnv: () => ({}),
      now: () => 1000,
    })
    await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    const turn = collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    await executable.asked
    assert.equal(adapter.disposeChildProcess('conv_1'), true, 'the spawn in flight is called off')
    executable.release()
    assert.equal((await turn).at(-1)?.type, 'turn_failed')
    assert.equal(sdk.capturedOptions.length, 0)
    assert.equal(adapter.listLiveSessions()[0]?.hasChildProcess, false)
    // The session stays: the next send starts its child as usual.
    const next = await collect(
      adapter.sendTurn(turnInput({ turnId: 'turn_2', requestId: 'approval_2' })) as AsyncIterable<ConversationEvent>,
    )
    assert.equal(next.at(-1)?.type, 'turn_completed')
    assert.equal(sdk.capturedOptions.length, 1)
    assert.equal(adapter.disposeChildProcess('conv_1'), true)
    assert.equal(adapter.disposeChildProcess('conv_1'), false, 'nothing is spawning or running any more')
    await adapter.disposeAll()
  }

  async function testDisposeChildKeepsSessionAndCursorForRespawn(): Promise<void> {
    const { adapter, capturedOptions } = createAdapter((_userMessage, context) => {
      context.emit({ type: 'system', subtype: 'init', session_id: 'cursor-1', model: 'sonnet' })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'cursor-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    await collect(adapter.startSession(SESSION_INPUT) as ConversationEvent[])
    await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(adapter.listLiveSessions()[0]?.hasChildProcess, true)

    assert.equal(adapter.disposeChildProcess('conv_1'), true)
    assert.equal(adapter.disposeChildProcess('conv_1'), false)
    const live = adapter.listLiveSessions()[0]
    assert.equal(live?.hasChildProcess, false)
    assert.equal(live?.providerSessionId, 'cursor-1')

    // Next turn respawns with the kept cursor.
    const events = await collect(
      adapter.sendTurn(turnInput({ turnId: 'turn_2', requestId: 'approval_2' })) as AsyncIterable<ConversationEvent>,
    )
    assert.equal(events.at(-1)?.type, 'turn_completed')
    assert.equal(capturedOptions.length, 2)
    assert.equal(capturedOptions[1]?.resume, 'cursor-1')

    const closed = await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
    assert.deepEqual(
      closed.map((event) => event.type),
      ['session_closed'],
    )
    assert.equal(adapter.listLiveSessions().length, 0)
  }

  // 1775: a tool the long-lived child invokes AFTER the turn `result` (the model
  // resuming once a background subagent completes) must not be auto-denied. With
  // a session-scoped continuation channel, handleCanUseTool opens a continuation
  // turn and the approval card flows to the runtime; resolveApproval answers it.
  async function testToolAfterResultOpensContinuationInsteadOfDenying(): Promise<void> {
    const gate = createDeferred<void>()
    const decisions: Array<Record<string, unknown>> = []
    const { adapter } = createAdapter(async (_userMessage, context) => {
      // The turn completes and its sendTurn stream ends.
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      // The child keeps working: only once the test has confirmed the turn
      // resolved does a post-`result` tool fire (a background subagent completed).
      await gate.promise
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      decisions.push(await canUseTool('Bash', { command: 'ls' }, {}))
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    const continuation: ConversationEvent[] = []
    await collect(
      adapter.startSession({
        ...SESSION_INPUT,
        onSessionEvent: (event) => continuation.push(event),
      }) as ConversationEvent[],
    )

    const turnEvents = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(turnEvents.at(-1)?.type, 'turn_completed', 'the turn resolves at `result`, freeing the composer')

    // Now let the post-`result` tool fire; its approval card must reach the
    // continuation channel rather than being denied.
    gate.resolve()
    const requestId = await waitForContinuationEvent(continuation, 'approval_requested')
    assert.deepEqual(
      continuation.slice(0, 2).map((event) => event.type),
      ['turn_started', 'approval_requested'],
      'the continuation announces its turn before the approval card',
    )
    const contTurnId = continuation[0]?.payload?.turnId
    assert.equal(typeof contTurnId === 'string' && contTurnId.includes('_cont_'), true)

    await collect(
      adapter.resolveApproval({
        ...SESSION_INPUT,
        turnId: contTurnId as string,
        requestId,
        approved: true,
      }) as ConversationEvent[],
    )
    await waitForContinuationEvent(continuation, 'turn_completed')

    assert.equal(decisions[0]?.behavior, 'allow', 'the post-`result` tool was approved, not auto-denied')
    assert.deepEqual(
      continuation.map((event) => event.type),
      ['turn_started', 'approval_requested', 'approval_resolved', 'usage_updated', 'turn_completed'],
    )
    assert.equal(continuation.find((event) => event.type === 'approval_resolved')?.payload?.approved, true)

    await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  // A background subagent working after the turn's `result`. Its tool calls
  // reach the runtime over the session channel, still linked to their lane,
  // but they open no turn: the conversation is idle while the agent works, so
  // the person can send, and no "done" notice or diff follows for a turn
  // nobody sent. A turn opens only once the model itself resumes.
  async function testSubagentStepsAfterResultRideTheSessionChannelWithoutATurn(): Promise<void> {
    const agentWorks = createDeferred<void>()
    const modelResumes = createDeferred<void>()
    const { adapter } = createAdapter(async (_userMessage, context) => {
      context.emit({
        type: 'assistant',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'task_1', name: 'Task', input: { subagent_type: 'Explore' } }] },
      })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      await agentWorks.promise
      context.emit({
        type: 'assistant',
        session_id: 's1',
        parent_tool_use_id: 'task_1',
        message: { content: [{ type: 'tool_use', id: 'child_1', name: 'Edit', input: { file_path: 'a.ts' } }] },
      })
      context.emit({
        type: 'user',
        session_id: 's1',
        parent_tool_use_id: 'task_1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'child_1', content: 'edited' }] },
      })
      await modelResumes.promise
      // The agent has reported; the model reads its answer and acts on it.
      context.emit({
        type: 'assistant',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'main_2', name: 'Read', input: { file_path: 'a.ts' } }] },
      })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    const continuation: ConversationEvent[] = []
    await collect(
      adapter.startSession({
        ...SESSION_INPUT,
        onSessionEvent: (event) => continuation.push(event),
      }) as ConversationEvent[],
    )

    const turnEvents = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    const lane = turnEvents.find((event) => event.type === 'tool_started')
    assert.equal(lane?.payload?.subagentLane, true, 'the lane header rides the turn that spawned it')

    agentWorks.resolve()
    await waitForContinuationEvent(continuation, 'tool_output')
    assert.deepEqual(
      continuation.map((event) => event.type),
      ['tool_started', 'tool_output'],
      "the agent's steps open no turn",
    )
    for (const step of continuation) {
      assert.equal(step.payload?.parentToolUseId, 'task_1', 'each step stays linked to its lane')
      assert.equal(step.payload?.turnId, undefined, 'a step between turns belongs to no turn')
    }
    assert.equal(continuation[0]?.payload?.tool, 'Edit')

    modelResumes.resolve()
    await waitForContinuationEvent(continuation, 'turn_completed')
    assert.deepEqual(
      continuation.slice(2).map((event) => event.type),
      ['turn_started', 'tool_started', 'usage_updated', 'turn_completed'],
      "the model's own work opens the continuation turn",
    )
    const contTurnId = continuation[2]?.payload?.turnId
    assert.equal(typeof contTurnId === 'string' && contTurnId.includes('_cont_'), true)
    assert.equal(continuation[3]?.payload?.turnId, contTurnId)

    await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  // 1775, the exact acceptance case: an AskUserQuestion raised AFTER the turn's
  // `result` — the model resuming once its background subagents report — must
  // surface as a real question card and route the human's answer back into the
  // tool, not be auto-denied with "Conversation turn is not active."
  async function testAskUserQuestionAfterResultReachesTheUserAndAnswersFlowBack(): Promise<void> {
    const gate = createDeferred<void>()
    const decisions: Array<Record<string, unknown>> = []
    const { adapter } = createAdapter(async (_userMessage, context) => {
      // A fan-out turn: the Task lane opens, then the turn resolves at `result`.
      context.emit({
        type: 'assistant',
        session_id: 's1',
        parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'task_1', name: 'Task', input: { subagent_type: 'Explore' } }] },
      })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      await gate.promise
      // The subagent finished and the model came back with a question for the user.
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      decisions.push(
        await canUseTool(
          'AskUserQuestion',
          {
            questions: [
              {
                question: 'Ship the fix or keep digging?',
                header: 'Next',
                multiSelect: false,
                options: [
                  { label: 'Ship it', description: 'The repro is covered' },
                  { label: 'Keep digging', description: 'Two lanes disagree' },
                ],
              },
            ],
          },
          {},
        ),
      )
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    })

    const continuation: ConversationEvent[] = []
    await collect(
      adapter.startSession({
        ...SESSION_INPUT,
        onSessionEvent: (event) => continuation.push(event),
      }) as ConversationEvent[],
    )
    const turnEvents = await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)
    assert.equal(turnEvents.at(-1)?.type, 'turn_completed', 'the fan-out turn resolves at `result`')

    gate.resolve()
    const requestId = await waitForContinuationEvent(continuation, 'approval_requested')
    const card = continuation.find((event) => event.type === 'approval_requested')
    assert.equal(card?.payload?.kind, 'question', 'it arrives as a question card, not a bare permission prompt')
    assert.equal(card?.payload?.summary, 'Ship the fix or keep digging?')
    assert.equal((card?.payload?.questions as unknown[]).length, 1)
    const contTurnId = continuation[0]?.payload?.turnId
    assert.equal(
      card?.payload?.turnId,
      contTurnId,
      'the card is stamped with the continuation turn the runtime mirrors',
    )

    await collect(
      adapter.resolveApproval({
        ...SESSION_INPUT,
        turnId: contTurnId as string,
        requestId,
        approved: true,
        answers: { 'Ship the fix or keep digging?': 'Ship it' },
      }) as ConversationEvent[],
    )
    await waitForContinuationEvent(continuation, 'turn_completed')

    assert.equal(decisions[0]?.behavior, 'allow', 'the post-`result` question was answered, not auto-denied')
    assert.deepEqual(
      (decisions[0]?.updatedInput as Record<string, unknown>).answers,
      { 'Ship the fix or keep digging?': 'Ship it' },
      "the human's answer reaches the tool",
    )
    assert.deepEqual(continuation.find((event) => event.type === 'approval_resolved')?.payload?.answers, {
      'Ship the fix or keep digging?': 'Ship it',
    })

    await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  // 1798, the provider half: a send that lands while a continuation turn is open
  // takes the session's turn over. The queue it replaces has to be ended, or its
  // drain awaits an iterator nobody will ever end — leaking one `for await` per
  // occurrence and stranding the permission that continuation was holding.
  async function testTurnTakeoverEndsTheReplacedContinuationQueue(): Promise<void> {
    const gate = createDeferred<void>()
    const decisions: Array<Record<string, unknown>> = []
    let turns = 0
    const { adapter } = createAdapter(async (_userMessage, context) => {
      turns += 1
      context.emit({ type: 'system', subtype: 'init', session_id: 'cursor-1', model: 'sonnet' })
      context.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'cursor-1',
        usage: { input_tokens: 1, output_tokens: 1 },
      })
      if (turns > 1) return
      // The first turn's child keeps working: a post-`result` tool opens a
      // continuation turn and blocks on its approval.
      await gate.promise
      const canUseTool = context.options.canUseTool as (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) => Promise<Record<string, unknown>>
      decisions.push(await canUseTool('Bash', { command: 'ls' }, {}))
    })

    const continuation: ConversationEvent[] = []
    await collect(
      adapter.startSession({
        ...SESSION_INPUT,
        onSessionEvent: (event) => continuation.push(event),
      }) as ConversationEvent[],
    )
    await collect(adapter.sendTurn(turnInput()) as AsyncIterable<ConversationEvent>)

    gate.resolve()
    await waitForContinuationEvent(continuation, 'approval_requested')

    // The composer flushes a queued message into that window (the runtime guard
    // normally rejects this; the provider must survive it either way).
    const takeover = collect(
      adapter.sendTurn(turnInput({ turnId: 'turn_2', requestId: 'approval_2' })) as AsyncIterable<ConversationEvent>,
    )
    const events = await withTimeout(
      takeover,
      'the replaced continuation queue was left open: its drain never ended, so its permission never resolved',
    )

    assert.equal(events.at(-1)?.type, 'turn_completed', 'the taking-over turn streams and completes normally')
    assert.equal(
      decisions[0]?.behavior,
      'deny',
      'the permission the replaced turn was holding is resolved, not stranded',
    )
    assert.deepEqual(
      continuation.map((event) => event.type),
      ['turn_started', 'approval_requested'],
      'the ended queue forwards nothing further to the session channel',
    )

    await collect(adapter.stopSession(SESSION_INPUT) as ConversationEvent[])
  }

  async function withTimeout<T>(promise: Promise<T>, message: string, ms = 2000): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise
    })
    return { promise, resolve }
  }

  async function waitForContinuationEvent(
    events: ConversationEvent[],
    type: ConversationEvent['type'],
  ): Promise<string> {
    // A wall-clock deadline, not a tick count: under full-suite load the fake
    // query's first event can take longer than a few hundred turns of the loop.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const match = events.find((event) => event.type === type)
      if (match) return typeof match.payload?.requestId === 'string' ? match.payload.requestId : ''
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`Timed out waiting for continuation ${type}`)
  }

  const suiteRun = main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })

  await suiteRun
})

function mapperState() {
  return {
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    providerSessionId: 'native' as string | null,
    turn: { turnId: 'turn_1' } as { turnId: string } | null,
    queryCostUsd: 0,
    declinedToolUseIds: new Set<string>(),
  }
}

test('a Claude result that reports no cost does not make the next turn report the whole session', () => {
  const state = mapperState()
  const result = (total: number, crashed = false) =>
    mapSdkMessage(state, {
      type: 'result',
      subtype: crashed ? 'error_during_execution' : 'success',
      is_error: crashed,
      session_id: 'native',
      total_cost_usd: total,
    }).find((event) => event.type === 'turn_completed')?.payload?.costUsd
  assert.equal(result(0.25), 0.25)
  // A crash reports a zero total; it is not a restarted count.
  state.turn = { turnId: 'turn_2' }
  result(0, true)
  state.turn = { turnId: 'turn_3' }
  assert.equal(Number((result(0.3) as number).toFixed(6)), 0.05)
})

test('each Claude turn reports the cost it added, not the running total of the live query', () => {
  const state = mapperState()
  const result = (total: number) =>
    mapSdkMessage(state, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'native',
      total_cost_usd: total,
    }).find((event) => event.type === 'turn_completed')?.payload?.costUsd
  assert.equal(result(0.25), 0.25)
  state.turn = { turnId: 'turn_2' }
  assert.equal(Number((result(0.4) as number).toFixed(6)), 0.15)
  // A running total that restarts (a fresh child, or /clear) is all new cost.
  state.turn = { turnId: 'turn_3' }
  assert.equal(result(0.1), 0.1)
})

test('each main-chain request reports its prompt cache as it starts: size, lifetime and whether anything was cached', () => {
  const state = mapperState()
  const start = (usage: Record<string, unknown>, parent?: string) =>
    mapSdkMessage(state, {
      type: 'stream_event',
      session_id: 'native',
      parent_tool_use_id: parent ?? null,
      event: { type: 'message_start', message: { usage } },
    })
  const [first] = start({
    input_tokens: 40,
    cache_creation_input_tokens: 2_000,
    cache_read_input_tokens: 300_000,
    cache_creation: { ephemeral_1h_input_tokens: 2_000, ephemeral_5m_input_tokens: 0 },
  })
  assert.equal(first?.type, 'usage_updated')
  // The same size is how full the context window is now.
  assert.deepEqual(first?.payload, {
    turnId: 'turn_1',
    promptCache: { ttl: '1h', cached: true, recacheTokens: 302_040 },
    contextUsed: 302_040,
  })
  // A request that only reads says nothing of the lifetime: it carries over.
  const [readOnly] = start({ input_tokens: 10, cache_read_input_tokens: 302_040 })
  assert.deepEqual(readOnly?.payload?.promptCache, { ttl: '1h', cached: true, recacheTokens: 302_050 })
  // Nothing cached at all is a cold request.
  const [uncached] = start({ input_tokens: 9_000 })
  assert.deepEqual(uncached?.payload?.promptCache, { ttl: '1h', cached: false, recacheTokens: 9_000 })
  // A subagent's requests are its own conversation, with its own cache.
  assert.deepEqual(start({ input_tokens: 5, cache_read_input_tokens: 5 }, 'task_1'), [])
  // And a start with no usage reports nothing.
  assert.deepEqual(start({}), [])
})

test('a turn reports how full the context window is: the last request, and the window the CLI ran it with', () => {
  const state = mapperState()
  mapSdkMessage(state, { type: 'system', subtype: 'init', session_id: 'native', model: 'claude-opus-4-7' })
  const stream = (event: Record<string, unknown>) =>
    mapSdkMessage(state, { type: 'stream_event', session_id: 'native', parent_tool_use_id: null, event })
  // Two requests in one turn (a tool round between them): each opening says
  // how big the conversation it sent was, cache hits included.
  stream({ type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 40_000 } } })
  stream({ type: 'message_delta', usage: { output_tokens: 300 } })
  const [second] = stream({
    type: 'message_start',
    message: { usage: { input_tokens: 400, cache_creation_input_tokens: 600, cache_read_input_tokens: 40_000 } },
  })
  assert.equal(second?.payload?.contextUsed, 41_000)
  stream({ type: 'message_delta', usage: { output_tokens: 250 } })
  // A subagent's requests fill a window of their own, not this one.
  mapSdkMessage(state, {
    type: 'stream_event',
    session_id: 'native',
    parent_tool_use_id: 'task_1',
    event: { type: 'message_start', message: { usage: { input_tokens: 90_000 } } },
  })
  const [usage] = mapSdkMessage(state, {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'native',
    // The turn's sum over both requests: what it cost, not what the window holds.
    usage: { input_tokens: 410, cache_creation_input_tokens: 600, cache_read_input_tokens: 80_000, output_tokens: 550 },
    modelUsage: {
      'claude-haiku-4-5': { inputTokens: 90_000, outputTokens: 10, contextWindow: 200_000 },
      'claude-opus-4-7': { inputTokens: 1_010, outputTokens: 550, contextWindow: 1_000_000 },
    },
  })
  assert.equal(usage?.type, 'usage_updated')
  assert.equal(usage?.payload?.inputTokens, 81_010)
  // The last request's size and what it wrote back; the main chain's window.
  assert.equal(usage?.payload?.contextUsed, 41_250)
  assert.equal(usage?.payload?.contextWindow, 1_000_000)
})

test('the context window is the init model’s row of modelUsage, else the largest one there', () => {
  const rows = {
    'claude-haiku-4-5': { contextWindow: 200_000 },
    'claude-opus-4-7[1m]': { contextWindow: 1_000_000 },
  }
  assert.equal(resultContextWindow(rows, 'claude-haiku-4-5'), 200_000)
  // An alias the CLI resolved has no row of its own: the main chain's model is
  // the one with the larger window, a subagent's the smaller.
  assert.equal(resultContextWindow(rows, 'opus'), 1_000_000)
  assert.equal(resultContextWindow(rows, null), 1_000_000)
  assert.equal(resultContextWindow({ x: { contextWindow: 0 } }, 'x'), undefined)
  assert.equal(resultContextWindow(undefined, 'x'), undefined)
})

test('a Claude compact boundary marks the transcript with what triggered it and the context it freed', () => {
  const state = mapperState()
  const [compacted] = mapSdkMessage(state, {
    type: 'system',
    subtype: 'compact_boundary',
    session_id: 'native',
    compact_metadata: { trigger: 'auto', pre_tokens: 182_000, post_tokens: 24_000, preserved_segment: {} },
  })
  assert.equal(compacted?.type, 'context_compacted')
  assert.deepEqual(compacted?.payload, { turnId: 'turn_1', trigger: 'auto', preTokens: 182_000, postTokens: 24_000 })
  // A boundary the CLI stamps without its metadata still marks the seam.
  const [bare] = mapSdkMessage(state, { type: 'system', subtype: 'compact_boundary', session_id: 'native' })
  assert.deepEqual(bare?.payload, { turnId: 'turn_1' })
  // Other system messages carry nothing the transcript shows.
  assert.deepEqual(mapSdkMessage(state, { type: 'system', subtype: 'status', session_id: 'native' }), [])
})

test('a Claude compacting status says so once per compaction, however often the CLI repeats it', () => {
  const state = mapperState()
  const status = (value: string | null) =>
    mapSdkMessage(state, { type: 'system', subtype: 'status', status: value, session_id: 'native' })
  const [compacting] = status('compacting')
  assert.equal(compacting?.type, 'context_compacting')
  assert.deepEqual(compacting?.payload, { turnId: 'turn_1' })
  // The CLI sends it again every half minute while it summarises.
  assert.deepEqual(status('compacting'), [])
  mapSdkMessage(state, { type: 'system', subtype: 'compact_boundary', session_id: 'native' })
  // The next compaction is its own.
  assert.equal(status('compacting')[0]?.type, 'context_compacting')
  assert.deepEqual(status(null), [])
  assert.equal(status('compacting')[0]?.type, 'context_compacting')
})

test('a /compact reports the window as the summary left it, not as full as the last request was', () => {
  const state = mapperState()
  mapSdkMessage(state, { type: 'system', subtype: 'init', session_id: 'native', model: 'claude-opus-4-7' })
  mapSdkMessage(state, {
    type: 'stream_event',
    session_id: 'native',
    parent_tool_use_id: null,
    event: { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 180_000 } } },
  })
  const result = () =>
    mapSdkMessage(state, {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 'native',
      usage: { input_tokens: 10, output_tokens: 0 },
      modelUsage: { 'claude-opus-4-7': { contextWindow: 200_000 } },
    }).find((event) => event.type === 'usage_updated')
  assert.equal(result()?.payload?.contextUsed, 180_010)
  // The compaction makes no request the stream shows before its result.
  mapSdkMessage(state, {
    type: 'system',
    subtype: 'compact_boundary',
    session_id: 'native',
    compact_metadata: { trigger: 'manual', pre_tokens: 180_010, post_tokens: 12_000 },
  })
  assert.equal(result()?.payload?.contextUsed, 12_000)
  // A boundary that does not say what is left reports no reading at all.
  mapSdkMessage(state, { type: 'system', subtype: 'compact_boundary', session_id: 'native' })
  assert.equal(result()?.payload?.contextUsed, undefined)
})

test('a Claude API retry tells the turn why it has nothing yet and when the next attempt runs', () => {
  const state = mapperState()
  const [retrying] = mapSdkMessage(state, {
    type: 'system',
    subtype: 'api_retry',
    session_id: 'native',
    attempt: 3,
    max_retries: 10,
    retry_delay_ms: 8_000,
    error_status: 401,
    error: 'authentication_failed',
  })
  assert.equal(retrying?.type, 'turn_retrying')
  assert.deepEqual(retrying?.payload, {
    turnId: 'turn_1',
    attempt: 3,
    maxAttempts: 10,
    retryInMs: 8_000,
    error: 'authentication_failed',
    status: 401,
  })
  // A connection that got no response has no status to report.
  const [unanswered] = mapSdkMessage(state, {
    type: 'system',
    subtype: 'api_retry',
    session_id: 'native',
    attempt: 1,
    max_retries: 10,
    retry_delay_ms: 500,
    error_status: null,
    error: 'unknown',
  })
  assert.deepEqual(unanswered?.payload, {
    turnId: 'turn_1',
    attempt: 1,
    maxAttempts: 10,
    retryInMs: 500,
    error: 'unknown',
  })
})

test('a refusal Claude answered on its fallback model is noted once, and the session reads the fallback model', () => {
  const state: Parameters<typeof mapSdkMessage>[0] = mapperState()
  mapSdkMessage(state, { type: 'system', subtype: 'init', session_id: 'native', model: 'claude-opus-4-7' })
  const fallback = (extra: Record<string, unknown>) =>
    mapSdkMessage(state, {
      type: 'system',
      subtype: 'model_refusal_fallback',
      session_id: 'native',
      trigger: 'refusal',
      direction: 'retry',
      original_model: 'claude-opus-4-7',
      fallback_model: 'claude-sonnet-4-6',
      request_id: null,
      content: 'Opus 4.7 declined this request, so Sonnet 4.6 answered it.',
      uuid: 'refusal-1',
      ...extra,
    })
  // A subagent's answer came from the fallback; the session's model did not change.
  const [local] = fallback({ scope: 'local' })
  assert.equal(local?.type, 'command_output')
  assert.deepEqual(local?.payload, {
    turnId: 'turn_1',
    adapterNote: true,
    output: 'Opus 4.7 declined this request, so Sonnet 4.6 answered it.',
  })
  assert.equal(state.contextModel, 'claude-opus-4-7')
  // The main thread's swap, said again as the turn ends: noted once, read as the session's.
  assert.deepEqual(fallback({ scope: 'session' }), [])
  assert.equal(state.contextModel, 'claude-sonnet-4-6')
  mapSdkMessage(state, { type: 'result', subtype: 'success', is_error: false, session_id: 'native' })
  // The next turn's refusal is noted again, in words of the adapter's own when the CLI sent none.
  state.turn = { turnId: 'turn_2' }
  assert.equal(
    fallback({ content: '' })[0]?.payload?.output,
    'The model declined to answer, so claude-sonnet-4-6 answered instead.',
  )
})

test('a refusal no fallback answered says why with the turn’s failure', () => {
  const state = mapperState()
  const refused = mapSdkMessage(state, {
    type: 'system',
    subtype: 'model_refusal_no_fallback',
    session_id: 'native',
    original_model: 'claude-opus-4-7',
    request_id: 'req_1',
    api_refusal_explanation: 'The request asked for working exploit code.',
    content: '',
    uuid: 'refusal-2',
  })
  assert.deepEqual(refused, [])
  const failed = mapSdkMessage(state, {
    type: 'result',
    subtype: 'success',
    is_error: true,
    session_id: 'native',
    result: 'API Error: Claude declined to respond to this request.',
  }).find((event) => event.type === 'turn_failed')
  assert.equal(
    failed?.payload?.message,
    'API Error: Claude declined to respond to this request.\n\nThe request asked for working exploit code.',
  )
  // Said with that turn only.
  state.turn = { turnId: 'turn_2' }
  const next = mapSdkMessage(state, {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: 'native',
    result: 'Something else failed.',
  }).find((event) => event.type === 'turn_failed')
  assert.equal(next?.payload?.message, 'Something else failed.')
})

test('Claude shell results say whether a command was declined, stopped or exited non-zero', () => {
  const state = mapperState()
  const output = (id: string, block: Record<string, unknown>, structured?: Record<string, unknown>) =>
    mapSdkMessage(state, {
      type: 'user',
      session_id: 'native',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, ...block }] },
      ...(structured ? { tool_use_result: structured } : {}),
    }).find((event) => event.type === 'tool_output')?.payload

  assert.deepEqual(
    [output('ok', { content: 'done', is_error: false }, { stdout: 'done', stderr: '', interrupted: false })].map(
      (payload) => [payload?.status, payload?.exitCode],
    ),
    [['ok', 0]],
  )
  const failed = output('failed', { content: 'Exit code 2\nnpm ERR! missing script', is_error: true })
  assert.equal(failed?.status, 'error')
  assert.equal(failed?.exitCode, 2)
  const stopped = output(
    'stopped',
    { content: 'partial', is_error: false },
    { stdout: 'partial', stderr: '', interrupted: true },
  )
  assert.equal(stopped?.status, 'stopped')
  state.declinedToolUseIds.add('declined')
  const declined = output('declined', { content: 'The user denied this tool use in SprintEngine.', is_error: true })
  assert.equal(declined?.status, 'declined')
  assert.equal(declined?.exitCode, undefined)
  assert.equal(state.declinedToolUseIds.size, 0)
  // Other tools keep their plain error status and carry no exit code.
  const read = output('read', { content: 'File does not exist.', is_error: true })
  assert.deepEqual([read?.status, read?.exitCode], ['error', undefined])
})

/** A stand-in SDK whose queries answer every prompt with a result, after an optional delay in loading. */
function skillsHarness(tempDir: string, loadDelayMs = 0) {
  const queries: Record<string, unknown>[] = []
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    queries.push(params.options)
    const pending: Record<string, unknown>[] = []
    let wake = null as (() => void) | null
    let ended = false
    void (async () => {
      for await (const _message of params.prompt) {
        pending.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'native' })
        wake?.()
      }
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      interrupt: async () => {
        ended = true
        wake?.()
      },
      setPermissionMode: async () => undefined,
    }
  }
  const loadQuery = async () => {
    await new Promise((resolve) => setTimeout(resolve, loadDelayMs))
    return query
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: loadQuery as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    tempDir,
  })
  return { adapter, queries }
}

async function skillsWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'claude-skill-plugins-'))
  const workspaceRoot = join(root, 'workspace')
  const tempDir = join(root, 'tmp')
  await mkdir(join(workspaceRoot, '.claude', 'skills', 'example'), { recursive: true })
  await mkdir(tempDir)
  await writeFile(join(workspaceRoot, '.claude', 'skills', 'example', 'SKILL.md'), '---\nname: example\n---\nDo it.')
  const turn = (turnId: string): MockAdapterTurnInput => ({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot,
    turnId,
    requestId: `approval_${turnId}`,
    message: 'hello',
    skills: ['example'],
  })
  return { root, tempDir, turn }
}

async function drain(stream: AsyncIterable<ConversationEvent> | ConversationEvent[]): Promise<ConversationEvent[]> {
  const events: ConversationEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

test('turns racing to start the Claude child stage one skills plugin and spawn one child', async () => {
  const f = await skillsWorkspace()
  const { adapter, queries } = skillsHarness(f.tempDir, 30)
  try {
    await adapter.startSession(f.turn('turn_1'))
    const first = adapter.sendTurn(f.turn('turn_1'))
    const second = adapter.sendTurn(f.turn('turn_2'))
    await Promise.all([drain(await first), drain(await second)])
    assert.equal(queries.length, 1)
    assert.equal((await readdir(f.tempDir)).length, 1)
  } finally {
    await adapter.disposeAll()
    await rm(f.root, { recursive: true, force: true })
  }
})

test('disposing every Claude child settles only once their skills plugins are removed', async () => {
  const f = await skillsWorkspace()
  const { adapter } = skillsHarness(f.tempDir)
  try {
    await adapter.startSession(f.turn('turn_1'))
    await drain(await adapter.sendTurn(f.turn('turn_1')))
    assert.equal((await readdir(f.tempDir)).length, 1)
    await adapter.disposeAll()
    assert.deepEqual(await readdir(f.tempDir), [])
  } finally {
    await rm(f.root, { recursive: true, force: true })
  }
})

test('a skills plugin left by a process that is gone is swept, one a live process owns is kept', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'claude-skill-sweep-'))
  try {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const folders = {
      // No process can have this id on macOS, Linux or Windows.
      dead: 'sprintengine-claude-skills-99999999-abc',
      live: `sprintengine-claude-skills-${process.ppid}-abc`,
      legacy: 'sprintengine-claude-skills-abc123',
      unrelated: 'other-tool-99999999-abc',
    }
    for (const name of Object.values(folders)) {
      await mkdir(join(tempDir, name, '.claude-plugin'), { recursive: true })
      await utimes(join(tempDir, name), old, old)
    }
    await sweepStaleSkillPlugins(tempDir)
    assert.deepEqual((await readdir(tempDir)).sort(), [folders.live, folders.unrelated].sort())
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

// The sequence Claude Code 2.1 streams for one agent launched in the background
// (recorded from a real run): the launch notice comes back at once, the turn
// ends, and the agent reports its progress and its end through task messages.
test('a background Claude agent keeps its lane open until it reports, then closes it with its answer', () => {
  const state = { ...mapperState(), subagents: new Map() }
  const types = (events: ConversationEvent[]) => events.map((event) => event.type)
  const map = (message: Record<string, unknown>) => mapSdkMessage(state, { session_id: 'native', ...message })

  map({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { subagent_type: 'Explore' } }] },
  })
  const started = map({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task_bg',
    tool_use_id: 'toolu_bg',
    description: 'Count .txt files',
    task_type: 'local_agent',
    subagent_type: 'Explore',
    is_backgrounded: true,
  })
  assert.deepEqual(types(started), ['subagent_status'])
  assert.deepEqual(started[0]?.payload, {
    toolUseId: 'toolu_bg',
    taskId: 'task_bg',
    status: 'running',
    background: true,
    subagentType: 'Explore',
    description: 'Count .txt files',
  })
  assert.equal('turnId' in (started[0]?.payload ?? {}), false, 'an agent outlives its turn, so its status carries none')

  // The launch notice is for the model; the lane waits for the agent.
  const ack = map({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_bg',
          content: [
            { type: 'text', text: 'Async agent launched successfully. (This tool result is internal metadata)' },
          ],
        },
      ],
    },
  })
  assert.deepEqual(ack, [])

  state.turn = null
  const progress = map({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task_bg',
    tool_use_id: 'toolu_bg',
    description: 'Count .txt files',
    last_tool_name: 'Bash',
    summary: 'Listing the directory',
    usage: { total_tokens: 9287, tool_uses: 1, duration_ms: 6011 },
  })
  assert.equal(progress[0]?.payload?.lastToolName, 'Bash')
  assert.equal(progress[0]?.payload?.progressSummary, 'Listing the directory')
  assert.deepEqual(progress[0]?.payload?.usage, { totalTokens: 9287, toolUses: 1, durationMs: 6011 })

  // The agent's own words go to its thread, and its last ones are its answer.
  const said = map({
    type: 'assistant',
    parent_tool_use_id: 'toolu_bg',
    message: {
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'There are 2 files.' },
      ],
    },
  })
  assert.deepEqual(types(said), ['subagent_message'])
  assert.deepEqual(said[0]?.payload, { parentToolUseId: 'toolu_bg', text: 'There are 2 files.' })
  assert.equal('turnId' in (said[0]?.payload ?? {}), false, 'an agent speaks outside any turn of the chat')
  assert.deepEqual(
    map({ type: 'system', subtype: 'task_updated', task_id: 'task_bg', patch: { status: 'completed', end_time: 42 } }),
    [],
  )
  const finished = map({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task_bg',
    tool_use_id: 'toolu_bg',
    status: 'completed',
    output_file: '/tmp/task_bg.output',
    summary: '2',
    usage: { total_tokens: 10065, tool_uses: 1, duration_ms: 7333 },
  })
  assert.deepEqual(types(finished), ['tool_output', 'subagent_status'])
  assert.equal(finished[0]?.payload?.toolUseId, 'toolu_bg')
  assert.equal(finished[0]?.payload?.output, 'There are 2 files.')
  assert.equal(finished[0]?.payload?.status, 'ok')
  assert.equal(finished[0]?.payload?.backgroundResult, true)
  assert.equal(finished[0]?.payload?.turnId, undefined)
  assert.equal(finished[1]?.payload?.status, 'completed')
  assert.equal(finished[1]?.payload?.endedAt, 42)
  assert.deepEqual(finished[1]?.payload?.usage, { totalTokens: 10065, toolUses: 1, durationMs: 7333 })
  assert.equal(state.subagents.size, 0)
})

// Recorded from a real run: the child running five background agents ended,
// and the next child resumed each with SendMessage. The resumed agent's task
// messages name the SendMessage call while its steps still name the Agent call
// that spawned it, so the lane it reports to is the one it started in.
test('a Claude agent resumed by SendMessage in a later child reports to the lane that spawned it', () => {
  const state = { ...mapperState(), subagents: new Map(), agentLanes: new Map<string, string>() }
  const map = (message: Record<string, unknown>) => mapSdkMessage(state, { session_id: 'native', ...message })
  map({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task_swift',
    tool_use_id: 'toolu_agent',
    description: 'Build Swift macOS app',
    task_type: 'local_agent',
    subagent_type: 'general-purpose',
    is_backgrounded: true,
  })
  // The child ends, and its agents with it.
  state.subagents.clear()

  const resumed = map({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task_swift',
    tool_use_id: 'toolu_send',
    description: 'Build Swift macOS app',
    task_type: 'local_agent',
    subagent_type: 'general-purpose',
    is_backgrounded: true,
  })
  assert.equal(resumed[0]?.payload?.toolUseId, 'toolu_agent')
  assert.equal(resumed[0]?.payload?.status, 'running')
  assert.equal(resumed[0]?.payload?.resumed, true, 'and its ended lane reopens')
  const progress = map({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'task_swift',
    tool_use_id: 'toolu_send',
    last_tool_name: 'Bash',
  })
  assert.equal(progress[0]?.payload?.toolUseId, 'toolu_agent')
  const finished = map({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task_swift',
    tool_use_id: 'toolu_send',
    status: 'completed',
    summary: 'Built it.',
  })
  assert.equal(finished[0]?.type, 'tool_output')
  assert.equal(finished[0]?.payload?.toolUseId, 'toolu_agent', 'its answer lands in its own lane, not on SendMessage')
  assert.equal(finished[1]?.payload?.toolUseId, 'toolu_agent')
  assert.equal(finished[1]?.payload?.status, 'completed')
})

// The same agent after the app restarted: the session that spawned it is gone,
// and only the lane the runtime read back from the transcript says where it ran.
test('a Claude agent resumed by SendMessage after a restart reports to the lane the runtime knew it by', async () => {
  const h = scriptedHarness()
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), knownSubagentLanes: [['task_swift', 'toolu_agent']] })
    const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    h.emit(init)
    h.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task_swift',
      tool_use_id: 'toolu_send',
      description: 'Build Swift macOS app',
      task_type: 'local_agent',
      subagent_type: 'general-purpose',
      is_backgrounded: true,
    })
    h.emit({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task_swift',
      tool_use_id: 'toolu_send',
      status: 'completed',
      summary: 'Built it.',
    })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done

    const statuses = first.events.filter((event) => event.type === 'subagent_status')
    assert.deepEqual(
      statuses.map((event) => [event.payload?.toolUseId, event.payload?.status, event.payload?.resumed]),
      [
        ['toolu_agent', 'running', true],
        ['toolu_agent', 'completed', undefined],
      ],
    )
    const answer = first.events.find((event) => event.type === 'tool_output' && event.payload?.backgroundResult)
    assert.equal(answer?.payload?.toolUseId, 'toolu_agent', 'its answer lands in its own lane, not on SendMessage')
  } finally {
    await h.adapter.disposeAll()
  }
})

// The order Claude Code streams one Monitor in: the call, the whole list of
// background work (which can only say the task is a shell), then the task's
// start, which links it to the call.
test('a Claude monitor is listed as background work until it reports, and housekeeping and agents are not', () => {
  const state = { ...mapperState(), turn: null, tasks: new Map(), monitorCalls: new Map() }
  const map = (message: Record<string, unknown>) => mapSdkMessage(state, { session_id: 'native', ...message })
  const listed = (events: ConversationEvent[]) =>
    events.flatMap((event) => (event.type === 'session_updated' ? [event.payload?.backgroundTasks] : []))

  map({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_mon',
          name: 'Monitor',
          input: { description: 'CI checks', command: 'gh pr checks --watch', timeout_ms: 600000 },
        },
      ],
    },
  })
  assert.deepEqual(
    listed(
      map({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'task_mon', task_type: 'local_bash', description: 'CI checks' },
          { task_id: 'task_agent', task_type: 'local_agent', description: 'Explore the router' },
          { task_id: 'task_ambient', task_type: 'local_bash', description: 'watch settings', ambient: true },
        ],
      }),
    ),
    [[{ taskId: 'task_mon', kind: 'command', description: 'CI checks' }]],
  )
  assert.deepEqual(
    listed(
      map({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_mon',
        tool_use_id: 'toolu_mon',
        task_type: 'local_bash',
        description: 'CI checks',
        is_backgrounded: true,
      }),
    ),
    [[{ taskId: 'task_mon', kind: 'monitor', description: 'CI checks' }]],
    'its start names the Monitor call, so it is a monitor and not a shell',
  )
  assert.deepEqual(
    listed(
      map({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'task_mon', task_type: 'local_bash', description: 'CI checks' }],
      }),
    ),
    [],
    'the same list again is no news, and does not forget it is a monitor',
  )
  assert.deepEqual(
    listed(
      map({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task_mon',
        tool_use_id: 'toolu_mon',
        status: 'completed',
        summary: 'All checks passed',
        output_file: '',
      }),
    ),
    [[]],
  )
})

// A CLI that sends no whole list still says when each task starts, moves to
// the background and ends.
test('Claude shells are listed from their own task messages: a foreground one only once it is backgrounded', () => {
  const state = { ...mapperState(), turn: null, tasks: new Map(), monitorCalls: new Map() }
  const map = (message: Record<string, unknown>) => mapSdkMessage(state, { session_id: 'native', ...message })
  const listed = (events: ConversationEvent[]) =>
    events.flatMap((event) => (event.type === 'session_updated' ? [event.payload?.backgroundTasks] : []))

  assert.deepEqual(
    listed(
      map({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_build',
        tool_use_id: 'toolu_build',
        task_type: 'local_bash',
        description: 'npm run build',
        is_backgrounded: false,
      }),
    ),
    [],
    'a foreground shell is the turn’s own work',
  )
  assert.deepEqual(
    listed(map({ type: 'system', subtype: 'task_updated', task_id: 'task_build', patch: { is_backgrounded: true } })),
    [[{ taskId: 'task_build', kind: 'command', description: 'npm run build' }]],
  )
  assert.deepEqual(
    listed(
      map({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task_flow',
        task_type: 'local_workflow',
        description: 'Review the diff',
      }),
    ),
    [
      [
        { taskId: 'task_build', kind: 'command', description: 'npm run build' },
        { taskId: 'task_flow', kind: 'task', description: 'Review the diff' },
      ],
    ],
  )
  assert.deepEqual(
    listed(map({ type: 'system', subtype: 'task_updated', task_id: 'task_build', patch: { status: 'killed' } })),
    [[{ taskId: 'task_flow', kind: 'task', description: 'Review the diff' }]],
  )
  assert.deepEqual(
    listed(
      map({ type: 'system', subtype: 'task_started', task_id: 'task_dream', task_type: 'dream', description: 'x' }),
    ),
    [],
    'a kind of task this build does not know is left out',
  )
})

test('a foreground Claude agent keeps its own result and background shells are not agents', () => {
  const state = { ...mapperState(), subagents: new Map() }
  const map = (message: Record<string, unknown>) => mapSdkMessage(state, { session_id: 'native', ...message })
  map({
    type: 'system',
    subtype: 'task_started',
    task_id: 'task_fg',
    tool_use_id: 'toolu_fg',
    task_type: 'local_agent',
    is_backgrounded: false,
  })
  const result = map({
    type: 'user',
    parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'Found it in router.ts' }] },
  })
  assert.equal(result[0]?.payload?.output, 'Found it in router.ts')
  const done = map({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task_fg',
    tool_use_id: 'toolu_fg',
    status: 'failed',
    summary: 'Ran out of turns',
  })
  assert.deepEqual(
    done.map((event) => event.type),
    ['subagent_status'],
    'a foreground agent returned its result on its call',
  )
  assert.equal(done[0]?.payload?.status, 'failed')
  assert.equal(done[0]?.payload?.error, 'Ran out of turns')

  assert.deepEqual(
    map({
      type: 'system',
      subtype: 'task_started',
      task_id: 'shell',
      tool_use_id: 'toolu_shell',
      task_type: 'local_bash',
      is_backgrounded: true,
    }),
    [],
  )
  assert.deepEqual(
    map({
      type: 'system',
      subtype: 'task_started',
      task_id: 'watch',
      tool_use_id: 'toolu_watch',
      task_type: 'local_agent',
      ambient: true,
    }),
    [],
  )
})

/**
 * A stand-in SDK driven from the test: every prompt the child reads is
 * recorded, and `emit` plays a message out of the child when the test says so.
 * `refuseModes` stands in for a CLI that will not take a live permission mode.
 */
function scriptedHarness(options: { refuseModes?: boolean; wedged?: boolean; slowModesMs?: number } = {}) {
  const prompts: Record<string, unknown>[] = []
  const spawned: Record<string, unknown>[] = []
  const interrupts: unknown[] = []
  const modes: string[] = []
  const pending: Record<string, unknown>[] = []
  let wake = null as (() => void) | null
  let ended = false
  const query = (params: { prompt: AsyncIterable<Record<string, unknown>>; options: Record<string, unknown> }) => {
    spawned.push(params.options)
    void (async () => {
      for await (const message of params.prompt) prompts.push(message)
    })()
    return {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (!pending.length) await new Promise<void>((resolve) => (wake = resolve))
          while (pending.length) yield pending.shift()!
        }
      },
      // As the CLI does, the child goes on after an interrupt: it still plays
      // out the tail of the exchange it was stopped in.
      // A wedged child (a process hung inside WSL) never answers either.
      interrupt: async (interruptOptions?: unknown) => {
        interrupts.push(interruptOptions)
        if (options.wedged) await new Promise(() => undefined)
      },
      setPermissionMode: async (mode: string) => {
        if (options.wedged) await new Promise(() => undefined)
        if (options.slowModesMs) await new Promise((resolve) => setTimeout(resolve, options.slowModesMs))
        if (options.refuseModes) throw new Error('Cannot set permission mode.')
        modes.push(mode)
      },
    }
  }
  const adapter = createClaudeAgentProvider({
    loadQuery: (async () => query) as never,
    resolveExecutable: async () => '/fake/bin/claude',
    buildEnv: () => ({ PATH: '/usr/bin' }),
    childAnswerTimeoutMs: 30,
  })
  const emit = (message: Record<string, unknown>) => {
    pending.push({ session_id: 'native', ...message })
    wake?.()
  }
  const turn = (turnId: string, overrides: Partial<MockAdapterTurnInput> = {}): MockAdapterTurnInput => ({
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    workspaceRoot: '/Users/dev/app',
    turnId,
    requestId: `approval_${turnId}`,
    message: 'hello',
    ...overrides,
  })
  // The id each prompt was sent with, which a result names to say it answered it.
  const uuidOf = (index: number) => String(prompts[index]?.uuid)
  return { adapter, prompts, spawned, interrupts, modes, emit, turn, uuidOf }
}

/** Read a turn's stream in the background, so the test can act between its events. */
function reader(stream: AsyncIterable<ConversationEvent>) {
  const events: ConversationEvent[] = []
  const done = (async () => {
    for await (const event of stream) events.push(event)
  })()
  return { events, done }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
/**
 * Wait for the child to have read `count` prompts: spawning it is several
 * awaits deep. A spawn takes about a quarter of a second alone; the budget is
 * for a full parallel suite, where two seconds was sometimes not enough.
 */
async function promptsRead(prompts: unknown[], count: number): Promise<void> {
  for (let attempt = 0; prompts.length < count && attempt < 500; attempt++) await settle()
  assert.equal(prompts.length, count)
}
const textDelta = (text: string) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
})
const init = { type: 'system', subtype: 'init' }
const success = (extra: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: false, ...extra })
const turnScoped = (events: ConversationEvent[]) =>
  events.filter((event) => event.type !== 'session_updated').map((event) => [event.type, event.payload?.turnId])

/** Start a session and a first turn, and wait for the child to have its message. */
async function running(h: ReturnType<typeof scriptedHarness>, onSessionEvent?: (event: ConversationEvent) => void) {
  await h.adapter.startSession({ ...h.turn('turn_1'), ...(onSessionEvent ? { onSessionEvent } : {}) })
  const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
  await promptsRead(h.prompts, 1)
  h.emit(init)
  return first
}

test('a message steered in while a Claude tool runs is folded into the running turn, which ends on its one result', async () => {
  const h = scriptedHarness()
  try {
    const continued: ConversationEvent[] = []
    const first = await running(h, (event) => continued.push(event))
    h.emit({ type: 'assistant', uuid: 'reply-1', message: { content: [{ type: 'text', text: 'Running the tests' }] } })
    h.emit({
      type: 'assistant',
      uuid: 'call-1',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }] },
    })
    await settle()
    // A different mode would respawn the child on an ordinary send; a steer
    // never does, or the work it redirects would be lost.
    const steered = await h.adapter.steer({ ...h.turn('turn_1', { mode: 'ask' }), message: 'use the staging file' })
    // Going back to before the message lands before the call that is still
    // waiting for its result, not on it.
    assert.deepEqual(steered, { ok: true, providerCursor: { sessionId: 'native', at: 'reply-1' } })
    await promptsRead(h.prompts, 2)
    assert.match(JSON.stringify(h.prompts[1]), /use the staging file/)
    assert.notEqual(h.uuidOf(0), h.uuidOf(1))
    h.emit({
      type: 'user',
      uuid: 'result-1',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    })
    h.emit(textDelta('Switching to staging'))
    // The CLI takes the message in at the tool round and answers both at once.
    h.emit(success({ user_message_uuids: [h.uuidOf(0), h.uuidOf(1)], total_cost_usd: 0.2 }))
    await first.done

    assert.equal(h.spawned.length, 1, 'the steer reused the running child')
    assert.deepEqual(turnScoped(first.events), [
      ['turn_started', 'turn_1'],
      ['tool_started', 'turn_1'],
      ['tool_output', 'turn_1'],
      ['content_delta', 'turn_1'],
      ['turn_completed', 'turn_1'],
    ])
    assert.equal(first.events.at(-1)?.payload?.costUsd, 0.2)
    // The turn is over, so nothing is steered into it any more, and what the
    // child does next reaches the session channel rather than a closed stream.
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'late' })).ok, false)
    h.emit(textDelta('A background task finished'))
    await settle()
    assert.deepEqual(
      continued.map((event) => event.type),
      ['turn_started', 'content_delta'],
    )
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a message steered in while Claude writes its last reply keeps the turn open for the result that answers it', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    h.emit(textDelta('Done. '))
    await settle()
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'also add a test' })).ok, true)
    await promptsRead(h.prompts, 2)
    // No tool round was left to take it in: the CLI answers the first message,
    // then starts an exchange of its own for the steered one.
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], queued_turn_count: 0, total_cost_usd: 0.1 }))
    await settle()
    assert.equal(
      first.events.some((event) => event.type === 'turn_completed'),
      false,
      'the first result answers only the first message',
    )
    h.emit(init)
    h.emit(textDelta('Added the test.'))
    h.emit(success({ user_message_uuids: [h.uuidOf(1)], result_index: 1, total_cost_usd: 0.25 }))
    await first.done

    const completed = first.events.filter((event) => event.type === 'turn_completed')
    assert.equal(completed.length, 1)
    assert.equal(completed[0]?.payload?.costUsd, 0.25, 'both exchanges are counted once, at the end')
    assert.equal(
      first.events
        .filter((event) => event.type === 'content_delta')
        .map((event) => event.payload?.text)
        .join(''),
      // The second reply starts a paragraph of its own rather than running on.
      'Done. \n\nAdded the test.',
    )
    assert.ok(first.events.every((event) => event.type === 'session_updated' || event.payload?.turnId === 'turn_1'))
  } finally {
    await h.adapter.disposeAll()
  }
})

test('two messages steered into one Claude turn are answered together, and the turn waits for that', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    h.emit(textDelta('Done.'))
    await settle()
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'also lint' })).ok, true)
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'and format' })).ok, true)
    await promptsRead(h.prompts, 3)
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], queued_turn_count: 0 }))
    await settle()
    assert.equal(first.events.filter((event) => event.type === 'turn_completed').length, 0)
    // The CLI merges both into one entry and one result, which names only the
    // last of them where it predates the full list.
    h.emit(init)
    h.emit(success({ user_message_uuid: h.uuidOf(2) }))
    await first.done
    assert.equal(first.events.filter((event) => event.type === 'turn_completed').length, 1)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Claude turn takes no steer before its own message has reached the child', async () => {
  const h = scriptedHarness()
  try {
    await h.adapter.startSession(h.turn('turn_1'))
    const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
    // The child is still being started: there is nothing yet to join.
    assert.deepEqual(await h.adapter.steer({ ...h.turn('turn_1'), message: 'too early' }), {
      ok: false,
      message: 'The agent is not working on that turn any more.',
    })
    await promptsRead(h.prompts, 1)
    assert.equal((await h.adapter.steer({ ...h.turn('turn_9'), message: 'another turn' })).ok, false)
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'now' })).ok, true)
    await promptsRead(h.prompts, 2)
    h.emit(success({ user_message_uuids: [h.uuidOf(0), h.uuidOf(1)] }))
    await first.done
  } finally {
    await h.adapter.disposeAll()
  }
})

test('stopping a Claude turn cancels a steered message the CLI has not taken in yet', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    h.emit(textDelta('Almost done'))
    await settle()
    assert.equal((await h.adapter.steer({ ...h.turn('turn_1'), message: 'also add a test' })).ok, true)
    const stopped = (await h.adapter.interrupt(h.turn('turn_1'))) as ConversationEvent[]
    await first.done
    assert.deepEqual(h.interrupts, [{ cancelQueued: true }])
    assert.equal(stopped[0]?.type, 'turn_failed')
    assert.equal(stopped[0]?.payload?.reason, 'interrupted')
  } finally {
    await h.adapter.disposeAll()
  }
})

/** What the CLI plays out after an interrupt: the rest of the reply, its note, and a failed result. */
function emitInterruptedTail(h: ReturnType<typeof scriptedHarness>, uuids: string[], totalCostUsd: number) {
  h.emit(textDelta(' 3, 4'))
  h.emit({
    type: 'assistant',
    uuid: 'cut-reply',
    message: { content: [{ type: 'text', text: 'Counting: 1, 2, 3, 4' }] },
  })
  h.emit({
    type: 'user',
    uuid: 'cut-note',
    message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  })
  h.emit({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    user_message_uuids: uuids,
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: totalCostUsd,
  })
}

test('what a stopped Claude exchange still plays out reaches no turn, and its cost goes to the next one', async () => {
  const h = scriptedHarness()
  try {
    const continued: ConversationEvent[] = []
    const first = await running(h, (event) => continued.push(event))
    h.emit(textDelta('Counting: 1, 2,'))
    await settle()
    await h.adapter.interrupt(h.turn('turn_1'))
    await first.done
    emitInterruptedTail(h, [h.uuidOf(0)], 0.011)
    await settle()
    assert.deepEqual(
      continued.filter((event) => event.type !== 'session_updated'),
      [],
      'no continuation turn is opened for the tail',
    )

    const second = reader((await h.adapter.sendTurn(h.turn('turn_2'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 2)
    h.emit(init)
    h.emit(textDelta('Hi'))
    h.emit(success({ user_message_uuids: [h.uuidOf(1)], total_cost_usd: 0.015 }))
    await second.done
    const completed = second.events.find((event) => event.type === 'turn_completed')
    assert.equal(completed?.payload?.costUsd, 0.015, 'the stopped exchange is paid for by the next turn')
    // The tail still moved the session on: the next turn ends past it.
    assert.deepEqual(completed?.payload?.providerCursor, { sessionId: 'native', at: 'cut-note' })

    const third = reader((await h.adapter.sendTurn(h.turn('turn_3'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 3)
    h.emit(init)
    h.emit(success({ user_message_uuids: [h.uuidOf(2)], total_cost_usd: 0.02 }))
    await third.done
    const costs = third.events.filter((event) => event.type === 'turn_completed').map((event) => event.payload?.costUsd)
    assert.equal(costs.length, 1)
    assert.ok(Math.abs(Number(costs[0]) - 0.005) < 1e-9, 'and only once')
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a message sent right after a Stop is answered in its own turn, which the stopped result does not end', async () => {
  const h = scriptedHarness()
  try {
    const continued: ConversationEvent[] = []
    const first = await running(h, (event) => continued.push(event))
    h.emit(textDelta('Counting: 1, 2,'))
    await settle()
    // Stop and send: the new message is on its way before the CLI has played
    // out what it was stopped in.
    await h.adapter.interrupt(h.turn('turn_1'))
    await first.done
    const second = reader((await h.adapter.sendTurn(h.turn('turn_2'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 2)
    emitInterruptedTail(h, [h.uuidOf(0)], 0.011)
    await settle()
    assert.deepEqual(turnScoped(second.events), [['turn_started', 'turn_2']], 'the new turn is still open')

    h.emit(init)
    h.emit(textDelta('BANANA'))
    h.emit(success({ user_message_uuids: [h.uuidOf(1)], total_cost_usd: 0.02 }))
    await second.done
    assert.deepEqual(turnScoped(second.events), [
      ['turn_started', 'turn_2'],
      ['content_delta', 'turn_2'],
      ['turn_completed', 'turn_2'],
    ])
    assert.equal(second.events.find((event) => event.type === 'content_delta')?.payload?.text, 'BANANA')
    assert.equal(second.events.at(-1)?.payload?.costUsd, 0.02)
    assert.deepEqual(
      continued.filter((event) => event.type !== 'session_updated'),
      [],
    )
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Stop after a message steered into the last reply leaves no stray turn and no failed session', async () => {
  const h = scriptedHarness()
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'claude-stop-runtime-'))
  const runtime = new ConversationRuntime({
    adapters: [h.adapter],
    getProviderById: () => undefined,
    secretStore: { getStatus: async () => ({ ok: false, message: 'unused' }) },
  })
  try {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: CLAUDE_AGENT_PROVIDER_ID,
      modelId: 'sonnet',
    })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    const events: ConversationEvent[] = []
    runtime.onEvent((event) => events.push(event))
    const sent = runtime.sendTurn({ sessionId, message: 'count to ten' })
    await promptsRead(h.prompts, 1)
    h.emit(init)
    h.emit(textDelta('Counting: 1, 2,'))
    await settle()
    // A steer settles with the stream it joined.
    const steered = runtime.sendTurn({ sessionId, message: 'in French', steer: true })
    await promptsRead(h.prompts, 2)
    assert.equal((await runtime.interrupt({ sessionId })).ok, true)
    assert.equal((await sent).ok, true)
    assert.equal((await steered).ok, true)
    // The CLI names both messages as the ones its stopped exchange answered.
    emitInterruptedTail(h, [h.uuidOf(0), h.uuidOf(1)], 0.011)
    await settle()
    await settle()
    const turnIds = new Set(events.map((event) => event.payload?.turnId).filter(Boolean))
    assert.equal(
      Array.from(turnIds).some((turnId) => String(turnId).includes('_cont_')),
      false,
      'no continuation turn',
    )
    assert.deepEqual(
      events.filter((event) => event.type === 'turn_failed').map((event) => event.payload?.reason),
      ['interrupted'],
    )
    const listed = runtime.listSessions({ workspaceId: 'workspace' })
    assert.ok(listed.ok)
    assert.equal(listed.sessions[0]?.status, 'ready')
  } finally {
    await runtime.shutdown().catch(() => undefined)
    await h.adapter.disposeAll()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a failed Claude result that names only messages nothing waits on does not end the running turn', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    await h.adapter.interrupt(h.turn('turn_1'))
    await first.done
    const second = reader((await h.adapter.sendTurn(h.turn('turn_2'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 2)
    // The new exchange has begun before the stopped one's result arrived.
    h.emit(init)
    h.emit({ type: 'result', subtype: 'error_during_execution', is_error: true, user_message_uuids: [h.uuidOf(0)] })
    await settle()
    assert.equal(
      second.events.some((event) => event.type === 'turn_failed' || event.type === 'turn_completed'),
      false,
    )
    h.emit(success({ user_message_uuids: [h.uuidOf(1)] }))
    await second.done
    assert.equal(second.events.at(-1)?.type, 'turn_completed')
  } finally {
    await h.adapter.disposeAll()
  }
})

// ── Slash commands ──────────────────────────────────────────────────────────

/** The text the child was handed for prompt `index`. */
const promptText = (h: ReturnType<typeof scriptedHarness>, index: number) =>
  (h.prompts[index]?.message as { content: unknown } | undefined)?.content

test('a slash command reaches Claude Code as the message itself, with no skill note ahead of it', async () => {
  const h = scriptedHarness()
  try {
    const skills = { skills: ['acme:deploy'] }
    await h.adapter.startSession(h.turn('turn_1'))
    const command = reader(
      (await h.adapter.sendTurn(
        h.turn('turn_1', { ...skills, message: '/review HEAD~1' }),
      )) as AsyncIterable<ConversationEvent>,
    )
    await promptsRead(h.prompts, 1)
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await command.done
    const prose = reader(
      (await h.adapter.sendTurn(
        h.turn('turn_2', { ...skills, message: 'now ship it' }),
      )) as AsyncIterable<ConversationEvent>,
    )
    await promptsRead(h.prompts, 2)
    h.emit(success({ user_message_uuids: [h.uuidOf(1)] }))
    await prose.done
    assert.equal(promptText(h, 0), '/review HEAD~1')
    assert.equal(promptText(h, 1), 'Use the attached skills: acme:deploy.\n\nnow ship it')
    // The skills are loaded for the command all the same.
    assert.deepEqual(h.spawned[0]?.skills, ['acme:deploy'])
  } finally {
    await h.adapter.disposeAll()
  }
})

test('images sent with a slash command go ahead of it, so the command is the last block Claude Code reads', () => {
  const image = { mediaType: 'image/png', dataBase64: 'AAAA' } as never
  const command = buildUserMessageContent('/review this screenshot', [image]) as Array<{ type: string }>
  assert.deepEqual(
    command.map((block) => block.type),
    ['image', 'text'],
  )
  const prose = buildUserMessageContent('what is /tmp for?', [image]) as Array<{ type: string }>
  assert.deepEqual(
    prose.map((block) => block.type),
    ['text', 'image'],
  )
})

/** A turn whose message is `message`, answered by `reply` once the child has it. */
async function commandTurn(message: string, reply: (h: ReturnType<typeof scriptedHarness>) => void) {
  const h = scriptedHarness()
  try {
    await h.adapter.startSession(h.turn('turn_1'))
    const turn = reader((await h.adapter.sendTurn(h.turn('turn_1', { message }))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    h.emit(init)
    reply(h)
    await turn.done
    return turn.events.filter((event) => event.type !== 'session_updated')
  } finally {
    await h.adapter.disposeAll()
  }
}

// The shapes Claude Code 2.1.284 sends for `/context`: an assistant message of
// its own making that nothing streams, then a result that repeats the output.
const CONTEXT_OUTPUT = '## Context Usage\n\n**Tokens:** 9.7k / 1m (1%)'
const localTwin = (command: string, text: string) => ({
  type: 'assistant',
  uuid: 'twin-1',
  parent_tool_use_id: null,
  local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
  local_command_run: { command, args: '' },
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
})

test('what a local command printed becomes the turn’s output, shown once', async () => {
  const events = await commandTurn('/context', (h) => {
    h.emit(localTwin('context', CONTEXT_OUTPUT))
    h.emit(
      success({ user_message_uuids: [h.uuidOf(0)], local_command: 'context', result: CONTEXT_OUTPUT, num_turns: 0 }),
    )
  })
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn_started', 'command_output', 'turn_completed'],
  )
  assert.deepEqual(events[1]?.payload, { turnId: 'turn_1', command: 'context', output: CONTEXT_OUTPUT })
})

test('a local command reported only on its result, or as system output, still shows', async () => {
  const onResult = await commandTurn('/usage', (h) => {
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], local_command: 'usage', result: 'Current session: 6% used' }))
  })
  assert.deepEqual(
    onResult.filter((event) => event.type === 'command_output').map((event) => event.payload),
    [{ turnId: 'turn_1', command: 'usage', output: 'Current session: 6% used' }],
  )
  const asSystem = await commandTurn('/usage', (h) => {
    h.emit({
      type: 'system',
      subtype: 'local_command_output',
      content: '<local-command-stdout>6% used</local-command-stdout>',
    })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
  })
  assert.deepEqual(
    asSystem.filter((event) => event.type === 'command_output').map((event) => event.payload?.output),
    ['6% used'],
  )
})

test('a slash command whose `!` line Claude Code refused says why instead of ending with nothing', async () => {
  const refusal =
    'Shell command permission check failed for pattern "!`touch out.txt &amp;&amp; echo done`": touch in ' +
    "'/Users/dev/app/out.txt' needs approval."
  const events = await commandTurn('/project:deploy', (h) => {
    h.emit({
      type: 'user',
      parent_tool_use_id: null,
      isReplay: true,
      message: { role: 'user', content: `<local-command-stderr>${refusal}</local-command-stderr>` },
    })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], num_turns: 0 }))
  })
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn_started', 'command_output', 'turn_completed'],
  )
  assert.equal(
    events[1]?.payload?.output,
    'Shell command permission check failed for pattern "!`touch out.txt && echo done`": touch in ' +
      "'/Users/dev/app/out.txt' needs approval.",
  )
})

test('/compact still marks the compaction, and what it printed is left to that divider', async () => {
  const events = await commandTurn('/compact', (h) => {
    h.emit({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 180000, post_tokens: 20000 },
    })
    h.emit(localTwin('compact', 'Compacted'))
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], local_command: 'compact', result: 'Compacted' }))
  })
  assert.deepEqual(
    events.map((event) => event.type),
    ['turn_started', 'context_compacted', 'turn_completed'],
  )
  assert.deepEqual(events[1]?.payload, { turnId: 'turn_1', trigger: 'manual', preTokens: 180000, postTokens: 20000 })
})

test('a /clear typed into the chat leaves a note that the model no longer has what came before', async () => {
  const events = await commandTurn('/clear', (h) => {
    h.emit({ type: 'conversation_reset', new_conversation_id: 'fresh', uuid: 'reset-1' })
    h.emit({ ...init, session_id: 'fresh' })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)], session_id: 'fresh' }))
  })
  const note = events.find((event) => event.type === 'command_output')
  assert.equal(note?.payload?.command, 'clear')
  assert.equal(note?.payload?.adapterNote, true)
  assert.equal(events.at(-1)?.type, 'turn_completed')
})

test("a live session's init publishes the folder's command list when it changed, and a push replaces it", async () => {
  const cwd = '/Users/dev/live-commands'
  publishConversationCommands({
    cli: 'claude-code',
    cwd,
    commands: [{ name: 'compact', description: 'Free up context', source: 'cli' }],
    fetchedAt: 1,
  })
  const published: string[][] = []
  const stop = onConversationCommandsChanged((catalog) => {
    if (catalog.cwd === cwd) published.push(catalog.commands.map((command) => command.name))
  })
  const h = scriptedHarness()
  try {
    await h.adapter.startSession(h.turn('turn_1', { workspaceRoot: cwd }))
    const turn = reader(
      (await h.adapter.sendTurn(h.turn('turn_1', { workspaceRoot: cwd }))) as AsyncIterable<ConversationEvent>,
    )
    await promptsRead(h.prompts, 1)
    const liveInit = { ...init, slash_commands: ['compact', 'mcp__docs__summarise', 'color'], skills: [] }
    h.emit(liveInit)
    await settle()
    const firstReport = conversationCommandsFor('claude-code', cwd).fetchedAt
    assert.ok(firstReport > 1)
    // Every exchange repeats its init; the same names are not news, but they
    // do say the list is current, so the next `/` does not probe for it.
    h.emit(liveInit)
    await settle()
    assert.equal(published.length, 1)
    assert.ok(conversationCommandsFor('claude-code', cwd).fetchedAt > firstReport)
    h.emit({
      type: 'system',
      subtype: 'commands_changed',
      commands: [
        { name: 'compact', description: 'Free up context', argumentHint: '', builtin: true },
        { name: 'fresh', description: 'New', argumentHint: '' },
      ],
    })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await turn.done
    assert.deepEqual(published, [
      ['compact', 'mcp__docs__summarise'],
      ['compact', 'fresh'],
    ])
    // The known row kept its description through the init.
    assert.equal(conversationCommandsFor('claude-code', cwd).commands[0]?.description, 'Free up context')
    // Nothing of it went into the transcript.
    assert.equal(
      turn.events.some((event) => JSON.stringify(event).includes('mcp__docs__summarise')),
      false,
    )
  } finally {
    stop()
    await h.adapter.disposeAll()
  }
})

test("a chat with skills attached keeps its own command list out of the folder's", async () => {
  const cwd = '/Users/dev/attached-commands'
  const published: unknown[] = []
  const stop = onConversationCommandsChanged((catalog) => {
    if (catalog.cwd === cwd) published.push(catalog)
  })
  const h = scriptedHarness()
  try {
    const input = h.turn('turn_1', { workspaceRoot: cwd, skills: ['acme:deploy'] })
    await h.adapter.startSession(input)
    const turn = reader((await h.adapter.sendTurn(input)) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    h.emit({ ...init, slash_commands: ['acme:deploy'] })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await turn.done
    assert.deepEqual(published, [])
  } finally {
    stop()
    await h.adapter.disposeAll()
  }
})

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: Record<string, unknown>,
) => Promise<{ behavior: string }>

const requestIdsOf = (events: ConversationEvent[], type: 'approval_requested' | 'approval_resolved') =>
  events.filter((event) => event.type === type).map((event) => String(event.payload?.requestId))

test('switching a Claude chat to bypass mid-reply applies at once and answers the asks bypass would not have made', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    const canUseTool = h.spawned[0].canUseTool as CanUseTool
    const compound = canUseTool('Bash', { command: 'ls && echo --- && cat notes 2>/dev/null' }, {})
    void canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Which file?', header: 'File', options: [{ label: 'a' }, { label: 'b' }] }] },
      {},
    )
    void canUseTool('Bash', { command: 'rm -rf build' }, { defaultToNo: true })
    await settle()
    const [bashId, questionId, unsafeId] = requestIdsOf(first.events, 'approval_requested')

    assert.deepEqual(await h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'bypass' }), {
      ok: true,
    })
    assert.deepEqual(h.modes, ['bypassPermissions'])
    assert.equal((await compound).behavior, 'allow')
    await settle()
    // A question is an answer, not a permission, and a call the CLI marks as
    // not approvable by a stray keystroke still waits for the person.
    assert.deepEqual(requestIdsOf(first.events, 'approval_resolved'), [bashId])
    assert.equal(first.events.find((event) => event.type === 'approval_resolved')?.payload?.approved, true)

    // The rest of the reply runs under bypass: the next call asks nobody.
    assert.equal((await canUseTool('Edit', { file_path: 'notes' }, {})).behavior, 'allow')
    assert.equal(requestIdsOf(first.events, 'approval_requested').length, 3)

    for (const requestId of [questionId, unsafeId])
      h.adapter.resolveApproval({ ...h.turn('turn_1'), requestId, approved: false })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done
    const second = reader((await h.adapter.sendTurn(h.turn('turn_2'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 2)
    assert.equal(h.spawned.length, 1, 'the child already runs under bypass, so the next message does not respawn it')
    h.emit(success({ user_message_uuids: [h.uuidOf(1)] }))
    await second.done
  } finally {
    await h.adapter.disposeAll()
  }
})

test('an idle Claude child is switched to bypass in place, not replaced', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done
    assert.deepEqual(await h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'bypass' }), {
      ok: true,
    })
    assert.deepEqual(h.modes, ['bypassPermissions'])
    assert.equal(h.adapter.listLiveSessions()[0]?.hasChildProcess, true)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a Claude child that refuses bypass mid-reply finishes it as it started, and the next message takes bypass', async () => {
  const h = scriptedHarness({ refuseModes: true })
  try {
    const first = await running(h)
    const canUseTool = h.spawned[0].canUseTool as CanUseTool
    const asked = canUseTool('Bash', { command: 'npm test' }, {})
    await settle()
    // No "from your next message": a looser mode is answered by the runtime
    // from the very next request, whatever the child is still running under.
    assert.deepEqual(await h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'bypass' }), {
      ok: true,
    })
    assert.deepEqual(requestIdsOf(first.events, 'approval_resolved'), [], 'the waiting ask is left to the person')
    h.adapter.resolveApproval({ ...h.turn('turn_1'), requestId: 'approval_turn_1', approved: true })
    assert.equal((await asked).behavior, 'allow')
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done

    const second = reader((await h.adapter.sendTurn(h.turn('turn_2'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 2)
    assert.equal(h.spawned.length, 2)
    assert.equal(h.spawned[1].permissionMode, 'bypassPermissions')
    assert.equal(h.spawned[1].resume, 'native', 'the conversation goes on in the same provider session')
    h.emit(success({ user_message_uuids: [h.uuidOf(1)] }))
    await second.done
  } finally {
    await h.adapter.disposeAll()
  }
})

test("leaving bypass mid-reply stops bypassing at once, and the next message runs on the CLI's own default", async () => {
  const h = scriptedHarness()
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), permissionPreset: 'bypass' })
    const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    h.emit(init)
    const canUseTool = h.spawned[0].canUseTool as CanUseTool
    assert.equal(h.spawned[0].permissionMode, 'bypassPermissions')
    assert.equal((await canUseTool('Bash', { command: 'npm test' }, {})).behavior, 'allow')

    assert.deepEqual(await h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'none' }), {
      ok: true,
    })
    assert.deepEqual(h.modes, ['default'])
    const asked = canUseTool('Bash', { command: 'npm publish' }, {})
    await settle()
    assert.equal(requestIdsOf(first.events, 'approval_requested').length, 1, 'the next call asks')
    h.adapter.resolveApproval({ ...h.turn('turn_1'), requestId: 'approval_turn_1', approved: false })
    assert.equal((await asked).behavior, 'deny')
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done

    // 'default' is not necessarily what the CLI's own settings start it on,
    // so the next message respawns the child with no mode pinned.
    const second = reader((await h.adapter.sendTurn(h.turn('turn_2'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 2)
    assert.equal(h.spawned.length, 2)
    assert.equal(h.spawned[1].permissionMode, undefined)
    h.emit(success({ user_message_uuids: [h.uuidOf(1)] }))
    await second.done
  } finally {
    await h.adapter.disposeAll()
  }
})

type PreToolUseHook = (input: Record<string, unknown>) => Promise<Record<string, unknown>>
const preToolUse = (options: Record<string, unknown>): PreToolUseHook =>
  (options.hooks as { PreToolUse: Array<{ hooks: PreToolUseHook[] }> }).PreToolUse[0].hooks[0]
const hookCall = (tool_name: string) => ({ hook_event_name: 'PreToolUse', tool_name, tool_use_id: `use-${tool_name}` })
const hookDecision = async (hook: PreToolUseHook, tool: string) =>
  ((await hook(hookCall(tool))).hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision

test('a Claude chat spawns Manual as default and Auto as the CLI’s own auto mode', async () => {
  for (const [permissionPreset, mode] of [
    ['manual', 'default'],
    ['auto', 'auto'],
  ] as const) {
    const h = scriptedHarness()
    try {
      await h.adapter.startSession({ ...h.turn('turn_1'), permissionPreset })
      const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
      await promptsRead(h.prompts, 1)
      assert.equal(h.spawned[0].permissionMode, mode, permissionPreset)
      h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
      await first.done
    } finally {
      await h.adapter.disposeAll()
    }
  }
})

test('a Claude chat runs Accept edits and Don’t ask at their own presets, and the preset’s own mode elsewhere', async () => {
  for (const [permissionPreset, permissionMode, mode] of [
    ['auto', 'acceptEdits', 'acceptEdits'],
    ['manual', 'dontAsk', 'dontAsk'],
    // A mode at another preset than its own, or one Claude does not have,
    // runs the preset's own mode rather than a guess.
    ['bypass', 'acceptEdits', 'bypassPermissions'],
    ['auto', 'workspace', 'auto'],
  ] as const) {
    const h = scriptedHarness()
    try {
      await h.adapter.startSession({ ...h.turn('turn_1'), permissionPreset, permissionMode })
      const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
      await promptsRead(h.prompts, 1)
      assert.equal(h.spawned[0].permissionMode, mode, `${permissionPreset}/${permissionMode}`)
      h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
      await first.done
    } finally {
      await h.adapter.disposeAll()
    }
  }
})

test('Don’t ask adds no card of its own, and a live switch to Accept edits reaches the child', async () => {
  const h = scriptedHarness()
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), permissionPreset: 'manual', permissionMode: 'dontAsk' })
    const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    const hook = preToolUse(h.spawned[0])
    // What Don't ask refuses is refused by the CLI, not sent to a card.
    assert.deepEqual(await hook(hookCall('Bash')), {})
    await h.adapter.setPermissionPreset({
      ...h.turn('turn_1'),
      permissionPreset: 'auto',
      permissionMode: 'acceptEdits',
    })
    assert.deepEqual(h.modes, ['acceptEdits'])
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done
  } finally {
    await h.adapter.disposeAll()
  }
})

test('Manual sends every action that changes something to a card, and lets lookups run', async () => {
  const h = scriptedHarness()
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), permissionPreset: 'manual' })
    const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    const hook = preToolUse(h.spawned[0])
    for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch', 'mcp__github__create_pr', 'Task'])
      assert.equal(await hookDecision(hook, tool), 'ask', tool)
    for (const tool of ['Read', 'Grep', 'Glob', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode'])
      assert.deepEqual(await hook(hookCall(tool)), {}, tool)

    // Leaving Manual lets the CLI's own mode decide again, from the next call.
    await h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'auto' })
    assert.deepEqual(h.modes, ['auto'])
    assert.deepEqual(await hook(hookCall('Bash')), {})
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a mode switch a wedged child never answers does not hold the switch, and a looser mode needs no next message', async () => {
  const h = scriptedHarness({ wedged: true })
  try {
    await running(h)
    assert.deepEqual(await h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'auto' }), {
      ok: true,
    })
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a switch a slow child takes late is not trusted, so switching back still reaches the child', async () => {
  const h = scriptedHarness({ slowModesMs: 60 })
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), permissionPreset: 'auto' })
    const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    h.emit(init)
    await h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'bypass' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepEqual(h.modes, ['bypassPermissions'], 'the child took bypass after all')
    await h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'auto' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(h.modes.length, 2, 'the switch back is sent, not taken as already in force')
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done
  } finally {
    await h.adapter.disposeAll()
  }
})

test('a switch back made while the child is still answering a switch reaches the child too', async () => {
  const h = scriptedHarness({ slowModesMs: 30 })
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), permissionPreset: 'auto' })
    const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    h.emit(init)
    const toBypass = h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'bypass' })
    const back = h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'auto' })
    await Promise.all([toBypass, back])
    assert.deepEqual(h.modes, ['bypassPermissions', 'auto'], 'the child ends on auto, not on bypass')
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done
  } finally {
    await h.adapter.disposeAll()
  }
})

test('Stop on a child that never acknowledges it ends the child, so the next message starts a fresh one', async () => {
  const h = scriptedHarness({ wedged: true })
  try {
    await running(h)
    h.adapter.interrupt(h.turn('turn_1'))
    assert.equal(h.adapter.listLiveSessions()[0]?.hasChildProcess, true, 'given its moment to answer')
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(h.adapter.listLiveSessions()[0]?.hasChildProcess, false)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('an answer to a card no child holds any more closes the card and ends a turn with no child', async () => {
  const h = scriptedHarness({ wedged: true })
  try {
    await running(h)
    h.adapter.interrupt(h.turn('turn_1'))
    await new Promise((resolve) => setTimeout(resolve, 60))
    const events = h.adapter.resolveApproval({
      ...h.turn('turn_1'),
      requestId: 'approval_gone',
      approved: true,
    }) as ConversationEvent[]
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_resolved', 'turn_failed'],
    )
    assert.equal(events[0]?.payload?.requestId, 'approval_gone')
  } finally {
    await h.adapter.disposeAll()
  }
})

test('choosing Manual mid-reply holds the very next call, even before the child has taken the mode', async () => {
  const h = scriptedHarness({ refuseModes: true })
  try {
    await h.adapter.startSession({ ...h.turn('turn_1'), permissionPreset: 'bypass' })
    const first = reader((await h.adapter.sendTurn(h.turn('turn_1'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 1)
    const hook = preToolUse(h.spawned[0])
    assert.deepEqual(await hook(hookCall('Bash')), {})
    // In force at once through the hook, so nothing waits for a next message.
    assert.deepEqual(await h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset: 'manual' }), {
      ok: true,
    })
    assert.equal(await hookDecision(hook, 'Bash'), 'ask')
    // What the child, still on bypass, sends to canUseTool is not answered
    // for the person any more.
    const canUseTool = h.spawned[0].canUseTool as CanUseTool
    const asked = canUseTool('Bash', { command: 'npm publish' }, {})
    await settle()
    assert.equal(requestIdsOf(first.events, 'approval_requested').length, 1, 'the call asks')
    h.adapter.resolveApproval({ ...h.turn('turn_1'), requestId: 'approval_turn_1', approved: false })
    assert.equal((await asked).behavior, 'deny')
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done

    // The next message respawns the child under Manual.
    const second = reader((await h.adapter.sendTurn(h.turn('turn_2'))) as AsyncIterable<ConversationEvent>)
    await promptsRead(h.prompts, 2)
    assert.equal(h.spawned.length, 2)
    assert.equal(h.spawned[1].permissionMode, 'default')
    h.emit(success({ user_message_uuids: [h.uuidOf(1)] }))
    await second.done
  } finally {
    await h.adapter.disposeAll()
  }
})

test('an idle Claude child moves between Manual, Auto and Bypass in place', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done
    for (const permissionPreset of ['auto', 'manual', 'bypass'] as const)
      assert.deepEqual(await h.adapter.setPermissionPreset({ ...h.turn('turn_1'), permissionPreset }), { ok: true })
    assert.deepEqual(h.modes, ['auto', 'default', 'bypassPermissions'])
    assert.equal(h.spawned.length, 1)
    assert.equal(h.adapter.listLiveSessions()[0]?.hasChildProcess, true)
  } finally {
    await h.adapter.disposeAll()
  }
})

test('an ask bypass would still have made is marked as one no mode answers', async () => {
  const h = scriptedHarness()
  try {
    const first = await running(h)
    const canUseTool = h.spawned[0].canUseTool as CanUseTool
    void canUseTool('Bash', { command: 'npm test' }, {})
    void canUseTool('Bash', { command: 'rm -rf build' }, { defaultToNo: true })
    void canUseTool('Bash', { command: 'git push' }, { matchedAskRule: { toolName: 'Bash' } } as never)
    await settle()
    const asked = first.events.filter((event) => event.type === 'approval_requested')
    assert.deepEqual(
      asked.map((event) => event.payload?.mustAsk === true),
      [false, true, true],
    )
    for (const event of asked)
      h.adapter.resolveApproval({ ...h.turn('turn_1'), requestId: String(event.payload?.requestId), approved: false })
    h.emit(success({ user_message_uuids: [h.uuidOf(0)] }))
    await first.done
  } finally {
    await h.adapter.disposeAll()
  }
})
