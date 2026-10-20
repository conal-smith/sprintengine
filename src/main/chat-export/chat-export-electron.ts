import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  type SaveDialogOptions,
  type WebContents,
} from 'electron'

import { conversationWorkingRoot, type AgentState } from '../../shared/agent-state'
import type { ChatExportFileFormat, ChatExportInput, ChatExportResult } from '../../shared/chat-export'
import { cliForConversationProvider } from '../../shared/conversation-harness'
import { usageAgentLabel } from '../../shared/usage-report'
import { runChatExport, type ChatExportChat, type ChatExportDeps } from './chat-export-service'
import { renderChatExportPdf } from './chat-export-pdf'
import { CHAT_EXPORT_EXTENSIONS } from './chat-export-filename'

// Export chat's Electron half: the save dialog, the clipboard, the disk and
// the print window, bound for `runChatExport`.

/**
 * Where an end-to-end run's exports are written without a dialog it cannot
 * click: a folder, under the suggested name. A development build only, as the
 * Open Folder picker's own override is (menu-dialog-ipc.ts).
 */
export const TEST_SAVE_DIR_ENV = 'SPRINTENGINE_TEST_SAVE_DIR'

const FILTERS: Readonly<Record<ChatExportFileFormat, SaveDialogOptions['filters']>> = {
  pdf: [{ name: 'PDF', extensions: [CHAT_EXPORT_EXTENSIONS.pdf] }],
  docx: [{ name: 'Word document', extensions: [CHAT_EXPORT_EXTENSIONS.docx] }],
  markdown: [{ name: 'Markdown', extensions: [CHAT_EXPORT_EXTENSIONS.markdown] }],
}

type ExportWorkspace = { id: string; name?: string; folderPath?: string | null; agents?: Record<string, AgentState> }

/** The chat as its workspace records it: a conversation with a folder to read its transcript under. */
export function chatExportChatOf(
  workspaces: readonly ExportWorkspace[],
  workspaceId: string,
  agentId: string,
): ChatExportChat | null {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  const agent = workspace?.agents?.[agentId]
  if (!workspace || !agent || agent.runtimeKind !== 'conversation') return null
  const workspaceRoot = conversationWorkingRoot(agent, workspace.folderPath)
  if (!workspaceRoot) return null
  return {
    title: agent.name,
    project: workspace.name?.trim() || null,
    providerId: agent.conversation?.providerId ?? null,
    modelId: agent.conversation?.modelId ?? null,
    workspaceRoot,
  }
}

export function createElectronChatExportDeps(options: {
  sender: WebContents
  workspaces: () => readonly ExportWorkspace[]
  readSource: ChatExportDeps['readSource']
  /** A CLI's own name, as its manifest gives it. */
  cliDisplayName: (cli: string) => string | null
}): ChatExportDeps {
  return {
    chat: (workspaceId, agentId) => chatExportChatOf(options.workspaces(), workspaceId, agentId),
    readSource: options.readSource,
    engineName: (providerId) => {
      const cli = cliForConversationProvider(providerId)
      return cli ? (options.cliDisplayName(cli) ?? usageAgentLabel(cli)) : null
    },
    pickSavePath: async ({ defaultPath, format }) => {
      const testFolder = await testSaveFolder()
      if (testFolder) return join(testFolder, defaultPath.split(/[\\/]/u).at(-1)!)
      const win = BrowserWindow.fromWebContents(options.sender)
      const dialogOptions: SaveDialogOptions = {
        title: 'Export chat',
        buttonLabel: 'Export',
        defaultPath,
        filters: FILTERS[format],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      }
      const result = win ? await dialog.showSaveDialog(win, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
      return result.canceled || !result.filePath ? null : result.filePath
    },
    defaultDirectory: () => {
      for (const name of ['downloads', 'documents', 'home'] as const) {
        try {
          return app.getPath(name)
        } catch {
          // A folder this system does not have; the next one.
        }
      }
      return ''
    },
    renderPdf: renderChatExportPdf,
    writeFile: (path, data) => writeFile(path, data),
    makeDirectory: async (path) => {
      await mkdir(path, { recursive: true })
    },
    // Both flavours in one item, written at once: the app the paste lands in
    // takes the HTML when it reads it, and the text when it does not.
    writeClipboard: (data) =>
      clipboard.write([
        new ClipboardItem({ 'text/plain': data.text, ...(data.html !== undefined ? { 'text/html': data.html } : {}) }),
      ]),
    now: () => Date.now(),
    locale: () => app.getLocale() || 'en',
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    region: () => app.getLocaleCountryCode() || null,
  }
}

/** One export, for the window that asked. */
export function exportChat(
  input: ChatExportInput,
  options: Parameters<typeof createElectronChatExportDeps>[0],
): Promise<ChatExportResult> {
  return runChatExport(input, createElectronChatExportDeps(options))
}

async function testSaveFolder(): Promise<string | null> {
  const folder = process.env[TEST_SAVE_DIR_ENV]
  if (!folder || app.isPackaged) return null
  const target = await stat(folder).catch(() => null)
  if (!target?.isDirectory()) throw new Error(`${TEST_SAVE_DIR_ENV} must point to an existing directory: ${folder}`)
  return folder
}
