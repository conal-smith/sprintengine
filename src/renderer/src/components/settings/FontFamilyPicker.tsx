import React from 'react'

import { showToast } from '../../store/toastStore'
import { fontStackFor, normalizeFontFamilyPreference } from '../../utils/fontFamilyPreference'
import {
  isFontFamilyAvailable,
  isMonospaceFamily,
  loadInstalledFontFamilies,
  type InstalledFontFamilies,
} from '../../utils/localFonts'
import { CheckIcon, ChevronDownIcon } from '../AppIcons'
import { Input, MenuOption, Popover, TriggerButton } from '../ui'
import { fontPickerOptions, selectedFontOptionKey, type FontPickerOption } from './fontPickerModel'

type FontFamilyPickerProps = {
  /** The setting's name, which is the trigger's and the surface's accessible name. */
  label: string
  /** The stored family; empty is the default face. */
  value: string
  onChange: (family: string) => void
  /** The bundled face the default stands for, by name ("Inter"). */
  defaultFamily: string
  /** The stack every preview falls back to, so a row missing a glyph draws it in the default. */
  defaultStack: string
  /**
   * The code font: each family on screen is marked when it is monospace, and a
   * proportional one is refused — a terminal lays text on a grid of equal
   * cells, and a proportional face draws narrower than the grid it sits on.
   */
  monospace?: boolean
}

type ListState = InstalledFontFamilies | { status: 'loading' }

/**
 * A searchable list of the installed font families, each drawn in its own
 * face, with the bundled default at the top. The search field is the
 * combobox: it keeps focus while the arrows move the highlight, and names the
 * highlighted row through `aria-activedescendant`. Where the system will not
 * list its fonts, the same field takes a family's name.
 *
 * The family list is read the first time a picker opens, not before
 * (`loadInstalledFontFamilies`). A row is laid out only while it is near the
 * view (`content-visibility`), so opening a list of a thousand families loads
 * the faces of the dozen on screen, not all thousand.
 */
