import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { detectComposerTrigger } from '../../../../shared/conversation/composerTrigger'
import { bundledPermissionModes } from '../../../../../tests/permission-modes'

import type {
  ConversationEvent,
  ConversationEventType,
  ConversationImageAttachment,
} from '../../../../shared/conversation-runtime'
import type { ConversationProviderListEntry } from '../../../../shared/plugin-manifest'
import {
  ATTACHABLE_IMAGE_TYPES as SHARED_ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_TURN as SHARED_MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENT_BYTES as SHARED_MAX_ATTACHMENT_BYTES,
} from '../../../../shared/conversation-attachments'
import {
  activeConversationStage,
  ATTACHABLE_IMAGE_TYPES,
  attachmentCountLabel,
  attachmentPreviewUrl,
  attachmentRejection,
  base64ByteLength,
  buildModelGroups,
  ComposerAttachmentStrip,
  ComposerContextMenu,
  composerSendAction,
  editingShortcut,
  dataTransferHasFiles,
  deriveConversationTimelineRows,
  flattenToolEntries,
  formatAttachmentBytes,
  formatStepDuration,
  groupResolvedDecisions,
  isAttachableImageType,
  isAuthShapedFailure,
  isConversationBusy,
  isConversationModelLocked,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_EDGE,
  MAX_ATTACHMENTS_PER_TURN,
  mergeQueuedTurn,
  parseOptionLabel,
  queueComposerDraft,
  projectConversation,
  providerAcceptsImages,
  queuedTurnLabel,
  readinessLabel,
  ResolvedDecisions,
  resolvedDecisionGroupLabel,
  resolvePermissionPreset,
  restoreRefusedText,
  draftAfterRetried,
  scaledImageDimensions,
  splitImageDataUrl,
  stopDisabledForPending,
  subagentLaneLabel,
  toolObject,
  toolVerb,
  UserTimelineRow,
  WorkTimeline,
  type ConversationApprovalEntry,
  type ConversationTimelineRow,
  type TranscriptEntry,
  type TranscriptToolEntry,
  MODEL_PICKER_TOGGLE_COMMAND,
  openAttachmentImage,
  registerMountedChatView,
  respondToModelPickerToggle,
  type MountedChatView,
} from './AgentChatView'
import { dispatchPanelCommandEvent } from '../../utils/panelCommands'
import { useToastStore } from '../../store/toastStore'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { test } from 'vitest'

