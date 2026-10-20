import { MenuDivider, MenuFlyoutItem, MenuItem } from '../ui'
import type { ChatExportAction } from '../../../../shared/chat-export'
import { CHAT_EXPORT_EMPTY_REASON, CHAT_EXPORT_MENU, exportChatOrToast } from '../panels/agentChat/chatExport'

// A chat tab's Export chat row: a flyout of the ways to take the whole
// conversation away, the two copies first (the quick one, for an email) and
// the three files under them. Off, saying why, while the chat has no message.

export function ChatExportMenuItems({
  workspaceId,
  agentId,
  empty,
  onDone,
}: {
  workspaceId: string
  agentId: string
  /** The chat has no message yet, so there is nothing to export. */
  empty: boolean
  onDone: () => void
}) {
  const run = (action: ChatExportAction) => {
    onDone()
    void exportChatOrToast({ workspaceId, agentId, action })
  }
  const copies = CHAT_EXPORT_MENU.filter((row) => row.action === 'copy' || row.action === 'copy-markdown')
  const files = CHAT_EXPORT_MENU.filter((row) => !copies.includes(row))
  return (
    <MenuFlyoutItem
      label="Export chat"
      ariaLabel="Export chat"
      disabled={empty}
      hint={empty ? CHAT_EXPORT_EMPTY_REASON : undefined}
      surfaceClassName="min-w-[196px]"
    >
      {copies.map((row) => (
        <MenuItem key={row.action} onClick={() => run(row.action)}>
          {row.label}
        </MenuItem>
      ))}
      <MenuDivider />
      {files.map((row) => (
        <MenuItem key={row.action} onClick={() => run(row.action)}>
          {row.label}
        </MenuItem>
      ))}
    </MenuFlyoutItem>
  )
}
