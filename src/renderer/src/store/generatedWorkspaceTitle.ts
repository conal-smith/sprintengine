/**
 * Titling a chat from its first prompt, both halves in one place: the local
 * heuristic lands at once, and — when the person has it on and a supported
 * agent CLI is installed — a model-written title replaces it when it arrives.
 *
 * The order matters. The heuristic is the fallback for every failure mode
 * (off, no CLI, timeout, guardrail, a bad answer), so it goes first and the
 * model's answer is an upgrade on top, never a wait. Both land through the
 * store, which owns the one rule that keeps a late answer honest: it replaces
 * exactly the name it was asked to replace, so a hand rename in the meantime
 * stands (`applyGeneratedWorkspaceTitle`).
 *
 * Failure is silence. No toast, no log line at warning level: an absent title
 * is the heuristic title, which is what the app showed before this existed.
 *
 * This titles a terminal agent's workspace, from the prompt its hook reports
 * to a window. A chat is titled by the process that runs it, from the chat's
 * own events, by the same rules (`main/text-generation/chat-titler.ts`): a chat
 * a phone starts may have no window here to title it.
 */

import type { ChatTitleRequest, TextGenerationResult } from '../../../shared/text-generation/contract'
import { resolveTextGenerationEngine } from '../../../shared/text-generation/contract'
import type { AgentCli, WorkspaceId } from '../types/workspace'
import { useWorkspaceStore } from './workspaceStore'

export type GeneratedTitleRequesterDeps = {
  /** The heuristic half. Returns the title it applied, or null. */
  autoTitle: (id: WorkspaceId, prompt: string) => string | null
  /** The late half. Returns whether the title landed. */
  applyGenerated: (id: WorkspaceId, title: string, replacing: string | null) => boolean
  /** Whether the workspace's name is still the app's to change. */
  isTitleOpen: (id: WorkspaceId) => boolean
  /** The engine to use right now, or null when no call should be made. */
  resolveEngine: () => ChatTitleRequest['engine'] | null
  cliRuntimes: () => ChatTitleRequest['cliRuntimes']
  generate: (request: ChatTitleRequest) => Promise<TextGenerationResult>
}

export type GeneratedTitleRequester = {
  /**
   * Title `id` from `prompt`. Returns the heuristic outcome synchronously; the
   * generated title, if any, lands later through `applyGenerated`. Never
   * rejects.
   */
  titleFromPrompt: (id: WorkspaceId, prompt: string) => string | null
}

/**
 * One more try after a failure that was about the transport — a killed
 * process, a non-zero exit, a deadline — and never after one that was about
 * the answer (guardrail) or the machine (no CLI). One retry is enough for a
 * title nobody is waiting on.
 */
const GENERATED_TITLE_RETRY_DELAY_MS = 2_000

export function createGeneratedTitleRequester(
  deps: GeneratedTitleRequesterDeps,
  options: { retryDelayMs?: number; wait?: (ms: number) => Promise<void> } = {},
): GeneratedTitleRequester {
  const retryDelayMs = options.retryDelayMs ?? GENERATED_TITLE_RETRY_DELAY_MS
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const generateWithRetry = async (request: ChatTitleRequest): Promise<TextGenerationResult> => {
    const first = await deps.generate(request)
    if (first.ok || (first.code !== 'transport' && first.code !== 'timeout')) return first
    await wait(retryDelayMs)
    return deps.generate(request)
  }

  return {
    titleFromPrompt: (id, prompt) => {
      const interim = deps.autoTitle(id, prompt)
      // The heuristic applied nothing AND the name is not ours to change: a
      // locked workspace, or one that no longer exists. No call is made — a
      // second agent's first prompt in an already-titled chat must not spend
      // a title on a name that could never land.
      if (interim === null && !deps.isTitleOpen(id)) return null
      const engine = deps.resolveEngine()
      if (!engine) return interim
      void generateWithRetry({ prompt, engine, cliRuntimes: deps.cliRuntimes() })
        .then((result) => {
          if (result.ok) deps.applyGenerated(id, result.value, interim)
        })
        .catch(() => undefined)
      return interim
    },
  }
}

/**
 * The engine for a call made now, read straight off the store: the setting,
 * the installed-plugin catalog in its own order, and the availability probe's
 * verdict per CLI. Only an explicit `installed: false` excludes a CLI, the
 * same trust rule the deployment pickers apply.
 */
export function resolveStoreTextGenerationEngine(): ChatTitleRequest['engine'] | null {
  const state = useWorkspaceStore.getState()
  const candidates = (state.pluginCatalogEntries ?? []).map((entry) => entry.id)
  const availability = state.cliAvailability
  return resolveTextGenerationEngine(state.appSettings.textGeneration, candidates, (cli: AgentCli) => {
    const entry = availability?.[cli]
    return entry ? entry.installed : undefined
  })
}

