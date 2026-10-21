import type {
  CreatePullRequestOutcome,
  CreatePullRequestState,
  PullRequestCheckoutPin,
  PushForPullRequestOutcome,
} from '../../../../../shared/git/pull-request-create'
import type { MeshConversationKey } from '../../../../../shared/tailnet-mesh'
import { resolveStoreTextGenerationEngine } from '../../../store/generatedWorkspaceTitle'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { linkPullRequestToConversation } from '../../workspace/useConversationPullRequests'

// Where the chat's "Create PR" does its work. The button, its dialog and the
// sentences on the strip are the same for every chat (owner ruling
// 2026-10-18: apart from the machine's mark, a remote chat looks and behaves
// as a local one); what differs is which machine reads the checkout, writes
// the draft, pushes and opens the pull request. A chat here asks this
// computer's shell; a chat on a paired machine asks that machine, in its own
// checkout, with its own text generation settings. Opening the forge's page
// and the clipboard stay on this computer, in front of the person, whichever
// machine did the work.

/** A drafted title and description, or the sentence the dialog shows instead. */
export type PullRequestDraftOutcome = { ok: true; title: string; body: string } | { ok: false; message: string }

/** A draft as a host starts it: refused at once (nothing here can write one), or being written. */
export type PullRequestDraft = { refused: string } | { written: Promise<PullRequestDraftOutcome> }

export type PullRequestHost = {
  /** Whether the checkout is ready to propose; null when it cannot say (not a checkout, no shell to ask). */
  state(): Promise<CreatePullRequestState | null>
  /** Draft a title and description, named so `cancelDraft` can stop it. */
  draft(draftId: string): PullRequestDraft
  cancelDraft(draftId: string): Promise<void>
  push(pin?: PullRequestCheckoutPin): Promise<PushForPullRequestOutcome>
  create(text: { title: string; body: string }, pin?: PullRequestCheckoutPin): Promise<CreatePullRequestOutcome>
  /** Record a pull request it created as the conversation's. */
  link(url: string, title: string): Promise<{ ok: true } | { ok: false; message: string }>
}

const draftFailed = (message: string) => `The draft could not be written: ${message}`

/** This computer's checkout at `cwd`, through the shell's own channels, recorded as `conversation`'s. */
export function localPullRequestHost(
  cwd: string,
  conversation: { workspaceId: string; agentId: string },
): PullRequestHost {
  return {
    state: async () => {
      const api = typeof window === 'undefined' ? undefined : window.api
      if (typeof api?.createPullRequestState !== 'function') return null
      return api.createPullRequestState(cwd)
    },
    draft: (draftId) => {
      const engine = resolveStoreTextGenerationEngine()
      if (!engine)
        return {
          refused:
            'Text generation is off (Settings → Agents → Text generation), so write the title and description here.',
        }
      // The style the title is written in and the CLI overrides (Settings →
      // Agents), read as the draft starts, like the engine.
      const { cliRuntimes, textGeneration } = useWorkspaceStore.getState().appSettings
      return {
        written: window.api
          .draftPullRequestText({
            cwd,
            engine,
            draftId,
            writingStyle: textGeneration.writingStyle,
            ...(cliRuntimes ? { cliRuntimes } : {}),
          })
          .then((result) =>
            result.ok
              ? { ok: true as const, title: result.value.title, body: result.value.body }
              : { ok: false as const, message: draftFailed(result.message) },
          ),
      }
    },
    cancelDraft: async (draftId) => {
      await window.api.cancelPullRequestDraft?.(draftId)
    },
    push: (pin) => window.api.pushForPullRequest(cwd, pin),
    create: (text, pin) => window.api.createPullRequest({ cwd, ...text, ...(pin ? { pin } : {}) }),
    link: (url, title) => linkPullRequestToConversation(conversation, url, title),
  }
}

/**
 * A chat on a paired machine, every step asked of that machine
 * (`chat-create-pull-request`). It records a pull request it creates as the
 * chat's itself, so `link` here only says how that went and asks for the
 * machine's list again, which flips the slot to "Open PR #N".
 */
export function remotePullRequestHost(key: MeshConversationKey, onRecorded: () => void): PullRequestHost {
  const recorded = new Map<string, { ok: true } | { ok: false; message: string }>()
  return {
    state: async () => {
      const result = await window.api.meshConversationPullRequestState({ key })
      return result.ok ? result.state : null
    },
    draft: (draftId) => ({
      written: window.api.meshConversationPullRequestDraft({ key, draftId }).then((result) =>
        result.ok
          ? { ok: true as const, title: result.title, body: result.body }
          : // That machine's text generation being off is said as it is, not as a failure.
            {
              ok: false as const,
              message: result.code === 'text_generation_off' ? result.message : draftFailed(result.message),
            },
      ),
    }),
    cancelDraft: async (draftId) => {
      await window.api.meshConversationPullRequestDraftCancel({ key, draftId })
    },
    push: (pin) => window.api.meshConversationPullRequestPush({ key, ...(pin ? { pin } : {}) }),
    create: async (text, pin) => {
      const created = await window.api.meshConversationPullRequestCreate({ key, ...text, ...(pin ? { pin } : {}) })
      if (!created.ok || created.kind !== 'created') return created
      recorded.set(created.url, created.recorded)
      return { ok: true, kind: 'created', url: created.url }
    },
    link: async (url) => {
      const outcome = recorded.get(url) ?? { ok: true }
      recorded.delete(url)
      onRecorded()
      return outcome
    },
  }
}
