import type { ConversationWireCommand } from '../../packages/conversation-protocol/src'
import type {
  ConversationHighlightColor,
  ConversationQueuedMessage,
  ConversationThread,
} from '../../packages/conversation-protocol/src/public'
import type { ConversationSessionFrame } from './conversation-runtime'
import { conversationPhaseWorking, phaseWithBackgroundWork } from './conversation/phase'
import type { RepositoryIdentity } from './repository-identity'
import type { TailnetRemoteStatus, TailnetScope } from './tailnet'

// The Mesh: another machine's Studio, mounted in this one.
//
// `tailnet.ts` is "who may drive this machine"; `tailnet-peers.ts` is "which
// machines exist". This file is the third direction and the one a person
// actually works in: the machines this Studio has PAIRED WITH, what they hold,
// and the conversations it follows on them.
//
// The outbound half lives in the main process (`tailnet/tailnet-mesh-service.ts`),
// not the renderer, for one hard reason: the listener refuses any request
// carrying an `Origin` header, and a renderer's fetch/WebSocket always sends
// one. Main is also where the device token belongs — a credential that reached
// the renderer would be one XSS away from the tailnet.

/**
 * One machine this Studio is paired with.
 *
 * The device token is deliberately NOT here: it lives in the main-process store
 * and never crosses the IPC boundary, so nothing a window can read is a
 * credential.
 */
export type MeshConnection = {
  /** Local id for this pairing record. Ours, not the remote machine's. */
  id: string
  /** What to call the machine in the UI — its tailnet host name where we could resolve one. */
  machineName: string
  /** `address:port` of that machine's listener. */
  endpoint: string
  /** The device id the remote machine issued us, so a person can match it to a row in ITS settings. */
  deviceId: string
  /** The name we paired under (this machine's name), for the same reason. */
  deviceName: string
  /** What that machine granted us. Refreshed from the remote on every browse. */
  scopes: TailnetScope[]
  pairedAt: string
  lastConnectedAt: string | null
  /**
   * How this pairing came about (pair-from-the-scan-and-stay-paired): a
   * carried link, a request someone approved over there, or the reverse half
   * of a both-ways pairing that machine asked for. `unknown` for records
   * written before this was kept.
   */
  pairedVia: 'link' | 'request' | 'reverse' | 'unknown'
}

/** A workspace on the remote machine, as `workspace.list` reports it. */
export type MeshWorkspace = {
  id: string
  name: string
  mode: string | null
  folderPath: string | null
  /**
   * Which repository the folder is a clone of, as the remote read it off its
   * own `git remote` (one-project-across-machines). Null when the remote is
   * an older build, the folder is not a repository, or it has no remote —
   * three different facts with one consequence: no grouping across machines.
   */
  repository: RepositoryIdentity | null
  /**
   * When the workspace was settled there, or null while it is in that
   * machine's list. Null too from a machine built before it said; a resting
   * workspace is one this machine draws no row for.
   */
  settledAt?: number | null
}

/**
 * A workspace's checkout facts on the remote machine, as `workspace.checkout`
 * reports them (checkout-and-branch-on-remote-create). `git: false` is a real
 * answer — the folder is not a repository, so there is no branch to show and
 * no worktree to make — and is distinct from a gap, which is "this pairing
 * may not ask".
 */
export type MeshWorkspaceCheckout = {
  workspaceId: string
  git: boolean
  /** The branch the workspace's own checkout is on; null when detached or not a repo. */
  branch: string | null
  /** The trunk the remote resolves (origin/HEAD, upstream, main/master), or null. */
  defaultBranch: string | null
  branches: Array<{ name: string; current: boolean }>
  worktrees: Array<{ path: string; branch: string | null; isMain: boolean }>
}

export type MeshWorkspaceCheckoutResult =
  { ok: true; checkout: MeshWorkspaceCheckout } | { ok: false; code: string; message: string }

