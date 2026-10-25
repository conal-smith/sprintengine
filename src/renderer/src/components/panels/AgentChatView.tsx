// AgentChatView — the chat runtime surface for conversation-backed standard
// agents (T6). It renders canonical ConversationEvents from the main runtime
// over the typed conversation IPC/preload path, and drives the session
// lifecycle: start, send a turn, stream assistant output, approve/deny tool
// requests, interrupt, stop, and retry. It deliberately has no terminal
// emulator dependency and no landing/hero — the first screen is the usable
// composer.
//
// `projectConversation` is a pure, DOM-free fold of the event stream plus the
// locally tracked user turns into an ordered transcript. It is unit-tested by
// AgentChatView.test.ts so the streaming/approval/interrupt/failure states have
// node-level coverage without rendering.

import { parseMachinePath } from '../../../../shared/machine-paths'
import { workspaceHostIdOf } from '../../../../shared/execution-host'
import { withoutStudioNoticePrefix } from '../../../../shared/studio-notice'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  LegendList,
  type LegendListRef,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from '@legendapp/list/react'

import type {
  ConversationCliRuntimeOverrides,
  ConversationImageAttachment,
  ConversationSessionSummary,
  ConversationMcpServerAction,
} from '../../../../shared/conversation-runtime'
import type { ConversationApprovalDecision } from '../../../../shared/conversation/approvalRules'
import type { MeshQueuedMessage } from '../../../../shared/tailnet-mesh'
import { apiKeyBillingNotice } from '../../../../shared/conversation/apiKeySource'
import { PromptCacheComposerNotice } from './agentChat/promptCacheNotice'
import type { ConversationProviderListEntry, ConversationProviderModel } from '../../../../shared/plugin-manifest'
import type { CliPermissionPreset } from '../../types/workspace'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ChevronDownIcon, ScheduleGlyph } from '../AppIcons'
import { copySelectionAsMarkdown } from '../../utils/selectionToMarkdown'
import { getEffectiveKeybindings, platformKeybindingsFromApiPlatform } from '../../commands/effectiveKeybindings'
import { keydownMatchesKeybindings } from '../../commands/commandDispatcher'
import { runAppCommand } from '../../commands/appCommandRunner'
import { showToast } from '../../store/toastStore'
import { renderKeybinding } from '../../commands/keybindings'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { ensureChatWorktree } from '../../utils/chatWorktreeRestore'
import {
  dataTransferHasDroppableFiles,
  dataTransferHasFiles,
  filesFromDataTransfer,
  pastedImagePaths,
  pathsForPathlessFiles,
  quotePromptPath,
  readPastedImagePaths,
  sortDroppedFiles,
  sortFiles,
  type DroppedFiles,
} from '../../utils/imageFileTransfer'
import { attachedFileName, attachedFilesOf, workspaceRunsHere } from '../../utils/attachedFiles'
import {
  attachmentCountLabel,
  attachmentPreviewUrl,
  ComposerAttachmentStrip,
  openAttachmentImage,
} from './ComposerAttachmentStrip'
import {
  COMPOSER_SURFACE_CLASS,
  SendGlyph,
  SendButton,
  FOCUS_RING_INSET_CLASS,
  FOCUS_RING_WITHIN_EDITOR_CLASS,
  FloatingButton,
  HiddenFileInput,
  InlineNotice,
  OutlineButton,
  Spinner,
  useWorkspaceSkills,
  TruncatedText,
} from '../ui'
import type { WorkspaceSkill } from '../../../../shared/electron-api'
import {
  CONVERSATION_DEFAULT_MODEL_ID,
  cliForConversationProvider,
  conversationSignIn,
} from '../../../../shared/conversation-harness'
import { isLooserCliPermissionPreset, parseCliPermissionPreset } from '../../../../shared/cli-permission-preset'
import { parseCliPermissionModeId } from '../../../../shared/cli-permission-mode'
import { pickRandomAgentName } from '../../../../shared/agent-names'
import { lockedChatEngineOption, isModelDerivedChatName } from './agentChat/chatEngine'
import { EnginePickerChip } from '../workspace/agentComposer/enginePicker'
import type { CliRuntimeOption } from '../ui/CliModelPicker'
import { PermissionFooter, usePermissionModeOptions } from '../workspace/agentComposer/spawnFooter'
import {
  PRESET_CHIP_LABEL,
  agentPermissionChipLabel,
  selectedPermissionOption,
} from '../workspace/agentComposer/agentSpawnShared'
import { useAgentCliCatalogOptions } from '../workspace/agentComposer/useAgentComposer'
import { conversationCliRuntimesFor } from '../workspace/newWorkspace/cliRuntimeOptions'
import {
  parseStoredAttachments,
  readString,
  type TranscriptEntry,
  type UserTurn,
} from './agentChat/conversationProjection'
import { rememberSentAttachment } from './agentChat/storedAttachments'
import { deriveConversationTimelineRows } from './agentChat/conversationTimeline'
import { LOST_REQUEST, sendRecoveringSession, sessionWasLost } from './agentChat/sessionRecovery'
import {
  createConversationProjectionState,
  syncConversationProjection,
} from './agentChat/incrementalConversationProjection'
import { ConversationLinkProvider } from './agentChat/conversationLinks'
import { SubagentStopProvider, SubagentTypesProvider } from './agentChat/subagentStatus'
import { StopGlyph } from './agentChat/stopGlyph'
import { recalledConversationScroll, rememberConversationScroll } from './agentChat/conversationViewState'
import { chatResumesInTerminal, resumeChatInTerminal } from './agentChat/resumeInTerminal'
import { useConversationSession } from './agentChat/useConversationSession'
import { useChatViewActive } from './agentChat/chatViewActivity'
import { prefersReducedMotion } from './agentChat/reducedMotion'
import { useConversationTransport } from './agentChat/conversationTransport'
import { openCliSignInTerminal } from './agentChat/cliSignIn'
import { useLocalChatBinding, type ChatBinding } from './agentChat/chatBinding'
import { latestReplyTurnId } from './agentChat/turnFolds'
import { useComposerDraft, type ComposerDraftMetadata } from './agentChat/useComposerDraft'
import { useComposerRecall } from './agentChat/composerRecall'
import { ComposerField, type ComposerFieldHandle, type ComposerKeyEvent } from './agentChat/ComposerField'
import { ComposerContextChips, SkillContextChip, useComposerContextPicker } from './agentChat/composerContextPicker'
import { ComposerPlusMenu } from '../workspace/agentComposer/ComposerPlusMenu'
import { unwatchPullRequest, usePullRequestsOfConversation } from '../workspace/useConversationPullRequests'
import { useLocalServersOfConversation } from '../workspace/useLocalServers'
import { useCreatePullRequestState } from './agentChat/createPullRequest'
import { localPullRequestHost } from './agentChat/pullRequestHost'
import { conversationContextReading } from './agentChat/contextReading'
import type { ContextBreakdownSource } from './agentChat/ContextBreakdown'
import { ConversationComposerStrip } from './agentChat/conversationStrip'
import { useConversationStripFacts } from './agentChat/conversationStripFacts'
import { useUsageLimitSnapshot } from './agentChat/usageLimits'
import { UsageLimitResumeRow } from './agentChat/usageLimitResume'
import { ScheduledMessageRows } from './agentChat/scheduledMessages'
import type { ScheduledMessage } from '../../../../shared/scheduled-messages'
import { canScheduleMessages, updateScheduledMessage } from '../../store/scheduledMessagesStore'
import { SendTimeTag } from '../workspace/agentComposer/schedule/SendTimeEditor'
import { defaultSendAt } from '../workspace/agentComposer/schedule/sendTime'
import { usageLimitProviderOf } from '../../store/usageLimitsStore'
import { studioAppCommands, useConversationCommands } from './agentChat/useConversationCommands'
import { composerAppCommand } from './agentChat/composerAppCommands'
import { commandInsertText } from './agentChat/slashCommandMenu'
import { tokenOpensMessage } from '../../../../shared/conversation/composerTrigger'
import { useConversationSearchJump } from './agentChat/conversationSearchJump'
import { useTurnNavigation } from './agentChat/turnNavigation'
import { TimelineMinimap } from './agentChat/TimelineMinimap'
import {
  QUOTE_SELECTION_COMMAND,
  QuoteSelectionToolbar,
  insertQuoteIntoDraft,
  quoteSelectionInto,
} from './agentChat/quoteSelection'
import {
  forwardPasteToComposer,
  isEditableElement,
  shouldRedirectToComposer,
  typedCharacter,
} from './agentChat/typeToComposer'
import { pasteIntoComposer } from '../../utils/clipboardPasteBridge'

/** ⌘⌥⏎ in the composer: send, then New chat (see the registry). */
const SEND_AND_NEW_COMMAND = 'chat.sendAndNew'

/** System Settings on Privacy & Security › Files and Folders; says so when it would not open. */
function openMacosPrivacySettings(): void {
  void window.api
    .openExternal(MACOS_FILES_AND_FOLDERS_SETTINGS_URL)
    .then((result) => {
      if (!result.ok) showToast({ tone: 'error', title: 'System Settings did not open', description: result.message })
    })
    .catch((error: unknown) =>
      showToast({
        tone: 'error',
        title: 'System Settings did not open',
        description: error instanceof Error ? error.message : String(error),
      }),
    )
}
import { settleDisclosureResize, useStickToBottom } from './agentChat/useStickToBottom'
import { TRANSCRIPT_FOOT, TRANSCRIPT_SCROLL_PADDING_CLASS, TranscriptHead } from './agentChat/transcriptEnds'
import { ConversationRowFrame } from './agentChat/conversationRowFrame'
import {
  type ChatOpening,
  MAX_DIVIDER_PAGES,
  unreadDividerRowId,
  unseenFromTheTop,
  useChatOpening,
} from './agentChat/unreadDivider'
import { loadWholeConversation } from './agentChat/conversationReplay'
import { ConversationReplayView, type ConversationReplaySource } from './agentChat/conversationReplayView'
import { onChatReplayRequest, takeChatReplayRequest } from './agentChat/chatReplayRequests'
import { chatExportSupported, exportChatOrToast } from './agentChat/chatExport'
import type { ChatExportAction } from '../../../../shared/chat-export'
import { useConversationScrollRestore } from './agentChat/conversationScrollRestore'
import { useComposerSkillReader } from './agentChat/composerSkillReader'
import { nextConversationEffort } from './agentChat/conversationEffort'
import {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_TURN,
  attachmentRejection,
  readImageAttachment,
} from './agentChat/imageAttachments'
import { ConversationPendingDock, coversComposer, type ApprovalModeSwitch } from './agentChat/pendingDock'
import { QueuedTurnRow, queuedTurnSendNow } from './agentChat/queuedTurnBubble'
import { followUpSendPresentation, primaryClickModifier, resolveComposerDispatch } from './agentChat/followUpDispatch'
import { FollowUpSendButton } from './agentChat/FollowUpSendButton'
import { ComposerTray, ComposerTrayRow } from './agentChat/composerTray'
import { PROMPT_STASH_COMMAND, usePromptStash } from './agentChat/promptStashPicker'
import { BackgroundTasksTrayRow } from './agentChat/backgroundTasksRow'
import { GoalTrayRow } from './agentChat/goalTrayRow'
import { WorktreeInstallTrayRow } from './agentChat/worktreeInstallRow'
import { StudioConnectionNotice } from './agentChat/studioConnectionNotice'
import { ConversationTodoStrip } from './agentChat/todoProgressStrip'
import { TimelineRow, type TimelineChrome } from './agentChat/timelineRows'
import { UnreadDivider } from './agentChat/turnMeta'
import { editFromHereDraft, type EditFromHereDraft } from './agentChat/editFromHere'
import { forkChat, forkRemoteChat, takeForkedAttachments, type ForkFromHereTarget } from './agentChat/forkFromHere'
import { SideQuestionDrawer, useSideQuestion, type SideQuestionApi } from './agentChat/sideQuestion'
import { ReadinessState, readinessLabel, type ChatReadiness } from './agentChat/chatStates'
import { PendingFirstMessage } from './agentChat/pendingFirstMessage'
import { withRequestedTurn, type RequestedTurnRowCache } from './agentChat/requestedTurnRow'
import { ComposerActionButton, ComposerContextMenu, type ComposerMenuState } from './agentChat/composerControls'
export { ComposerContextMenu, editingShortcut } from './agentChat/composerControls'
export type { ComposerMenuState } from './agentChat/composerControls'

export { readinessLabel } from './agentChat/chatStates'
export type { ChatReadiness } from './agentChat/chatStates'

export { ResolvedDecisions, UserTimelineRow, WorkTimeline, isAuthShapedFailure } from './agentChat/timelineRows'
export { formatStepDuration } from './agentChat/stepDuration'

export { parseOptionLabel } from './agentChat/pendingDock'

export {
  ATTACHABLE_IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_EDGE,
  attachmentRejection,
  base64ByteLength,
  formatAttachmentBytes,
  isAttachableImageType,
  providerAcceptsImages,
  scaledImageDimensions,
  splitImageDataUrl,
} from './agentChat/imageAttachments'

export {
  activeConversationStage,
  deriveConversationTimelineRows,
  flattenToolEntries,
  groupResolvedDecisions,
  resolvedDecisionGroupLabel,
  subagentLaneLabel,
  toolObject,
  toolVerb,
} from './agentChat/conversationTimeline'
export type {
  ConversationApprovalEntry,
  ConversationDecisionRow,
  ConversationTimelineRow,
} from './agentChat/conversationTimeline'

export { projectConversation } from './agentChat/conversationProjection'
export type {
  ConversationProjection,
  TranscriptEntry,
  TranscriptToolEntry,
  UserTurn,
} from './agentChat/conversationProjection'
import { clientSupports, hostPlatform } from '../../clientCapabilities'
import { MACOS_FILES_AND_FOLDERS_SETTINGS_URL } from '../../../../shared/conversation/macosPrivacyFolders'
import { useFileDropTarget } from '../../hooks/useFileDropTarget'
import { ComposerDropOverlay } from './agentChat/ComposerDropOverlay'

import {
  composerSendAction,
  draftAfterRetried,
  isConversationBusy,
  queueComposerDraft,
  queuedDropNotice,
  restoreRefusedText,
  stopDisabledForPending,
  type PendingAction,
  type QueuedTurn,
} from './agentChat/composerQueue'
export {
  composerSendAction,
  draftAfterRetried,
  isConversationBusy,
  mergeQueuedTurn,
  queueComposerDraft,
  queuedTurnLabel,
  restoreRefusedText,
  stopDisabledForPending,
} from './agentChat/composerQueue'
import {
  chatPermissionRefusals,
  isConversationModelLocked,
  resolvePermissionMode,
  resolvePermissionPreset,
} from './agentChat/chatPermissions'
export {
  chatPermissionRefusals,
  isConversationModelLocked,
  resolvePermissionMode,
  resolvePermissionPreset,
} from './agentChat/chatPermissions'
import {
  MODEL_PICKER_TOGGLE_COMMAND,
  registerMountedChatView,
  SIDE_QUESTION_COMMAND,
} from './agentChat/mountedChatViews'
import { useChatFind } from './agentChat/useChatFind'
import { FindBar } from '../find/FindBar'
export {
  MODEL_PICKER_TOGGLE_COMMAND,
  registerMountedChatView,
  respondToModelPickerToggle,
} from './agentChat/mountedChatViews'
export type { MountedChatView } from './agentChat/mountedChatViews'
import { ContextWindowNotice } from './agentChat/ContextWindowNotice'
import { buildModelGroups } from './agentChat/modelGroups'
export { buildModelGroups } from './agentChat/modelGroups'
export type { ModelGroup } from './agentChat/modelGroups'

// The DataTransfer plumbing lives in utils/imageFileTransfer (shared with the
// new-chat launch surface); re-exported here because this module declared it
// first and the tests and seam read it from here.
export { dataTransferHasFiles }
// The staged-image strip and its helpers live in ComposerAttachmentStrip
// (shared with the new-chat launch surface, which must not import this panel);
// re-exported for the same reason.
export { attachmentCountLabel, attachmentPreviewUrl, ComposerAttachmentStrip, openAttachmentImage }

// What keeps the transcript at its end while the reader is there: a row added
// or growing, and the list itself resizing (a pane dragged, the composer tray
// growing). One path, not the list's plus an effect per token. While a turn
// streams the follow is instant: the last row grows on every flush, and a
// smooth follow restarts its glide each time, so the list would be in a
// smooth scroll — a frame and a scroll handler per display refresh — for the
// whole reply.
const END_FOLLOW_TRIGGERS = { dataChange: true, itemLayout: true, layout: true }

// Said on the composer when a settled chat's worktree could not be checked out
// again; the toast that came with it says why (chatWorktreeRestore.ts).
const WORKTREE_NOT_BACK = 'This chat’s worktree could not be brought back, so nothing can run in it.'

// What Retry sends when the failed turn answered news Studio brought the chat:
// the person asking the agent to carry on, in their own words, rather than the
// news repeated as though they were reporting it.
const RETRY_AFTER_STUDIO_NOTICE = 'Continue.'

// Stable empty-catalog reference: returned for any provider whose live catalog
// has not loaded so effects keyed on the derived list do not re-run each render.
const EMPTY_MODELS: ConversationProviderModel[] = []

// What a chat hands the skills picker for MCP servers: none — a chat reads
// skills only, and the picker is told not to list servers.
const NO_MCP_SERVERS: never[] = []
const ignoreMcpServers = (): void => undefined

// ── Component ───────────────────────────────────────────────────────────────

type Props = {
  workspaceId: string
  agentId: string
}

// The bordered/rounded surface and focus ring live on the composer container;
// the field itself is transparent and borderless so it reads as one piece with
// the footer control row beneath it. The container wears
// FOCUS_RING_WITHIN_EDITOR_CLASS, so the indicator here is the product's one
// ring — it used to be an accent border swap, a second idiom.
// The field is `ComposerField`, an editor that draws the draft's markdown in
// place; its ground, ink, placeholder tier and type are its own, and the bounds
// are the caller's — the same pair the new-chat composer uses.
// The box's own padding (`px-5 pb-1 pt-4`, the New chat composer's) is on the
// field's wrapper, so the field draws none. One row to start — a running chat's
// box should not take the transcript's room for an empty prompt — growing with
// its content to a ceiling, then scrolling.
const COMPOSER_CLASS = 'max-h-[280px] min-h-[40px] w-full'

// An error on the composer's line. Most are a sentence and nothing to redo — a
// refused image, a clipboard write, a search that lost its row. A send that did
// not go carries the send, so Retry repeats exactly that message and only
// appears when there is one to repeat.
type ComposerActionError = string | { message: string; retry: QueuedTurn }

// A message's words as the runtime records them: one kind of line break, no
// space at either end.
function steeredText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').trim()
}

function composerErrorMessage(error: ComposerActionError | null): string | null {
  return typeof error === 'string' ? error : (error?.message ?? null)
}

// No mode of the CLI's own: what a chat whose runtime names none offers.
const NO_MODES: readonly string[] = []

export default function AgentChatView({ workspaceId, agentId }: Props) {
  const binding = useLocalChatBinding(workspaceId, agentId)
  if (!binding)
    return (
      <ChatShell>
        <InlineNotice tone="error" className="mx-3 my-2">
          This agent has no conversation provider selected.
        </InlineNotice>
      </ChatShell>
    )
  return (
    <ConversationChatBody
      key={`${workspaceId}:${agentId}`}
      workspaceId={workspaceId}
      agentId={agentId}
      binding={binding}
    />
  )
}

/**
 * The chat view itself, over whichever transport the tree provides: the
 * conversation IPC here, or a paired machine's conversation over the Mesh.
 * `binding` is the agent it is for — a record in the store, or the fields a
 * remote pane keeps — and the transport's capabilities decide which controls
 * it offers.
 */
