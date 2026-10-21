import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { asRecord } from '../../shared/records'
import type { ConversationToolOutputPayload, ConversationToolStartedPayload } from '../../shared/conversation-runtime'
import { resolveClaudeConfigDir } from '../claude-config-dir'
import { mapSdkMessage } from '../providers/claude-agent-provider'
import { ImportedTranscriptBuilder, recordTime, type ImportedConversation } from './imported-transcript'
import { newestRecordTime, readJsonLines, readJsonLinesWindow, stringField, type ScannedSession } from './session-files'

// Claude Code saves each session as `<config>/projects/<folder>/<id>.jsonl`,
// one record per line: the person's messages and the tool results the CLI
// answered with are `user` records, the model's text, thinking and tool calls
// `assistant` records (one per content block), and the rest is bookkeeping
// (titles, attachments, compaction marks). A spawned agent's own history sits
// in a folder beside the session's file, so reading the top level only reads
// conversations a person had.

/** Where Claude Code keeps its sessions on this machine. */
export function claudeCodeProjectsDir(homeDir: string, env: NodeJS.ProcessEnv): string {
  return join(resolveClaudeConfigDir(homeDir, env), 'projects')
}

// A session's opening carries its folder, its first message and (mostly) its
// title; a long first message or a pasted picture can push those past a short
// read, so a second, longer one is tried before the session is passed over.
const HEAD_BYTES = [64 * 1024, 1024 * 1024]
const TAIL_BYTES = 64 * 1024

