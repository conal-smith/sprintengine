import React, { useCallback, useEffect, useState } from 'react'

import type { WorkspaceId } from '../../types/workspace'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { showToast } from '../../store/toastStore'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import { Checkbox, EmptyState, GhostButton, Input, OutlineButton, Tooltip } from '../ui'
import { DangerButton } from '../ui/Buttons'
import { SettingCard, SettingToggle, SettingsPageHeader, SettingsRow } from './SettingsAtoms'
import { isImeKey } from '../../utils/imeKey'
import {
  MAX_AUTO_SETTLE_AFTER_DAYS,
  MIN_AUTO_SETTLE_AFTER_DAYS,
  normalizeAutoSettleAfterDays,
} from '../../utils/workspaceSettle'
import { createSettledChatsSelector, type SettledChatEntry } from './settledChatsModel'
import { remoteOriginChatWorkspaceId } from '../workspace/remoteBand/remoteSessionsModel'
import { useStableCallback } from '../../hooks/useStableCallback'
import { useDeleteSettledChats } from '../../hooks/useDeleteSettledChats'

const SETTLED_PAGE = 100

/**
 * Settings ▸ Settled chats (owner, 2026-09-28): where a chat goes once it has
 * come to rest. The sidebar used to fold these into a Settled shelf under
 * every project; that was one more line to read past for chats the person had
 * already called finished, so the rail stopped drawing them and this page
 * holds them instead.
 *
 * Three things to do with one: Open reads it (and, as opening any settled
 * chat does, leaves it settled — reading is not activity), Un-settle puts it
 * back in its project's list, and Delete is rid of it for good, with its
 * history and the worktree it owns (`useDeleteSettledChats`). Delete is a
 * button on the row, not hidden in a right-click menu, and the boxes beside
 * the rows delete many at once: a long-lived profile settles hundreds, and
 * clearing them one confirmation at a time is no way to do it. Select all
 * takes every settled chat, the ones folded under "Show more" included, and
 * the confirmation counts them.
 */
/**
 * How many quiet days settle a chat with Auto-settle on. Typed, and kept on
 * leaving the field or Enter; a blank entry goes back to what is kept, and an
 * out-of-range one to the nearest day in range.
 */
function AutoSettleDaysRow() {
  const days = normalizeAutoSettleAfterDays(useWorkspaceStore((s) => s.appSettings.autoSettleAfterDays))
  const setDays = useWorkspaceStore((s) => s.setAutoSettleAfterDays)
  const [draft, setDraft] = useState(String(days))
  useEffect(() => setDraft(String(days)), [days])
  const commit = () => {
    const parsed = draft.trim() === '' ? NaN : Number(draft)
    const next = Number.isFinite(parsed) ? normalizeAutoSettleAfterDays(parsed) : days
    setDays(next)
    setDraft(String(next))
  }
  return (
    <SettingsRow
      label="Settle after quiet days"
      help={`For chats with Auto-settle switched on from their menu: how many days without activity settle one, from ${MIN_AUTO_SETTLE_AFTER_DAYS} to ${MAX_AUTO_SETTLE_AFTER_DAYS}.`}
      htmlFor="auto-settle-after-days"
    >
      <Input
        id="auto-settle-after-days"
        type="number"
        inputMode="numeric"
        min={MIN_AUTO_SETTLE_AFTER_DAYS}
        max={MAX_AUTO_SETTLE_AFTER_DAYS}
        step={1}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (isImeKey(event)) return
          if (event.key === 'Enter') event.currentTarget.blur()
        }}
        size="md"
        variant="well"
        fullWidth={false}
        className="w-20 text-right tabular-nums"
      />
    </SettingsRow>
  )
}

