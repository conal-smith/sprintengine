/**
 * Titling a chat from what the person first said in it, in the process that
 * runs the chat.
 *
 * A window used to do this, from its list of chat sessions, and that list
 * stands still while the window cannot be seen and does not exist with no
 * window open. So a chat started from a phone — by a person who is, by
 * definition, away from the desk — kept the heuristic title at best, and
 * "Chat N" when its first message came with pictures and so after the chat
 * was made. Here the title follows the chat's own events, whichever door the
 * message came through: a window, a phone, a paired machine, a schedule.
 *
 * The two halves are the window's, in the same order
 * (`renderer/src/store/generatedWorkspaceTitle.ts`): the heuristic lands at
 * once, and when the person has model-written titles on and a supported agent
 * CLI is installed, the model's title replaces it when it arrives. The rules
 * that keep it honest are the store's (`applyGeneratedWorkspaceTitle`), kept
 * the same:
 *
 * - A locked name is never touched. A hand rename locks, an explicit name at
 *   birth is locked, and a title that lands locks too, so the name stops
 *   moving with the chat's next message.
 * - A late model title replaces exactly the name it was asked to replace, so a
 *   rename the person made while it was being written stands.
 *
 * One model call per chat workspace, whatever comes of it: a title nobody is
 * waiting on is not worth a second call per message. Later messages still get
 * the heuristic while the name is open, which is what covers a first message
 * with no words to title from.
 *
 * Studio's own messages (an agent's notice, a resume after a usage limit) are
 * not the person asking for anything, and title nothing.
 *
 * Failure is silence, as in the window: the diagnostics log says which engine
 * was asked and what it said, and the chat keeps the name it has.
 */
import { readConversationMessageOrigin, type ConversationEvent } from '../../shared/conversation-runtime'
import {
  resolveTextGenerationEngine,
  type ChatTitleRequest,
  type TextGenerationResult,
  type TextGenerationEngineSettings,
} from '../../shared/text-generation/contract'
import { deriveWorkspaceTitle } from '../../shared/workspace-title'

/** A workspace as the titler reads it: the name, and whether it is still the app's to change. */
type TitledWorkspace = { name: string; titleLocked?: boolean }

export type ChatTitlerDeps = {
  /** Every chat's events, whichever machine runs it. */
  onEvent: (listener: (event: ConversationEvent) => void) => () => void
  /** The workspace as the registry holds it now; null for one it does not hold. */
  getWorkspace: (workspaceId: string) => TitledWorkspace | null
  /** Name the workspace and lock the name, through the workspace bus. Whether it landed. */
  rename: (workspaceId: string, name: string) => boolean
  /** The person's model-written titles setting, as main's mirror holds it. */
  settings: () => TextGenerationEngineSettings
  /** The agent CLIs this Studio knows, in the order its pickers list them. */
  candidateClis: () => readonly string[]
  /**
   * What availability detection last said of a CLI, without probing: only an
   * explicit false rules one out, as in the window, and the generator answers
   * for a CLI that turns out to be missing.
   */
  installed: (cli: string) => boolean | undefined
  cliRuntimes: () => ChatTitleRequest['cliRuntimes']
  generate: (request: ChatTitleRequest) => Promise<TextGenerationResult>
  /** Where a title that did not come is written down. */
  log?: (message: string) => void
}

export type ChatTitler = {
  /** Stop following the chats; a title still being written is dropped when it arrives. */
  dispose: () => void
}

/**
 * One more try after a failure that was about the transport — a killed
 * process, a non-zero exit, a deadline — and never after one that was about
 * the answer (guardrail) or the machine (no CLI), as the window's requester
 * does. One retry is enough for a title nobody is waiting on.
 */
const CHAT_TITLE_RETRY_DELAY_MS = 2_000

export function createChatTitler(
  deps: ChatTitlerDeps,
  options: { retryDelayMs?: number; wait?: (ms: number) => Promise<void> } = {},
): ChatTitler {
  const retryDelayMs = options.retryDelayMs ?? CHAT_TITLE_RETRY_DELAY_MS
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  // The workspaces a model title has been asked for in this run.
  const asked = new Set<string>()
  let disposed = false

  const generateWithRetry = async (request: ChatTitleRequest): Promise<TextGenerationResult> => {
    const first = await deps.generate(request)
    if (first.ok || (first.code !== 'transport' && first.code !== 'timeout')) return first
    await wait(retryDelayMs)
    if (disposed) return first
    return deps.generate(request)
  }

  // The heuristic half: name a still-open workspace after the prompt, and
  // lock it. Null when the prompt yields no usable title (an image-only
  // turn's words, filler), which leaves the name open for the next message.
  function autoTitle(workspaceId: string, prompt: string): string | null {
    const title = deriveWorkspaceTitle(prompt)
    if (!title) return null
    return deps.rename(workspaceId, title) ? title : null
  }

  // The late half, read against the registry as it is when the answer comes.
  function applyGenerated(workspaceId: string, rawTitle: string, replacing: string | null): void {
    const title = rawTitle.trim()
    if (disposed || !title) return
    const workspace = deps.getWorkspace(workspaceId)
    if (!workspace) return
    const stillOurs = replacing !== null ? workspace.name === replacing : !workspace.titleLocked
    if (!stillOurs || workspace.name === title) return
    deps.rename(workspaceId, title)
  }

  function onEvent(event: ConversationEvent): void {
    if (disposed || event.type !== 'user_message') return
    if (readConversationMessageOrigin(event.payload?.origin)) return
    const prompt = typeof event.payload?.text === 'string' ? event.payload.text : ''
    if (!prompt.trim()) return
    const workspaceId = event.workspaceId
    // A workspace this process does not hold is not its to name: a chat that
    // runs here for another machine's Studio is named there.
    const workspace = deps.getWorkspace(workspaceId)
    if (!workspace || workspace.titleLocked) return
    const interim = autoTitle(workspaceId, prompt)
    if (asked.has(workspaceId)) return
    const engine = resolveTextGenerationEngine(deps.settings(), deps.candidateClis(), deps.installed)
    if (!engine) return
    asked.add(workspaceId)
    void generateWithRetry({ prompt, engine, cliRuntimes: deps.cliRuntimes() })
      .then((result) => {
        if (result.ok) applyGenerated(workspaceId, result.value, interim)
        else if (!disposed) deps.log?.(`${describeEngine(engine)}${result.code} — ${result.message}`)
      })
      .catch(() => undefined)
  }

  const unsubscribe = deps.onEvent((event) => {
    // The runtime drops a listener that throws, and this one must outlive any
    // single chat's odd event.
    try {
      onEvent(event)
    } catch {
      // A title is never worth more than the chat it names.
    }
  })

  return {
    dispose: () => {
      disposed = true
      unsubscribe()
    },
  }
}

function describeEngine(engine: ChatTitleRequest['engine']): string {
  return `${[engine.cli, engine.model, engine.reasoning].filter(Boolean).join(' · ')}: `
}
