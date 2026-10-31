import { resolveSnoozePresets, type SnoozePresetId } from '../../../utils/workspaceSnooze'
import { ContextMenu, DescribedMenuItem, MenuDivider, MenuFlyoutItem, StarGlyph } from '../../ui'

// The menu a right-click on a selection of several chats opens
// (sidebarBulkSelection.ts): the marks and rest a chat's own menu offers that
// mean the same for many at once. What only makes sense for one chat (Open,
// Rename, Reveal, New chat in project) is left to that chat's own menu.
//
// Each item says how many of the selection it reaches, since some chats in it
// may not take it: one still working is not settled or snoozed, one that is
// not a conversation has no title to regenerate.

export type BulkChatAction =
  'settle' | `snooze:${SnoozePresetId}` | 'regenerate-titles' | 'mark-unread' | 'star' | 'unstar'

/** How many of the selection each item reaches. */
export type BulkChatReach = {
  selected: number
  /** Not settled, and not working. */
  settle: number
  /** Awake, may sleep, and not working. */
  snooze: number
  regenerateTitle: number
  markUnread: number
  starred: number
}

function reachHint(reached: number, selected: number): string | undefined {
  return reached === selected ? undefined : `${reached} of ${selected}`
}

const chats = (count: number) => `${count} ${count === 1 ? 'chat' : 'chats'}`

export function BulkChatContextMenu({
  x,
  y,
  reach,
  onClose,
  onSelect,
}: {
  x: number
  y: number
  reach: BulkChatReach
  onClose: () => void
  onSelect: (action: BulkChatAction) => void
}) {
  const { selected } = reach
  const allStarred = reach.starred === selected
  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Actions for ${chats(selected)}`}
      onClose={onClose}
      surfaceClassName="min-w-[240px]"
    >
      <DescribedMenuItem
        tooltip={`${allStarred ? 'Unstar' : 'Star'} ${chats(selected)}.`}
        onClick={() => onSelect(allStarred ? 'unstar' : 'star')}
        icon={
          <StarGlyph
            filled={allStarred}
            stroked
            className={`icon-sm shrink-0 ${allStarred ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-disabled)]'}`}
          />
        }
      >
        {allStarred ? 'Unstar' : 'Star'}
      </DescribedMenuItem>
      <DescribedMenuItem
        disabled={reach.markUnread === 0}
        hint={reachHint(reach.markUnread, selected)}
        tooltip="Mark the chats whose agents have finished something as unread, on every device."
        onClick={() => onSelect('mark-unread')}
      >
        Mark unread
      </DescribedMenuItem>
      <DescribedMenuItem
        disabled={reach.regenerateTitle === 0}
        hint={reachHint(reach.regenerateTitle, selected)}
        tooltip="Write each chat's title again from what was said in it."
        onClick={() => onSelect('regenerate-titles')}
      >
        Regenerate titles
      </DescribedMenuItem>
      <MenuDivider />
      <DescribedMenuItem
        disabled={reach.settle === 0}
        hint={reachHint(reach.settle, selected)}
        tooltip="Put the chats away: their agents stop. A chat still working is left as it is."
        onClick={() => onSelect('settle')}
      >
        Settle
      </DescribedMenuItem>
      <MenuFlyoutItem
        label="Snooze"
        ariaLabel={`Snooze ${chats(selected)}`}
        disabled={reach.snooze === 0}
        hint={reachHint(reach.snooze, selected)}
        tooltip="Hide the chats from the list until a time. A chat still working is left as it is."
      >
        {resolveSnoozePresets(Date.now()).map((preset) => (
          <DescribedMenuItem
            key={preset.id}
            hint={preset.whenLabel}
            tooltip={`Snooze until ${preset.label.toLowerCase()}, ${preset.whenLabel}.`}
            onClick={() => onSelect(`snooze:${preset.id}`)}
          >
            {preset.label}
          </DescribedMenuItem>
        ))}
      </MenuFlyoutItem>
    </ContextMenu>
  )
}