/** Every session Claude Code saved that a person typed into, newest first. */
export async function scanClaudeCodeSessions(projectsDir: string): Promise<ScannedSession[]> {
  let folders: string[]
  try {
    folders = await readdir(projectsDir)
  } catch (error) {
    // Gone is empty; there but unreadable (permissions, a privacy prompt
    // declined) is said, not passed off as "no sessions".
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const sessions: ScannedSession[] = []
  for (const folder of folders) {
    let names: string[]
    try {
      names = (await readdir(join(projectsDir, folder))).filter((name) => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const name of names) {
      const scanned = await scanSessionFile(join(projectsDir, folder, name)).catch(() => null)
      if (scanned) sessions.push(scanned)
    }
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function scanSessionFile(path: string): Promise<ScannedSession | null> {
  const info = await stat(path)
  if (!info.isFile() || info.size === 0) return null
  let head: ReturnType<typeof readHead> | null = null
  let headRecords: Array<Record<string, unknown>> = []
  for (const bytes of HEAD_BYTES) {
    headRecords = await readJsonLinesWindow(path, 0, bytes)
    head = readHead(headRecords)
    if (head.excluded) return null
    if ((head.folderPath && head.firstPrompt) || info.size <= bytes) break
  }
  if (!head?.folderPath || !head.firstPrompt) return null
  const tail = info.size > TAIL_BYTES ? await readJsonLinesWindow(path, info.size - TAIL_BYTES, TAIL_BYTES) : []
  // The CLI writes its title records again on every save, so the file's end
  // carries the latest of each; what the head said holds when it does not.
  const titles = { ...head.titles }
  for (const record of tail) noteSessionTitle(titles, record)
  const title = sessionTitle(titles)
  return {
    source: 'claude-code',
    sessionId: head.sessionId ?? basename(path, '.jsonl'),
    path,
    folderPath: head.folderPath,
    title: title ?? null,
    firstPrompt: head.firstPrompt,
    startedAt: head.startedAt ?? info.mtimeMs,
    // The file's end, or all of it when it is short enough to have been read whole.
    updatedAt: newestRecordTime(tail.length > 0 ? tail : headRecords) ?? info.mtimeMs,
  }
}

function readHead(records: Array<Record<string, unknown>>) {
  const head: {
    excluded: boolean
    sessionId: string | null
    folderPath: string | null
    firstPrompt: string | null
    titles: SessionTitles
    startedAt: number | null
  } = {
    excluded: false,
    sessionId: null,
    folderPath: null,
    firstPrompt: null,
    titles: { named: undefined, generated: null },
    startedAt: null,
  }
  for (const record of records) {
    // A session the Agent SDK or `claude -p` ran was a program's, not a
    // person's: this app's own chats, a script, a CI job. Each names how it
    // started on every record.
    const entrypoint = stringField(record.entrypoint)
    if (entrypoint?.startsWith('sdk')) return { ...head, excluded: true }
    head.sessionId ??= stringField(record.sessionId)
    head.folderPath ??= stringField(record.cwd)
    head.startedAt ??= recordTime(record.timestamp)
    noteSessionTitle(head.titles, record)
    if (!head.firstPrompt && isMainChainPrompt(record))
      head.firstPrompt = claudePromptText(asRecord(record.message)?.content)
  }
  return head
}

/**
 * The titles a session's records have given it so far. `named` is the one a
 * person gave with `/rename`: undefined until a record says, null once a
 * rename was cleared (the CLI writes an empty one for that).
 */
type SessionTitles = { named: string | null | undefined; generated: string | null }

function noteSessionTitle(titles: SessionTitles, record: Record<string, unknown>): void {
  if (record.type === 'custom-title' && typeof record.customTitle === 'string')
    titles.named = stringField(record.customTitle)
  else if (record.type === 'ai-title') titles.generated = stringField(record.aiTitle) ?? titles.generated
  // Older versions wrote a one-line summary in place of a title.
  else if (record.type === 'summary') titles.generated = stringField(record.summary) ?? titles.generated
}

// A person's name for the session wins over the CLI's: the CLI writes its own
// title after the person's on every save, so the later record is not the newer
// choice.
function sessionTitle(titles: SessionTitles): string | null {
  return titles.named ?? titles.generated
}

function isMainChainPrompt(record: Record<string, unknown>): boolean {
  return (
    record.type === 'user' &&
    record.isSidechain !== true &&
    record.isMeta !== true &&
    record.isCompactSummary !== true &&
    isPersonsMessage(record)
  )
}

/**
 * Whether a person sent the message, typed or queued. The CLI hands the model
 * some messages of its own (a background task reporting back) in the same
 * record, marked by where they came from; a version that marks neither only
 * wrote what a person sent.
 */
function isPersonsMessage(record: Record<string, unknown>): boolean {
  const origin = stringField(asRecord(record.origin)?.kind)
  return (origin === null || origin === 'human') && record.promptSource !== 'system'
}

/**
 * What the person typed, out of a `user` record's content: its text, with the
 * wrapping the CLI puts around a slash command undone (`/review 12` rather
 * than its tags). Null for a record that only carries tool results, or what
 * the CLI said back to a local command, or its note that a turn was stopped.
 */
export function claudePromptText(content: unknown): string | null {
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((entry) => {
              const block = asRecord(entry)
              return block?.type === 'text' && typeof block.text === 'string' ? block.text : ''
            })
            .filter(Boolean)
            .join('\n\n')
        : ''
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (!text) return null
  if (/^<(local-command-(stdout|stderr|caveat)|bash-(stdout|stderr))>/.test(text)) return null
  if (text.startsWith('[Request interrupted by user')) return null
  const command = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)
  if (command?.[1]) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
    const name = command[1].startsWith('/') ? command[1] : `/${command[1]}`
    return args ? `${name} ${args}` : name
  }
  const shell = /^<bash-input>([\s\S]*?)<\/bash-input>$/.exec(text)
  if (shell) return `!${shell[1]!.trim()}`
  return text
}

/** A session's whole history, in the chat's vocabulary. */
export async function readClaudeCodeSession(path: string, fallbackAt: number): Promise<ImportedConversation> {
  const builder = new ImportedTranscriptBuilder(fallbackAt)
  // The adapter's own reading of a tool call and its result, so an imported
  // step's row is drawn as a live one is. Its state is only what that needs.
  const state = {
    sessionId: 'import',
    workspaceId: '',
    agentId: '',
    providerId: 'claude-agent',
    modelId: '',
    providerSessionId: null as string | null,
    turn: { turnId: '' },
  }
  const titles: SessionTitles = { named: undefined, generated: null }
  for await (const record of readJsonLines(path)) {
    noteSessionTitle(titles, record)
    if (record.isSidechain === true) continue
    const at = recordTime(record.timestamp)
    if (record.type === 'system' && record.subtype === 'compact_boundary') {
      const metadata = asRecord(record.compactMetadata)
      builder.compacted(at, {
        ...(metadata?.trigger === 'manual' || metadata?.trigger === 'auto' ? { trigger: metadata.trigger } : {}),
        ...(typeof metadata?.preTokens === 'number' ? { preTokens: metadata.preTokens } : {}),
      })
      continue
    }
    if (record.type !== 'user' && record.type !== 'assistant') continue
    const content = asRecord(record.message)?.content
    if (record.type === 'user') {
      if (record.isMeta === true || record.isCompactSummary === true) continue
      const blocks = Array.isArray(content) ? content : []
      const results = blocks.filter((block) => asRecord(block)?.type === 'tool_result')
      if (results.length > 0) {
        // No pictures are kept from an import: a history can hold hundreds of
        // screenshots, and writing them all is not what bringing a chat in
        // should cost. Its steps show their words, as they always did.
        const mapped = mapSdkMessage(
          state,
          {
            type: 'user',
            message: { role: 'user', content: results },
            tool_use_result: record.toolUseResult,
          },
          { saveToolImages: false },
        )
        // A task tool's result announces its row again, with the task list
        // it left, ahead of the result itself.
        for (const event of mapped)
          if (event.type === 'tool_started')
            builder.toolStarted(withoutTurn(event.payload) as Omit<ConversationToolStartedPayload, 'turnId'>, at)
          else if (event.type === 'tool_output')
            builder.toolOutput(withoutTurn(event.payload) as Omit<ConversationToolOutputPayload, 'turnId'>, at)
        continue
      }
      const prompt = isPersonsMessage(record) ? claudePromptText(content) : null
      if (prompt) builder.userMessage(prompt, at)
      continue
    }
    for (const entry of Array.isArray(content) ? content : []) {
      const block = asRecord(entry)
      if (block?.type === 'text' && typeof block.text === 'string') builder.assistantText(block.text, at)
      else if (block?.type === 'thinking' && typeof block.thinking === 'string') builder.reasoning(block.thinking, at)
      else if (block?.type === 'tool_use') {
        const mapped = mapSdkMessage(state, { type: 'assistant', message: { role: 'assistant', content: [block] } })
        for (const event of mapped)
          if (event.type === 'tool_started')
            builder.toolStarted(withoutTurn(event.payload) as Omit<ConversationToolStartedPayload, 'turnId'>, at)
      }
    }
  }
  return builder.finish(sessionTitle(titles))
}

function withoutTurn(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  const { turnId: _turnId, ...rest } = payload ?? {}
  return rest
}