export function ConversationChatBody({ workspaceId, agentId, binding }: Props & { binding: ChatBinding }) {
  const transport = useConversationTransport()
  const agent = binding.agent
  const workspace = binding.workspace
  const updateBinding = binding.update
  // A conversation-runtime chat has no pty, so no `UserPromptSubmit` frame
  // reaches the sidebar's ordering clock the way a CLI's does. Sending a turn
  // is the same event, so it stamps the same clock here — without this these
  // chats would sit at their creation time for ever while every CLI chat moved.
  const recordUserMessage = binding.recordUserMessage
  const appCliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  // What Enter does while the agent works: queue the message, or steer the
  // turn with it (followUpDispatch.ts). Read alone, so a change elsewhere in
  // the settings does not render the chat again.
  const followUpBehavior = useWorkspaceStore((s) => s.appSettings.followUpBehavior)
  const hostSettings = useWorkspaceStore((s) => s.appSettings.hosts)
  // A chat in a workspace on a WSL machine runs that machine's `claude`. One
  // that records no machine runs where its folder defaults to, as the router
  // and Studio's git read it (owner ruling 2026-10-03).
  const workspaceHostId = workspace ? workspaceHostIdOf(workspace) : undefined
  const cliRuntimes = useMemo(
    () => conversationCliRuntimesFor(appCliRuntimes, workspaceHostId, hostSettings),
    [appCliRuntimes, workspaceHostId, hostSettings],
  )
  const conversation = agent.conversation
  const label = agent.name ?? agentId
  const workspaceRoot = binding.workspaceRoot
  const { operate } = transport.capabilities

  const [localReadiness, setReadiness] = useState<ChatReadiness>({ kind: 'loading' })
  // A transport that decides readiness itself (a remote link) replaces this
  // machine's provider check, which says nothing about a provider over there.
  const hostReadiness = binding.readiness
  const readiness = hostReadiness ?? localReadiness
  // A New chat whose worktree is being made has no folder yet, but its
  // provider does not need one: it is checked meanwhile, so the chat is ready
  // to start the moment the folder lands rather than checking only then.
  const awaitingWorktree = hostReadiness?.kind === 'preparing-worktree'
  const overridingReadiness = awaitingWorktree ? null : hostReadiness
  const hasRoot = Boolean(workspaceRoot) || awaitingWorktree
  const [providers, setProviders] = useState<ConversationProviderListEntry[]>([])
  // Live model catalogs keyed by providerId, fetched lazily as the user opens
  // the picker or filters to a provider — never a blanket prefetch. A non-empty
  // entry is preferred over the manifest seed.
  const [catalogByProvider, setCatalogByProvider] = useState<Record<string, ConversationProviderModel[]>>({})
  // Whether each provider has a configured key, fetched alongside its catalog.
  // Drives the explicit "add key" vs "no models" group state so a key-configured
  // provider never collapses into a silent stale seed.
  const [keyByProvider, setKeyByProvider] = useState<Record<string, boolean>>({})
  // The active provider's live catalog (stable ref per cache entry) feeds the
  // current-model label, context length, and the tab self-heal below.
  const liveModels = catalogByProvider[conversation?.providerId ?? ''] ?? EMPTY_MODELS
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  // The live session as the runtime last reported it — adopted on start and
  // re-adopted from every result that can change its preset, so the pill moves
  // when the provider accepts a change, never on an optimistic guess. The pill
  // reads the session's own preset first, then the agent record, then 'default'
  // (`resolvePermissionPreset`).
  const [session, setSession] = useState<ConversationSessionSummary | null>(binding.session ?? null)
  const hostSession = binding.session
  useEffect(() => {
    if (hostSession !== undefined) setSession(hostSession)
  }, [hostSession])
  const sessionId = session?.sessionId ?? null
  const providerEntry = providers.find((entry) => entry.id === conversation?.providerId)
  const capabilities = session?.capabilities ?? providerEntry?.capabilities
  const permissionPreset = resolvePermissionPreset(session, agent?.cliPermissionPreset)
  const permissionMode = resolvePermissionMode(session, agent)
  const mcpServerActions = capabilities?.mcpServerActions
  const supportsSkills =
    transport.capabilities.skills && capabilities?.skills !== undefined && capabilities.skills !== 'none'
  // The chat has no plan toggle: a turn goes out in the mode the agent is on,
  // which is the default unless a read-only ask was set for it.
  const conversationMode: 'default' | 'ask' = agent?.conversationMode === 'ask' ? 'ask' : 'default'
  const reasoningEffort = capabilities?.reasoningEfforts?.includes(agent?.conversationReasoningEffort ?? '')
    ? agent?.conversationReasoningEffort
    : undefined
  // The chat's root. Whether it can be seen decides whether streamed tokens
  // render now or wait until it is seen again.
  const shellRef = useRef<HTMLDivElement | null>(null)
  const viewActive = useChatViewActive(shellRef)
  const {
    events,
    hydrated,
    caughtUp,
    hasMore,
    beforeCursor,
    loadingEarlier,
    loadEarlier: fetchEarlier,
    error: historyError,
    replayThroughSeq,
    announcement,
  } = useConversationSession(binding.sessionRoot ?? workspaceRoot, workspaceId, agentId, { active: viewActive })
  const animatedRowIds = useRef(new Set<string>())
  const [userTurns, setUserTurns] = useState<UserTurn[]>([])
  const {
    draft,
    setDraft,
    draftMetadata: storedDraftMetadata,
    setDraftMetadata,
    flushDraft,
    persistenceError,
    beginDraftSend,
    finishDraftSend,
    clearDraft,
  } = useComposerDraft(workspaceId, agentId, '')
  const draftMetadata = useMemo<ComposerDraftMetadata>(
    () => ({
      mentions: storedDraftMetadata.mentions,
      skillIds: supportsSkills ? (agent?.conversationSkills ?? storedDraftMetadata.skillIds) : [],
      files: storedDraftMetadata.files,
    }),
    [
      storedDraftMetadata.mentions,
      storedDraftMetadata.skillIds,
      storedDraftMetadata.files,
      agent?.conversationSkills,
      supportsSkills,
    ],
  )
  const [composerCaret, setComposerCaret] = useState(draft.length)
  const [pickedSkills, setPickedSkills] = useState<Record<string, WorkspaceSkill>>({})
  const [pending, setPending] = useState<PendingAction>(null)
  // When the turn the person is waiting on was asked for: from then until it
  // ends, the transcript's working line counts from here, and stands under
  // the message before the agent has said anything (`withRequestedTurn`).
  const [turnRequestedAt, setTurnRequestedAt] = useState<number | null>(null)
  const sending = pending === 'starting' || pending === 'sending'
  // New chat's first message, still waiting to go, and when this view opened
  // on it: its working line counts from then, through the setup and the turn.
  const startupPending = Boolean(
    agent?.chatStartupPrompt || agent?.chatStartupImages?.length || agent?.chatStartupFiles?.length,
  )
  const [startupSince] = useState(() => Date.now())
  const startupHolding =
    startupPending &&
    (readiness.kind === 'ready' || readiness.kind === 'loading' || readiness.kind === 'preparing-worktree')
  const sendInFlightRef = useRef(false)
  // The ref's value as state, so what waits on a send (the queue's flush) runs
  // again once it settles; the ref stays the synchronous re-entry guard.
  const [sendInFlight, setSendInFlight] = useState(false)
  // Images staged for the next turn (D3/1774), in the order they were added.
  const [attachments, setAttachments] = useState<ConversationImageAttachment[]>([])
  // A fork made at one of the person's messages hands that message's images
  // to this composer, beside the text the draft store already gave it.
  useEffect(() => {
    const forked = takeForkedAttachments(workspaceId, agentId)
    if (forked.length) setAttachments((current) => [...forked, ...current].slice(0, MAX_ATTACHMENTS_PER_TURN))
  }, [workspaceId, agentId])
  // A pasted/dropped/picked image is being read and resampled. Held so the
  // strip can say so instead of looking like nothing happened on a large file.
  const [attachingCount, setAttachingCount] = useState(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // The "+" row's two handlers, stable so the row does not redraw with every
  // streamed token. The pick goes through a ref to `takePickedFiles`, set
  // further down where what a pick does is known.
  const openFilePicker = useCallback(() => fileInputRef.current?.click(), [])
  const takePickedFilesRef = useRef<(files: File[]) => void>(() => undefined)
  const onPickedFiles = useCallback((files: File[]) => takePickedFilesRef.current(files), [])
  const attachmentSeqRef = useRef(0)
  // Type-ahead queue (D6/1776): a message the user committed while the session
  // was busy. It holds until the turn unlocks, then auto-sends as a follow-up
  // turn. Null when nothing is queued; a second commit while busy appends so no
  // typed intent is dropped. Attachments ride the queue too — dropping them at
  // the queue boundary would silently lose what the user staged.
  const [queuedTurn, setQueuedTurn] = useState<QueuedTurn | null>(null)
  // When the draft is to be sent, picked from the "+" (Schedule); null sends
  // it as usual. While set, Enter and the send button schedule the draft
  // instead: main keeps it and sends it into this chat at that time, whether
  // or not this view is open then.
  const [sendAt, setSendAt] = useState<number | null>(null)
  // The local id of a queued message handed to the running turn (a steer),
  // until its own `user_message` arrives. One is delivered at a time, and the
  // queue holds its next message until then.
  const [steeringTurnId, setSteeringTurnId] = useState<string | null>(null)
  // Steers whose `user_message` is in the conversation while their send has
  // not settled yet.
  const landedSteerIdsRef = useRef(new Set<string>())
  // A steer to a chat on a paired machine has no echoed id to land by: its
  // words, and how many of the chat's messages were already in when it went,
  // are what its own message is known by when it arrives.
  const steerLandingRef = useRef<{ id: string; text: string; before: number } | null>(null)
  // The composer's right-click menu (1793); null when closed. Opening it snapshots
  // the click point, the field's selection, and the clipboard, so the menu's
  // enable states describe the moment the user asked for it.
  const [composerMenu, setComposerMenu] = useState<ComposerMenuState | null>(null)
  // Where the caret belongs after a menu edit rewrites the controlled draft.
  // Applied once the new value has rendered, so the caret lands in the edited
  // text instead of jumping to the end of it.
  const pendingCaretRef = useRef<number | null>(null)
  const [actionError, setActionError] = useState<ComposerActionError | null>(null)
  const skillReader = useComposerSkillReader(workspaceRoot)
  const listRef = useRef<LegendListRef | null>(null)
  const conversationKey = `${workspaceId}:${agentId}`
  const scrollMemoryRef = useRef(recalledConversationScroll(conversationKey))
  const firstVisibleRowRef = useRef<string | undefined>(scrollMemoryRef.current?.rowId)
  const pendingUserScrollIdRef = useRef<string | null>(null)
  const [anchoredUserId, setAnchoredUserId] = useState<string | null>(null)
  const chromeRef = useRef<TimelineChrome | null>(null)
  const composerRef = useRef<ComposerFieldHandle | null>(null)
  // The newest completed reply the reader has seen: the latest one whenever
  // they are at the end, and the latest the chat opened with until then. The
  // jump pill counts the replies completed after it while scrolled up — after
  // it in the transcript, so a page of older replies loaded above is not news.
  const replySeenRef = useRef<{ turnId: string | null } | null>(null)

  // Resolve provider/model/key readiness from the conversation IPC.
  useEffect(() => {
    let cancelled = false
    if (!conversation || overridingReadiness) return
    if (!hasRoot) {
      setReadiness({ kind: 'no-workspace-folder' })
      return
    }
    setReadiness({ kind: 'loading' })
    void (async () => {
      try {
        const list = await transport.services.providers.list({
          cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides,
        })
        if (cancelled) return
        if (!list.ok) {
          setReadiness({ kind: 'error', message: list.message })
          return
        }
        setProviders(list.providers)
        const provider = list.providers.find((entry) => entry.id === conversation.providerId)
        if (!provider) {
          setReadiness({ kind: 'provider-unavailable', providerId: conversation.providerId })
          return
        }
        // Listed but unable to start sessions (e.g. its CLI was not found):
        // surface the provider's own plain-language reason.
        if (provider.unavailable) {
          setReadiness({ kind: 'error', message: provider.unavailable })
          return
        }
        // Providers with a live catalog accept models not in the static seed, so
        // membership is only enforced for static-only providers.
        // An agent-harness provider is a CLI and takes whatever model id that CLI
        // takes (the picker offers the CLI's own list), exactly as the runtime's
        // start check does.
        if (
          !provider.supportsDynamicModels &&
          provider.providerType !== 'agent-harness' &&
          !provider.models.some((model) => model.id === conversation.modelId)
        ) {
          setReadiness({
            kind: 'model-unavailable',
            providerId: conversation.providerId,
            modelId: conversation.modelId,
          })
          return
        }
        const status = await transport.services.providers.secretStatus({ providerId: conversation.providerId })
        if (cancelled) return
        // A provider that declares no secret returns ok:false with that reason;
        // treat anything other than an explicit unconfigured key as ready.
        if (status.ok && !status.status.configured) {
          setReadiness({ kind: 'missing-key', providerId: conversation.providerId })
          return
        }
        setReadiness({ kind: 'ready' })
      } catch (err) {
        if (!cancelled)
          setReadiness({ kind: 'error', message: err instanceof Error ? err.message : 'Provider check failed.' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [conversation, hasRoot, cliRuntimes, overridingReadiness, transport])

  // Fetch one provider's live catalog and key status on demand, caching both.
  // Called for the active provider on mount and for whichever provider the user
  // filters to in the picker — never a blanket fan-out over every provider.
  // Failures are silent: the picker falls back to the manifest seed (unknown key
  // state) or its explicit empty state (known key state), never a stale list.
  const fetchProviderCatalog = useCallback(
    (providerId: string) => {
      if (!providerId) return
      void transport.services.providers
        .models({ providerId })
        .then((result) => {
          if (result.ok) setCatalogByProvider((current) => ({ ...current, [providerId]: result.models }))
        })
        .catch(() => undefined)
      void transport.services.providers
        .secretStatus({ providerId })
        .then((result) => {
          if (result.ok) setKeyByProvider((current) => ({ ...current, [providerId]: result.status.configured }))
        })
        .catch(() => undefined)
    },
    [transport],
  )

  // Fetch the active provider up front so the current model's display label,
  // context length, and readiness resolve before the picker is ever opened.
  // A model on another machine is that machine's catalog, not this one's: a
  // binding that names its engine brings the catalog with it.
  const modelSwitch = transport.capabilities.modelSwitch
  const hostEngine = binding.engine
  useEffect(() => {
    const providerId = conversation?.providerId
    if (providerId && modelSwitch && !hostEngine) fetchProviderCatalog(providerId)
  }, [conversation?.providerId, fetchProviderCatalog, modelSwitch, hostEngine])

  const projectionStateRef = useRef(createConversationProjectionState())
  const { projection, structureRevision } = useMemo(() => {
    const state = syncConversationProjection(projectionStateRef.current, events, userTurns)
    projectionStateRef.current = state
    return { projection: state.projection, structureRevision: state.structureRevision }
  }, [events, userTurns])
  // The transcript's shape — its turns, requests and messages — without the
  // words streaming into the latest reply. What is derived from the shape is
  // computed when it changes, not on every token.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shapeEntries = useMemo(() => projection.entries, [structureRevision])
  const shape = useMemo(() => transcriptShape(shapeEntries), [shapeEntries])

  // A sent picture's bytes stay with the local turn only until the transcript
  // has stored it: once its `user_message` names the stored copies, the bubble
  // reads them from the attachment store (seeded here, so it draws at once)
  // and the view stops holding up to 16 images' worth of base64 for as long as
  // it is open.
  useEffect(() => {
    if (!transport.attachment || !userTurns.some((turn) => turn.attachments?.length)) return
    const pending = new Map(userTurns.filter((turn) => turn.attachments?.length).map((turn) => [turn.id, turn]))
    const released = new Set<string>()
    // A sent message lands near the end of the log; how far back is looked is
    // bounded, so a send whose images were never stored costs little.
    const stop = Math.max(0, events.length - 2_000)
    for (let index = events.length - 1; index >= stop && released.size < pending.size; index--) {
      const event = events[index]!
      if (event.type !== 'user_message') continue
      const turn = pending.get(readString(event.payload, 'localTurnId') ?? '')
      const stored = parseStoredAttachments(event.payload?.attachments)
      if (!turn?.attachments || !stored || stored.length !== turn.attachments.length) continue
      stored.forEach((reference, position) => {
        const local = turn.attachments!.find((image) => image.id === reference.id) ?? turn.attachments![position]!
        rememberSentAttachment(reference.ref, local)
      })
      released.add(turn.id)
    }
    if (!released.size) return
    setUserTurns((current) =>
      current.map((turn) => {
        if (!released.has(turn.id)) return turn
        const { attachments: _sent, ...rest } = turn
        return rest
      }),
    )
    // Only a new message can land one: keyed on the transcript's shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureRevision, userTurns, transport])
  const previousRowsRef = useRef<ReturnType<typeof deriveConversationTimelineRows>>([])
  const requestedTurnRowRef = useRef<RequestedTurnRowCache>(null)
  const timelineRows = useMemo(() => {
    const rows = deriveConversationTimelineRows(projection.entries, projection.activeTurn, previousRowsRef.current)
    previousRowsRef.current = rows
    return withRequestedTurn(rows, turnRequestedAt, sending, requestedTurnRowRef)
  }, [projection.entries, projection.activeTurn, turnRequestedAt, sending])
  // The send has settled and no turn runs: the turn asked for has ended (or
  // never began), and its working line with it.
  useEffect(() => {
    if (turnRequestedAt !== null && pending === null && !projection.activeTurn) setTurnRequestedAt(null)
  }, [projection.activeTurn, turnRequestedAt, pending])
  // The "New" divider: where the replies the reader has not seen begin, as
  // they stood when the chat was opened (`unreadDivider.ts`). A chat followed
  // from another machine keeps its visit clock there, so only one here has a
  // divider.
  const opening = useChatOpening(transport.kind === 'local' ? workspaceId : null)
  const unreadRowId = useMemo(
    () => (opening ? unreadDividerRowId(timelineRows, opening, { historyAbove: hasMore }) : null),
    [timelineRows, opening, hasMore],
  )
  const unreadRowIndex = unreadRowId ? timelineRows.findIndex((row) => row.id === unreadRowId) : -1
  // This opening has a divider the chat has not landed on yet (the landing
  // below). A list mounting now starts there (`initialScrollIndex`) rather
  // than at the end or a remembered place and moving a frame later, and
  // neither the end-follow nor the restore of a remembered place takes it
  // anywhere else first.
  const [landedOpening, setLandedOpening] = useState<ChatOpening | null>(null)
  const landsAtDivider = opening !== null && landedOpening !== opening && unreadRowIndex >= 0
  // The replies nobody has seen run past the top of what is loaded: the one
  // the reader saw is further back. A few pages are read back to find it
  // before the opening lands; past them the divider stands at the top.
  const dividerPagesRef = useRef<{ opening: ChatOpening | null; pages: number }>({ opening: null, pages: 0 })
  if (dividerPagesRef.current.opening !== opening) dividerPagesRef.current = { opening, pages: 0 }
  const seeksSeenReply =
    opening !== null &&
    landedOpening !== opening &&
    hasMore &&
    dividerPagesRef.current.pages < MAX_DIVIDER_PAGES &&
    unseenFromTheTop(timelineRows, opening)
  const { handleRecallKeyDown, detachRecall } = useComposerRecall(shape.promptHistory, draft, setDraft)

  // A model switch made from a paired device reaches this window as the
  // session's own `session_updated` event naming the model. The agent record
  // follows it, so this chip — and a later resume, which starts on the record's
  // model — name the model the chat is on. Only an event after the replay
  // moves it, and each one once: a switch replayed from an earlier session is
  // history, and the record may have moved since.
  // Each render looks only at the events that arrived since the last one: the
  // scan stops at the newest number it has already read.
  //
  // The same scan finds the runtime moving the chat to another permission mode
  // on its own: a runtime that would not start under the chosen mode is
  // started with none, and says so. The chip follows the live session; the
  // agent record keeps the person's choice, so the next start tries it again.
  type LiveSessionScan = {
    replay: number
    through: number
    found: { id: string; modelId: string } | null
    preset: { id: string; sessionId: string; permissionPreset: CliPermissionPreset; permissionMode?: string } | null
  }
  const modelScanRef = useRef<LiveSessionScan>({ replay: -1, through: 0, found: null, preset: null })
  const liveSessionScan = useMemo(() => {
    if (!hydrated) return null
    const scan = modelScanRef.current
    if (scan.replay !== replayThroughSeq)
      modelScanRef.current = { replay: replayThroughSeq, through: replayThroughSeq, found: null, preset: null }
    const { through } = modelScanRef.current
    let found: LiveSessionScan['found'] = null
    let preset: LiveSessionScan['preset'] = null
    let newest = through
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!
      if (event.seq === undefined) continue
      if (event.seq <= through) break
      newest = Math.max(newest, event.seq)
      if (event.type !== 'session_updated') continue
      const modelId = event.payload?.modelId
      if (!found && typeof modelId === 'string' && modelId) found = { id: event.id, modelId }
      const permissionPreset = parseCliPermissionPreset(event.payload?.permissionPreset)
      const permissionMode = parseCliPermissionModeId(event.payload?.permissionMode) ?? undefined
      if (!preset && permissionPreset)
        preset = { id: event.id, sessionId: event.sessionId, permissionPreset, permissionMode }
    }
    modelScanRef.current = {
      ...modelScanRef.current,
      through: newest,
      found: found ?? modelScanRef.current.found,
      preset: preset ?? modelScanRef.current.preset,
    }
    return modelScanRef.current
  }, [events, hydrated, replayThroughSeq])
  const liveModelEvent = liveSessionScan?.found ?? null
  const livePresetEvent = liveSessionScan?.preset ?? null
  const appliedPresetEventRef = useRef<string | null>(null)
  useEffect(() => {
    if (!livePresetEvent || appliedPresetEventRef.current === livePresetEvent.id) return
    appliedPresetEventRef.current = livePresetEvent.id
    setSession((current) =>
      current && current.sessionId === livePresetEvent.sessionId
        ? {
            ...current,
            permissionPreset: livePresetEvent.permissionPreset,
            permissionMode: livePresetEvent.permissionMode,
          }
        : current,
    )
  }, [livePresetEvent])
  const appliedModelEventRef = useRef<string | null>(null)
  useEffect(() => {
    if (!liveModelEvent || appliedModelEventRef.current === liveModelEvent.id) return
    appliedModelEventRef.current = liveModelEvent.id
    if (transport.kind !== 'local' || !conversation || liveModelEvent.modelId === conversation.modelId) return
    updateBinding({ conversation: { providerId: conversation.providerId, modelId: liveModelEvent.modelId } })
  }, [liveModelEvent, transport.kind, conversation, updateBinding])

  // Follow the stream only while the user is at (or near) the bottom: reading
  // scrollback must never be yanked away by incoming tokens. A "jump to
  // latest" pill appears once they scroll up. Keyed on events.length so token
  // appends (which don't change the row count) also keep the view pinned.
  const { atBottom, atBottomRef, setAtBottom, observeScroll } = useStickToBottom(scrollMemoryRef.current?.atEnd ?? true)
  const loadEarlier = useCallback((): Promise<void> => {
    // Let the list preserve its visible row when a page is prepended, even if
    // the currently loaded page is short enough to also count as at the end.
    atBottomRef.current = false
    setAtBottom(false)
    return fetchEarlier()
  }, [fetchEarlier, atBottomRef, setAtBottom])
  const { flashRowId, clearFlash, searching, jumpToRow } = useConversationSearchJump({
    workspaceId,
    agentId,
    rows: timelineRows,
    hydrated,
    hasMore,
    loadingEarlier,
    loadEarlier,
    pauseFollowing: () => {
      atBottomRef.current = false
      setAtBottom(false)
    },
    scrollToRow: (index) => {
      // Tail padding is only needed for a newly sent prompt. Applying it to a
      // historical row pins every following row for measurement in the list.
      setAnchoredUserId(null)
      void listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: false })
    },
    reportError: setActionError,
  })
  const turnNavigation = useTurnNavigation({ rows: timelineRows, listRef, jumpToRow })
  const stepTurn = turnNavigation.step
  // Drawn again when the prompts move; the reader's place in them it follows
  // on its own, and a token changes neither.
  const minimap = useMemo(() => <TimelineMinimap navigation={turnNavigation} />, [turnNavigation])
  const { isRestoring: isRestoringScroll } = useConversationScrollRestore({
    memory: scrollMemoryRef.current,
    // Not on a kept chat's held transcript: the catch-up behind it may bring
    // a divider to land on instead of the place remembered.
    hydrated: caughtUp,
    searching,
    landsElsewhere: landsAtDivider,
    hasMore,
    loadingEarlier,
    rows: timelineRows,
    loadEarlier,
    scrollRoot: () => transcriptRef.current,
    // The remembered row is gone: open where a conversation opens anyway, and
    // follow it from there.
    fallbackToEnd: () => {
      void listRef.current?.scrollToEnd({ animated: false })
      atBottomRef.current = true
      setAtBottom(true)
    },
    restore: (index, offset) => {
      const list = listRef.current
      if (!list) return
      void list.scrollToIndex({ index, animated: false, viewPosition: 0 }).then(() => {
        if (listRef.current !== list) return
        const position = list.getState().positionAtIndex(index)
        if (position !== undefined) void list.scrollToOffset({ offset: position + offset, animated: false })
      })
    },
  })
  // End-follow is paused for the one frame a disclosure resizes its row. That
  // pause is not the reader leaving the end, so it must not show the pill.
  const [followPaused, setFollowPaused] = useState(false)
  const followPausedRef = useRef(false)
  // A scroll is read once a frame, however many events it fired: an animated
  // end-follow or a fling fires one per frame or more, and each read measures
  // the scroller.
  const scrollFrameRef = useRef(0)
  const lastScrollRef = useRef<NativeScrollEvent | null>(null)
  const readLogScroll = useCallback(() => {
    scrollFrameRef.current = 0
    const scrolled = lastScrollRef.current
    lastScrollRef.current = null
    if (!scrolled || followPausedRef.current) return
    const { contentOffset, contentSize, layoutMeasurement } = scrolled
    const element = listRef.current?.getScrollableNode()
    observeScroll(
      element?.scrollTop ?? contentOffset.y,
      element?.scrollHeight ?? contentSize.height,
      element?.clientHeight ?? layoutMeasurement.height,
    )
    // The restore's own jumps are not a place the reader chose; remembering
    // them would overwrite the position being restored.
    if (isRestoringScroll()) return
    // At the end, where the view opens again anyway, there is no row to find.
    if (atBottomRef.current) {
      rememberConversationScroll(conversationKey, { offset: 0, atEnd: true })
      return
    }
    const rowId = firstVisibleRowRef.current
    const position = rowId ? listRef.current?.getState().positionByKey(rowId) : undefined
    rememberConversationScroll(conversationKey, {
      rowId,
      offset: position === undefined ? contentOffset.y : Math.max(0, contentOffset.y - position),
      atEnd: false,
    })
  }, [conversationKey, observeScroll, atBottomRef, isRestoringScroll])
  const handleLogScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (followPausedRef.current) return
      lastScrollRef.current = event.nativeEvent
      if (scrollFrameRef.current) return
      if (typeof requestAnimationFrame === 'function') scrollFrameRef.current = requestAnimationFrame(readLogScroll)
      else readLogScroll()
    },
    [readLogScroll],
  )
  useEffect(() => () => cancelAnimationFrame(scrollFrameRef.current), [])
  const jumpToLatest = useCallback(() => {
    void listRef.current?.scrollToEnd({ animated: !prefersReducedMotion() })
    atBottomRef.current = true
    setAtBottom(true)
  }, [atBottomRef, setAtBottom])
  const preserveDisclosurePosition = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target instanceof Element ? event.target.closest('button[aria-expanded]') : null
      const row = target?.closest<HTMLElement>('[data-conversation-row-kind]')
      if (!row) return
      const top = row.getBoundingClientRect().top
      const wasFollowing = atBottomRef.current
      // Disable native end-follow before the disclosure changes its height.
      // Otherwise the resize can yank the control away from the pointer.
      atBottomRef.current = false
      followPausedRef.current = true
      flushSync(() => setFollowPaused(true))
      requestAnimationFrame(() => {
        // The disclosure suspends follow for its resize frame, not forever.
        // A user already reading scrollback remains there; one following the
        // end whose row opened past it is no longer there, and the pill says so.
        const scroller = listRef.current?.getScrollableNode()
        const following =
          row.isConnected && scroller ? settleDisclosureResize(row, top, scroller, wasFollowing) : wasFollowing
        atBottomRef.current = following
        followPausedRef.current = false
        setFollowPaused(false)
        if (wasFollowing && !following) setAtBottom(false)
      })
    },
    [atBottomRef, setAtBottom],
  )
  // A chat opened with replies its reader has not seen opens at the divider,
  // with what is new below it to read down into, instead of at the end: from
  // the end the reader would have to find where they left off by scrolling
  // back through it, and a place they left further up is older than what is
  // new. Once per opening; a search jump keeps its own. Ahead of the
  // end-follow below, which runs after it in the same commit and finds
  // `atBottomRef` already off.
  const openingRef = useRef(opening)
  useEffect(() => {
    openingRef.current = opening
  }, [opening])
  useEffect(() => {
    if (!opening || landedOpening === opening || !hydrated || seeksSeenReply) return
    const index = unreadRowIndex
    // A kept chat opened again draws what it held at once, and what was written
    // since arrives behind this join's fence: the reply nobody has seen may be
    // in that catch-up. Until it is in, no divider is not the answer yet, and
    // the opening waits for it rather than being spent on the end.
    if (index < 0 && !caughtUp) return
    setLandedOpening(opening)
    if (index < 0 || searching) return
    atBottomRef.current = false
    setAtBottom(false)
    setAnchoredUserId(null)
    // A list that mounted with this opening started at the divider; one
    // already mounted (a chat kept warm behind another) is moved there a
    // frame later, as a search jump lands. Not cancelled when the rows move
    // on — a streaming chat moves them every frame, and the landing happens
    // once — only skipped if the chat was left in the meantime.
    requestAnimationFrame(() => {
      if (openingRef.current !== opening) return
      void listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: false })
    })
  }, [opening, landedOpening, hydrated, caughtUp, seeksSeenReply, unreadRowIndex, searching, atBottomRef, setAtBottom])
  // The page back the divider waits for, one at a time.
  useEffect(() => {
    if (!seeksSeenReply || !caughtUp || loadingEarlier) return
    dividerPagesRef.current.pages += 1
    void fetchEarlier().catch(() => undefined)
  }, [seeksSeenReply, caughtUp, loadingEarlier, fetchEarlier])
  const followedInitialSnapshot = useRef(false)
  useEffect(() => {
    if (!hydrated) return
    const animate = followedInitialSnapshot.current
    followedInitialSnapshot.current = true
    if (atBottomRef.current) {
      void listRef.current?.scrollToEnd({
        animated: animate && !prefersReducedMotion(),
      })
    }
    // Not on every event: tokens grow the last row, and the list's own
    // end-follow keeps up with that. This lands the first snapshot at the
    // end, and follows a turn starting or ending and a row being added.
  }, [timelineRows.length, projection.activeTurn, hydrated, atBottomRef])
  useEffect(() => {
    const id = pendingUserScrollIdRef.current
    if (!id) return
    const index = timelineRows.findIndex((row) => row.id === id)
    if (index < 0) return
    pendingUserScrollIdRef.current = null
    setAnchoredUserId(id)
    atBottomRef.current = false
    void listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: false })
  }, [timelineRows, atBottomRef])

  // Surface turn failures (streamed via `turn_failed`) to the app Notifications
  // panel, deduped on the message so a single failure is logged once.
  const lastNotifiedErrorRef = useRef<string | null>(null)
  useEffect(() => {
    const message = projection.lastError
    // Clear on recovery so an identical error on a later turn notifies again.
    if (!message) {
      lastNotifiedErrorRef.current = null
      return
    }
    if (message === lastNotifiedErrorRef.current) return
    lastNotifiedErrorRef.current = message
    publishDiagnosticSync({
      level: 'error',
      source: 'workspace',
      title: `${label} turn failed`,
      message,
      ...(projection.lastErrorDetail && projection.lastErrorDetail !== message
        ? { details: projection.lastErrorDetail }
        : {}),
      workspaceId,
      workspaceName: workspace?.name,
      agentId,
    })
  }, [projection.lastError, projection.lastErrorDetail, label, workspaceId, workspace?.name, agentId])

  // Surface session/send action errors (start failure, missing key, IPC error)
  // the same way — these never reach the event stream.
  const lastNotifiedActionErrorRef = useRef<string | null>(null)
  const actionErrorMessage = composerErrorMessage(actionError)
  useEffect(() => {
    if (!actionErrorMessage || actionErrorMessage === lastNotifiedActionErrorRef.current) return
    lastNotifiedActionErrorRef.current = actionErrorMessage
    publishDiagnosticSync({
      level: 'error',
      source: 'workspace',
      title: `${label} could not start`,
      message: actionErrorMessage,
      workspaceId,
      workspaceName: workspace?.name,
      agentId,
    })
  }, [actionErrorMessage, label, workspaceId, workspace?.name, agentId])

  // A chat agent is named as a terminal agent is — from the shared pool — and
  // never after its model. A chat created before that rule wears its model's
  // label as its name ("Opus 5.5"); once this machine's model labels are known,
  // it is renamed the way an unnamed terminal agent is on load. A chat on
  // another machine is named there.
  const cliCatalogOptions = useAgentCliCatalogOptions()
  const derivedNameLabels = useMemo(() => {
    const labels = new Set<string>()
    for (const provider of providers)
      for (const model of provider.models) if (model.displayName) labels.add(model.displayName)
    for (const model of liveModels) if (model.displayName) labels.add(model.displayName)
    for (const option of cliCatalogOptions)
      for (const model of option.modelSelection?.options ?? []) if (model.label) labels.add(model.label)
    return labels
  }, [providers, liveModels, cliCatalogOptions])
  const renamedFromModelRef = useRef(false)
  useEffect(() => {
    if (!conversation || !workspace || renamedFromModelRef.current || providers.length === 0) return
    if (!isModelDerivedChatName(agent?.name, conversation.modelId, derivedNameLabels)) return
    renamedFromModelRef.current = true
    // The other agents' names as they are now: read once, here, rather than
    // drawn from, so the chat does not redraw with every agent it sits beside.
    const agents = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === workspace.id)?.agents
    updateBinding({
      name: pickRandomAgentName(
        Object.entries(agents ?? {})
          .filter(([id]) => id !== agentId)
          .map(([, other]) => other.name),
      ),
    })
  }, [conversation, workspace, providers.length, agent?.name, derivedNameLabels, agentId, updateBinding])

  // Start the chat's session: before its first send, and again when the one
  // this view held is gone (its server restarted under an open window), which
  // resumes it from its transcript as an app restart does.
  const startSession = useCallback(async (): Promise<
    { ok: true; sessionId: string } | { ok: false; message: string } | null
  > => {
    if (!conversation || !workspaceRoot || !transport.capabilities.startSession || !transport.startSession) return null
    try {
      if (!(await ensureChatWorktree(workspaceId))) return { ok: false, message: WORKTREE_NOT_BACK }
      const result = await transport.startSession({
        workspaceRoot,
        workspaceId,
        agentId,
        providerId: conversation.providerId,
        modelId: conversation.modelId,
        cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides,
        // The spawn picker's preset, stamped on the agent record at spawn and
        // editable from the composer's permission pill until the first turn. No
        // hardcoded 'default' here: an agent spawned as Bypass starts as Bypass.
        permissionPreset,
        ...(permissionMode ? { permissionMode } : {}),
      })
      if (!result.ok) return { ok: false, message: result.message }
      setSession(result.session)
      return { ok: true, sessionId: result.session.sessionId }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Could not start the conversation.' }
    }
  }, [agentId, cliRuntimes, conversation, permissionMode, permissionPreset, workspaceId, workspaceRoot, transport])
  const ensureSession = useCallback(async (): Promise<string | null> => {
    // A settled chat whose worktree the cleanup gave back has it checked out
    // again before a turn runs in it (chatWorktreeRestore.ts) — including a
    // turn on the session this view still holds, which main respawns from
    // its suspended state in the chat's folder.
    if (!(await ensureChatWorktree(workspaceId))) {
      setActionError(WORKTREE_NOT_BACK)
      return null
    }
    if (sessionId) return sessionId
    const started = await startSession()
    if (!started) return null
    if (!started.ok) {
      setActionError(started.message)
      return null
    }
    return started.sessionId
  }, [sessionId, startSession, workspaceId])
  // The session this view holds is gone where it ran: forget it, so the next
  // send starts the chat's session again. A view that cannot start a session
  // (a paired machine's chat) keeps the one it has.
  const forgetLostSession = useCallback(
    (result: { ok: boolean; code?: unknown; message?: unknown }): boolean => {
      if (!transport.capabilities.startSession || !sessionWasLost(result)) return false
      setSession(null)
      return true
    },
    [transport],
  )

  // Change the tool-permission preset. The agent record is the durable seed (it
  // starts the next session and survives a remount), so it is written first; a
  // live session additionally gets the change pushed to its running query and
  // reports back the preset it now holds, which is what the pill reads. A
  // provider that refuses (no live-change support, or Claude Code declining)
  // rolls the record back and surfaces its own message — the pill never shows a
  // preset the session is not actually on. An accepted change the provider
  // cannot apply to the turn already streaming comes back with a `notice`: the
  // preset IS recorded, so the pill moves and the sentence says when it starts
  // applying (1808).
  const [permissionChanging, setPermissionChanging] = useState(false)
  const [permissionNotice, setPermissionNotice] = useState<string | null>(null)
  // A mode of the CLI's own rides beside its preset (Claude Code's Accept edits
  // at Auto); the record keeps both, and a preset's own mode clears the mode.
  const changePermissionPreset = useCallback(
    async (next: CliPermissionPreset, nextMode?: string) => {
      if ((next === permissionPreset && nextMode === permissionMode) || permissionChanging) return
      setActionError(null)
      setPermissionNotice(null)
      const previous = { cliPermissionPreset: agent?.cliPermissionPreset, cliPermissionMode: agent?.cliPermissionMode }
      updateBinding({ cliPermissionPreset: next, cliPermissionMode: nextMode })
      if (!sessionId) return
      setPermissionChanging(true)
      try {
        const answered = await transport.setPermissionPreset({
          sessionId,
          permissionPreset: next,
          ...(nextMode ? { permissionMode: nextMode } : {}),
        })
        // No session there any more: the record carries the preset, and the
        // next session starts on it.
        if (forgetLostSession(answered)) return
        // A remote command answers without a session: the preset it accepted
        // is the one now in force over there, on the session this pane holds.
        const result = answered.ok
          ? {
              ...answered,
              session: answered.session ?? { ...session!, permissionPreset: next, permissionMode: nextMode },
            }
          : answered
        if (result.ok) {
          setSession(result.session)
          setPermissionNotice(result.notice ?? null)
        } else {
          updateBinding(previous)
          setActionError(result.message)
        }
      } catch (err) {
        updateBinding(previous)
        setActionError(err instanceof Error ? err.message : 'Could not change tool permissions.')
      } finally {
        setPermissionChanging(false)
      }
    },
    [
      agent?.cliPermissionMode,
      agent?.cliPermissionPreset,
      permissionChanging,
      permissionMode,
      permissionPreset,
      session,
      sessionId,
      updateBinding,
      transport,
      forgetLostSession,
    ],
  )

  // Send one turn. A turn needs text or at least one image — the runtime accepts
  // an image-only turn, so the composer does too.
  const sendTurn = useCallback(
    async (
      message: string,
      turnAttachments: ConversationImageAttachment[] = [],
      requestedMetadata: ComposerDraftMetadata = { skillIds: [], mentions: [], files: [] },
      fromDraft = false,
      // A message the person already let go of (the queued turn, flushed when
      // the agent went idle) goes back ahead of whatever they typed since.
      // Anything else refused (the startup prompt, Retry, Compact) lands in
      // the composer only when it is empty, so a draft never grows a prefix.
      restoreAhead = false,
      // The message is already on screen as the chat's pending first bubble
      // (PendingFirstMessage): its row takes that one's place where it stands,
      // without the entrance a new row plays, which read as the bubble jumping.
      inPlace = false,
    ) => {
      const metadata = supportsSkills ? requestedMetadata : { ...requestedMetadata, skillIds: [] }
      const text = message.trim()
      // The files attached by path travel beside the words, as a list: main
      // tells the agent where each is, the bubble draws them as cards, and
      // the text stays what the person typed.
      const files = attachedFilesOf(metadata.files)
      const putBack = (current: string) => (restoreAhead ? restoreRefusedText(current, text) : current || text)
      if (
        (!text &&
          turnAttachments.length === 0 &&
          metadata.mentions.length === 0 &&
          metadata.skillIds.length === 0 &&
          files.length === 0) ||
        pending ||
        sendInFlightRef.current
      )
        return
      sendInFlightRef.current = true
      setSendInFlight(true)
      setActionError(null)
      // A "from the next turn" notice is spent once that turn leaves.
      setPermissionNotice(null)
      setPending('starting')
      // The first message waited out the chat's setup under a working line
      // that began when the chat opened; the turn's carries on from there.
      setTurnRequestedAt(inPlace ? startupSince : Date.now())
      const localTurnId = `user-${userTurns.length}-${Date.now()}`
      // An optimistic bubble only where the runtime echoes its id back on the
      // `user_message` that replaces it. A remote send has no such id, so its
      // bubble is the host's own event, a moment later. It goes up before the
      // session is made sure of: a chat's first message otherwise waited out
      // its CLI starting before it showed at all.
      if (transport.capabilities.optimisticTurns) {
        pendingUserScrollIdRef.current = `user:${localTurnId}`
        if (inPlace) animatedRowIds.current.add(`user:${localTurnId}`)
        setUserTurns((current) => [
          ...current,
          {
            id: localTurnId,
            text,
            createdAt: Date.now(),
            mentions: metadata.mentions,
            ...(files.length > 0 ? { files } : {}),
            skills: metadata.skillIds,
            ...(turnAttachments.length > 0 ? { attachments: turnAttachments } : {}),
          },
        ])
      }
      const activeSession = await ensureSession()
      const thisSend = { text, attachments: turnAttachments, metadata }
      if (!activeSession) {
        // The turn never left: its bubble comes down with the text going back.
        setUserTurns((current) => current.filter((turn) => turn.id !== localTurnId))
        setTurnRequestedAt(null)
        if (pendingUserScrollIdRef.current === `user:${localTurnId}`) pendingUserScrollIdRef.current = null
        // The session's own failure is already on the line; it is this send's.
        setActionError((current) => {
          const message = composerErrorMessage(current)
          return message ? { message, retry: thisSend } : current
        })
        sendInFlightRef.current = false
        setSendInFlight(false)
        setPending(null)
        if (!fromDraft) {
          setDraft(putBack)
          setDraftMetadata((current) => ({
            skillIds: [...new Set([...metadata.skillIds, ...current.skillIds])],
            mentions: [...metadata.mentions, ...current.mentions],
            files: [...new Set([...metadata.files, ...current.files])],
          }))
        }
        // The turn never left, so hand the staged images back rather than make
        // the user re-attach them — unless they already staged new ones.
        if (turnAttachments.length > 0) {
          setAttachments((current) => (current.length === 0 ? turnAttachments : current))
        }
        return
      }
      const draftSend = fromDraft ? beginDraftSend(message) : null
      setPending('sending')
      recordUserMessage?.(Date.now())
      try {
        const result = await sendRecoveringSession({
          sessionId: activeSession,
          send: (onSession) =>
            transport.send({
              sessionId: onSession,
              message: text,
              localTurnId,
              skills: metadata.skillIds.map((id) => ({ id })),
              mentions: metadata.mentions,
              ...(files.length > 0 ? { files } : {}),
              mode: conversationMode,
              reasoningEffort,
              ...(turnAttachments.length > 0 ? { attachments: turnAttachments } : {}),
            }),
          restart: async () => {
            // A view that cannot start one (a paired machine's chat) keeps the one it has.
            if (!transport.capabilities.startSession) return null
            setSession(null)
            return startSession()
          },
        })
        finishDraftSend(draftSend, result.ok)
        // A failed send keeps the mode and effort the user chose. Rolling them
        // back would quietly turn a plan-mode resend into one that can write.
        if (!result.ok) {
          setActionError({ message: result.message, retry: thisSend })
          setUserTurns((current) => current.filter((turn) => turn.id !== localTurnId))
          setTurnRequestedAt(null)
          if (turnAttachments.length) setAttachments((current) => (current.length ? current : turnAttachments))
          if (!fromDraft) {
            setDraft(putBack)
            setDraftMetadata((current) => ({
              skillIds: [...new Set([...metadata.skillIds, ...current.skillIds])],
              mentions: [...metadata.mentions, ...current.mentions],
              files: [...new Set([...metadata.files, ...current.files])],
            }))
          }
        }
      } catch (err) {
        finishDraftSend(draftSend, false)
        setUserTurns((current) => current.filter((turn) => turn.id !== localTurnId))
        setTurnRequestedAt(null)
        if (!fromDraft) {
          setDraft(putBack)
          setDraftMetadata((current) => ({
            skillIds: [...new Set([...metadata.skillIds, ...current.skillIds])],
            mentions: [...metadata.mentions, ...current.mentions],
            files: [...new Set([...metadata.files, ...current.files])],
          }))
        }
        if (turnAttachments.length) setAttachments((current) => (current.length ? current : turnAttachments))
        setActionError({
          message: err instanceof Error ? err.message : 'Could not send the message.',
          retry: thisSend,
        })
      } finally {
        sendInFlightRef.current = false
        setSendInFlight(false)
        setPending(null)
      }
    },
    [
      ensureSession,
      startSession,
      pending,
      recordUserMessage,
      startupSince,
      userTurns.length,
      transport,
      conversationMode,
      reasoningEffort,
      supportsSkills,
      beginDraftSend,
      finishDraftSend,
      setDraft,
      setDraftMetadata,
    ],
  )

  // Set further down, once the model picker and effort control it drives are
  // known; answers whether it handled the message.
  const runAppCommandRef = useRef<(text: string, attachments: number) => boolean>(() => false)
  // Set further down, once the chat's identity and draft are in hand: hands
  // the draft to main to send at `sendAt`.
  const scheduleDraftRef = useRef<() => Promise<void>>(async () => undefined)
  // A chat on another machine that holds its own queue (`hostQueue`): a
  // message queued while its turn runs is handed to that machine at once, and
  // that machine sends it when the turn ends, so it goes even if this one is
  // asleep or closed by then (owner report 2026-10-08). Only words are handed
  // over, as that machine keeps nothing else for later: a message with images
  // waits here and goes with them when the turn ends, as before. And only
  // while the queue here is empty: a message refused there waits here, and
  // what follows it joins it here, so one message is never split between the
  // two machines.
  const hostQueue = transport.capabilities.hostQueue && transport.queue ? (binding.hostQueue ?? null) : null
  // Messages on their way to that machine, until it answers that it holds them.
  const [handingOff, setHandingOff] = useState<string[]>([])
  // The held messages an Edit is taking back, so a second click asks once.
  const takingBackRef = useRef(new Set<string>())
  const handToHost = useCallback(
    async (text: string): Promise<boolean> => {
      const queue = transport.queue
      if (!queue) return false
      setHandingOff((current) => [...current, text])
      let result: { ok: true } | { ok: false; message: string }
      try {
        result = await queue({ message: text })
      } catch (err) {
        result = { ok: false, message: err instanceof Error ? err.message : 'The message did not reach it.' }
      }
      setHandingOff((current) => {
        const index = current.indexOf(text)
        return index < 0 ? current : [...current.slice(0, index), ...current.slice(index + 1)]
      })
      if (result.ok) return true
      // Not held there: it waits here, as every queued message did before,
      // ahead of anything queued since — never lost.
      const turn: QueuedTurn = { text, attachments: [], metadata: { skillIds: [], mentions: [], files: [] } }
      setQueuedTurn((current) =>
        current ? queueComposerDraft(turn, current.text, current.attachments, current.metadata).turn : turn,
      )
      const machine = transport.machineName ?? 'The other machine'
      setActionError(
        `${machine} could not hold the message (${result.message.replace(/\.$/u, '')}). It waits here, and goes when the turn ends while this machine is awake.`,
      )
      return false
    },
    [transport],
  )
  // Whether a commit while the turn runs is handed to the machine running the chat.
  const handsQueueToHost =
    hostQueue !== null &&
    queuedTurn === null &&
    attachments.length === 0 &&
    !draftMetadata.mentions.length &&
    !draftMetadata.skillIds.length &&
    !draftMetadata.files.length

  // What "send it now" does for the queued message: a steer where both the
  // transport and the provider take one, else stop the turn and let the queue
  // send it the moment the session is free.
  const canSteer = transport.capabilities.steer && capabilities?.steer === true
  const queuedSendNow = queuedTurnSendNow({
    canSteer,
    activeTurn: projection.activeTurn,
    awaitingApproval: projection.awaitingApproval,
    stopping: pending === 'stopping',
    steering: steeringTurnId !== null,
  })
  // Whether a message committed now may go into the turn, or stop it, rather
  // than wait for it: the person's choice decides which only while this holds.
  const sendNowAvailable = operate && !queuedSendNow.disabled
  // Set further down, beside the "Send now" it shares with the queued row.
  const steerTurnRef = useRef<(turn: QueuedTurn) => Promise<void>>(async () => undefined)

  // Composer submit (Enter or the send affordance). Sends immediately when the
  // session is idle. While a turn runs the message queues by default, where it
  // stays in sight: the flush effect below sends it the moment the session
  // unlocks. Handing every mid-turn Enter straight to the turn lost messages
  // the running turn never took in, with nothing left in the queue to show for
  // them, so a steer is always a choice: the person's, in Settings ▸ Agents,
  // or for one message by Primary+Enter (`commitComposerNow`). A steer the
  // turn cannot take now queues instead, and one the runtime refuses goes back
  // to the queue, so a message is never lost to the race with the turn's end.
  const commitDraft = useCallback(
    (forceQueue: boolean): boolean => {
      const text = draft.trim()
      // Typed while a New chat is still setting up, before its first message
      // has gone: queued behind it, as a reply typed while a turn runs is. Any
      // other chat that cannot send yet keeps the words where they are.
      if (readiness.kind !== 'ready') {
        if (!startupHolding || (!text && attachments.length === 0 && !draftMetadata.files.length)) return false
        const { turn, dropped } = queueComposerDraft(queuedTurn, text, attachments, draftMetadata)
        setQueuedTurn(turn)
        clearDraft()
        setAttachments([])
        setActionError(queuedDropNotice(dropped))
        return true
      }
      if (
        !text &&
        attachments.length === 0 &&
        !draftMetadata.mentions.length &&
        !draftMetadata.skillIds.length &&
        !draftMetadata.files.length
      )
        return false
      // A time is picked: the draft is scheduled, whatever the turn is doing.
      if (sendAt !== null) {
        void scheduleDraftRef.current()
        return true
      }
      // A command Studio answers itself, or one it will not send, is handled
      // here whatever the turn is doing: it never reaches the CLI or the queue.
      if (runAppCommandRef.current(text, attachments.length + draftMetadata.files.length)) return true
      if (isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending) || steeringTurnId !== null) {
        const dispatch = forceQueue
          ? 'queue'
          : resolveComposerDispatch({
              busy: true,
              behavior: followUpBehavior,
              alternate: false,
              canSteer,
              sendNowAvailable,
            })
        if (dispatch === 'steer') {
          // The draft alone: a message already queued keeps its place.
          const { turn, dropped } = queueComposerDraft(null, text, attachments, draftMetadata)
          clearDraft()
          setAttachments([])
          setActionError(queuedDropNotice(dropped))
          void steerTurnRef.current(turn)
          return true
        }
        if (handsQueueToHost && text) {
          clearDraft()
          setActionError(null)
          void handToHost(text)
          return true
        }
        // The cap is the IPC boundary's; trimming to it is right, hiding the trim
        // is not — the user must know which images did not make the queue.
        const { turn, dropped } = queueComposerDraft(queuedTurn, text, attachments, draftMetadata)
        setQueuedTurn(turn)
        clearDraft()
        setAttachments([])
        setActionError(queuedDropNotice(dropped))
        return true
      }
      void sendTurn(text, attachments, draftMetadata, true)
      setAttachments([])
      return true
    },
    [
      readiness.kind,
      startupHolding,
      attachments,
      draft,
      draftMetadata,
      clearDraft,
      projection.activeTurn,
      projection.awaitingApproval,
      pending,
      queuedTurn,
      steeringTurnId,
      sendTurn,
      sendAt,
      handsQueueToHost,
      handToHost,
      followUpBehavior,
      canSteer,
      sendNowAvailable,
    ],
  )
  const submitComposer = useCallback((): boolean => commitDraft(false), [commitDraft])
  // The draft to the queue, whatever Enter would do with it: Primary+Enter's
  // commit where Steer is the person's choice.
  const submitQueued = () => commitDraft(true)

  // Open the composer's right-click menu (1793). The clipboard read is awaited
  // before opening so Paste is never offered against an empty clipboard, and the
  // pointer/selection state is captured before it, because the event's target is
  // released once the handler returns. The menu key (Shift+F10) raises the same
  // event and is the keyboard path in; when it reports no pointer, the menu opens
  // at the field instead of the viewport corner.
  const openComposerMenu = useCallback(async (event: MouseEvent, field: ComposerFieldHandle) => {
    event.preventDefault()
    const rect = field.getBoundingClientRect()
    const keyboardInvoked = event.clientX === 0 && event.clientY === 0
    const x = keyboardInvoked ? rect.left : event.clientX
    const y = keyboardInvoked ? rect.bottom : event.clientY
    const selectionStart = field.selectionStart ?? 0
    const selectionEnd = field.selectionEnd ?? selectionStart
    const clipboardText = await readClipboardText()
    setComposerMenu({ x, y, selectionStart, selectionEnd, clipboardText })
  }, [])

  // Replace the menu's captured selection with `text` ('' for a plain cut) and
  // put the caret after what was inserted.
  const replaceComposerSelection = useCallback(
    (menu: Pick<ComposerMenuState, 'selectionStart' | 'selectionEnd'>, text: string) => {
      setDraft((current) => current.slice(0, menu.selectionStart) + text + current.slice(menu.selectionEnd))
      pendingCaretRef.current = menu.selectionStart + text.length
    },
    [setDraft],
  )

  // Apply the caret position a menu edit asked for, once the rewritten draft has
  // rendered. Focus comes back to the field so the user can keep typing.
  useEffect(() => {
    const caret = pendingCaretRef.current
    if (caret === null) return
    pendingCaretRef.current = null
    const field = composerRef.current
    if (!field) return
    field.focus()
    field.setSelectionRange(caret, caret)
  }, [draft])

  // Auto-send the queued message as a follow-up turn once the session idles.
  // Gated on the same busy signal the submit uses, so it never races the guard;
  // sendTurn's own `pending` guard prevents a re-entrant double send.
  useEffect(() => {
    if (queuedTurn === null || readiness.kind !== 'ready') return
    // New chat's first message goes first; what was queued behind it waits for its turn.
    if (startupPending) return
    if (isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending)) return
    // A steer still on its way counts as the turn: the send that it closed
    // settles before the turn it opened is on screen.
    if (steeringTurnId !== null) return
    // "Stop and send" can see the turn end before the send that started it
    // settles; sendTurn would refuse the message then, and it would be lost.
    if (sendInFlight || sendInFlightRef.current) return
    const { text, attachments: queuedAttachments, metadata } = queuedTurn
    setQueuedTurn(null)
    void sendTurn(text, queuedAttachments, metadata, false, true)
  }, [
    queuedTurn,
    readiness.kind,
    startupPending,
    projection.activeTurn,
    projection.awaitingApproval,
    pending,
    steeringTurnId,
    sendInFlight,
    sendTurn,
  ])

  // The launcher's prompt is this chat's first message: Enter there starts the
  // agent on what was typed, as a terminal agent's startup prompt does, so it is
  // sent here the moment the provider is ready and the history has loaded —
  // never left in the composer for a second Enter. One-shot: the record is
  // cleared before the send, so a remount cannot send it twice. A chat whose
  // provider cannot start keeps the text as its draft instead of dropping it.
  //
  // The launcher's images go with it as images, read from the files it holds
  // them in and prepared the way a pasted path's are, so the first message
  // carries them exactly as a later one does. A provider that reads no images
  // is given their paths after the text instead, as a terminal agent is; an
  // image that cannot be read leaves the text as the draft, with the reason.
  const startupPrompt = agent?.chatStartupPrompt
  const startupImages = agent?.chatStartupImages
  // The files New chat attached by path go with it as this chat's own send
  // would carry them: beside the words, drawn as cards in its first bubble.
  const startupFiles = agent?.chatStartupFiles
  const startupTakesImages =
    readiness.kind === 'ready' && capabilities?.images === true && transport.capabilities.imageAttachments
  const startupHandledRef = useRef(false)
  // A New chat still waiting on its worktree holds the message (it has no
  // root, so no history to hydrate); one whose worktree could not be made
  // gives it back to the composer, as a chat whose provider cannot start does.
  const worktreeFailed = readiness.kind === 'worktree-failed'
  useEffect(() => {
    if (
      (!startupPrompt && !startupImages?.length && !startupFiles?.length) ||
      startupHandledRef.current ||
      (!hydrated && !worktreeFailed)
    )
      return
    if (readiness.kind === 'loading' || readiness.kind === 'preparing-worktree') return
    startupHandledRef.current = true
    updateBinding({ chatStartupPrompt: undefined, chatStartupImages: undefined, chatStartupFiles: undefined })
    const started = userTurns.length > 0 || shape.hasUserMessage
    if (started) return
    const text = startupPrompt ?? ''
    const paths = startupImages ?? []
    // The message carries the launcher's own files. The draft is not part of
    // it: a chat that waited on its worktree took type-ahead, whose mentions
    // and files stay with the words they were typed with.
    const metadata = { skillIds: [], mentions: [], files: startupFiles ?? [] }
    // Left as the draft, the files are its cards again, and the message goes
    // back ahead of anything typed while the chat waited.
    const keepAsDraft = (words: string) => {
      setDraft((current) => restoreRefusedText(current, words))
      if (startupFiles?.length)
        setDraftMetadata((current) => ({ ...current, files: [...new Set([...startupFiles, ...current.files])] }))
    }
    if (!startupTakesImages) {
      const withPaths = [text, ...paths.map(quotePromptPath)].filter(Boolean).join(' ')
      if (readiness.kind !== 'ready') keepAsDraft(withPaths)
      else void sendTurn(withPaths, [], metadata, false, false, true)
      return
    }
    if (paths.length === 0) {
      void sendTurn(text, [], metadata, false, false, true)
      return
    }
    void (async () => {
      setAttachingCount((count) => count + paths.length)
      let failure: string | null = null
      const turnAttachments: ConversationImageAttachment[] = []
      try {
        const read = await readPastedImagePaths(paths)
        if (!read.ok) failure = read.message
        else
          for (const file of read.files) {
            attachmentSeqRef.current += 1
            turnAttachments.push(await readImageAttachment(file, `att-${attachmentSeqRef.current}-${Date.now()}`))
          }
      } catch (err) {
        failure = err instanceof Error ? err.message : 'That image could not be attached.'
      } finally {
        setAttachingCount((count) => Math.max(0, count - paths.length))
      }
      if (failure) {
        keepAsDraft(text)
        setActionError(failure)
        return
      }
      void sendTurn(text, turnAttachments, metadata, false, false, true)
    })()
  }, [
    startupPrompt,
    startupImages,
    startupFiles,
    startupTakesImages,
    hydrated,
    worktreeFailed,
    readiness.kind,
    userTurns.length,
    shape.hasUserMessage,
    sendTurn,
    setDraft,
    setDraftMetadata,
    updateBinding,
  ])

  // A reply queued behind a New chat's first message, whose worktree then
  // could not be made: the first message is back in the composer, and the
  // reply follows it there rather than going ahead of it on the next send.
  useEffect(() => {
    if (readiness.kind !== 'worktree-failed' || !queuedTurn) return
    setQueuedTurn(null)
    setDraft((current) => [current, queuedTurn.text].filter(Boolean).join('\n'))
    setDraftMetadata((current) => ({
      skillIds: [...new Set([...current.skillIds, ...queuedTurn.metadata.skillIds])],
      mentions: [...current.mentions, ...queuedTurn.metadata.mentions],
      files: [...new Set([...current.files, ...queuedTurn.metadata.files])],
    }))
    setAttachments((current) => [...current, ...queuedTurn.attachments].slice(0, MAX_ATTACHMENTS_PER_TURN))
  }, [readiness.kind, queuedTurn, setDraft, setDraftMetadata])

  // Stage images for the next turn. Each file is read and resampled on its own
  // so one unreadable file never drops the rest of a multi-image paste; the
  // first refusal is what the composer reports, and the rest still attach.
  const attachFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return
      let firstError: string | null = null
      // Refuse on type and count first, so the "Reading N images…" state counts
      // only what is actually being read.
      const readable: File[] = []
      for (const file of files) {
        const rejection = attachmentRejection(file, attachments.length + readable.length)
        if (rejection) firstError ??= rejection
        else readable.push(file)
      }
      if (readable.length === 0) {
        setActionError(firstError)
        return
      }

      const accepted: ConversationImageAttachment[] = []
      setAttachingCount((count) => count + readable.length)
      try {
        for (const file of readable) {
          attachmentSeqRef.current += 1
          try {
            accepted.push(await readImageAttachment(file, `att-${attachmentSeqRef.current}-${Date.now()}`))
          } catch (err) {
            firstError ??= err instanceof Error ? err.message : 'That image could not be attached.'
          }
        }
      } finally {
        setAttachingCount((count) => Math.max(0, count - readable.length))
      }
      // The slice is the invariant, not the user-facing rule: the per-file check
      // above already reported the cap, this only holds it under overlapping
      // batches (a paste landing while a drop is still reading).
      if (accepted.length > 0) {
        setAttachments((current) => [...current, ...accepted].slice(0, MAX_ATTACHMENTS_PER_TURN))
      }
      setActionError(firstError)
    },
    [attachments.length],
  )

  // Attach the images a pasted list of paths names, reading them now — the
  // file may be a screenshot's temporary copy that is gone minutes later. A
  // paste that cannot be read is put back as the text it was, at the caret it
  // was pasted at, with the reason on the composer's error line.
  const attachPastedPaths = async (paths: string[], text: string, selectionStart: number, selectionEnd: number) => {
    setAttachingCount((count) => count + paths.length)
    let read: Awaited<ReturnType<typeof readPastedImagePaths>>
    try {
      read = await readPastedImagePaths(paths)
    } finally {
      setAttachingCount((count) => Math.max(0, count - paths.length))
    }
    if (read.ok) {
      await attachFiles(read.files)
      return
    }
    setDraft((current) => current.slice(0, selectionStart) + text + current.slice(selectionEnd))
    pendingCaretRef.current = selectionStart + text.length
    setActionError(read.message)
  }

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((entry) => entry.id !== id))
  }, [])

  // Approval/question cards resolve mid-turn on stateful providers — while the
  // sendTurn promise is still pending — so they get their own busy latch
  // instead of the composer's `pending` (which would deadlock the card: the
  // turn cannot finish until the card is answered).
  const [respondingRequestId, setRespondingRequestId] = useState<string | null>(null)
  const resolveApproval = useCallback(
    async (
      requestId: string,
      approved: boolean,
      answers?: Record<string, string>,
      decision?: ConversationApprovalDecision,
    ) => {
      if (!sessionId || respondingRequestId) return
      setActionError(null)
      setRespondingRequestId(requestId)
      try {
        const result = await transport.respond({
          sessionId,
          requestId,
          approved,
          answers,
          decision,
        })
        if (!result.ok) setActionError(forgetLostSession(result) ? LOST_REQUEST : result.message)
        else if (
          approved &&
          shapeEntries.some(
            (entry) => entry.kind === 'approval' && entry.requestId === requestId && entry.requestKind === 'plan',
          )
        ) {
          updateBinding({ conversationMode: 'default' })
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not record the approval.')
      } finally {
        setRespondingRequestId(null)
      }
    },
    [sessionId, respondingRequestId, shapeEntries, updateBinding, transport, forgetLostSession],
  )

  // "Allow and switch to …" on a permission card: this request is allowed
  // once, and only then does the chat move to the looser mode, which answers
  // the requests still waiting that it covers. The order keeps the person's
  // own answer theirs — the switch never answers, or relabels, the card they
  // clicked — and a refused allow (the request was already answered) leaves
  // the mode where it was.
  const approveAndSwitchMode = useCallback(
    async (requestId: string, next: CliPermissionPreset) => {
      if (!sessionId || respondingRequestId) return
      setActionError(null)
      setRespondingRequestId(requestId)
      let allowed = false
      try {
        const result = await transport.respond({ sessionId, requestId, approved: true, decision: 'once' })
        if (result.ok) allowed = true
        else setActionError(forgetLostSession(result) ? LOST_REQUEST : result.message)
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Could not record the approval.')
      } finally {
        setRespondingRequestId(null)
      }
      if (allowed) await changePermissionPreset(next)
    },
    [sessionId, respondingRequestId, transport, changePermissionPreset, forgetLostSession],
  )

  const interrupt = useCallback(async () => {
    if (!sessionId || pending === 'stopping') return
    setPending('stopping')
    try {
      const result = await transport.interrupt({ sessionId })
      // A session that is gone has nothing running to stop.
      if (!result.ok && !forgetLostSession(result)) setActionError(result.message)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not interrupt the turn.')
    } finally {
      setPending(null)
    }
  }, [sessionId, pending, transport, forgetLostSession])

  // One agent stopped from its lane, leaving the chat and its turn running.
  // The lane ends when the agent reports it stopped; a refusal is said where
  // every other action's is.
  const stopSubagentEnabled =
    operate && capabilities?.stopSubagent === true && typeof transport.stopSubagent === 'function'
  const stopSubagent = useMemo(
    () =>
      stopSubagentEnabled && sessionId
        ? async (toolUseId: string): Promise<boolean> => {
            try {
              const result = await transport.stopSubagent!({ sessionId, toolUseId })
              if (!result.ok && !forgetLostSession(result)) setActionError(result.message)
              return result.ok
            } catch (err) {
              setActionError(err instanceof Error ? err.message : 'Could not stop the agent.')
              return false
            }
          }
        : null,
    [stopSubagentEnabled, sessionId, transport, forgetLostSession],
  )

  // A side question (sideQuestion.tsx), asked of the chat's session — started
  // first when this view holds none, as a send starts it — and kept out of the
  // chat. The session a question went to is remembered by its id, so closing
  // the drawer calls it off there; one closed before its session started is
  // never asked.
  const sideQuestionEnabled =
    operate &&
    capabilities?.sideQuestion === true &&
    typeof transport.askSideQuestion === 'function' &&
    typeof transport.cancelSideQuestion === 'function'
  // Held across the API's renewals: starting the session for a question
  // renews it, and the drawer's close must still find where that one went.
  const sideQuestionsAsked = useRef(new Map<string, string>())
  const sideQuestionsCalledOff = useRef(new Set<string>())
  const sideQuestionApi = useMemo<SideQuestionApi | null>(() => {
    if (!sideQuestionEnabled) return null
    const askedOf = sideQuestionsAsked.current
    const calledOff = sideQuestionsCalledOff.current
    return {
      async ask({ requestId, question, history }) {
        const started = await ensureSession()
        if (calledOff.delete(requestId))
          return { ok: false, cancelled: true, message: 'The side question was called off.' }
        if (!started) return { ok: false, message: 'The chat could not be started to answer it.' }
        askedOf.set(requestId, started)
        try {
          const result = await transport.askSideQuestion!({
            sessionId: started,
            requestId,
            question,
            ...(history.length ? { history } : {}),
          })
          if (!result.ok && !result.cancelled && forgetLostSession(result))
            return { ok: false, message: 'The chat’s session ended. Ask again to start it.' }
          return result
        } finally {
          askedOf.delete(requestId)
        }
      },
      cancel(requestId) {
        const asked = askedOf.get(requestId)
        if (!asked) {
          calledOff.add(requestId)
          return
        }
        void transport.cancelSideQuestion!({ sessionId: asked, requestId }).catch(() => undefined)
      },
    }
  }, [sideQuestionEnabled, ensureSession, transport, forgetLostSession])
  const sideQuestion = useSideQuestion(sideQuestionApi)
  // Whether it opened: a chat with no reply yet has nothing to ask about.
  const openSideQuestionRef = useRef<(question?: string) => boolean>(() => false)

  // Send a queued message into the running turn (a steer). It skips sendTurn's
  // `pending` latch on purpose: that latch belongs to the send whose turn is
  // running, which settles only when this one takes the turn over. The bubble
  // is optimistic as any send's is, and lands where the runtime delivered it.
  // A refused steer goes back to the head of the queue, so it still goes when
  // the turn ends rather than being lost.
  const putBackQueued = (turn: QueuedTurn) => {
    setQueuedTurn((current) => {
      if (!current) return turn
      return queueComposerDraft(turn, current.text, current.attachments, current.metadata).turn
    })
  }
  const steerTurn = async (turn: QueuedTurn) => {
    // The queue was emptied to hand this message over; with no session to
    // take it, it goes back rather than vanishing.
    if (!sessionId) {
      putBackQueued(turn)
      return
    }
    const metadata = supportsSkills ? turn.metadata : { ...turn.metadata, skillIds: [] }
    const text = turn.text.trim()
    const files = attachedFilesOf(metadata.files)
    const localTurnId = `user-${userTurns.length}-${Date.now()}`
    // An optimistic bubble only where the runtime echoes its id back, as for
    // any send: a paired machine's chat draws the message from its own event.
    const optimistic = transport.capabilities.optimisticTurns
    setActionError(null)
    setSteeringTurnId(localTurnId)
    steerLandingRef.current = optimistic
      ? null
      : {
          id: localTurnId,
          text: steeredText(text),
          before: shapeEntries.filter((entry) => entry.kind === 'user' && entry.seq !== undefined).length,
        }
    if (optimistic) {
      pendingUserScrollIdRef.current = `user:${localTurnId}`
      setUserTurns((current) => [
        ...current,
        {
          id: localTurnId,
          text,
          createdAt: Date.now(),
          mentions: metadata.mentions,
          ...(files.length > 0 ? { files } : {}),
          skills: metadata.skillIds,
          ...(turn.attachments.length > 0 ? { attachments: turn.attachments } : {}),
        },
      ])
    }
    recordUserMessage?.(Date.now())
    // The send settles only when the turn the steer opened does, so a failure
    // can arrive after the message was already written to the conversation.
    // Queueing that one again would send it twice; only a message that never
    // landed goes back to the head of the queue. Where the landing cannot be
    // seen (no echoed id: a paired machine, which holds a steer its turn
    // could not take for the turn's end itself), a refused one goes back to
    // the composer instead, for the person to send again or not.
    const requeue = (message: string) => {
      setActionError(message)
      if (landedSteerIdsRef.current.has(localTurnId)) return
      if (!optimistic) {
        setDraft((current) => restoreRefusedText(current, turn.text))
        setDraftMetadata((current) => ({
          skillIds: [...new Set([...turn.metadata.skillIds, ...current.skillIds])],
          mentions: [...turn.metadata.mentions, ...current.mentions],
          files: [...new Set([...turn.metadata.files, ...current.files])],
        }))
        if (turn.attachments.length)
          setAttachments((current) => [...turn.attachments, ...current].slice(0, MAX_ATTACHMENTS_PER_TURN))
        return
      }
      setUserTurns((current) => current.filter((entry) => entry.id !== localTurnId))
      putBackQueued(turn)
    }
    try {
      const result = await transport.send({
        sessionId,
        message: text,
        localTurnId,
        skills: metadata.skillIds.map((id) => ({ id })),
        mentions: metadata.mentions,
        ...(files.length > 0 ? { files } : {}),
        mode: conversationMode,
        reasoningEffort,
        ...(turn.attachments.length > 0 ? { attachments: turn.attachments } : {}),
        steer: true,
      })
      if (!result.ok) {
        forgetLostSession(result)
        requeue(result.message)
      }
    } catch (err) {
      requeue(err instanceof Error ? err.message : 'Could not send the message.')
    } finally {
      landedSteerIdsRef.current.delete(localTurnId)
      if (steerLandingRef.current?.id === localTurnId) steerLandingRef.current = null
      setSteeringTurnId((current) => (current === localTurnId ? null : current))
    }
  }
  steerTurnRef.current = steerTurn

  // The steer is delivered once its own `user_message` replaces the optimistic
  // bubble; the queue may hand over the next one from then on. The id is kept
  // until its send settles, so a late failure knows the message is already in.
  useEffect(() => {
    if (steeringTurnId === null) return
    const landing = steerLandingRef.current?.id === steeringTurnId ? steerLandingRef.current : null
    const landed = landing
      ? shapeEntries
          .filter((entry) => entry.kind === 'user' && entry.seq !== undefined)
          .slice(landing.before)
          .some((entry) => entry.kind === 'user' && steeredText(entry.text) === landing.text)
      : shapeEntries.some((entry) => entry.kind === 'user' && entry.id === steeringTurnId && entry.seq !== undefined)
    if (!landed) return
    landedSteerIdsRef.current.add(steeringTurnId)
    setSteeringTurnId(null)
  }, [steeringTurnId, shapeEntries])

  const sendQueuedNow = (turn: QueuedTurn) => {
    if (queuedSendNow.disabled || !operate) {
      setQueuedTurn(turn)
      return
    }
    if (queuedSendNow.kind === 'steer') {
      setQueuedTurn(null)
      void steerTurn(turn)
      return
    }
    setQueuedTurn(turn)
    void interrupt()
  }

  // "Stop and send" for a message the machine running the chat holds, where
  // that machine takes no steer: it sends what it holds once the turn ends,
  // so stopping the turn is all that is asked of it from here.
  const stopForHostQueue = () => {
    if (queuedSendNow.disabled || !operate) return
    void interrupt()
  }
  // "Send now" for a message that machine holds. Where it takes a steer the
  // message is taken back from what it holds and steered into the turn, which
  // goes on, its agents with it; a steer the turn cannot take is held there
  // again, as any is. The row says "Send now" then, so it must not stop the
  // turn (owner report 2026-10-24: a held message sent now ended the turn and
  // the helper it was running). Elsewhere it is Stop and send.
  const sendHostQueuedNow = (message: MeshQueuedMessage | undefined) => {
    if (!message || queuedSendNow.disabled || !operate) return
    if (queuedSendNow.kind === 'steer' && transport.cancelQueued) void steerHostQueued(message)
    else stopForHostQueue()
  }
  const steerHostQueued = async (message: MeshQueuedMessage) => {
    if (!transport.cancelQueued || takingBackRef.current.has(message.id)) return
    takingBackRef.current.add(message.id)
    try {
      const result = await transport.cancelQueued({ queuedId: message.id })
      if (!result.ok) {
        setActionError(result.message)
        return
      }
      await steerTurn({ text: message.text, attachments: [], metadata: { skillIds: [], mentions: [], files: [] } })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The message could not be sent now.')
    } finally {
      takingBackRef.current.delete(message.id)
    }
  }
  // Edit on a message that machine holds: taken back there first, so it cannot
  // go as well as come back here. One already on its way stays where it is,
  // and the refusal says so.
  const takeBackHostQueued = async (message: MeshQueuedMessage) => {
    if (!transport.cancelQueued || takingBackRef.current.has(message.id)) return
    takingBackRef.current.add(message.id)
    try {
      const result = await transport.cancelQueued({ queuedId: message.id })
      if (!result.ok) {
        setActionError(result.message)
        return
      }
      setDraft((current) => [message.text, current].filter(Boolean).join('\n'))
      composerRef.current?.focus()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'The message could not be taken back.')
    } finally {
      takingBackRef.current.delete(message.id)
    }
  }

  // ⌘↵ / Ctrl+↵ (and a Primary-click on send): the other of what Enter does
  // while the agent works. Idle, that is an ordinary send. With Steer chosen,
  // the draft queues. Otherwise the draft joins the queue and the queue goes
  // at once: steered into the turn, or, where the provider cannot take it,
  // sent once the turn is stopped. With nothing typed, the queue goes now.
  const commitComposerNow = () => {
    // A time is picked: ⌘↵ schedules, as Enter does.
    if (sendAt !== null) {
      submitComposer()
      return
    }
    if (!isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending) && steeringTurnId === null) {
      submitComposer()
      return
    }
    const text = draft.trim()
    const hasDraft =
      text.length > 0 ||
      attachments.length > 0 ||
      draftMetadata.mentions.length > 0 ||
      draftMetadata.skillIds.length > 0 ||
      draftMetadata.files.length > 0
    const dispatch = resolveComposerDispatch({
      busy: true,
      behavior: followUpBehavior,
      alternate: true,
      canSteer,
      sendNowAvailable,
    })
    if (hasDraft && dispatch === 'queue') {
      submitQueued()
      return
    }
    if (!hasDraft) {
      if (queuedTurn) sendQueuedNow(queuedTurn)
      // What the machine running the chat holds goes now as its row's Send
      // now sends it: steered in, or the turn stopped where it takes no steer.
      else sendHostQueuedNow(hostQueue?.messages.find((message) => message.failure === undefined))
      return
    }
    // Held by the machine running the chat, then let go by stopping its turn.
    // A steer goes into that turn instead, through the queue below.
    if (handsQueueToHost && text && dispatch !== 'steer') {
      clearDraft()
      setActionError(null)
      void handToHost(text).then((held) => {
        if (held) stopForHostQueue()
      })
      return
    }
    const { turn, dropped } = queueComposerDraft(queuedTurn, text, attachments, draftMetadata)
    clearDraft()
    setAttachments([])
    setActionError(queuedDropNotice(dropped))
    sendQueuedNow(turn)
  }
  // Esc stops a running turn, as it does in an agent CLI's own terminal. It
  // gets here only once the composer's pickers and prompt recall have passed
  // it on, and never while a menu is open over the composer or text in the
  // transcript is selected: there Esc belongs to what is showing. Nor while a
  // request waits in the dock: the turn is paused on the person's answer, Esc
  // reads there as "no", and a stop would throw away the turn it was asked in.
  const stopsTurnOnEscape = (event: ComposerKeyEvent): boolean => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return false
    if (!projection.activeTurn || !operate || stopDisabledForPending(pending)) return false
    if (modelMenuOpen || composerMenu) return false
    if (shape.pendingApprovals.length > 0) return false
    return !window.getSelection()?.toString().trim()
  }
  const sendNowShortcutLabel = renderKeybinding(
    'Primary+Enter',
    window.api.platform === 'darwin' ? 'darwin' : window.api.platform === 'win32' ? 'windows' : 'linux',
  )

  // Retry re-sends the last user message. The projection's entries are the
  // authoritative source — after an app restart the message only exists in the
  // replayed transcript, not in the local userTurns state. Its images are read
  // back from the store the transcript names them in, as Edit from here does:
  // a stored message carries refs rather than the bytes, and an image-only
  // message would otherwise retry as nothing at all.
  //
  // When that message was Studio's own, the retry is the person asking the
  // agent to carry on, and goes as theirs: a window cannot send as Studio, and
  // repeating Studio's name in front would tell the agent Studio was speaking
  // when the person was. A resume after a usage limit already is that ask, so
  // its words go without the name. A launched agent's news is not: sent as the
  // person's, it would have them reporting what another agent did, so its
  // retry is the plain ask to carry on.
  const retryLatestRef = useRef<() => Promise<void>>(async () => undefined)
  retryLatestRef.current = async () => {
    const lastUser = [...projection.entries]
      .reverse()
      .find((entry): entry is Extract<TranscriptEntry, { kind: 'user' }> => entry.kind === 'user')
    if (!lastUser) return
    if (lastUser.origin && lastUser.origin.reason !== 'usage-resume') {
      void sendTurn(RETRY_AFTER_STUDIO_NOTICE)
      return
    }
    const message = await editFromHereDraft(lastUser, transport)
    void sendTurn(lastUser.origin ? withoutStudioNoticePrefix(message.text) : message.text, message.attachments, {
      skillIds: message.skills,
      mentions: message.mentions,
      files: message.files,
    })
  }
  const retry = useCallback(() => void retryLatestRef.current(), [])
  // The composer's Retry repeats the send that failed. A failed send hands its
  // message back to the composer, so when the composer still holds it the retry
  // goes from there and empties it, as the first attempt did; edited since, the
  // message goes as it was sent and the edit stays. The images handed back go
  // with the retry either way, so they leave the composer: left there, the next
  // send would upload them a second time.
  const failedSend = typeof actionError === 'object' ? (actionError?.retry ?? null) : null
  const retryFailedSend = () => {
    if (!failedSend) return
    const fromDraft = draft.trim() === failedSend.text
    // Put back ahead of what was typed since, it goes out from here once, and
    // the typed rest stays; left in, the next Enter sent it a second time.
    const rest = fromDraft ? null : draftAfterRetried(draft, failedSend.text)
    if (rest !== null) setDraft(rest)
    void sendTurn(failedSend.text, failedSend.attachments, failedSend.metadata, fromDraft, rest !== null)
    setAttachments((current) => (current === failedSend.attachments ? [] : current))
  }
  // Only this machine's chats on a CLI Studio can open a sign-in for (Claude
  // Code, Kimi Code) sign in through it; a paired machine's chat would need
  // signing in over there.
  // A chat on an SSH machine signs in there, whichever CLI it runs (phase 8).
  // With the SSH machines preview off, such a chat has nowhere to sign in:
  // this computer's CLI is not the one the chat runs.
  const machineId = useWorkspaceStore((state) => {
    const environment = state.workspaces.find((workspace) => workspace.id === workspaceId)?.environment
    return environment?.kind === 'ssh' ? environment.id : null
  })
  const sshMachinesOn = window.api?.sshMachinesEnabled === true
  const signInProviderId =
    transport.kind === 'local' &&
    (!machineId || sshMachinesOn) &&
    (machineId
      ? cliForConversationProvider(conversation?.providerId)
      : conversationSignIn(cliForConversationProvider(conversation?.providerId)))
      ? conversation?.providerId
      : undefined
  const signIn = useCallback(async () => {
    if (!signInProviderId) return
    try {
      const result = await openCliSignInTerminal({
        workspaceId,
        providerId: signInProviderId,
        cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides,
        machineId,
      })
      if (!result.ok) setActionError(result.message)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not open the sign-in terminal.')
    }
  }, [signInProviderId, workspaceId, cliRuntimes, machineId])
  const onSignIn = signInProviderId ? signIn : undefined

  // "Edit from here" went back to before a message: it returns to the
  // composer ahead of anything already typed there, with what it carried.
  const restoreDraftRef = useRef<(draft: EditFromHereDraft) => void>(() => undefined)
  restoreDraftRef.current = (restored) => {
    setDraft((current) => [restored.text, current].filter(Boolean).join('\n\n'))
    setDraftMetadata({
      // The files the message carried come back as their cards.
      files: [...new Set([...restored.files, ...draftMetadata.files])],
      skillIds: [...new Set([...restored.skills, ...draftMetadata.skillIds])],
      mentions: [
        ...restored.mentions,
        ...draftMetadata.mentions.filter(
          (mention) => !restored.mentions.some((kept) => kept.path === mention.path && kept.kind === mention.kind),
        ),
      ],
    })
    setAttachments((current) => [...restored.attachments, ...current].slice(0, MAX_ATTACHMENTS_PER_TURN))
    composerRef.current?.focus()
  }
  const restoreDraft = useCallback((draft: EditFromHereDraft) => restoreDraftRef.current(draft), [])

  const ready = readiness.kind === 'ready'
  // The launcher's message, not sent yet but on its way: drawn as the bubble
  // it will be, with what it waits on, until the send puts up its own.
  const startupWaiting = startupHolding
  // The session cannot take a live turn right now (streaming, awaiting approval,
  // or an in-flight send). A submit made while busy queues instead of erroring.
  const composerBusy =
    isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending) || steeringTurnId !== null
  // Retry and other "act now" affordances stay disabled while busy or not ready.
  const composerDisabled = !ready || composerBusy
  // The textarea itself is only disabled before the provider is ready — it stays
  // editable through a stream so type-ahead works (D6/1776). A New chat waiting
  // on its worktree takes type-ahead too, and one whose worktree failed holds
  // the message it gave back: neither can send (Send and Enter wait on ready).
  const composerInputDisabled =
    !ready && !startupHolding && readiness.kind !== 'preparing-worktree' && readiness.kind !== 'worktree-failed'
  // While the agent works the send queues or steers, by the person's choice,
  // and a Primary-click does the other: the button, Enter and the menu's
  // Send all read it from here.
  const followUpPresentation = followUpSendPresentation({
    behavior: followUpBehavior,
    canSteer,
    sendNowAvailable,
    ...(queuedSendNow.reason ? { unavailableReason: queuedSendNow.reason } : {}),
    clickModifier: primaryClickModifier(window.api?.platform),
    shortcutLabel: sendNowShortcutLabel,
  })
  // One rule for both send affordances — the footer button and the right-click
  // menu's Send item (1793) — so they can never label or gate a commit
  // differently from each other or from Enter.
  // A New chat setting up reads as a chat at work: a message queues behind its first.
  const sendAction = composerSendAction({
    ready: ready || startupHolding,
    busy: composerBusy || startupHolding,
    sending,
    hasText: draft.trim().length > 0 || draftMetadata.mentions.length > 0 || draftMetadata.skillIds.length > 0,
    attachmentCount: attachments.length + draftMetadata.files.length,
    busyLabel: followUpPresentation.labels[followUpPresentation.action],
  })

  // The runtime binds a session to one provider/model, so the model is editable
  // only until the conversation starts: once a turn is sent, a session exists,
  // or replayed history is present, the pill is read-only and the user opens a
  // new agent to change model.
  // A provider that declares `liveModelSwitch` takes a new model mid-chat
  // (from the next turn), so its picker never locks; any other provider binds
  // a session to its model and the picker locks once the chat has started.
  const liveModelSwitch = capabilities?.liveModelSwitch === true && typeof transport.setModel === 'function'
  const modelLocked =
    !modelSwitch || (!liveModelSwitch && isConversationModelLocked(userTurns.length, sessionId, shape.hasConversation))
  const modelGroups = buildModelGroups(providers, catalogByProvider, keyByProvider)
  const currentModel = modelGroups
    .find((group) => group.providerId === conversation.providerId)
    ?.models.find((model) => model.id === conversation.modelId)
  // The engine chip: the terminal agent's picker, locked to this chat's CLI.
  // The rail shows that CLI alone and the list is its own models (only the
  // chat's model once it has started); effort and permissions sit on the
  // picker's trailing row exactly as they do for a terminal launch.
  // A chat on another machine brings that machine's row for its CLI.
  const chatCli = hostEngine?.value ?? cliForConversationProvider(conversation.providerId)
  const chatModel = conversation.modelId === CONVERSATION_DEFAULT_MODEL_ID ? undefined : conversation.modelId
  const chatCliOption: CliRuntimeOption | null = chatCli
    ? (hostEngine ??
      cliCatalogOptions.find((option) => option.value === chatCli) ?? {
        value: chatCli,
        label: providerEntry?.displayName ?? chatCli,
      })
    : null
  const chatPickerOptions = chatCliOption
    ? [modelLocked ? lockedChatEngineOption(chatCliOption, chatModel) : chatCliOption]
    : []
  const chatModelLabel = chatCliOption
    ? (chatCliOption.modelSelection?.options.find((option) => option.id === chatModel)?.label ??
      chatModel ??
      chatCliOption.label)
    : null
  const currentModelLabel = chatModelLabel ?? currentModel?.displayName ?? conversation.modelId
  // How full the context window is: the runtime's own report first, then the
  // CLI model catalog's window for this chat's model, then a provider
  // catalog's context length (contextReading.ts). The strip's ring and the
  // tray's nearly-full row read the one answer.
  const catalogContextWindow = useWorkspaceStore((state) =>
    chatCli && chatModel
      ? state.appSettings.cliModelCatalog?.[chatCli]?.models.find((entry) => entry.id === chatModel)?.contextWindow
      : undefined,
  )
  const contextReading = conversationContextReading({
    usage: projection.usage,
    catalogWindow: catalogContextWindow,
    providerContextLength: currentModel?.contextLength,
  })
  // ⌘⇧M toggles the model picker (registered as
  // `chat.modelPicker.toggle` so the Shortcuts settings, the
  // palette and the conflict suite all know the chord). The shell's dispatcher
  // resolves the binding and `runCommand` routes the registry's panel-event to
  // the module-level responder above; this view only registers itself.
  const changeReasoningEffort = (effort: string | undefined) => {
    if (effort && !capabilities?.reasoningEfforts?.includes(effort)) return
    updateBinding({ conversationReasoningEffort: effort })
    if (sessionId) setPermissionNotice('Reasoning effort applies from the next turn.')
  }
  const cycleEffortRef = useRef(() => {})
  cycleEffortRef.current = () =>
    changeReasoningEffort(nextConversationEffort(capabilities?.reasoningEfforts ?? [], reasoningEffort))
  // Continue in terminal (the palette, `/terminal`, the tab's menu): main
  // stops a turn this chat is running, suspends it and opens a terminal agent
  // resuming its CLI session. A message queued behind that turn is refused
  // while the terminal opens, and so comes back to the composer.
  // Only a chat on this machine: a paired machine's session is not here.
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const resumesInTerminal = transport.kind === 'local' && chatResumesInTerminal(agent, pluginCatalogEntries)
  const resumeInTerminalRef = useRef(() => {})
  resumeInTerminalRef.current = () => {
    if (!resumesInTerminal) {
      setActionError('A terminal cannot resume this kind of chat yet.')
      return
    }
    void (async () => {
      // After an app restart the chat holds no session until it is sent
      // something, and main reads the CLI session to hand over through one.
      // Claude and Codex start one without spawning their CLI, and the handoff
      // suspends it again either way. One that could not start has said why,
      // unless there was no folder to start in.
      if (!sessionId && !(await ensureSession()) && workspaceRoot) return
      const result = await resumeChatInTerminal({ workspaceId, agentId })
      setActionError(result.ok ? null : result.message)
    })().catch((error: unknown) =>
      setActionError(error instanceof Error ? error.message : 'The chat could not be continued in a terminal.'),
    )
  }
  const keybindingSettings = useWorkspaceStore((s) => s.appSettings.keybindings)
  const sendAndNewKeys = getEffectiveKeybindings(SEND_AND_NEW_COMMAND, keybindingSettings)
  const keyPlatform = platformKeybindingsFromApiPlatform(window.api.platform)
  const toggleModelPickerRef = useRef<() => void>(() => {})
  // The picker stays reachable once the chat has started: its model is fixed
  // then, but effort and permissions are not.
  toggleModelPickerRef.current = () => {
    if (!chatCli) return
    setModelMenuOpen((open) => !open)
  }
  // A quote (the selection toolbar's, or the quote shortcut's) lands where the
  // composer's caret was, as a block of its own, and the caret waits on a fresh
  // line under it. The field keeps its caret while focus is in the transcript.
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  // Declared below; read through a ref by the window's hand-offs (mountedChatViews).
  const quoteIntoComposerRef = useRef<(markdown: string) => void>(() => undefined)
  const quoteIntoComposer = useCallback(
    (markdown: string) => {
      const field = composerRef.current
      setDraft((current) => {
        const next = insertQuoteIntoDraft(current, markdown, field?.selectionEnd ?? current.length)
        pendingCaretRef.current = next.caret
        return next.text
      })
    },
    [setDraft],
  )
  quoteIntoComposerRef.current = quoteIntoComposer
  // Replay: the conversation played back from its first message, drawn over
  // this view (agentChat/conversationReplayView). It reads the whole log, so
  // the turns this view has not paged in yet are fetched first; leaving, or
  // starting again, drops a read still under way.
  const [replay, setReplay] = useState<ConversationReplaySource | null>(null)
  const replayRunRef = useRef(0)
  const startReplayRef = useRef<() => void>(() => undefined)
  startReplayRef.current = () => {
    const run = ++replayRunRef.current
    setReplay({ status: 'loading' })
    const root = binding.sessionRoot ?? workspaceRoot
    const held = { events, hasMore: hasMore && root !== null, beforeCursor }
    const key = { workspaceRoot: root ?? '', workspaceId, agentId }
    void loadWholeConversation((input) => transport.loadEarlier(input), key, held)
      .then((all) => {
        if (replayRunRef.current === run) setReplay({ status: 'ready', events: all })
      })
      .catch((error: unknown) => {
        if (replayRunRef.current === run)
          setReplay({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  }
  const leaveReplay = useCallback(() => {
    replayRunRef.current += 1
    setReplay(null)
  }, [])
  // A replay asked for from the tab's menu, which may have mounted this view to
  // ask it: the ask waits for the transcript, or it would replay an empty chat.
  useEffect(() => {
    if (!hydrated) return
    const answer = () => {
      if (takeChatReplayRequest(workspaceId, agentId)) startReplayRef.current()
    }
    answer()
    return onChatReplayRequest(answer)
  }, [workspaceId, agentId, hydrated])
  const quoteSelectionRef = useRef<() => boolean>(() => false)
  quoteSelectionRef.current = () => {
    const transcript = transcriptRef.current
    if (!transcript || composerInputDisabled) return false
    return quoteSelectionInto(transcript, document.getSelection(), quoteIntoComposer)
  }
  // Restart agent session (`chat.restartSession`): end the agent's process the
  // way Settle and the idle sweep do — suspended, so the session keeps its
  // resume cursor and the next message starts it again on the same
  // conversation (sessionRecovery.ts covers a session the runtime no longer
  // holds) — then list the slash commands again, so a skill or plugin
  // installed since shows up. Refused while the agent works: a suspend
  // interrupts the turn and ends the agents it sent off.
  const restartSessionRef = useRef<() => Promise<void>>(async () => undefined)
  restartSessionRef.current = async () => {
    if (transport.kind !== 'local') {
      showToast({ tone: 'warn', title: 'This chat runs on another machine', description: 'Restart it there.' })
      return
    }
    const working =
      isConversationBusy(projection.activeTurn, projection.awaitingApproval, pending) ||
      steeringTurnId !== null ||
      timelineRows.some((row) => row.kind === 'working')
    if (working) {
      showToast({
        tone: 'warn',
        title: 'The agent is still working',
        description: 'Stop it first, then restart the session.',
      })
      return
    }
    if (!sessionId) {
      // No agent has started for this chat since it opened: nothing runs to
      // end. The command list is still asked again, which is what someone
      // reaching for this after an install wants.
      conversationCommands.refresh()
      showToast({
        tone: 'neutral',
        title: 'No agent session to restart',
        description: 'This chat has no agent running. Your next message starts one.',
      })
      return
    }
    const result = await window.api.conversationSessionSuspend({ sessionId }).catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }))
    if (!result.ok) {
      showToast({ tone: 'error', title: 'The session was not restarted', description: result.message })
      return
    }
    if (result.session) setSession(result.session)
    conversationCommands.refresh()
    showToast({
      tone: 'good',
      title: 'Agent session restarted',
      description: 'Your next message starts it again, with the conversation as it was.',
    })
  }
  // Typing or pasting in the chat away from the composer lands in it
  // (agentChat/typeToComposer). Read through a ref so the listeners are bound
  // once per shell, not once per keystroke's render.
  const typeIntoComposerRef = useRef<(text: string) => boolean>(() => false)
  typeIntoComposerRef.current = (text) => {
    const field = composerRef.current
    if (!field || composerInputDisabled || replay !== null) return false
    replaceComposerSelection({ selectionStart: field.selectionStart, selectionEnd: field.selectionEnd }, text)
    return true
  }
  const composerEditableRef = useRef<() => HTMLElement | null>(() => null)
  composerEditableRef.current = () => {
    if (composerInputDisabled || replay !== null) return null
    const editable = shellRef.current?.querySelector<HTMLElement>('[data-composer-field] .cm-content') ?? null
    // Hidden while a question covers the composer: the answer goes there.
    return editable && isEditableElement(editable) && !editable.closest('.hidden, [hidden]') ? editable : null
  }
  // On the shell through React rather than bound once at mount: the view
  // first renders a shell of its own while the chat is loading, and this one
  // arrives later.
  const redirectHandlers = useMemo<React.HTMLAttributes<HTMLDivElement>>(
    () => ({
      onKeyDown: (event) => {
        if (event.defaultPrevented) return
        const text = typedCharacter(event.nativeEvent)
        if (!text || !shouldRedirectToComposer(event.target) || !composerEditableRef.current()) return
        if (typeIntoComposerRef.current(text)) event.preventDefault()
      },
      onPaste: (event) => {
        if (event.defaultPrevented || !shouldRedirectToComposer(event.target)) return
        const editable = composerEditableRef.current()
        if (!editable) return
        composerRef.current?.focus()
        event.preventDefault()
        if (event.clipboardData && forwardPasteToComposer(editable, event.clipboardData)) return
        // A paste whose text the event did not carry (the clipboard bridge's
        // case): read it, as the bridge does for the composer itself.
        void window.api
          .clipboardReadText()
          .then((text) => {
            if (text && editable.isConnected) pasteIntoComposer(editable, text)
          })
          .catch(() => undefined)
      },
    }),
    [],
  )
  const chatFind = useChatFind({
    rows: timelineRows,
    listRef,
    transcriptRef,
    shellRef,
    jumpToRow,
    pauseFollowing: () => {
      atBottomRef.current = false
      setAtBottom(false)
    },
    focusFallback: () => composerRef.current?.focus(),
  })
  const openChatFind = chatFind.openFind
  // Export chat asks this before it offers itself: a chat with no message has
  // nothing to export. Earlier pages not read in yet are messages too.
  const hasMessagesRef = useRef(false)
  hasMessagesRef.current = hasMore || timelineRows.some((row) => row.kind === 'user' || row.kind === 'assistant')
  const exportable = transport.kind === 'local' && chatExportSupported()
  useEffect(
    () =>
      registerMountedChatView({
        workspaceId,
        agentId,
        isFocused: () => Boolean(shellRef.current?.contains(document.activeElement)),
        toggleModelPicker: () => toggleModelPickerRef.current(),
        cycleEffort: () => cycleEffortRef.current(),
        resumeInTerminal: () => resumeInTerminalRef.current(),
        stepTurn,
        startReplay: () => startReplayRef.current(),
        quoteSelection: () => quoteSelectionRef.current(),
        insertQuote: (text) => {
          quoteIntoComposerRef.current(text)
          composerRef.current?.focus()
        },
        restartSession: () => void restartSessionRef.current(),
        openFind: openChatFind,
        openSideQuestion: () => openSideQuestionRef.current(),
        hasMessages: () => hasMessagesRef.current,
        // Main reads a local chat's transcript; a chat on another machine has
        // none here to read.
        ...(exportable
          ? { exportChat: (action: ChatExportAction) => void exportChatOrToast({ workspaceId, agentId, action }) }
          : {}),
      }),
    [workspaceId, agentId, stepTurn, openChatFind, exportable],
  )
  const modelPickerShortcutLabel = useMemo(() => {
    const keybinding = getEffectiveKeybindings(MODEL_PICKER_TOGGLE_COMMAND, keybindingSettings)[0]
    if (!keybinding) return null
    const platform = window.api.platform === 'darwin' ? 'darwin' : window.api.platform === 'win32' ? 'windows' : 'linux'
    return renderKeybinding(keybinding, platform)
  }, [keybindingSettings])
  const sideQuestionShortcutLabel = useMemo(() => {
    const keybinding = getEffectiveKeybindings(SIDE_QUESTION_COMMAND, keybindingSettings)[0]
    if (!keybinding) return null
    const platform = window.api.platform === 'darwin' ? 'darwin' : window.api.platform === 'win32' ? 'windows' : 'linux'
    return renderKeybinding(keybinding, platform)
  }, [keybindingSettings])
  const quoteShortcutLabel = useMemo(() => {
    const keybinding = getEffectiveKeybindings(QUOTE_SELECTION_COMMAND, keybindingSettings)[0]
    if (!keybinding) return null
    const platform = window.api.platform === 'darwin' ? 'darwin' : window.api.platform === 'win32' ? 'windows' : 'linux'
    return renderKeybinding(keybinding, platform)
  }, [keybindingSettings])
  const [modelChanging, setModelChanging] = useState(false)
  const selectModel = (providerId: string, modelId: string) => {
    setModelMenuOpen(false)
    if (modelLocked || modelChanging || (providerId === conversation.providerId && modelId === conversation.modelId))
      return
    // The agent keeps its name: it is named from the pool, not after its model.
    const record = () => {
      updateBinding({ conversation: { providerId, modelId }, conversationMode: 'default' })
      binding.rememberModel?.({ providerId, modelId })
    }
    // No live session: the record is what the next session starts on.
    if (!sessionId || !transport.setModel) {
      record()
      return
    }
    // A live session takes the switch first; the record moves only once the
    // provider accepted it, so the chip never names a model the session is not
    // on. Mid-turn the provider says the reply finishes on its old model.
    setActionError(null)
    setPermissionNotice(null)
    setModelChanging(true)
    void transport
      .setModel({ sessionId, modelId })
      .then((result) => {
        // No session there any more: the record is what the next one starts on.
        if (forgetLostSession(result)) {
          record()
          return
        }
        if (!result.ok) {
          setActionError(result.message)
          return
        }
        record()
        if (result.session) setSession(result.session)
        setPermissionNotice(result.notice ?? null)
      })
      .catch((error: unknown) => setActionError(error instanceof Error ? error.message : 'Could not change the model.'))
      .finally(() => setModelChanging(false))
  }
  runAppCommandRef.current = (text, attachmentCount) => {
    const action = composerAppCommand(text, {
      cli: chatCli,
      models: chatCliOption?.modelSelection?.options ?? [],
      efforts: capabilities?.reasoningEfforts ?? [],
      attachments: attachmentCount,
      sideQuestion: sideQuestionApi !== null,
    })
    if (!action) return false
    if (action.kind === 'refuse') {
      setPermissionNotice(action.notice)
      return true
    }
    if (action.kind === 'sideQuestion') {
      if (!openSideQuestionRef.current(action.question)) {
        setPermissionNotice('A side question asks about the chat so far. Send the chat a message first.')
        return true
      }
      clearDraft()
      setCommandHint(null)
      return true
    }
    clearDraft()
    setCommandHint(null)
    if (action.kind === 'model') {
      if (action.model && conversation && !modelLocked) selectModel(conversation.providerId, action.model)
      else setModelMenuOpen(true)
    } else if (action.effort) changeReasoningEffort(action.effort)
    else cycleEffortRef.current()
    return true
  }

  // Capabilities are available from the provider catalog before the first turn,
  // then the live session reports the declaration it actually started with.
  const supportsTools = capabilities?.tools === true
  const assistantName = supportsTools
    ? (session?.displayName ?? providerEntry?.displayName ?? currentModelLabel)
    : currentModelLabel
  // Where the ring's breakdown is read: the chat's agent, over the transport,
  // where both can (ContextBreakdown.tsx). It is read again as a turn ends,
  // not while one runs: the key holds still through a turn and moves with
  // the reading the turn's end leaves.
  // A chat with no live session (the app restarted since it last ran) has
  // no agent to ask until a message starts one, and says so.
  const breakdownDeclared = capabilities?.contextBreakdown === true
  const readContextBreakdown = breakdownDeclared ? transport.readContextBreakdown : undefined
  const contextRefreshKey = projection.activeTurn ? 'turn' : (contextReading?.used ?? 0)
  const hasContextReading = contextReading !== null
  const contextBreakdownSource = useMemo<ContextBreakdownSource | null>(
    () =>
      hasContextReading
        ? {
            load: readContextBreakdown
              ? sessionId
                ? () => readContextBreakdown({ sessionId })
                : async () => ({
                    ok: false,
                    reason: 'not-running',
                    message: `${assistantName} is not running for this chat now. Send a message and it can say what fills the window.`,
                  })
              : null,
            agentName: assistantName,
            // A window on the Studio protocol: the agent could say, but
            // nothing here can ask it. A paired machine's chat asks it over
            // there, where that machine reads the window.
            ...(breakdownDeclared && !readContextBreakdown
              ? { unavailable: 'This window cannot ask the agent what fills the window, only how full it is.' }
              : {}),
            cacheKey: sessionId,
            refreshKey: contextRefreshKey,
          }
        : null,
    [hasContextReading, breakdownDeclared, readContextBreakdown, sessionId, assistantName, contextRefreshKey],
  )
  // Image attach is offered only where a provider actually reads the turn's
  // attachments, the transport carries them there, and the session can take a
  // turn — a control that stages images no one will receive is worse than no
  // control.
  const imagesEnabled = ready && capabilities?.images === true && transport.capabilities.imageAttachments
  // Files attached by path are cards only where the agent can read them by
  // that path and the card can open them: a chat on this computer (not a
  // paired machine's, an SSH machine's or a WSL distribution's), in a window
  // that reads a file's path. Anywhere else a file is typed as its path.
  const filesEnabled =
    ready &&
    transport.kind === 'local' &&
    transport.capabilities.localFiles &&
    workspaceRunsHere(binding.workspace) &&
    clientSupports('drag-paths')

  const skillInventory = useWorkspaceSkills(
    workspaceRoot,
    null,
    supportsSkills && transport.capabilities.composerContext,
  )
  // Held from render to render, as the "+" menu that takes them is memoized:
  // a list rebuilt each render redrew the menu on every keystroke and token.
  const attachedSkills = useMemo(
    () =>
      draftMetadata.skillIds.map(
        (id): WorkspaceSkill =>
          pickedSkills[id] ??
          skillInventory.skills.find((skill) => skill.id === id) ?? {
            id,
            name: id,
            source: 'custom',
            harnesses: [],
            installState: 'installed',
          },
      ),
    [draftMetadata.skillIds, pickedSkills, skillInventory.skills],
  )
  const setAttachedSkills = useCallback(
    (skills: WorkspaceSkill[]) => {
      const ids = [...new Set(skills.map((skill) => skill.id))].slice(0, 32)
      setPickedSkills((current) => ({ ...current, ...Object.fromEntries(skills.map((skill) => [skill.id, skill])) }))
      updateBinding({ conversationSkills: ids })
      setDraftMetadata((current) => ({ ...current, skillIds: ids }))
    },
    [updateBinding, setDraftMetadata],
  )
  const plusMenuSkills = useMemo(
    () =>
      supportsSkills
        ? {
            workspaceRoot,
            // A chat stages skills itself, so the workspace-wide inventory is
            // its list. Its servers were set when it started: they are listed
            // with how each is connecting, and none is picked from here.
            pluginId: null,
            skills: attachedSkills,
            onSkillsChange: setAttachedSkills,
            mcpServers: NO_MCP_SERVERS,
            onMcpServersChange: ignoreMcpServers,
            mcpCli: chatCli,
            mcpPickable: false,
            // A chat on a paired machine lists that machine's.
            ...(transport.remoteExtensions ? { remote: transport.remoteExtensions } : {}),
            // A live chat here can reconnect its servers, switch them, and
            // sign in to one, as far as its CLI lets it.
            ...(transport.kind === 'local' && sessionId && mcpServerActions?.length
              ? {
                  mcpActions: {
                    available: mcpServerActions,
                    run: (serverId: string, action: ConversationMcpServerAction) =>
                      window.api.conversationSessionMcpAction({ sessionId, serverId, action }),
                  },
                }
              : {}),
          }
        : undefined,
    [
      supportsSkills,
      workspaceRoot,
      attachedSkills,
      setAttachedSkills,
      chatCli,
      transport.remoteExtensions,
      transport.kind,
      sessionId,
      mcpServerActions,
    ],
  )
  const removeDraftFile = useCallback(
    (path: string) =>
      setDraftMetadata((current) => ({ ...current, files: current.files.filter((entry) => entry !== path) })),
    [setDraftMetadata],
  )
  const removeContextTrigger = (range: { start: number; end: number }) => {
    setDraft((current) => current.slice(0, range.start) + current.slice(range.end))
    pendingCaretRef.current = range.start
    setComposerCaret(range.start)
    detachRecall()
  }
  // The `/` menu lists what the chat's CLI runs in this folder, plus Studio's
  // own few. A chat on another machine has no folder here to ask about, so its
  // menu holds Studio's commands, and the CLI's only once a list for it has
  // reached this machine.
  const localCommands = transport.capabilities.composerContext
  const appCommands = useMemo(
    () =>
      studioAppCommands({
        model: Boolean(chatCli),
        effort: Boolean(capabilities?.reasoningEfforts?.length),
        terminal: resumesInTerminal,
        sideQuestion: sideQuestionApi !== null,
      }),
    [chatCli, capabilities?.reasoningEfforts?.length, resumesInTerminal, sideQuestionApi],
  )
  const conversationCommands = useConversationCommands(
    chatCli,
    localCommands ? workspaceRoot : (binding.sessionRoot ?? null),
    { appCommands, discover: localCommands },
  )
  const commandCatalog = conversationCommands.catalog
  const commandMenuAvailable = Boolean(
    chatCli && (localCommands ? workspaceRoot : conversationCommands.commands.length),
  )
  // A picked command's argument hint, shown under the field until the person
  // types past what the pick left there.
  const [commandHint, setCommandHint] = useState<{ command: string; hint: string; draft: string } | null>(null)
  const contextPicker = useComposerContextPicker({
    workspaceRoot,
    draft,
    caret: composerCaret,
    // The type-ahead reads this machine's inventory; a remote chat's skills come from its "+".
    skillsEnabled: supportsSkills && transport.capabilities.composerContext,
    // A file mention names a file on this machine's disk.
    mentionsEnabled: transport.capabilities.composerContext,
    commandMenu: commandMenuAvailable
      ? {
          commands: conversationCommands.commands,
          status: {
            cliLabel: chatCliOption?.label ?? providerEntry?.displayName ?? chatCli ?? 'The CLI',
            loading: conversationCommands.loading,
            error: commandCatalog?.error,
            answered: Boolean(commandCatalog?.fetchedAt),
            reportedCount: commandCatalog?.commands.length ?? 0,
          },
          onOpen: conversationCommands.refreshIfStale,
        }
      : null,
    onPickCommand: (command, range) => {
      // Studio's own commands act here and leave nothing to send. `/model`
      // leaves focus to the picker it opens, so its token goes without the
      // caret restore that would pull focus back into the field.
      if (command.source === 'app') {
        setCommandHint(null)
        if (command.name === 'model') {
          setDraft((current) => current.slice(0, range.start) + current.slice(range.end))
          setComposerCaret(range.start)
          detachRecall()
          setModelMenuOpen(true)
          return
        }
        removeContextTrigger(range)
        if (command.name === 'effort') cycleEffortRef.current()
        if (command.name === 'terminal') resumeInTerminalRef.current()
        if (command.name === 'btw' && !openSideQuestionRef.current())
          setPermissionNotice('A side question asks about the chat so far. Send the chat a message first.')
        return
      }
      // Everything else is text the CLI expands when the message goes out —
      // as `/name` where the token opens the message, and as a form the agent
      // reads mid-message anywhere else. A space already after the token is
      // reused rather than doubled.
      const opensMessage = tokenOpensMessage(draft, range.start)
      const text = commandInsertText(command, opensMessage)
      const end = text.endsWith(' ') && /^\s/u.test(draft.slice(range.end)) ? range.end + 1 : range.end
      const next = draft.slice(0, range.start) + text + draft.slice(end)
      setDraft(next)
      pendingCaretRef.current = range.start + text.length
      setComposerCaret(range.start + text.length)
      detachRecall()
      // Arguments follow a command only where it runs, at the message's start.
      setCommandHint(
        opensMessage && command.argumentHint
          ? { command: command.name, hint: command.argumentHint, draft: next }
          : null,
      )
    },
    onPickSkill: (skill, range) => {
      setAttachedSkills([...attachedSkills, skill])
      removeContextTrigger(range)
    },
    onPickMention: (mention, range) => {
      setDraftMetadata((current) => ({
        ...current,
        mentions: [
          ...current.mentions.filter((entry) => entry.path !== mention.path || entry.kind !== mention.kind),
          mention,
        ].slice(-50),
      }))
      removeContextTrigger(range)
    },
  })
  // ⌘S sets the draft aside, or on an empty box lists what was set aside
  // (agentChat/promptStashPicker.tsx). A stashed prompt comes back ahead of
  // anything typed since, the way "Edit from here" brings a message back.
  const stashPicker = usePromptStash({
    stashKeys: getEffectiveKeybindings(PROMPT_STASH_COMMAND, keybindingSettings),
    platform: keyPlatform,
    content: () => ({
      text: draft,
      files: draftMetadata.files,
      mentions: draftMetadata.mentions,
      images: attachments,
    }),
    clear: () => {
      clearDraft()
      setAttachments([])
      detachRecall()
    },
    restore: ({ prompt, images }) => {
      restoreDraftRef.current({
        text: prompt.text,
        files: prompt.files,
        skills: [],
        mentions: prompt.mentions,
        attachments: images,
      })
      return true
    },
    acceptsImages: imagesEnabled,
    empty: !draft.trim() && !attachments.length && !draftMetadata.files.length && !draftMetadata.mentions.length,
  })

  const pendingApprovalEntries = shape.pendingApprovals
  const pendingApprovalEntry = pendingApprovalEntries[0]
  // A question takes the composer's place, so no placeholder speaks for it;
  // the tray's requests leave the field showing beneath them.
  const composerPlaceholder = pendingApprovalEntry
    ? pendingApprovalEntry.requestKind === 'plan'
      ? 'Respond to the plan above to continue'
      : 'Respond to the request above to continue'
    : !ready && !startupHolding
      ? readinessLabel(readiness)
      : projection.activeTurn || startupHolding
        ? 'Reply — sends when the turn finishes'
        : 'Send a message…'

  // Retry lives on the failed turn's error block in the transcript; only the
  // latest failed turn is retryable (retry re-sends the last user message).
  const lastFailedTurnId = !projection.activeTurn && ready ? shape.lastFailedTurnId : undefined

  const latestTurnId = shape.latestTurnId
  const oldChrome = chromeRef.current
  const checkpointSeqs = shape.checkpointSeqs
  const stableCheckpointSeqs =
    oldChrome?.checkpointSeqs &&
    oldChrome.checkpointSeqs.size === checkpointSeqs.size &&
    [...checkpointSeqs].every((seq) => oldChrome.checkpointSeqs?.has(seq))
      ? oldChrome.checkpointSeqs
      : checkpointSeqs
  // Offered where the provider can drop turns from its own context and this
  // view can operate the conversation.
  const rewindEnabled = operate && capabilities?.rewind === true && typeof transport.rewind === 'function'
  // Handoff, where the provider can start a fresh session pointed at a file
  // of the chat's messages and this view can operate the conversation.
  const handoffEnabled = operate && capabilities?.handoff === true && typeof transport.handoff === 'function'
  const handingOffRef = useRef(false)
  const handoff = async () => {
    if (handingOffRef.current || !transport.handoff) return
    handingOffRef.current = true
    try {
      const root = binding.sessionRoot ?? workspaceRoot
      if (!root) throw new Error('This chat has no folder to hand off from.')
      const handed = await transport.handoff({ key: { workspaceRoot: root, workspaceId, agentId } })
      if (!handed.ok) throw new Error(handed.message)
    } catch (error) {
      showToast({
        tone: 'error',
        title: 'The chat was not handed off',
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      handingOffRef.current = false
    }
  }
  // "Fork from here", where the provider can be forked and this machine can
  // open the fork in a tab. A provider that branches only the session it is
  // running (an ACP agent's `session/fork`, `forkFromLiveSession`) has this
  // chat's session started first for a fork at the newest reply; any other
  // is not started for nothing. A paired machine's chat is forked over there,
  // never started here, and the fork opens as a pane onto that machine.
  const forkRef = useRef<(target: ForkFromHereTarget) => Promise<void>>(async () => undefined)
  forkRef.current = async (target) => {
    if (transport.kind === 'remote') {
      await forkRemoteChat({
        transport,
        workspaceId,
        agentId,
        providerId: conversation?.providerId || 'remote',
        name: agent.name,
        target,
      })
      return
    }
    if (!workspaceRoot) throw new Error('This chat has no folder to fork in.')
    if (
      target.side === 'assistant' &&
      target.turnId === latestTurnId &&
      capabilities?.forkFromLiveSession === true &&
      transport.capabilities.startSession
    )
      await ensureSession()
    await forkChat({ transport, key: { workspaceRoot, workspaceId, agentId }, target })
  }
  const forkFromHere = useCallback((target: ForkFromHereTarget) => forkRef.current(target), [])
  const onFork =
    operate && capabilities?.fork === true && typeof transport.fork === 'function' ? forkFromHere : undefined
  // The Files and Folders setting is this Mac's, so only a chat that runs on
  // it, in a window that can reach System Settings, offers to open it.
  const onOpenPrivacySettings =
    transport.kind === 'local' && !machineId && hostPlatform() === 'darwin' && clientSupports('reveal-in-folder')
      ? openMacosPrivacySettings
      : undefined
  // A side question is offered once the chat has a reply to ask about, and
  // carried on in a chat of its own where the chat can be forked here: from
  // its newest reply, once no turn runs, as Fork from here is.
  const sideQuestionOffered = sideQuestionApi !== null && latestTurnId !== undefined
  openSideQuestionRef.current = (question) => {
    if (!sideQuestionOffered) return false
    sideQuestion.show(question)
    return true
  }
  const sideQuestionMenuRow = useMemo(
    () => ({ onAsk: () => void openSideQuestionRef.current(), shortcut: sideQuestionShortcutLabel }),
    [sideQuestionShortcutLabel],
  )
  const continueSideQuestion =
    onFork && latestTurnId
      ? {
          disabled: projection.activeTurn ? 'Available once the chat’s turn ends' : null,
          onContinue: (question: string) =>
            forkFromHere({ side: 'assistant', turnId: latestTurnId, draft: { text: question } }),
        }
      : undefined
  const chrome: TimelineChrome =
    oldChrome &&
    oldChrome.assistantName === assistantName &&
    oldChrome.latestTurnId === latestTurnId &&
    oldChrome.retryTurnId === lastFailedTurnId &&
    oldChrome.onRetry === retry &&
    oldChrome.retryDisabled === composerDisabled &&
    oldChrome.onSignIn === onSignIn &&
    oldChrome.onOpenPrivacySettings === onOpenPrivacySettings &&
    oldChrome.checkpointsEnabled === (capabilities?.checkpoints === true) &&
    oldChrome.conversationRunning === projection.activeTurn &&
    oldChrome.checkpointSeqs === stableCheckpointSeqs &&
    oldChrome.rewindEnabled === rewindEnabled &&
    oldChrome.onFork === onFork &&
    oldChrome.cli === chatCli
      ? oldChrome
      : {
          assistantName,
          latestTurnId,
          retryTurnId: lastFailedTurnId,
          onRetry: retry,
          retryDisabled: composerDisabled,
          onSignIn,
          onOpenPrivacySettings,
          platform: hostPlatform(),
          checkpointsEnabled: capabilities?.checkpoints === true,
          conversationRunning: projection.activeTurn,
          checkpointSeqs: stableCheckpointSeqs,
          rewindEnabled,
          onRestoreDraft: restoreDraft,
          onFork,
          cli: chatCli,
        }
  chromeRef.current = chrome
  // What rows read besides their own item: it changes with a turn starting or
  // ending, a retry becoming possible, a jump's flash, never with a token.
  // `chrome` is the previous object while nothing in it changed (above).
  const rowContext = useMemo(
    () => ({ chrome, flashRowId, hydrated, replayThroughSeq, unreadRowId }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chrome, flashRowId, hydrated, replayThroughSeq, unreadRowId],
  )

  const latestCompletedTurnId = shape.latestCompletedTurnId ?? null
  if (hydrated && (atBottom || !replySeenRef.current) && replySeenRef.current?.turnId !== latestCompletedTurnId)
    replySeenRef.current = { turnId: latestCompletedTurnId }
  const newReplies =
    atBottom || !replySeenRef.current ? 0 : repliesCompletedAfter(shapeEntries, replySeenRef.current.turnId)
  // Install trailing space in the same render as the optimistic prompt, before
  // the scroll effect runs. Otherwise a send from scrollback is clamped to the
  // old scroll range and leaves the new prompt at the bottom.
  const effectiveAnchorId = pendingUserScrollIdRef.current ?? anchoredUserId
  const anchorUserIndex = effectiveAnchorId ? timelineRows.findIndex((row) => row.id === effectiveAnchorId) : -1
  const rememberedRowIndex = scrollMemoryRef.current?.rowId
    ? timelineRows.findIndex((row) => row.id === scrollMemoryRef.current?.rowId)
    : -1

  // Orphan turn failure: lastError set but no transcript entry carries it (a
  // turn_failed with no turnId while nothing was streaming). Without this the
  // chat would look idle/successful with the only trace in Notifications.
  const hasFailedTurnEntry = shape.lastFailedTurnId !== undefined
  // Whether this chat's permission preset can be changed from its picker: the
  // same gate the separate pill used to have. A preset the provider cannot run
  // stays listed, dimmed, with the reason.
  const permissionsEditable =
    operate &&
    (transport.capabilities.reportsPreset || session?.permissionPreset !== undefined) &&
    Boolean(capabilities?.approvals || capabilities?.permissionPresets?.length)
  const presetRefusals = chatPermissionRefusals({
    cli: chatCli,
    allowed: capabilities?.permissionPresets,
    permissionModes: transport.capabilities.permissionModes,
    machineName: transport.machineName,
  })
  // The CLI's modes under its own names. A mode of its own is offered where
  // this chat's runtime maps it, and only a local chat says which it maps; a
  // remote one is told presets, so it lists each preset's own mode.
  const permissionOptions = usePermissionModeOptions(chatCli, 'chat', capabilities?.permissionModes ?? NO_MODES)
  // A mode of the CLI's own at a preset this chat cannot run is dimmed with
  // that preset's reason.
  const permissionDisabledReasons = presetRefusals
    ? {
        ...presetRefusals,
        ...Object.fromEntries(
          permissionOptions
            .filter((option) => option.mode && presetRefusals[option.value])
            .map((option) => [option.id, presetRefusals[option.value]]),
        ),
      }
    : undefined
  // The looser modes a permission card offers to allow into: Auto and Bypass,
  // under the CLI's names for them, where they would ask less than the chat
  // does now and the chat can run them.
  // Held from render to render, as the dock that takes them is memoized: a
  // keystroke in the composer leaves the dock as it was.
  const approvalModeSwitches = useMemo<ApprovalModeSwitch[]>(
    () =>
      permissionsEditable && chatCli
        ? (['auto', 'bypass'] as const)
            .filter((preset) => isLooserCliPermissionPreset(preset, permissionPreset) && !presetRefusals?.[preset])
            .map((preset) => ({
              preset,
              label: `Allow and switch to ${selectedPermissionOption(permissionOptions, preset)?.label ?? PRESET_CHIP_LABEL[preset]}`,
            }))
        : [],
    [permissionsEditable, chatCli, permissionPreset, presetRefusals, permissionOptions],
  )
  const approveAndSwitch = useCallback(
    (requestId: string, preset: CliPermissionPreset) => void approveAndSwitchMode(requestId, preset),
    [approveAndSwitchMode],
  )
  // Type dropped paths at the caret, spaced off the words around them. The
  // field keeps its selection while the pointer is over the transcript, so a
  // drop there lands where the user left off typing.
  const insertComposerPaths = (paths: string[]) => {
    const field = composerRef.current
    const selectionStart = field?.selectionStart ?? draft.length
    const selectionEnd = field?.selectionEnd ?? selectionStart
    const before = draft.slice(0, selectionStart)
    const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
    // A file from this chat's own SSH machine is typed as that machine spells
    // it: the agent runs there and cannot read this computer's `ssh://` form.
    const spelled = paths.map((path) => {
      const onMachine = machineId ? parseMachinePath(path) : null
      return onMachine && onMachine.id === machineId ? onMachine.path : path
    })
    replaceComposerSelection({ selectionStart, selectionEnd }, `${lead}${spelled.map(quotePromptPath).join(' ')} `)
  }

  // Files attached by path join the draft as cards, each once. The send
  // carries them beside the words and main tells the agent where each is, so
  // a provider that reads no images or documents still reads them off the disk.
  const attachFilePaths = (paths: string[]) =>
    setDraftMetadata((current) => ({ ...current, files: [...new Set([...current.files, ...paths])] }))

  // How a drop, a pick or a paste is sorted here (sortFiles): a file from the
  // system is a card where `filesEnabled`, and typed as its path anywhere
  // else, as it always was; one from the studio's own panes is typed; an image
  // attaches where the provider reads images; a file with no path is uploaded
  // where the shell can.
  const fileSorting = { attachImages: imagesEnabled, attachByPath: filesEnabled }
  const takeFiles = ({ paths, files, images, pathless }: DroppedFiles) => {
    if (paths.length > 0) insertComposerPaths(paths)
    if (files.length > 0) attachFilePaths(files)
    if (images.length > 0) void attachFiles(images)
    else setActionError(null)
    // No path here: a browser uploads them and types the server's paths. One
    // that cannot be is said, even beside images that did attach, so a file
    // never goes missing from a drop or a paste without a word.
    if (pathless.length > 0)
      void pathsForPathlessFiles(pathless).then(({ paths: uploaded, message }) => {
        if (uploaded.length > 0) insertComposerPaths(uploaded)
        if (message) setActionError(message)
      })
    composerRef.current?.focus()
  }

  // A pick from the system's file dialog, sorted as a drop is where files
  // attach by path; where only images do, the dialog offered images alone.
  takePickedFilesRef.current = (files) =>
    filesEnabled ? takeFiles(sortFiles(files, fileSorting)) : void attachFiles(files)

  // A file dropped anywhere on the chat lands in the composer — over the
  // transcript as much as on the composer. Aiming a drag at a field a few lines
  // tall is a needless target, and a drop that missed it used to do nothing at
  // all. The composer still lights up as the drop's destination. Any file takes,
  // sorted as `takeFiles` sorts it. A row the stream or the list's
  // virtualization removes mid-drag never reports its leave; the drop target
  // asks where the pointer went instead of counting (useFileDropTarget). The
  // drop it claims is also what keeps the field's own drop from typing a studio
  // drag's paths a second time when it lands on the field itself. While the
  // composer takes no input the drag passes the chat by, and a readiness change
  // mid-drag takes the affordance down with it.
  const { active: dropActive, handlers: fileDropHandlers } = useFileDropTarget({
    enabled: !composerInputDisabled,
    accepts: dataTransferHasDroppableFiles,
    onDrop: (dataTransfer) => takeFiles(sortDroppedFiles(dataTransfer, fileSorting)),
  })

  const orphanTurnError = projection.lastError && !hasFailedTurnEntry ? projection.lastError : null
  const composerError = actionErrorMessage ?? persistenceError ?? historyError ?? orphanTurnError
  // Retry only where there is something to send again: the send that failed,
  // or a turn that failed without a transcript entry to carry its own Retry.
  const composerRetry = actionError
    ? failedSend
      ? retryFailedSend
      : null
    : !persistenceError && !historyError && orphanTurnError
      ? retry
      : null
  // An error set by this view's own action is cleared at its source; one that
  // comes from elsewhere (the draft store, the history subscription, the
  // projection) is hidden until it clears and a new one arrives.
  const [dismissedError, setDismissedError] = useState<string | null>(null)
  useEffect(() => {
    if (!composerError) setDismissedError(null)
  }, [composerError])
  const dismissComposerError = () => {
    if (actionError) setActionError(null)
    else setDismissedError(composerError)
  }
  // The session's standing notices, dismissed by their words for as long as
  // this view is open: the same notice again says nothing new.
  const [dismissedNotices, setDismissedNotices] = useState<ReadonlySet<string>>(() => new Set())
  const dismissNotice = (notice: string) => setDismissedNotices((current) => new Set(current).add(notice))
  const billingNotice = apiKeyBillingNotice(projection.apiKeySource)
  const requestPending = pendingApprovalEntries.length > 0
  // A question waiting takes the composer's place. The composer stays mounted
  // behind it, unseen, so the draft — its words, pasted images, files and
  // mentions — is exactly as it was once the question is answered.
  const questionCoversComposer = pendingApprovalEntries.some(
    (entry) => entry.status === 'pending' && coversComposer(entry),
  )
  const draftHeld =
    draft.trim().length > 0 ||
    attachments.length > 0 ||
    draftMetadata.files.length > 0 ||
    draftMetadata.mentions.length > 0
  // The card held focus and has gone with its answer: the keyboard returns to
  // the field it came from, rather than to the page.
  const questionCoveredRef = useRef(false)
  useEffect(() => {
    const uncovered = questionCoveredRef.current && !questionCoversComposer
    questionCoveredRef.current = questionCoversComposer
    if (!uncovered) return
    const active = document.activeElement
    if (!active || active === document.body) composerRef.current?.focus()
  }, [questionCoversComposer])

  // The chat's permissions, on the engine picker's trailing row beside effort —
  // the same place a launch from New chat picks them — bound to this chat's
  // own preset, which a live session changes in place.
  const composerPermissions =
    chatCli && permissionsEditable
      ? () => (
          <PermissionFooter
            options={permissionOptions}
            preset={permissionPreset}
            mode={permissionMode}
            disabled={permissionChanging}
            disabledReasons={permissionDisabledReasons}
            onSelect={(next) => void changePermissionPreset(next.value, next.mode)}
          />
        )
      : null
  // A safeguard that is off (Bypass), or a preset this chat cannot run, is a
  // standing warning. Its chip used to say so on the row; inside the picker it
  // would go quiet, so the engine chip carries the warn tint and the words.
  const composerPermissionWarn = composerPermissions
    ? (presetRefusals?.[permissionPreset] ??
      (permissionPreset === 'bypass'
        ? `Permissions: ${agentPermissionChipLabel(permissionOptions, permissionPreset, permissionMode)}`
        : null))
    : null
  const stripFacts = useConversationStripFacts({
    workspaceId,
    agentId,
    workspace: binding.workspace,
    workspaceRoot,
    transport,
    listed: binding.listed ?? null,
  })
  // ── Scheduling the next message ──────────────────────────────────────────
  // Offered for a chat that runs on this computer, as its usage-limit resume
  // is: main sends the message, through this computer's own chats.
  const scheduleOffered = operate && transport.kind !== 'remote' && !stripFacts.machine && canScheduleMessages()
  // What a scheduled message carries is its text: a picture or a file staged
  // with it is the moment's, and is not kept for later.
  const scheduleBlocked =
    attachments.length > 0 || draftMetadata.files.length > 0
      ? 'A scheduled message carries text only — remove the pictures and files first'
      : null
  const scheduleOption = useMemo(
    () =>
      scheduleOffered
        ? {
            on: sendAt !== null,
            disabled: sendAt === null ? scheduleBlocked : null,
            onToggle: () => setSendAt((current) => (current === null ? defaultSendAt(Date.now()) : null)),
          }
        : undefined,
    [scheduleOffered, sendAt, scheduleBlocked],
  )
  // A chat that stops offering it (moved to another machine) sends as usual.
  useEffect(() => {
    if (!scheduleOffered) setSendAt(null)
  }, [scheduleOffered])
  const editScheduledMessage = useCallback(
    (message: ScheduledMessage) => {
      void updateScheduledMessage({ kind: 'delete', id: message.id }).then((deleted) => {
        if (!deleted) return
        setDraft((current) => [message.text, current].filter(Boolean).join('\n'))
        // One a paired machine queued was set for the turn's end, not for a
        // time: it comes back as a plain draft.
        if (!message.queued) setSendAt(message.sendAt > Date.now() ? message.sendAt : defaultSendAt(Date.now()))
        composerRef.current?.focus()
      })
    },
    [setDraft],
  )
  scheduleDraftRef.current = async () => {
    if (sendAt === null) return
    if (scheduleBlocked) {
      setActionError(`${scheduleBlocked}, or send it now.`)
      return
    }
    const text = draft.trim()
    if (!text) return
    if (sendAt <= Date.now()) {
      setActionError('That time has passed — pick one ahead, or send it now.')
      return
    }
    const scheduled = await updateScheduledMessage({ kind: 'schedule', workspaceId, agentId, text, sendAt })
    if (!scheduled) {
      setActionError('The message could not be scheduled.')
      return
    }
    setActionError(null)
    clearDraft()
    setSendAt(null)
  }
  // The pull requests this conversation opened, from the record the sidebar
  // reads. A chat on a paired machine has its record there, and its machine
  // lists them with the chat.
  const localPullRequests = usePullRequestsOfConversation(transport.kind === 'remote' ? null : { workspaceId, agentId })
  const conversationPullRequests =
    transport.kind === 'remote' ? (binding.listed?.pullRequests ?? localPullRequests) : localPullRequests
  // The person's "Stop watching" on the strip's pull request: the record's
  // change comes back through the list above, so nothing is held here.
  const stopWatchingPullRequest = useCallback(
    (url: string) => {
      void unwatchPullRequest({ workspaceId, agentId }, url).then((stopped) => {
        if (!stopped.ok) setActionError(`Could not stop watching the pull request: ${stopped.message}`)
      })
    },
    [workspaceId, agentId],
  )
  // The local servers this conversation's agents started, from the same
  // Studio record the sidebar's marks read; a paired machine's are its own.
  const conversationLocalServers = useLocalServersOfConversation(
    transport.kind === 'remote' ? null : { workspaceId, agentId },
  )
  const stripLocalServers = useMemo(
    () => (conversationLocalServers.length > 0 ? { workspaceId, servers: conversationLocalServers } : null),
    [conversationLocalServers, workspaceId],
  )
  // The subscription limits of the agent this chat runs on — read on this
  // computer, so only for a chat that runs here.
  const usageLimitsShown = useWorkspaceStore((s) => s.appSettings.appearance.usageLimits)
  const usageProvider =
    usageLimitsShown && transport.kind !== 'remote' && !stripFacts.machine
      ? usageLimitProviderOf(conversation?.providerId)
      : null
  const stripUsageLimits = useUsageLimitSnapshot(usageProvider)
  // "Create PR" works in this computer's checkout, or on the paired machine a
  // remote chat runs on, which does every step in its own checkout (owner
  // ruling 2026-10-18) where it says it can and this pairing may drive the
  // chat. A chat on WSL or an SSH machine (the strip names its machine) has
  // no git or `gh` here, and nothing there answers for them.
  const createPullRequestCwd =
    transport.kind !== 'remote' && transport.capabilities.localFiles && !stripFacts.machine ? workspaceRoot : null
  const remotePullRequestHost =
    transport.kind === 'remote' && transport.capabilities.hostPullRequests && operate
      ? (transport.pullRequestHost ?? null)
      : null
  const pullRequestHost = useMemo(
    () =>
      remotePullRequestHost ??
      (createPullRequestCwd ? localPullRequestHost(createPullRequestCwd, { workspaceId, agentId }) : null),
    [remotePullRequestHost, createPullRequestCwd, workspaceId, agentId],
  )
  // A turn ending moves the transcript's shape, and a token never does: read
  // when the shape moves, not on every streamed frame, which scanned back over
  // the whole running turn's events each time.
  const lastTurnEnd = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type === 'turn_completed' || event.type === 'turn_failed') return event.id
    }
    return ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureRevision])
  const [createPullRequestAsk, setCreatePullRequestAsk] = useState(0)
  const createPullRequestState = useCreatePullRequestState(
    // Not asked while the conversation owns an open pull request: the slot is that one's.
    conversationPullRequests.some((pr) => pr.state === 'open') ? null : pullRequestHost,
    [
      lastTurnEnd,
      stripFacts.branch?.name ?? '',
      stripFacts.changes ? `${stripFacts.changes.added}:${stripFacts.changes.removed}` : '',
      conversationPullRequests.map((pr) => `${pr.url}:${pr.state}`).join(','),
      createPullRequestAsk,
    ].join('|'),
  )
  // Held while the control shows its dialog, a step or a failure: the pull
  // request it just opened makes the checkout stop reading as ready, and that
  // must not take a failure to record it off the screen unread.
  const [createPullRequestHeld, setCreatePullRequestHeld] = useState(false)
  const createPullRequest = useMemo(
    () =>
      pullRequestHost && (createPullRequestState?.readiness.ready || createPullRequestHeld)
        ? {
            host: pullRequestHost,
            onSettled: () => setCreatePullRequestAsk((count) => count + 1),
            onHoldChange: setCreatePullRequestHeld,
            ready: createPullRequestState?.readiness.ready === true,
            forge: createPullRequestState?.forge ?? null,
          }
        : null,
    [pullRequestHost, createPullRequestState, createPullRequestHeld],
  )
  return (
    <ConversationLinkProvider
      workspaceId={workspaceId}
      agentId={agentId}
      cwd={workspaceRoot ?? ''}
      workspaceRoot={workspaceRoot ?? ''}
    >
      <SubagentTypesProvider value={projection.agentTypes}>
        <ChatShell shellRef={shellRef} dropHandlers={fileDropHandlers} keyHandlers={redirectHandlers}>
          {/* No title row above the transcript: the tab names the agent, as it
            does a terminal agent, and a thread title here repeated the first
            message over its own bubble. */}

          {/* Over the transcript's top-right, outside its log: the bar is
            chrome, and a change to its count is not a message. Not under a
            replay, which draws over the live chat it would be searching. */}
          {chatFind.open && replay === null ? (
            <FindBar
              label="Find in chat"
              query={chatFind.query}
              onQueryChange={chatFind.setQuery}
              status={chatFind.status}
              hasMatches={chatFind.hasMatches}
              onNext={chatFind.findNext}
              onPrevious={chatFind.findPrevious}
              onClose={chatFind.close}
              inputRef={chatFind.inputRef}
            />
          ) : null}
          {sideQuestionApi ? (
            <SideQuestionDrawer
              state={sideQuestion}
              chatName={agent?.name || 'this chat'}
              shortcut={sideQuestionShortcutLabel}
              continueInChat={continueSideQuestion}
            />
          ) : null}
          <div
            ref={transcriptRef}
            // Under a replay the live chat keeps running, out of reach.
            inert={replay !== null}
            role="log"
            // Focusable, out of the tab order: a click in the transcript puts
            // focus here rather than on the page, so what is typed next reaches
            // the chat (and the composer, typeToComposer) and the arrow keys
            // scroll it.
            tabIndex={-1}
            aria-label={`${label} conversation`}
            aria-live="off"
            aria-busy={!hydrated || loadingEarlier}
            onClickCapture={preserveDisclosurePosition}
            // A selection of the conversation copies as the markdown it was
            // rendered from; anything else is the browser's to copy.
            onCopy={(event) => copySelectionAsMarkdown(event.nativeEvent, event.currentTarget)}
            className="relative min-h-0 flex-1"
          >
            {timelineRows.length === 0 ? (
              startupWaiting ? (
                <PendingFirstMessage
                  text={startupPrompt ?? ''}
                  files={[...(startupImages ?? []), ...(startupFiles ?? [])]}
                  since={startupSince}
                  workspaceId={workspaceId}
                  preparingWorktree={readiness.kind === 'preparing-worktree'}
                  agentName={assistantName}
                />
              ) : !ready ? (
                <ReadinessState
                  readiness={readiness}
                  canSwitchModel={!modelLocked}
                  onSwitchModel={() => setModelMenuOpen(true)}
                  {...(binding.worktreeActions ? { worktreeActions: binding.worktreeActions } : {})}
                />
              ) : (
                // A new chat starts from the New chat panel, which sends its
                // first message; a chat with none yet only says so.
                <div className="flex h-full items-center justify-center">
                  <p className="max-w-[280px] text-center text-meta leading-5 text-[color:var(--text-muted)]">
                    No messages yet. Send a prompt to start the conversation.
                  </p>
                </div>
              )
            ) : (
              <LegendList
                ref={listRef}
                data={timelineRows}
                dataKey={conversationKey}
                // A row on screen renders again only when its item or this
                // changes, so everything a row reads besides its item rides
                // here rather than only in the closure below.
                extraData={rowContext}
                renderItem={({ item }) => (
                  <>
                    {item.id === unreadRowId ? <UnreadDivider /> : null}
                    <ConversationRowFrame
                      key={item.id}
                      id={item.id}
                      live={
                        hydrated &&
                        (item.kind === 'user'
                          ? item.entry.seq === undefined || item.entry.seq > replayThroughSeq
                          : item.kind === 'assistant' && (item.entry.checkpointTurnSeq ?? 0) > replayThroughSeq)
                      }
                      seen={animatedRowIds.current}
                      flash={flashRowId === item.id}
                      onFlashEnd={clearFlash}
                    >
                      <SubagentStopProvider value={stopSubagent}>
                        <TimelineRow key={item.id} row={item} chrome={chrome} />
                      </SubagentStopProvider>
                    </ConversationRowFrame>
                  </>
                )}
                keyExtractor={(row) => row.id}
                getItemType={(row) => row.kind}
                recycleItems
                estimatedItemSize={120}
                // A tab stop so the transcript scrolls from the keyboard, ringed
                // the way every focusable scroll container in the kit is: inset
                // (an outward ring is clipped at the pane's edge) and on keyboard
                // focus only — a click into the transcript to select text is not
                // a focus change worth drawing, and the UA outline it used to get
                // was neither the kit's colour nor its shape.
                // The gutter, not a narrower list, draws the chat width setting's
                // column: the scroller stays pane-wide so its scrollbar does too.
                // No padding or margin of its own above or below the rows: the
                // list cannot see one, and its end would stop short of it. The
                // gap at either end is the list's header and footer
                // (transcriptEnds.tsx).
                className={`chat-column-gutter h-full overflow-y-auto ${TRANSCRIPT_SCROLL_PADDING_CLASS} focus:outline-none ${FOCUS_RING_INSET_CLASS}`}
                tabIndex={0}
                ListHeaderComponent={
                  <TranscriptHead>
                    {hasMore ? (
                      <div className="flex justify-center pb-3">
                        <OutlineButton
                          size="xs"
                          busy={loadingEarlier}
                          disabled={loadingEarlier}
                          onClick={() => {
                            void loadEarlier().catch(() => undefined)
                          }}
                        >
                          {loadingEarlier ? 'Loading earlier…' : 'Load earlier'}
                        </OutlineButton>
                      </div>
                    ) : null}
                  </TranscriptHead>
                }
                ListFooterComponent={TRANSCRIPT_FOOT}
                aria-live="off"
                onScroll={handleLogScroll}
                onFirstVisibleItemChanged={({ key }) => {
                  firstVisibleRowRef.current = key
                }}
                initialScrollAtEnd={landsAtDivider ? false : (scrollMemoryRef.current?.atEnd ?? true)}
                initialScrollIndex={
                  landsAtDivider ? unreadRowIndex : rememberedRowIndex >= 0 ? rememberedRowIndex : undefined
                }
                maintainVisibleContentPosition={{ data: true, size: true }}
                maintainScrollAtEnd={
                  atBottom && !followPaused && !landsAtDivider
                    ? { animated: !projection.activeTurn && !prefersReducedMotion(), on: END_FOLLOW_TRIGGERS }
                    : false
                }
                anchoredEndSpace={anchorUserIndex >= 0 ? { anchorIndex: anchorUserIndex, anchorOffset: 0 } : undefined}
              />
            )}
            {minimap}
            <QuoteSelectionToolbar
              rootRef={transcriptRef}
              // A chat nobody can see has no selection to offer a quote for.
              enabled={!composerInputDisabled && viewActive}
              shortcut={quoteShortcutLabel}
              onQuote={quoteIntoComposer}
            />
          </div>

          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {announcement}
          </div>
          <div inert={replay !== null} className="chat-column-gutter relative pb-4 pt-1">
            {!atBottom && timelineRows.length > 0 ? (
              // Solid at rest, not the outline's transparent ground: it floats
              // over the transcript, and a see-through pill let the text run
              // through its label (see FloatingButton in ui/Buttons).
              <FloatingButton
                size="xs"
                onClick={jumpToLatest}
                className="absolute -top-10 left-1/2 z-[var(--z-float)] -translate-x-1/2 whitespace-nowrap"
              >
                <ChevronDownIcon className="icon-xs shrink-0" />
                {newReplies > 0 ? `${newReplies} new ${newReplies === 1 ? 'reply' : 'replies'}` : 'Jump to latest'}
              </FloatingButton>
            ) : null}
            {/*
             * The composer tray: everything the chat has to say about the next
             * message, one row each, most urgent against the composer — the
             * state of the session, then the agent's checklist, the cache and
             * the context window, what is queued, what the agent is waiting on,
             * and last what failed. While the agent is blocked on a request, the
             * checklist, the cache and the context window step aside for it;
             * what the session can and cannot do, and what the person just
             * changed, stay beside it.
             */}
            <ComposerTray>
              {/* A window on the Studio protocol whose connection is down
                says so, in words, while the transcript stays as it was. */}
              <StudioConnectionNotice />
              {/* The chat's worktree still installing its dependencies: the
                first message a chat started from outside a window waits for it. */}
              <WorktreeInstallTrayRow folder={workspaceRoot} />
              {/* Loading is not a warning — it is the state the screen is in,
                so it reads as the quiet line it is; anything else here is a
                degraded session. */}
              {!ready && timelineRows.length > 0 ? (
                readiness.kind === 'loading' ? (
                  <ComposerTrayRow glyph={<Spinner />}>{readinessLabel(readiness)}</ComposerTrayRow>
                ) : (
                  <ComposerTrayRow tone="warn">{readinessLabel(readiness)}</ComposerTrayRow>
                )
              ) : null}
              {/* Warn only about the CURRENT session: after a restart the
                replayed transcript may carry a previous session's source, but
                no session is live until the next send (which resets the source
                via session_started). Only a source that bills API usage warns:
                a subscription login reports `none`. */}
              {sessionId !== null && billingNotice !== null && !dismissedNotices.has(billingNotice) ? (
                <ComposerTrayRow tone="warn" onDismiss={() => dismissNotice(billingNotice)}>
                  {billingNotice}
                </ComposerTrayRow>
              ) : null}
              {sessionId !== null &&
              projection.sessionNotice !== null &&
              !dismissedNotices.has(projection.sessionNotice) ? (
                <ComposerTrayRow tone="warn" onDismiss={() => dismissNotice(projection.sessionNotice!)}>
                  {projection.sessionNotice}
                </ComposerTrayRow>
              ) : null}
              {/*
               * A permission change the provider recorded but cannot apply to
               * the turn already streaming (1808). Information, not a failure:
               * the pill already shows the new preset, and this says when it
               * starts applying.
               */}
              {permissionNotice ? (
                <ComposerTrayRow tone="neutral" onDismiss={() => setPermissionNotice(null)}>
                  <span className="text-[color:var(--text-muted)]">{permissionNotice}</span>
                </ComposerTrayRow>
              ) : null}
              {/* The shells and monitors the agent left running when its turn
                ended: a monitor it will wake for, a dev server it is done
                with. Only between turns, and only for a live session: a
                transcript read back after a restart names a process that is
                gone. */}
              {sessionId !== null && !projection.activeTurn ? (
                <BackgroundTasksTrayRow
                  tasks={projection.backgroundTasks}
                  seed={sessionId}
                  onStop={operate ? () => void interrupt() : undefined}
                  stopping={pending === 'stopping'}
                />
              ) : null}
              {/* The goal the agent keeps working toward by itself, turn after
                turn, and where it stands: during its turns as between them.
                Only for a live session, which says its goal again once it has
                read the thread's. */}
              {sessionId !== null ? <GoalTrayRow goal={projection.goal} seed={sessionId} /> : null}
              {requestPending ? null : (
                <>
                  <ConversationTodoStrip entries={shapeEntries} activeTurn={projection.activeTurn} />
                  {/* The prompt cache about to go cold, or gone: what the next
                    message puts at stake, and `/compact` — which Claude Code runs
                    as its own command — to shrink it. Only a Claude chat reports
                    a cache, and only a view that can send may offer to compact
                    it. */}
                  {operate && chatCli === 'claude-code' ? (
                    <PromptCacheComposerNotice
                      reading={projection.promptCache}
                      busy={composerBusy}
                      onCompact={() => void sendTurn('/compact')}
                      onHandoff={handoffEnabled ? () => void handoff() : undefined}
                    />
                  ) : null}
                  {contextReading ? (
                    <ContextWindowNotice
                      used={contextReading.used}
                      total={contextReading.total}
                      onCompact={
                        operate && (chatCli === 'claude-code' || chatCli === 'codex')
                          ? () => void sendTurn('/compact')
                          : undefined
                      }
                      compactDisabled={composerDisabled}
                    />
                  ) : null}
                </>
              )}

              {/*
               * Queued message: the user typed ahead and committed while the turn
               * was busy. It auto-sends the moment the session unlocks; Send now
               * hands it to the running turn (or stops the turn, where the
               * provider cannot take it mid-turn), and Edit takes it back into
               * the composer. Kept truthful so a queued turn is never a silent,
               * invisible pending action.
               */}
              {queuedTurn ? (
                <QueuedTurnRow
                  // The files it carries are named after the words, as the line
                  // has no room for their cards.
                  text={[queuedTurn.text, ...queuedTurn.metadata.files.map(attachedFileName)].filter(Boolean).join(' ')}
                  attachments={queuedTurn.attachments}
                  sendNow={operate ? queuedSendNow : { ...queuedSendNow, disabled: true }}
                  shortcutLabel={sendNowShortcutLabel}
                  onSendNow={() => sendQueuedNow(queuedTurn)}
                  onEdit={() => {
                    setDraft((current) => [queuedTurn.text, current].filter(Boolean).join('\n'))
                    setDraftMetadata({
                      skillIds: [...new Set([...queuedTurn.metadata.skillIds, ...draftMetadata.skillIds])],
                      mentions: [...queuedTurn.metadata.mentions, ...draftMetadata.mentions],
                      files: [...new Set([...queuedTurn.metadata.files, ...draftMetadata.files])],
                    })
                    setAttachments((current) =>
                      [...queuedTurn.attachments, ...current].slice(0, MAX_ATTACHMENTS_PER_TURN),
                    )
                    setQueuedTurn(null)
                    composerRef.current?.focus()
                  }}
                />
              ) : null}

              {/*
               * A chat on another machine that holds its own queue: what is on
               * its way there, then what that machine says it holds. It sends
               * them when the turn ends, whether or not this machine is awake
               * then. Stop and send stops the turn, which is what lets them go;
               * Edit takes one back from there into this composer.
               */}
              {hostQueue && handingOff.length > 0 ? (
                <QueuedTurnRow
                  text={handingOff.join('\n')}
                  attachments={[]}
                  sendNow={null}
                  shortcutLabel={sendNowShortcutLabel}
                  onSendNow={() => undefined}
                  status="Queuing"
                  statusHint={`On its way to ${hostQueue.machineName}, which sends it when this turn ends`}
                />
              ) : null}
              {hostQueue?.messages.map((message) => (
                <QueuedTurnRow
                  key={message.id}
                  text={message.text}
                  attachments={[]}
                  sendNow={
                    message.failure !== undefined
                      ? null
                      : operate
                        ? queuedSendNow
                        : { ...queuedSendNow, disabled: true }
                  }
                  shortcutLabel={sendNowShortcutLabel}
                  onSendNow={() => sendHostQueuedNow(message)}
                  {...(operate && transport.cancelQueued ? { onEdit: () => void takeBackHostQueued(message) } : {})}
                  failed={message.failure !== undefined}
                  status={message.failure !== undefined ? `Couldn't send: ${message.failure}` : 'Queued'}
                  statusHint={
                    message.failure !== undefined
                      ? `${hostQueue.machineName} could not send it when the turn ended`
                      : `${hostQueue.machineName} holds it and sends it when this turn ends`
                  }
                />
              ))}

              <ConversationPendingDock
                placement="tray"
                pendingApprovals={pendingApprovalEntries}
                workspaceRoot={workspaceRoot ?? undefined}
                onApprove={resolveApproval}
                modeSwitches={approvalModeSwitches}
                onApproveAndSwitch={approveAndSwitch}
                // Read-only: the pending requests are shown, not answerable.
                busy={respondingRequestId !== null || !operate}
              />

              {/* A turn a usage limit stopped: when the limit resets, and
                the resume Studio can send the chat then. Read on this
                computer, so only for a chat that runs here. */}
              {transport.kind !== 'remote' && !stripFacts.machine ? (
                <UsageLimitResumeRow workspaceId={workspaceId} agentId={agentId} />
              ) : null}

              {/* The messages scheduled into this chat from the "+": when each
                goes out, with Send now, Edit and Delete. Edit takes one back
                into the composer still set for its time, so pressing
                Schedule again puts it back. */}
              {scheduleOffered ? (
                <ScheduledMessageRows workspaceId={workspaceId} agentId={agentId} onEdit={editScheduledMessage} />
              ) : null}

              {/*
               * A turn failure renders as a structured error block in the
               * transcript (with its own Retry), so here we only restate text for
               * action errors that never reach the transcript (start/send/IPC) —
               * plus the orphan case: a turn_failed that attached to no turn (no
               * turnId while nothing was streaming) sets lastError without a
               * failed transcript entry, and must still surface somewhere in the
               * chat.
               */}
              {composerError && composerError !== dismissedError ? (
                <ComposerTrayRow
                  tone="error"
                  onDismiss={dismissComposerError}
                  actions={
                    composerRetry ? (
                      <OutlineButton size="xs" onClick={composerRetry} disabled={composerDisabled}>
                        Retry
                      </OutlineButton>
                    ) : null
                  }
                >
                  {composerError}
                </ComposerTrayRow>
              ) : null}
              {/* The stash ⌘S opened, against the box it restores into. */}
              {stashPicker.picker}
            </ComposerTray>

            {/*
             * Composer: the New chat composer's box (owner ruling 2026-10-04) —
             * the field, then one row under it: the "+" (attach, skills), a tag
             * for each skill attached, the engine chip (model, effort and
             * permissions) and send. The model is picked before the first
             * message, then locked. While an approval card is pending the
             * disabled placeholder says why the composer is waiting. Under the
             * box, the strip says where the agent works and how full its
             * context is.
             *
             * A question from the agent is answered in the box's place: the
             * card wears the composer's surface, and the composer is hidden
             * rather than unmounted, so its draft is still there when the
             * answer is in.
             */}
            {questionCoversComposer ? (
              <div
                className={`relative overflow-hidden ${COMPOSER_SURFACE_CLASS} border-[color:var(--border-default)]`}
              >
                <ConversationPendingDock
                  placement="composer"
                  pendingApprovals={pendingApprovalEntries}
                  workspaceRoot={workspaceRoot ?? undefined}
                  onApprove={resolveApproval}
                  busy={respondingRequestId !== null || !operate}
                  // Said only when something is waiting, so nobody retypes a
                  // message they believe the card replaced.
                  footnote={draftHeld ? 'Your draft is kept for after you answer' : null}
                />
              </div>
            ) : null}
            <div
              // The floating browser player parks clear of this box
              // (FloatingPlayer.clearOfComposer).
              data-chat-composer=""
              className={`relative transition-colors ${COMPOSER_SURFACE_CLASS} ${FOCUS_RING_WITHIN_EDITOR_CLASS} ${
                dropActive ? 'border-[color:var(--accent-primary)]' : 'border-[color:var(--border-default)]'
              } ${questionCoversComposer ? 'hidden' : ''}`}
            >
              {dropActive ? <ComposerDropOverlay ground="surface" /> : null}
              {contextPicker.picker}
              <ComposerAttachmentStrip
                attachments={attachments}
                reading={attachingCount}
                onRemove={removeAttachment}
                files={draftMetadata.files}
                onRemoveFile={removeDraftFile}
                className="px-5 pt-4"
              />
              {/* The files and folders @-mentioned into the draft. The skills
                  attached sit on the row under the field, as tags beside the
                  "+" that attached them. */}
              <ComposerContextChips
                mentions={draftMetadata.mentions}
                onRemoveMention={(mention) =>
                  setDraftMetadata((current) => ({
                    ...current,
                    mentions: current.mentions.filter((entry) => entry !== mention),
                  }))
                }
              />
              <div className="px-5 pb-1 pt-4">
                <ComposerField
                  ref={composerRef}
                  contentAttributes={{
                    'aria-label': `Message ${label}`,
                    ...contextPicker.comboboxProps,
                    ...stashPicker.comboboxProps,
                  }}
                  value={draft}
                  historyScope={`${workspaceId}\0${agentId}`}
                  onBlur={flushDraft}
                  leavesDrop={dataTransferHasDroppableFiles}
                  onPaste={(event, field) => {
                    // A pasted screenshot only exists as a clipboard item, and a
                    // file copied in Finder or Explorer pastes as the file: both
                    // attach as a drop of them would, where files attach by path.
                    // A text paste reports no file and falls through to the
                    // default — unless the text is only paths to images outside
                    // the workspace, which attach instead. A paste of nothing
                    // this chat attaches is left to the default too, as it
                    // always was; once one is taken, everything that came with
                    // it is taken as a drop of it would be — a path typed, a
                    // file with no path uploaded or said — and none dropped.
                    const pasted =
                      imagesEnabled || filesEnabled
                        ? sortFiles(filesFromDataTransfer(event.clipboardData), fileSorting)
                        : null
                    if (pasted && (pasted.images.length > 0 || pasted.files.length > 0)) {
                      event.preventDefault()
                      takeFiles(pasted)
                      return
                    }
                    if (!imagesEnabled) return
                    const text = event.clipboardData?.getData('text/plain') ?? ''
                    const paths = pastedImagePaths(
                      text,
                      transport.capabilities.localFiles && workspaceRoot ? [workspaceRoot] : [],
                    )
                    if (!paths) return
                    event.preventDefault()
                    void attachPastedPaths(paths, text, field.selectionStart, field.selectionEnd)
                  }}
                  onChange={(value, caret) => {
                    detachRecall()
                    setDraft(value)
                    setComposerCaret(caret)
                  }}
                  onSelectionChange={setComposerCaret}
                  onContextMenu={(event, field) => void openComposerMenu(event, field)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return
                    if (contextPicker.handleKeyDown(event)) return
                    if (stashPicker.handleKeyDown(event)) return
                    if (
                      event.key === 'Backspace' &&
                      event.currentTarget.selectionStart === 0 &&
                      event.currentTarget.selectionEnd === 0
                    ) {
                      if (draftMetadata.mentions.length) {
                        event.preventDefault()
                        setDraftMetadata((current) => ({ ...current, mentions: current.mentions.slice(0, -1) }))
                        return
                      }
                      if (draftMetadata.files.length) {
                        event.preventDefault()
                        setDraftMetadata((current) => ({ ...current, files: current.files.slice(0, -1) }))
                        return
                      }
                      if (supportsSkills && attachedSkills.length) {
                        event.preventDefault()
                        setAttachedSkills(attachedSkills.slice(0, -1))
                        return
                      }
                      if (attachments.length) {
                        event.preventDefault()
                        setAttachments((current) => current.slice(0, -1))
                        return
                      }
                    }
                    if (handleRecallKeyDown(event)) return
                    if (event.key === 'Escape' && stopsTurnOnEscape(event)) {
                      event.preventDefault()
                      void interrupt()
                      return
                    }
                    // ⌘⌥⏎ (`chat.sendAndNew`, rebindable): send, then New chat,
                    // only once the message has gone or been queued.
                    if (keydownMatchesKeybindings(event, sendAndNewKeys, keyPlatform)) {
                      event.preventDefault()
                      if (submitComposer()) runAppCommand('chat.new')
                      return
                    }
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
                      event.preventDefault()
                      commitComposerNow()
                      return
                    }
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      submitComposer()
                    }
                  }}
                  placeholder={composerPlaceholder}
                  disabled={composerInputDisabled}
                  className={COMPOSER_CLASS}
                />
              </div>
              {/* What the picked command takes after it, until the person types
                past the pick. Under the field rather than as ghost text in it,
                where it would sit among the words being typed and read as part
                of the draft. */}
              {commandHint && commandHint.draft === draft ? (
                <p className="truncate px-5 pb-1 font-mono text-meta text-[color:var(--text-subtle)]">
                  /{commandHint.command} {commandHint.hint}
                </p>
              ) : null}
              {/* The controls, on the box's own ground with no rule above
                  them: the "+", a tag for each skill attached, the engine and
                  the send — the New chat composer's row, so the two boxes are
                  one object. It is short enough not to fold; a pane too narrow
                  even for it wraps it rather than hiding a control. */}
              <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1.5">
                {/* Outside the menu: the picker it serves opens from a row of
                    the "+" menu, and the file arrives after that menu has gone.
                    Any file where files attach by path, images alone where
                    only images do. */}
                {imagesEnabled || filesEnabled ? (
                  <HiddenFileInput
                    ref={fileInputRef}
                    accept={filesEnabled ? undefined : ATTACHABLE_IMAGE_TYPES.join(',')}
                    onFiles={onPickedFiles}
                  />
                ) : null}
                {imagesEnabled || filesEnabled || supportsSkills || scheduleOption || sideQuestionOffered ? (
                  <ComposerPlusMenu
                    placement="top-start"
                    onAttach={imagesEnabled || filesEnabled ? openFilePicker : undefined}
                    schedule={scheduleOption}
                    skills={plusMenuSkills}
                    sideQuestion={sideQuestionOffered ? sideQuestionMenuRow : undefined}
                  />
                ) : null}
                {/* The tags: when the message is to go, then each skill attached to the next turn. */}
                {sendAt !== null ? (
                  <SendTimeTag at={sendAt} onChange={setSendAt} onRemove={() => setSendAt(null)} />
                ) : null}
                {supportsSkills
                  ? attachedSkills.map((skill) => (
                      <SkillContextChip
                        key={skill.id}
                        skill={skill}
                        onRemove={() => setAttachedSkills(attachedSkills.filter((entry) => entry.id !== skill.id))}
                        onOpen={() => skillReader.openSkill(skill)}
                      />
                    ))
                  : null}

                <span className="flex-1" />

                {chatCli ? (
                  <EnginePickerChip
                    cli={chatCli}
                    options={chatPickerOptions}
                    model={chatModel}
                    reasoning={reasoningEffort}
                    open={modelMenuOpen}
                    onOpenChange={setModelMenuOpen}
                    placement="top-start"
                    shortcutLabel={modelPickerShortcutLabel}
                    warn={composerPermissionWarn}
                    onSelectCli={() => selectModel(conversation.providerId, CONVERSATION_DEFAULT_MODEL_ID)}
                    onSelectModel={(_cli, next) =>
                      selectModel(conversation.providerId, next ?? CONVERSATION_DEFAULT_MODEL_ID)
                    }
                    onSelectReasoning={(_cli, next) => changeReasoningEffort(next ?? undefined)}
                    {...(modelLocked && modelSwitch
                      ? { groupNote: { cli: chatCli, note: '· model is set once the chat starts' } }
                      : {})}
                    // Permissions on the picker's trailing row beside effort, as
                    // a launch picks them: one place for how the agent runs.
                    // Where this chat cannot change them, the row has none.
                    permissions={composerPermissions ?? (() => null)}
                  />
                ) : (
                  // A provider that is not a CLI (an API-key provider) has no
                  // picker of this kind; its model is shown, not chosen.
                  <TruncatedText
                    as="span"
                    text={currentModelLabel}
                    className="max-w-[180px] px-1.5 text-meta text-[color:var(--text-muted)]"
                  />
                )}
                {/* With a time picked the send schedules, whatever the turn is
                    doing: Stop is not what a press means then. */}
                {sendAt !== null ? (
                  <SendButton
                    size="sm"
                    onClick={submitComposer}
                    disabled={!draft.trim()}
                    aria-keyshortcuts="Enter"
                    data-composer-schedule-send="true"
                    className="shrink-0 gap-1.5 pl-3 pr-2.5"
                  >
                    Schedule
                    <ScheduleGlyph className="icon-sm" />
                  </SendButton>
                ) : projection.activeTurn && !operate ? null : (
                  <>
                    {projection.activeTurn ? (
                      <ComposerActionButton
                        tone="neutral"
                        ariaLabel={pending === 'stopping' ? 'Stopping' : 'Stop responding'}
                        onClick={() => void interrupt()}
                        disabled={stopDisabledForPending(pending)}
                      >
                        <StopGlyph className="icon-sm shrink-0" />
                      </ComposerActionButton>
                    ) : null}
                    {/* While the agent works, the send says whether it queues
                        or steers. With nothing typed, Stop stands alone. */}
                    {composerBusy || startupHolding ? (
                      projection.activeTurn && sendAction.disabled ? null : (
                        <FollowUpSendButton
                          presentation={followUpPresentation}
                          platform={window.api?.platform}
                          disabled={sendAction.disabled}
                          onSend={(alternate) => (alternate ? commitComposerNow() : void submitComposer())}
                        />
                      )
                    ) : (
                      <ComposerActionButton
                        tone="accent"
                        ariaLabel={sendAction.label}
                        onClick={submitComposer}
                        disabled={sendAction.disabled}
                      >
                        <SendGlyph className="icon-sm shrink-0" />
                      </ComposerActionButton>
                    )}
                  </>
                )}
              </div>
              {/*
               * Right-click menu (1793): Send plus the standard editing actions, so
               * committing a turn is not limited to Enter and the button. Rendered
               * only while open — it positions itself at the click point.
               */}
              {composerMenu ? (
                <ComposerContextMenu
                  menu={composerMenu}
                  send={sendAction}
                  editable={!composerInputDisabled}
                  onSend={submitComposer}
                  onCut={() => {
                    const selected = draft.slice(composerMenu.selectionStart, composerMenu.selectionEnd)
                    void writeClipboardText(selected).then((written) => {
                      if (written) replaceComposerSelection(composerMenu, '')
                      else setActionError('Could not cut to the clipboard.')
                    })
                  }}
                  onCopy={() => {
                    const selected = draft.slice(composerMenu.selectionStart, composerMenu.selectionEnd)
                    void writeClipboardText(selected).then((written) => {
                      if (!written) setActionError('Could not copy to the clipboard.')
                    })
                  }}
                  onPaste={() => replaceComposerSelection(composerMenu, composerMenu.clipboardText)}
                  onClose={() => setComposerMenu(null)}
                />
              ) : null}
            </div>
            {/* Tokens only, never money: a chat runs on the person's CLI
                subscription, and the SDK's dollar figure is an API-price
                estimate that reads as a bill. */}
            <ConversationComposerStrip
              machine={stripFacts.machine}
              branch={stripFacts.branch}
              changes={stripFacts.changes}
              context={contextReading}
              contextBreakdown={contextBreakdownSource}
              pullRequests={conversationPullRequests}
              {...(transport.kind === 'remote' ? {} : { onStopWatchingPullRequest: stopWatchingPullRequest })}
              createPullRequest={createPullRequest}
              localServers={stripLocalServers}
              usageLimits={stripUsageLimits}
            />
          </div>
          {replay ? (
            <ConversationReplayView
              source={replay}
              title={label}
              assistantName={assistantName}
              cli={chatCli}
              onLeave={leaveReplay}
            />
          ) : null}
        </ChatShell>
      </SubagentTypesProvider>
      {skillReader.reader}
    </ConversationLinkProvider>
  )
}

