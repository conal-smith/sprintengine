import type { ChatExportAction, ChatExportRemoteSource } from '../../../../../shared/chat-export'
import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { clientSupports, hostPlatform } from '../../../clientCapabilities'
import { showToast } from '../../../store/toastStore'
import { revealLabel } from '../../../utils/revealLabel'
import { mountedChatViewFor } from './mountedChatViews'

// Export chat, the window's half: offered on a chat tab's menu and in the
// palette, carried out by main (`window.api.exportChat`), which reads the
// transcript, asks where to save and writes. This says how it went: the
// shared toast, with a way to the file when there is one.

/** The rows of the menu's flyout, in order: the two copies, then the files. */
export const CHAT_EXPORT_MENU: readonly { action: ChatExportAction; label: string }[] = [
  { action: 'copy', label: 'Copy chat' },
  { action: 'copy-markdown', label: 'Copy chat as Markdown' },
  { action: 'pdf', label: 'PDF…' },
  { action: 'docx', label: 'Word document…' },
  { action: 'markdown', label: 'Markdown…' },
]

/** Why the export rows are off for a chat with nothing in it. */
export const CHAT_EXPORT_EMPTY_REASON = 'No messages yet'

/**
 * Whether a shell can export at all: the save dialog is the OS's, and the
 * clipboard written is the machine's the app runs on, so a browser tab has
 * neither.
 */
export function chatExportSupported(): boolean {
  return clientSupports('native-dialogs')
}

/**
 * Whether the chat has a message to export, as far as the window can tell
 * without reading the transcript: its view when one is drawn, else the
 * session main lists for it. Null when neither knows — a chat not opened since
 * the app started — and the export is offered; main says so if it is empty.
 */
export function chatHasMessages(
  workspaceId: string,
  agentId: string,
  sessions: readonly ConversationSessionSummary[],
): boolean | null {
  const view = mountedChatViewFor(workspaceId, agentId)?.hasMessages?.()
  if (view !== undefined) return view
  const session = sessions.find((candidate) => candidate.workspaceId === workspaceId && candidate.agentId === agentId)
  if (!session) return null
  return Boolean(
    session.firstUserText ||
    session.lastUserText ||
    session.lastTurnEndedAt !== undefined ||
    session.turnStartedAt !== undefined,
  )
}

/**
 * Export one chat, and say how it went. Never throws: a menu has nowhere of its
 * own to show an error. A chat followed from a paired machine names `remote`,
 * which reads its whole transcript from that machine first: main has none of
 * it to read.
 */
export async function exportChatOrToast(input: {
  workspaceId: string
  agentId: string
  action: ChatExportAction
  remote?: () => Promise<ChatExportRemoteSource>
}): Promise<void> {
  const { remote, ...chat } = input
  const copying = input.action === 'copy' || input.action === 'copy-markdown'
  const failed = (error: unknown) => ({
    ok: false as const,
    message: error instanceof Error ? error.message : 'The chat could not be exported.',
  })
  const result = await (remote ? remote().then((source) => ({ ...chat, remote: source })) : Promise.resolve(chat))
    .then((asked) => window.api.exportChat(asked))
    .catch(failed)
  if (!result.ok) {
    showToast({
      tone: 'error',
      title: copying ? 'Could not copy the chat' : 'Could not export the chat',
      description: result.message,
    })
    return
  }
  if (result.kind === 'cancelled') return
  if (result.kind === 'copied') {
    showToast({ tone: 'good', title: 'Chat copied' })
    return
  }
  const { path } = result
  showToast({
    tone: 'good',
    title: 'Chat exported',
    description: result.fileName,
    ...(clientSupports('reveal-in-folder')
      ? {
          actions: [
            {
              id: 'reveal',
              label: revealLabel(hostPlatform()),
              run: () => void window.api.showItemInFolder(path),
            },
          ],
        }
      : {}),
  })
}
