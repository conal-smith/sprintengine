import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { meshConversationSessionId } from '../../../../../shared/tailnet-mesh'
import type { BranchPullRequest } from '../../../../../shared/git/pull-request'
import type {
  MeshConversation,
  MeshConversationAccess,
  MeshConversationKey,
  MeshConversationLink,
  MeshQueuedMessage,
} from '../../../../../shared/tailnet-mesh'
import type { CliRuntimeOption } from '../../ui/CliModelPicker'
import {
  publishRemoteConversationList,
  useRemoteConversationFactsOf,
} from '../../workspace/remoteBand/remoteConversationFacts'
import { ConversationChatBody } from '../AgentChatView'
import { remoteFileCountsOf } from '../../workspace/terminalLines'
import { ChatViewErrorBoundary } from './ChatViewErrorBoundary'
import { publishRemoteChat } from './remoteChatRegistry'
import type { ChatBinding, ChatAgentFields } from './chatBinding'
import type { ChatReadiness } from './chatStates'
import {
  ConversationTransportProvider,
  createRemoteConversationTransport,
  type ConversationTransportCapabilities,
} from './conversationTransport'

// A conversation on a paired machine, in the regular chat view.
//
// The transcript, pending requests and composer are the chat view's own; what
// this pane adds is the transport (main follows the conversation over the
// tailnet and keeps its tail, so a reconnect or a restart resumes rather than
// replays) and the agent fields a local chat keeps in its record. The machine
// is named above the transcript and on the tab, so a keystroke here is never
// mistaken for one on this machine.
//
// Readiness is the link's: live and allowed to operate is ready; live and
// read-only shows the conversation with the composer closed and says why; a
// link that is reconnecting keeps the transcript on screen and says so.

const NO_PULL_REQUESTS: readonly BranchPullRequest[] = []

type Props = {
  /** The workspace here that holds this pane. */
  workspaceId: string
  connectionId: string
  machineName: string
  /** The conversation's ids on that machine. */
  remoteWorkspaceId: string
  remoteAgentId: string
  /** What the row it was opened from called it, until the machine is read. */
  title?: string
}

function remoteConversationReadiness(
  link: MeshConversationLink | null,
  access: MeshConversationAccess | null,
  machineName: string,
): ChatReadiness {
  if (!link) return { kind: 'error', message: `Connecting to ${machineName}.` }
  if (link.state !== 'live') return { kind: 'error', message: link.detail }
  if (access !== 'operate')
    return {
      kind: 'error',
      message: `This pairing may follow this conversation on ${machineName} but not drive it.`,
    }
  return { kind: 'ready' }
}

/**
 * The chat's CLI row as the machine running it lists it: its name and the
 * models its own picker offers, which are the only ones it will switch to.
 * Null for a machine that does not offer model switching, or a chat whose
 * provider is not a CLI; the chip then shows the model it is on, locked.
 */
function remoteConversationEngine(thread: MeshConversation | null, modelSwitch: boolean): CliRuntimeOption | null {
  const models = modelSwitch ? thread?.models : undefined
  if (!models) return null
  return {
    value: models.cli,
    label: models.cliLabel,
    modelSelection: { options: models.options, allowCustomId: false },
  }
}

/** The session a remote row stands for, as the chat view reads one: what that machine said it can do. */
function remoteConversationSession(
  thread: MeshConversation | null,
  key: MeshConversationKey,
  modelSwitch: boolean,
): ConversationSessionSummary {
  const capabilities = thread?.capabilities
  return {
    // A session id, even for a conversation with none live over there: a
    // remote send resumes one, so the view never starts one here.
    sessionId: thread?.sessionId ?? `remote:${key.agentId}`,
    workspaceId: key.workspaceId,
    agentId: key.agentId,
    providerId: thread?.providerId ?? '',
    modelId: thread?.modelId ?? '',
    status: 'ready',
    // The preset the machine says the conversation is on. With it the chat
    // shows the same switcher a local chat does; without it (a desktop built
    // before the list named it) the switcher stays hidden.
    ...(thread?.permissionPreset ? { permissionPreset: thread.permissionPreset } : {}),
    createdAt: thread?.createdAt ?? 0,
    updatedAt: thread?.updatedAt ?? 0,
    capabilities: {
      tools: true,
      approvals: capabilities?.approvals ?? true,
      questions: capabilities?.questions ?? true,
      // The remote send carries no mode or effort. It carries images where
      // the machine lists the chat as taking them: main puts each in that
      // machine's upload store, as the phone does, and the send names them.
      planMode: false,
      images: capabilities?.images === true,
      skills: 'none',
      reasoningEfforts: null,
      interrupt: capabilities?.interrupt ?? true,
      resume: false,
      subagents: true,
      cost: false,
      contextMeter: false,
      // Whether the machine will take a new model mid-conversation, as its
      // list says; a machine that does not offer model switching never will.
      liveModelSwitch: modelSwitch && thread?.models?.liveModelSwitch === true,
      checkpoints: capabilities?.checkpoints ?? false,
      // Whether its provider takes a message mid-turn, where the list says;
      // the transport offers it only for a machine that takes a steer.
      steer: capabilities?.steer === true,
      // The presets the chat's provider over there can run, where its list names them.
      ...(capabilities?.permissionPresets ? { permissionPresets: capabilities.permissionPresets } : {}),
    },
  }
}

