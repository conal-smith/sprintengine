import { conversationWorkingRoot } from '../../shared/agent-state'
import {
  PULL_REQUEST_BODY_MAX_CHARS,
  PULL_REQUEST_TITLE_MAX_CHARS,
  readPullRequestCheckoutPin,
  type CreatePullRequestOutcome,
  type CreatePullRequestState,
  type PullRequestCheckoutPin,
  type PushForPullRequestOutcome,
} from '../../shared/git/pull-request-create'
import {
  toolError,
  toolSuccess,
  type McpConnectionContext,
  type McpToolRegistration,
  type McpToolResult,
} from '../../shared/modules/mcp-tools'
import type {
  PullRequestTextRequest,
  PullRequestTextResult,
  TextGenerationCliRuntimeOverrides,
  TextGenerationEngine,
} from '../../shared/text-generation/contract'
import type { TextGenerationWritingStyle } from '../../shared/text-generation/writing-style'
import type { WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { createDraftRuns } from '../ipc/text-generation-draft'
import type { DraftInputOutcome } from '../pull-request-create'

// The chat's "Create PR" for a paired desktop that follows one of this
// machine's chats (owner ruling 2026-10-18: apart from the machine's mark, a
// remote chat looks and behaves as a local one). The checkout, git, the
// forge's CLI and the agent CLI that drafts the text are all here, so every
// step runs here, in the chat's own checkout, as the shell's channels run it
// for a window on this machine (`ipc/pull-request-create-ipc.ts`).
//
// A call names the CHAT, never a folder: this machine resolves the folder the
// chat works in from its own record, so a paired device can reach no checkout
// but a chat's, and learns no path on this disk (the state's `gitRoot` is left
// out). The draft is written with this machine's text generation settings,
// as a chat here is titled with them; a machine where it is off says so, and
// the person writes the text themselves. A pull request opened here is
// recorded as the chat's here, where its record lives, and the paired
// device's next read of the list carries it.
//
// Reading whether the button may show is a read, on `conversation:read` like
// the list it sits beside; everything else pushes, opens or spends a CLI
// run, and needs `conversation:operate`, as sending into the chat does.

export const CONVERSATION_PULL_REQUEST_STATE_TOOL = 'conversation.pull_request_state'
export const CONVERSATION_PULL_REQUEST_DRAFT_TOOL = 'conversation.pull_request_draft'
export const CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_TOOL = 'conversation.pull_request_draft_cancel'
export const CONVERSATION_PULL_REQUEST_PUSH_TOOL = 'conversation.pull_request_push'
export const CONVERSATION_PULL_REQUEST_CREATE_TOOL = 'conversation.pull_request_create'

/** Classified as mutations: audited, and `conversation:operate` from a paired device (tailnet-scopes.ts). */
export const CONVERSATION_PULL_REQUEST_MUTATION_TOOL_NAMES: readonly string[] = [
  CONVERSATION_PULL_REQUEST_DRAFT_TOOL,
  CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_TOOL,
  CONVERSATION_PULL_REQUEST_PUSH_TOOL,
  CONVERSATION_PULL_REQUEST_CREATE_TOOL,
]

type ChatKey = { workspaceId: string; agentId: string }

export type ChatCheckout = { ok: true; root: string } | { ok: false; code: string; message: string }

/** What drafts this machine's text: the engine its settings resolve to, the CLI overrides and the writing style. */
export type PullRequestDraftEngine = {
  engine: TextGenerationEngine
  cliRuntimes?: TextGenerationCliRuntimeOverrides
  writingStyle: TextGenerationWritingStyle
}

export type ConversationPullRequestToolsDeps = {
  /** The folder a chat works in on this disk, or why it has none here. */
  checkoutOf(key: ChatKey): ChatCheckout
  creator: {
    state(cwd: string): Promise<CreatePullRequestState>
    draftInput(cwd: string): Promise<DraftInputOutcome>
    push(cwd: string, pin?: PullRequestCheckoutPin): Promise<PushForPullRequestOutcome>
    create(
      cwd: string,
      text: { title: string; body: string },
      pin?: PullRequestCheckoutPin,
    ): Promise<CreatePullRequestOutcome>
  }
  /** The engine this machine's settings draft with; null when text generation is off or no CLI can. */
  draftEngine(): PullRequestDraftEngine | null
  generate(request: PullRequestTextRequest): Promise<PullRequestTextResult>
  /** Record the pull request as the chat's, as the shell's "Create PR" records it (`pullRequests.link`). */
  link(input: {
    conversation: ChatKey
    url: string
    title: string
  }): Promise<{ ok: true } | { ok: false; message: string }>
  /** A draft that could not be written, for the diagnostics log. */
  log?(message: string): void
}

/**
 * The folder a chat works in, read from this machine's registry: its
 * worktree when it runs in one, else its workspace's folder. A workspace on
 * WSL or an SSH machine has its folder on that machine's disk, where this
 * process has no git to run.
 */
export function chatCheckoutFromRegistry(
  getRecord: (workspaceId: string) => WorkspaceRegistryRecord | null,
): (key: ChatKey) => ChatCheckout {
  return (key) => {
    const record = getRecord(key.workspaceId)
    if (!record)
      return { ok: false, code: 'unknown_workspace', message: `Workspace "${key.workspaceId}" is not known here.` }
    const agent = record.agents[key.agentId]
    if (!agent) return { ok: false, code: 'unknown_conversation', message: 'That chat is not known here.' }
    if (record.environment)
      return {
        ok: false,
        code: 'checkout_elsewhere',
        message: "That chat's checkout is on another machine, and Create PR works in this machine's checkouts only.",
      }
    const root = conversationWorkingRoot(agent, record.folderPath)
    if (!root) return { ok: false, code: 'workspace_without_folder', message: 'That chat has no folder here.' }
    return { ok: true, root }
  }
}

const ID_MAX = 200

const CHAT_PROPERTIES = {
  workspaceId: { type: 'string', description: 'The workspace id of the chat, as conversation.create answered it.' },
  agentId: { type: 'string', description: 'The agent id of the chat.' },
}

const PIN_PROPERTY = {
  type: 'object',
  description:
    'The branch and commit conversation.pull_request_state answered (`branch`, `headSha`). Refused once the ' +
    'checkout has moved off it, so nothing is pushed or opened that was not seen.',
  properties: { branch: { type: 'string' }, headSha: { type: 'string' } },
  required: ['branch', 'headSha'],
  additionalProperties: false,
}

function idArg(args: Record<string, unknown>, key: string): string | McpToolResult {
  const value = args[key]
  if (typeof value !== 'string' || !value || value.length > ID_MAX)
    return toolError('invalid_arguments', `"${key}" must be a non-empty string.`)
  return value
}

/** The chat a call names, and the folder it works in here. */
function resolveChat(
  deps: ConversationPullRequestToolsDeps,
  args: Record<string, unknown>,
): { key: ChatKey; root: string } | McpToolResult {
  const workspaceId = idArg(args, 'workspaceId')
  if (typeof workspaceId !== 'string') return workspaceId
  const agentId = idArg(args, 'agentId')
  if (typeof agentId !== 'string') return agentId
  const key = { workspaceId, agentId }
  const checkout = deps.checkoutOf(key)
  if (!checkout.ok) return toolError(checkout.code, checkout.message)
  return { key, root: checkout.root }
}

/** The pin a call carries: absent is the checkout as it stands; one that is not a pin is refused, never dropped. */
function pinArg(args: Record<string, unknown>): { pin: PullRequestCheckoutPin | undefined } | McpToolResult {
  if (args.pin === undefined) return { pin: undefined }
  const pin = readPullRequestCheckoutPin(args.pin)
  if (!pin) return toolError('invalid_arguments', '"pin" is the branch and commit the state answered.')
  return { pin }
}

const isResult = (value: object): value is McpToolResult => 'content' in value

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createConversationPullRequestTools(deps: ConversationPullRequestToolsDeps): McpToolRegistration[] {
  // Drafts in flight, by the caller, the chat and the id the caller gave
  // each: one device's cancel reaches only its own draft.
  const drafts = createDraftRuns()
  const draftKey = (context: McpConnectionContext | undefined, key: ChatKey, draftId: string) =>
    [context?.metadata.deviceId ?? context?.metadata.kind ?? 'local', key.workspaceId, key.agentId, draftId].join('\0')

  const state: McpToolRegistration = {
    name: CONVERSATION_PULL_REQUEST_STATE_TOOL,
    description:
      "Whether a chat's checkout is ready for a pull request, as the chat's Create PR button asks: `state` is null " +
      'when the folder is not a checkout, else `readiness` (`ready`, or the `reason` it is not), the `branch` and ' +
      '`headSha` to pin the push and the creation to, `base`, `forge`, and how many `uncommittedChanges` the pull ' +
      'request would leave out.',
    inputSchema: {
      type: 'object',
      properties: CHAT_PROPERTIES,
      required: ['workspaceId', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const chat = resolveChat(deps, args)
      if (isResult(chat)) return chat
      const read = await deps.creator.state(chat.root).catch(() => null)
      // No path on this machine in the answer.
      return toolSuccess({ ok: true, ...chat.key, state: read ? { ...read, gitRoot: null } : null })
    },
  }

  const draft: McpToolRegistration = {
    name: CONVERSATION_PULL_REQUEST_DRAFT_TOOL,
    description:
      "Draft a pull request's `title` and `body` from the chat's branch (its commits, diff and the repository's " +
      'template) with this machine\'s text generation settings. Refused with "text_generation_off" where they are ' +
      'off or no CLI here can write one. Name it with `draftId` to stop it with conversation.pull_request_draft_cancel.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CHAT_PROPERTIES,
        draftId: { type: 'string', description: 'A name for this draft, to cancel it by.' },
      },
      required: ['workspaceId', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const chat = resolveChat(deps, args)
      if (isResult(chat)) return chat
      if (
        args.draftId !== undefined &&
        (typeof args.draftId !== 'string' || !args.draftId || args.draftId.length > ID_MAX)
      )
        return toolError('invalid_arguments', '"draftId" must be a non-empty string when provided.')
      const engine = deps.draftEngine()
      if (!engine)
        return toolError(
          'text_generation_off',
          'Text generation is off on this machine (Settings → Agents → Text generation), so write the title and description yourself.',
        )
      const draftId = typeof args.draftId === 'string' ? draftKey(context, chat.key, args.draftId) : null
      const result = await drafts.run(draftId, async (signal): Promise<PullRequestTextResult> => {
        const gathered = await deps.creator.draftInput(chat.root)
        if (!gathered.ok) return { ok: false, code: 'unsupported', message: gathered.message }
        return deps.generate({
          input: { ...gathered.input, style: engine.writingStyle },
          engine: engine.engine,
          ...(engine.cliRuntimes ? { cliRuntimes: engine.cliRuntimes } : {}),
          signal,
        })
      })
      if (!result.ok) {
        if (result.code !== 'cancelled') deps.log?.(`${engine.engine.cli}: ${result.code} — ${result.message}`)
        return toolError(result.code === 'cancelled' ? 'cancelled' : 'draft_failed', result.message)
      }
      return toolSuccess({ ok: true, title: result.value.title, body: result.value.body })
    },
  }

  const draftCancel: McpToolRegistration = {
    name: CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_TOOL,
    description: 'Stop a draft conversation.pull_request_draft is writing, by the `draftId` it was given.',
    inputSchema: {
      type: 'object',
      properties: { ...CHAT_PROPERTIES, draftId: { type: 'string', description: 'The draft to stop.' } },
      required: ['workspaceId', 'agentId', 'draftId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const workspaceId = idArg(args, 'workspaceId')
      if (typeof workspaceId !== 'string') return workspaceId
      const agentId = idArg(args, 'agentId')
      if (typeof agentId !== 'string') return agentId
      const draftId = idArg(args, 'draftId')
      if (typeof draftId !== 'string') return draftId
      drafts.cancel(draftKey(context, { workspaceId, agentId }, draftId))
      return toolSuccess({ ok: true })
    },
  }

  const push: McpToolRegistration = {
    name: CONVERSATION_PULL_REQUEST_PUSH_TOOL,
    description:
      "Push the chat's branch to its own name on its push remote when that does not have all of it, as Create PR " +
      'does before it opens the pull request. `pushed` says whether anything went.',
    inputSchema: {
      type: 'object',
      properties: { ...CHAT_PROPERTIES, pin: PIN_PROPERTY },
      required: ['workspaceId', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const chat = resolveChat(deps, args)
      if (isResult(chat)) return chat
      const pinned = pinArg(args)
      if (isResult(pinned)) return pinned
      const pushed = await deps.creator
        .push(chat.root, pinned.pin)
        .catch((error: unknown): PushForPullRequestOutcome => ({ ok: false, message: describe(error) }))
      if (!pushed.ok) return toolError('push_failed', pushed.message)
      return toolSuccess({ ok: true, pushed: pushed.pushed })
    },
  }

  const create: McpToolRegistration = {
    name: CONVERSATION_PULL_REQUEST_CREATE_TOOL,
    description:
      "Open a pull request from the chat's branch with the forge's CLI (gh, glab or tea), as Create PR does. " +
      "`kind` is `created` (recorded as the chat's; `recorded` says whether that landed), `existing` (the branch " +
      "had one, not claimed for the chat), `page` (the forge's own page to finish it on, with `place` and why in " +
      "`reason`) or `list` (probably opened, address unknown: the forge's list to look in).",
    inputSchema: {
      type: 'object',
      properties: {
        ...CHAT_PROPERTIES,
        title: { type: 'string', description: "The pull request's title." },
        body: { type: 'string', description: 'Its description, in Markdown.' },
        pin: PIN_PROPERTY,
      },
      required: ['workspaceId', 'agentId', 'title', 'body'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const chat = resolveChat(deps, args)
      if (isResult(chat)) return chat
      if (typeof args.title !== 'string' || !args.title.trim() || typeof args.body !== 'string')
        return toolError('invalid_arguments', '"title" and "body" are the pull request\'s text.')
      const pinned = pinArg(args)
      if (isResult(pinned)) return pinned
      const text = {
        title: args.title.trim().slice(0, PULL_REQUEST_TITLE_MAX_CHARS),
        body: args.body.slice(0, PULL_REQUEST_BODY_MAX_CHARS),
      }
      const outcome = await deps.creator
        .create(chat.root, text, pinned.pin)
        .catch((error: unknown): CreatePullRequestOutcome => ({ ok: false, message: describe(error) }))
      if (!outcome.ok) return toolError('create_failed', outcome.message)
      if (outcome.kind !== 'created') return toolSuccess({ ...outcome })
      // Recorded here, where the chat's record is; a failure to record is
      // said with the address, since the pull request exists either way.
      const linked = await deps
        .link({ conversation: chat.key, url: outcome.url, title: text.title })
        .catch((error: unknown) => ({ ok: false as const, message: describe(error) }))
      return toolSuccess({
        ...outcome,
        recorded: linked.ok,
        ...(linked.ok
          ? {}
          : {
              recordMessage: `The pull request is open (${outcome.url}), but it could not be recorded: ${linked.message}`,
            }),
      })
    },
  }

  return [state, draft, draftCancel, push, create]
}
