import React from 'react'

import { FilterMenu, Tooltip } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { selectChatListView, type ChatListView } from '../../../store/slices/settingsSlice'

const CHAT_LIST_VIEW_ITEMS: ReadonlyArray<{ value: ChatListView; label: string }> = [
  { value: 'projects', label: 'By project' },
  { value: 'status', label: 'By status' },
  { value: 'all', label: 'All chats' },
]

/**
 * How this window groups its chats: by project, by status, or all together
 * (owner request 2026-11-02). It sits on New chat's row beside the scheduled
 * clock. The pick is this window's and lasts until it closes; Settings ▸
 * Appearance sets the shape every window opens in. The glyph tints while the
 * window is off that default, so a list grouped another way never passes for
 * the usual one.
 *
 * Its own component, reading the store itself, so the sidebar's every render
 * (a chat switch, an agent's tick) does not re-render the menu with it.
 */
export const ChatListGroupingMenu = React.memo(function ChatListGroupingMenu() {
  const view = useWorkspaceStore(selectChatListView)
  const defaultView = useWorkspaceStore((s) => s.chatListView)
  const setOverride = useWorkspaceStore((s) => s.setChatListViewOverride)
  return (
    <Tooltip content="Group chats" placement="right">
      <FilterMenu
        ariaLabel="Group chats"
        size="md"
        className="shrink-0"
        groups={[
          {
            label: 'Group chats',
            items: CHAT_LIST_VIEW_ITEMS,
            value: view,
            defaultValue: defaultView,
            onChange: (value) => setOverride(value as ChatListView),
          },
        ]}
      />
    </Tooltip>
  )
})