// The chat panel is header-less by design: the tab already names the agent, and
// Model/session controls live in the composer footer. A saved conversation's
// editable title sits above the timeline so rename remains directly reachable.
function ChatShell({
  shellRef,
  dropHandlers,
  keyHandlers,
  children,
}: {
  shellRef?: React.RefObject<HTMLDivElement | null>
  dropHandlers?: React.HTMLAttributes<HTMLDivElement>
  keyHandlers?: Pick<React.HTMLAttributes<HTMLDivElement>, 'onKeyDown' | 'onPaste'>
  children: React.ReactNode
}) {
  return (
    <div
      ref={shellRef}
      {...dropHandlers}
      {...keyHandlers}
      // Scopes the chat contrast setting's inks (assets/index.css).
      data-chat-pane=""
      className="relative isolate flex h-full flex-col bg-[color:var(--agent-surface)] text-meta text-[color:var(--text-default)]"
    >
      {children}
    </div>
  )
}

// What the view reads off the transcript's shape, in one pass: the requests
// waiting in the dock, the latest failed turn (the one Retry re-sends), the
// turn left unfolded, the turns that can be reverted, the prompts recall steps
// through, and whether anything has been said yet.
function transcriptShape(entries: readonly TranscriptEntry[]) {
  const pendingApprovals: Extract<TranscriptEntry, { kind: 'approval' }>[] = []
  const promptHistory: string[] = []
  const checkpointSeqs = new Set<number>()
  let lastFailedTurnId: string | undefined
  let latestCompletedTurnId: string | undefined
  let hasUserMessage = false
  let hasConversation = false
  for (const entry of entries) {
    if (entry.kind === 'approval' && entry.status === 'pending') pendingApprovals.push(entry)
    if (entry.kind === 'user') {
      hasUserMessage = true
      hasConversation = true
      // Up recalls what the person typed, not what Studio sent the chat.
      if (entry.text && entry.origin?.kind !== 'studio') promptHistory.push(entry.text)
    }
    if (entry.kind !== 'assistant') continue
    hasConversation = true
    if (entry.status === 'failed') lastFailedTurnId = entry.turnId
    if (entry.status === 'complete') latestCompletedTurnId = entry.turnId
    if (entry.checkpointAvailable && entry.checkpointTurnSeq !== undefined) checkpointSeqs.add(entry.checkpointTurnSeq)
  }
  return {
    pendingApprovals,
    promptHistory,
    checkpointSeqs,
    lastFailedTurnId,
    latestCompletedTurnId,
    hasUserMessage,
    hasConversation,
    latestTurnId: latestReplyTurnId(entries),
  }
}