/** A paired machine's `workspace.extensions` answer for one of its projects. */
export type MeshWorkspaceExtensionsResult =
  | { ok: true; extensions: import('./workspace-extensions').WorkspaceExtensions }
  | { ok: false; code: string; message: string }

/**
 * A paired machine's answers to its chat's Create PR (`chat-create-pull-request`),
 * one per step, as the shell's own channels answer them for a chat here
 * (`createPullRequestState`, `draftPullRequestText`, `pushForPullRequest`,
 * `createPullRequest`). The state carries no path on that machine: its
 * `gitRoot` is null. `text_generation_off` is a machine whose own text
 * generation is off, where the person writes the text themselves.
 */
export type MeshPullRequestStateResult =
  | { ok: true; state: import('./git/pull-request-create').CreatePullRequestState | null }
  | { ok: false; code: string; message: string }
export type MeshPullRequestDraftResult =
  { ok: true; title: string; body: string } | { ok: false; code: string; message: string }
export type MeshPullRequestPushResult = { ok: true; pushed: boolean } | { ok: false; code: string; message: string }
/**
 * A creation's end, as `createPullRequest` answers it, except that a pull
 * request created there was recorded there as the chat's: `recorded` says
 * whether that landed, and why not.
 */
export type MeshPullRequestCreateResult =
  | Exclude<import('./git/pull-request-create').CreatePullRequestOutcome, { ok: false } | { kind: 'created' }>
  | { ok: true; kind: 'created'; url: string; recorded: { ok: true } | { ok: false; message: string } }
  | { ok: false; code: string; message: string }

/**
 * A part of a browse this machine is not allowed to read, named with the reason.
 *
 * A device paired for conversations alone genuinely cannot list workspaces.
 * Showing an empty list would say "this machine has no workspaces", which is a
 * different — and false — statement.
 */
export type MeshGap = {
  part: 'workspaces'
  code: string
  message: string
}

/** One machine's contents, as the Mesh surface shows them. */
export type MeshBrowse = {
  connectionId: string
  /** False when the machine did not answer at all; everything below is then empty. */
  reachable: boolean
  /** Why it did not answer, in a sentence. Null when it did. */
  unreachableReason: string | null
  /** True when the remote refused our token — revoked or re-paired at the other end. */
  unauthorized: boolean
  /** Live scopes read from the remote, which may differ from what was stored at pairing. */
  scopes: TailnetScope[]
  workspaces: MeshWorkspace[]
  gaps: MeshGap[]
  /**
   * What the machine said in its handshake it can do (`TAILNET_CAPABILITIES`),
   * so a surface offers only what it will honour: New chat leaves its effort
   * control off for a machine without `new-chat-effort`. Null, or absent, when
   * it said nothing, which promises nothing.
   */
  capabilities?: string[] | null
}

/** The state of one followed remote conversation's link, as the pane badges it. */
export type MeshLinkState =
  /** Opening the socket for the first time. */
  | 'connecting'
  /** Following; frames are flowing. */
  | 'live'
  /** The socket dropped and we are dialling again. The transcript stays on screen. */
  | 'reconnecting'
  /** The peer is not answering. Quiet, not alarming — a sleeping laptop looks like this. */
  | 'offline'
  /** Finished for good: the conversation ended, access was revoked, or the pane stopped following. */
  | 'closed'

export type MeshPairResult = { ok: true; connection: MeshConnection } | { ok: false; code: string; message: string }

/**
 * Where a New chat on a paired machine runs when it is not the project's own
 * folder: a worktree cut for it there (a name, or '' for one made up there),
 * or a worktree the project already has, by the path `workspace.checkout`
 * listed. A machine is asked for one only where it advertises the capability
 * (`new-chat-worktree`, `new-chat-worktree-name`, `new-chat-in-worktree`).
 */
export type MeshNewChatWorktree = { kind: 'new'; name: string } | { kind: 'existing'; path: string }

