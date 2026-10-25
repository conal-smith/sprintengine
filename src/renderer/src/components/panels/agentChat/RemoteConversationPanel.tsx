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

/** What the machine says it does for its chats beyond the turn: forks, side questions, the window's breakdown. */
type RemoteAgentReads = { fork: boolean; sideQuestions: boolean; contextBreakdown: boolean }
const NO_AGENT_READS: RemoteAgentReads = { fork: false, sideQuestions: false, contextBreakdown: false }

/** What the machine a chat runs on said it takes, each read from its list. */
type RemoteSessionFeatures = {
  modelSwitch: boolean
  stopSubagents: boolean
  handoff: boolean
  sendSkills: boolean
  rewind: boolean
  agentReads: RemoteAgentReads
  cliPermissionModes: boolean
  sendMode: boolean
  reasoningEffort: boolean
  mcpServerActions: boolean
}

/** The session a remote row stands for, as the chat view reads one: what that machine said it can do. */
function remoteConversationSession(
  thread: MeshConversation | null,
  key: MeshConversationKey,
  features: RemoteSessionFeatures,
): ConversationSessionSummary {
  const {
    modelSwitch,
    stopSubagents,
    handoff,
    sendSkills,
    rewind,
    agentReads,
    cliPermissionModes,
    sendMode,
    reasoningEffort,
    mcpServerActions,
  } = features
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
    // And the CLI's own mode at it (Claude Code's Accept edits), from a
    // machine that runs them; elsewhere the preset runs its own.
    ...(cliPermissionModes && thread?.permissionPreset && thread.permissionMode
      ? { permissionMode: thread.permissionMode }
      : {}),
    createdAt: thread?.createdAt ?? 0,
    updatedAt: thread?.updatedAt ?? 0,
    capabilities: {
      tools: true,
      approvals: capabilities?.approvals ?? true,
      questions: capabilities?.questions ?? true,
      // Whether its provider plans, where the machine takes the mode a turn
      // runs in; one that does not runs every turn in the default mode.
      planMode: sendMode && capabilities?.planMode === true,
      // The remote send carries images where the machine lists the chat as
      // taking them: main puts each in that machine's upload store, as the
      // phone does, and the send names them.
      images: capabilities?.images === true,
      // That machine's skills, where it takes them with a message: its runtime
      // resolves each against its own folder and delivers it, which is what
      // `context` stands for here. The "+" lists them, and that machine's MCP
      // servers beside them.
      skills: sendSkills ? 'context' : 'none',
      // The levels its provider runs, where the machine takes a change of
      // them: the effort control and `/effort` are offered as a local chat's
      // are, and a change is that machine's to keep.
      reasoningEfforts:
        reasoningEffort && capabilities?.reasoningEfforts?.length ? capabilities.reasoningEfforts : null,
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
      // Whether one agent the chat spawned can be stopped by itself: the
      // machine takes the command and lists the chat's provider as able.
      // The machine's turn Stop spares such a chat's agents, so this is the
      // only Stop an agent has from here.
      stopSubagent: stopSubagents && capabilities?.stopSubagent === true,
      // Whether the chat can be handed off to a fresh session over there: the
      // machine takes the command and lists the chat's provider as able.
      handoff: handoff && capabilities?.handoff === true,
      // Whether the chat can go back to before one of its messages over there
      // (Edit from here): the machine takes the command and lists the chat's
      // provider as able.
      rewind: rewind && capabilities?.rewind === true,
      // Fork from here, a side question, and what fills the window: each
      // where the machine takes it and lists the chat's provider as able. A
      // fork is made over there and opens here as a pane of its own.
      fork: agentReads.fork && capabilities?.fork === true,
      sideQuestion: agentReads.sideQuestions && capabilities?.sideQuestion === true,
      contextBreakdown: agentReads.contextBreakdown && capabilities?.contextBreakdown === true,
      // The presets the chat's provider over there can run, where its list names them.
      ...(capabilities?.permissionPresets ? { permissionPresets: capabilities.permissionPresets } : {}),
      // What the "+" menu's server rows may do to the chat's servers over
      // there while it runs, where the machine takes the command.
      ...(mcpServerActions && capabilities?.mcpServerActions?.length
        ? { mcpServerActions: capabilities.mcpServerActions }
        : {}),
      // The CLI's own modes it runs beside them, offered in the same picker a
      // local chat's are, where the machine takes a switch to one.
      ...(cliPermissionModes && capabilities?.permissionModes ? { permissionModes: capabilities.permissionModes } : {}),
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
  // The machine runs chats on their CLI's own modes beside the presets.
  const [cliPermissionModes, setCliPermissionModes] = useState(false)
  // The machine holds a message queued here mid-turn and sends it when the
  // turn ends, so this machine may sleep or close meanwhile; and what it
  // holds for this chat, as it last said.
  const [queuedSends, setQueuedSends] = useState(false)
  const [sendSkills, setSendSkills] = useState(false)
  // The machine opens a pull request for one of its chats (Create PR).
  const [hostPullRequests, setHostPullRequests] = useState(false)
  // The machine takes a message into a turn one of its chats is running.
  const [steerSends, setSteerSends] = useState(false)
  // The machine stops one agent of one of its chats by itself.
  const [stopSubagents, setStopSubagents] = useState(false)
  // The machine hands one of its chats off to a fresh session.
  const [handoff, setHandoff] = useState(false)
  // The machine takes one of its chats back to before a message, and puts a
  // turn's files back from its checkpoint, in its own checkout.
  const [rewind, setRewind] = useState(false)
  const [checkpointRevert, setCheckpointRevert] = useState(false)
  // The machine forks its chats, answers a side question about one, and says
  // what fills one's window.
  const [agentReads, setAgentReads] = useState<RemoteAgentReads>(NO_AGENT_READS)
  // The machine searches a chat's folder for an @ and takes what is
  // mentioned; takes files with a message; lists a chat CLI's commands.
  const [composerMentions, setComposerMentions] = useState(false)
  const [messageFiles, setMessageFiles] = useState(false)
  const [commandList, setCommandList] = useState(false)
  // The machine runs a turn in the mode its message says.
  const [sendMode, setSendMode] = useState(false)
  // The machine lists its chats' reasoning effort and takes a change of it.
  const [reasoningEffort, setReasoningEffort] = useState(false)
  // The machine reconnects and switches a live chat's MCP servers.
  const [mcpServerActions, setMcpServerActions] = useState(false)
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
  const checkpointRevertRef = useRef(checkpointRevert)
  checkpointRevertRef.current = checkpointRevert
  const composerMentionsRef = useRef(composerMentions)
  composerMentionsRef.current = composerMentions
  const messageFilesRef = useRef(messageFiles)
  messageFilesRef.current = messageFiles
  const commandListRef = useRef(commandList)
  commandListRef.current = commandList
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
    const setEffort = base.setReasoningEffort
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
          checkpointRevert: checkpointRevertRef.current,
          mentions: composerMentionsRef.current,
          attachFiles: messageFilesRef.current,
          commandList: commandListRef.current,
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
      // Read again once accepted, as a model switch is, so the control names
      // the level the machine says the chat now runs at.
      ...(setEffort
        ? {
            setReasoningEffort: async (change: Parameters<typeof setEffort>[0]) => {
              const result = await setEffort(change)
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
        setCliPermissionModes(result.cliPermissionModes === true)
        setQueuedSends(result.queuedSends === true)
        setSendSkills(result.sendSkills === true)
        setHostPullRequests(result.createPullRequest === true)
        setSteerSends(result.steerSends === true)
        setStopSubagents(result.stopSubagents === true)
        setHandoff(result.handoff === true)
        setRewind(result.rewind === true)
        setCheckpointRevert(result.checkpointRevert === true)
        setAgentReads((current) => {
          const next = {
            fork: result.fork === true,
            sideQuestions: result.sideQuestions === true,
            contextBreakdown: result.contextBreakdown === true,
          }
          return current.fork === next.fork &&
            current.sideQuestions === next.sideQuestions &&
            current.contextBreakdown === next.contextBreakdown
            ? current
            : next
        })
        setComposerMentions(result.mentions === true)
        setMessageFiles(result.messageFiles === true)
        setCommandList(result.commands === true)
        setSendMode(result.sendMode === true)
        setReasoningEffort(result.reasoningEffort === true)
        setMcpServerActions(result.mcpServerActions === true)
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
    const { conversation, name: _name, conversationReasoningEffort: _effort, ...rest } = patch
    setFields((current) => ({ ...current, ...rest }))
    // The chat view records a model only once the machine accepted the
    // switch; the chip moves now, and the list read that follows confirms it.
    // The CLI is the machine's to say, never this pane's.
    if (conversation?.modelId)
      setThread((current) => (current ? { ...current, modelId: conversation.modelId } : current))
    // The effort likewise: the machine keeps it, and the control reads it off
    // the list, moved now to the level it accepted.
    if ('conversationReasoningEffort' in patch)
      setThread((current) => {
        if (!current) return current
        const { reasoningEffort: _was, ...rest } = current
        return patch.conversationReasoningEffort
          ? { ...rest, reasoningEffort: patch.conversationReasoningEffort }
          : rest
      })
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
  const session = useMemo(
    () =>
      remoteConversationSession(thread, key, {
        modelSwitch,
        stopSubagents,
        handoff,
        sendSkills,
        rewind,
        agentReads,
        cliPermissionModes,
        sendMode,
        reasoningEffort,
        mcpServerActions,
      }),
    [
      thread,
      key,
      modelSwitch,
      stopSubagents,
      handoff,
      sendSkills,
      rewind,
      agentReads,
      cliPermissionModes,
      sendMode,
      reasoningEffort,
      mcpServerActions,
    ],
  )
  const engine = useMemo(() => remoteConversationEngine(thread, modelSwitch), [thread, modelSwitch])
  const readiness = useMemo(() => remoteConversationReadiness(link, access, machineName), [link, access, machineName])
  const binding = useMemo<ChatBinding>(
    () => ({
      agent: {
        ...fields,
        name: displayTitle,
        conversation: { providerId: thread?.providerId ?? '', modelId: thread?.modelId ?? '' },
        // The effort the machine says the chat runs at, which each turn there runs at.
        ...(thread?.reasoningEffort ? { conversationReasoningEffort: thread.reasoningEffort } : {}),
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
