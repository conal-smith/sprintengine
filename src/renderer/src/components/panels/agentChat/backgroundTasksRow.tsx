// What the chat's process still runs after its turn ended, as one row of the
// composer tray: "Waiting on monitor: CI checks", "Running: npm run dev". A
// monitor wakes the agent when it has something to say, so the chat is not
// done and the row wears the working mark; a shell the agent left running
// (a dev server) is not work it will come back to, so that row is quiet and
// wears the command mark the transcript draws for a shell step. Stop ends
// all of it: the chat's Stop between turns, for what the turn left running.
//
// A task's name is often the whole shell line the agent ran, and several of
// them wrapped in full can fill the tray to the top of the transcript. So the
// row keeps to one line until its chevron opens it, as the checklist strip
// beside it does, and opened lists one task a line; whether it is open is kept
// per chat.

import type { JSX } from 'react'
import type { ConversationBackgroundTask } from '../../../../../shared/conversation-runtime'
import { backgroundTasksWakeAgent, describeBackgroundTasks } from '../../../../../shared/conversation/backgroundTasks'
import { IconButton, OutlineButton, Tooltip, WorkingMark } from '../../ui'
import { ChevronRightGlyph, ToolKindGlyph } from './toolRows/ToolKindGlyph'
import { ComposerTrayRow } from './composerTray'
import { useConversationLinkContext } from './conversationLinks'
import { useConversationDisclosure } from './conversationViewState'

export function BackgroundTasksTrayRow({
  tasks,
  seed,
  onStop,
  stopping = false,
}: {
  tasks: readonly ConversationBackgroundTask[]
  /** The chat's id: what picks its working mark's pattern. */
  seed: string
  /** Absent where the view cannot operate the chat. */
  onStop?: () => void
  /** A stop was asked for and the chat has not answered yet. */
  stopping?: boolean
}): JSX.Element | null {
  const context = useConversationLinkContext()
  const [open, setOpen] = useConversationDisclosure(
    `${context?.workspaceId ?? ''}:${context?.agentId ?? ''}`,
    'background-tasks',
    false,
  )
  const line = describeBackgroundTasks(tasks)
  if (!line) return null
  const waiting = backgroundTasksWakeAgent(tasks)
  // One task is named in the line itself; several are counted there and
  // named after it.
  const names = tasks.length > 1 ? tasks.flatMap((task) => (task.description ? [task.description] : [])) : []
  const toggle = open ? 'Show less' : 'Show all'
  return (
    <ComposerTrayRow
      actions={
        <>
          <Tooltip content={toggle}>
            <IconButton size="xs" aria-label={toggle} aria-expanded={open} onClick={() => setOpen(!open)}>
              <ChevronRightGlyph className={`icon-xs transition-transform ${open ? 'rotate-90' : ''}`} />
            </IconButton>
          </Tooltip>
          {onStop ? (
            <OutlineButton size="xs" onClick={onStop} disabled={stopping}>
              {stopping ? 'Stopping…' : 'Stop'}
            </OutlineButton>
          ) : null}
        </>
      }
      glyph={
        waiting ? (
          <WorkingMark label="Waiting on background work" seed={seed} />
        ) : (
          <ToolKindGlyph kind="command" className="icon-sm shrink-0 text-[color:var(--text-subtle)]" />
        )
      }
    >
      <div className={open ? 'break-words' : 'truncate'}>
        <span className={waiting ? undefined : 'text-[color:var(--text-muted)]'}>{line}</span>
        {names.length > 0 && !open ? (
          <span className="text-[color:var(--text-muted)]"> · {names.join(', ')}</span>
        ) : null}
      </div>
      {open && names.length > 0 ? (
        <ul className="mt-1 flex max-h-48 flex-col gap-1 overflow-y-auto pr-1 text-meta leading-5 text-[color:var(--text-muted)]">
          {names.map((name, index) => (
            <li key={index} className="break-words">
              {name}
            </li>
          ))}
        </ul>
      ) : null}
    </ComposerTrayRow>
  )
}
