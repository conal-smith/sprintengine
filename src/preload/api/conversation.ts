import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type {
  ConversationWorkspaceKey,
  ConversationThreadsResult,
  ConversationSearchInput,
  ConversationSearchResult,
  ConversationRenameInput,
} from '../../shared/conversation-index'
import type { ConversationSearchHit } from '../../shared/conversation-index'

import type {
  ConversationProviderListResult,
  ConversationProviderModelsInput,
  ConversationProviderModelsResult,
  ConversationSecretClearInput,
  ConversationSecretClearResult,
  ConversationSecretSetInput,
  ConversationSecretSetResult,
  ConversationSecretStatusInput,
  ConversationSecretStatusResult,
  ElectronApi,
} from '../../shared/electron-api'
import type {
  ConversationEvent,
  ConversationInterruptInput,
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
  ConversationProvidersListInput,
  ConversationProviderSignInInput,
  ConversationProviderSignInResult,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationAttachmentInput,
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
  ConversationForkInput,
  ConversationForkResult,
  ConversationApprovalRulesResult,
  ConversationApprovalRuleRevokeResult,
} from '../../shared/conversation-runtime'

type ConversationIpcRenderer = {
  on(
    channel: 'conversation:search:batch',
    listener: (event: IpcRendererEvent, batch: { requestId: string; hits: ConversationSearchHit[] }) => void,
  ): void
  removeListener(
    channel: 'conversation:search:batch',
    listener: (event: IpcRendererEvent, batch: { requestId: string; hits: ConversationSearchHit[] }) => void,
  ): void
  invoke(channel: 'conversation:threads', input: ConversationWorkspaceKey): Promise<ConversationThreadsResult>
  invoke(channel: 'conversation:search', input: ConversationSearchInput): Promise<ConversationSearchResult>
  invoke(channel: 'conversation:search:cancel', input: { requestId: string }): Promise<{ ok: boolean }>
  invoke(
    channel: 'conversation:rename',
    input: ConversationRenameInput,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  invoke(
    channel: 'conversation:delete',
    input: ConversationTranscriptInput,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  invoke(channel: 'conversation:approval-rules:list'): Promise<ConversationApprovalRulesResult>
  invoke(
    channel: 'conversation:approval-rules:revoke',
    input: { ruleId: string },
  ): Promise<ConversationApprovalRuleRevokeResult>
  invoke(channel: 'conversation:turn:diff', input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult>
  invoke(channel: 'conversation:turn:revert', input: ConversationRevertInput): Promise<ConversationRevertResult>
  invoke(channel: 'conversation:turn:rewind', input: ConversationRewindInput): Promise<ConversationRewindResult>
  invoke(channel: 'conversation:handoff', input: ConversationHandoffInput): Promise<ConversationHandoffResult>
  invoke(channel: 'conversation:turn:fork', input: ConversationForkInput): Promise<ConversationForkResult>
  invoke(
    channel: 'conversation:session:subscribe',
    input: ConversationSubscribeInput & { subscriptionId: string },
  ): Promise<{ ok: boolean; subscriptionId?: string; message?: string }>
  invoke(channel: 'conversation:session:unsubscribe', input: { subscriptionId: string }): Promise<{ ok: boolean }>
  invoke(channel: 'conversation:session:earlier', input: ConversationLoadEarlierInput): Promise<ConversationPageResult>
  on(
    channel: 'conversation:session-event',
    listener: (event: IpcRendererEvent, payload: { subscriptionId: string; frame: ConversationSessionFrame }) => void,
  ): void
  removeListener(
    channel: 'conversation:session-event',
    listener: (event: IpcRendererEvent, payload: { subscriptionId: string; frame: ConversationSessionFrame }) => void,
  ): void
  invoke(
    channel: 'conversation:providers:list',
    input?: ConversationProvidersListInput,
  ): Promise<ConversationProviderListResult>
  invoke(
    channel: 'conversation:providers:models',
    input: ConversationProviderModelsInput,
  ): Promise<ConversationProviderModelsResult>
  invoke(
    channel: 'conversation:providers:sign-in',
    input: ConversationProviderSignInInput,
  ): Promise<ConversationProviderSignInResult>
  invoke(
    channel: 'conversation:secrets:status',
    input: ConversationSecretStatusInput,
  ): Promise<ConversationSecretStatusResult>
  invoke(channel: 'conversation:secrets:set', input: ConversationSecretSetInput): Promise<ConversationSecretSetResult>
  invoke(
    channel: 'conversation:secrets:clear',
    input: ConversationSecretClearInput,
  ): Promise<ConversationSecretClearResult>
  invoke(
    channel: 'conversation:sessions:start',
    input: ConversationStartSessionInput,
  ): Promise<ConversationStartSessionResult>
  invoke(
    channel: 'conversation:sessions:send-turn',
    input: ConversationSendTurnInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:interrupt',
    input: ConversationInterruptInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:respond-to-request',
    input: ConversationRespondToRequestInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:set-permission',
    input: ConversationSetPermissionInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:set-model',
    input: ConversationSetModelInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:mcp-action',
    input: ConversationMcpServerActionInput,
  ): Promise<ConversationMcpServerActionResult>
  invoke(
    channel: 'conversation:sessions:stop-subagent',
    input: ConversationStopSubagentInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:side-question',
    input: ConversationSideQuestionInput,
  ): Promise<ConversationSideQuestionResult>
  invoke(
    channel: 'conversation:sessions:cancel-side-question',
    input: ConversationCancelSideQuestionInput,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  invoke(
    channel: 'conversation:sessions:stop',
    input: ConversationStopSessionInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:suspend',
    input: ConversationSuspendSessionInput,
  ): Promise<ConversationSessionActionResult>
  invoke(
    channel: 'conversation:sessions:terminal-handoff',
    input: ConversationTerminalHandoffInput,
  ): Promise<ConversationTerminalHandoffResult>
  invoke(
    channel: 'conversation:sessions:list',
    input?: ConversationListSessionsInput,
  ): Promise<ConversationListSessionsResult>
  invoke(channel: 'conversation:transcript', input: ConversationTranscriptInput): Promise<ConversationTranscriptResult>
  invoke(channel: 'conversation:tool-detail', input: ConversationToolDetailInput): Promise<ConversationToolDetailResult>
  invoke(channel: 'conversation:attachment', input: ConversationAttachmentInput): Promise<ConversationAttachmentResult>
  invoke(
    channel: 'conversation:plan-document',
    input: ConversationPlanDocumentInput,
  ): Promise<ConversationPlanDocumentResult>
  invoke(channel: 'conversation:events:subscribe'): Promise<{ ok: true; subscriptionId: string }>
  invoke(
    channel: 'conversation:events:unsubscribe',
    input: { subscriptionId: string },
  ): Promise<{ ok: true } | { ok: false; message: string }>
  on(channel: 'conversation:event', listener: (event: IpcRendererEvent, payload: ConversationEvent) => void): void
  removeListener(
    channel: 'conversation:event',
    listener: (event: IpcRendererEvent, payload: ConversationEvent) => void,
  ): void
}

export function createConversationApi(renderer: ConversationIpcRenderer) {
  const callbacks = new Set<(event: ConversationEvent) => void>()
  let subscription: Promise<{ ok: true; subscriptionId: string }> | undefined
  const listener = (_event: IpcRendererEvent, payload: ConversationEvent) => {
    for (const callback of callbacks) {
      try {
        callback(payload)
      } catch {
        callbacks.delete(callback)
      }
    }
  }
  let nextScopedId = 0
  return {
    conversationThreads: (input: ConversationWorkspaceKey) => renderer.invoke('conversation:threads', input),
    conversationSearch: (input: ConversationSearchInput) => renderer.invoke('conversation:search', input),
    onConversationSearchBatch: (callback: (batch: { requestId: string; hits: ConversationSearchHit[] }) => void) => {
      const receive = (_event: IpcRendererEvent, batch: { requestId: string; hits: ConversationSearchHit[] }) =>
        callback(batch)
      renderer.on('conversation:search:batch', receive)
      return () => renderer.removeListener('conversation:search:batch', receive)
    },
    conversationCancelSearch: (input: { requestId: string }) => renderer.invoke('conversation:search:cancel', input),
    conversationRename: (input: ConversationRenameInput) => renderer.invoke('conversation:rename', input),
    conversationDelete: (input: ConversationTranscriptInput) => renderer.invoke('conversation:delete', input),
    conversationApprovalRules: (): Promise<ConversationApprovalRulesResult> =>
      renderer.invoke('conversation:approval-rules:list'),
    conversationRevokeApprovalRule: (input: { ruleId: string }): Promise<ConversationApprovalRuleRevokeResult> =>
      renderer.invoke('conversation:approval-rules:revoke', input),
    conversationTurnDiff: (input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult> =>
      renderer.invoke('conversation:turn:diff', input),
    conversationRevertToTurn: (input: ConversationRevertInput): Promise<ConversationRevertResult> =>
      renderer.invoke('conversation:turn:revert', input),
    conversationRewindToTurn: (input: ConversationRewindInput): Promise<ConversationRewindResult> =>
      renderer.invoke('conversation:turn:rewind', input),
    conversationHandoff: (input: ConversationHandoffInput): Promise<ConversationHandoffResult> =>
      renderer.invoke('conversation:handoff', input),
    conversationForkAtTurn: (input: ConversationForkInput): Promise<ConversationForkResult> =>
      renderer.invoke('conversation:turn:fork', input),
    conversationProvidersList: (input?: ConversationProvidersListInput): Promise<ConversationProviderListResult> =>
      renderer.invoke('conversation:providers:list', input),
    conversationProviderModels: (input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult> =>
      renderer.invoke('conversation:providers:models', input),
    conversationProviderSignIn: (input: ConversationProviderSignInInput): Promise<ConversationProviderSignInResult> =>
      renderer.invoke('conversation:providers:sign-in', input),
    conversationSecretStatus: (input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult> =>
      renderer.invoke('conversation:secrets:status', input),
    conversationSecretSet: (input: ConversationSecretSetInput): Promise<ConversationSecretSetResult> =>
      renderer.invoke('conversation:secrets:set', input),
    conversationSecretClear: (input: ConversationSecretClearInput): Promise<ConversationSecretClearResult> =>
      renderer.invoke('conversation:secrets:clear', input),
    conversationSessionStart: (input: ConversationStartSessionInput): Promise<ConversationStartSessionResult> =>
      renderer.invoke('conversation:sessions:start', input),
    conversationSessionSendTurn: (input: ConversationSendTurnInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:send-turn', input),
    conversationSessionInterrupt: (input: ConversationInterruptInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:interrupt', input),
    conversationSessionRespondToRequest: (
      input: ConversationRespondToRequestInput,
    ): Promise<ConversationSessionActionResult> => renderer.invoke('conversation:sessions:respond-to-request', input),
    conversationSessionSetPermission: (
      input: ConversationSetPermissionInput,
    ): Promise<ConversationSessionActionResult> => renderer.invoke('conversation:sessions:set-permission', input),
    conversationSessionSetModel: (input: ConversationSetModelInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:set-model', input),
    conversationSessionMcpAction: (
      input: ConversationMcpServerActionInput,
    ): Promise<ConversationMcpServerActionResult> => renderer.invoke('conversation:sessions:mcp-action', input),
    conversationSessionStopSubagent: (input: ConversationStopSubagentInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:stop-subagent', input),
    conversationSessionAskSideQuestion: (
      input: ConversationSideQuestionInput,
    ): Promise<ConversationSideQuestionResult> => renderer.invoke('conversation:sessions:side-question', input),
    conversationSessionCancelSideQuestion: (
      input: ConversationCancelSideQuestionInput,
    ): Promise<{ ok: true } | { ok: false; message: string }> =>
      renderer.invoke('conversation:sessions:cancel-side-question', input),
    conversationSessionStop: (input: ConversationStopSessionInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:stop', input),
    conversationSessionSuspend: (input: ConversationSuspendSessionInput): Promise<ConversationSessionActionResult> =>
      renderer.invoke('conversation:sessions:suspend', input),
    conversationSessionTerminalHandoff: (
      input: ConversationTerminalHandoffInput,
    ): Promise<ConversationTerminalHandoffResult> => renderer.invoke('conversation:sessions:terminal-handoff', input),
    conversationSessionsList: (input?: ConversationListSessionsInput): Promise<ConversationListSessionsResult> =>
      renderer.invoke('conversation:sessions:list', input),
    conversationTranscript: (input: ConversationTranscriptInput): Promise<ConversationTranscriptResult> =>
      renderer.invoke('conversation:transcript', input),
    conversationToolDetail: (input: ConversationToolDetailInput): Promise<ConversationToolDetailResult> =>
      renderer.invoke('conversation:tool-detail', input),
    conversationAttachment: (input: ConversationAttachmentInput): Promise<ConversationAttachmentResult> =>
      renderer.invoke('conversation:attachment', input),
    conversationPlanDocument: (input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult> =>
      renderer.invoke('conversation:plan-document', input),
    conversationLoadEarlier: (input: ConversationLoadEarlierInput): Promise<ConversationPageResult> =>
      renderer.invoke('conversation:session:earlier', input),
    onConversationSession: (
      input: ConversationSubscribeInput,
      cb: (frame: ConversationSessionFrame) => void,
    ): (() => void) => {
      const subscriptionId = `panel-${Date.now()}-${++nextScopedId}`
      let disposed = false
      const receive = (
        _event: IpcRendererEvent,
        payload: { subscriptionId: string; frame: ConversationSessionFrame },
      ) => {
        if (!disposed && payload.subscriptionId === subscriptionId) cb(payload.frame)
      }
      renderer.on('conversation:session-event', receive)
      const subscribed = renderer.invoke('conversation:session:subscribe', { ...input, subscriptionId })
      void subscribed
        .then((result) => {
          if (!disposed && !result.ok)
            cb({ type: 'error', message: result.message ?? 'Conversation subscription failed.' })
        })
        .catch((error) => {
          if (!disposed) cb({ type: 'error', message: String(error) })
        })
      return () => {
        if (disposed) return
        disposed = true
        renderer.removeListener('conversation:session-event', receive)
        void subscribed
          .then(() => renderer.invoke('conversation:session:unsubscribe', { subscriptionId }))
          .catch(() => undefined)
      }
    },
    onConversationEvent: (cb: (event: ConversationEvent) => void): (() => void) => {
      callbacks.add(cb)
      if (!subscription) {
        renderer.on('conversation:event', listener)
        subscription = renderer.invoke('conversation:events:subscribe')
        void subscription.catch(() => undefined)
      }
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        callbacks.delete(cb)
        if (callbacks.size > 0) return
        renderer.removeListener('conversation:event', listener)
        const pending = subscription
        subscription = undefined
        void pending
          ?.then((result) => {
            void renderer.invoke('conversation:events:unsubscribe', { subscriptionId: result.subscriptionId })
          })
          .catch(() => undefined)
      }
    },
  } satisfies Pick<
    ElectronApi,
    | 'conversationProvidersList'
    | 'conversationThreads'
    | 'conversationSearch'
    | 'onConversationSearchBatch'
    | 'conversationCancelSearch'
    | 'conversationRename'
    | 'conversationDelete'
    | 'conversationProviderModels'
    | 'conversationProviderSignIn'
    | 'conversationSecretStatus'
    | 'conversationSecretSet'
    | 'conversationSecretClear'
    | 'conversationSessionStart'
    | 'conversationSessionSendTurn'
    | 'conversationSessionInterrupt'
    | 'conversationSessionRespondToRequest'
    | 'conversationSessionSetPermission'
    | 'conversationSessionSetModel'
    | 'conversationSessionMcpAction'
    | 'conversationSessionStopSubagent'
    | 'conversationSessionAskSideQuestion'
    | 'conversationSessionCancelSideQuestion'
    | 'conversationSessionStop'
    | 'conversationSessionSuspend'
    | 'conversationSessionTerminalHandoff'
    | 'conversationSessionsList'
    | 'conversationTranscript'
    | 'conversationToolDetail'
    | 'conversationAttachment'
    | 'conversationPlanDocument'
    | 'conversationLoadEarlier'
    | 'conversationTurnDiff'
    | 'conversationRevertToTurn'
    | 'conversationRewindToTurn'
    | 'conversationHandoff'
    | 'conversationForkAtTurn'
    | 'conversationApprovalRules'
    | 'conversationRevokeApprovalRule'
    | 'onConversationSession'
    | 'onConversationEvent'
  >
}

export const conversationApi = createConversationApi(ipcRenderer)
