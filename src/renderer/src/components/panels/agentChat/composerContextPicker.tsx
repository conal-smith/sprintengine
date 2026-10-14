import React, { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { WorkspaceSkill } from '../../../../../shared/electron-api'
import type { FileSearchEntry } from '../../../../../shared/ipc/filesystem'
import {
  detectComposerTrigger,
  tokenOpensMessage,
  type ComposerTrigger,
} from '../../../../../shared/conversation/composerTrigger'
import type { ConversationMentionRef } from '../../../../../shared/conversation/mentions'
import { rankMentionCandidates } from '../../../../../shared/conversation/searchRanking'
import type { ConversationCommand } from '../../../../../shared/conversation/commands'
import {
  ChipButton,
  InlineSkillPicker,
  LinkButton,
  MenuOption,
  Popover,
  StarGlyph,
  type InlineSkillPickerHandle,
} from '../../ui'
import { AttachmentChip } from '../../ui/AttachmentChip'
import { recentFileVisit, workspaceFileVisits } from '../../../utils/recentFileVisits'
import {
  commandWorksMidMessage,
  rankConversationCommands,
  SlashCommandMenu,
  type SlashCommandMenuStatus,
} from './slashCommandMenu'
import { useConversationTransport } from './conversationTransport'
import { type ComposerKeyEvent } from './ComposerField'
import { isImeKey } from '../../../utils/imeKey'

type TriggerRange = ComposerTrigger['range']

// What the field carries while it drives the command menu, as attributes on
// the composer's editable element.
type ComboboxAttributes = {
  role?: 'combobox'
  'aria-autocomplete'?: 'list'
  'aria-expanded'?: boolean
  'aria-controls'?: string
  'aria-activedescendant'?: string
}

/** Only workspace-relative references leave the picker, including parent folders. */
export function fileMentionCandidates(root: string, files: FileSearchEntry[], query: string): ConversationMentionRef[] {
  const prefix = root.replaceAll('\\', '/').replace(/\/$/u, '') + '/'
  const candidates = new Map<string, ConversationMentionRef>()
  for (const file of files) {
    const normalized = file.path.replaceAll('\\', '/')
    const path = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
    if (!path || path.startsWith('/') || /^[A-Za-z]:\//u.test(path) || path.split('/').includes('..')) continue
    candidates.set(path, { path, kind: file.isDir ? 'folder' : 'file' })
    const parts = path.split('/')
    parts.pop()
    while (parts.length) {
      const parent = parts.join('/')
      candidates.set(parent, { path: parent, kind: 'folder' })
      parts.pop()
    }
  }
  return rankMentionCandidates(
    [...candidates.values()].map((candidate) => ({
      ...candidate,
      recentAt: recentFileVisit(prefix + candidate.path),
    })),
    query,
    50,
  ).map(({ path, kind }) => ({ path, kind }))
}

export function useFileMentionSearch(workspaceRoot: string | null, query: string | null) {
  const channel = `mention:${useId()}`
  const files = useConversationTransport().services.files
  const [state, setState] = useState<{ rows: ConversationMentionRef[]; loading: boolean; error: string | null }>({
    rows: [],
    loading: false,
    error: null,
  })
  useEffect(() => {
    let cancelled = false
    let started = false
    setState({ rows: [], loading: Boolean(workspaceRoot && query?.trim()), error: null })
    if (!workspaceRoot || query === null || !query.trim()) return
    const timer = window.setTimeout(() => {
      started = true
      void files
        .search(workspaceRoot, query, {
          limit: 50,
          purpose: 'mention',
          channel,
          recentAt: workspaceFileVisits(workspaceRoot),
        })
        .then((result) => {
          if (cancelled) return
          setState(
            result.ok
              ? { rows: fileMentionCandidates(workspaceRoot, result.results, query), loading: false, error: null }
              : { rows: [], loading: false, error: result.message },
          )
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setState({ rows: [], loading: false, error: error instanceof Error ? error.message : String(error) })
        })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (started) void files.cancelSearch(channel).catch(() => undefined)
    }
  }, [query, workspaceRoot, channel, files])
  return state
}

const InlineMentionPicker = forwardRef<
  InlineSkillPickerHandle,
  {
    workspaceRoot: string | null
    query: string
    onPick: (mention: ConversationMentionRef) => void
    onDismiss: () => void
  }
>(function InlineMentionPicker({ workspaceRoot, query, onPick, onDismiss }, ref) {
  const { rows, loading, error } = useFileMentionSearch(workspaceRoot, query)
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const active = Math.min(activeIndex, Math.max(0, rows.length - 1))
  useEffect(() => setActiveIndex(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  useImperativeHandle(
    ref,
    () => ({
      moveSelection(delta) {
        setActiveIndex((current) => Math.max(0, Math.min(rows.length - 1, current + delta)))
        return rows.length > 0
      },
      pickActive() {
        const row = rows[active]
        if (!row) return false
        onPick(row)
        return true
      },
      matchCount: () => rows.length,
    }),
    [active, onPick, rows],
  )
  return (
    <div className="pointer-events-none absolute inset-0 flex">
      <Popover
        open
        onOpenChange={(open) => {
          if (!open) onDismiss()
        }}
        ariaLabel="Mention a workspace file"
        popupRole="listbox"
        placement="top-start"
        material="glass"
        className="w-full"
        renderTrigger={() => null}
        surfaceClassName="w-[var(--popover-trigger-width)]"
      >
        <div ref={listRef} id={listId} className="max-h-64 overflow-y-auto py-1">
          {loading || error || rows.length === 0 ? (
            <p role="status" className="px-3 py-2 text-meta text-[color:var(--text-muted)]">
              {error ??
                (loading ? 'Searching files…' : query ? 'No matching workspace files.' : 'Type a file or folder name.')}
            </p>
          ) : null}
          {rows.map((row, index) => (
            <MenuOption
              key={`${row.kind}:${row.path}`}
              role="option"
              selected={index === active}
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => onPick(row)}
              trailing={row.kind === 'folder' ? 'Folder' : undefined}
            >
              {row.path}
            </MenuOption>
          ))}
        </div>
        <div className="border-t border-[color:var(--border-subtle)] px-3 py-1.5 text-micro text-[color:var(--text-subtle)]">
          ↑↓ choose · enter or tab attach · esc dismiss
        </div>
      </Popover>
    </div>
  )
})

/** The `/` menu's inputs: the merged command list and what is known about the CLI's answer. */
export type ComposerCommandMenuInput = {
  commands: readonly ConversationCommand[]
  status: SlashCommandMenuStatus
  /** The menu opened on a fresh `/`: a chance to ask the CLI again. */
  onOpen?: () => void
}

export function useComposerContextPicker({
  workspaceRoot,
  draft,
  caret,
  skillsEnabled,
  mentionsEnabled = true,
  commandMenu = null,
  onPickSkill,
  onPickMention,
  onPickCommand,
}: {
  workspaceRoot: string | null
  draft: string
  caret: number
  skillsEnabled: boolean
  mentionsEnabled?: boolean
  /** Null where the chat has no command list: `/` then stays literal text. */
  commandMenu?: ComposerCommandMenuInput | null
  onPickSkill: (skill: WorkspaceSkill, range: TriggerRange) => void
  onPickMention: (mention: ConversationMentionRef, range: TriggerRange) => void
  onPickCommand?: (command: ConversationCommand, range: TriggerRange) => void
}) {
  const detected = useMemo(() => detectComposerTrigger(draft, caret), [draft, caret])
  // A dismissal is remembered by where the token starts, not by what it
  // holds: Esc keeps the menu shut while the person goes on typing into the
  // same token, and a new token (or the caret leaving this one) forgets it.
  const tokenKey = detected ? `${detected.kind}:${detected.range.start}` : null
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  useEffect(() => {
    if (dismissedKey !== null && tokenKey !== dismissedKey) setDismissedKey(null)
  }, [dismissedKey, tokenKey])
  const enabled =
    detected?.kind === 'mention' ? mentionsEnabled : detected?.kind === 'skill' ? skillsEnabled : commandMenu !== null
  const trigger = detected && tokenKey !== dismissedKey && enabled ? detected : null
  const pickerRef = useRef<InlineSkillPickerHandle>(null)
  const dismiss = useCallback(() => setDismissedKey(tokenKey), [tokenKey])

  // The command menu's rows and highlight live here rather than inside the
  // menu, because the field is the combobox: its `aria-activedescendant`
  // names the highlighted row, and the keys that move it arrive on the field.
  // A `/` later in the message lists only what does something there: the CLI
  // runs a command only as the message's first word (`commandWorksMidMessage`).
  const commandQuery = trigger?.kind === 'slash' ? trigger.query : null
  const commandOpensMessage = trigger?.kind === 'slash' && tokenOpensMessage(draft, trigger.range.start)
  const allCommands = commandMenu?.commands
  const commandRows = useMemo(() => {
    if (commandQuery === null || !allCommands) return []
    const rows = rankConversationCommands(allCommands, commandQuery)
    return commandOpensMessage ? rows : rows.filter(commandWorksMidMessage)
  }, [allCommands, commandQuery, commandOpensMessage])
  const [commandIndex, setCommandIndex] = useState(0)
  useEffect(() => setCommandIndex(0), [commandQuery])
  const activeCommand = Math.min(commandIndex, Math.max(0, commandRows.length - 1))
  const commandOpen = trigger?.kind === 'slash'
  const onOpenCommands = commandMenu?.onOpen
  const commandTokenStart = commandOpen ? trigger.range.start : null
  useEffect(() => {
    if (commandTokenStart !== null) onOpenCommands?.()
  }, [commandTokenStart, onOpenCommands])
  const pickCommand = useCallback(
    (command: ConversationCommand) => {
      if (trigger?.kind === 'slash') onPickCommand?.(command, trigger.range)
    },
    [onPickCommand, trigger],
  )

  const listId = useId()
  const optionId = useCallback((index: number) => `${listId}-option-${index}`, [listId])

  const handleKeyDown = useCallback(
    (event: ComposerKeyEvent): boolean => {
      if (!trigger || isImeKey(event)) return false
      // A token under the caret is not a request to pick: "ping @alice" + Enter
      // sends, arrows move the caret and Tab moves focus unless the open picker
      // has a highlighted result to act on. Shift+Enter is always a newline.
      // With no command matching, Enter sends what was typed — `/foo bar` for
      // a command the list does not know still reaches the CLI.
      const commands = trigger.kind === 'slash'
      const picker = pickerRef.current
      const count = commands ? commandRows.length : (picker?.matchCount() ?? 0)
      const highlighted = count > 0
      if (event.key === 'Escape') dismiss()
      else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && highlighted) {
        const delta = event.key === 'ArrowUp' ? -1 : 1
        // The command list wraps, as a short menu does; the skill and file
        // lists stop at their ends.
        if (commands) setCommandIndex((activeCommand + delta + count) % count)
        else picker?.moveSelection(delta)
      } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && highlighted) {
        if (commands) pickCommand(commandRows[activeCommand])
        else if (!picker?.pickActive()) return false
      } else return false
      event.preventDefault()
      event.stopPropagation()
      return true
    },
    [activeCommand, commandRows, dismiss, pickCommand, trigger],
  )
  const picker =
    trigger?.kind === 'mention' ? (
      <InlineMentionPicker
        ref={pickerRef}
        workspaceRoot={workspaceRoot}
        query={trigger.query}
        onPick={(mention) => onPickMention(mention, trigger.range)}
        onDismiss={dismiss}
      />
    ) : trigger?.kind === 'skill' ? (
      <InlineSkillPicker
        ref={pickerRef}
        workspaceRoot={workspaceRoot}
        pluginId={null}
        query={trigger.query}
        onPick={(skill) => onPickSkill(skill, trigger.range)}
        onDismiss={dismiss}
      />
    ) : trigger?.kind === 'slash' && commandMenu ? (
      <SlashCommandMenu
        listId={listId}
        optionId={optionId}
        rows={commandRows}
        activeIndex={activeCommand}
        query={trigger.query}
        status={commandMenu.status}
        skillsHint={skillsEnabled}
        onActiveIndexChange={setCommandIndex}
        onPick={pickCommand}
        onDismiss={dismiss}
      />
    ) : null
  // The field's combobox wiring, where the chat has a command menu. Only that
  // menu is a listbox the field points into; the skill and file pickers keep
  // their own semantics.
  const commandMenuOpen = commandOpen && commandMenu !== null
  const comboboxProps: ComboboxAttributes = commandMenu
    ? {
        role: 'combobox',
        'aria-autocomplete': 'list',
        'aria-expanded': commandMenuOpen,
        'aria-controls': commandMenuOpen ? listId : undefined,
        'aria-activedescendant': commandMenuOpen && commandRows.length ? optionId(activeCommand) : undefined,
      }
    : {}
  return { trigger, pickerRef, handleKeyDown, dismiss, picker, comboboxProps }
}

/**
 * One skill attached to the next turn, as a tag: hover or click opens what the
 * skill is and a way to read it; its × takes it off. The composer row's tags
 * beside the "+" are these.
 */
export function SkillContextChip({
  skill,
  onRemove,
  onOpen,
}: {
  skill: WorkspaceSkill
  onRemove: () => void
  onOpen: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <AttachmentChip label={skill.name} removeLabel={`Remove ${skill.name}`} onRemove={onRemove}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        ariaLabel={skill.name}
        popupRole="dialog"
        placement="top-start"
        renderTrigger={({ ref, triggerProps, togglePopover }) => (
          <ChipButton
            ref={ref}
            {...triggerProps}
            variant="outline"
            onMouseEnter={() => setOpen(true)}
            onClick={togglePopover}
          >
            <StarGlyph filled={false} stroked className="icon-xs" />
            {skill.name}
          </ChipButton>
        )}
      >
        <div className="max-w-xs space-y-2 p-3 text-meta">
          <p className="font-medium">{skill.name}</p>
          {skill.description ? <p>{skill.description}</p> : null}
          <p className="text-[color:var(--text-muted)]">
            {skill.source} · {skill.installState === 'available' ? 'Available to install' : 'Installed'}
          </p>
          <LinkButton
            onClick={() => {
              setOpen(false)
              onOpen()
            }}
          >
            Open skill
          </LinkButton>
        </div>
      </Popover>
    </AttachmentChip>
  )
}

/**
 * The files and folders @-mentioned into the draft, as removable chips above
 * the field. The skills attached to the turn are tags on the row under the
 * field instead (`SkillContextChip`), beside the "+" that attached them.
 */
export function ComposerContextChips({
  mentions,
  onRemoveMention,
}: {
  mentions: ConversationMentionRef[]
  onRemoveMention: (mention: ConversationMentionRef) => void
}) {
  if (mentions.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 px-5 pt-3" aria-label="Attached context">
      {mentions.map((mention) => (
        <AttachmentChip
          key={`${mention.kind}:${mention.path}`}
          label={mention.path + (mention.kind === 'folder' ? '/' : '')}
          removeLabel={`Remove ${mention.path}`}
          onRemove={() => onRemoveMention(mention)}
        />
      ))}
    </div>
  )
}
