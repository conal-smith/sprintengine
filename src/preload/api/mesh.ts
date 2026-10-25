import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'

import {
  MESH_BROWSE_CHANNEL,
  MESH_CREATE_CONVERSATION_CHANNEL,
  MESH_SETTLE_CONVERSATION_CHANNEL,
  MESH_VISIT_CONVERSATION_CHANNEL,
  MESH_CHANGE_CONVERSATION_CHANNEL,
  MESH_WORKSPACE_CHECKOUT_CHANNEL,
  MESH_WORKSPACE_EXTENSIONS_CHANNEL,
  MESH_FORGET_CHANNEL,
  MESH_GET_LIVE_STATE_CHANNEL,
  MESH_LIST_CONNECTIONS_CHANNEL,
  MESH_CANCEL_PAIRING_CHANNEL,
  MESH_CHECK_REACHABILITY_CHANNEL,
  MESH_PAIR_CHANNEL,
  MESH_REQUEST_PAIRING_CHANNEL,
  MESH_EVENT_CHANNEL,
  type MeshBrowse,
  type MeshConnection,
  type MeshCreateConversationResult,
  type MeshNewChatWorktree,
  type MeshSettleConversationResult,
  type MeshChangeConversationResult,
  type MeshConversationChange,
  type MeshVisitConversationResult,
  type MeshWorkspaceCheckoutResult,
  type MeshWorkspaceExtensionsResult,
  type MeshEvent,
  type MeshLiveState,
  type MeshPairResult,
  type MeshRequestPairingResult,
  meshConversationFrameChannel,
  MESH_CONVERSATION_COMMAND_CHANNEL,
  MESH_CONVERSATION_EARLIER_CHANNEL,
  MESH_CONVERSATION_FOLLOW_CHANNEL,
  MESH_CONVERSATION_LIST_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_CREATE_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_DRAFT_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_PUSH_CHANNEL,
  MESH_CONVERSATION_PULL_REQUEST_STATE_CHANNEL,
  MESH_CONVERSATION_SEND_CHANNEL,
  MESH_CONVERSATION_TOOL_DETAIL_CHANNEL,
  MESH_CONVERSATION_TOOL_IMAGE_CHANNEL,
  MESH_CONVERSATION_TURN_DIFF_CHANNEL,
  MESH_CONVERSATION_UNFOLLOW_CHANNEL,
  type MeshConversationCommand,
  type MeshConversationCommandResult,
  type MeshConversationFrame,
  type MeshConversationKey,
  type MeshConversationImageResult,
  type MeshConversationListResult,
  type MeshPullRequestCreateResult,
  type MeshPullRequestDraftResult,
  type MeshPullRequestPushResult,
  type MeshPullRequestStateResult,
} from '../../shared/tailnet-mesh'
import type { PullRequestCheckoutPin } from '../../shared/git/pull-request-create'
import type {
  ConversationImageAttachment,
  ConversationPageResult,
  ConversationToolDetailResult,
  ConversationTurnDiffResult,
} from '../../shared/conversation-runtime'
import type { TailnetScope } from '../../shared/tailnet'
import type { CliPermissionPreset } from '../../shared/cli-permission-preset'
import type { ElectronApi } from '../../shared/electron-api'

