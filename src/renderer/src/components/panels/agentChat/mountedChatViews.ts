import { useWorkspaceStore } from '../../../store/workspaceStore'
import { PANEL_COMMAND_EVENT } from '../../../utils/panelCommands'
import { QUOTE_SELECTION_COMMAND } from './quoteSelection'
import type { ChatExportAction } from '../../../../../shared/chat-export'

// Which mounted chat view answers a whole-window model-picker shortcut (see
// the effect inside AgentChatView). Mount order; the focused view wins.
export type MountedChatView = {
  workspaceId: string
  agentId?: string
  isFocused: () => boolean
  toggleModelPicker: () => void
  cycleEffort?: () => void
  resumeInTerminal?: () => void
  stepTurn?: (direction: -1 | 1) => void
  /** Play the conversation back from its first message (`chat.replay.start`). */
  startReplay?: () => void
  /** Quote the document's selection when it is in this view's transcript; whether it was. */
  quoteSelection?: () => boolean
  /** End the agent's process, keeping the conversation (`chat.restartSession`). */
  restartSession?: () => void
  /** Show the find bar and put the caret in it (`chat.find`). */
  openFind?: () => void
  /** Set a quote into the composer where its caret is, and put the keyboard there. */
  insertQuote?: (text: string) => void
  /** Open the side question drawer (`chat.sideQuestion`); absent where the chat cannot answer one. */
  openSideQuestion?: () => void
  /** Whether the conversation has a message in it yet: what Export chat offers itself on. */
  hasMessages?: () => boolean
  /** Export the conversation (`chat.export.*`); absent where the chat cannot be exported. */
  exportChat?: (action: ChatExportAction) => void
}
const mountedChatViews: MountedChatView[] = []
export const MODEL_PICKER_TOGGLE_COMMAND = 'chat.modelPicker.toggle'
const CHAT_FIND_COMMAND = 'chat.find'
const RESUME_IN_TERMINAL_COMMAND = 'chat.resumeInTerminal'
const REPLAY_COMMAND = 'chat.replay.start'
const RESTART_SESSION_COMMAND = 'chat.restartSession'
export const SIDE_QUESTION_COMMAND = 'chat.sideQuestion'
/** The palette's Export chat commands, by the export each asks for. */
export const CHAT_EXPORT_COMMANDS: Readonly<Record<string, ChatExportAction>> = {
  'chat.export.copy': 'copy',
  'chat.export.copyMarkdown': 'copy-markdown',
  'chat.export.pdf': 'pdf',
  'chat.export.docx': 'docx',
  'chat.export.markdown': 'markdown',
}

/**
 * Answer `chat.modelPicker.toggle` (⌘⇧M, or the palette row) with ONE chat
 * view: the one holding focus, failing that the most recently mounted view
 * in the active workspace — never every mounted view (background workspace
 * layers stay mounted). One module-level listener, installed while any view
 * is mounted, picks the responder and toggles it; the views never compare
 * closures, which is how the first cut of this silently answered nothing.
 * Returns the view that answered, or null.
 */
export function respondToModelPickerToggle(): MountedChatView | null {
  const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
  const responder =
    mountedChatViews.find((view) => view.isFocused()) ??
    [...mountedChatViews].reverse().find((view) => view.workspaceId === activeWorkspaceId) ??
    null
  responder?.toggleModelPicker()
  return responder
}

function onModelPickerPanelCommand(event: Event): void {
  const detail = (event as CustomEvent<{ id?: string }>).detail
  if (detail?.id === MODEL_PICKER_TOGGLE_COMMAND) respondToModelPickerToggle()
  if (detail?.id === 'chat.effort.cycle') {
    const responder =
      mountedChatViews.find((view) => view.isFocused()) ??
      [...mountedChatViews]
        .reverse()
        .find((view) => view.workspaceId === useWorkspaceStore.getState().activeWorkspaceId)
    responder?.cycleEffort?.()
  }
  if (detail?.id === RESUME_IN_TERMINAL_COMMAND) {
    const responder =
      mountedChatViews.find((view) => view.isFocused()) ??
      [...mountedChatViews]
        .reverse()
        .find((view) => view.workspaceId === useWorkspaceStore.getState().activeWorkspaceId)
    responder?.resumeInTerminal?.()
  }
  if (detail?.id === 'chat.turn.previous' || detail?.id === 'chat.turn.next') {
    const responder =
      mountedChatViews.find((view) => view.isFocused()) ??
      [...mountedChatViews]
        .reverse()
        .find((view) => view.workspaceId === useWorkspaceStore.getState().activeWorkspaceId)
    responder?.stepTurn?.(detail.id === 'chat.turn.previous' ? -1 : 1)
  }
  if (detail?.id === REPLAY_COMMAND) {
    const responder =
      mountedChatViews.find((view) => view.isFocused()) ??
      [...mountedChatViews]
        .reverse()
        .find((view) => view.workspaceId === useWorkspaceStore.getState().activeWorkspaceId)
    responder?.startReplay?.()
  }
  const exportAction = detail?.id ? CHAT_EXPORT_COMMANDS[detail.id] : undefined
  if (exportAction) {
    const responder =
      mountedChatViews.find((view) => view.isFocused()) ??
      [...mountedChatViews]
        .reverse()
        .find((view) => view.workspaceId === useWorkspaceStore.getState().activeWorkspaceId)
    responder?.exportChat?.(exportAction)
  }
  if (detail?.id === RESTART_SESSION_COMMAND) {
    const responder =
      mountedChatViews.find((view) => view.isFocused()) ??
      [...mountedChatViews]
        .reverse()
        .find((view) => view.workspaceId === useWorkspaceStore.getState().activeWorkspaceId)
    responder?.restartSession?.()
  }
  if (detail?.id === SIDE_QUESTION_COMMAND) {
    const responder =
      mountedChatViews.find((view) => view.isFocused()) ??
      [...mountedChatViews]
        .reverse()
        .find((view) => view.workspaceId === useWorkspaceStore.getState().activeWorkspaceId)
    responder?.openSideQuestion?.()
  }
  // From the keyboard the shell only takes ⌘F inside a chat
  // (`shellTakesChordFrom`), so the focused view answers; from the palette,
  // which holds focus itself, the active workspace's chat does.
  if (detail?.id === CHAT_FIND_COMMAND) {
    const responder =
      mountedChatViews.find((view) => view.isFocused()) ??
      [...mountedChatViews]
        .reverse()
        .find((view) => view.workspaceId === useWorkspaceStore.getState().activeWorkspaceId)
    responder?.openFind?.()
  }
  // The view whose transcript holds the selection answers, whichever has focus.
  if (detail?.id === QUOTE_SELECTION_COMMAND) mountedChatViews.some((view) => view.quoteSelection?.() === true)
}

/** Register a mounted chat view as a possible responder; returns the unregister. */
export function registerMountedChatView(entry: MountedChatView): () => void {
  if (mountedChatViews.length === 0) window.addEventListener(PANEL_COMMAND_EVENT, onModelPickerPanelCommand)
  mountedChatViews.push(entry)
  return () => {
    const index = mountedChatViews.indexOf(entry)
    if (index >= 0) mountedChatViews.splice(index, 1)
    if (mountedChatViews.length === 0) window.removeEventListener(PANEL_COMMAND_EVENT, onModelPickerPanelCommand)
  }
}

/** The mounted view of one chat, if this window draws it. */
export function mountedChatViewFor(workspaceId: string, agentId: string): MountedChatView | null {
  return mountedChatViews.find((view) => view.workspaceId === workspaceId && view.agentId === agentId) ?? null
}
