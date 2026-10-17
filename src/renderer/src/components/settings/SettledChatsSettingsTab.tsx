import React, { useCallback, useState } from 'react'

import type { WorkspaceId } from '../../types/workspace'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { showToast } from '../../store/toastStore'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { EmptyState, GhostButton, OutlineButton } from '../ui'
import { SettingCard, SettingToggle, SettingsPageHeader } from './SettingsAtoms'
import { createSettledChatsSelector, type SettledChatEntry } from './settledChatsModel'
import { useStableCallback } from '../../hooks/useStableCallback'

const SETTLED_PAGE = 100

/**
 * Settings ▸ Settled chats (owner, 2026-09-28): where a chat goes once it has
 * come to rest. The sidebar used to fold these into a Settled shelf under
 * every project; that was one more line to read past for chats the person had
 * already called finished, so the rail stopped drawing them and this page
 * holds them instead.
 *
 * Two things to do with one, both the ones the shelf offered: Open reads it
 * (and, as opening any settled chat does, leaves it settled — reading is not
 * activity), and Un-settle puts it back in its project's list.
 */
export function SettledChatsSettingsTab({
  onOpenChat,
}: {
  /** Leave Settings for this chat. */
  onOpenChat: (id: WorkspaceId) => void
}): React.JSX.Element {
  const moduleOverrides = useWorkspaceStore((s) => s.appSettings.modules)
  const setWorkspaceSettled = useWorkspaceStore((s) => s.setWorkspaceSettled)
  const settleOnMerge = useWorkspaceStore((s) => s.appSettings.settleOnPullRequestMerge)
  const setSettleOnMerge = useWorkspaceStore((s) => s.setSettleOnPullRequestMerge)
  // One clock for the visit: "settled 3d ago" does not need to tick while the
  // page is open, and a timer here would re-render the list for nothing.
  const [now] = useState(() => Date.now())
  // The settled chats alone, not the whole registry: the list is the same
  // array until one of them moves, so a background agent's write elsewhere
  // re-renders nothing here.
  const [selectSettledChats] = useState(createSettledChatsSelector)
  const chats = useWorkspaceStore((s) => selectSettledChats(s.workspaces, moduleOverrides))
  // Hundreds of chats settle on a long-lived profile; the page draws the most
  // recent and folds the rest.
  const [shown, setShown] = useState(SETTLED_PAGE)
  // A chat opened here from a paired machine rests over there: that machine
  // is asked to bring it back, so every device lists it again, and it comes
  // back here once it has said yes. A machine that keeps no rest has nothing
  // to ask.
  const unsettle = useCallback(
    (id: WorkspaceId) => {
      const origin = useWorkspaceStore.getState().workspaces.find((workspace) => workspace.id === id)?.remoteOrigin
      const settle = window.api?.meshSettleConversation
      if (!origin || typeof settle !== 'function') {
        setWorkspaceSettled(id, false)
        return
      }
      const refused = (message: string) =>
        showToast({ tone: 'error', title: 'The chat was not brought back', description: message })
      void settle({ connectionId: origin.connectionId, workspaceId: origin.workspaceId, settled: false })
        .then((answer) => {
          if (answer.ok || answer.code === 'lifecycle_unsupported') setWorkspaceSettled(id, false)
          else refused(answer.message)
        })
        .catch((error: unknown) => refused(error instanceof Error ? error.message : String(error)))
    },
    [setWorkspaceSettled],
  )
  const open = useStableCallback(onOpenChat)
  const remaining = chats.length - shown

  return (
    <div role="tabpanel" id="settings-panel-settled-chats" aria-labelledby="settings-tab-settled-chats">
      <SettingsPageHeader title="Settled chats" meta={chats.length > 0 ? `${chats.length}` : undefined} />
      <SettingCard className="mb-5">
        <SettingToggle
          label="Settle when its pull requests merge"
          description="For chats with Auto-settle switched on from their menu: once every pull request is merged or closed, and at least one merged, the chat settles. Not if you wrote to it after the merge, and never while an agent in it is working. A settled chat's worktree is removed once its work is merged and clean, and checked out again from its branch when you come back."
          enabled={settleOnMerge}
          onChange={setSettleOnMerge}
        />
      </SettingCard>
      {chats.length === 0 ? (
        <EmptyState
          density="list"
          title="No settled chats."
          body="A chat settles when you settle it from its menu. Switch on Auto-settle there and it also settles after three days without activity, or when its pull requests merge."
        />
      ) : (
        <SettingCard as="ul" ariaLabel="Settled chats">
          {chats.slice(0, shown).map((chat) => (
            <SettledChatRow key={chat.id} chat={chat} now={now} onUnsettle={unsettle} onOpen={open} />
          ))}
        </SettingCard>
      )}
      {remaining > 0 ? (
        <div className="mt-2 flex justify-center">
          <GhostButton size="xs" onClick={() => setShown((count) => count + SETTLED_PAGE)}>
            Show {Math.min(SETTLED_PAGE, remaining)} more
          </GhostButton>
        </div>
      ) : null}
    </div>
  )
}

const SettledChatRow = React.memo(function SettledChatRow({
  chat,
  now,
  onUnsettle,
  onOpen,
}: {
  chat: SettledChatEntry
  now: number
  onUnsettle: (id: WorkspaceId) => void
  onOpen: (id: WorkspaceId) => void
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium text-[color:var(--text-strong)]" title={chat.title}>
          {chat.title}
        </div>
        <div className="truncate text-meta text-[color:var(--text-subtle)]">
          {chat.project} · Settled {formatRelativeMsAgo(chat.settledAt, now)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {/* The visible word leads the accessible name, and the chat
            follows it, so a list of these is not a list of identical
            buttons. */}
        <GhostButton size="xs" aria-label={`Un-settle ${chat.title}`} onClick={() => onUnsettle(chat.id)}>
          Un-settle
        </GhostButton>
        <OutlineButton size="xs" aria-label={`Open ${chat.title}`} onClick={() => onOpen(chat.id)}>
          Open
        </OutlineButton>
      </div>
    </li>
  )
})
