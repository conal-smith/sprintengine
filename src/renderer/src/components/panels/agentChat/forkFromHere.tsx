// "Fork from here" on a message: a new chat opens in the tab after this one,
// holding the conversation up to that point, and carries on by itself. Forked
// at a reply, the fork holds that turn; forked at one of the person's messages,
// it holds what came before it, and the message waits in the fork's composer
// to be sent again, changed or not. Nothing about this chat changes, and both
// chats work in the same files, which the toast that announces the fork says.

import { useState } from 'react'
import { newAgentIdSuffix } from '../../../../../shared/agent-ids'

import type { ConversationImageAttachment, ConversationKey } from '../../../../../shared/conversation-runtime'
import { GhostButton, Tooltip } from '../../ui'
import { showToast } from '../../../store/toastStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { placeSpawnedAgentTab } from '../../workspace/manager/layoutTabActions'
import { forkedAgentPatch, forkName } from '../../../../../shared/conversation/fork'
import { SOLO_CHAT_TEMPLATE_ID } from '../../../../../shared/layouts/templates'
import { meshConversationSessionId, type MeshConversationPaneSpec } from '../../../../../shared/tailnet-mesh'
import { LAYOUT_TEMPLATES } from '../../../layouts/templates'
import { addMeshConversationTabAfter } from '../../../utils/modelRegistry'
import { composerDraftStore, type ComposerDraft } from './draftStore'
import type { TranscriptEntry } from './conversationProjection'
import { useConversationTransport, type ConversationTransport } from './conversationTransport'
import { editFromHereDraft } from './editFromHere'
import { attachedFilePaths } from '../../../utils/attachedFiles'

type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>

/** Where to fork: after a reply's turn, or before one of the person's messages, which the fork's composer gets back. */
export type ForkFromHereTarget =
  // `draft`: words for the fork's composer, ready to send there (a side
  // question carried on in a chat of its own).
  | { side: 'assistant'; turnId: string; draft?: { text: string } }
  | {
      side: 'user'
      turnSeq: number
      // `files`: the files it attached by path, as the fork composer's cards.
      draft: Omit<ComposerDraft, 'updatedAt' | 'files'> & { files?: string[] }
      // The images the message carried, staged in the fork's composer with it.
      attachments?: ConversationImageAttachment[]
    }

// The images a fork's composer starts with, until its view mounts and takes
// them. Held here rather than in the draft store, which is written to disk and
// keeps text only. They are base64, up to a turn's worth each, and a fork whose
// view never mounts (closed unopened, or removed) would otherwise hold them
// for as long as the window is open: a hand-off nobody took within the hour,
// or whose chat is gone, is let go, and only the newest few are held at all.
// The words stay in the fork's draft either way.
const FORKED_ATTACHMENTS_TTL_MS = 60 * 60 * 1000
const FORKED_ATTACHMENTS_HELD = 4
const forkedAttachments = new Map<
  string,
  { workspaceId: string; agentId: string; attachments: ConversationImageAttachment[]; at: number }
>()
const forkedAttachmentsKey = (workspaceId: string, agentId: string) => `${workspaceId}\u0000${agentId}`

function letGoOfStaleForks(now: number): void {
  const workspaces = useWorkspaceStore.getState().workspaces
  for (const [key, held] of forkedAttachments) {
    // A pane onto a paired machine's chat has no record here: its fork's
    // images wait for as long as the workspace holding the pane is open.
    const workspace = workspaces.find((candidate) => candidate.id === held.workspaceId)
    const agentGone = !workspace || (!workspace.agents[held.agentId] && !workspace.remoteOrigin)
    if (agentGone || now - held.at > FORKED_ATTACHMENTS_TTL_MS) forkedAttachments.delete(key)
  }
  // Oldest first: a Map keeps the order its entries went in.
  for (const key of forkedAttachments.keys()) {
    if (forkedAttachments.size <= FORKED_ATTACHMENTS_HELD) break
    forkedAttachments.delete(key)
  }
}

function holdForkedAttachments(workspaceId: string, agentId: string, attachments: ConversationImageAttachment[]) {
  const key = forkedAttachmentsKey(workspaceId, agentId)
  forkedAttachments.delete(key)
  forkedAttachments.set(key, { workspaceId, agentId, attachments, at: Date.now() })
  letGoOfStaleForks(Date.now())
}