const quietDays = (days: number): string => (days === 1 ? 'a day' : `${days} days`)

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
  const keepWithOpenPr = useWorkspaceStore((s) => s.appSettings.keepChatsWithOpenPullRequest)
  const setKeepWithOpenPr = useWorkspaceStore((s) => s.setKeepChatsWithOpenPullRequest)
  const autoSettleDays = normalizeAutoSettleAfterDays(useWorkspaceStore((s) => s.appSettings.autoSettleAfterDays))
  const autoCompact = useWorkspaceStore((s) => s.appSettings.autoCompactChats)
  const setAutoCompact = useWorkspaceStore((s) => s.setAutoCompactChats)
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
      void settle({
        connectionId: origin.connectionId,
        workspaceId: remoteOriginChatWorkspaceId(origin),
        settled: false,
      })
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
  const { deleteChats, deleting } = useDeleteSettledChats()
  const [selected, setSelected] = useState<ReadonlySet<WorkspaceId>>(new Set())
  // A chat that left the list (deleted, un-settled, deleted elsewhere) leaves the selection.
  const selectedIds = chats.filter((chat) => selected.has(chat.id)).map((chat) => chat.id)
  const allSelected = chats.length > 0 && selectedIds.length === chats.length
  const toggleSelected = useCallback((id: WorkspaceId) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const remove = useCallback(
    async (ids: readonly WorkspaceId[]) => {
      const gone = await deleteChats(ids)
      if (gone.length > 0) setSelected((current) => new Set([...current].filter((id) => !gone.includes(id))))
    },
    [deleteChats],
  )
  const removeOne = useCallback((id: WorkspaceId) => void remove([id]), [remove])

  return (
    <div role="tabpanel" id="settings-panel-settled-chats" aria-labelledby="settings-tab-settled-chats">
      <SettingsPageHeader title="Settled chats" meta={chats.length > 0 ? `${chats.length}` : undefined} />
      <SettingCard className="mb-5">
        <AutoSettleDaysRow />
        <SettingToggle
          label="Settle when its pull requests merge"
          description="For chats with Auto-settle switched on from their menu: once every pull request is merged or closed, and at least one merged, the chat settles. Not if you wrote to it after the merge, and never while an agent in it is working. A settled chat's worktree is removed once its work is merged and clean, and checked out again from its branch when you come back."
          enabled={settleOnMerge}
          onChange={setSettleOnMerge}
        />
        <SettingToggle
          label="Keep chats with an open pull request"
          description={`For chats with Auto-settle switched on from their menu: a chat whose pull request is still open, waiting on review or still a draft, does not settle after ${quietDays(autoSettleDays)} without activity. Settling when its pull requests merge is the setting above.`}
          enabled={keepWithOpenPr}
          onChange={setKeepWithOpenPr}
        />
        <SettingToggle
          label="Auto compact idle chats"
          description="For Claude chats that leave Auto compact to this default in their menu: a chat holding at least 100k tokens compacts by itself while it sits idle, just before its prompt cache expires, so coming back later doesn't re-read all of it at the uncached price. Your visible history stays as it is; a divider marks where it compacted."
          enabled={autoCompact}
          onChange={setAutoCompact}
        />
      </SettingCard>
      {chats.length === 0 ? (
        <EmptyState
          density="list"
          title="No settled chats."
          body={`A chat settles when you settle it from its menu. Switch on Auto-settle there and it also settles after ${quietDays(autoSettleDays)} without activity, or when its pull requests merge.`}
        />
      ) : (
        <>
          <div className="mb-2 flex items-center gap-3 px-4">
            <Checkbox
              checked={allSelected}
              indeterminate={selectedIds.length > 0 && !allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(chats.map((chat) => chat.id)))}
              label={allSelected ? `All ${chats.length} selected` : 'Select all'}
            />
          </div>
          <SettingCard as="ul" ariaLabel="Settled chats">
            {chats.slice(0, shown).map((chat) => (
              <SettledChatRow
                key={chat.id}
                chat={chat}
                now={now}
                selected={selected.has(chat.id)}
                busy={deleting.has(chat.id)}
                onToggleSelected={toggleSelected}
                onUnsettle={unsettle}
                onOpen={open}
                onDelete={removeOne}
              />
            ))}
          </SettingCard>
        </>
      )}
      {remaining > 0 ? (
        <div className="mt-2 flex justify-center">
          <GhostButton size="xs" onClick={() => setShown((count) => count + SETTLED_PAGE)}>
            Show {Math.min(SETTLED_PAGE, remaining)} more
          </GhostButton>
        </div>
      ) : null}
      {selectedIds.length > 0 ? (
        <div className="sticky bottom-0 mt-4 flex items-center gap-3 rounded-[var(--radius-shell)] border border-[color:var(--border-strong)] bg-[color:var(--bg-surface-raised)] px-4 py-2.5">
          <span className="text-body font-medium text-[color:var(--text-strong)]">{selectedIds.length} selected</span>
          <span className="flex-1" />
          <GhostButton size="xs" onClick={() => setSelected(new Set())}>
            Clear selection
          </GhostButton>
          <Tooltip
            multiline
            content="Deletes the selected chats and their history for good. Each one's worktree is removed or goes back to the pool unless it has uncommitted changes, and branches are kept. You confirm first."
          >
            <DangerButton
              size="xs"
              disabled={selectedIds.some((id) => deleting.has(id))}
              onClick={() => void remove(selectedIds)}
            >
              Delete {selectedIds.length === 1 ? '1 chat' : `${selectedIds.length} chats`}
            </DangerButton>
          </Tooltip>
        </div>
      ) : null}
    </div>
  )
}

/** What a row's Delete says it does, on hover and keyboard focus. */
export function settledChatDeleteTooltip(remoteMachine: string | null): string {
  return remoteMachine
    ? `Removes this chat from this computer only. The chat, its history and its worktree stay on ${remoteMachine}, where it can be deleted. You confirm first.`
    : 'Deletes this chat and its history for good. Its worktree is removed or goes back to the pool unless it has uncommitted changes, and its branch is kept. You confirm first.'
}

const SettledChatRow = React.memo(function SettledChatRow({
  chat,
  now,
  selected,
  busy,
  onToggleSelected,
  onUnsettle,
  onOpen,
  onDelete,
}: {
  chat: SettledChatEntry
  now: number
  selected: boolean
  /** Being deleted now. */
  busy: boolean
  onToggleSelected: (id: WorkspaceId) => void
  onUnsettle: (id: WorkspaceId) => void
  onOpen: (id: WorkspaceId) => void
  onDelete: (id: WorkspaceId) => void
}) {
  const removeWord = chat.remoteMachine ? 'Remove' : 'Delete'
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Checkbox
        checked={selected}
        onChange={() => onToggleSelected(chat.id)}
        ariaLabel={`Select ${chat.title}`}
        disabled={busy}
      />
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
        <Tooltip multiline content={settledChatDeleteTooltip(chat.remoteMachine)}>
          <GhostButton
            size="xs"
            tone="danger"
            busy={busy}
            disabled={busy}
            aria-label={`${removeWord} ${chat.title}`}
            onClick={() => onDelete(chat.id)}
          >
            {removeWord}
          </GhostButton>
        </Tooltip>
      </div>
    </li>
  )
})
