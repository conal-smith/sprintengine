import type { IpcMain, WebContents } from 'electron'
import type {
  ConversationWorkspaceKey,
  ConversationThreadsResult,
  ConversationSearchInput,
  ConversationSearchResult,
  ConversationRenameInput,
} from '../../shared/conversation-index'
import type { ConversationSearchHit } from '../../shared/conversation-index'

import type {
  CliAvailability,
  CliDetectResult,
  CliRuntimeSettings,
  ConversationProviderListResult,
  ConversationProviderModelsInput,
  ConversationProviderModelsResult,
  ConversationSecretClearInput,
  ConversationSecretClearResult,
  ConversationSecretSetInput,
  ConversationSecretSetResult,
  ConversationSecretStatusInput,
  ConversationSecretStatusResult,
} from '../../shared/electron-api'
import type {
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationInterruptInput,
  ConversationProvidersListInput,
  ConversationProviderSignInInput,
  ConversationProviderSignInResult,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationSetModelInput,
  ConversationMcpServerActionInput,
  ConversationStopSubagentInput,
  ConversationCancelSideQuestionInput,
  ConversationSideQuestionInput,
  ConversationSideQuestionResult,
  ConversationMcpServerActionResult,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
  ConversationSuspendSessionInput,
  ConversationTerminalHandoffInput,
  ConversationTerminalHandoffResult,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationAttachmentResult,
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
  ConversationSubscribeInput,
  ConversationLoadEarlierInput,
  ConversationSessionFrame,
  ConversationPageResult,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationRewindInput,
  ConversationRewindResult,
  ConversationHandoffInput,
  ConversationHandoffResult,
  ConversationSwitchProviderInput,
  ConversationSwitchProviderResult,
  ConversationForkInput,
  ConversationForkResult,
  ConversationApprovalRulesResult,
  ConversationApprovalRuleRevokeResult,
  ConversationEventType,
  ConversationContextBreakdownInput,
  ConversationContextBreakdownResult,
} from '../../shared/conversation-runtime'
import {
  parseProviderInput,
  parseRespondToRequestInput,
  parseSecretSetInput,
  parseSendTurnInput,
  parseSessionIdInput,
  parseSetModelInput,
  parseMcpServerActionInput,
  parseStopSubagentInput,
  parseSideQuestionInput,
  parseCancelSideQuestionInput,
  parseSetPermissionInput,
  parseStartSessionInput,
  parseTranscriptInput,
} from '../conversation-ipc-inputs'
import { ConversationRuntime } from '../conversation-runtime'
import type { ConversationBackend } from '../../server/core/conversation-backend'
import { ConversationSessionApi } from '../conversation-session-api'
import { detectAgentCliAvailability, recordCliDetection } from '../cli-availability'
import { detectCli } from '../cli-runtime-install'
import { resolveConversationSignIn } from '../conversation-sign-in'
import {
  getConversationProviderById,
  listConversationProviderRegistryEntries,
  listPluginRegistryEntries,
} from '../plugin-registry-instance'
import { listOpenAiCompatibleModels } from '../providers/openai-compatible-provider'
import { getSharedCredentialStore } from '../secret-store'
import { isRecord } from '../../shared/records'
import { cliForConversationProvider } from '../../shared/conversation-harness'