export function FontFamilyPicker({
  label,
  value,
  onChange,
  defaultFamily,
  defaultStack,
  monospace = false,
}: FontFamilyPickerProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [list, setList] = React.useState<ListState>({ status: 'loading' })
  const [activeKey, setActiveKey] = React.useState<string | null>(null)
  const triggerRef = React.useRef<{ current: HTMLButtonElement | null } | null>(null)
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const listId = React.useId()

  React.useEffect(() => {
    if (!open) return
    let current = true
    void loadInstalledFontFamilies().then((result) => {
      if (current) setList(result)
    })
    return () => {
      current = false
    }
  }, [open])

  const families = list.status === 'granted' ? list.families : NO_FAMILIES
  const options = React.useMemo(() => fontPickerOptions(families, query), [families, query])
  const selectedKey = selectedFontOptionKey(value)
  const activeIndex = ((): number => {
    const held = activeKey === null ? -1 : options.findIndex((option) => option.key === activeKey)
    if (held >= 0) return held
    const selected = options.findIndex((option) => option.key === selectedKey)
    if (selected >= 0) return selected
    return options.length > 0 ? 0 : -1
  })()
  const optionId = React.useCallback((key: string): string => `${listId}-${key}`, [listId])

  const stored = normalizeFontFamilyPreference(value)
  const shownFamily = stored.length > 0 ? stored : defaultFamily

  const close = (): void => {
    setOpen(false)
    triggerRef.current?.current?.focus()
  }

  const choose = (option: FontPickerOption): void => {
    if (option.kind === 'default') {
      onChange('')
      close()
      return
    }
    // A typed name is checked against what is installed: one that is not would
    // be stored, and every surface would quietly go on drawing the fallback.
    if (option.kind === 'typed' && !isFontFamilyAvailable(option.family)) {
      showToast({
        tone: 'warn',
        title: `“${option.family}” isn’t installed`,
        description: 'Check the name, or install the font. The current font was kept.',
      })
      return
    }
    if (monospace && !isMonospaceFamily(option.family)) {
      showToast({
        tone: 'warn',
        title: `“${option.family}” isn’t monospace`,
        description: 'Code and the terminal need a fixed-width font, so the current font was kept.',
      })
      return
    }
    onChange(option.family)
    close()
  }

  // Kept for the rows, which are memoized and must not take a new handler on
  // every keystroke.
  const chooseRef = React.useRef(choose)
  chooseRef.current = choose
  const onChooseKey = React.useCallback(
    (key: string) => {
      const option = options.find((candidate) => candidate.key === key)
      if (option) chooseRef.current(option)
    },
    [options],
  )

  React.useEffect(() => {
    if (!open || activeIndex < 0) return
    const row = document.getElementById(optionId(options[activeIndex]!.key))
    // Optional-called: jsdom has no `scrollIntoView`.
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex, options, optionId])

  const onQueryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      if (options.length === 0) return
      const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
      setActiveKey(options[next]!.key)
      return
    }
    // Home and End are the caret's while there is text to move it through.
    if ((event.key === 'Home' || event.key === 'End') && query.length === 0 && options.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      setActiveKey(options[event.key === 'Home' ? 0 : options.length - 1]!.key)
      return
    }
    if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault()
      event.stopPropagation()
      choose(options[activeIndex]!)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery('')
          setActiveKey(null)
        }
        setOpen(next)
      }}
      ariaLabel={label}
      popupRole="dialog"
      onOpenAutoFocus={focusFontSearch}
      placement="bottom-end"
      renderTrigger={({ ref, triggerProps, togglePopover }) => {
        triggerRef.current = ref
        return (
          <TriggerButton
            ref={ref}
            open={open}
            onClick={togglePopover}
            aria-label={`${label}: ${shownFamily}${stored.length === 0 ? ' (default)' : ''}`}
            className="w-56"
            data-font-picker-trigger={label}
            {...triggerProps}
          >
            {/* The value, drawn in itself. */}
            <span className="min-w-0 flex-1 truncate" style={{ fontFamily: fontStackFor(stored, defaultStack) }}>
              {shownFamily}
            </span>
            {stored.length === 0 ? (
              <span className="shrink-0 text-micro text-[color:var(--text-subtle)]">Default</span>
            ) : null}
            <ChevronDownIcon className="icon-xs shrink-0 text-[color:var(--text-muted)]" />
          </TriggerButton>
        )
      }}
    >
      <div className="flex w-72 flex-col">
        <div className="border-b border-[color:var(--border-subtle)] p-1.5">
          <Input
            variant="quiet"
            size="sm"
            type="search"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? optionId(options[activeIndex]!.key) : undefined}
            aria-autocomplete="list"
            aria-label={`Search ${label.toLocaleLowerCase()}`}
            data-font-search="true"
            placeholder={list.status === 'unavailable' ? 'Type a font’s name…' : 'Search fonts…'}
            spellCheck={false}
            autoComplete="off"
            maxLength={200}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setActiveKey(null)
            }}
            onKeyDown={onQueryKeyDown}
          />
        </div>
        {list.status === 'unavailable' ? (
          <p className="m-0 px-2.5 pt-2 text-micro text-[color:var(--text-muted)]">
            This computer didn’t share its list of fonts. Type the name of one that is installed.
          </p>
        ) : null}
        <FontOptionList
          listRef={listRef}
          listId={listId}
          label={label}
          options={options}
          activeKey={activeIndex >= 0 ? options[activeIndex]!.key : null}
          selectedKey={selectedKey}
          defaultFamily={defaultFamily}
          defaultStack={defaultStack}
          monospace={monospace}
          loading={list.status === 'loading'}
          optionId={optionId}
          onHighlight={setActiveKey}
          onChoose={onChooseKey}
        />
      </div>
    </Popover>
  )
}

const NO_FAMILIES: readonly string[] = []

/**
 * Puts focus in the search field as the picker opens, by click or by key, so
 * typing filters at once and Enter picks. Not `autoFocus`: the surface mounts
 * hidden until it has been positioned, and focus on a hidden field goes
 * nowhere — it stayed on the trigger. Asked again on the next frame when the
 * first try did not land, as the project picker does.
 */
function focusFontSearch(surface: HTMLElement): void {
  const field = surface.querySelector<HTMLInputElement>('input[data-font-search="true"]')
  if (!field) return
  field.focus()
  if (document.activeElement !== field) {
    requestAnimationFrame(() => {
      if (field.isConnected) field.focus()
    })
  }
}

// The keyboard highlight: the step the pointer's hover takes, so the arrow
// keys and the pointer mark a row the same way. Never on the row that holds
// the value — that one keeps the selection fill `MenuOption` gives it.
const KEYBOARD_HIGHLIGHT_CLASS = 'bg-[color:var(--bg-hover)] text-[color:var(--text-strong)]'

type MonospaceProbe = (row: HTMLElement, onVisible: () => void) => () => void

