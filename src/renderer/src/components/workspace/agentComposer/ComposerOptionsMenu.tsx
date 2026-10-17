import React from 'react'

import { CheckIcon, ScheduleGlyph } from '../../AppIcons'
import {
  AttachGlyph,
  CardButton,
  ConversationGlyph,
  MENU_DIVIDER_CLASS,
  MenuItem,
  MenuOption,
  PluginsGlyph,
  TerminalAgentGlyph,
} from '../../ui'
import { MENU_GROUP_LABEL_CLASS } from '../../ui/menuClasses'
import { TerminalPromptGlyph } from '../../ui/CodeBlockGlyphs'
import { roveMenuFocus } from '../../ui/ContextMenu'
import type { AgentComposerSelection } from './useAgentComposer'

// What the New chat composer's "+" opens (owner ruling 2026-10-04): how the
// launch starts, then what it starts with. It replaces the ⋯ menu that chose
// the kind of launch and the Chat | Scheduled agent switch above the box, so
// everything a launch rarely changes is in one place and the row under the
// prompt is a picture of this launch — each choice that is not the default
// rises next to the "+" as a tag.
//
// Every row is a feature the panel already had: "Start as" is the launch kind,
// Attach files the image attachment the box takes by paste and drop, Skills,
// plugins & MCPs the picker that was a chip on the row, and Schedule sends the
// message later — in New chat through the Scheduled agents module, in an open
// chat as a scheduled message. A row whose feature is not there is not drawn.

export type StartAs = AgentComposerSelection['kind']

const START_AS: ReadonlyArray<{ kind: StartAs; label: string; glyph: (className: string) => React.ReactNode }> = [
  { kind: 'conversation', label: 'Conversation', glyph: (className) => <ConversationGlyph className={className} /> },
  { kind: 'general', label: 'Terminal agent', glyph: (className) => <TerminalAgentGlyph className={className} /> },
  { kind: 'terminal', label: 'Terminal', glyph: (className) => <TerminalPromptGlyph className={className} /> },
]

/** What a "Start as" choice is called, for the tag it raises beside the "+". */
export function startAsLabel(kind: StartAs): string {
  return START_AS.find((entry) => entry.kind === kind)!.label
}

/** A "Start as" choice's glyph, for the tag it raises beside the "+". */
export function StartAsGlyph({ kind, className }: { kind: StartAs; className?: string }): React.JSX.Element {
  return <>{START_AS.find((entry) => entry.kind === kind)!.glyph(className ?? 'icon-xs')}</>
}

export type ComposerOptionsProps = {
  startAs: StartAs
  /** The kinds this launch may start as; one that is not offered is not drawn. */
  offered: ReadonlySet<StartAs>
  onStartAs: (kind: StartAs) => void
  /** Attach files; absent where the launch takes none. */
  onAttach?: () => void
  /** Open the skills, plugins and MCP picker; absent where the launch reads none. */
  onSkills?: () => void
  /** How many skills and MCP servers are picked, said on the row. */
  skillsCount: number
  /**
   * The schedule row; absent where scheduling is not offered. `disabled` is the
   * reason it cannot be picked now, said as its hint.
   */
  schedule?: { on: boolean; disabled: string | null; onToggle: () => void }
  /**
   * Ask the open chat a side question that stays out of it; absent where it
   * answers none. `shortcut` is the chord that does the same, said on the row.
   */
  sideQuestion?: { onAsk: () => void; shortcut?: string | null }
  close: () => void
}