/**
 * A chat agent started on a paired machine (`conversation.create`). The chat
 * is known there by its workspace and agent ids, which is what a pane follows
 * it by; `title` is the agent's name there. `worktree` is the worktree it runs
 * in there, as that machine answered; null for the project's own folder, or a
 * machine that does not say.
 */
export type MeshCreateConversationResult =
  | {
      ok: true
      workspaceId: string
      agentId: string
      title: string
      providerId: string
      modelId: string
      worktree?: { path: string; branch: string | null } | null
    }
  | { ok: false; code: string; message: string }

/**
 * A chat settled, or brought back, on a paired machine (`conversation.settle`).
 * `settledAt` is the machine's answer: when it was settled, or null when it is
 * in the list. `lifecycle_unsupported` is a machine that does not advertise
 * `conversation-lifecycle`.
 */
export type MeshSettleConversationResult =
  { ok: true; workspaceId: string; settledAt: number | null } | { ok: false; code: string; message: string }

/** A visit recorded on a paired machine (`conversation.visit`): the chat's visit clock there now. */
export type MeshVisitConversationResult =
  { ok: true; workspaceId: string; lastVisitedAt: number } | { ok: false; code: string; message: string }

/**
 * A row menu change to a chat on a paired machine, written to that machine's
 * record of it: Snooze and Wake now (`until: null`), Star and Highlight color
 * (a member left out stays as it is), Auto-settle (`chat-row-menu` there), and
 * Mark unread (`chat-mark-unread` there).
 */
export type MeshConversationChange =
  | { kind: 'snooze'; until: number | null }
  | { kind: 'highlight'; starred?: boolean; color?: ConversationHighlightColor | null }
  | { kind: 'auto-settle'; enabled: boolean }
  | { kind: 'mark-unread' }
  | MeshConversationManageChange

/**
 * A chat's management from a paired desktop, beyond its marks, each where
 * the machine advertises its capability (`MeshConversationManage`): Rename
 * (`chat-rename`), Auto compact (`chat-auto-compact`) and Stop watching
 * (`chat-unwatch-pull-request`).
 */
export type MeshConversationManageChange =
  | { kind: 'rename'; name: string }
  | { kind: 'auto-compact'; enabled: boolean }
  /** One agent's watch of a pull request, by its address; every watch the agent has without one. */
  | { kind: 'unwatch-pull-request'; agentId: string; url?: string }

/**
 * Which of a chat's management a paired machine takes from here, by the
 * capability each needs there. `rename`: `chat-rename`, the chat renamed
 * there, so every device lists it by the new name. `autoCompact`:
 * `chat-auto-compact`, the chat's Auto compact switched there, the machine
 * that runs it compacting it by itself. `unwatchPullRequest`:
 * `chat-unwatch-pull-request`, a watch of the chat's pull request ended
 * there, where its listed pull request says it is watched.
 */
export type MeshConversationManage = {
  rename: boolean
  autoCompact: boolean
  unwatchPullRequest: boolean
}

/** That machine took the change, or why not. `row_menu_unsupported` is a machine without the tool. */
export type MeshChangeConversationResult =
  { ok: true; workspaceId: string } | { ok: false; code: string; message: string }

/**
 * A pairing we have ASKED for and are waiting on, as a window sees
 * it. The collect secret is not here and never leaves main.
 */
export type MeshPairRequestView = {
  requestId: string
  endpoint: string
  machineName: string
  /**
   * The six digits the person at the other machine must TYPE to allow this
   * (pair-from-the-scan-and-stay-paired, phase 2). Minted over there; shown
   * large here so it can be read out.
   */
  comparisonCode: string
  expiresAt: string
  /** True when this request also offers the other machine a device here (phase 6). */
  reverseOffered: boolean
}

/**
 * How a request THIS machine made stopped waiting, or that it still is.
 * `failed` is the one phase the other machine never said: the wait ended
 * here (the credential could not be saved, or the reverse grant could not
 * be minted) and `detail` says why.
 */
export type MeshPairRequestPhase = 'waiting' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'failed'

