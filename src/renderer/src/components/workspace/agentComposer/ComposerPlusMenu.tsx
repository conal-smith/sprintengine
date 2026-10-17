import React from 'react'

import { ComposerPlusGlyph, IconButton, Popover, type PopoverPlacement } from '../../ui'
import { MENU_LIST_CLASS } from '../../ui/menuClasses'
import { ComposerOptions, type ComposerOptionsProps, type StartAs } from './ComposerOptionsMenu'
import { SkillsAndMcpsPicker, type SkillsAndMcpsPickerProps } from './SkillsAndMcpsPicker'

// The composer's "+" (owner ruling 2026-10-04): the round button at the start
// of the row under the prompt, the menu it opens, and the skills picker one of
// that menu's rows opens over the same "+". ONE assembly, because the New chat
// composer and an open conversation's composer must offer the same door, not
// two that resemble each other — the conversation's used to be a paperclip and
// a Skills chip side by side, which was the same two features spelled
// differently.
//
// Both popovers stand on one anchor, so the picker opens where the person was
// looking rather than from a row that has already gone with its menu.

/** Only a conversation: the shape a running chat passes, where how it started is settled. */
const CONVERSATION_ONLY: ReadonlySet<StartAs> = new Set<StartAs>(['conversation'])

export type ComposerPlusMenuProps = {
  /** Which side the menu and the picker open on; they flip when there is no room. */
  placement: Extract<PopoverPlacement, 'bottom-start' | 'top-start'>
  /**
   * The "Start as" tiles. Absent, the launch is a conversation and nothing
   * else, and the menu draws no tiles (one kind on offer is not a choice).
   */
  startAs?: { kind: StartAs; offered: ReadonlySet<StartAs>; onStartAs: (kind: StartAs) => void }
  /** Attach files; absent where the composer takes none. */
  onAttach?: ComposerOptionsProps['onAttach']
  /** The schedule row; absent where scheduling is not offered. */
  schedule?: ComposerOptionsProps['schedule']
  /**
   * The skills (and, where offered, MCP servers) picker the menu's row opens.
   * Absent where the composer reads none, and the row is not drawn.
   */
  skills?: Omit<SkillsAndMcpsPickerProps, 'open' | 'onOpenChange' | 'renderTrigger' | 'placement'>
  /** The side question row; absent where the chat answers none (and in New chat, which has nothing to ask about). */
  sideQuestion?: ComposerOptionsProps['sideQuestion']
}

// Memoized: an open chat re-renders its composer row on every streamed token,
// and the "+" has nothing to redraw until one of its own props changes.
export const ComposerPlusMenu = React.memo(function ComposerPlusMenu({
  placement,
  startAs,
  onAttach,
  schedule,
  skills,
  sideQuestion,
}: ComposerPlusMenuProps) {
  const [optionsOpen, setOptionsOpen] = React.useState(false)
  const [skillsOpen, setSkillsOpen] = React.useState(false)
  // The "+" itself, so a pick from its menu hands focus back to it: the row
  // picked unmounts with the menu, and focus would otherwise fall to the page.
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  // Stable, because the popover runs it whenever it changes while open: an
  // inline one re-ran on every render of the host and pulled focus back to the
  // checked row from wherever the arrows had moved it.
  const focusOnOpen = React.useCallback((surface: HTMLElement) => {
    ;(
      surface.querySelector<HTMLElement>('[data-menu-item="true"][aria-checked="true"]') ??
      surface.querySelector<HTMLElement>('[data-menu-item="true"]:not([disabled])')
    )?.focus()
  }, [])
  const skillsCount = skills ? skills.skills.length + (skills.includeMcps === false ? 0 : skills.mcpServers.length) : 0
  return (
    <Popover
      open={optionsOpen}
      onOpenChange={(next) => {
        if (next) setSkillsOpen(false)
        setOptionsOpen(next)
      }}
      ariaLabel="Options"
      popupRole="menu"
      placement={placement}
      surfaceClassName={`w-[304px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusOnOpen}
      renderTrigger={({ ref: optionsRef, triggerProps, togglePopover }) => {
        const plus = (anchor: (node: HTMLButtonElement | null) => void) => (
          <IconButton
            ref={anchor}
            size="md"
            aria-label="Options"
            onClick={togglePopover}
            data-composer-options="true"
            className="shrink-0"
            {...triggerProps}
          >
            <ComposerPlusGlyph className="icon-sm" />
          </IconButton>
        )
        return skills ? (
          <SkillsAndMcpsPicker
            {...skills}
            placement={placement}
            open={skillsOpen}
            onOpenChange={setSkillsOpen}
            renderTrigger={({ ref: skillsRef }) =>
              plus((node) => {
                optionsRef.current = node
                skillsRef.current = node
                triggerRef.current = node
              })
            }
          />
        ) : (
          plus((node) => {
            optionsRef.current = node
            triggerRef.current = node
          })
        )
      }}
    >
      <ComposerOptions
        startAs={startAs?.kind ?? 'conversation'}
        offered={startAs?.offered ?? CONVERSATION_ONLY}
        onStartAs={startAs?.onStartAs ?? (() => undefined)}
        onAttach={onAttach}
        onSkills={skills ? () => setSkillsOpen(true) : undefined}
        skillsCount={skillsCount}
        schedule={schedule}
        sideQuestion={sideQuestion}
        close={() => {
          setOptionsOpen(false)
          triggerRef.current?.focus()
        }}
      />
    </Popover>
  )
})