export type ConversationIpcHandlers = {
  listThreads?(input: ConversationWorkspaceKey): Promise<ConversationThreadsResult>
  searchThreads?(
    input: ConversationSearchInput,
    options: { signal: AbortSignal; onBatch?: (hits: ConversationSearchHit[]) => void },
  ): Promise<ConversationSearchResult>
  renameThread?(input: ConversationRenameInput): Promise<{ ok: true } | { ok: false; message: string }>
  deleteThread?(input: ConversationTranscriptInput): Promise<{ ok: true } | { ok: false; message: string }>
  listProviders(input?: ConversationProvidersListInput): Promise<ConversationProviderListResult>
  listProviderModels(input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult>
  resolveSignIn?(input: ConversationProviderSignInInput): Promise<ConversationProviderSignInResult>
  getSecretStatus(input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult>
  setSecret(input: ConversationSecretSetInput): Promise<ConversationSecretSetResult>
  clearSecret(input: ConversationSecretClearInput): Promise<ConversationSecretClearResult>
  startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>
  sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult>
  interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult>
  respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult>
  setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult>
  setModel?(input: ConversationSetModelInput): Promise<ConversationSessionActionResult>
  mcpServerAction?(input: ConversationMcpServerActionInput): Promise<ConversationMcpServerActionResult>
  stopSubagent?(input: ConversationStopSubagentInput): Promise<ConversationSessionActionResult>
  askSideQuestion?(input: ConversationSideQuestionInput): Promise<ConversationSideQuestionResult>
  cancelSideQuestion?(
    input: ConversationCancelSideQuestionInput,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  readContextBreakdown?(input: ConversationContextBreakdownInput): Promise<ConversationContextBreakdownResult>
  stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult>
  suspendSession?(input: ConversationSuspendSessionInput): Promise<ConversationSessionActionResult>
  terminalHandoff?(input: ConversationTerminalHandoffInput): Promise<ConversationTerminalHandoffResult>
  listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult
  readTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult>
  getToolDetail?(input: ConversationToolDetailInput): Promise<ConversationToolDetailResult>
  readAttachment?(ref: string): Promise<ConversationAttachmentResult>
  planDocument?(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult>
  subscribe?(
    input: ConversationSubscribeInput,
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose: () => void; ready: Promise<void> }
  loadEarlier?(input: ConversationLoadEarlierInput): Promise<ConversationPageResult>
  getTurnDiff?(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult>
  revertToTurn?(input: ConversationRevertInput): Promise<ConversationRevertResult>
  rewindToTurn?(input: ConversationRewindInput): Promise<ConversationRewindResult>
  handoffConversation?(input: ConversationHandoffInput): Promise<ConversationHandoffResult>
  switchConversationProvider?(input: ConversationSwitchProviderInput): Promise<ConversationSwitchProviderResult>
  forkAtTurn?(input: ConversationForkInput): Promise<ConversationForkResult>
  listApprovalRules?(): Promise<ConversationApprovalRulesResult>
  revokeApprovalRule?(ruleId: string): Promise<ConversationApprovalRuleRevokeResult>
  onEvent(listener: (event: ConversationEvent) => void): () => void
}

/**
 * What the all-conversations channel (`conversation:event`) forwards: a chat's
 * lifecycle and status, never its per-token stream. Every workspace window
 * subscribes, and its readers (the session list, the history rows) only ask
 * whether a chat started, moved, waited or ended. Reply and reasoning deltas,
 * and a running tool's partial output, went to every window, hidden ones
 * included, dozens of times a second per streaming chat, only to be dropped
 * there. The pane showing a chat reads its stream on the scoped channel
 * (`conversation:session-event`), which is unchanged.
 */
const BROADCAST_EVENT_TYPES: ReadonlySet<ConversationEventType> = new Set<ConversationEventType>([
  'session_started',
  'session_ready',
  'session_updated',
  'session_closed',
  'user_message',
  'turn_started',
  'tool_started',
  'tool_output',
  'approval_requested',
  'approval_resolved',
  'usage_updated',
  'context_compacted',
  'context_compacting',
  'context_handed_off',
  'command_output',
  'turn_completed',
  'turn_failed',
  'subagent_status',
  'subagent_message',
])

/**
 * An event as this app's own window reads it. A stored tool result carries
 * its text twice, as `preview` and as `output`, for readers that know only
 * one of the names; the window reads `preview` first, so the copy is left
 * out of what crosses to it, which is a fifth to a third of a snapshot of a
 * chat that ran many tools. Other wires carry the event as stored.
 */
export function eventForWindow(event: ConversationEvent): ConversationEvent {
  const payload = event.payload
  if (event.type !== 'tool_output' || typeof payload?.preview !== 'string' || payload.output !== payload.preview)
    return event
  const { output: _copy, ...rest } = payload
  return { ...event, payload: rest }
}

export function frameForWindow(frame: ConversationSessionFrame): ConversationSessionFrame {
  if (frame.type === 'event') return { ...frame, event: eventForWindow(frame.event) }
  if (frame.type === 'snapshot')
    return { ...frame, page: { ...frame.page, events: frame.page.events.map(eventForWindow) } }
  return frame
}

/**
 * What the all-chats broadcast carries of an event: whose it is, what kind,
 * and when. Its reader (the sessions list) only learns from it that a chat
 * moved and asks for the list again; the payload, a tool's input or result
 * among them, went to every window for every step of every chat unread.
 */
function broadcastEnvelope(event: ConversationEvent): ConversationEvent {
  const { payload: _payload, parts: _parts, ...envelope } = event as ConversationEvent & { parts?: unknown }
  return envelope
}

export function isConversationBroadcastEvent(event: ConversationEvent): boolean {
  if (!BROADCAST_EVENT_TYPES.has(event.type)) return false
  // A running tool's output streams; its final output says the tool is done.
  return !(event.type === 'tool_output' && event.payload?.partial === true)
}

// Agent-harness conversation providers ride a local CLI (the shared table in
// conversation-harness); when that CLI is not installed the provider is hidden
// from the picker instead of failing at session start.
//
// Every chat asks for the provider list as it opens, so the answer comes from
// the app's own CLI availability (cli-availability.ts): probed at startup,
// held until Re-check or an install, and one probe per CLI however many ask at
// once. Probing here instead started a `--version` of every harness CLI on
// each chat opened a minute after the last, once per window and pane asking,
// and a New chat on a worktree paid for them while its `worktree add` ran.

// The app holds "not installed" until Re-check, so a CLI installed from a
// terminal since would stay unavailable in every chat; it is looked at again,
// at most this often, rather than on every list.
const CLI_UNAVAILABLE_TTL_MS = 30_000

export type HarnessCliCheckDeps = {
  /** The app's held answer for one CLI (probed only when it has none), or undefined when its probe failed. */
  availability?: (cli: string, runtime: Partial<CliRuntimeSettings> | undefined) => Promise<CliAvailability | undefined>
  /** A probe of one CLI, for a "not installed" looked at again. */
  detect?: (cli: string, runtime: Partial<CliRuntimeSettings> | undefined) => Promise<CliDetectResult>
  /** Tells the app's held answer what a probe here found. */
  record?: (runtime: Partial<CliRuntimeSettings> | undefined, detected: CliDetectResult) => void
  now?: () => number
}

async function heldCliAvailability(
  cli: string,
  runtime: Partial<CliRuntimeSettings> | undefined,
): Promise<CliAvailability | undefined> {
  const entry = listPluginRegistryEntries().find((candidate) => candidate.id === cli)
  if (!entry) return { cli, installed: false, resolvedPath: null, version: null }
  const availability = await detectAgentCliAvailability(
    { cliRuntimes: runtime ? { [cli]: runtime } : undefined },
    { listEntries: () => [entry] },
  )
  return availability[cli]
}

/** Whether a harness provider's CLI can be started, for the provider list. */
export function createHarnessCliCheck(
  deps: HarnessCliCheckDeps = {},
): (cli: string, cliRuntimes?: ConversationCliRuntimeOverrides) => Promise<boolean> {
  const availability = deps.availability ?? heldCliAvailability
  const detect = deps.detect ?? ((cli, runtime) => detectCli(cli, runtime))
  const record = deps.record ?? recordCliDetection
  const now = deps.now ?? Date.now
  const rechecks = new Map<string, { at: number; installed: Promise<boolean> }>()

  return async (cli, cliRuntimes) => {
    const runtime = cliRuntimes?.[cli]
    let held: CliAvailability | undefined
    try {
      held = await availability(cli, runtime)
    } catch {
      held = undefined
    }
    // Fail open: a probe that could not decide must not silently hide the
    // provider — a missing CLI still fails loudly (and actionably) at session
    // start.
    if (!held) return true
    if (held.installed && held.resolvedPath) return true
    const key = `${cli}:${runtime?.command?.trim() ?? ''}:${runtime?.hostId ?? 'local'}`
    const last = rechecks.get(key)
    if (last && now() - last.at < CLI_UNAVAILABLE_TTL_MS) return last.installed
    const installed = detect(cli, runtime).then(
      (detected) => {
        if (detected.error === null) record(runtime, detected)
        return detected.installed && Boolean(detected.resolvedPath)
      },
      () => true,
    )
    rechecks.set(key, { at: now(), installed })
    return installed
  }
}

export function createConversationIpcHandlers(
  // The app passes the core's chats (the core owns the runtime, so shutdown and
  // diagnostics reach it); constructing a runtime here keeps tests/legacy
  // callers working standalone.
  runtime: ConversationBackend = new ConversationRuntime({ secretStore: getSharedCredentialStore() }),
): ConversationIpcHandlers {
  const secretStore = getSharedCredentialStore()
  const sessions = new ConversationSessionApi(runtime)
  const isHarnessCliInstalled = createHarnessCliCheck()

  return {
    listThreads: (input) => runtime.listThreads(input),
    searchThreads: (input, options) => runtime.searchThreads(input, options),
    renameThread: (input) => runtime.renameThread(input),
    deleteThread: (input) => runtime.deleteTranscript(input),
    async listProviders(input?: ConversationProvidersListInput): Promise<ConversationProviderListResult> {
      try {
        const providers = listConversationProviderRegistryEntries().map((provider) => ({
          ...provider,
          capabilities: runtime.getProviderCapabilities(provider.id),
        }))
        const listed: typeof providers = []
        for (const provider of providers) {
          const harnessCli = cliForConversationProvider(provider.id)
          if (harnessCli && !(await isHarnessCliInstalled(harnessCli, input?.cliRuntimes))) {
            // Never hide the provider: an undetectable CLI is annotated so the
            // picker can say WHY it is unavailable (spawn defaults skip it).
            listed.push({
              ...provider,
              unavailable: `The ${provider.displayName} CLI wasn’t found from the app. Launch SprintEngine from a terminal, or set a command override in Settings → CLI runtimes.`,
            })
            continue
          }
          listed.push(provider)
        }
        return { ok: true, providers: listed }
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
    listProviderModels(input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult> {
      const nativeModels = runtime.getNativeProviderModels(input.providerId)
      if (nativeModels) return Promise.resolve({ ok: true, models: nativeModels })
      return listOpenAiCompatibleModels({
        providerId: input.providerId,
        getProviderById: getConversationProviderById,
        resolveSecret: (providerId) => secretStore.resolveSecret(providerId),
      })
    },
    resolveSignIn(input: ConversationProviderSignInInput): Promise<ConversationProviderSignInResult> {
      return resolveConversationSignIn(input)
    },
    getSecretStatus(input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult> {
      return secretStore.getStatus(input.providerId)
    },
    setSecret(input: ConversationSecretSetInput): Promise<ConversationSecretSetResult> {
      return secretStore.setSecret(input.providerId, input.value)
    },
    clearSecret(input: ConversationSecretClearInput): Promise<ConversationSecretClearResult> {
      return secretStore.clearSecret(input.providerId)
    },
    startSession(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> {
      return runtime.startSession(input)
    },
    sendTurn(input: ConversationSendTurnInput): Promise<ConversationSessionActionResult> {
      return runtime.sendTurn(input)
    },
    interrupt(input: ConversationInterruptInput): Promise<ConversationSessionActionResult> {
      return runtime.interrupt(input)
    },
    respondToRequest(input: ConversationRespondToRequestInput): Promise<ConversationSessionActionResult> {
      return runtime.respondToRequest(input)
    },
    setPermission(input: ConversationSetPermissionInput): Promise<ConversationSessionActionResult> {
      return runtime.setPermission(input)
    },
    setModel(input: ConversationSetModelInput): Promise<ConversationSessionActionResult> {
      return runtime.setModel(input)
    },
    mcpServerAction(input: ConversationMcpServerActionInput): Promise<ConversationMcpServerActionResult> {
      return runtime.mcpServerAction(input)
    },
    stopSubagent(input: ConversationStopSubagentInput): Promise<ConversationSessionActionResult> {
      return runtime.stopSubagent(input)
    },
    askSideQuestion(input: ConversationSideQuestionInput): Promise<ConversationSideQuestionResult> {
      return runtime.askSideQuestion(input)
    },
    cancelSideQuestion(
      input: ConversationCancelSideQuestionInput,
    ): Promise<{ ok: true } | { ok: false; message: string }> {
      return runtime.cancelSideQuestion(input)
    },
    readContextBreakdown(input: ConversationContextBreakdownInput): Promise<ConversationContextBreakdownResult> {
      return runtime.readContextBreakdown(input)
    },
    stopSession(input: ConversationStopSessionInput): Promise<ConversationSessionActionResult> {
      return runtime.stopSession(input)
    },
    suspendSession(input: ConversationSuspendSessionInput): Promise<ConversationSessionActionResult> {
      return runtime.suspendSession(input)
    },
    listSessions(input?: ConversationListSessionsInput): ConversationListSessionsResult {
      return runtime.listSessions(input)
    },
    readTranscript(input: ConversationTranscriptInput): Promise<ConversationTranscriptResult> {
      return runtime.readTranscript(input)
    },
    readAttachment(ref) {
      return runtime.readAttachment(ref)
    },
    planDocument(input) {
      return runtime.planDocument(input)
    },
    getToolDetail(input) {
      return runtime.getToolDetail(input)
    },
    listApprovalRules() {
      return runtime.listApprovalRules()
    },
    revokeApprovalRule(ruleId) {
      return runtime.revokeApprovalRule(ruleId)
    },
    subscribe(input, listener) {
      return sessions.subscribe(input, listener)
    },
    loadEarlier(input) {
      return sessions.loadEarlier(input)
    },
    getTurnDiff(input) {
      return sessions.getTurnDiff(input)
    },
    revertToTurn(input) {
      return sessions.revertToTurn(input)
    },
    rewindToTurn(input) {
      return sessions.rewindToTurn(input)
    },
    handoffConversation(input) {
      return sessions.handoffConversation(input)
    },
    switchConversationProvider(input) {
      return runtime.switchConversationProvider(input)
    },
    forkAtTurn(input) {
      return sessions.forkAtTurn(input)
    },
    onEvent(listener: (event: ConversationEvent) => void): () => void {
      return runtime.onEvent(listener)
    },
  }
}

export function registerConversationIpc(
  ipcMain: IpcMain,
  handlers: ConversationIpcHandlers = createConversationIpcHandlers(),
): void {
  let nextSubscriptionId = 0
  const eventSubscriptions = new Map<string, { senderId: number; dispose: () => void }>()
  const scopedSubscriptions = new Map<string, { senderId: number; dispose: () => void }>()
  // A reload keeps the webContents, so `destroyed` never fires for the page it
  // replaced: the new page subscribes again while the old page's subscriptions
  // keep sending to the same sender, one more copy of every event per reload.
  // Navigation ends everything the page held, as it does for the git watch.
  const watchedSenders = new WeakSet<WebContents>()
  const releaseOnNavigation = (sender: WebContents): void => {
    if (watchedSenders.has(sender)) return
    watchedSenders.add(sender)
    const senderId = sender.id
    // Emitted for main-frame, cross-document navigations only — a reload is
    // one — once the new page has committed, before its scripts run.
    sender.on('did-navigate', () => {
      for (const subscription of [...eventSubscriptions.values(), ...scopedSubscriptions.values()])
        if (subscription.senderId === senderId) subscription.dispose()
    })
  }
  const searches = new Map<string, AbortController>()
  ipcMain.handle('conversation:threads', (_, input: unknown) => {
    const parsed = parseTranscriptInput(isRecord(input) ? { ...input, agentId: 'history' } : input)
    if (!parsed.ok) return parsed
    return handlers.listThreads?.(parsed.input) ?? { ok: false, message: 'Conversation history is unavailable.' }
  })
  ipcMain.handle('conversation:search', async (event, input: unknown) => {
    const parsed = parseTranscriptInput(isRecord(input) ? { ...input, agentId: 'history' } : input)
    if (!parsed.ok) return parsed
    if (
      !isRecord(input) ||
      typeof input.query !== 'string' ||
      input.query.length > 1000 ||
      (input.requestId !== undefined && (typeof input.requestId !== 'string' || input.requestId.length > 200))
    )
      return { ok: false, message: 'Search query and optional request identity are required.' }
    const key = `${event.sender.id}:${input.requestId ?? ++nextSubscriptionId}`
    searches.get(key)?.abort()
    const controller = new AbortController()
    searches.set(key, controller)
    const dispose = () => controller.abort()
    event.sender.once('destroyed', dispose)
    try {
      return (
        (await handlers.searchThreads?.(
          { ...parsed.input, query: input.query, requestId: input.requestId as string | undefined },
          {
            signal: controller.signal,
            onBatch: (hits) => {
              if (typeof input.requestId === 'string' && !controller.signal.aborted && !event.sender.isDestroyed())
                event.sender.send('conversation:search:batch', { requestId: input.requestId, hits })
            },
          },
        )) ?? { ok: false, message: 'Conversation search is unavailable.' }
      )
    } finally {
      event.sender.removeListener('destroyed', dispose)
      if (searches.get(key) === controller) searches.delete(key)
    }
  })
  ipcMain.handle('conversation:search:cancel', (event, input: unknown) => {
    if (!isRecord(input) || typeof input.requestId !== 'string') return { ok: false }
    searches.get(`${event.sender.id}:${input.requestId}`)?.abort()
    return { ok: true }
  })
  ipcMain.handle('conversation:rename', (_, input: unknown) => {
    const parsed = parseTranscriptInput(input)
    if (!parsed.ok) return parsed
    if (!isRecord(input) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200)
      return { ok: false, message: 'A title of 1–200 characters is required.' }
    return (
      handlers.renameThread?.({ ...parsed.input, title: input.title }) ?? {
        ok: false,
        message: 'Conversation history is unavailable.',
      }
    )
  })
  ipcMain.handle('conversation:delete', (_, input: unknown) => {
    const parsed = parseTranscriptInput(input)
    if (!parsed.ok) return parsed
    return handlers.deleteThread?.(parsed.input) ?? { ok: false, message: 'Conversation history is unavailable.' }
  })
  ipcMain.handle(
    'conversation:approval-rules:list',
    () => handlers.listApprovalRules?.() ?? { ok: false, message: 'Permission rules are unavailable.' },
  )
  ipcMain.handle('conversation:approval-rules:revoke', (_, input: unknown) => {
    if (!isRecord(input) || typeof input.ruleId !== 'string')
      return { ok: false, message: 'Rule identity is required.' }
    return handlers.revokeApprovalRule?.(input.ruleId) ?? { ok: false, message: 'Permission rules are unavailable.' }
  })
  ipcMain.handle('conversation:turn:diff', async (_, input: unknown): Promise<ConversationTurnDiffResult> => {
    if (
      !isRecord(input) ||
      !Number.isSafeInteger(input.turnSeq) ||
      Number(input.turnSeq) < 1 ||
      (input.path !== undefined && typeof input.path !== 'string')
    )
      return { ok: false, message: 'Turn sequence and optional file path are required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.getTurnDiff?.({
        key: key.input,
        turnSeq: Number(input.turnSeq),
        path: input.path as string | undefined,
      }) ?? { ok: false, message: 'Checkpoints are unavailable.' }
    )
  })
  ipcMain.handle('conversation:turn:revert', async (_, input: unknown): Promise<ConversationRevertResult> => {
    if (
      !isRecord(input) ||
      !Number.isSafeInteger(input.turnSeq) ||
      Number(input.turnSeq) < 1 ||
      (input.confirmed !== undefined && typeof input.confirmed !== 'boolean') ||
      (input.undo !== undefined && typeof input.undo !== 'boolean') ||
      (input.files !== undefined &&
        (!Array.isArray(input.files) || !input.files.every((path) => typeof path === 'string')))
    )
      return { ok: false, message: 'Turn sequence and explicit confirmation are required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.revertToTurn?.({
        key: key.input,
        turnSeq: Number(input.turnSeq),
        confirmed: input.confirmed === true,
        undo: input.undo === true,
        ...(Array.isArray(input.files) ? { files: input.files as string[] } : {}),
      }) ?? { ok: false, message: 'Checkpoints are unavailable.' }
    )
  })
  ipcMain.handle('conversation:turn:rewind', async (_, input: unknown): Promise<ConversationRewindResult> => {
    if (!isRecord(input) || !Number.isSafeInteger(input.turnSeq) || Number(input.turnSeq) < 1)
      return { ok: false, message: 'The message to edit is required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.rewindToTurn?.({ key: key.input, turnSeq: Number(input.turnSeq) }) ?? {
        ok: false,
        message: 'Editing an earlier message is unavailable.',
      }
    )
  })
  ipcMain.handle('conversation:handoff', async (_, input: unknown): Promise<ConversationHandoffResult> => {
    if (!isRecord(input)) return { ok: false, message: 'The chat to hand off is required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    return (
      handlers.handoffConversation?.({ key: key.input }) ?? {
        ok: false,
        message: 'Handing a chat off is unavailable.',
      }
    )
  })
  ipcMain.handle(
    'conversation:switch-provider',
    async (_, input: unknown): Promise<ConversationSwitchProviderResult> => {
      if (!isRecord(input)) return { ok: false, message: 'The chat to move is required.' }
      const key = parseTranscriptInput(input.key)
      if (!key.ok) return key
      if (typeof input.providerId !== 'string' || !input.providerId.trim() || input.providerId.length > 200)
        return { ok: false, message: 'The agent to move the chat to is required.' }
      const modelId = typeof input.modelId === 'string' && input.modelId.length <= 400 ? input.modelId : ''
      return (
        handlers.switchConversationProvider?.({ key: key.input, providerId: input.providerId, modelId }) ?? {
          ok: false,
          message: 'Switching the agent is unavailable.',
        }
      )
    },
  )
  ipcMain.handle('conversation:turn:fork', async (_, input: unknown): Promise<ConversationForkResult> => {
    if (
      !isRecord(input) ||
      typeof input.newAgentId !== 'string' ||
      !input.newAgentId.trim() ||
      (input.title !== undefined && typeof input.title !== 'string') ||
      (input.side === 'user'
        ? !Number.isSafeInteger(input.turnSeq) || Number(input.turnSeq) < 1
        : input.side !== 'assistant' || typeof input.turnId !== 'string' || !input.turnId)
    )
      return { ok: false, message: 'The message to fork from is required.' }
    const key = parseTranscriptInput(input.key)
    if (!key.ok) return key
    const common = {
      key: key.input,
      newAgentId: input.newAgentId,
      ...(typeof input.title === 'string' ? { title: input.title } : {}),
    }
    return (
      handlers.forkAtTurn?.(
        input.side === 'user'
          ? { ...common, side: 'user', turnSeq: Number(input.turnSeq) }
          : { ...common, side: 'assistant', turnId: input.turnId as string },
      ) ?? { ok: false, message: 'Forking a conversation is unavailable.' }
    )
  })
  ipcMain.handle('conversation:session:subscribe', (event, input: unknown) => {
    if (!isRecord(input) || typeof input.subscriptionId !== 'string' || !isRecord(input.key))
      return { ok: false, message: 'Subscription identity is required.' }
    const parsed = parseTranscriptInput(input.key)
    if (!parsed.ok) return parsed
    if (input.afterSeq !== undefined && (!Number.isSafeInteger(input.afterSeq) || Number(input.afterSeq) < 0))
      return { ok: false, message: 'afterSeq must be a nonnegative integer.' }
    if (
      input.generation !== undefined &&
      (typeof input.generation !== 'string' || input.generation.length < 1 || input.generation.length > 200)
    )
      return { ok: false, message: 'generation must be a string of 1–200 characters.' }
    if (input.turnLimit !== undefined && (!Number.isSafeInteger(input.turnLimit) || Number(input.turnLimit) < 1))
      return { ok: false, message: 'turnLimit must be a positive integer.' }
    if (!handlers.subscribe) return { ok: false, message: 'Conversation subscriptions are unavailable.' }
    const subscriptionId = input.subscriptionId
    const key = `${event.sender.id}:${subscriptionId}`
    scopedSubscriptions.get(key)?.dispose()
    const subscription = handlers.subscribe(
      {
        key: parsed.input,
        afterSeq: input.afterSeq as number | undefined,
        // Without the cursor's log generation the session cannot vouch for
        // the cursor, and every reconnect would be answered with a reset.
        generation: input.generation as string | undefined,
        turnLimit: input.turnLimit as number | undefined,
      },
      (frame) => {
        if (!event.sender.isDestroyed())
          event.sender.send('conversation:session-event', { subscriptionId, frame: frameForWindow(frame) })
      },
    )
    const dispose = () => {
      subscription.dispose()
      event.sender.removeListener('destroyed', dispose)
      if (scopedSubscriptions.get(key)?.dispose === dispose) scopedSubscriptions.delete(key)
    }
    event.sender.once('destroyed', dispose)
    scopedSubscriptions.set(key, { senderId: event.sender.id, dispose })
    releaseOnNavigation(event.sender)
    return { ok: true, subscriptionId }
  })
  ipcMain.handle('conversation:session:unsubscribe', (event, input: unknown) => {
    if (isRecord(input) && typeof input.subscriptionId === 'string')
      scopedSubscriptions.get(`${event.sender.id}:${input.subscriptionId}`)?.dispose()
    return { ok: true }
  })
  ipcMain.handle('conversation:session:earlier', async (_, input: unknown): Promise<ConversationPageResult> => {
    if (!isRecord(input) || !Number.isSafeInteger(input.beforeCursor) || Number(input.beforeCursor) < 1)
      return { ok: false, message: 'beforeCursor must be a positive integer.' }
    const parsed = parseTranscriptInput(input.key)
    if (!parsed.ok) return parsed
    if (input.turnLimit !== undefined && (!Number.isSafeInteger(input.turnLimit) || Number(input.turnLimit) < 1))
      return { ok: false, message: 'turnLimit must be a positive integer.' }
    const result = await handlers.loadEarlier?.({
      key: parsed.input,
      beforeCursor: Number(input.beforeCursor),
      turnLimit: input.turnLimit as number | undefined,
    })
    if (!result) return { ok: false, message: 'Conversation history is unavailable.' }
    return result.ok ? { ...result, page: { ...result.page, events: result.page.events.map(eventForWindow) } } : result
  })

  ipcMain.handle('conversation:providers:list', async (_, input: unknown): Promise<ConversationProviderListResult> => {
    if (input !== undefined && !isRecord(input)) return { ok: false, message: 'Provider list input must be an object.' }
    try {
      return await handlers.listProviders(input as ConversationProvidersListInput | undefined)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle(
    'conversation:providers:models',
    async (_, input: unknown): Promise<ConversationProviderModelsResult> => {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      try {
        return await handlers.listProviderModels(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:providers:sign-in',
    async (_, input: unknown): Promise<ConversationProviderSignInResult> => {
      const parsed = parseProviderInput(input)
      if (!parsed.ok) return parsed
      const cliRuntimes = isRecord(input) ? input.cliRuntimes : undefined
      if (cliRuntimes !== undefined && !isRecord(cliRuntimes))
        return { ok: false, message: 'cliRuntimes must be an object.' }
      try {
        return (
          (await handlers.resolveSignIn?.({
            providerId: parsed.input.providerId,
            ...(cliRuntimes ? { cliRuntimes: cliRuntimes as ConversationProviderSignInInput['cliRuntimes'] } : {}),
          })) ?? { ok: false, message: 'Sign-in is unavailable.' }
        )
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle('conversation:secrets:status', async (_, input: unknown): Promise<ConversationSecretStatusResult> => {
    const parsed = parseProviderInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.getSecretStatus(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:secrets:set', async (_, input: unknown): Promise<ConversationSecretSetResult> => {
    const parsed = parseSecretSetInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.setSecret(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:secrets:clear', async (_, input: unknown): Promise<ConversationSecretClearResult> => {
    const parsed = parseProviderInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.clearSecret(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:sessions:start', async (_, input: unknown): Promise<ConversationStartSessionResult> => {
    const parsed = parseStartSessionInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.startSession(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle(
    'conversation:sessions:send-turn',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSendTurnInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.sendTurn(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:interrupt',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSessionIdInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.interrupt(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:respond-to-request',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseRespondToRequestInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.respondToRequest(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:set-permission',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSetPermissionInput(input)
      if (!parsed.ok) return parsed
      try {
        return handlers.setPermission(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:mcp-action',
    async (_, input: unknown): Promise<ConversationMcpServerActionResult> => {
      const parsed = parseMcpServerActionInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.mcpServerAction) return { ok: false, message: 'MCP server actions are unavailable.' }
      try {
        return await handlers.mcpServerAction(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:stop-subagent',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseStopSubagentInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.stopSubagent) return { ok: false, message: 'Stopping one agent is unavailable.' }
      try {
        return await handlers.stopSubagent(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:side-question',
    async (_, input: unknown): Promise<ConversationSideQuestionResult> => {
      const parsed = parseSideQuestionInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.askSideQuestion) return { ok: false, message: 'Side questions are unavailable.' }
      try {
        return await handlers.askSideQuestion(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:cancel-side-question',
    async (_, input: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
      const parsed = parseCancelSideQuestionInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.cancelSideQuestion) return { ok: false, message: 'Side questions are unavailable.' }
      try {
        return await handlers.cancelSideQuestion(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:context-breakdown',
    async (_, input: unknown): Promise<ConversationContextBreakdownResult> => {
      const parsed = parseSessionIdInput(input)
      if (!parsed.ok) return { ok: false, reason: 'failed', message: parsed.message }
      if (!handlers.readContextBreakdown)
        return { ok: false, reason: 'unsupported', message: 'The context breakdown is unavailable.' }
      try {
        return await handlers.readContextBreakdown(parsed.input)
      } catch (err) {
        return { ok: false, reason: 'failed', message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:set-model',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSetModelInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.setModel) return { ok: false, message: 'Changing models mid-conversation is unavailable.' }
      try {
        return await handlers.setModel(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle('conversation:sessions:stop', async (_, input: unknown): Promise<ConversationSessionActionResult> => {
    const parsed = parseSessionIdInput(input)
    if (!parsed.ok) return parsed
    try {
      return handlers.stopSession(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle(
    'conversation:sessions:suspend',
    async (_, input: unknown): Promise<ConversationSessionActionResult> => {
      const parsed = parseSessionIdInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.suspendSession) return { ok: false, message: 'Suspending a conversation is unavailable.' }
      try {
        return await handlers.suspendSession(parsed.input)
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle(
    'conversation:sessions:terminal-handoff',
    async (_, input: unknown): Promise<ConversationTerminalHandoffResult> => {
      // A session, or the chat by its identity (a tab's menu holds no session).
      const chat =
        isRecord(input) &&
        input.sessionId === undefined &&
        typeof input.workspaceId === 'string' &&
        input.workspaceId.trim() &&
        typeof input.agentId === 'string' &&
        input.agentId.trim()
          ? { workspaceId: input.workspaceId, agentId: input.agentId }
          : null
      const parsed = chat ? { ok: true as const, input: chat } : parseSessionIdInput(input)
      if (!parsed.ok) return parsed
      if (!handlers.terminalHandoff) return { ok: false, message: 'Resuming a chat in a terminal is unavailable.' }
      try {
        return await handlers.terminalHandoff(
          'sessionId' in parsed.input ? { sessionId: parsed.input.sessionId } : parsed.input,
        )
      } catch (err) {
        return { ok: false, message: formatError(err) }
      }
    },
  )

  ipcMain.handle('conversation:sessions:list', async (_, input: unknown): Promise<ConversationListSessionsResult> => {
    if (input !== undefined && !isRecord(input)) return { ok: false, message: 'Session list input must be an object.' }
    try {
      return handlers.listSessions(input as ConversationListSessionsInput | undefined)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:tool-detail', async (_, input: unknown): Promise<ConversationToolDetailResult> => {
    const parsed = parseTranscriptInput(input)
    if (!parsed.ok || !isRecord(input) || typeof input.toolUseId !== 'string' || !input.toolUseId.trim())
      return { ok: false, code: 'invalid_input', message: 'Conversation and tool identity are required.' }
    return (
      handlers.getToolDetail?.({ ...parsed.input, toolUseId: input.toolUseId }) ?? {
        ok: false,
        code: 'unavailable',
        message: 'Tool details are unavailable.',
      }
    )
  })

  // A sent image, read back for a replayed bubble. The reference is resolved
  // inside the attachment store only; this is not a general file read.
  ipcMain.handle('conversation:attachment', async (_, input: unknown): Promise<ConversationAttachmentResult> => {
    if (!isRecord(input) || typeof input.ref !== 'string') return { ok: false, message: 'ref is required.' }
    return handlers.readAttachment?.(input.ref) ?? { ok: false, message: 'Attachments are unavailable.' }
  })

  // A proposed plan, as a file the workspace pane opens. The agent's own plan
  // file is only ever answered with when it still holds this text; otherwise
  // the text is copied into app data (conversation-plan-store).
  ipcMain.handle('conversation:plan-document', async (_, input: unknown): Promise<ConversationPlanDocumentResult> => {
    const key = parseTranscriptInput(input)
    if (!key.ok) return key
    if (!isRecord(input) || typeof input.plan !== 'string') return { ok: false, message: 'plan is required.' }
    const title = typeof input.title === 'string' ? input.title : undefined
    const planFilePath = typeof input.planFilePath === 'string' ? input.planFilePath : undefined
    try {
      return (
        (await handlers.planDocument?.({ ...key.input, plan: input.plan, title, planFilePath })) ?? {
          ok: false,
          message: 'Plans are unavailable.',
        }
      )
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:transcript', async (_, input: unknown): Promise<ConversationTranscriptResult> => {
    const parsed = parseTranscriptInput(input)
    if (!parsed.ok) return parsed
    try {
      return await handlers.readTranscript(parsed.input)
    } catch (err) {
      return { ok: false, message: formatError(err) }
    }
  })

  ipcMain.handle('conversation:events:subscribe', (event): { ok: true; subscriptionId: string } => {
    const sender = event.sender
    const subscriptionId = `conversation-subscription-${++nextSubscriptionId}`
    const cleanup = (): void => {
      if (!eventSubscriptions.delete(subscriptionId)) return
      sender.removeListener('destroyed', cleanup)
      unsubscribe()
    }
    const unsubscribe = handlers.onEvent((conversationEvent) => {
      if (sender.isDestroyed()) {
        cleanup()
        return
      }
      if (isConversationBroadcastEvent(conversationEvent))
        sender.send('conversation:event', broadcastEnvelope(conversationEvent))
    })
    eventSubscriptions.set(subscriptionId, { senderId: sender.id, dispose: cleanup })
    sender.once('destroyed', cleanup)
    releaseOnNavigation(sender)
    return { ok: true, subscriptionId }
  })

  ipcMain.handle(
    'conversation:events:unsubscribe',
    (_event, input: unknown): { ok: true } | { ok: false; message: string } => {
      if (!isRecord(input) || typeof input.subscriptionId !== 'string') {
        return { ok: false, message: 'subscriptionId is required.' }
      }
      eventSubscriptions.get(input.subscriptionId)?.dispose()
      return { ok: true }
    },
  )
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