/**
 * Whether a paired machine answers right now (phase 4), as main last checked
 * it. `unauthorized` is the one refusal that is not "asleep": the machine
 * answered and refused our credential, so it was revoked over there.
 */
export type MeshMachineReachability = {
  connectionId: string
  machineName: string
  /** A check is in flight; `reachable` is the previous answer meanwhile. */
  checking: boolean
  reachable: boolean
  unauthorized: boolean
  /** Epoch ms of the last completed check, or null before the first. */
  checkedAt: number | null
  /** Epoch ms of the last time the machine answered, or null if it never has. */
  lastReachedAt: number | null
  /** The failure in a sentence when not reachable; null otherwise. */
  detail: string | null
}

export type MeshRequestPairingResult =
  { ok: true; request: MeshPairRequestView } | { ok: false; code: string; message: string }

/**
 * The answer to one poll. `unreachable` is deliberately NOT an outcome here —
 * it comes back as `ok: false` so the panel keeps waiting rather than tearing
 * the request down: a machine that went to sleep mid-wait has not refused.
 */
export type MeshCollectPairingResult =
  | { ok: true; status: 'pending'; request: MeshPairRequestView }
  | { ok: true; status: 'approved'; connection: MeshConnection }
  | { ok: true; status: 'denied' }
  | { ok: true; status: 'expired' }
  | { ok: false; code: string; message: string }

/**
 * Broadcast mesh lifecycle (MC: remote-sessions-ux / tailnet-live-state-push).
 *
 * Distinct from a followed conversation's frame channel, which carries its
 * events to the one window that owns the pane. These are the whole-app facts
 * every window may care about — a machine paired or forgotten, answering or
 * not — pushed on one channel so chrome (the Remote glyph, toasts) never polls.
 */
export type MeshEvent =
  | { kind: 'machine-paired'; revision: number; connection: MeshConnection }
  | { kind: 'machine-forgotten'; revision: number; connectionId: string; machineName: string }
  /**
   * A request this machine made to pair with another (phase 3): main owns
   * the wait, so every surface — not just the panel that asked — can show
   * the code while it waits and the answer when it lands. `connection` rides
   * on `approved`; `detail` on `failed` and `denied`.
   */
  | {
      kind: 'pair-request'
      revision: number
      phase: MeshPairRequestPhase
      request: MeshPairRequestView
      connection?: MeshConnection
      detail?: string
    }
  | ({ kind: 'machine-reachability'; revision: number } & MeshMachineReachability)
  /**
   * A paired machine said its workspace list or conversation list changed
   * (2026-09-05, the change feed). Carries nothing else: a surface that
   * shows that machine re-reads it through the mesh's browse, which is the
   * read it already knows how to do — and no longer does on a timer.
   */
  | {
      kind: 'remote-changed'
      revision: number
      connectionId: string
      machineName: string
      what: 'workspaces' | 'conversations'
    }

/**
 * The initial read behind `MESH_EVENT_CHANNEL`, so a window that mounts (or
 * reloads) mid-wait starts where every other window is. Carries the same
 * monotonic `revision` the events do; a subscriber keeps whichever is newer.
 */
export type MeshLiveState = {
  revision: number
  /** Requests this machine made that are still waiting to be answered. */
  requests: MeshPairRequestView[]
  /** The last reachability answer per paired machine; absent before the first check. */
  reachability: MeshMachineReachability[]
}

export const MESH_EVENT_CHANNEL = 'mesh:event'
export const MESH_GET_LIVE_STATE_CHANNEL = 'mesh:get-live-state'

