import React, { useCallback, useState } from 'react'

import { conversationProviderForCli } from '../../../../shared/conversation-harness'
import type { AgentCli } from '../../types/workspace'
import CliIcon from '../CliIcon'
import {
  IconButton,
  MenuDivider,
  MenuItem,
  MENU_GROUP_LABEL_CLASS,
  MENU_LIST_CLASS,
  Popover,
  roveMenuFocus,
  Tooltip,
} from '../ui'
import { useAgentCliCatalogOptions } from './agentComposer/useAgentComposer'

/**
 * What a row of the tab strip's "+" opens the new tab on: the kind of agent and
 * the CLI it runs. The tab still opens the launch surface, standing on that
 * pick, so the prompt, the project and the permissions stay where they always
 * are; only the choice of engine moves up to the click that made the tab.
 */
export type NewAgentTabPick = { kind: 'conversation' | 'general'; cli: AgentCli } | { kind: 'terminal' }

type NewAgentTabMenuProps = {
  /** Opens the tab; no pick is the surface as it was, on the last engine used. */
  onPick: (pick?: NewAgentTabPick) => void
}

const FIRST_ROW_SELECTOR = '[role=menuitem]:not([disabled])'

/**
 * The tab strip's "+": every engine this machine has, as a chat and as a
 * terminal agent, then a plain terminal. One click used to open the surface on
 * whatever engine was used last — Claude Code for most people — and the other
 * CLIs were a level down, behind the engine chip, so the strip read as one that
 * could only start Claude. The rows come from the same catalog every engine
 * picker reads, so a CLI that is not installed is not offered here either.
 */
export function NewAgentTabMenu({ onPick }: NewAgentTabMenuProps) {
  const [open, setOpen] = useState(false)
  const engines = useAgentCliCatalogOptions()
  // The strip's "+" is on standard workspaces only, every one of which can
  // host a chat agent; a chat needs a CLI with a conversation runtime.
  const chatEngines = engines.filter((option) => conversationProviderForCli(option.value) !== null)

  const pick = useCallback(
    (choice?: NewAgentTabPick) => {
      setOpen(false)
      onPick(choice)
    },
    [onPick],
  )

  const engineRow = (kind: 'conversation' | 'general', option: (typeof engines)[number]) => (
    <MenuItem
      key={`${kind}:${option.value}`}
      onClick={() => pick({ kind, cli: option.value })}
      icon={<CliIcon cli={option.value} className="icon-sm shrink-0" />}
    >
      {option.label}
    </MenuItem>
  )

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="New agent"
      popupRole="menu"
      placement="bottom-start"
      onOpenAutoFocus={(surface) => {
        surface.querySelector<HTMLButtonElement>(FIRST_ROW_SELECTOR)?.focus()
      }}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content="New agent" placement="bottom">
          {/* `GHOST_TONE.quiet` is this control's rest ink exactly —
              `--text-disabled`, lifting on `--bg-hover` — which is what keeps a
              sticky control from competing with the tab labels beside it. */}
          <IconButton
            ref={ref}
            tone="quiet"
            aria-label="New agent"
            pressed={open}
            {...triggerProps}
            onClick={(event) => {
              // The strip's own click handler would select whatever tab sits
              // under the button; this is a control, not a tab.
              event.stopPropagation()
              togglePopover()
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="icon-xs">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            </svg>
          </IconButton>
        </Tooltip>
      )}
    >
      <div
        className={`w-[220px] ${MENU_LIST_CLASS}`}
        onKeyDown={(event) => roveMenuFocus(event, event.currentTarget)}
        onClick={(event) => event.stopPropagation()}
      >
        {chatEngines.length > 0 && (
          <>
            <div className={`${MENU_GROUP_LABEL_CLASS} pb-1 pt-1.5`}>Chat</div>
            {chatEngines.map((option) => engineRow('conversation', option))}
            <MenuDivider />
          </>
        )}
        {engines.length > 0 && (
          <>
            <div className={`${MENU_GROUP_LABEL_CLASS} pb-1 pt-1.5`}>Terminal agent</div>
            {engines.map((option) => engineRow('general', option))}
            <MenuDivider />
          </>
        )}
        <MenuItem onClick={() => pick({ kind: 'terminal' })}>Terminal</MenuItem>
        <MenuItem onClick={() => pick()}>More options…</MenuItem>
      </div>
    </Popover>
  )
}
