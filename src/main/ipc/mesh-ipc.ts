import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import {
  MESH_BROWSE_CHANNEL,
  MESH_CREATE_CONVERSATION_CHANNEL,
  MESH_SETTLE_CONVERSATION_CHANNEL,
  MESH_VISIT_CONVERSATION_CHANNEL,
  MESH_CHANGE_CONVERSATION_CHANNEL,
  MESH_CONVERSATION_DELETE_PLAN_CHANNEL,
  MESH_CONVERSATION_SEARCH_CHANNEL,
  MESH_WORKSPACE_CHECKOUT_CHANNEL,
  MESH_WORKSPACE_EXTENSIONS_CHANNEL,
  MESH_FORGET_CHANNEL,
  MESH_GET_LIVE_STATE_CHANNEL,
  MESH_LIST_CONNECTIONS_CHANNEL,
  MESH_CANCEL_PAIRING_CHANNEL,
  MESH_CHECK_REACHABILITY_CHANNEL,
  MESH_PAIR_CHANNEL,
  MESH_REQUEST_PAIRING_CHANNEL,
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
  type MeshConversationFrame,
} from '../../shared/tailnet-mesh'
import type { AutomationService } from '../automation/automation-service'
import { asRecord } from '../../shared/records'

// The window's door onto the Mesh.
//
// IPC-only, exactly like the tailnet configuration channels: no MCP tool
// reaches any of this, so neither a local agent nor a paired remote device can
// make this machine pair with a third one, enumerate what it is paired with, or
// follow a conversation somewhere else. Pairing another machine is a decision a
// person makes at this keyboard.
//
// A followed conversation is owned by the WINDOW that followed it. A window
// that closes or reloads has no pane left to paint, so its follows end with it
// rather than streaming into a destroyed sender.