export const MESH_REQUEST_PAIRING_CHANNEL = 'mesh:request-pairing'
export const MESH_CANCEL_PAIRING_CHANNEL = 'mesh:cancel-pairing'
/** Re-check one paired machine now (the row's Retry), or every machine when no id is given. */
export const MESH_CHECK_REACHABILITY_CHANNEL = 'mesh:check-reachability'
export const MESH_LIST_CONNECTIONS_CHANNEL = 'mesh:list-connections'
export const MESH_PAIR_CHANNEL = 'mesh:pair'
export const MESH_FORGET_CHANNEL = 'mesh:forget'
/**
 * Forget a machine in BOTH directions at once (remote-settings-rebuild).
 *
 * `mesh:forget` drops only this machine's credential for a peer, and
 * `tailnet:revoke-device` only the peer's credential for this machine — two
 * halves of one pairing that a person thinks of as one relationship. A Remote
 * row's Revoke means "we are not paired any more", so it takes both, and takes
 * them tolerantly: a machine that only ever drove us has no connection to
 * forget, and one we only ever drove has no device to revoke.
 *
 * Named `tailnet:*` rather than `mesh:*` because it spans both stores; it
 * lives on the same IPC-only front door as the rest of that family.
 */
export const TAILNET_FORGET_MACHINE_CHANNEL = 'tailnet:forget-machine'
export const MESH_BROWSE_CHANNEL = 'mesh:browse'
/** Start a chat agent on a paired machine, over its `conversation.create`. */
export const MESH_CREATE_CONVERSATION_CHANNEL = 'mesh:create-conversation'
/** Settle a chat on a paired machine, or bring it back, over its `conversation.settle`. */
export const MESH_SETTLE_CONVERSATION_CHANNEL = 'mesh:settle-conversation'
/** Say a chat on a paired machine is on screen here, over its `conversation.visit`. */
export const MESH_VISIT_CONVERSATION_CHANNEL = 'mesh:visit-conversation'
/** A row menu change to a chat on a paired machine (`MeshConversationChange`). */
export const MESH_CHANGE_CONVERSATION_CHANNEL = 'mesh:change-conversation'
/** One remote workspace's checkout facts (branch, branches, worktrees) over `workspace.checkout`. */
export const MESH_WORKSPACE_CHECKOUT_CHANNEL = 'mesh:workspace-checkout'
export const MESH_WORKSPACE_EXTENSIONS_CHANNEL = 'mesh:workspace-extensions'
/** A remote chat's Create PR, one channel per step (`chat-create-pull-request`). */
export const MESH_CONVERSATION_PULL_REQUEST_STATE_CHANNEL = 'mesh:conversation-pull-request-state'
export const MESH_CONVERSATION_PULL_REQUEST_DRAFT_CHANNEL = 'mesh:conversation-pull-request-draft'
export const MESH_CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_CHANNEL = 'mesh:conversation-pull-request-draft-cancel'
export const MESH_CONVERSATION_PULL_REQUEST_PUSH_CHANNEL = 'mesh:conversation-pull-request-push'
export const MESH_CONVERSATION_PULL_REQUEST_CREATE_CHANNEL = 'mesh:conversation-pull-request-create'

/**
 * What forgetting a machine did, from the Mesh's side.
 *
 * The ids are reported back rather than assumed: a caller that passed both and
 * got one null knows the other half was already gone, which is a different
 * story from "nothing happened" and the difference a row needs to explain
 * itself.
 */
export type MeshForgetMachineResult = {
  connections: MeshConnection[]
  revokedDeviceId: string | null
  forgottenConnectionId: string | null
}

/** The same, plus the fresh listener status the inbound revoke produced. */
export type TailnetForgetMachineResult = MeshForgetMachineResult & {
  status: TailnetRemoteStatus
}

// ── Conversations on a paired machine ───────────────────────────────────────
//
// Main follows a conversation over that machine's conversation socket, keeps
// its transcript tail and cursor on disk, and hands a window the same frames
// the local session API does — `snapshot`, `event`, `synchronized`, `error` —
// plus `link`, the client-side connection state the far end cannot narrate
// while unreachable.

/** What a pairing may do with a machine's conversations: follow them, or also drive them. */
export type MeshConversationAccess = 'read' | 'operate'

/** One conversation on one paired machine. The ids are that machine's own. */
export type MeshConversationKey = { connectionId: string; workspaceId: string; agentId: string }

