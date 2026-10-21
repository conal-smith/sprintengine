import { isMachinePath } from '../../shared/machine-paths'
import type { ConversationRuntime } from '../../main/conversation-runtime'

// What everything that drives or reads chats calls: the session API both IPC
// and the network wrap, the tailnet conversation host, the module conversation
// service, scheduled agents, companion agents and the IPC handlers.
//
// Today the only implementation is the in-process `ConversationRuntime`. The
// seam exists so a later phase can answer the same calls from another server
// (the one inside a WSL distribution, or one reached over SSH) and pick between
// them per workspace, without any of those callers changing. So a caller takes
// a `ConversationBackend`, never the runtime class, and a member belongs here
// only if a remote server could answer it too.
//
// What stays off it is the owner's business, on the owner handle the core
// hands out beside it: when its idle sweep runs, flushing and shutting down.

// `Pick` refuses a name the runtime does not have, so this list cannot drift
// from the class.
export type ConversationBackendMember =
  | 'onEvent'
  | 'listSessions'
  | 'sessionWorkspaceRoot'
  | 'listLiveConversationRoots'
  | 'liveConversationWorkspaceRoots'
  | 'getProviderCapabilities'
  | 'getNativeProviderModels'
  | 'startSession'
  | 'sendTurn'
  | 'hasCommandReceipt'
  | 'respondToRequest'
  | 'setPermission'
  | 'setModel'
  | 'mcpServerAction'
  | 'interrupt'
  | 'stopSubagent'
  | 'askSideQuestion'
  | 'cancelSideQuestion'
  | 'readContextBreakdown'
  | 'stopSession'
  | 'suspendSession'
  | 'terminalHandoffTarget'
  | 'stopForTerminalHandoff'
  | 'endTerminalHandoff'
  | 'noteTerminalHandoff'
  | 'getToolDetail'
  | 'findToolCall'
  | 'readAttachment'
  | 'planDocument'
  | 'listThreads'
  | 'searchThreads'
  | 'renameThread'
  | 'deleteTranscript'
  | 'readTranscript'
  | 'readPeekTranscript'
  | 'readConversationSync'
  | 'readConversationPage'
  | 'recoverTranscript'
  | 'getTurnDiff'
  | 'listApprovalRules'
  | 'revokeApprovalRule'
  | 'revertToTurn'
  | 'rewindToTurn'
  | 'forkAtTurn'

export type ConversationBackend = Pick<ConversationRuntime, ConversationBackendMember>

/**
 * The in-process backend: the runtime itself, seen only through the backend's
 * members. A view rather than a copy, so `this` inside each method is still the
 * runtime.
 */
export function localConversationBackend(runtime: ConversationRuntime): ConversationBackend {
  return runtime
}

/**
 * This process's runtime, refusing a chat whose folder is on an SSH machine
 * (`ssh://…`, shared/machine-paths.ts): it is that machine's server's to run,
 * and a path in that spelling handed to this computer's runtime would be read
 * as a folder here. Every member answers such a call as it fails, in words.
 */
export function refuseMachinePaths(backend: ConversationBackend): ConversationBackend {
  const named = (first: unknown): boolean => {
    if (typeof first !== 'object' || first === null) return false
    const record = first as { workspaceRoot?: unknown; key?: { workspaceRoot?: unknown } }
    return isMachinePath(record.workspaceRoot) || isMachinePath(record.key?.workspaceRoot)
  }
  const message = 'This chat is on an SSH machine. Turn SSH machines on (Settings › Agents › Studio server) to open it.'
  // One wrapper per member, so a member read twice is the same function (a
  // listener handed in and later taken out again is found).
  const wrapped = new Map<PropertyKey, { of: unknown; fn: (...args: unknown[]) => unknown }>()
  return new Proxy(backend, {
    get(target, member, receiver) {
      const value = Reflect.get(target, member, receiver) as unknown
      if (typeof value !== 'function') return value
      const known = wrapped.get(member)
      if (known && known.of === value) return known.fn
      const fn = (...args: unknown[]) => {
        if (args.length > 0 && named(args[0]))
          return member === 'recoverTranscript'
            ? Promise.reject(new Error(message))
            : Promise.resolve({ ok: false, message })
        return (value as (...input: unknown[]) => unknown).apply(target, args)
      }
      wrapped.set(member, { of: value, fn })
      return fn
    },
  })
}
