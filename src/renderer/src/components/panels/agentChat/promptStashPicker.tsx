import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { keydownMatchesKeybindings } from '../../../commands/commandDispatcher'
import { renderKeybinding, type KeybindingPlatform } from '../../../commands/keybindings'
import { showToast, useToastStore } from '../../../store/toastStore'
import { formatRelativeMsAgo } from '../../../utils/relativeTime'
import { MenuOption } from '../../ui'
import type { ComposerKeyEvent } from './ComposerField'
import {
  promptStash,
  type LoadedStashedPrompt,
  type PromptStash,
  type PromptStashInput,
  type StashedPrompt,
} from './promptStash'

// ⌘S in a composer (`chat.stash`, rebindable): with something typed, the
// draft is set aside and the box cleared, and a toast offers Undo; on an empty
// box it opens the stash in the composer's tray, where ↵ puts one back, ⌘⌫
// deletes one, and Esc closes the list. Focus never leaves the field: the field
// is the combobox and the list is the listbox it points into, the way the
// mention picker works, so typing carries on where it was.
//
// Resolved in the composer's own keydown, so ⌘S anywhere else — the editor's
// save above all — is left to what it was pressed in.

export const PROMPT_STASH_COMMAND = 'chat.stash'
const PROMPT_STASH_UNDO_TOAST_ID = 'prompt-stash-undo'
const DELETE_KEYS = ['Primary+Backspace'] as const

/** Whose stash the Undo toast would undo; a composer going away takes its toast with it. */
let undoOwner: symbol | null = null

function usePromptStashList(stash: PromptStash): readonly StashedPrompt[] {
  return useSyncExternalStore(stash.subscribe, stash.list)
}

/** A row's two lines: the first words, then what else the entry carries and when it was stashed. */
function describeStashedPrompt(entry: StashedPrompt, now: number): { title: string; detail: string } {
  const firstLine = entry.text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  const parts: string[] = []
  if (entry.images.length) parts.push(entry.images.length === 1 ? '1 image' : `${entry.images.length} images`)
  const files = entry.files.length + entry.mentions.length
  if (files) parts.push(files === 1 ? '1 file' : `${files} files`)
  const title = firstLine ?? (parts.length ? parts.join(', ') : 'Empty prompt')
  const details = firstLine ? parts : []
  const when = formatRelativeMsAgo(entry.stashedAt, now)
  if (when) details.push(`stashed ${when}`)
  return { title, detail: details.join(' · ') }
}

type PromptStashComposer = {
  /** The effective chords for `chat.stash`; empty when the person turned it off. */
  stashKeys: readonly string[]
  platform: KeybindingPlatform
  /** What the box holds right now. */
  content: () => PromptStashInput
  /** Empty the box after its content was stashed. */
  clear: () => void
  /**
   * Put an entry back, beside whatever the box holds. False when it could not
   * be, and the entry then stays in the stash.
   */
  restore: (loaded: LoadedStashedPrompt) => boolean | Promise<boolean>
  /** Whether this box takes images: an entry with images is not offered where it would lose them. */
  acceptsImages: boolean
  /** The box holds nothing: typing closes the list. */
  empty: boolean
  /** For tests; the window's stash otherwise. */
  stash?: PromptStash
}

