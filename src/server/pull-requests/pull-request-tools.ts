import type { BranchPullRequest } from '../../shared/git/pull-request'
import { toolError, toolSuccess, type McpToolRegistration } from '../../shared/modules/mcp-tools'
import { gatewayConversation } from '../tools/client-tool-gateway'
import type { NoteOpenedOutcome, PullRequestConversationKey, WatchOutcome } from './pull-request-record'

// The gateway's pull request tool: how an agent says "I opened this" (owner
// ruling 2026-10-04). The server notices the common create commands on its own
// (`src/shared/git/pull-request-opened.ts`); this is the way for every other
// forge and every other way of opening one, and it costs nothing to call after
// those too.
//
// Whose pull request it is comes from the CONNECTION, never from the
// arguments: the calling agent's workspace and agent, as the launch token the
// connection presented proves them. A connection that only declared an agent
// (the person's own scripts, a paired device, anything that can reach the
// socket) is not a conversation, and is refused.

/** Linking records a pull request against a conversation: a mutation, audited. */
export const PULL_REQUEST_LINK_TOOL = 'pull_request.link'
/** Watching has Studio babysit a conversation's pull request and wake its chat (`pull-request-watch.ts`). */
export const PULL_REQUEST_WATCH_TOOL = 'pull_request.watch'
export const PULL_REQUEST_UNWATCH_TOOL = 'pull_request.unwatch'

export type PullRequestToolsDeps = {
  link(key: PullRequestConversationKey, input: { url: string; title?: string }): Promise<NoteOpenedOutcome>
  watch(key: PullRequestConversationKey, input: { url: string }): Promise<WatchOutcome>
  unwatch(key: PullRequestConversationKey, input: { url: string }): boolean
  /** The pull requests the conversation opened, newest first, the ones from its own branch marked. */
  pullRequestsOf(key: PullRequestConversationKey): BranchPullRequest[]
  /**
   * Whether the conversation is a chat, which Studio can wake with a message.
   * A terminal agent reads whatever is typed at its prompt, and Studio does
   * not type a watch's news into one.
   */
  isChat(key: PullRequestConversationKey): boolean
}

const PULL_REQUEST_ARGUMENT = {
  description:
    "The pull request: its number (e.g. 234) or its URL. Leave it out for this chat's pull request from the branch " +
    'its checkout is on.',
  type: ['integer', 'string'],
}

type Target = { ok: true; url: string } | { ok: false; code: string; message: string }

/**
 * Which pull request a call names: a URL as given (watching links it first),
 * a number among the conversation's own, or, with neither, the one open from
 * the branch its checkout is on, else its only open one.
 */