export function registerMeshIpc(ipcMain: IpcMain, service: AutomationService): void {
  // followId -> the window following.
  const followers = new Map<string, WebContents>()
  const trackedSenders = new Set<number>()

  const releaseSender = (senderId: number): void => {
    for (const [followId, sender] of [...followers]) {
      if (sender.id !== senderId) continue
      followers.delete(followId)
      service.mesh().unfollowConversation(followId)
    }
    trackedSenders.delete(senderId)
  }

  const trackSender = (event: IpcMainInvokeEvent): void => {
    if (trackedSenders.has(event.sender.id)) return
    trackedSenders.add(event.sender.id)
    event.sender.once('destroyed', () => releaseSender(event.sender.id))
  }

  ipcMain.handle(MESH_LIST_CONNECTIONS_CHANNEL, () => service.mesh().listConnections())
  // The initial read behind `mesh:event`: the requests waiting and each
  // machine's last reachability, so a reloaded window starts where it was.
  ipcMain.handle(MESH_GET_LIVE_STATE_CHANNEL, () => service.mesh().getLiveState())
  ipcMain.handle(MESH_PAIR_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.mesh().pair({ pairingUrl: record?.pairingUrl, deviceName: record?.deviceName })
  })
  // Asking a machine to pair, and polling the answer. Like every other
  // `mesh:*` channel this is IPC-only: pairing WITH a machine stays a decision
  // made at this keyboard, reachable from no MCP tool.
  ipcMain.handle(MESH_REQUEST_PAIRING_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.mesh().requestPairing({
      endpoint: record?.endpoint,
      deviceName: record?.deviceName,
      // Both halves of a both-ways pairing carry their own set: `scopes` is
      // what this machine asks to do THERE, `reverseScopes` what that machine
      // may do here. Absent leaves each end's own default in force.
      scopes: record?.scopes,
      reverseScopes: record?.reverseScopes,
    })
  })
  // Reachability on demand (the row's Retry): main already checks on start,
  // wake, and a timer; this is the person asking for one more, now.
  ipcMain.handle(MESH_CHECK_REACHABILITY_CHANNEL, (_event, connectionId: unknown) =>
    service.mesh().checkReachability(typeof connectionId === 'string' ? connectionId : undefined),
  )
  ipcMain.handle(MESH_CANCEL_PAIRING_CHANNEL, (_event, requestId: unknown) => {
    service.mesh().cancelPairing(requestId)
  })
  ipcMain.handle(MESH_FORGET_CHANNEL, (_event, connectionId: unknown) => service.mesh().forget(connectionId))
  ipcMain.handle(MESH_BROWSE_CHANNEL, (_event, connectionId: unknown) => service.mesh().browse(connectionId))
  ipcMain.handle(MESH_CREATE_CONVERSATION_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().createConversation({
      connectionId: record.connectionId,
      workspaceId: record.workspaceId,
      cli: record.cli,
      prompt: record.prompt,
      cliModel: record.cliModel,
      permissionPreset: record.permissionPreset,
      effort: record.effort,
      worktree: record.worktree,
      attachments: record.attachments,
      skills: record.skills,
    })
  })
  // A remote chat's rest and visit clock, kept by the machine it runs on.
  ipcMain.handle(MESH_SETTLE_CONVERSATION_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().settleConversation({
      connectionId: record.connectionId,
      workspaceId: record.workspaceId,
      settled: record.settled,
    })
  })
  ipcMain.handle(MESH_VISIT_CONVERSATION_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().visitConversation({
      connectionId: record.connectionId,
      workspaceId: record.workspaceId,
    })
  })
  // A remote chat's row menu: its star, colour, snooze, Auto-settle and Mark
  // unread, kept by the machine it runs on.
  ipcMain.handle(MESH_CHANGE_CONVERSATION_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().changeConversation({
      connectionId: record.connectionId,
      workspaceId: record.workspaceId,
      change: record.change,
    })
  })
  // A paired desktop's chat management: what a Delete there would do.
  ipcMain.handle(MESH_CONVERSATION_DELETE_PLAN_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationDeletePlan({ connectionId: record.connectionId, workspaceId: record.workspaceId })
  })
  // …and what was said in its chats, for the palette.
  ipcMain.handle(MESH_CONVERSATION_SEARCH_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationSearch({ connectionId: record.connectionId, query: record.query })
  })
  ipcMain.handle(MESH_WORKSPACE_CHECKOUT_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input)
    return service.mesh().workspaceCheckout(record?.connectionId, record?.workspaceId)
  })
  ipcMain.handle(MESH_WORKSPACE_EXTENSIONS_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service
      .mesh()
      .workspaceExtensions({ connectionId: record.connectionId, workspaceId: record.workspaceId, cli: record.cli })
  })
  // A remote chat's Create PR, a step per channel as the shell's own are:
  // every one runs on the chat's machine, in its checkout there.
  ipcMain.handle(MESH_CONVERSATION_PULL_REQUEST_STATE_CHANNEL, (_event, input: unknown) =>
    service.mesh().conversationPullRequestState({ key: asRecord(input)?.key }),
  )
  ipcMain.handle(MESH_CONVERSATION_PULL_REQUEST_DRAFT_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationPullRequestDraft({ key: record.key, draftId: record.draftId })
  })
  ipcMain.handle(MESH_CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationPullRequestDraftCancel({ key: record.key, draftId: record.draftId })
  })
  ipcMain.handle(MESH_CONVERSATION_PULL_REQUEST_PUSH_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationPullRequestPush({ key: record.key, pin: record.pin })
  })
  ipcMain.handle(MESH_CONVERSATION_PULL_REQUEST_CREATE_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service
      .mesh()
      .conversationPullRequestCreate({ key: record.key, title: record.title, body: record.body, pin: record.pin })
  })

  // Conversations on a paired machine. Like every `mesh:*` channel these
  // are IPC-only: following another machine's chat is something a person
  // here asks for, reachable from no MCP tool.
  ipcMain.handle(MESH_CONVERSATION_LIST_CHANNEL, (_event, connectionId: unknown) =>
    service.mesh().listConversations(connectionId),
  )
  ipcMain.handle(MESH_CONVERSATION_FOLLOW_CHANNEL, (event, input: unknown) => {
    const record = asRecord(input) ?? {}
    const followId = typeof record.followId === 'string' ? record.followId : ''
    if (!followId) {
      return { ok: false, code: 'invalid_arguments', message: 'A follow needs an id to deliver its frames on.' }
    }
    trackSender(event)
    followers.set(followId, event.sender)
    const channel = meshConversationFrameChannel(followId)
    return service.mesh().followConversation({
      followId,
      key: record.key,
      turnLimit: record.turnLimit,
      emit: (frame: MeshConversationFrame) => {
        const sender = followers.get(followId)
        if (!sender || sender.isDestroyed()) return
        sender.send(channel, frame)
      },
    })
  })
  ipcMain.handle(MESH_CONVERSATION_UNFOLLOW_CHANNEL, (_event, followId: unknown) => {
    if (typeof followId === 'string') followers.delete(followId)
    service.mesh().unfollowConversation(followId)
  })
  ipcMain.handle(MESH_CONVERSATION_EARLIER_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service
      .mesh()
      .conversationLoadEarlier({ key: record.key, beforeCursor: record.beforeCursor, turnLimit: record.turnLimit })
  })
  ipcMain.handle(MESH_CONVERSATION_COMMAND_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationCommand({ key: record.key, command: record.command })
  })
  // A message with the images attached to it: main puts each in the other
  // machine's upload store and sends the message naming them. One with none
  // is the `send` command.
  ipcMain.handle(MESH_CONVERSATION_SEND_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationSend({
      key: record.key,
      message: record.message,
      attachments: record.attachments,
      queue: record.queue,
      steer: record.steer,
      skills: record.skills,
    })
  })
  ipcMain.handle(MESH_CONVERSATION_TOOL_DETAIL_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationToolDetail({ key: record.key, toolUseId: record.toolUseId })
  })
  ipcMain.handle(MESH_CONVERSATION_TOOL_IMAGE_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationToolImage({ key: record.key, toolUseId: record.toolUseId })
  })
  ipcMain.handle(MESH_CONVERSATION_TURN_DIFF_CHANNEL, (_event, input: unknown) => {
    const record = asRecord(input) ?? {}
    return service.mesh().conversationTurnDiff({ key: record.key, turnSeq: record.turnSeq, path: record.path })
  })
}