function FontOptionList({
  listRef,
  listId,
  label,
  options,
  activeKey,
  selectedKey,
  defaultFamily,
  defaultStack,
  monospace,
  loading,
  optionId,
  onHighlight,
  onChoose,
}: {
  listRef: React.RefObject<HTMLDivElement | null>
  listId: string
  label: string
  options: readonly FontPickerOption[]
  activeKey: string | null
  selectedKey: string
  defaultFamily: string
  defaultStack: string
  monospace: boolean
  loading: boolean
  optionId: (key: string) => string
  onHighlight: (key: string) => void
  onChoose: (key: string) => void
}): React.JSX.Element {
  // One observer for the whole list. A row asks whether its family is
  // monospace only once it comes near the view, where its face is being
  // loaded to draw it anyway — never for the thousand rows scrolled away.
  const [probe, setProbe] = React.useState<MonospaceProbe | null>(null)
  React.useEffect(() => {
    const root = listRef.current
    if (!monospace || !root || typeof IntersectionObserver === 'undefined') return
    const waiting = new Map<Element, () => void>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          observer.unobserve(entry.target)
          const onVisible = waiting.get(entry.target)
          waiting.delete(entry.target)
          onVisible?.()
        }
      },
      { root },
    )
    setProbe(() => (row: HTMLElement, onVisible: () => void) => {
      waiting.set(row, onVisible)
      observer.observe(row)
      return () => {
        waiting.delete(row)
        observer.unobserve(row)
      }
    })
    return () => {
      observer.disconnect()
      setProbe(null)
    }
  }, [listRef, monospace])

  return (
    <div ref={listRef} id={listId} role="listbox" aria-label={label} className="max-h-72 overflow-y-auto py-1">
      {options.map((option) => (
        <FontOptionRow
          key={option.key}
          option={option}
          id={optionId(option.key)}
          active={option.key === activeKey}
          selected={option.key === selectedKey}
          defaultFamily={defaultFamily}
          defaultStack={defaultStack}
          probe={probe}
          onHighlight={onHighlight}
          onChoose={onChoose}
        />
      ))}
      {loading ? (
        <p className="m-0 px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]" role="status">
          Reading installed fonts…
        </p>
      ) : options.length === 0 ? (
        <p className="m-0 px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]" role="status">
          No fonts match.
        </p>
      ) : null}
    </div>
  )
}

const FontOptionRow = React.memo(function FontOptionRow({
  option,
  id,
  active,
  selected,
  defaultFamily,
  defaultStack,
  probe,
  onHighlight,
  onChoose,
}: {
  option: FontPickerOption
  id: string
  active: boolean
  selected: boolean
  defaultFamily: string
  defaultStack: string
  probe: MonospaceProbe | null
  onHighlight: (key: string) => void
  onChoose: (key: string) => void
}) {
  const family = option.kind === 'default' ? defaultFamily : option.family
  const rowRef = React.useRef<HTMLButtonElement | null>(null)
  const [mono, setMono] = React.useState(false)
  React.useEffect(() => {
    const row = rowRef.current
    if (!probe || !row || option.kind === 'default') return
    return probe(row, () => setMono(isMonospaceFamily(family)))
  }, [probe, option.kind, family])
  return (
    <MenuOption
      ref={rowRef}
      id={id}
      role="option"
      selected={selected}
      tabIndex={-1}
      data-font-option={option.key}
      // Focus stays in the search field; a press on a row must not take it.
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => onHighlight(option.key)}
      onClick={() => onChoose(option.key)}
      // `content-visibility`: a row far from the view is not laid out, so its
      // face is not loaded until the list scrolls to it.
      className={`text-body [contain-intrinsic-size:auto_var(--control-sm)] [content-visibility:auto] ${
        active && !selected ? KEYBOARD_HIGHLIGHT_CLASS : ''
      }`}
      trailing={
        <span className="flex shrink-0 items-center gap-1.5 text-micro text-[color:var(--text-subtle)]">
          {option.kind === 'default' ? 'Default' : null}
          {option.kind === 'typed' ? 'Use this name' : null}
          {mono ? 'Monospace' : null}
          <CheckIcon className={`icon-xs ${selected ? 'text-[color:var(--accent-primary)]' : 'invisible'}`} />
        </span>
      }
    >
      <span style={{ fontFamily: option.kind === 'default' ? defaultStack : fontStackFor(family, defaultStack) }}>
        {family}
      </span>
    </MenuOption>
  )
})
