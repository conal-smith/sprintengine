import React, { useCallback, useRef, useState, type JSX } from 'react'

import { Popover } from './Popover'
import type { SelectItem } from './Select'
import { MENU_GROUP_LABEL_CLASS, MENU_ITEM_CLASS, MENU_LIST_CLASS } from './menuClasses'
import { FOCUS_RING_CLASS } from './tokens'

// The shared filter/sort affordance: axis controls collapse behind a single
// glyph (progressive disclosure) so search stays the only at-rest control in a
// panel toolbar. Because hiding the controls would also hide that a filter is
// applied, the trigger marks itself active — accent tint (no dot: the app draws none) and an
// accessible name that says so — whenever any axis is off its default.
//
// The surface is a `menu` of `group`s of `menuitemradio` options; the checked
// option in each group is that group's tab stop, with Arrow/Home/End roving
// across the whole list — the same keyboard contract as OverflowMenu. Picking
// an option does not close the menu, so several axes can be set in one visit;
// Escape / outside-click close and restore focus to the glyph.
//
// Generic sibling of the Backlog panel's BacklogFilterMenu (same visual and
// keyboard behavior); new panels should use this one.

export type FilterMenuGroup = {
  label: string
  items: ReadonlyArray<SelectItem<string>>
  value: string
  // The "no filter applied" baseline the active marker is measured against.
  defaultValue: string
  onChange: (value: string) => void
}

type FilterMenuProps = {
  ariaLabel: string
  groups: ReadonlyArray<FilterMenuGroup>
  className?: string
  // `sm`, the default, is a panel toolbar's glyph. `md` is the icon button's
  // `md` step, for a trigger that stands in a row of `md` icon buttons (the
  // chat rail's, beside New chat) and has to read as one of them.
  size?: 'sm' | 'md'
}

const TRIGGER_BOX = { sm: 'h-6 w-6', md: 'size-control-sm' } as const

const OPTION_SELECTOR = '[data-filter-option="true"]'

export function FilterMenu({ ariaLabel, groups, className, size = 'sm' }: FilterMenuProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const surfaceRef = useRef<HTMLElement | null>(null)

  // On open, land focus on the first checked option (or the first option) so
  // the menu is immediately keyboard-operable from its current state.
  const focusSelected = useCallback((surface: HTMLElement) => {
    surfaceRef.current = surface
    const checked = surface.querySelector<HTMLButtonElement>(`${OPTION_SELECTOR}[data-selected="true"]`)
    const target = checked ?? surface.querySelector<HTMLButtonElement>(OPTION_SELECTOR)
    target?.focus()
  }, [])

  const focusByOffset = (current: HTMLElement, offset: 1 | -1) => {
    const surface = surfaceRef.current
    if (!surface) return
    const nodes = Array.from(surface.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR))
    const idx = nodes.indexOf(current as HTMLButtonElement)
    if (idx < 0 || nodes.length === 0) return
    nodes[(idx + offset + nodes.length) % nodes.length]?.focus()
  }

  const onOptionKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusByOffset(event.currentTarget, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusByOffset(event.currentTarget, -1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      surfaceRef.current?.querySelector<HTMLButtonElement>(OPTION_SELECTOR)?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      const nodes = surfaceRef.current?.querySelectorAll<HTMLButtonElement>(OPTION_SELECTOR)
      nodes?.[nodes.length - 1]?.focus()
    }
  }

  const active = groups.some((group) => group.value !== group.defaultValue)

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      popupRole="menu"
      placement="bottom-end"
      className={className}
      surfaceClassName={`min-w-[12rem] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusSelected}
      renderTrigger={({ ref, togglePopover, triggerProps, open: opened }) => (
        <button
          ref={ref}
          type="button"
          aria-haspopup="menu"
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          aria-label={active ? `${ariaLabel} — filters active` : ariaLabel}
          onClick={togglePopover}
          className={[
            'interactive relative inline-flex items-center justify-center rounded-sm',
            TRIGGER_BOX[size],
            FOCUS_RING_CLASS,
            opened || active
              ? 'text-[color:var(--accent-primary)]'
              : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]',
            opened ? 'bg-[color:var(--bg-hover)]' : 'hover:bg-[color:var(--bg-hover)]',
          ].join(' ')}
        >
          <FilterGlyph />
        </button>
      )}
    >
      {groups.map((group, index) => (
        <FilterGroup
          key={group.label}
          label={group.label}
          items={group.items}
          current={group.value}
          onSelect={group.onChange}
          onOptionKey={onOptionKey}
          divider={index > 0}
        />
      ))}
    </Popover>
  )
}

function FilterGroup({
  label,
  items,
  current,
  onSelect,
  onOptionKey,
  divider,
}: {
  label: string
  items: ReadonlyArray<SelectItem<string>>
  current: string
  onSelect: (value: string) => void
  onOptionKey: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  divider?: boolean
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={`py-1 ${divider ? 'mt-1 border-t border-[color:var(--border-subtle)] pt-1.5' : ''}`}
    >
      <p className={`${MENU_GROUP_LABEL_CLASS} pb-0.5`}>{label}</p>
      {items.map((item) => {
        const selected = item.value === current
        return (
          <button
            key={item.value}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            data-filter-option="true"
            data-selected={selected || undefined}
            // The checked option is the group's tab stop (radiogroup roving);
            // Arrow/Home/End move within the surface, Enter/Space select.
            tabIndex={selected ? 0 : -1}
            onKeyDown={onOptionKey}
            onClick={() => onSelect(item.value)}
            className={[
              MENU_ITEM_CLASS,
              selected
                ? 'text-[color:var(--text-strong)]'
                : 'text-[color:var(--text-default)] hover:text-[color:var(--text-strong)]',
            ].join(' ')}
          >
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[color:var(--accent-primary)]">
              {selected ? <CheckGlyph /> : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function FilterGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CheckGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