/** The menu's rows. The host's Popover is the surface (role="menu") and carries the list class. */
export function ComposerOptions({
  startAs,
  offered,
  onStartAs,
  onAttach,
  onSkills,
  skillsCount,
  schedule,
  sideQuestion,
  close,
}: ComposerOptionsProps): React.JSX.Element {
  const plainShell = startAs === 'terminal'
  const choices = START_AS.filter((entry) => offered.has(entry.kind))
  return (
    // Arrow keys rove every row and tile of this level, the way the kit's menus
    // answer them; Tab leaves.
    <div onKeyDown={(event) => roveMenuFocus(event, event.currentTarget.closest('[role="menu"]'))}>
      {choices.length > 1 ? (
        <div role="group" aria-label="Start as">
          <div className={`${MENU_GROUP_LABEL_CLASS} pb-1 pt-1.5`}>Start as</div>
          <div className="grid grid-cols-3 gap-0.5 px-1 pb-0.5">
            {choices.map((entry) => {
              const checked = entry.kind === startAs
              return (
                <CardButton
                  key={entry.kind}
                  role="menuitemradio"
                  aria-checked={checked}
                  aria-pressed={undefined}
                  selected={checked}
                  data-menu-item="true"
                  data-start-as={entry.kind}
                  tabIndex={-1}
                  onClick={() => {
                    onStartAs(entry.kind)
                    close()
                  }}
                  className={`h-14 items-center justify-center gap-1.5 text-meta font-medium ${
                    checked ? '' : 'text-[color:var(--text-muted)] hover:text-[color:var(--text-strong)]'
                  }`}
                >
                  {entry.glyph('icon-md')}
                  <span>{entry.label}</span>
                </CardButton>
              )
            })}
          </div>
          <div className={MENU_DIVIDER_CLASS} role="separator" />
        </div>
      ) : null}
      {onAttach ? (
        <MenuItem
          icon={<AttachGlyph className="icon-sm shrink-0 text-[color:var(--text-muted)]" />}
          disabled={plainShell}
          onClick={() => {
            close()
            onAttach()
          }}
        >
          Attach files
        </MenuItem>
      ) : null}
      {onSkills ? (
        <MenuItem
          icon={<PluginsGlyph className="icon-sm shrink-0 text-[color:var(--text-muted)]" />}
          disabled={plainShell}
          hint={skillsCount > 0 ? String(skillsCount) : undefined}
          onClick={() => {
            close()
            onSkills()
          }}
        >
          Skills, plugins &amp; MCPs
        </MenuItem>
      ) : null}
      {sideQuestion ? (
        <MenuItem
          icon={<ConversationGlyph className="icon-sm shrink-0 text-[color:var(--text-muted)]" />}
          shortcut={sideQuestion.shortcut ?? undefined}
          data-composer-side-question="true"
          onClick={() => {
            // The menu hands focus back to the "+" as it closes; the drawer
            // takes it from there once it opens.
            close()
            sideQuestion.onAsk()
          }}
        >
          Side question
        </MenuItem>
      ) : null}
      {schedule ? (
        <>
          <div className={MENU_DIVIDER_CLASS} role="separator" />
          <MenuOption
            role="menuitemcheckbox"
            selected={schedule.on}
            stacked={schedule.disabled !== null}
            disabled={schedule.disabled !== null}
            data-menu-item="true"
            data-composer-schedule="true"
            tabIndex={-1}
            icon={
              <ScheduleGlyph
                className={`${schedule.disabled !== null ? 'mt-0.5 ' : ''}icon-sm shrink-0 text-[color:var(--text-muted)]`}
              />
            }
            trailing={
              schedule.on ? (
                <CheckIcon
                  className={`${schedule.disabled !== null ? 'mt-0.5 ' : ''}icon-xs shrink-0 text-[color:var(--accent-primary)]`}
                />
              ) : null
            }
            onClick={() => {
              schedule.onToggle()
              close()
            }}
          >
            <span className="block text-body font-medium">Schedule</span>
            {/* Only why it cannot be picked now: what it does is the row's word. */}
            {schedule.disabled !== null ? (
              <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{schedule.disabled}</span>
            ) : null}
          </MenuOption>
        </>
      ) : null}
      {plainShell ? (
        <p className="px-2.5 pb-1.5 pt-1 text-micro text-[color:var(--text-muted)]">
          A plain shell takes no attachments or options.
        </p>
      ) : null}
    </div>
  )
}