export function usePromptStash({
  stashKeys,
  platform,
  content,
  clear,
  restore,
  acceptsImages,
  empty,
  stash: injected,
}: PromptStashComposer) {
  const stash = useMemo(() => injected ?? promptStash(), [injected])
  const entries = usePromptStashList(stash)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const owner = useRef(Symbol('prompt-stash'))
  const listId = useId()
  const active = Math.min(activeIndex, Math.max(0, entries.length - 1))
  // The chord the person has, so every hint names the key they press.
  const stashLabel = renderKeybinding(stashKeys[0] ?? 'Primary+S', platform)
  const latest = useRef({ content, clear, restore, acceptsImages })
  latest.current = { content, clear, restore, acceptsImages }

  // Something typed is the person carrying on: the list goes.
  useEffect(() => {
    if (!empty) setOpen(false)
  }, [empty])

  // The toast's Undo puts the words back in THIS box, so it cannot outlive it.
  useEffect(() => {
    const self = owner.current
    return () => {
      if (undoOwner !== self) return
      undoOwner = null
      useToastStore.getState().dismissToast(PROMPT_STASH_UNDO_TOAST_ID)
    }
  }, [])

  const restoresHere = useCallback(
    (entry: StashedPrompt) => latest.current.acceptsImages || entry.images.length === 0,
    [],
  )

  const bringBack = useCallback(
    async (entry: StashedPrompt): Promise<boolean> => {
      if (!restoresHere(entry)) return false
      const loaded = await stash.load(entry.id)
      if (!loaded) return false
      if (!(await latest.current.restore(loaded))) return false
      stash.remove(entry.id)
      if (loaded.missingImages > 0)
        showToast({
          tone: 'warn',
          title: loaded.missingImages === 1 ? 'An image did not come back' : 'Some images did not come back',
          description: 'They were no longer on this device.',
        })
      return true
    },
    [stash, restoresHere],
  )

  const stashNow = useCallback(() => {
    const input = latest.current.content()
    const entry = stash.stash(input)
    if (!entry) return false
    latest.current.clear()
    undoOwner = owner.current
    showToast({
      id: PROMPT_STASH_UNDO_TOAST_ID,
      tone: stash.saveFailed() ? 'warn' : 'good',
      title: 'Prompt stashed',
      description: stash.saveFailed()
        ? 'It could not be saved on this device and lasts until the app closes.'
        : `${stashLabel} in an empty box brings it back.`,
      actions: [
        {
          id: 'undo',
          label: 'Undo',
          run: () => {
            useToastStore.getState().dismissToast(PROMPT_STASH_UNDO_TOAST_ID)
            if (undoOwner === owner.current) undoOwner = null
            void bringBack(entry)
          },
        },
      ],
    })
    return true
  }, [stash, bringBack, stashLabel])

  /** The composer's keydown, first in line after an input method. True when the key was the stash's. */
  const handleKeyDown = useCallback(
    (event: ComposerKeyEvent): boolean => {
      if (stashKeys.length && keydownMatchesKeybindings(event, stashKeys, platform)) {
        event.preventDefault()
        event.stopPropagation()
        // A held ⌘S is one press: its repeats would stash, then open the list.
        if (event.repeat) return true
        if (open) setOpen(false)
        else if (!stashNow()) {
          setActiveIndex(0)
          setOpen(true)
        }
        return true
      }
      if (!open) return false
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        return true
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex((current) => Math.max(0, Math.min(entries.length - 1, current + step)))
        return true
      }
      if (keydownMatchesKeybindings(event, DELETE_KEYS, platform)) {
        event.preventDefault()
        const entry = entries[active]
        if (entry) stash.remove(entry.id)
        return true
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        const entry = entries[active]
        if (entry && restoresHere(entry)) {
          setOpen(false)
          void bringBack(entry)
        }
        return true
      }
      return false
    },
    [stashKeys, platform, open, stashNow, entries, active, stash, restoresHere, bringBack],
  )

  const optionId = (index: number) => `${listId}-option-${index}`
  const picker = open ? (
    <PromptStashList
      listId={listId}
      optionId={optionId}
      entries={entries}
      active={active}
      platform={platform}
      stashLabel={stashLabel}
      restoresHere={restoresHere}
      onHover={setActiveIndex}
      onPick={(entry) => {
        setOpen(false)
        void bringBack(entry)
      }}
    />
  ) : null
  const comboboxProps = open
    ? {
        role: 'combobox' as const,
        'aria-expanded': true,
        'aria-controls': listId,
        'aria-activedescendant': entries.length ? optionId(active) : undefined,
      }
    : {}
  return { open, picker, handleKeyDown, comboboxProps, close: () => setOpen(false) }
}

function PromptStashList({
  listId,
  optionId,
  entries,
  active,
  platform,
  stashLabel,
  restoresHere,
  onHover,
  onPick,
}: {
  listId: string
  optionId: (index: number) => string
  entries: readonly StashedPrompt[]
  active: number
  platform: KeybindingPlatform
  stashLabel: string
  restoresHere: (entry: StashedPrompt) => boolean
  onHover: (index: number) => void
  onPick: (entry: StashedPrompt) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const now = Date.now()
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  return (
    <div data-prompt-stash="">
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Stashed prompts"
        className="max-h-64 overflow-y-auto py-1"
      >
        {entries.length === 0 ? (
          <p role="status" className="px-3 py-2 text-meta text-[color:var(--text-muted)]">
            Nothing stashed. {stashLabel} with something typed sets it aside here.
          </p>
        ) : null}
        {entries.map((entry, index) => {
          const { title, detail } = describeStashedPrompt(entry, now)
          const here = restoresHere(entry)
          return (
            <MenuOption
              key={entry.id}
              id={optionId(index)}
              role="option"
              stacked
              selected={index === active}
              disabled={!here}
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onMouseMove={() => onHover(index)}
              onClick={() => onPick(entry)}
            >
              <span className="truncate text-body">{title}</span>
              <span className="truncate text-meta text-[color:var(--text-subtle)]">
                {here ? detail : `${detail ? `${detail} · ` : ''}this chat takes no images`}
              </span>
            </MenuOption>
          )
        })}
      </div>
      <div className="border-t border-[color:var(--border-subtle)] px-3 py-1.5 text-micro text-[color:var(--text-subtle)]">
        ↑↓ choose · enter restore · {renderKeybinding('Primary+Backspace', platform)} delete · esc close
      </div>
    </div>
  )
}