/** The images a fork's composer was handed, once: taking them answers the hand-off. */
export function takeForkedAttachments(workspaceId: string, agentId: string): ConversationImageAttachment[] {
  const key = forkedAttachmentsKey(workspaceId, agentId)
  const held = forkedAttachments.get(key)
  forkedAttachments.delete(key)
  letGoOfStaleForks(Date.now())
  return held && Date.now() - held.at <= FORKED_ATTACHMENTS_TTL_MS ? held.attachments : []
}

/** "Fork from here" under one of the person's messages. */
export function ForkMessageAction({
  entry,
  running,
  onFork,
  className,
}: {
  entry: UserEntry
  running: boolean
  onFork: (target: ForkFromHereTarget) => Promise<void>
  className?: string
}) {
  const transport = useConversationTransport()
  const turnSeq = entry.seq
  // A bubble not yet in the transcript has no point to fork at.
  if (turnSeq === undefined || typeof transport.fork !== 'function') return null
  return (
    <ForkFromHereButton
      running={running}
      tooltip="Open a new chat with the conversation before this message, and this message ready to send"
      className={className}
      onFork={async () => {
        // The message goes back as it was sent, its images included, read from
        // the store when the send is no longer in memory.
        const { attachments } = await editFromHereDraft(entry, transport)
        await onFork({
          side: 'user',
          turnSeq,
          // Its files go with it, as the fork composer's cards.
          draft: {
            text: entry.text,
            skillIds: entry.skills ?? [],
            mentions: entry.mentions ?? [],
            files: attachedFilePaths(entry.files),
          },
          ...(attachments.length ? { attachments } : {}),
        })
      }}
    />
  )
}

/** "Fork from here" on a reply's meta line. */
export function ForkReplyAction({
  turnId,
  running,
  onFork,
  className,
}: {
  turnId: string
  running: boolean
  onFork: (target: ForkFromHereTarget) => Promise<void>
  className?: string
}) {
  // Only a transport that can fork offers it, as for a message; the
  // provider's own `fork` capability is the caller's gate.
  const transport = useConversationTransport()
  if (typeof transport.fork !== 'function') return null
  return (
    <ForkFromHereButton
      running={running}
      tooltip="Open a new chat with the conversation up to this reply"
      className={className}
      onFork={() => onFork({ side: 'assistant', turnId })}
    />
  )
}