/** A conversation as that machine lists it, with the members its protocol version keeps. */
export type MeshConversation = ConversationThread

export type MeshConversationLink = {
  type: 'link'
  state: MeshLinkState
  detail: string
  /** What the far end lets this pairing do right now; null before it has said. */
  access: MeshConversationAccess | null
  /** Why a closed link will not come back on its own, when it will not. */
  code?: string
}

/**
 * The messages the machine holds for this conversation until its turn ends,
 * whole each time (`conversation-queued-sends`). The last list heard stands
 * while the link is down: that machine still holds them.
 */
export type MeshConversationQueued = { type: 'queued'; messages: MeshQueuedMessage[] }

/** A message a paired machine holds for its chat's turn to end, by that machine's id for it. */
export type MeshQueuedMessage = ConversationQueuedMessage

export type MeshConversationFrame = ConversationSessionFrame | MeshConversationLink | MeshConversationQueued

/**
 * `modelSwitch`: the machine advertises `conversation-models` — its list names
 * each chat's model catalog and it takes `setModel`. False for a machine that
 * does not, whose chats keep the model they have.
 *
 * `permissionModes`: the machine advertises `conversation-permission-modes` —
 * its chats run on `manual` and `auto` too. False for a machine that reads
 * those as `none`, where only `none` and `bypass` are offered.
 *
 * `lifecycle`: the machine advertises `conversation-lifecycle` — its list
 * leaves out settled chats and names their titles and clocks, and it takes
 * `conversation.settle` and `conversation.visit`. False for a machine that
 * does not, whose chats offer no Settle here.
 *
 * `queuedSends`: the machine advertises `conversation-queued-sends` — a
 * message queued in one of its chats mid-turn is handed to it at once, and it
 * sends it when the turn ends. False for a machine that does not, where the
 * message waits here and goes when the turn ends only if this machine is
 * awake to send it.
 *
 * `sendSkills`: the machine advertises `conversation-send-skills` and
 * `workspace-extensions` — a message to one of its chats may carry its skills,
 * listed for the composer by `meshWorkspaceExtensions`.
 *
 * `steerSends`: the machine advertises `conversation-steer-sends` — a message
 * may go into the turn one of its chats is running, where that chat's provider
 * takes one (its listed `capabilities.steer`). False for a machine that does
 * not, where a message sent mid-turn waits for the turn to end.
 *
 * `stopSubagents`: the machine advertises `conversation-stop-subagent` — one
 * agent a chat of its own spawned may be stopped by itself from here, where
 * that chat's provider can (its listed `capabilities.stopSubagent`). False for
 * a machine that does not, where an agent's lane offers no Stop.
 *
 * `createPullRequest`: the machine advertises `chat-create-pull-request` — a
 * chat of its own offers Create PR here, every step run over there.
 *
 * `rowMenu`: the machine advertises `chat-row-menu` — its chats' Star,
 * Highlight color, Snooze and Auto-settle are offered here, and written there.
 *
 * `markUnread`: the machine advertises `chat-mark-unread` — its chats offer
 * Mark unread here.
 */
export type MeshConversationListResult =
  | {
      ok: true
      conversations: MeshConversation[]
      access: MeshConversationAccess
      modelSwitch: boolean
      permissionModes?: boolean
      lifecycle?: boolean
      queuedSends?: boolean
      sendSkills?: boolean
      steerSends?: boolean
      stopSubagents?: boolean
      createPullRequest?: boolean
      rowMenu?: boolean
      markUnread?: boolean
      /** What of its chats' management the machine takes from here; absent from a build before it. */
      manage?: MeshConversationManage
    }
  | { ok: false; code: string; message: string }

/**
 * A step's picture from a paired machine, as a data URL a window can draw.
 * `images_unsupported` is a machine that does not serve pictures (it does not
 * advertise `conversation-images`); the picture stays over there.
 */
export type MeshConversationImageResult = { ok: true; dataUrl: string } | { ok: false; code: string; message: string }