test('AgentChatView', async () => {
  // Most of this suite reads static markup, which needs no DOM. The composer
  // context menu is the exception: ContextMenu portals its surface to
  // document.body (4a384239, so a transformed ancestor cannot clip it), and
  // react-dom/server renders nothing for a portal — it does not even have a
  // document to portal into. Those three cases therefore mount into a real DOM
  // and read the body back, the same way CliModelPicker.test.tsx drives its
  // portaled popovers.
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  // This suite bundles as ESM, so it is always strict: a plain assignment to
  // Node's getter-only `navigator` throws rather than silently failing the way it
  // does in the CJS suites.
  Object.defineProperty(globalThis, 'navigator', {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  })
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  anyGlobal.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  // Mounts a portaling element and returns the whole body's markup, so the
  // portaled surface is in reach of the same substring assertions the static
  // cases use. Unmounts before returning: the menu registers window listeners.
  function renderPortalMarkup(element: ReactElement): string {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(element)
    })
    const markup = dom.window.document.body.innerHTML
    act(() => root.unmount())
    container.remove()
    return markup
  }

  let seq = 0
  function ev(type: ConversationEventType, payload?: Record<string, unknown>): ConversationEvent {
    seq += 1
    return {
      id: `e-${seq}`,
      sessionId: 'sess-1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      providerId: 'mock-provider',
      modelId: 'mock-model',
      type,
      createdAt: seq,
      payload,
    }
  }

  function assistant(entries: TranscriptEntry[], turnId: string) {
    const found = entries.find((e) => e.kind === 'assistant' && e.turnId === turnId)
    assert.ok(found && found.kind === 'assistant', `assistant entry for ${turnId}`)
    return found as Extract<TranscriptEntry, { kind: 'assistant' }>
  }

  function row<T extends ConversationTimelineRow['kind']>(rows: ConversationTimelineRow[], kind: T) {
    const found = rows.find((entry) => entry.kind === kind)
    assert.ok(found, `timeline row for ${kind}`)
    return found as Extract<ConversationTimelineRow, { kind: T }>
  }

  // --- empty / idle ----------------------------------------------------------

  const empty = projectConversation([], [])
  assert.equal(empty.sessionStatus, 'idle')
  assert.equal(empty.activeTurn, false)
  assert.equal(empty.entries.length, 0)
  assert.equal(empty.lastError, null)

  // --- streaming turn then completion (mock happy path) ----------------------

  const T1 = 'turn-1'
  const streaming = projectConversation(
    [
      ev('session_started'),
      ev('session_ready'),
      ev('turn_started', { turnId: T1 }),
      ev('content_delta', { turnId: T1, text: 'Hello ' }),
      ev('content_delta', { turnId: T1, text: 'world' }),
    ],
    [{ id: 'u1', text: 'hi' }],
  )
  assert.equal(streaming.sessionStatus, 'ready')
  assert.equal(streaming.activeTurn, true, 'turn without completion is active')
  const streamingAssistant = assistant(streaming.entries, T1)
  assert.equal(streamingAssistant.text, 'Hello world', 'content deltas accumulate in order')
  assert.equal(streamingAssistant.status, 'streaming')
  assert.equal(activeConversationStage(streaming.entries, streaming.activeTurn), 'responding')
  // user turn renders before its assistant turn
  assert.equal(streaming.entries[0]?.kind, 'user')
  assert.equal(streaming.entries[1]?.kind, 'assistant')
  const streamingRows = deriveConversationTimelineRows(streaming.entries, streaming.activeTurn)
  assert.equal(streamingRows.filter((entry) => entry.kind === 'working').length, 1, 'streaming has one live state row')

  const thinkingOnly = projectConversation([ev('turn_started', { turnId: T1 })])
  assert.equal(activeConversationStage(thinkingOnly.entries, thinkingOnly.activeTurn), 'thinking')
  const thinkingRows = deriveConversationTimelineRows(thinkingOnly.entries, thinkingOnly.activeTurn)
  assert.equal(row(thinkingRows, 'working').label, 'Thinking…')

  // --- approval requested -> approved -> usage -> completed ------------------

  const approved = projectConversation(
    [
      ev('turn_started', { turnId: T1 }),
      ev('content_delta', { turnId: T1, text: 'Working' }),
      ev('approval_requested', { turnId: T1, requestId: 'r1', summary: 'May I proceed?' }),
      ev('approval_resolved', { turnId: T1, requestId: 'r1', approved: true }),
      ev('usage_updated', { turnId: T1, inputTokens: 4, outputTokens: 8 }),
      ev('turn_completed', { turnId: T1 }),
    ],
    [{ id: 'u1', text: 'go' }],
  )
  assert.equal(approved.awaitingApproval, false, 'resolved approval is no longer awaiting')
  assert.equal(approved.activeTurn, false)
  assert.equal(assistant(approved.entries, T1).status, 'complete')
  assert.deepEqual(approved.usage, { inputTokens: 4, outputTokens: 8 })
  const approvalEntry = approved.entries.find((e) => e.kind === 'approval')
  assert.ok(approvalEntry && approvalEntry.kind === 'approval')
  assert.equal(approvalEntry.status, 'approved')

  // --- pending approval gates the turn --------------------------------------

  const pendingApproval = projectConversation([
    ev('turn_started', { turnId: T1 }),
    ev('approval_requested', { turnId: T1, requestId: 'r1', summary: 'Need approval' }),
  ])
  assert.equal(pendingApproval.awaitingApproval, true)
  assert.equal(activeConversationStage(pendingApproval.entries, pendingApproval.activeTurn), 'approval')
  const pendingEntry = pendingApproval.entries.find((e) => e.kind === 'approval')
  assert.ok(pendingEntry && pendingEntry.kind === 'approval' && pendingEntry.status === 'pending')
  const pendingApprovalRows = deriveConversationTimelineRows(pendingApproval.entries, pendingApproval.activeTurn)
  assert.equal(
    pendingApprovalRows.some((entry) => entry.kind === 'approval'),
    false,
    'pending approval is owned by the composer dock',
  )
  assert.equal(
    pendingApprovalRows.some((entry) => entry.kind === 'working'),
    false,
    'pending approval suppresses duplicate working row',
  )

  // --- denied approval fails the turn (mock contract) -----------------------

  const denied = projectConversation([
    ev('turn_started', { turnId: T1 }),
    ev('approval_requested', { turnId: T1, requestId: 'r1', summary: 'Need approval' }),
    ev('approval_resolved', { turnId: T1, requestId: 'r1', approved: false }),
    ev('turn_failed', { turnId: T1, reason: 'approval_denied' }),
  ])
  assert.equal(assistant(denied.entries, T1).status, 'failed')
  assert.equal(denied.lastError, 'approval_denied', 'a real failure surfaces an actionable error')
  assert.equal(denied.lastErrorDetail, null, 'a failure without a message has no detail')

  // --- a provider failure keeps its full message for the diagnostics log ----

  const providerFailed = projectConversation([
    ev('turn_started', { turnId: T1 }),
    ev('turn_failed', {
      turnId: T1,
      reason: 'provider',
      message: 'Failed to authenticate: OAuth session expired and could not be refreshed',
    }),
  ])
  assert.equal(providerFailed.lastError, 'provider')
  assert.equal(
    providerFailed.lastErrorDetail,
    'Failed to authenticate: OAuth session expired and could not be refreshed',
    'the log gets the provider message, not only its short code',
  )

  // --- interruption is not an error (explicit turnId variant) ---------------

  const interrupted = projectConversation([
    ev('turn_started', { turnId: T1 }),
    ev('content_delta', { turnId: T1, text: 'partial' }),
    ev('turn_failed', { turnId: T1, reason: 'interrupted' }),
  ])
  assert.equal(assistant(interrupted.entries, T1).status, 'interrupted')
  assert.equal(interrupted.lastError, null, 'interruption is a state, not an error')
  assert.equal(interrupted.activeTurn, false)

  // --- real mock-provider interrupt: turn_failed WITHOUT turnId --------------
  // The mock provider's interrupt() emits `turn_failed { reason: 'interrupted' }`
  // with no turnId (src/main/providers/mock-conversation-provider.ts). Replays the
  // actual start -> send (which requests approval) -> Stop sequence: the
  // projection must still end the active turn, drop the pending-approval gate, and
  // render the interrupted state so the UI does not stay stuck responding.
  const mockInterrupted = projectConversation(
    [
      ev('session_started'),
      ev('session_ready'),
      ev('turn_started', { turnId: T1 }),
      ev('content_delta', { turnId: T1, text: 'Mock response for: hi' }),
      ev('approval_requested', {
        turnId: T1,
        requestId: 'r1',
        action: 'mock_approval',
        summary: 'Mock provider requests approval to complete the turn.',
      }),
      ev('turn_failed', { reason: 'interrupted' }),
    ],
    [{ id: 'u1', text: 'hi' }],
  )
  assert.equal(
    mockInterrupted.activeTurn,
    false,
    'Stop ends the active turn even without a turnId on the interrupt event',
  )
  assert.equal(
    mockInterrupted.awaitingApproval,
    false,
    'a pending approval no longer blocks the composer after interrupt',
  )
  assert.equal(mockInterrupted.lastError, null, 'interruption is a state, not an error')
  assert.equal(assistant(mockInterrupted.entries, T1).status, 'interrupted')
  const mockApproval = mockInterrupted.entries.find((e) => e.kind === 'approval')
  assert.ok(mockApproval && mockApproval.kind === 'approval')
  assert.equal(mockApproval.status, 'cancelled', 'the unresolved approval is cancelled by the interrupt')

  // --- tool start/output cards ----------------------------------------------

  const withTool = projectConversation([
    ev('turn_started', { turnId: T1 }),
    ev('tool_started', { turnId: T1, callId: 'c1', name: 'search' }),
    ev('tool_started', { turnId: T1, callId: 'c2', name: 'read_file' }),
    ev('tool_output', { turnId: T1, callId: 'c1', output: 'result rows' }),
    ev('tool_output', { turnId: T1, callId: 'c2', output: 'file body' }),
    ev('turn_completed', { turnId: T1 }),
  ])
  const toolEntry = withTool.entries.find((e) => e.kind === 'tool')
  assert.ok(toolEntry && toolEntry.kind === 'tool')
  assert.equal(toolEntry.name, 'search')
  assert.equal(toolEntry.status, 'done')
  assert.equal(toolEntry.output, 'result rows')
  const toolRows = deriveConversationTimelineRows(withTool.entries, withTool.activeTurn)
  const toolTurnRow = row(toolRows, 'assistant')
  assert.equal(toolTurnRow.tools.length, 2, 'consecutive tool calls are grouped onto the turn row')
  assert.equal(toolTurnRow.entry.text, '', 'tool-only turn still renders its work timeline')

  // Tool steps carry timestamps so the timeline can show per-step durations.
  const [firstTool, secondTool] = toolTurnRow.tools
  assert.ok(firstTool && typeof firstTool.startedAt === 'number', 'tool start timestamp recorded')
  assert.ok(
    firstTool && typeof firstTool.completedAt === 'number' && firstTool.completedAt > (firstTool.startedAt ?? 0),
  )
  assert.ok(secondTool && typeof secondTool.completedAt === 'number')

  const runningTool = projectConversation([
    ev('turn_started', { turnId: T1 }),
    ev('tool_started', { turnId: T1, callId: 'c1', name: 'search' }),
  ])
  assert.equal(activeConversationStage(runningTool.entries, runningTool.activeTurn), 'tool')
  assert.equal(
    row(deriveConversationTimelineRows(runningTool.entries, runningTool.activeTurn), 'working').label,
    'Searching…',
  )

  // --- reasoning rides the turn row, separate from prose ---------------------

  const withReasoning = projectConversation([
    ev('turn_started', { turnId: T1 }),
    ev('reasoning_delta', { turnId: T1, text: 'Checking repo docs.' }),
    ev('content_delta', { turnId: T1, text: 'Found the brand guide.' }),
    ev('turn_completed', { turnId: T1 }),
  ])
  const reasoningRow = row(deriveConversationTimelineRows(withReasoning.entries, withReasoning.activeTurn), 'assistant')
  assert.equal(reasoningRow.entry.reasoning, 'Checking repo docs.')
  assert.equal(reasoningRow.entry.text, 'Found the brand guide.')
  // Reasoning window: first reasoning_delta -> first non-reasoning event.
  assert.ok(
    typeof reasoningRow.entry.reasoningDurationMs === 'number' && reasoningRow.entry.reasoningDurationMs > 0,
    'reasoning duration derives from event timestamps',
  )

  // --- session closed --------------------------------------------------------

  const closed = projectConversation([ev('session_started'), ev('session_ready'), ev('session_closed')])
  assert.equal(closed.sessionStatus, 'stopped')

  // --- readiness copy --------------------------------------------------------

  assert.equal(readinessLabel({ kind: 'ready' }), 'Ready')
  assert.match(readinessLabel({ kind: 'missing-key', providerId: 'p' }), /API key/)
  assert.match(readinessLabel({ kind: 'provider-unavailable', providerId: 'p' }), /not installed/)
  assert.match(readinessLabel({ kind: 'model-unavailable', providerId: 'p', modelId: 'm' }), /not offered/)
  assert.equal(readinessLabel({ kind: 'error', message: 'boom' }), 'boom')

  // --- Stop remains available while send promise is unresolved ---------------

  assert.equal(stopDisabledForPending('sending'), false, 'unresolved send does not disable Stop')
  assert.equal(stopDisabledForPending('starting'), false)
  assert.equal(stopDisabledForPending('stopping'), true)
  assert.equal(stopDisabledForPending(null), false)

  // --- Send-while-busy queues instead of erroring (D6/1776) -------------------

  // Idle: a live send is allowed.
  assert.equal(isConversationBusy(false, false, null), false, 'idle session accepts a live send')
  // Streaming: the runtime guard would reject a new turn, so the submit queues.
  assert.equal(isConversationBusy(true, false, null), true, 'streaming turn queues the next message')
  // Awaiting approval queues too (pendingRequestId is set on the runtime).
  assert.equal(isConversationBusy(false, true, null), true, 'awaiting approval queues the next message')
  // An in-flight send (before the turn events land) also queues, so a fast second
  // Enter never fires two overlapping sends.
  assert.equal(isConversationBusy(false, false, 'sending'), true, 'in-flight send queues the next message')
  assert.equal(isConversationBusy(false, false, 'starting'), true)

  // --- one send rule behind Enter, the button, and the menu (1793) ------------

  const idleSend = { ready: true, busy: false, sending: false, hasText: true, attachmentCount: 0 }
  assert.deepEqual(
    composerSendAction(idleSend),
    { label: 'Send message', disabled: false },
    'an idle session with text sends now',
  )
  assert.equal(
    composerSendAction({ ...idleSend, busy: true }).label,
    'Queue message',
    'a busy session queues, and the affordance says so instead of promising a send',
  )
  assert.equal(
    composerSendAction({ ...idleSend, busy: true, sending: true }).label,
    'Sending',
    'an in-flight send reads as sending, not as a second queue',
  )
  assert.equal(
    composerSendAction({ ...idleSend, hasText: false }).disabled,
    true,
    'an empty composer has nothing to commit',
  )
  assert.equal(
    composerSendAction({ ...idleSend, hasText: false, attachmentCount: 1 }).disabled,
    false,
    'an image-only message is sendable (D3/1774)',
  )
  assert.equal(
    composerSendAction({ ...idleSend, ready: false }).disabled,
    true,
    'nothing commits before the provider is ready',
  )
  // Busy is a routing signal, never a gate: type-ahead must stay committable so
  // the queue can take it.
  assert.equal(composerSendAction({ ...idleSend, busy: true }).disabled, false)

  assert.equal(editingShortcut('darwin', 'X'), '⌘X')
  assert.equal(editingShortcut('win32', 'V'), 'Ctrl+V')

  const menuState = { x: 20, y: 40, selectionStart: 2, selectionEnd: 7, clipboardText: 'pasted' }
  const composerMenuMarkup = renderPortalMarkup(
    createElement(ComposerContextMenu, {
      menu: menuState,
      send: composerSendAction(idleSend),
      editable: true,
      onSend: () => {},
      onCut: () => {},
      onCopy: () => {},
      onPaste: () => {},
      onClose: () => {},
    }),
  )
  assert.ok(composerMenuMarkup.includes('role="menu"'), 'the composer menu is a menu surface')
  assert.ok(composerMenuMarkup.includes('aria-label="Message actions"'), 'the menu surface is named')
  for (const label of ['Send message', 'Cut', 'Copy', 'Paste']) {
    assert.ok(composerMenuMarkup.includes(`>${label}</span>`), `the composer menu offers ${label}`)
  }
  assert.doesNotMatch(composerMenuMarkup, /disabled=""/, 'with a selection and a full clipboard every item is live')

  // Nothing selected and an empty clipboard: the editing actions say so rather
  // than sitting enabled and doing nothing.
  const emptyMenuMarkup = renderPortalMarkup(
    createElement(ComposerContextMenu, {
      menu: { ...menuState, selectionEnd: 2, clipboardText: '' },
      send: composerSendAction({ ...idleSend, hasText: false }),
      editable: true,
      onSend: () => {},
      onCut: () => {},
      onCopy: () => {},
      onPaste: () => {},
      onClose: () => {},
    }),
  )
  assert.equal(
    (emptyMenuMarkup.match(/disabled=""/g) ?? []).length,
    4,
    'Send, Cut, Copy, and Paste each disable when there is nothing to act on',
  )

  // A composer that cannot be edited (provider not ready) still allows Copy — it
  // reads the field — but never offers to rewrite it.
  const readOnlyMenuMarkup = renderPortalMarkup(
    createElement(ComposerContextMenu, {
      menu: menuState,
      send: composerSendAction({ ...idleSend, ready: false }),
      editable: false,
      onSend: () => {},
      onCut: () => {},
      onCopy: () => {},
      onPaste: () => {},
      onClose: () => {},
    }),
  )
  assert.equal(
    (readOnlyMenuMarkup.match(/disabled=""/g) ?? []).length,
    3,
    'Send, Cut, and Paste disable on a non-editable composer; Copy stays available',
  )

  // --- Model picker locks once the conversation has started ------------------

  assert.equal(isConversationModelLocked(0, null), false, 'model is editable before the first turn with no session')
  assert.equal(isConversationModelLocked(1, null), true, 'model locks after the first user turn')
  assert.equal(isConversationModelLocked(0, 'session-1'), true, 'model locks once a session exists')
  // After an app restart userTurns/sessionId are empty local state, but replayed
  // history means the conversation has started: the pill must stay locked.
  assert.equal(isConversationModelLocked(0, null, true), true, 'replayed transcript history locks the model')

  // --- Tool rows carry the provider's input summary ---------------------------

  const toolSummaryProjection = projectConversation(
    [
      ev('session_started'),
      ev('session_ready'),
      ev('turn_started', { turnId: 'turn-tool' }),
      ev('tool_started', { turnId: 'turn-tool', toolCallId: 'tu-1', tool: 'Bash', summary: 'Bash: npm test' }),
      ev('tool_output', { turnId: 'turn-tool', toolCallId: 'tu-1', output: '2 passing' }),
      ev('turn_completed', { turnId: 'turn-tool' }),
    ],
    [{ id: 'u-t', text: 'run the tests' }],
  )
  const summarizedToolEntry = toolSummaryProjection.entries.find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool',
  )
  assert.equal(summarizedToolEntry?.name, 'Bash')
  assert.equal(summarizedToolEntry?.summary, 'Bash: npm test')
  assert.equal(summarizedToolEntry?.output, '2 passing')
  assert.equal(summarizedToolEntry?.status, 'done')

  // --- Structured question card (approval kind: question) --------------------

  const TQ = 'turn-q'
  const questionPayload = {
    turnId: TQ,
    requestId: 'req-q',
    action: 'AskUserQuestion',
    kind: 'question',
    summary: 'Which auth method?',
    questions: [
      {
        question: 'Which auth method?',
        header: 'Auth',
        multiSelect: false,
        allowFreeText: true,
        options: [{ label: 'OAuth', description: 'Redirect flow' }, { label: 'API key' }],
      },
    ],
  }
  const questionPending = projectConversation(
    [
      ev('session_started'),
      ev('session_ready'),
      ev('turn_started', { turnId: TQ }),
      ev('approval_requested', questionPayload),
    ],
    [{ id: 'u-q', text: 'help me pick' }],
  )
  assert.equal(questionPending.awaitingApproval, true)
  const pendingQuestionEntry = questionPending.entries.find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval',
  )
  assert.ok(pendingQuestionEntry)
  assert.equal(pendingQuestionEntry.requestKind, 'question')
  assert.equal(pendingQuestionEntry.questions?.length, 1)
  assert.equal(pendingQuestionEntry.questions?.[0]?.options.length, 2)
  assert.equal(pendingQuestionEntry.questions?.[0]?.options[0]?.label, 'OAuth')
  assert.equal(pendingQuestionEntry.status, 'pending')

  const questionResolved = projectConversation(
    [
      ev('session_started'),
      ev('session_ready'),
      ev('turn_started', { turnId: TQ }),
      ev('approval_requested', questionPayload),
      ev('approval_resolved', {
        turnId: TQ,
        requestId: 'req-q',
        approved: true,
        answers: { 'Which auth method?': 'OAuth' },
      }),
      ev('content_delta', { turnId: TQ, text: 'Using OAuth then.' }),
      ev('turn_completed', { turnId: TQ }),
    ],
    [{ id: 'u-q', text: 'help me pick' }],
  )
  assert.equal(questionResolved.awaitingApproval, false)
  const resolvedQuestionEntry = questionResolved.entries.find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval',
  )
  assert.equal(resolvedQuestionEntry?.status, 'approved')
  assert.deepEqual(resolvedQuestionEntry?.answers, { 'Which auth method?': 'OAuth' })

  // --- Plan approval card (approval kind: plan) -------------------------------

  const planProjection = projectConversation(
    [
      ev('session_started'),
      ev('session_ready'),
      ev('turn_started', { turnId: 'turn-p' }),
      ev('approval_requested', {
        turnId: 'turn-p',
        requestId: 'req-p',
        action: 'ExitPlanMode',
        kind: 'plan',
        summary: 'The agent proposed a plan.',
        plan: '## Plan\n1. Step one',
      }),
    ],
    [{ id: 'u-p', text: 'plan it' }],
  )
  const planEntry = planProjection.entries.find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval',
  )
  assert.equal(planEntry?.requestKind, 'plan')
  assert.equal(planEntry?.plan, '## Plan\n1. Step one')

  // --- Persisted user_message events drive user bubbles (replay) --------------

  const replayProjection = projectConversation(
    [
      ev('session_started'),
      ev('session_ready'),
      ev('user_message', { turnId: 'turn-r1', text: 'first question', localTurnId: 'local-1' }),
      ev('turn_started', { turnId: 'turn-r1' }),
      ev('content_delta', { turnId: 'turn-r1', text: 'first answer' }),
      ev('turn_completed', { turnId: 'turn-r1' }),
    ],
    // Locals are empty after a reload: user bubbles must come from events.
    [],
  )
  const replayUsers = replayProjection.entries.filter((entry) => entry.kind === 'user')
  assert.equal(replayUsers.length, 1)
  assert.equal(replayUsers[0]?.kind === 'user' && replayUsers[0].text, 'first question')

  // Live path: the represented local is not duplicated; a brand-new optimistic
  // local (no user_message yet) still renders at the tail.
  const optimisticProjection = projectConversation(
    [
      ev('session_started'),
      ev('session_ready'),
      ev('user_message', { turnId: 'turn-r1', text: 'first question', localTurnId: 'local-1' }),
      ev('turn_started', { turnId: 'turn-r1' }),
      ev('turn_completed', { turnId: 'turn-r1' }),
    ],
    [
      { id: 'local-1', text: 'first question' },
      { id: 'local-2', text: 'second question in flight' },
    ],
  )
  const optimisticUsers = optimisticProjection.entries.filter((entry) => entry.kind === 'user')
  assert.equal(optimisticUsers.length, 2)
  assert.equal(optimisticUsers[1]?.kind === 'user' && optimisticUsers[1].text, 'second question in flight')

  // --- work-timeline vocabulary (pure helpers) ---------------------------------

  assert.equal(toolVerb('Read', false), 'Read')
  assert.equal(toolVerb('Grep', false), 'Searched')
  assert.equal(toolVerb('Edit', false), 'Edited')
  assert.equal(toolVerb('Edit', true), 'Editing')
  assert.equal(toolVerb('Bash', false), 'Ran')
  assert.equal(toolVerb('Bash', true), 'Running')
  assert.equal(toolVerb('CustomTool', false), 'Called CustomTool')
  assert.equal(toolVerb('CustomTool', true), 'Calling CustomTool')

  assert.equal(
    toolObject({ name: 'Bash', summary: 'Bash: npm test' }),
    'npm test',
    'summary prefix strips to the object',
  )
  assert.equal(toolObject({ name: 'Bash', summary: 'plain summary' }), 'plain summary')
  assert.equal(toolObject({ name: 'Bash' }), '')

  assert.deepEqual(parseOptionLabel('OAuth (Recommended)'), { text: 'OAuth', recommended: true })
  assert.deepEqual(parseOptionLabel('OAuth (recommended)'), { text: 'OAuth', recommended: true })
  assert.deepEqual(parseOptionLabel('API keys'), { text: 'API keys', recommended: false })

  assert.equal(formatStepDuration(200), '0.2s')
  assert.equal(formatStepDuration(3000), '3s')
  assert.equal(formatStepDuration(21_000), '21s')
  assert.equal(formatStepDuration(83_000), '1m 23s')

  assert.equal(isAuthShapedFailure('OAuth token expired. Run `claude login`.'), true)
  assert.equal(isAuthShapedFailure('HTTP 401 from provider'), true)
  assert.equal(isAuthShapedFailure('network timeout'), false)
  assert.equal(isAuthShapedFailure(undefined), false)

  // --- diff chips + permission action + failure detail ride the projection ----

  const richTurn = projectConversation([
    ev('turn_started', { turnId: 'turn-rich' }),
    ev('tool_started', {
      turnId: 'turn-rich',
      toolCallId: 'e1',
      tool: 'Edit',
      summary: 'Edit: src/sync/worker.ts',
      addedLines: 34,
      removedLines: 6,
    }),
    ev('tool_output', { turnId: 'turn-rich', toolCallId: 'e1', output: 'ok' }),
    ev('approval_requested', {
      turnId: 'turn-rich',
      requestId: 'req-b',
      action: 'Bash',
      kind: 'tool',
      summary: 'Bash: git rm stale.ts',
    }),
    ev('approval_resolved', { turnId: 'turn-rich', requestId: 'req-b', approved: true }),
    ev('turn_failed', { turnId: 'turn-rich', reason: 'provider', message: 'exit 1 · OAuth token expired' }),
  ])
  const richTool = richTurn.entries.find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> => entry.kind === 'tool',
  )
  assert.equal(richTool?.addedLines, 34)
  assert.equal(richTool?.removedLines, 6)
  const richApproval = richTurn.entries.find(
    (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> => entry.kind === 'approval',
  )
  assert.equal(richApproval?.action, 'Bash', 'the tool behind a permission request is preserved')
  const richAssistant = assistant(richTurn.entries, 'turn-rich')
  assert.equal(richAssistant.failureReason, 'provider')
  assert.equal(
    richAssistant.failureDetail,
    'exit 1 · OAuth token expired',
    'full provider message kept for Show details',
  )

  // --- turn byline: modelId is captured from the turn's events -----------------

  const modelTurnEvents: ConversationEvent[] = [
    { ...ev('turn_started', { turnId: 'turn-m' }), modelId: 'sonnet' },
    ev('content_delta', { turnId: 'turn-m', text: 'hi' }),
    ev('turn_completed', { turnId: 'turn-m' }),
  ]
  assert.equal(assistant(projectConversation(modelTurnEvents).entries, 'turn-m').modelId, 'sonnet')

  // --- apiKeySource rides session_updated (subscription-auth guarantee) -------

  assert.equal(empty.apiKeySource, null, 'no session_updated means no reported auth source')

  const subscriptionAuth = projectConversation([
    ev('session_started'),
    ev('session_ready'),
    ev('session_updated', { providerSessionId: 'cli-1', apiKeySource: 'none' }),
  ])
  assert.equal(subscriptionAuth.apiKeySource, 'none')

  const apiKeyAuth = projectConversation([
    ev('session_started'),
    ev('session_ready'),
    // A cursor-only update (no auth info) must not erase a later init's source.
    ev('session_updated', { providerSessionId: 'cli-1' }),
    ev('session_updated', { providerSessionId: 'cli-1', apiKeySource: 'ANTHROPIC_API_KEY' }),
    ev('session_updated', { providerSessionId: 'cli-2' }),
  ])
  assert.equal(apiKeyAuth.apiKeySource, 'ANTHROPIC_API_KEY', 'latest reported source wins; cursor-only updates keep it')

  // Transcripts written while the field was redacted replay `[redacted]`: that
  // is no source at all, not an API key.
  const redactedAuth = projectConversation([
    ev('session_started'),
    ev('session_updated', { providerSessionId: 'cli-1', apiKeySource: '[redacted]' }),
  ])
  assert.equal(redactedAuth.apiKeySource, null, 'a redacted source replayed from disk reports nothing')

  // --- a provider's session notice rides session_updated until the next session ---

  assert.equal(empty.sessionNotice, null)
  const replaced = projectConversation([
    ev('session_started'),
    ev('session_updated', { providerSessionId: 'new-thread', notice: 'The previous thread could not be resumed.' }),
    ev('session_updated', { providerSessionId: 'new-thread' }),
  ])
  assert.equal(replaced.sessionNotice, 'The previous thread could not be resumed.')
  const restarted = projectConversation([
    ev('session_started'),
    ev('session_updated', { providerSessionId: 'new-thread', notice: 'The previous thread could not be resumed.' }),
    ev('session_started'),
  ])
  assert.equal(restarted.sessionNotice, null, "a new session does not inherit the previous one's notice")

  // --- subagent lanes: parent-linked tool events nest under their Task lane ---

  const LANE_TURN = 'turn-lane'
  const fanOutEvents: ConversationEvent[] = [
    ev('turn_started', { turnId: LANE_TURN }),
    ev('tool_started', {
      turnId: LANE_TURN,
      toolCallId: 'lane-a',
      tool: 'Task',
      summary: 'Task: map the reducer',
      subagentLane: true,
      subagentType: 'Explore',
    }),
    ev('tool_started', {
      turnId: LANE_TURN,
      toolCallId: 'lane-b',
      tool: 'Task',
      summary: 'Task: audit the IPC',
      subagentLane: true,
      subagentType: 'general-purpose',
    }),
    ev('tool_started', {
      turnId: LANE_TURN,
      toolCallId: 'a1',
      tool: 'Read',
      summary: 'Read: src/a.ts',
      parentToolUseId: 'lane-a',
    }),
    ev('tool_started', {
      turnId: LANE_TURN,
      toolCallId: 'b1',
      tool: 'Grep',
      summary: 'Grep: conversation',
      parentToolUseId: 'lane-b',
    }),
    ev('tool_output', { turnId: LANE_TURN, toolCallId: 'a1', output: 'file body', parentToolUseId: 'lane-a' }),
    ev('tool_started', { turnId: LANE_TURN, toolCallId: 'top-1', tool: 'Bash', summary: 'Bash: npm test' }),
  ]
  const fanOut = projectConversation(fanOutEvents)
  const laneTools = fanOut.entries.filter((entry): entry is TranscriptToolEntry => entry.kind === 'tool')
  assert.deepEqual(
    laneTools.map((tool) => tool.id),
    ['lane-a', 'lane-b', 'top-1'],
    'child tool calls leave the top level and nest under their lane',
  )
  const laneA = laneTools[0]
  assert.equal(laneA?.subagentLane, true)
  assert.equal(laneA?.subagentType, 'Explore')
  assert.equal(laneA?.status, 'running', 'a lane stays running until its own tool_output arrives')
  assert.deepEqual(
    laneA?.children?.map((child) => child.id),
    ['a1'],
  )
  assert.equal(laneA?.children?.[0]?.status, 'done', 'a child closes on its own parent-linked output')
  assert.deepEqual(
    laneTools[1]?.children?.map((child) => child.id),
    ['b1'],
  )
  assert.equal(laneTools[2]?.subagentLane, undefined, 'ordinary top-level tools are untouched')
  assert.equal(flattenToolEntries(laneTools).length, 5, 'lane children count as real steps')
  assert.equal(subagentLaneLabel(laneA as TranscriptToolEntry), 'Explore agent')
  assert.equal(subagentLaneLabel(laneTools[1] as TranscriptToolEntry), 'general-purpose agent')

  // Two lanes running at once are reported as a fan-out, not as the last tool.
  const fanOutRows = deriveConversationTimelineRows(fanOut.entries, fanOut.activeTurn)
  assert.equal(row(fanOutRows, 'working').label, '2 agents working…')
  assert.equal(row(fanOutRows, 'assistant').tools.length, 3, 'the turn row carries lanes, not flattened children')

  // One lane closed: the other still names itself, and the closed lane keeps its
  // real duration (start → its own output), not a child's stamp.
  const laneClosed = projectConversation([
    ...fanOutEvents,
    ev('tool_output', { turnId: LANE_TURN, toolCallId: 'lane-b', output: 'audit done' }),
  ])
  const closedLaneRows = deriveConversationTimelineRows(laneClosed.entries, laneClosed.activeTurn)
  assert.equal(row(closedLaneRows, 'working').label, 'Explore agent working…')
  const closedLane = laneClosed.entries.find(
    (entry): entry is TranscriptToolEntry => entry.kind === 'tool' && entry.id === 'lane-b',
  )
  assert.equal(closedLane?.status, 'done')
  assert.ok(
    closedLane?.startedAt !== undefined &&
      closedLane.completedAt !== undefined &&
      closedLane.completedAt > closedLane.startedAt,
    'a lane spans from its spawn to its own completion',
  )

  // A lane without a subagentLane flag is still a lane once children link to it,
  // and a child whose parent never arrived stays visible at the top level.
  const impliedLane = projectConversation([
    ev('turn_started', { turnId: 'turn-implied' }),
    ev('tool_started', { turnId: 'turn-implied', toolCallId: 'p1', tool: 'Task', summary: 'Task: investigate' }),
    ev('tool_started', {
      turnId: 'turn-implied',
      toolCallId: 'p1c',
      tool: 'Read',
      summary: 'Read: src/x.ts',
      parentToolUseId: 'p1',
    }),
    ev('tool_started', {
      turnId: 'turn-implied',
      toolCallId: 'orphan',
      tool: 'Read',
      summary: 'Read: src/y.ts',
      parentToolUseId: 'missing',
    }),
  ])
  const impliedTools = impliedLane.entries.filter((entry): entry is TranscriptToolEntry => entry.kind === 'tool')
  assert.deepEqual(
    impliedTools.map((tool) => tool.id),
    ['p1', 'orphan'],
  )
  assert.equal(impliedTools[0]?.subagentLane, true, 'having children is enough to be a lane')
  assert.equal(
    subagentLaneLabel(impliedTools[0] as TranscriptToolEntry),
    'Agent',
    'an untyped lane falls back to the generic noun',
  )
  assert.equal(
    toolObject(impliedTools[0] as TranscriptToolEntry),
    'investigate',
    'the spawn summary is the lane object',
  )
  assert.equal(impliedTools[1]?.children, undefined, 'an orphaned child renders rather than disappearing')

  // A subagent that reports after its turn's result rides the continuation turn
  // (`<sessionId>_cont_<n>`): its calls, and the lane's own closing output, carry
  // a different turnId than the Task call that spawned them. They still belong to
  // that lane, and must not close some unrelated call on the continuation turn.
  const continuationFanOut = projectConversation([
    ev('turn_started', { turnId: 'turn-parent' }),
    ev('tool_started', {
      turnId: 'turn-parent',
      toolCallId: 'lane-x',
      tool: 'Task',
      summary: 'Task: dig',
      subagentLane: true,
      subagentType: 'Explore',
    }),
    ev('turn_completed', { turnId: 'turn-parent' }),
    ev('turn_started', { turnId: 'turn-parent_cont_1' }),
    ev('tool_started', { turnId: 'turn-parent_cont_1', toolCallId: 'sib-1', tool: 'Bash', summary: 'Bash: npm test' }),
    ev('tool_started', {
      turnId: 'turn-parent_cont_1',
      toolCallId: 'x1',
      tool: 'Read',
      summary: 'Read: src/deep.ts',
      parentToolUseId: 'lane-x',
    }),
    ev('tool_output', { turnId: 'turn-parent_cont_1', toolCallId: 'lane-x', output: 'dug' }),
  ])
  const continuationTools = continuationFanOut.entries.filter(
    (entry): entry is TranscriptToolEntry => entry.kind === 'tool',
  )
  assert.deepEqual(
    continuationTools.map((tool) => tool.id),
    ['lane-x', 'sib-1'],
    'a continuation-turn child joins its lane instead of becoming a stray row',
  )
  assert.deepEqual(
    continuationTools[0]?.children?.map((child) => child.id),
    ['x1'],
  )
  assert.equal(continuationTools[0]?.status, 'done', 'a lane closes on the continuation turn that carries its result')
  assert.equal(continuationTools[1]?.status, 'running', 'the lane result never closes an unrelated continuation call')

  // Output without a call id closes the latest call in its own lane only.
  const idlessOutput = projectConversation([
    ev('turn_started', { turnId: 'turn-idless' }),
    ev('tool_started', {
      turnId: 'turn-idless',
      toolCallId: 'lane-c',
      tool: 'Task',
      summary: 'Task: check',
      subagentLane: true,
    }),
    ev('tool_started', {
      turnId: 'turn-idless',
      toolCallId: 'c1',
      tool: 'Read',
      summary: 'Read: src/z.ts',
      parentToolUseId: 'lane-c',
    }),
    ev('tool_output', { turnId: 'turn-idless', output: 'child done', parentToolUseId: 'lane-c' }),
  ])
  const idlessLane = idlessOutput.entries.find(
    (entry): entry is TranscriptToolEntry => entry.kind === 'tool' && entry.id === 'lane-c',
  )
  assert.equal(idlessLane?.status, 'running', 'a child output never closes its parent lane')
  assert.equal(idlessLane?.children?.[0]?.status, 'done')

  // --- the work timeline renders lanes as live rows, children nested ---------

  const laneMarkup = renderToStaticMarkup(createElement(WorkTimeline, { tools: laneTools, live: true }))
  assert.ok(laneMarkup.includes('Explore agent'), 'a running lane names the agent that was spawned')
  assert.ok(laneMarkup.includes('general-purpose agent'), 'concurrent lanes both render')
  assert.ok(laneMarkup.includes('map the reducer'), 'a lane says what its agent was sent to do')
  assert.ok(laneMarkup.includes('audit the IPC'), 'same-type lanes stay distinguishable by their task')
  assert.ok(laneMarkup.includes('src/a.ts'), 'a live lane shows the steps running inside it')
  assert.equal(
    (laneMarkup.match(/aria-expanded="true"/g) ?? []).length,
    2,
    'both live lanes mount expanded outside the settled work group',
  )
  assert.ok(laneMarkup.includes('aria-busy="true"'), 'the timeline stays live while lanes run')
  assert.equal((laneMarkup.match(/>running</g) ?? []).length, 2, 'running steps carry an accessible status')
  assert.equal(
    (laneMarkup.match(/>Working · </g) ?? []).length,
    2,
    'a running lane says it is working in words, beside how long it has been',
  )

  // The same fan-out, finished: the settled work folds behind one closed
  // summary line, with no step count, and nothing inside it is on screen.
  const finishedFanOut = projectConversation([
    ...fanOutEvents,
    ev('tool_output', { turnId: LANE_TURN, toolCallId: 'b1', output: 'hits', parentToolUseId: 'lane-b' }),
    ev('tool_output', { turnId: LANE_TURN, toolCallId: 'lane-a', output: 'mapped' }),
    ev('tool_output', { turnId: LANE_TURN, toolCallId: 'lane-b', output: 'audited' }),
    ev('tool_output', { turnId: LANE_TURN, toolCallId: 'top-1', output: '2 passing' }),
    ev('turn_completed', { turnId: LANE_TURN }),
  ])
  const doneLaneMarkup = renderToStaticMarkup(
    createElement(WorkTimeline, {
      tools: finishedFanOut.entries.filter((entry): entry is TranscriptToolEntry => entry.kind === 'tool'),
      live: false,
    }),
  )
  assert.ok(doneLaneMarkup.includes('Ran 2 agents'), 'the settled fan-out is summarised in one line')
  assert.ok(!doneLaneMarkup.includes(' steps'), 'the summary does not count steps')
  assert.ok(!doneLaneMarkup.includes('general-purpose agent'), 'settled lanes fold behind the closed summary')
  assert.ok(!doneLaneMarkup.includes('src/a.ts'), 'a finished lane replayed from history mounts collapsed')
  assert.ok(!doneLaneMarkup.includes('>running<'), 'nothing claims to be running once the fan-out is done')

  // --- resolved approvals collapse into one expandable group (1792) ----------

  const BATCH_TURN = 'turn-batch'
  const batchDecision = (requestId: string, action: string, summary: string): ConversationEvent[] => [
    ev('approval_requested', { turnId: BATCH_TURN, requestId, action, kind: 'tool', summary }),
    ev('approval_resolved', { turnId: BATCH_TURN, requestId, approved: true }),
  ]
  const batch = projectConversation([
    ev('turn_started', { turnId: BATCH_TURN }),
    ev('content_delta', { turnId: BATCH_TURN, text: 'Writing the files.' }),
    ...batchDecision('b1', 'Write', 'Write: src/a.ts'),
    ...batchDecision('b2', 'Edit', 'Edit: src/b.ts'),
    ...batchDecision('b3', 'Write', 'Write: src/c.ts'),
    // Text streamed after the batch was answered: it must not read above it.
    ev('content_delta', { turnId: BATCH_TURN, text: ' Done.' }),
    ev('turn_completed', { turnId: BATCH_TURN }),
  ])
  const batchRows = deriveConversationTimelineRows(batch.entries, batch.activeTurn)
  assert.equal(
    batchRows.filter((entry) => entry.kind === 'approval').length,
    0,
    "a turn's decisions ride its turn block instead of trailing the prose",
  )
  const batchAssistant = row(batchRows, 'assistant')
  assert.equal(batchAssistant.decisions.length, 1, 'a batch answered together is one row, not one row each')
  const batchGroup = batchAssistant.decisions[0]
  assert.ok(batchGroup && batchGroup.kind === 'decisionGroup')
  assert.equal(batchGroup.label, 'Approved 3 files')
  assert.deepEqual(
    batchGroup.entries.map((entry) => entry.requestId),
    ['b1', 'b2', 'b3'],
    'the group keeps the individual requests for its expanded state',
  )

  // Outcomes never merge: a denial keeps its own row ahead of the approved run.
  const mixedOutcomes = projectConversation([
    ev('turn_started', { turnId: 'turn-mixed' }),
    ev('approval_requested', {
      turnId: 'turn-mixed',
      requestId: 'm1',
      action: 'Bash',
      kind: 'tool',
      summary: 'Bash: rm -rf build',
    }),
    ev('approval_resolved', { turnId: 'turn-mixed', requestId: 'm1', approved: false }),
    ev('approval_requested', {
      turnId: 'turn-mixed',
      requestId: 'm2',
      action: 'Bash',
      kind: 'tool',
      summary: 'Bash: npm test',
    }),
    ev('approval_resolved', { turnId: 'turn-mixed', requestId: 'm2', approved: true }),
    ev('approval_requested', {
      turnId: 'turn-mixed',
      requestId: 'm3',
      action: 'Bash',
      kind: 'tool',
      summary: 'Bash: npm run lint',
    }),
    ev('approval_resolved', { turnId: 'turn-mixed', requestId: 'm3', approved: true }),
    ev('turn_completed', { turnId: 'turn-mixed' }),
  ])
  const mixedDecisions = row(
    deriveConversationTimelineRows(mixedOutcomes.entries, mixedOutcomes.activeTurn),
    'assistant',
  ).decisions
  assert.deepEqual(
    mixedDecisions.map((decision) => decision.kind),
    ['decision', 'decisionGroup'],
  )
  assert.equal(
    mixedDecisions[1]?.kind === 'decisionGroup' ? mixedDecisions[1].label : '',
    'Approved 2 tool uses',
    'a batch of commands counts tool uses, not files',
  )

  const decisionEntry = (
    requestId: string,
    status: ConversationApprovalEntry['status'],
    extra: Partial<ConversationApprovalEntry> = {},
  ): ConversationApprovalEntry => ({
    kind: 'approval',
    requestId,
    summary: `summary ${requestId}`,
    status,
    requestKind: 'tool',
    ...extra,
  })

  assert.deepEqual(groupResolvedDecisions([decisionEntry('p1', 'pending')]), [], 'pending requests stay in the dock')
  assert.deepEqual(
    groupResolvedDecisions([decisionEntry('t1', 'approved')]).map((decision) => decision.kind),
    ['decision'],
    'one resolved permission is not a list',
  )
  assert.deepEqual(
    groupResolvedDecisions([
      decisionEntry('t1', 'approved'),
      decisionEntry('t2', 'approved'),
      decisionEntry('q1', 'approved', { requestKind: 'question' }),
      decisionEntry('t3', 'approved'),
      decisionEntry('t4', 'approved'),
    ]).map((decision) => decision.kind),
    ['decisionGroup', 'decision', 'decisionGroup'],
    'a question records a real answer, so it keeps its own row and splits the runs',
  )
  assert.equal(
    resolvedDecisionGroupLabel('denied', [
      decisionEntry('d1', 'denied', { action: 'Write' }),
      decisionEntry('d2', 'denied', { action: 'Read' }),
    ]),
    'Denied 2 files',
  )
  assert.equal(
    resolvedDecisionGroupLabel('approved', [
      decisionEntry('a1', 'approved', { action: 'Write' }),
      decisionEntry('a2', 'approved', { action: 'Bash' }),
    ]),
    'Approved 2 tool uses',
    'a mixed batch falls back to the generic noun',
  )
  assert.equal(
    resolvedDecisionGroupLabel('cancelled', [decisionEntry('c1', 'cancelled'), decisionEntry('c2', 'cancelled')]),
    'Cancelled 2 tool uses',
  )

  // The group renders collapsed: one summary line, the requests behind it.
  const decisionsMarkup = renderToStaticMarkup(createElement(ResolvedDecisions, { rows: batchAssistant.decisions }))
  assert.ok(decisionsMarkup.includes('Approved 3 files'), 'the batch reads as one outcome line')
  assert.ok(decisionsMarkup.includes('aria-expanded="false"'), 'a resolved batch mounts collapsed and is expandable')
  assert.ok(!decisionsMarkup.includes('src/a.ts'), 'the individual requests wait behind the expander')

  // ── Tool permissions ─────────────────────────────────────────────────────────
  // A chat's preset is chosen on its engine picker's trailing row — the same
  // footer control a terminal launch uses — not on a separate pill.
  // Which preset the pill reports (1809). The store used to be the only source,
  // so a session running on a different preset than the agent record rendered a
  // pill that misstated what the child would do on its next tool call.
  const liveSession = (permissionPreset?: 'none' | 'bypass') => (permissionPreset ? { permissionPreset } : {})
  assert.equal(
    resolvePermissionPreset(liveSession('bypass'), 'none'),
    'bypass',
    'a live session running on Bypass is reported as Bypass, whatever the agent record says',
  )
  assert.equal(
    resolvePermissionPreset(liveSession('none'), 'bypass'),
    'none',
    'the session wins in the other direction too — the pill never overstates the child’s freedom',
  )
  assert.equal(
    resolvePermissionPreset(null, 'none'),
    'none',
    'with no session yet the agent record is what the next session will start on',
  )
  assert.equal(
    resolvePermissionPreset(liveSession(), 'none'),
    'none',
    'a session that never recorded a preset falls through to the record, not past it',
  )
  assert.equal(
    resolvePermissionPreset(null, undefined),
    'auto',
    'an agent record predating the field starts on the app’s spawn default',
  )

  const { PermissionFooter } = await import('../workspace/agentComposer/spawnFooter')
  const { agentPermissionOptions } = await import('../workspace/agentComposer/agentSpawnShared')
  const footerMarkup = (preset: 'none' | 'bypass' | 'auto', cli = 'claude-code', mode?: string): string =>
    renderToStaticMarkup(
      createElement(PermissionFooter, {
        options: agentPermissionOptions(bundledPermissionModes(cli)),
        preset,
        ...(mode ? { mode } : {}),
        onSelect: () => {},
      }),
    )

  const defaultFooter = footerMarkup('none')
  assert.ok(defaultFooter.includes('No flag'), 'the footer names the preset in force at rest')
  assert.ok(
    defaultFooter.includes('aria-haspopup="menu"') && defaultFooter.includes('aria-expanded="false"'),
    'it is a disclosure control over the preset rows, announced as one',
  )
  assert.ok(!defaultFooter.includes('--tone-warn'), 'the CLI’s own default is the quiet, unremarkable state')
  assert.ok(
    footerMarkup('bypass').includes('--tone-warn'),
    'a chat running without permission checks says so in the warn tone',
  )
  assert.ok(footerMarkup('bypass', 'codex').includes('YOLO'), 'a Codex chat names bypass the way Codex does')
  assert.ok(footerMarkup('auto', 'codex').includes('Auto-review'), 'and Auto, as Codex’s auto-review')
  assert.ok(
    footerMarkup('auto', 'claude-code', 'acceptEdits').includes('Accept edits'),
    'a mode of the CLI’s own at a preset is named for itself, not for the preset',
  )
  assert.ok(
    footerMarkup('auto', 'claude-code', 'workspace').includes('>Auto<'),
    'a mode the CLI does not have reads as the preset’s own',
  )

  // The pill's rows (remote-sessions-ux / selector-menus-premium): roving
  // tabIndex, one-line summaries, and the four glyphs drawn from AppIcons —
  // not a paragraph per row (owner request 2026-09-30 for four presets).
  const { PermissionPresetMenuRows } = await import('../workspace/agentComposer/agentSpawnShared')
  const rowsMarkup = renderToStaticMarkup(
    createElement(PermissionPresetMenuRows, { value: 'bypass', onSelect: () => {} }),
  )
  assert.equal((rowsMarkup.match(/role="menuitemradio"/g) ?? []).length, 4, 'four preset rows')
  assert.equal((rowsMarkup.match(/tabindex="0"/g) ?? []).length, 1, 'exactly one tab stop: the checked row')
  assert.ok(
    rowsMarkup.indexOf('>Manual<') < rowsMarkup.indexOf('>Auto<') &&
      rowsMarkup.indexOf('>Auto<') < rowsMarkup.indexOf('Bypass permissions') &&
      rowsMarkup.indexOf('Bypass permissions') < rowsMarkup.indexOf('No flag'),
    'strictest first, No flag last',
  )
  assert.ok(
    rowsMarkup.includes('The CLI’s default — no permission flag is passed.'),
    'the no-flag row carries a one-line summary',
  )
  assert.ok(!rowsMarkup.includes('That can mean asking'), 'the paragraph stays in the tooltip, off the row')
  const unsupportedRows = renderToStaticMarkup(
    createElement(PermissionPresetMenuRows, {
      value: 'none',
      onSelect: () => {},
      disabledReasons: { bypass: 'This provider does not support this permission preset.' },
    }),
  )
  assert.equal(
    (unsupportedRows.match(/ disabled=""/g) ?? []).length,
    1,
    'a provider dims exactly the preset it cannot run',
  )
  assert.equal(
    (unsupportedRows.match(/does not support this permission preset/g) ?? []).length,
    1,
    'with its reason as the meta line',
  )

  // --- image attachments (D3/1774) -------------------------------------------

  // The affordance is offered only where a provider actually reads the turn's
  // attachments. Any other provider ignores the field, so staging an image there
  // would be a control whose payload goes nowhere.
  assert.equal(providerAcceptsImages('claude-agent'), true, 'the agent harness composes image blocks')
  assert.equal(providerAcceptsImages('openrouter'), false, 'a model provider does not read attachments yet')
  assert.equal(providerAcceptsImages(undefined), false, 'an unknown provider is never assumed vision-capable')

  // The three boundary limits are the shared declaration, not a second copy that
  // can drift from the one the IPC boundary enforces (1810). Identity, not
  // equality: a re-typed array here would pass a deepEqual today and drift
  // tomorrow. The other half of the pairing — that the boundary accepts exactly
  // these values — is asserted against the real handler in
  // src/main/ipc/conversation-ipc.test.ts.
  assert.equal(ATTACHABLE_IMAGE_TYPES, SHARED_ATTACHABLE_IMAGE_TYPES, 'the composer offers the shared media-type set')
  assert.equal(MAX_ATTACHMENT_BYTES, SHARED_MAX_ATTACHMENT_BYTES, 'the composer sizes against the shared ceiling')
  assert.equal(MAX_ATTACHMENTS_PER_TURN, SHARED_MAX_ATTACHMENTS_PER_TURN, 'the composer trims to the shared cap')

  // The composer accepts exactly the shared set — nothing narrower (a silently
  // unattachable format) and nothing wider (a rejection one layer down).
  for (const mediaType of SHARED_ATTACHABLE_IMAGE_TYPES) {
    assert.equal(isAttachableImageType(mediaType), true, `${mediaType} is attachable`)
  }
  assert.equal(isAttachableImageType('image/svg+xml'), false, 'SVG is not in the SDK image set')
  assert.equal(isAttachableImageType('application/pdf'), false, 'only images attach')

  // Type and count are decidable before the file is read; the byte ceiling is not
  // (downscaling happens first), so it is deliberately not this predicate's job.
  assert.equal(attachmentRejection({ name: 'shot.png', type: 'image/png' }, 0), null, 'a PNG under the cap attaches')
  assert.match(
    attachmentRejection({ name: 'notes.pdf', type: 'application/pdf' }, 0) ?? '',
    /notes\.pdf is not an image/,
    'a refusal names the file and the accepted formats',
  )
  assert.match(
    attachmentRejection({ type: 'application/pdf' }, 0) ?? '',
    /^That file is not an image/,
    'a nameless clipboard item still gets a readable refusal',
  )
  assert.match(
    attachmentRejection({ name: 'ok.png', type: 'image/png' }, MAX_ATTACHMENTS_PER_TURN) ?? '',
    new RegExp(`at most ${MAX_ATTACHMENTS_PER_TURN} images`),
    'the per-turn cap is reported, not silently enforced',
  )

  // Decoded length drives every byte guard, so padding must not skew it.
  assert.equal(base64ByteLength('Zm9v'), 3, 'unpadded')
  assert.equal(base64ByteLength('Zm8='), 2, 'one pad byte')
  assert.equal(base64ByteLength('Zg=='), 1, 'two pad bytes')
  assert.equal(base64ByteLength(''), 0, 'empty payload is zero bytes, never negative')

  // An image that already fits comes back untouched — resampling it would
  // re-encode for no gain (and flatten an animated GIF).
  assert.deepEqual(scaledImageDimensions(800, 600), { width: 800, height: 600 }, 'a small image is not resampled')
  assert.deepEqual(
    scaledImageDimensions(MAX_ATTACHMENT_EDGE, MAX_ATTACHMENT_EDGE),
    { width: MAX_ATTACHMENT_EDGE, height: MAX_ATTACHMENT_EDGE },
    'exactly at the edge still fits',
  )
  assert.deepEqual(
    scaledImageDimensions(3200, 1600),
    { width: MAX_ATTACHMENT_EDGE, height: MAX_ATTACHMENT_EDGE / 2 },
    'the long edge is what gets constrained, aspect ratio preserved',
  )
  assert.deepEqual(
    scaledImageDimensions(1000, 4000),
    { width: 392, height: MAX_ATTACHMENT_EDGE },
    'a portrait image constrains on height',
  )
  assert.deepEqual(scaledImageDimensions(0, 0), { width: 0, height: 0 }, 'a zero-sized image never divides by zero')
  assert.deepEqual(
    scaledImageDimensions(20000, 4),
    { width: MAX_ATTACHMENT_EDGE, height: 1 },
    'an extreme aspect ratio still yields a drawable canvas',
  )

  // The IPC boundary wants the raw payload, not the data: URI it came in as.
  assert.deepEqual(
    splitImageDataUrl('data:image/png;base64,Zm9v'),
    { mediaType: 'image/png', dataBase64: 'Zm9v' },
    'the prefix is stripped and the media type kept',
  )
  assert.equal(splitImageDataUrl('data:image/png,notbase64'), null, 'a non-base64 data URL is refused, not guessed')
  assert.equal(splitImageDataUrl('https://example.com/a.png'), null, 'a remote URL is not a payload')
  assert.equal(splitImageDataUrl('data:image/png;base64,'), null, 'an empty payload is refused')

  assert.equal(
    attachmentPreviewUrl({ id: 'a', mediaType: 'image/webp', dataBase64: 'Zm9v', byteLength: 3 }),
    'data:image/webp;base64,Zm9v',
    'the thumbnail reads the base64 already in memory — no object URL to leak',
  )

  assert.equal(formatAttachmentBytes(512), '512 B')
  assert.equal(formatAttachmentBytes(2048), '2 KB')
  assert.equal(formatAttachmentBytes(MAX_ATTACHMENT_BYTES), '5.0 MB')

  // A queued image-only turn has no text to show, so the count is the label —
  // never a blank row that reads as nothing queued.
  assert.equal(queuedTurnLabel('look at this', 0), 'look at this')
  assert.equal(queuedTurnLabel('look at this', 2), 'look at this · 2 images')
  assert.equal(queuedTurnLabel('', 1), '1 image')
  assert.equal(attachmentCountLabel(1), '1 image', 'the count never reads "1 images"')

  // A second commit while the turn is locked folds into the waiting queued turn.
  const img = (n: number): ConversationImageAttachment => ({
    id: `q${n}`,
    mediaType: 'image/png',
    dataBase64: 'Zm9v',
    byteLength: 3,
  })
  assert.deepEqual(
    mergeQueuedTurn(null, 'first', [img(1)]),
    { text: 'first', attachments: [img(1)], dropped: 0 },
    'the first commit while busy becomes the queued turn',
  )
  assert.deepEqual(
    mergeQueuedTurn({ text: 'first', attachments: [img(1)] }, 'second', [img(2)]),
    { text: 'first\nsecond', attachments: [img(1), img(2)], dropped: 0 },
    'a second commit appends its text and concatenates its images',
  )
  assert.equal(
    mergeQueuedTurn({ text: '', attachments: [] }, 'only text', []).text,
    'only text',
    'an empty queued text does not leave a leading newline',
  )
  assert.equal(
    mergeQueuedTurn({ text: 'staged', attachments: [] }, '', [img(1)]).text,
    'staged',
    'an image-only commit keeps the queued text as-is',
  )
  // The cap is the IPC boundary's, so trimming is right — but a queue that
  // swallowed the tail of a paste in silence would look like it took everything.
  const overflowed = mergeQueuedTurn(
    { text: 'a', attachments: Array.from({ length: MAX_ATTACHMENTS_PER_TURN }, (_, i) => img(i)) },
    'b',
    [img(99), img(98)],
  )
  assert.equal(overflowed.attachments.length, MAX_ATTACHMENTS_PER_TURN, 'the queued turn never exceeds the cap')
  assert.equal(overflowed.dropped, 2, 'the trim is counted so the composer can report it')

  // A queued turn whose send was refused comes back to the composer even when
  // the person has typed more since, ahead of it, not only onto an empty box.
  assert.equal(restoreRefusedText('', 'queued'), 'queued')
  assert.equal(restoreRefusedText('typed since', 'queued'), 'queued\ntyped since')
  assert.equal(restoreRefusedText('queued', 'queued'), 'queued', 'already back, it is not doubled')
  assert.equal(restoreRefusedText('queued\ntyped since', 'queued'), 'queued\ntyped since', 'nor stacked again')
  // Its Retry takes it back out, so the next Enter sends only what was typed.
  assert.equal(draftAfterRetried('queued\ntyped since', 'queued'), 'typed since')
  assert.equal(draftAfterRetried('typed since', 'queued'), null)

  // Mid-drag the payload is unreadable — only the item kinds are — so the drop
  // target and the preventDefault gate key off those.
  const transfer = (value: { types?: string[]; items?: { kind: string }[] }): DataTransfer =>
    value as unknown as DataTransfer
  assert.equal(dataTransferHasFiles(transfer({ types: ['Files'] })), true, 'a file drag is claimed')
  assert.equal(dataTransferHasFiles(transfer({ types: ['text/plain'], items: [{ kind: 'string' }] })), false)
  assert.equal(dataTransferHasFiles(null), false, 'a missing payload never claims the drop')
  assert.equal(
    dataTransferHasFiles(transfer({ items: [{ kind: 'file' }] })),
    true,
    'an item-only payload (some clipboard/drag sources) still reports files',
  )

  // The staged strip: thumbnails are the content, remove is a trailing action —
  // hidden at rest but focusable and named, so a keyboard user can reach it.
  const staged: ConversationImageAttachment[] = [
    { id: 'att-1', mediaType: 'image/png', dataBase64: 'Zm9v', name: 'screenshot.png', byteLength: 3 },
    { id: 'att-2', mediaType: 'image/jpeg', dataBase64: 'YmFy', byteLength: 3 },
  ]
  assert.equal(
    renderToStaticMarkup(createElement(ComposerAttachmentStrip, { attachments: [], reading: 0, onRemove: () => {} })),
    '',
    'nothing staged renders nothing — no empty chrome above the field',
  )
  const stripMarkup = renderToStaticMarkup(
    createElement(ComposerAttachmentStrip, { attachments: staged, reading: 0, onRemove: () => {} }),
  )
  assert.ok(stripMarkup.includes('src="data:image/png;base64,Zm9v"'), 'the staged image renders from its own payload')
  assert.ok(stripMarkup.includes('alt="screenshot.png"'), 'a named file is its own alt text')
  assert.ok(
    stripMarkup.includes('alt="Attached image"'),
    'a pasted screenshot with no name still has an accessible name',
  )
  assert.ok(
    stripMarkup.includes('aria-label="Remove screenshot.png"'),
    'remove is named per image, not a row of identical buttons',
  )
  assert.equal(
    (stripMarkup.match(/<li/g) ?? []).length,
    2,
    'the strip is a real list, so a screen reader announces how many images are staged',
  )
  assert.ok(
    renderToStaticMarkup(
      createElement(ComposerAttachmentStrip, { attachments: [], reading: 2, onRemove: () => {} }),
    ).includes('Reading 2 images…'),
    'a large image being read says so instead of looking like nothing happened',
  )

  // The user bubble: an image-only turn must not render an empty text line.
  const bubbleWithBoth = renderToStaticMarkup(
    createElement(UserTimelineRow, { entry: { kind: 'user', id: 'u1', text: 'what is this?', attachments: staged } }),
  )
  assert.ok(bubbleWithBoth.includes('what is this?'), 'text still renders alongside the images')
  assert.equal((bubbleWithBoth.match(/<img/g) ?? []).length, 2, 'every image sent with the turn shows in the bubble')
  const imageOnlyBubble = renderToStaticMarkup(
    createElement(UserTimelineRow, { entry: { kind: 'user', id: 'u2', text: '', attachments: staged } }),
  )
  assert.ok(!imageOnlyBubble.includes('<p'), 'an image-only turn renders no empty paragraph')
  assert.ok(
    renderToStaticMarkup(createElement(UserTimelineRow, { entry: { kind: 'user', id: 'u3', text: 'plain' } })).includes(
      'plain',
    ),
    'a text-only bubble is unchanged',
  )

  // A thumbnail is a door, not a picture: clicking one hands the image to the
  // operating system's viewer, so it has to be a real button with a name of its
  // own — a bare <img> is what made the click do nothing at all.
  assert.ok(
    stripMarkup.includes('aria-label="Open screenshot.png"'),
    'a staged thumbnail is a named button, so it can be clicked and tabbed to',
  )
  assert.ok(
    bubbleWithBoth.includes('aria-label="Open screenshot.png"'),
    'a sent image opens the same way as a staged one',
  )
  assert.ok(
    bubbleWithBoth.includes('aria-label="Open Attached image"'),
    'a pasted screenshot with no name still names its own door',
  )
  {
    const opened: unknown[] = []
    const priorApi = (dom.window as unknown as Record<string, unknown>).api
    ;(dom.window as unknown as Record<string, unknown>).api = {
      openImageAttachment: async (input: unknown) => {
        opened.push(input)
      },
    }
    await openAttachmentImage(staged[0]!)
    assert.deepEqual(
      opened,
      [{ mediaType: 'image/png', dataBase64: 'Zm9v', name: 'screenshot.png' }],
      'opening sends the bytes and the name main needs to write the file it opens',
    )
    // A refusal from main must be reported: nothing else on screen would change
    // to tell the person their click went nowhere.
    const reported: string[] = []
    const priorToasts = useToastStore.getState().toasts
    ;(dom.window as unknown as Record<string, unknown>).api = {
      openImageAttachment: async () => {
        throw new Error('no application knows how to open it')
      },
    }
    await openAttachmentImage(staged[0]!)
    for (const toast of useToastStore.getState().toasts) reported.push(`${toast.tone}:${toast.title}`)
    assert.ok(reported.includes('error:Could not open that image'), 'a failed open is reported rather than swallowed')
    useToastStore.setState({ toasts: priorToasts })
    ;(dom.window as unknown as Record<string, unknown>).api = priorApi
  }

  // The persisted user_message event names its images by store reference, so
  // while the local send is here the bubble keeps the images it staged. Without
  // the localTurnId hand-off the thumbnails would blink out the instant the
  // authoritative event replaced the optimistic entry.
  const IMG_TURN = 'turn-img'
  const withImages = projectConversation(
    [
      ev('turn_started', { turnId: IMG_TURN }),
      ev('user_message', { turnId: IMG_TURN, text: 'what is this?', localTurnId: 'local-1' }),
      ev('content_delta', { turnId: IMG_TURN, text: 'a cat' }),
    ],
    [{ id: 'local-1', text: 'what is this?', attachments: staged }],
  )
  const imageUserEntry = withImages.entries.find((entry) => entry.kind === 'user')
  assert.ok(imageUserEntry && imageUserEntry.kind === 'user', 'the user bubble survives the swap to the event entry')
  assert.deepEqual(
    imageUserEntry.attachments,
    staged,
    'the authoritative bubble keeps the images the local send staged',
  )
  assert.equal(
    withImages.entries.filter((entry) => entry.kind === 'user').length,
    1,
    'the optimistic entry is still replaced, not duplicated',
  )
  // A replayed transcript has no local send behind it: a turn that recorded no
  // images must not invent an empty attachments array, and one that did reads
  // them back by reference.
  const replayed = projectConversation([
    ev('turn_started', { turnId: IMG_TURN }),
    ev('user_message', { turnId: IMG_TURN, text: 'what is this?', localTurnId: 'local-1' }),
  ])
  const replayedUser = replayed.entries.find((entry) => entry.kind === 'user')
  assert.ok(replayedUser && replayedUser.kind === 'user')
  assert.equal(replayedUser.attachments, undefined, 'a replayed bubble carries no live attachments')
  assert.equal(replayedUser.storedAttachments, undefined, 'nor stored ones it never recorded')
  const storedRef = {
    id: 'img-1',
    mediaType: 'image/png',
    name: 'cat.png',
    byteLength: 3,
    ref: `${'a'.repeat(32)}/x.png`,
  }
  const recordedEvents = [
    ev('turn_started', { turnId: IMG_TURN }),
    ev('user_message', {
      turnId: IMG_TURN,
      text: 'what is this?',
      localTurnId: 'local-1',
      attachments: [storedRef, { id: 'broken' }],
    }),
  ]
  const restored = projectConversation(recordedEvents).entries.find((entry) => entry.kind === 'user')
  assert.ok(restored && restored.kind === 'user')
  assert.deepEqual(restored.storedAttachments, [storedRef], 'a replayed bubble keeps its well-formed references')
  const live = projectConversation(recordedEvents, [
    { id: 'local-1', text: 'what is this?', attachments: staged },
  ]).entries.find((entry) => entry.kind === 'user')
  assert.ok(live && live.kind === 'user')
  assert.deepEqual(live.attachments, staged, 'a live send still shows the images it has in memory')
  assert.equal(live.storedAttachments, undefined, 'and does not read them back as well')

  // The spawn→session wiring lives inside store/window-bound code this DOM-less
  // test cannot mount, so it is pinned at the source. Both ends matter: a spawn
  // that drops the picked preset, or a session start that re-hardcodes 'default',
  // puts the bug back with every rendered assertion above still passing.
  const chatViewSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/panels/AgentChatView.tsx'),
    'utf8',
  )
  const workspaceManagerSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/workspace/WorkspaceManager.tsx'),
    'utf8',
  )
  assert.match(
    chatViewSource,
    /const permissionPreset = resolvePermissionPreset\(session, agent\?\.cliPermissionPreset\)/,
    'the live session supplies the exact requested preset',
  )
  assert.doesNotMatch(
    chatViewSource,
    /capabilities\.permissionPresets\[0\]/,
    'unsupported manual approval cannot silently fall back to CLI-managed permissions',
  )
  assert.match(
    chatViewSource.slice(chatViewSource.indexOf('transport.startSession({')),
    /^[\s\S]{0,600}?\n\s+permissionPreset,\n/,
    'the session start carries the agent’s preset instead of the provider default',
  )
  assert.doesNotMatch(
    chatViewSource,
    /permissionPreset: 'manual'/,
    'no start path in the chat view pins the preset to a literal',
  )
  assert.match(
    workspaceManagerSource.slice(
      workspaceManagerSource.indexOf('conversationAgentRuntimePatch(target.providerId, target.modelId)'),
    ),
    /^[\s\S]{0,600}?permissionPreset: resolveCliPermissionPreset\(confirm\.cli, agentSpawnPermissionPreset\),/,
    'the chat spawn stamps the preset the picker showed for its CLI, like every CLI spawn',
  )
  // Every open chat's layer stays mounted and nearly every chat has an
  // `agent-1`, so a DOM id built from the agent id names several elements and a
  // label points at whichever came first — another chat's composer.
  assert.doesNotMatch(
    chatViewSource,
    /(?:\bid|htmlFor|aria-[a-z]+)=\{`[^`]*\$\{agentId\}/,
    'no DOM id in the chat view is built from the agent id alone',
  )
  // A refused change must never leave the pill claiming a preset the session is
  // not on: both failure branches of changePermissionPreset (refused, threw)
  // write the old value back. A window whose bridge is missing is answered
  // with a refusal by its transport, so the first branch covers it.
  assert.match(
    chatViewSource,
    /const previous = \{ cliPermissionPreset: agent\?\.cliPermissionPreset, cliPermissionMode: agent\?\.cliPermissionMode \}/,
    'the rollback holds the preset and the CLI’s own mode the record had',
  )
  assert.equal(
    (chatViewSource.match(/updateBinding\(previous\)/g) ?? []).length,
    2,
    'both failure branches roll the optimistic write back',
  )
  // An accepted change the provider cannot apply to the streaming turn comes back
  // with a sentence saying when it starts applying (1808). Produced-and-dropped is
  // the failure mode here, so the success path is pinned to show it — as
  // information, never through the error line's tone.
  assert.match(
    chatViewSource,
    /setSession\(result\.session\)\n\s+setPermissionNotice\(result\.notice \?\? null\)/,
    'an accepted permission change adopts the session’s reported preset and surfaces its notice',
  )
  const noticeRenderIndex = chatViewSource.indexOf('{permissionNotice ? (')
  assert.notEqual(noticeRenderIndex, -1, 'the notice has a render site at all')
  const noticeRender = chatViewSource.slice(noticeRenderIndex)
  assert.match(
    noticeRender.slice(0, 300),
    /--text-muted[\s\S]*?\{permissionNotice\}/,
    'the notice renders in the muted information tone, not as an error',
  )
  assert.doesNotMatch(
    noticeRender.slice(0, 300),
    /tone-error/,
    'a recorded change is information; the error line stays for actual failures',
  )

  // A message committed while the agent works waits in the queue by default,
  // where it can be seen, sent now or taken back. Handing every one to the
  // running turn on Enter lost messages that turn never took in, so a steer on
  // Enter is the person's choice (followUpDispatch.ts), never Enter's own.
  const submitSource = chatViewSource.slice(
    chatViewSource.indexOf('const commitDraft = useCallback('),
    chatViewSource.indexOf('const openComposerMenu = useCallback('),
  )
  assert.match(submitSource, /setQueuedTurn\(turn\)/, 'a busy submit queues the message')
  assert.match(
    submitSource,
    /resolveComposerDispatch\(\{[\s\S]*?behavior: followUpBehavior[\s\S]*?if \(dispatch === 'steer'\)/,
    'a busy submit steers only where the person chose it',
  )
  assert.doesNotMatch(submitSource, /steerOnSend/, 'nothing else hands the message to the running turn')
  assert.doesNotMatch(
    chatViewSource,
    /useEffect\(\(\) => \{\s*if \(queuedTurn === null[^}]*\}\s*if \(steer/,
    'nothing steers a queued message without the person asking',
  )

  // The composer's attach wiring is window/DOM-bound (FileReader, canvas, the
  // send IPC) and cannot be mounted here, so the ends that would silently drop a
  // staged image are pinned at the source.
  assert.match(
    chatViewSource.slice(chatViewSource.indexOf('transport.send({')),
    /^[\s\S]{0,400}?attachments: turnAttachments/,
    'the send IPC carries the staged attachments, not just the text',
  )
  for (const handler of ['onPaste=', 'onDrop:', 'useFileDropTarget({', '<HiddenFileInput']) {
    assert.ok(chatViewSource.includes(handler), `the composer wires ${handler}`)
  }
  // The "+" menu's Attach files row clicks the kit's hidden file input, whose
  // pick is sorted as a drop of the same files is: images through attachFiles
  // where the chat reads them, any other file as its card.
  assert.match(
    chatViewSource.slice(chatViewSource.indexOf('<HiddenFileInput')),
    /^[\s\S]{0,300}?onFiles=\{onPickedFiles\}/,
    'the picker hands its pick on',
  )
  assert.match(
    chatViewSource,
    /takePickedFilesRef\.current = \(files\) =>\s+filesEnabled \? takeFiles\(sortFiles\(files, fileSorting\)\) : void attachFiles\(files\)/,
    'a picked file is taken as a drop of it is, and attaches through attachFiles where only images do',
  )
  assert.match(
    chatViewSource.slice(chatViewSource.indexOf('<ComposerPlusMenu')),
    /^[\s\S]{0,200}?onAttach=\{imagesEnabled \|\| filesEnabled \? openFilePicker : undefined\}/,
    'the "+" offers Attach files where the chat reads images or takes files by path',
  )
  assert.ok(
    chatViewSource.includes('dropHandlers={fileDropHandlers}'),
    'a file dropped anywhere on the chat lands in the composer, not only on the field',
  )
  assert.match(
    chatViewSource.slice(chatViewSource.indexOf("event.key === 'Backspace'")),
    /selectionStart === 0[\s\S]*?selectionEnd === 0[\s\S]*?if \(attachments.length\) \{\s+event.preventDefault\(\)\s+setAttachments\(\(current\) => current.slice\(0, -1\)\)/,
    'Backspace at the draft start removes the last staged image after other context chips',
  )
  assert.equal(
    (chatViewSource.match(/imagesEnabled/g) ?? []).length >= 4,
    true,
    'every image attach entry point (paste, drop, picker) is gated on provider support',
  )
  assert.match(
    chatViewSource.slice(chatViewSource.indexOf('queueComposerDraft(queuedTurn')),
    /^[\s\S]{0,300}?setActionError\(queuedDropNotice\(dropped\)\)/,
    'a queue merge that hit the cap tells the user, instead of trimming in silence',
  )

  // The right-click menu (1793) is DOM-bound (pointer coordinates, the field's
  // selection, the clipboard IPC), so its wiring is pinned at the source.
  assert.ok(
    chatViewSource.includes('onContextMenu={(event, field) => void openComposerMenu(event, field)}'),
    'the composer field opens the menu on right-click',
  )
  assert.match(
    chatViewSource.slice(chatViewSource.indexOf('const openComposerMenu')),
    /^[\s\S]{0,900}?await readClipboardText\(\)/,
    'the menu reads the clipboard before opening, so Paste is never offered against an empty one',
  )
  // The button and the menu item must both read the shared rule — a literal
  // re-derivation in either place is how they drift apart.
  assert.ok(
    chatViewSource.includes('ariaLabel={sendAction.label}') &&
      chatViewSource.includes('disabled={sendAction.disabled}') &&
      chatViewSource.includes('send={sendAction}'),
    'the send button and the menu item share one composerSendAction result',
  )
  assert.match(
    chatViewSource.slice(chatViewSource.indexOf('onCut={')),
    /^[\s\S]{0,400}?if \(written\) replaceComposerSelection\(composerMenu, ''\)/,
    'Cut removes the selection only once the clipboard write actually succeeded',
  )
  assert.ok(
    chatViewSource.includes('onSend={submitComposer}'),
    'the menu commits through the same submit path as Enter and the button',
  )

  // Skills and files use the same caret-aware trigger detector. A selected
  // range is removed without disturbing the remainder of the draft.
  assert.deepEqual(
    detectComposerTrigger('/', 1),
    { kind: 'slash', query: '', range: { start: 0, end: 1 } },
    'a bare slash opens the list unfiltered',
  )
  assert.deepEqual(
    detectComposerTrigger('$', 1),
    { kind: 'skill', query: '', range: { start: 0, end: 1 } },
    'a bare dollar opens the list unfiltered',
  )
  assert.deepEqual(
    detectComposerTrigger('please run $back', 16),
    { kind: 'skill', query: 'back', range: { start: 11, end: 16 } },
    'a dollar starting a word attaches a skill',
  )
  assert.equal(detectComposerTrigger('costs US$40', 11), null, 'a dollar inside a word is money, not a mention')
  assert.equal(detectComposerTrigger('please run $backlog on it', 24), null, 'a space ends the mention token')
  assert.equal(detectComposerTrigger('hello', 5), null)
  assert.equal(detectComposerTrigger('', 0), null)

  // The type-ahead is mounted inside the composer box, whose top edge anchors it,
  // and the same handler answers the shell's light dismiss and the field's Escape.
  assert.match(
    chatViewSource.slice(chatViewSource.indexOf('{contextPicker.picker}')),
    /^[\s\S]{0,900}?<ComposerAttachmentStrip/,
    'the skill type-ahead sits inside the composer box, ahead of the attachment strip',
  )
  assert.ok(
    chatViewSource.includes('contextPicker.handleKeyDown(event)'),
    'the textarea forwards navigation and dismissal to the shared picker',
  )

  console.log('AgentChatView.test.ts: ok')

  // ── Model picker groups (1772) ───────────────────────────────────────────────
  // The picker used to fetch only the ACTIVE provider's catalog and to drop any
  // group with zero models, so a key-configured OpenRouter/xAI whose manifest seed
  // was empty simply vanished — the user could never reach the models they had
  // paid for. Group construction and the search/chip filter are the two places
  // that regression lived, so both are pinned here.

  function providerEntry(
    overrides: Partial<ConversationProviderListEntry> & Pick<ConversationProviderListEntry, 'id'>,
  ): ConversationProviderListEntry {
    return {
      displayName: overrides.id,
      source: 'user',
      version: 1,
      providerType: 'model-provider',
      models: [],
      supportsDynamicModels: false,
      credentialSource: 'api-key',
      adapter: { kind: 'declarative', execution: 'declarative', trust: 'not_required' },
      ...overrides,
    }
  }

  const HARNESS = providerEntry({
    id: 'claude-agent',
    displayName: 'Claude Code',
    providerType: 'agent-harness',
    credentialSource: 'native',
    models: [{ id: 'opus', displayName: 'Opus' }],
  })
  const OPENROUTER = providerEntry({
    id: 'openrouter',
    displayName: 'OpenRouter',
    supportsDynamicModels: true,
    models: [{ id: 'seed-a' }, { id: 'seed-b' }],
  })
  const XAI = providerEntry({ id: 'xai', displayName: 'xAI', supportsDynamicModels: true, models: [] })

  // Native credentials sort first so the user's existing CLI configuration is
  // never silently displaced by app-managed API keys.
  {
    const groups = buildModelGroups([OPENROUTER, HARNESS, XAI], {}, {})
    assert.deepEqual(
      groups.map((group) => group.providerId),
      ['claude-agent', 'openrouter', 'xai'],
      'the native-credentials group sorts ahead of app-managed API providers',
    )
    assert.equal(groups[0]?.credentialSource, 'native')
    assert.equal(
      groups[1]?.credentialSource,
      'api-key',
      'app-managed API credentials remain distinct from native login',
    )
  }

  // The headline 1772 case: a key-configured provider that is NOT the active one.
  // Its live catalog is merged in as soon as the picker browses to it, and the
  // group survives an empty seed instead of disappearing.
  {
    const withKeyNoCatalogYet = buildModelGroups([XAI], {}, { xai: true })
    assert.deepEqual(withKeyNoCatalogYet[0]?.models, [], 'no catalog loaded yet means no invented models')
    assert.equal(
      withKeyNoCatalogYet[0]?.emptyState,
      'no-models',
      'a key-configured provider says so instead of vanishing',
    )

    const browsed = buildModelGroups([XAI], { xai: [{ id: 'grok-4' }] }, { xai: true })
    assert.deepEqual(browsed[0]?.models, [{ id: 'grok-4' }], "a non-active provider's live catalog is reachable")
    assert.equal(browsed[0]?.emptyState, undefined)
  }

  // No key configured: an explicit add-key state, never a seed the user cannot use.
  {
    const groups = buildModelGroups([OPENROUTER], {}, { openrouter: false })
    assert.deepEqual(groups[0]?.models, [], 'a keyless dynamic provider lists nothing')
    assert.equal(groups[0]?.emptyState, 'add-key')
  }

  // Key state not yet fetched: the seed shows provisionally rather than an empty
  // group, so opening the picker cold is never a blank list.
  {
    const groups = buildModelGroups([OPENROUTER], {}, {})
    assert.deepEqual(
      groups[0]?.models.map((model) => model.id),
      ['seed-a', 'seed-b'],
    )
    assert.equal(groups[0]?.emptyState, undefined)
  }

  // A static provider's seed IS its full catalog — key state must never blank it.
  {
    const native = providerEntry({
      id: 'native',
      credentialSource: 'native',
      supportsDynamicModels: true,
      models: [{ id: 'native-model' }],
    })
    const local = providerEntry({ id: 'local', credentialSource: 'none', supportsDynamicModels: true })
    assert.deepEqual(buildModelGroups([native], {}, { native: false })[0].models, native.models)
    assert.equal(buildModelGroups([local], {}, { local: false })[0].emptyState, 'no-models')
  }
  {
    const staticProvider = providerEntry({ id: 'static', models: [{ id: 'only-model' }] })
    const groups = buildModelGroups([staticProvider], {}, { static: false })
    assert.deepEqual(
      groups[0]?.models.map((model) => model.id),
      ['only-model'],
      'a static catalog is not key-gated',
    )
    assert.equal(groups[0]?.emptyState, undefined)
  }

  // Live catalog wins over the seed for the provider it was fetched for, and only
  // for that provider — one fetch must never leak across groups.
  {
    const groups = buildModelGroups(
      [OPENROUTER, XAI],
      { openrouter: [{ id: 'live-1' }] },
      { openrouter: true, xai: true },
    )
    assert.deepEqual(
      groups[0]?.models.map((model) => model.id),
      ['live-1'],
      'the live catalog replaces the seed',
    )
    assert.equal(groups[1]?.emptyState, 'no-models', 'the other provider keeps its own (empty) state')
  }

  // ⌘⇧M / the palette's "Toggle Model Picker" answer with ONE view: the focused
  // one, else the most recently mounted view in the active workspace. The first
  // cut compared closures per view and silently answered nothing; this pins the
  // module-level responder the shell's panel-event now reaches.
  {
    // The event helper builds a `CustomEvent` from the global; under jsdom the
    // window only accepts its own.
    anyGlobal.CustomEvent = dom.window.CustomEvent
    useWorkspaceStore.setState({ activeWorkspaceId: 'ws-active' } as never)
    const toggled: string[] = []
    const entry = (workspaceId: string, focused = false): MountedChatView => ({
      workspaceId,
      isFocused: () => focused,
      toggleModelPicker: () => toggled.push(workspaceId),
    })
    const offBackground = registerMountedChatView(entry('ws-background'))
    const offActiveOlder = registerMountedChatView(entry('ws-active'))
    const offActiveNewer = registerMountedChatView(entry('ws-active'))
    dispatchPanelCommandEvent(MODEL_PICKER_TOGGLE_COMMAND)
    assert.deepEqual(toggled, ['ws-active'], 'exactly one view answers, in the active workspace')
    assert.equal(respondToModelPickerToggle()?.workspaceId, 'ws-active', 'the responder is the active workspace view')
    toggled.length = 0
    const offFocused = registerMountedChatView(entry('ws-background', true))
    dispatchPanelCommandEvent(MODEL_PICKER_TOGGLE_COMMAND)
    assert.deepEqual(toggled, ['ws-background'], 'a focused view wins over the active workspace')
    dispatchPanelCommandEvent('notebook.something-else')
    assert.deepEqual(toggled, ['ws-background'], 'other panel commands are ignored')
    offFocused()
    offActiveNewer()
    offActiveOlder()
    offBackground()
    toggled.length = 0
    dispatchPanelCommandEvent(MODEL_PICKER_TOGGLE_COMMAND)
    assert.deepEqual(toggled, [], 'with no view mounted the listener is gone')
    void offActiveNewer
  }

  // The previous/next-turn shortcuts reach one view through the same responder.
  {
    const steps: number[] = []
    const off = registerMountedChatView({
      workspaceId: 'ws-active',
      isFocused: () => true,
      toggleModelPicker: () => undefined,
      stepTurn: (direction) => steps.push(direction),
    })
    dispatchPanelCommandEvent('chat.turn.previous')
    dispatchPanelCommandEvent('chat.turn.next')
    assert.deepEqual(steps, [-1, 1], 'each chord steps the responding view once, in its direction')
    off()
  }

  console.log('AgentChatView.test.ts (model picker 1772): ok')
})

test('a draft folded into the queue keeps the queued message first and every attached context', () => {
  const image = (id: string): ConversationImageAttachment => ({
    id,
    mediaType: 'image/png',
    dataBase64: 'Zm9v',
    byteLength: 3,
  })
  const first = queueComposerDraft(null, 'check the logs', [image('a')], {
    skillIds: ['review'],
    mentions: [],
    files: ['/Users/dev/Desktop/crash.log'],
  })
  assert.deepEqual(first, {
    turn: {
      text: 'check the logs',
      attachments: [image('a')],
      metadata: { skillIds: ['review'], mentions: [], files: ['/Users/dev/Desktop/crash.log'] },
    },
    dropped: 0,
  })
  const mention = { kind: 'file' as const, path: 'src/app.ts' }
  const second = queueComposerDraft(first.turn, 'then fix it', [image('b')], {
    skillIds: ['review', 'tests'],
    mentions: [mention],
    // A file attached to both is sent once.
    files: ['/Users/dev/Desktop/crash.log', '/Users/dev/Desktop/spec.pdf'],
  })
  assert.equal(second.turn.text, 'check the logs\nthen fix it')
  assert.deepEqual(
    second.turn.attachments.map((entry) => entry.id),
    ['a', 'b'],
  )
  assert.deepEqual(second.turn.metadata, {
    skillIds: ['review', 'tests'],
    mentions: [mention],
    files: ['/Users/dev/Desktop/crash.log', '/Users/dev/Desktop/spec.pdf'],
  })
})

test('a busy commit is named by what the follow-up choice makes it, and an idle one still sends', () => {
  const busySend = { ready: true, busy: true, sending: false, hasText: true, attachmentCount: 0 }
  assert.equal(composerSendAction({ ...busySend, busyLabel: 'Steer message' }).label, 'Steer message')
  assert.equal(composerSendAction({ ...busySend, busy: false, busyLabel: 'Steer message' }).label, 'Send message')
  assert.equal(composerSendAction({ ...busySend, sending: true, busyLabel: 'Steer message' }).label, 'Sending')
})