export default function RemoteConversationPanel({
  workspaceId,
  connectionId,
  machineName,
  remoteWorkspaceId,
  remoteAgentId,
  title,
}: Props) {
  const key = useMemo<MeshConversationKey>(
    () => ({ connectionId, workspaceId: remoteWorkspaceId, agentId: remoteAgentId }),
    [connectionId, remoteWorkspaceId, remoteAgentId],
  )
  const [link, setLink] = useState<MeshConversationLink | null>(null)
  const [thread, setThread] = useState<MeshConversation | null>(null)
  const [listedAccess, setListedAccess] = useState<MeshConversationAccess | null>(null)
  // The machine advertises model switching and lists this chat's catalog.
  const [listedModelSwitch, setListedModelSwitch] = useState(false)
  // The machine runs chats on Manual and Auto as well as Bypass and No flag.
  const [permissionModes, setPermissionModes] = useState(false)
  // The machine holds a message queued here mid-turn and sends it when the
  // turn ends, so this machine may sleep or close meanwhile; and what it
  // holds for this chat, as it last said.
  const [queuedSends, setQueuedSends] = useState(false)
  const [sendSkills, setSendSkills] = useState(false)
  // The machine opens a pull request for one of its chats (Create PR).
  const [hostPullRequests, setHostPullRequests] = useState(false)
  // The machine takes a message into a turn one of its chats is running.
  const [steerSends, setSteerSends] = useState(false)
  const [hostQueued, setHostQueued] = useState<MeshQueuedMessage[]>([])
  const modelSwitch = listedModelSwitch && Boolean(thread?.models)
  // Bumped after an accepted model switch, so the list is read again and the
  // chip names what the machine says the chat is now on.
  const [listVersion, setListVersion] = useState(0)
  // The link's word on access is the latest (a refused command narrows it);
  // the list's is what was granted when this pane last read the machine.
  const access = link?.access ?? listedAccess

  // One transport per conversation, never rebuilt on a grant change: a new
  // transport is a new subscription, and the follow in main would be dropped
  // and dialled again. Its capabilities read the access as it is now.
  const accessRef = useRef(access)
  accessRef.current = access
  const modelSwitchRef = useRef(modelSwitch)
  modelSwitchRef.current = modelSwitch
  const permissionModesRef = useRef(permissionModes)
  permissionModesRef.current = permissionModes
  const queuedSendsRef = useRef(queuedSends)
  queuedSendsRef.current = queuedSends
  const sendSkillsRef = useRef(sendSkills)
  sendSkillsRef.current = sendSkills
  const hostPullRequestsRef = useRef(hostPullRequests)
  hostPullRequestsRef.current = hostPullRequests
  const steerSendsRef = useRef(steerSends)
  steerSendsRef.current = steerSends
  const threadRef = useRef(thread)
  threadRef.current = thread
  const transport = useMemo(() => {
    const base = createRemoteConversationTransport({
      key,
      machineName,
      access: null,
      onLink: setLink,
      onQueued: setHostQueued,
      // A pull request Create PR opened there is in the machine's list now:
      // read it again, so the strip says "Open PR #N" without waiting for the
      // sidebar's next read.
      onPullRequestRecorded: () => setListVersion((version) => version + 1),
    })
    const capabilities = base.capabilities
    const setModel = base.setModel
    const send = base.send
    return {
      ...base,
      // A chat at rest over there is listed without a session, and so without
      // what it can do: its first message wakes one, and the list is read
      // again once that message is answered, so the composer learns whether
      // the chat takes images without waiting for the link to drop.
      send: async (turn: Parameters<typeof send>[0]) => {
        const result = await send(turn)
        if (result.ok && !threadRef.current?.capabilities) setListVersion((version) => version + 1)
        return result
      },
      get capabilities(): ConversationTransportCapabilities {
        return {
          ...capabilities,
          operate: accessRef.current === 'operate',
          modelSwitch: modelSwitchRef.current,
          permissionModes: permissionModesRef.current,
          hostQueue: queuedSendsRef.current,
          skills: sendSkillsRef.current,
          steer: steerSendsRef.current,
          hostPullRequests: hostPullRequestsRef.current,
        }
      },
      ...(setModel
        ? {
            setModel: async (change: Parameters<typeof setModel>[0]) => {
              const result = await setModel(change)
              if (result.ok) setListVersion((version) => version + 1)
              return result
            },
          }
        : {}),
    }
  }, [key, machineName])

  // The machine's list names the conversation's title, model and what its
  // provider can do. Read on open and whenever the link comes back live.
  // Not when the link drops: a machine the follow cannot reach will not
  // answer a list either, and the read would only wait out its timeout.
  // Main shares one list per machine across the panes and the band that ask
  // at once, and the protocol has no read for a single conversation, so the
  // whole list is still what is asked for.
  const live = link?.state === 'live'
  const linkRef = useRef(link)
  linkRef.current = link
  useEffect(() => {
    if (!live && linkRef.current !== null) return
    let cancelled = false
    void window.api
      .meshConversationList(connectionId)
      .then((result) => {
        if (cancelled || !result.ok) return
        // The pane's tab reads its mark, model and clock off this list too.
        publishRemoteConversationList(connectionId, result.conversations)
        setListedAccess(result.access)
        setListedModelSwitch(result.modelSwitch === true)
        setPermissionModes(result.permissionModes === true)
        setQueuedSends(result.queuedSends === true)
        setSendSkills(result.sendSkills === true)
        setHostPullRequests(result.createPullRequest === true)
        setSteerSends(result.steerSends === true)
        setThread(
          result.conversations.find(
            (entry) => entry.workspaceId === remoteWorkspaceId && entry.agentId === remoteAgentId,
          ) ?? null,
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connectionId, remoteWorkspaceId, remoteAgentId, live, listVersion])

  const [fields, setFields] = useState<Omit<ChatAgentFields, 'conversation' | 'name'>>({})
  const update = useCallback((patch: Partial<ChatAgentFields>) => {
    const { conversation, name: _name, ...rest } = patch
    setFields((current) => ({ ...current, ...rest }))
    // The chat view records a model only once the machine accepted the
    // switch; the chip moves now, and the list read that follows confirms it.
    // The CLI is the machine's to say, never this pane's.
    if (conversation?.modelId)
      setThread((current) => (current ? { ...current, modelId: conversation.modelId } : current))
  }, [])
  // The branch, changed files and pull requests the strip under the composer draws, from
  // the newest list either this pane or the sidebar read: the sidebar reads
  // the machine again whenever it says its chats changed, so a pull request
  // the agent opens mid-conversation reaches the strip without a reopen.
  const facts = useRemoteConversationFactsOf(connectionId, meshConversationSessionId(remoteWorkspaceId, remoteAgentId))
  const listed = useMemo(() => {
    const pullRequests = facts?.pullRequests ?? NO_PULL_REQUESTS
    return {
      branch: facts?.branch ?? null,
      worktree: facts?.worktree ?? false,
      files: remoteFileCountsOf(facts?.changes ?? null, pullRequests)?.files ?? null,
      pullRequests,
    }
  }, [facts])
  const displayTitle = thread?.title || title || 'Conversation'
  const session = useMemo(() => remoteConversationSession(thread, key, modelSwitch), [thread, key, modelSwitch])
  const engine = useMemo(() => remoteConversationEngine(thread, modelSwitch), [thread, modelSwitch])
  const readiness = useMemo(() => remoteConversationReadiness(link, access, machineName), [link, access, machineName])
  const binding = useMemo<ChatBinding>(
    () => ({
      agent: {
        ...fields,
        name: displayTitle,
        conversation: { providerId: thread?.providerId ?? '', modelId: thread?.modelId ?? '' },
      },
      update,
      workspace: null,
      workspaceRoot: null,
      sessionRoot: `mesh:${connectionId}`,
      readiness,
      session,
      // No header of its own (owner, 2026-10-08): the tab names the agent and
      // wears the machine's mark, and the strip under the composer marks the
      // machine again; a third line saying both was the same fact once more.
      ...(engine ? { engine } : {}),
      hostQueue: { machineName, messages: hostQueued },
      listed,
    }),
    [fields, displayTitle, thread, update, connectionId, readiness, session, engine, machineName, hostQueued, listed],
  )

  // The Agents tab beside it reads the chat through this transport, as it
  // reads a local chat through its record.
  useEffect(
    () => publishRemoteChat(workspaceId, { agentId: remoteAgentId, transport, binding }),
    [workspaceId, remoteAgentId, transport, binding],
  )

  return (
    <ConversationTransportProvider value={transport}>
      <ChatViewErrorBoundary chatKey={`${connectionId}:${remoteWorkspaceId}:${remoteAgentId}`}>
        <ConversationChatBody
          key={`${connectionId}:${remoteWorkspaceId}:${remoteAgentId}`}
          workspaceId={workspaceId}
          agentId={remoteAgentId}
          binding={binding}
        />
      </ChatViewErrorBoundary>
    </ConversationTransportProvider>
  )
}