/**
 * The commands a remote device may send. A permanent rule is not among them.
 * A queued send and taking one back need `conversation-queued-sends` there.
 */
export type MeshConversationCommand =
  | ConversationWireCommand
  | { kind: 'send'; message: string; queue: true }
  | { kind: 'cancelQueued'; queuedId: string }
  | { kind: 'stopSubagent'; toolUseId: string }

/** `notice` qualifies an accepted command, e.g. that a model switch applies from the next turn. */
export type MeshConversationCommandResult = { ok: true; notice?: string } | { ok: false; code: string; message: string }

/**
 * Whether a machine's listed chat is at work, waiting on a person, or neither.
 * A turn in flight is at work, and so is a chat whose turn is over while its
 * `backgroundWork` goes on, as the machine's own sidebar counts it
 * (`phaseWithBackgroundWork`). A machine from before it listed background work
 * says only the turn's phase, which is read as before.
 */
export function meshConversationPresence(
  phase: MeshConversation['phase'],
  backgroundWork?: MeshConversation['backgroundWork'] | null,
): 'running' | 'needs-input' | 'idle' {
  const counted = phaseWithBackgroundWork(phase, Boolean(backgroundWork))
  if (conversationPhaseWorking(counted)) return 'running'
  if (counted === 'waiting_for_approval' || counted === 'waiting_for_input') return 'needs-input'
  return 'idle'
}

/** The layout component of a chat pane following a conversation on a paired machine. */
export const MESH_CONVERSATION_COMPONENT = 'mesh-conversation'

/**
 * Whether a layout tab's component is a remote conversation pane. Layouts are
 * saved with their tabs, and ones saved before the client side was called the
 * mesh name this pane `fleet-conversation`; it reads as the same pane, so an
 * update reopens every remote chat a person had.
 *
 * A remote terminal pane (`mesh-terminal`, or `fleet-terminal` before that) is
 * not one. Terminals stopped crossing the tailnet on 2026-09-29, and such a tab
 * saved by an earlier build falls through to the layout's unavailable surface,
 * like any other stale tab.
 */
export function isMeshConversationPane(component: unknown): boolean {
  return component === MESH_CONVERSATION_COMPONENT || component === 'fleet-conversation'
}

/** A layout tab's component with a pre-rename remote pane read as its current name; any other unchanged. */
export function canonicalMeshPaneComponent<T>(component: T): T | typeof MESH_CONVERSATION_COMPONENT {
  return isMeshConversationPane(component) ? MESH_CONVERSATION_COMPONENT : component
}

/**
 * The id a remote conversation's row and pane are known by here: one id for
 * "what this pane shows on that machine", so a row finds the window already
 * showing it.
 */
export function meshConversationSessionId(workspaceId: string, agentId: string): string {
  return `conversation:${workspaceId}:${agentId}`
}

/** The channel one followed conversation's frames arrive on. The renderer picks the id and subscribes first. */
export function meshConversationFrameChannel(followId: string): string {
  return `mesh:conversation:${followId}`
}

export const MESH_CONVERSATION_LIST_CHANNEL = 'mesh:conversation-list'
export const MESH_CONVERSATION_FOLLOW_CHANNEL = 'mesh:conversation-follow'
export const MESH_CONVERSATION_UNFOLLOW_CHANNEL = 'mesh:conversation-unfollow'
export const MESH_CONVERSATION_EARLIER_CHANNEL = 'mesh:conversation-earlier'
export const MESH_CONVERSATION_COMMAND_CHANNEL = 'mesh:conversation-command'
export const MESH_CONVERSATION_SEND_CHANNEL = 'mesh:conversation-send'
export const MESH_CONVERSATION_TOOL_DETAIL_CHANNEL = 'mesh:conversation-tool-detail'
export const MESH_CONVERSATION_TURN_DIFF_CHANNEL = 'mesh:conversation-turn-diff'
export const MESH_CONVERSATION_TOOL_IMAGE_CHANNEL = 'mesh:conversation-tool-image'