// The replies completed after the one the reader last saw, counted back from
// the end: a page of older history loaded above it adds none. A seen reply that
// has left the transcript (the conversation went back past it) leaves nothing
// to count from, so nothing is called new rather than everything; none seen at
// all makes every completed reply new.
export function repliesCompletedAfter(entries: readonly TranscriptEntry[], seenTurnId: string | null): number {
  let count = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (entry.kind !== 'assistant') continue
    if (seenTurnId !== null && entry.turnId === seenTurnId) return count
    if (entry.status === 'complete') count++
  }
  return seenTurnId === null ? count : 0
}

// Clipboard reads/writes go through the main process: an Electron renderer has
// no permission-free `navigator.clipboard` read, and the app already owns this
// bridge for the terminal. An unavailable bridge reads as an empty clipboard,
// which disables Paste rather than offering an item that would do nothing.
async function readClipboardText(): Promise<string> {
  if (typeof window.api?.clipboardReadText !== 'function') return ''
  try {
    return await window.api.clipboardReadText()
  } catch {
    return ''
  }
}

// Reports whether the text actually reached the clipboard: Cut removes the
// selection only on a true, so a failed write can never lose the text from both
// the draft and the clipboard.
async function writeClipboardText(text: string): Promise<boolean> {
  if (typeof window.api?.clipboardWriteText !== 'function') return false
  try {
    await window.api.clipboardWriteText(text)
    return true
  } catch {
    return false
  }
}