let defaultRequester: GeneratedTitleRequester | null = null

/** The app's requester, bound to the store and the preload bridge. */
export function generatedWorkspaceTitleRequester(): GeneratedTitleRequester {
  if (!defaultRequester) {
    defaultRequester = createGeneratedTitleRequester({
      autoTitle: (id, prompt) => useWorkspaceStore.getState().autoTitleWorkspaceFromPrompt(id, prompt),
      applyGenerated: (id, title, replacing) =>
        useWorkspaceStore.getState().applyGeneratedWorkspaceTitle(id, title, replacing),
      isTitleOpen: (id) => {
        const ws = useWorkspaceStore.getState().workspaces.find((candidate) => candidate.id === id)
        return Boolean(ws) && !ws?.titleLocked
      },
      resolveEngine: resolveStoreTextGenerationEngine,
      cliRuntimes: () => useWorkspaceStore.getState().appSettings.cliRuntimes,
      generate: (request) => {
        const api = typeof window !== 'undefined' ? window.api : undefined
        if (!api?.generateChatTitle) {
          return Promise.resolve({ ok: false, code: 'unavailable', message: 'Text generation bridge is unavailable.' })
        }
        return api.generateChatTitle(request)
      },
    })
  }
  return defaultRequester
}

export type RegenerateTitleDeps = {
  /** The first message with words the person sent in the chat, or null when none is kept. */
  firstPrompt: (id: WorkspaceId) => Promise<string | null>
  resolveEngine: () => ChatTitleRequest['engine'] | null
  cliRuntimes: () => ChatTitleRequest['cliRuntimes']
  generate: (request: ChatTitleRequest) => Promise<TextGenerationResult>
  /** Name the chat and lock the name, as a hand rename does. */
  rename: (id: WorkspaceId, name: string) => void
}

export type RegenerateTitleResult = { ok: true; title: string } | { ok: false; message: string }

/**
 * "Regenerate title": the person asked, so the lock a landed title or a hand
 * rename put on the name does not hold this one back, and neither does the
 * one call per chat the automatic title makes. The model titles the chat from
 * its first message again, and the new name locks, as any title that lands
 * does.
 */
export async function regenerateWorkspaceTitle(
  id: WorkspaceId,
  deps: RegenerateTitleDeps,
): Promise<RegenerateTitleResult> {
  const engine = deps.resolveEngine()
  if (!engine)
    return {
      ok: false,
      message: 'Model-written titles are off in Settings, or no agent CLI that writes them is installed.',
    }
  const prompt = (await deps.firstPrompt(id).catch(() => null))?.trim()
  if (!prompt) return { ok: false, message: 'This chat has no message of yours to title it from.' }
  const result = await deps
    .generate({ prompt, engine, cliRuntimes: deps.cliRuntimes() })
    .catch((error: unknown): TextGenerationResult => ({
      ok: false,
      code: 'transport',
      message: error instanceof Error ? error.message : String(error),
    }))
  if (!result.ok) return { ok: false, message: result.message }
  const title = result.value.trim()
  if (!title) return { ok: false, message: 'The model answered with no title.' }
  deps.rename(id, title)
  return { ok: true, title }
}

/** Regenerate a chat's title through the store and the preload bridge. */
export function regenerateStoreWorkspaceTitle(id: WorkspaceId): Promise<RegenerateTitleResult> {
  return regenerateWorkspaceTitle(id, {
    firstPrompt: async (workspaceId) => {
      const api = typeof window !== 'undefined' ? window.api : undefined
      if (!api?.conversationSessionsList || !api.readConversationPeek) return null
      const listed = await api.conversationSessionsList({ workspaceId })
      if (!listed.ok) return null
      // Oldest first: the chat's first message is in its first session's transcript.
      const sessions = [...listed.sessions].sort((a, b) => a.createdAt - b.createdAt)
      for (const session of sessions) {
        const peek = await api.readConversationPeek(session.sessionId)
        if (peek.first?.text.trim()) return peek.first.text
      }
      return null
    },
    resolveEngine: resolveStoreTextGenerationEngine,
    cliRuntimes: () => useWorkspaceStore.getState().appSettings.cliRuntimes,
    generate: (request) => {
      const api = typeof window !== 'undefined' ? window.api : undefined
      if (!api?.generateChatTitle)
        return Promise.resolve({ ok: false, code: 'unavailable', message: 'Text generation bridge is unavailable.' })
      return api.generateChatTitle(request)
    },
    rename: (workspaceId, name) => useWorkspaceStore.getState().renameWorkspace(workspaceId, name),
  })
}