function ForkFromHereButton({
  running,
  tooltip,
  onFork,
  className,
}: {
  running: boolean
  tooltip: string
  onFork: () => Promise<void>
  className?: string
}) {
  const [pending, setPending] = useState(false)
  async function fork() {
    if (running || pending) return
    setPending(true)
    try {
      await onFork()
    } catch (error) {
      showToast({
        tone: 'error',
        title: `Could not fork from here: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setPending(false)
    }
  }
  return (
    <Tooltip content={running ? 'Stop the running turn before forking from an earlier message' : tooltip}>
      <span className={className}>
        <GhostButton size="inline" disabled={running || pending} onClick={() => void fork()}>
          {pending ? 'Forking…' : 'Fork from here'}
        </GhostButton>
      </span>
    </Tooltip>
  )
}

/**
 * Make the fork and open it: the runtime writes its conversation, then the
 * new chat joins the workspace as this one's twin (its CLI, model, effort,
 * permission mode, skills and working folder), named after it, in the tab
 * after this one's. A message forked before goes into its composer.
 */
export async function forkChat(input: {
  transport: Pick<ConversationTransport, 'fork'>
  key: ConversationKey
  target: ForkFromHereTarget
}): Promise<void> {
  const { key, target } = input
  const workspace = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === key.workspaceId)
  const parent = workspace?.agents[key.agentId]
  if (!input.transport.fork || !parent?.conversation) throw new Error('This chat cannot be forked here.')
  const agentId = `conversation-${parent.conversation.providerId}-${newAgentIdSuffix()}`
  const name = forkName(
    parent.name || 'Chat',
    Object.values(workspace?.agents ?? {}).map((agent) => agent.name),
  )
  const forked = await input.transport.fork({
    key,
    newAgentId: agentId,
    title: name,
    ...(target.side === 'user'
      ? { side: 'user' as const, turnSeq: target.turnSeq }
      : { side: 'assistant' as const, turnId: target.turnId }),
  })
  if (!forked.ok) throw new Error(forked.message)
  useWorkspaceStore.getState().updateAgent(key.workspaceId, agentId, forkedAgentPatch(parent, name))
  if (target.side === 'user') {
    composerDraftStore().getState().put(key.workspaceId, agentId, target.draft)
    if (target.attachments?.length) holdForkedAttachments(key.workspaceId, agentId, target.attachments)
  } else if (target.draft?.text.trim())
    composerDraftStore().getState().put(key.workspaceId, agentId, {
      text: target.draft.text,
      skillIds: [],
      mentions: [],
    })
  placeSpawnedAgentTab(key.workspaceId, agentId, name, { afterAgentId: key.agentId })
  showToast({ tone: 'neutral', title: `Forked into ${name}. Both chats work in the same files.` })
}

/**
 * Fork a chat followed from a paired machine. The machine makes the fork, as
 * its own Fork from here would: beside the chat in its workspace there, named
 * after it beside that workspace's other chats, in the same files. Here it
 * opens as a pane onto that machine in the tab after this chat's, as a local
 * fork opens after its chat, or, where this chat's layout is not mounted, as a
 * chat of its own, the way a chat started over there from New chat opens. A
 * message forked before goes into its composer; the files it attached by path
 * stay behind, since those paths are on that machine's disk.
 */
export async function forkRemoteChat(input: {
  transport: Pick<ConversationTransport, 'fork' | 'machineName' | 'remoteExtensions'>
  /** The workspace here whose pane follows the chat. */
  workspaceId: string
  /** The chat's id over there, and the provider it runs on, which names the fork's id as a local fork's. */
  agentId: string
  providerId: string
  /** The chat's name, for the fork's until the machine says what it called it. */
  name: string
  target: ForkFromHereTarget
}): Promise<void> {
  const { target } = input
  const remote = input.transport.remoteExtensions
  const origin = useWorkspaceStore
    .getState()
    .workspaces.find((candidate) => candidate.id === input.workspaceId)?.remoteOrigin
  if (!input.transport.fork || !remote) throw new Error('This chat cannot be forked here.')
  const machineName = input.transport.machineName ?? origin?.machineName ?? 'the other machine'
  const agentId = `conversation-${input.providerId}-${newAgentIdSuffix()}`
  const forked = await input.transport.fork({
    // The transport names the chat by its ids over there; this key is only
    // the shape the call takes, and its root means nothing to that machine.
    key: { workspaceRoot: '', workspaceId: remote.workspaceId, agentId: input.agentId },
    newAgentId: agentId,
    ...(target.side === 'user'
      ? { side: 'user' as const, turnSeq: target.turnSeq }
      : { side: 'assistant' as const, turnId: target.turnId }),
  })
  if (!forked.ok) throw new Error(forked.message)
  // What the machine called it, beside the chats of its workspace there.
  const listed = await window.api.meshConversationList(remote.connectionId).catch(() => null)
  const named = listed?.ok
    ? listed.conversations.find(
        (conversation) => conversation.workspaceId === remote.workspaceId && conversation.agentId === agentId,
      )?.title
    : undefined
  const name = named || forkName(input.name || 'Chat', [])
  const pane: MeshConversationPaneSpec = {
    connectionId: remote.connectionId,
    machineName,
    remoteWorkspaceId: remote.workspaceId,
    remoteAgentId: agentId,
    title: name,
  }
  let workspaceId = input.workspaceId
  if (
    !addMeshConversationTabAfter(workspaceId, pane, {
      connectionId: remote.connectionId,
      remoteWorkspaceId: remote.workspaceId,
      remoteAgentId: input.agentId,
    })
  ) {
    const template = LAYOUT_TEMPLATES.find((candidate) => candidate.id === SOLO_CHAT_TEMPLATE_ID)
    // Made all the same, and listed with that machine's chats.
    if (!template || !origin) {
      showToast({
        tone: 'neutral',
        title: `Forked into ${name} on ${machineName}`,
        description: `No pane could open for it here. It is listed under ${machineName} in the sidebar.`,
      })
      return
    }
    workspaceId = useWorkspaceStore.getState().addWorkspace(template, {
      name,
      folderPath: null,
      // The chat over there is in the same workspace as the one it was forked
      // from, so it is known by the same project and checkout; only the
      // session the band recognises it by is its own.
      remoteOrigin: { ...origin, sessionId: meshConversationSessionId(remote.workspaceId, agentId) },
      seedAgent: { tabName: name, meshConversation: pane },
    })
  }
  if (target.side === 'user') {
    const { files: _paths, ...draft } = target.draft
    composerDraftStore().getState().put(workspaceId, agentId, draft)
    if (target.attachments?.length) holdForkedAttachments(workspaceId, agentId, target.attachments)
  } else if (target.draft?.text.trim())
    composerDraftStore().getState().put(workspaceId, agentId, { text: target.draft.text, skillIds: [], mentions: [] })
  showToast({
    tone: 'neutral',
    title: `Forked into ${name} on ${machineName}. Both chats work in the same files there.`,
  })
}