// The Mesh's data path: the machines this Studio drives, what they
// hold, and the terminals it has open on them.
//
// Nothing here carries a credential. The device tokens stay in main, which is
// also the only place that can dial the listener at all — it refuses any
// request with an `Origin` header, and a renderer always sends one.
export const meshApi = {
  meshListConnections: (): Promise<MeshConnection[]> =>
    ipcRenderer.invoke(MESH_LIST_CONNECTIONS_CHANNEL) as Promise<MeshConnection[]>,
  meshPair: (pairingUrl: string): Promise<MeshPairResult> =>
    ipcRenderer.invoke(MESH_PAIR_CHANNEL, { pairingUrl }) as Promise<MeshPairResult>,
  meshRequestPairing: (
    endpoint: string,
    options?: { scopes?: TailnetScope[]; reverseScopes?: TailnetScope[] },
  ): Promise<MeshRequestPairingResult> =>
    ipcRenderer.invoke(MESH_REQUEST_PAIRING_CHANNEL, {
      endpoint,
      // Omitted rather than sent empty when the caller names nothing, so each
      // end's own default stays in force.
      ...(options?.scopes ? { scopes: options.scopes } : {}),
      ...(options?.reverseScopes ? { reverseScopes: options.reverseScopes } : {}),
    }) as Promise<MeshRequestPairingResult>,
  meshCheckReachability: (connectionId?: string): Promise<MeshLiveState> =>
    ipcRenderer.invoke(MESH_CHECK_REACHABILITY_CHANNEL, connectionId ?? null) as Promise<MeshLiveState>,
  meshCancelPairing: (requestId: string): Promise<void> =>
    ipcRenderer.invoke(MESH_CANCEL_PAIRING_CHANNEL, requestId) as Promise<void>,
  meshForget: (connectionId: string): Promise<MeshConnection[]> =>
    ipcRenderer.invoke(MESH_FORGET_CHANNEL, connectionId) as Promise<MeshConnection[]>,
  meshBrowse: (connectionId: string): Promise<MeshBrowse> =>
    ipcRenderer.invoke(MESH_BROWSE_CHANNEL, connectionId) as Promise<MeshBrowse>,
  meshCreateConversation: (input: {
    connectionId: string
    workspaceId: string
    cli?: string
    prompt?: string
    cliModel?: string
    permissionPreset?: string
    /** The CLI's effort level; dropped for a machine that does not advertise `new-chat-effort`. */
    effort?: string
    /** A worktree to start in; refused, never dropped, by a machine without the capability for it. */
    worktree?: MeshNewChatWorktree
    /** Images that go with the first message; main puts them in that machine's upload store first. */
    attachments?: ConversationImageAttachment[]
    skills?: string[]
  }): Promise<MeshCreateConversationResult> => {
    const { attachments, skills, ...rest } = input
    return ipcRenderer.invoke(MESH_CREATE_CONVERSATION_CHANNEL, {
      ...rest,
      ...(attachments?.length ? { attachments } : {}),
      ...(skills?.length ? { skills } : {}),
    }) as Promise<MeshCreateConversationResult>
  },
  meshSettleConversation: (input: {
    connectionId: string
    workspaceId: string
    settled?: boolean
  }): Promise<MeshSettleConversationResult> =>
    ipcRenderer.invoke(MESH_SETTLE_CONVERSATION_CHANNEL, input) as Promise<MeshSettleConversationResult>,
  meshVisitConversation: (input: { connectionId: string; workspaceId: string }): Promise<MeshVisitConversationResult> =>
    ipcRenderer.invoke(MESH_VISIT_CONVERSATION_CHANNEL, input) as Promise<MeshVisitConversationResult>,
  meshChangeConversation: (input: {
    connectionId: string
    workspaceId: string
    change: MeshConversationChange
  }): Promise<MeshChangeConversationResult> =>
    ipcRenderer.invoke(MESH_CHANGE_CONVERSATION_CHANNEL, input) as Promise<MeshChangeConversationResult>,
  meshWorkspaceCheckout: (connectionId: string, workspaceId: string): Promise<MeshWorkspaceCheckoutResult> =>
    ipcRenderer.invoke(MESH_WORKSPACE_CHECKOUT_CHANNEL, {
      connectionId,
      workspaceId,
    }) as Promise<MeshWorkspaceCheckoutResult>,
  meshWorkspaceExtensions: (input: {
    connectionId: string
    workspaceId: string
    cli?: string
  }): Promise<MeshWorkspaceExtensionsResult> =>
    ipcRenderer.invoke(MESH_WORKSPACE_EXTENSIONS_CHANNEL, input) as Promise<MeshWorkspaceExtensionsResult>,
  // Whole-app mesh lifecycle (remote-sessions-ux): machine paired/forgotten,
  // reachability and pairing waits, broadcast to every window.
  meshGetLiveState: (): Promise<MeshLiveState> =>
    ipcRenderer.invoke(MESH_GET_LIVE_STATE_CHANNEL) as Promise<MeshLiveState>,
  onMeshEvent: (cb: (event: MeshEvent) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, event: MeshEvent) => cb(event)
    ipcRenderer.on(MESH_EVENT_CHANNEL, handler)
    return () => ipcRenderer.removeListener(MESH_EVENT_CHANNEL, handler)
  },
  meshConversationList: (connectionId: string): Promise<MeshConversationListResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_LIST_CHANNEL, connectionId) as Promise<MeshConversationListResult>,
  // The same shape as `onConversationSession`: listen first, then ask main
  // to follow, and hand back the unsubscribe. A follow that could not start
  // reaches the callback as an `error` frame, never as a throw.
  onMeshConversationSession: (
    input: { key: MeshConversationKey; turnLimit?: number },
    cb: (frame: MeshConversationFrame) => void,
  ): (() => void) => {
    const followId = `follow-${Date.now()}-${++nextFollowId}`
    const channel = meshConversationFrameChannel(followId)
    let disposed = false
    const handler = (_: IpcRendererEvent, frame: MeshConversationFrame) => {
      if (!disposed) cb(frame)
    }
    ipcRenderer.on(channel, handler)
    const followed = ipcRenderer.invoke(MESH_CONVERSATION_FOLLOW_CHANNEL, { followId, ...input }) as Promise<
      { ok: true } | { ok: false; code: string; message: string }
    >
    void followed
      .then((result) => {
        if (!disposed && !result.ok) cb({ type: 'error', message: result.message })
      })
      .catch((error: unknown) => {
        if (!disposed) cb({ type: 'error', message: String(error) })
      })
    return () => {
      if (disposed) return
      disposed = true
      ipcRenderer.removeListener(channel, handler)
      void followed.then(() => ipcRenderer.invoke(MESH_CONVERSATION_UNFOLLOW_CHANNEL, followId)).catch(() => undefined)
    }
  },
  meshConversationLoadEarlier: (input: {
    key: MeshConversationKey
    beforeCursor: number
    turnLimit?: number
  }): Promise<ConversationPageResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_EARLIER_CHANNEL, input) as Promise<ConversationPageResult>,
  meshConversationSend: (input: {
    key: MeshConversationKey
    message: string
    attachments?: ConversationImageAttachment[]
    queue?: boolean
    skills?: string[]
    steer?: boolean
    mode?: 'default' | 'plan' | 'ask'
  }): Promise<MeshConversationCommandResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_SEND_CHANNEL, {
      key: input.key,
      message: input.message,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.queue ? { queue: true } : {}),
      ...(input.skills?.length ? { skills: input.skills } : {}),
      ...(input.steer ? { steer: true } : {}),
      ...(input.mode && input.mode !== 'default' ? { mode: input.mode } : {}),
    }) as Promise<MeshConversationCommandResult>,
  meshConversationCancelQueued: (input: { key: MeshConversationKey; queuedId: string }) =>
    command(input.key, { kind: 'cancelQueued', queuedId: input.queuedId }),
  meshConversationInterrupt: (input: { key: MeshConversationKey }) => command(input.key, { kind: 'interrupt' }),
  meshConversationStopSubagent: (input: { key: MeshConversationKey; toolUseId: string }) =>
    command(input.key, { kind: 'stopSubagent', toolUseId: input.toolUseId }),
  meshConversationResolveApproval: (input: {
    key: MeshConversationKey
    requestId: string
    decision: 'once' | 'conversation' | 'deny'
  }) => command(input.key, { kind: 'resolveApproval', requestId: input.requestId, decision: input.decision }),
  meshConversationAnswerQuestion: (input: {
    key: MeshConversationKey
    requestId: string
    answers: Record<string, string>
  }) => command(input.key, { kind: 'answerQuestion', requestId: input.requestId, answers: input.answers }),
  meshConversationSetPermissionPreset: (input: {
    key: MeshConversationKey
    preset: CliPermissionPreset
    permissionMode?: string
  }) =>
    command(input.key, {
      kind: 'setPermissionPreset',
      preset: input.preset,
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    }),
  meshConversationSetModel: (input: { key: MeshConversationKey; modelId: string }) =>
    command(input.key, { kind: 'setModel', modelId: input.modelId }),
  meshConversationSetReasoningEffort: (input: { key: MeshConversationKey; effort?: string }) =>
    command(input.key, { kind: 'setReasoningEffort', ...(input.effort ? { effort: input.effort } : {}) }),
  meshConversationMcpServerAction: (input: {
    key: MeshConversationKey
    serverId: string
    action: 'reconnect' | 'enable' | 'disable'
  }) => command(input.key, { kind: 'mcpServerAction', serverId: input.serverId, action: input.action }),
  meshConversationToolDetail: (input: {
    key: MeshConversationKey
    toolUseId: string
  }): Promise<ConversationToolDetailResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_TOOL_DETAIL_CHANNEL, input) as Promise<ConversationToolDetailResult>,
  meshConversationTurnDiff: (input: {
    key: MeshConversationKey
    turnSeq: number
    path?: string
  }): Promise<ConversationTurnDiffResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_TURN_DIFF_CHANNEL, input) as Promise<ConversationTurnDiffResult>,
  meshConversationToolImage: (input: {
    key: MeshConversationKey
    toolUseId: string
  }): Promise<MeshConversationImageResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_TOOL_IMAGE_CHANNEL, input) as Promise<MeshConversationImageResult>,
  // A remote chat's Create PR: each step runs on the chat's machine.
  meshConversationPullRequestState: (input: { key: MeshConversationKey }): Promise<MeshPullRequestStateResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_PULL_REQUEST_STATE_CHANNEL, input) as Promise<MeshPullRequestStateResult>,
  meshConversationPullRequestDraft: (input: {
    key: MeshConversationKey
    draftId?: string
  }): Promise<MeshPullRequestDraftResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_PULL_REQUEST_DRAFT_CHANNEL, input) as Promise<MeshPullRequestDraftResult>,
  meshConversationPullRequestDraftCancel: (input: {
    key: MeshConversationKey
    draftId: string
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }> =>
    ipcRenderer.invoke(MESH_CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_CHANNEL, input) as Promise<
      { ok: true } | { ok: false; code: string; message: string }
    >,
  meshConversationPullRequestPush: (input: {
    key: MeshConversationKey
    pin?: PullRequestCheckoutPin
  }): Promise<MeshPullRequestPushResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_PULL_REQUEST_PUSH_CHANNEL, input) as Promise<MeshPullRequestPushResult>,
  meshConversationPullRequestCreate: (input: {
    key: MeshConversationKey
    title: string
    body: string
    pin?: PullRequestCheckoutPin
  }): Promise<MeshPullRequestCreateResult> =>
    ipcRenderer.invoke(MESH_CONVERSATION_PULL_REQUEST_CREATE_CHANNEL, input) as Promise<MeshPullRequestCreateResult>,
} satisfies Pick<
  ElectronApi,
  | 'meshListConnections'
  | 'meshPair'
  | 'meshRequestPairing'
  | 'meshCancelPairing'
  | 'meshCheckReachability'
  | 'meshForget'
  | 'meshBrowse'
  | 'meshCreateConversation'
  | 'meshSettleConversation'
  | 'meshVisitConversation'
  | 'meshChangeConversation'
  | 'meshWorkspaceCheckout'
  | 'meshWorkspaceExtensions'
  | 'meshGetLiveState'
  | 'onMeshEvent'
  | 'meshConversationList'
  | 'onMeshConversationSession'
  | 'meshConversationLoadEarlier'
  | 'meshConversationSend'
  | 'meshConversationCancelQueued'
  | 'meshConversationInterrupt'
  | 'meshConversationStopSubagent'
  | 'meshConversationResolveApproval'
  | 'meshConversationAnswerQuestion'
  | 'meshConversationSetPermissionPreset'
  | 'meshConversationSetModel'
  | 'meshConversationSetReasoningEffort'
  | 'meshConversationMcpServerAction'
  | 'meshConversationToolDetail'
  | 'meshConversationTurnDiff'
  | 'meshConversationToolImage'
  | 'meshConversationPullRequestState'
  | 'meshConversationPullRequestDraft'
  | 'meshConversationPullRequestDraftCancel'
  | 'meshConversationPullRequestPush'
  | 'meshConversationPullRequestCreate'
>

let nextFollowId = 0

function command(key: MeshConversationKey, input: MeshConversationCommand): Promise<MeshConversationCommandResult> {
  return ipcRenderer.invoke(MESH_CONVERSATION_COMMAND_CHANNEL, {
    key,
    command: input,
  }) as Promise<MeshConversationCommandResult>
}