function resolveTarget(value: unknown, mine: readonly BranchPullRequest[]): Target {
  const github = mine.filter((pr) => !pr.forge)
  if (typeof value === 'string' && /^\s*https?:\/\//i.test(value)) {
    if (value.length > 2048) return { ok: false, code: 'invalid_arguments', message: '"pullRequest" is too long.' }
    return { ok: true, url: value.trim() }
  }
  const number =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim().replace(/^#/, '')) : NaN
  if (value !== undefined && !(Number.isInteger(number) && number > 0)) {
    return { ok: false, code: 'invalid_arguments', message: '"pullRequest" is a pull request number or URL.' }
  }
  if (value !== undefined) {
    const found = github.filter((pr) => pr.number === number)
    const pick = found.find((pr) => pr.onSessionBranch) ?? found[0]
    if (!pick)
      return {
        ok: false,
        code: 'not_found',
        message: `No pull request #${number} is this chat's on record. Pass its URL, which records it too.`,
      }
    return { ok: true, url: pick.url }
  }
  const candidates = github.filter((pr) => pr.state === 'open')
  const pick = candidates.find((pr) => pr.onSessionBranch) ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (pick) return { ok: true, url: pick.url }
  if (candidates.length === 0)
    return {
      ok: false,
      code: 'not_found',
      message: 'This chat has no open GitHub pull request on record. Open one (`gh pr create`), or pass its URL.',
    }
  return {
    ok: false,
    code: 'invalid_arguments',
    message: `This chat has ${candidates.length} open pull requests (${candidates.map((pr) => `#${pr.number}`).join(', ')}); say which.`,
  }
}

export function createPullRequestTools(deps: PullRequestToolsDeps): McpToolRegistration[] {
  return [
    {
      name: PULL_REQUEST_LINK_TOOL,
      description:
        "Record a pull request or merge request you just opened as this conversation's, so SprintEngine Studio " +
        'shows it on the conversation and follows it until it merges. Call this right after you create one, on any ' +
        'forge (GitHub, GitLab, Gitea, Forgejo, Codeberg, Bitbucket, Azure DevOps, self-hosted or not), with the URL ' +
        'the forge gave you. Link only what you opened: one another conversation linked first stays with it. ' +
        'Studio notices `gh pr create` and `glab mr create` on its own, and linking after those is harmless.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              "The pull request's web URL, e.g. https://github.com/acme/app/pull/12 or " +
              'https://gitlab.com/acme/app/-/merge_requests/12.',
          },
          title: { type: 'string', description: "Its title, shown until the forge's own is read." },
        },
        required: ['url'],
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        // The conversation the connection's launch token proved, not the ids
        // it declared: any local connection can declare an agent id, and a
        // link written under one would put a server or a pull request on
        // somebody else's conversation.
        const conversation = gatewayConversation(context)
        if (!conversation) {
          return toolError(
            'not_a_conversation',
            'Only an agent SprintEngine Studio started can link a pull request: it is recorded as that ' +
              "agent's conversation's.",
          )
        }
        if (typeof args.url !== 'string' || !args.url.trim() || args.url.length > 2048) {
          return toolError('invalid_arguments', '"url" is the pull request\'s web URL.')
        }
        if (args.title !== undefined && typeof args.title !== 'string') {
          return toolError('invalid_arguments', '"title" must be a string when provided.')
        }
        const outcome = await deps.link(
          { workspaceId: conversation.workspaceId, agentId: conversation.agentId },
          { url: args.url.trim(), ...(typeof args.title === 'string' ? { title: args.title } : {}) },
        )
        if (!outcome.ok) return toolError(outcome.code, outcome.message)
        const { pullRequest } = outcome
        return toolSuccess({
          linked: true,
          alreadyLinked: !outcome.recorded,
          pullRequest: {
            url: pullRequest.url,
            number: pullRequest.number,
            repository: pullRequest.repoKey,
            forge: pullRequest.forge ?? 'github',
            // Read from GitHub; a pull request on another forge is shown as opened.
            ...(pullRequest.forge ? {} : { state: pullRequest.state }),
          },
        })
      },
    },
    {
      name: PULL_REQUEST_WATCH_TOOL,
      description:
        "Have SprintEngine Studio babysit one of this chat's GitHub pull requests. Studio reads it every two " +
        'minutes and wakes this chat with a message when it needs you: a check failed, all required checks passed, ' +
        'the branch fell behind or conflicts with its base, someone else reviewed or commented (an approval or ' +
        'changes requested is said as such), or it merged or closed. Use this instead of polling, sleeping, ' +
        '`gh pr checks --watch` or any other watch loop, and end your turn right after calling it: you are woken ' +
        'when there is something to do. A wake is news, not a merge decision: check the pull request is approved ' +
        'and green before you merge it. Only comments written after this call wake you, so deal with the ones ' +
        'already there first. Call pull_request.unwatch when you hand the work back to the person. The watch also ' +
        'ends when the pull request merges or closes, when the chat is settled or deleted, after 10 wakes in a ' +
        'row that bring only comments, or after 8 failed reads in a row (a GitHub rate limit only pauses it). A ' +
        'pull request this chat has not recorded yet is recorded as its own first, as pull_request.link does.',
      inputSchema: {
        type: 'object',
        properties: { pullRequest: PULL_REQUEST_ARGUMENT },
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        // The conversation the launch token proved, as for linking: a watch
        // made under a declared id would wake somebody else's chat.
        const conversation = gatewayConversation(context)
        if (!conversation) {
          return toolError(
            'not_a_conversation',
            'Only an agent SprintEngine Studio started can have a pull request watched: the watch wakes that ' +
              "agent's chat.",
          )
        }
        const key = { workspaceId: conversation.workspaceId, agentId: conversation.agentId }
        if (!deps.isChat(key)) {
          return toolError(
            'not_a_chat',
            'Studio wakes a chat with a watch’s news, and this agent runs in a terminal, which Studio does not ' +
              'type into. Check the pull request with `gh pr checks` and `gh pr view` when you need to.',
          )
        }
        const target = resolveTarget(args.pullRequest, deps.pullRequestsOf(key))
        if (!target.ok) return toolError(target.code, target.message)
        const outcome = await deps.watch(key, { url: target.url })
        if (!outcome.ok) return toolError(outcome.code, outcome.message)
        const { pullRequest } = outcome
        return toolSuccess({
          watching: true,
          alreadyWatching: outcome.alreadyWatching,
          pullRequest: { url: pullRequest.url, number: pullRequest.number, repository: pullRequest.repoKey },
          next: 'End your turn now. Studio wakes this chat when the pull request needs you.',
        })
      },
    },
    {
      name: PULL_REQUEST_UNWATCH_TOOL,
      description:
        "Stop SprintEngine Studio watching one of this chat's pull requests (see pull_request.watch). Call it when " +
        'you hand the work back to the person, so the chat stops waiting on the pull request. The pull request ' +
        "stays the chat's. Leave out the pull request to stop every watch this chat has.",
      inputSchema: {
        type: 'object',
        properties: { pullRequest: PULL_REQUEST_ARGUMENT },
        additionalProperties: false,
      },
      mutates: true,
      handler: async (args, context) => {
        const conversation = gatewayConversation(context)
        if (!conversation) {
          return toolError(
            'not_a_conversation',
            'Only an agent SprintEngine Studio started can stop a watch: a watch is its chat’s.',
          )
        }
        const key = { workspaceId: conversation.workspaceId, agentId: conversation.agentId }
        const mine = deps.pullRequestsOf(key)
        const urls =
          args.pullRequest === undefined
            ? mine.filter((pr) => pr.watch).map((pr) => pr.url)
            : (() => {
                const target = resolveTarget(args.pullRequest, mine)
                return target.ok ? [target.url] : target
              })()
        if (!Array.isArray(urls)) return toolError(urls.code, urls.message)
        const stopped = urls.filter((url) => deps.unwatch(key, { url }))
        return toolSuccess({ stopped: stopped.length, pullRequests: stopped })
      },
    },
  ]
}
