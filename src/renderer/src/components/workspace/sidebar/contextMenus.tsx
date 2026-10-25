// The sidebar's right-click menus for a workspace row, a paired machine's chat
// row, and a folder header.

import type { ReactNode } from 'react'
import { type Workspace, type HighlightColor } from '../../../types/workspace'
import { resolveEnabledWorkspaceType } from '../../AppIcons'
import type { WorkspaceTypeRowAction } from '../../../modules/renderer-host'
import {
  type SnoozePresetId,
  isSnoozedWorkspace,
  canSnoozeWorkspace,
  resolveSnoozePresets,
} from '../../../utils/workspaceSnooze'
import { newChatProjectTarget, type FolderGroup } from './folderGroups'
import { isStarred } from '../../../utils/highlight'
import { isSettledWorkspace } from '../../../utils/workspaceSettle'
import {
  ContextMenu,
  MenuItem,
  DescribedMenuItem,
  MenuDivider,
  StarGlyph,
  MenuFlyoutItem,
  MenuSwatchRow,
  ProjectColorSwatchRow,
  SwitchGlyph,
} from '../../ui'
import { type ProjectColorSetting, type ProjectColor } from '../../../utils/projectColor'
import { chatLinkFor } from '../../../../../shared/deep-link'
import { isProjectlessChatsRoot } from '../../../../../shared/projectless-chats'
import { clientSupports } from '../../../clientCapabilities'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import { chatMenuTooltips as tips, type ChatMenuPlace } from './chatMenuTooltips'
import type { MeshConversationManage } from '../../../../../shared/tailnet-mesh'

export function sidebarWorkspaceOf(workspace: Workspace): {
  id: string
  name: string
  mode: Workspace['mode']
  moduleState: Workspace['moduleState']
} {
  return {
    id: workspace.id,
    name: workspace.name,
    mode: workspace.mode,
    moduleState: workspace.moduleState,
  }
}

export function workspaceTypeRowActions(
  workspace: Workspace,
  moduleOverrides: Parameters<typeof resolveEnabledWorkspaceType>[1],
): WorkspaceTypeRowAction[] {
  const type = resolveEnabledWorkspaceType(workspace.mode, moduleOverrides)
  const row = sidebarWorkspaceOf(workspace)
  return (type?.rowActions ?? []).filter((action) => action.isVisible?.(row) !== false)
}

/**
 * A chat row's Auto compact switch: on by its own choice, or by the app-wide
 * default where it left that unset; and whether its chat is Claude's, the one
 * it works on yet. Null for a row with no chat in it, or a paired machine's,
 * whose switch is that machine's (`RemoteConversation.autoCompact`).
 */
export function autoCompactSwitchOf(
  workspace: Workspace,
  enabledByDefault: boolean,
): { on: boolean; claude: boolean } | null {
  if (workspace.remoteOrigin) return null
  const chats = Object.values(workspace.agents ?? {}).filter(
    (agent) => agent.runtimeKind === 'conversation' && agent.conversation,
  )
  if (chats.length === 0) return null
  return {
    on: workspace.autoCompactEnabled ?? enabledByDefault,
    claude: chats.some((agent) => cliForConversationProvider(agent.conversation!.providerId) === 'claude-code'),
  }
}

/** What the rest-and-marks half of a chat's menu dispatches, on a row here or a paired machine's. */
export type ChatMarkAction =
  | 'toggle-star'
  | 'toggle-settle'
  | 'toggle-auto-settle'
  // Snooze presets dispatch as `snooze:<presetId>` so the union stays closed
  // while the list of wake times remains data: a new wake time is a row in the
  // preset table, not a new member of this union.
  | `snooze:${SnoozePresetId}`
  | 'wake'
  | 'clear-color'

/** A change to a chat's marks or sleep, as opposed to its rest: what a paired machine's `chat-row-menu` takes. */
export type ChatMarkChange = Exclude<ChatMarkAction, 'toggle-settle'>

export function isChatMarkChange(action: string): action is ChatMarkChange {
  return (
    action === 'toggle-star' ||
    action === 'toggle-auto-settle' ||
    action === 'wake' ||
    action === 'clear-color' ||
    action.startsWith('snooze:')
  )
}

export type ContextMenuAction =
  | 'open'
  | 'mark-unread'
  | 'stop-watching'
  | 'rename'
  | 'new-chat'
  | 'reveal'
  | 'copy-link'
  | 'move-to-new-window'
  | 'move-to-main-window'
  | ChatMarkAction
  | 'toggle-auto-compact'
  | 'toggle-schedule-pause'
  | 'delete-settled'
  | `type-action:${string}`

/**
 * A chat menu's row: `DescribedMenuItem`, whose `tooltip` is required, so no
 * item of a chat's menu can be added without saying what it does
 * (`chatMenuTooltips`).
 */
const ChatMenuItem = DescribedMenuItem

/**
 * A chat's rest and its marks, the half of its menu below the divider: Star,
 * then whatever the row adds (`between`), Settle, Snooze, Auto-settle and the
 * highlight swatches. One component for a row here and a paired machine's,
 * so the two menus cannot drift apart.
 */
function ChatRestAndMarkItems({
  where,
  starred,
  color,
  settle,
  working,
  snooze,
  autoSettle,
  autoCompact = null,
  between = null,
  onSelect,
  onPickColor,
}: {
  /** Whose the chat is, which its items' tooltips say (`ChatMenuPlace`). */
  where: ChatMenuPlace
  starred: boolean
  color: HighlightColor | null
  /** Settle, Un-settle, or neither where the chat's rest cannot be asked for. */
  settle: 'settle' | 'unsettle' | null
  /** An agent in the chat is still working, so Settle and Snooze wait. */
  working: boolean
  /**
   * Wake now on a sleeping chat; the Snooze presets where it may sleep,
   * disabled while it may not yet; null for neither.
   */
  snooze: 'wake' | { disabled: boolean } | null
  /** The Auto-settle switch's state; null leaves it off the menu. */
  autoSettle: boolean | null
  /**
   * The Auto compact switch: whether it is on for this chat (its own choice,
   * or the app-wide default), and whether the chat is Claude's, the only one
   * it works on yet. Null leaves it off the menu: a row with no chat in it,
   * or a paired machine's chat where that machine does not take the switch
   * from here.
   */
  autoCompact?: { on: boolean; claude: boolean } | null
  between?: ReactNode
  onSelect: (action: ChatMarkAction | 'toggle-auto-compact') => void
  onPickColor: (color: HighlightColor) => void
}) {
  return (
    <>
      <ChatMenuItem
        checked={starred}
        tooltip={tips.star(starred, where)}
        onClick={() => onSelect('toggle-star')}
        icon={
          <StarGlyph
            filled={starred}
            stroked
            className={`icon-sm shrink-0 ${starred ? 'text-[color:var(--tone-warn)]' : 'text-[color:var(--text-disabled)]'}`}
          />
        }
      >
        {starred ? 'Unstar' : 'Star'}
      </ChatMenuItem>
      {between}
      {/* Rest by hand (settled-chats, 2026-09-07). Un-settle also holds the
          row out of the sweep until it sees new activity. Settling ends the
          chat's agents, and their work with them: it waits until they finish. */}
      {settle === 'unsettle' ? (
        <ChatMenuItem tooltip={tips.unsettle()} onClick={() => onSelect('toggle-settle')}>
          Un-settle
        </ChatMenuItem>
      ) : settle === 'settle' ? (
        <ChatMenuItem
          disabled={working}
          hint={working ? 'Working' : undefined}
          tooltip={tips.settle(working, where)}
          onClick={() => onSelect('toggle-settle')}
        >
          Settle
        </ChatMenuItem>
      ) : null}
      {/* Sleep by hand (snooze, 2026-09-10), beneath Settle because it is the
          softer of the two: Settle says the work is done, Snooze says only
          "not now". Resolved against the clock at OPEN time so the wake times
          on the rows are the ones the click will actually land on.

          Hidden entirely — rather than disabled — where the chat has nowhere
          to sleep (a settled row): a permanently dead entry is worse than no
          entry. Disabled, not hidden, when the agent is working: that one is
          temporary and the reason is worth showing. */}
      {snooze === 'wake' ? (
        <ChatMenuItem tooltip={tips.wake(where)} onClick={() => onSelect('wake')}>
          Wake now
        </ChatMenuItem>
      ) : snooze ? (
        <MenuFlyoutItem
          label="Snooze"
          ariaLabel="Snooze chat"
          disabled={snooze.disabled || working}
          hint={working ? 'Working' : undefined}
          tooltip={tips.snooze(working, where)}
        >
          {resolveSnoozePresets(Date.now()).map((preset) => (
            <ChatMenuItem
              key={preset.id}
              hint={preset.whenLabel}
              tooltip={tips.snoozeUntil(preset.label, preset.whenLabel)}
              onClick={() => onSelect(`snooze:${preset.id}`)}
            >
              {preset.label}
            </ChatMenuItem>
          ))}
        </MenuFlyoutItem>
      ) : null}
      {/* Whether this chat settles by itself: after three quiet days, or when
          its pull requests land. Off unless switched on here. A standing
          setting, so a switch row that stays open to show it flip, like Star. */}
      {autoSettle !== null ? (
        <ChatMenuItem
          checked={autoSettle}
          trailing={<SwitchGlyph checked={autoSettle} />}
          tooltip={tips.autoSettle(where)}
          onClick={() => onSelect('toggle-auto-settle')}
        >
          Auto-settle
        </ChatMenuItem>
      ) : null}
      {/* Whether Studio compacts the chat by itself before its prompt cache
          expires. Beside Auto-settle, as the other standing rule about what
          happens to an idle chat, and a switch the same way. Off, and said
          why, for a chat that is not Claude's. */}
      {autoCompact ? (
        <ChatMenuItem
          checked={autoCompact.claude && autoCompact.on}
          disabled={!autoCompact.claude}
          hint={autoCompact.claude ? undefined : 'Claude only'}
          trailing={<SwitchGlyph checked={autoCompact.claude && autoCompact.on} />}
          tooltip={tips.autoCompact(autoCompact.claude, where)}
          onClick={() => onSelect('toggle-auto-compact')}
        >
          Auto compact
        </ChatMenuItem>
      ) : null}
      <MenuSwatchRow
        label="Highlight color"
        value={color}
        onPick={onPickColor}
        onClear={() => onSelect('clear-color')}
        swatchTooltip={(swatch) => tips.highlight(swatch, where)}
      />
    </>
  )
}

// Workspace-row context menu. Generic menu chrome (surface, clamped
// positioning, items, dividers, swatch row, dismissal, focus handling) lives
// in the ui/ContextMenu primitive; only the sidebar's actions stay here.
export function WorkspaceContextMenu({
  x,
  y,
  workspace,
  moduleOverrides,
  isDetachedWindow,
  now,
  working,
  remoteMarks = false,
  remoteManage,
  remoteNewChat = false,
  autoCompact = null,
  canMarkUnread = false,
  watchedPullRequestNumber = null,
  schedule = null,
  canDelete = false,
  remoteDelete = false,
  onClose,
  onSelect,
  onPickColor,
}: {
  x: number
  y: number
  workspace: Workspace | null
  moduleOverrides: Parameters<typeof resolveEnabledWorkspaceType>[1]
  isDetachedWindow: boolean
  /** An agent in the chat is still working, so Settle and Snooze wait (`workspaceIsWorking`). */
  working: boolean
  /** The clock the wake times and the asleep/awake reading are resolved against. */
  now: number
  /**
   * A row born on a paired machine whose machine takes the row menu's marks
   * (`chat-row-menu`): its Star, Highlight color, Snooze and Auto-settle are
   * that machine's, and `workspace` carries them as that machine lists them.
   */
  remoteMarks?: boolean
  /** What of a paired machine's chat's management its machine takes from here (`MeshConversationManage`). */
  remoteManage?: MeshConversationManage
  /** A paired machine's chat whose machine this pairing may start a chat on: New chat in project opens there. */
  remoteNewChat?: boolean
  /**
   * The Auto compact switch for a chat here (see `ChatRestAndMarkItems`);
   * null leaves it off the menu.
   */
  autoCompact?: { on: boolean; claude: boolean } | null
  /**
   * An agent here has finished something, the chat is not the one in front,
   * and its row is not already marked: Mark unread has something to mark.
   */
  canMarkUnread?: boolean
  /** The pull request Studio is watching for the chat, by number: Stop watching stops it. Null offers nothing. */
  watchedPullRequestNumber?: number | null
  /**
   * The schedule here that started this chat, and whether it is paused: the
   * menu offers to pause it, or resume it. Null for every other chat.
   */
  schedule?: { paused: boolean } | null
  /**
   * The window can delete settled chats (a confirm dialog and main's delete
   * are there). Delete is offered only on a settled chat: Settle is how a
   * chat is put away, and deleting is for one already put away. A paired
   * machine's is offered where that machine deletes its chats from here
   * (`remoteDelete`).
   */
  canDelete?: boolean
  /**
   * A paired machine's settled chat, whose machine deletes its chats from
   * here (`chat-delete`): Delete deletes it there, then this computer's record.
   */
  remoteDelete?: boolean
  onClose: () => void
  onSelect: (action: ContextMenuAction) => void
  onPickColor: (color: HighlightColor) => void
}) {
  if (!workspace) return null
  const typeActions = workspaceTypeRowActions(workspace, moduleOverrides)
  // Reveal is about THIS row's folder, so a missing one takes it away. New
  // chat is about the project the row files under, which a pruned worktree
  // does not touch — hence the two predicates rather than one.
  const folderPathExists = Boolean(workspace.folderPath) && !workspace.folderMissing
  const newChatTarget = newChatProjectTarget(workspace)
  const canNewChatInProject = newChatTarget !== null
  // A `sprintengine://` link opens the desktop app, so a browser tab does not
  // offer one; nor does a row whose id a link cannot carry. A paired
  // machine's chat is linked by its id there (`chatLinkIdOf`).
  const canCopyLink = clientSupports('deep-links') && chatLinkFor(chatLinkIdOf(workspace)) !== null
  const starred = isStarred(workspace.highlight)
  const settled = isSettledWorkspace(workspace)
  const snoozed = isSnoozedWorkspace(workspace, now)
  const autoSettle = workspace.autoSettleEnabled === true
  const currentColor = workspace.highlight?.color ?? null
  // Settle is the one way a row is put away: there is no Close beside it. A
  // row born on a paired machine asks that machine first where it keeps its
  // chats' rest, and rests here alone where it keeps none; it never offers
  // Un-settle: a settled one is off the rail here. Its sleep and Auto-settle
  // are that machine's, offered where it takes them.
  const remote = Boolean(workspace.remoteOrigin)
  const where: ChatMenuPlace = workspace.remoteOrigin
    ? {
        kind: 'remote',
        machineName: workspace.remoteOrigin.machineName,
        marks: remoteMarks,
        ...(remoteManage ? { manage: remoteManage } : {}),
      }
    : { kind: 'local' }
  // Reveal is shown off, and says why, for a folder this computer cannot
  // show: one on the paired machine the chat runs on, or one gone from disk.
  const revealUnavailable = remote || (Boolean(workspace.folderPath) && workspace.folderMissing === true)
  const settle = remote ? (settled ? null : 'settle') : settled ? 'unsettle' : 'settle'
  const sleeps = remote ? remoteMarks : !settled
  const canSnooze = remote ? !settled : canSnoozeWorkspace(workspace)

  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Workspace actions: ${workspace.name}`}
      onClose={onClose}
      surfaceClassName="min-w-[240px]"
    >
      <ChatMenuItem tooltip={tips.open()} onClick={() => onSelect('open')}>
        Open
      </ChatMenuItem>
      {canMarkUnread ? (
        <ChatMenuItem tooltip={tips.markUnread(where)} onClick={() => onSelect('mark-unread')}>
          Mark unread
        </ChatMenuItem>
      ) : null}
      <ChatMenuItem tooltip={tips.rename(where)} onClick={() => onSelect('rename')} shortcut="F2">
        Rename
      </ChatMenuItem>
      {canNewChatInProject ? (
        <ChatMenuItem
          tooltip={tips.newChat(isProjectlessChatsRoot(newChatTarget))}
          onClick={() => onSelect('new-chat')}
        >
          {isProjectlessChatsRoot(newChatTarget) ? 'New chat without a project' : 'New chat in project'}
        </ChatMenuItem>
      ) : remote && remoteNewChat ? (
        <ChatMenuItem tooltip={tips.newChat(false, where)} onClick={() => onSelect('new-chat')}>
          New chat in project
        </ChatMenuItem>
      ) : null}
      {folderPathExists ? (
        <ChatMenuItem tooltip={tips.reveal()} onClick={() => onSelect('reveal')}>
          Reveal folder
        </ChatMenuItem>
      ) : revealUnavailable ? (
        <ChatMenuItem
          disabled
          hint={remote ? `On ${workspace.remoteOrigin!.machineName}` : 'Missing'}
          tooltip={tips.revealUnavailable(where)}
          onClick={() => undefined}
        >
          Reveal folder
        </ChatMenuItem>
      ) : null}
      {canCopyLink ? (
        <ChatMenuItem tooltip={tips.copyLink(where)} onClick={() => onSelect('copy-link')}>
          Copy link to chat
        </ChatMenuItem>
      ) : null}
      {isDetachedWindow ? (
        <ChatMenuItem tooltip={tips.moveToMainWindow()} onClick={() => onSelect('move-to-main-window')}>
          Move to Main Window
        </ChatMenuItem>
      ) : (
        <ChatMenuItem tooltip={tips.moveToNewWindow()} onClick={() => onSelect('move-to-new-window')}>
          Move to New Window
        </ChatMenuItem>
      )}
      <MenuDivider />
      <ChatRestAndMarkItems
        where={where}
        starred={starred}
        color={currentColor}
        settle={settle}
        working={working}
        snooze={snoozed ? 'wake' : sleeps ? { disabled: !canSnooze } : null}
        autoSettle={remote && !remoteMarks ? null : autoSettle}
        autoCompact={remote && !remoteManage?.autoCompact ? null : autoCompact}
        between={
          <>
            {/* A chat whose agent has Studio babysitting its pull request reads as
                working until it is woken; this ends the watch and leaves the chat
                as it is. Settle ends the watch too, with the chat. */}
            {watchedPullRequestNumber !== null ? (
              <ChatMenuItem
                tooltip={tips.stopWatching(watchedPullRequestNumber, where)}
                onClick={() => onSelect('stop-watching')}
              >
                Stop watching #{watchedPullRequestNumber}
              </ChatMenuItem>
            ) : null}
            {/* A run's chat is where a person notices a schedule doing too much:
                this stops its next runs from here, and leaves this chat (and any
                run still going) as it is. */}
            {schedule ? (
              <ChatMenuItem
                hint={schedule.paused ? undefined : 'This chat carries on'}
                tooltip={tips.schedule(schedule.paused)}
                onClick={() => onSelect('toggle-schedule-pause')}
              >
                {schedule.paused ? 'Resume this schedule' : 'Pause this schedule'}
              </ChatMenuItem>
            ) : null}
          </>
        }
        onSelect={onSelect}
        onPickColor={onPickColor}
      />
      {typeActions.length > 0 ? (
        <>
          <MenuDivider />
          {typeActions.map((action) => (
            <ChatMenuItem
              key={action.id}
              variant={action.variant}
              tooltip={tips.typeAction(action.label)}
              onClick={() => onSelect(`type-action:${action.id}`)}
            >
              {action.label}
            </ChatMenuItem>
          ))}
        </>
      ) : null}
      {canDelete && settled && (!remote || remoteDelete) ? (
        <>
          <MenuDivider />
          <ChatMenuItem variant="danger" tooltip={tips.deleteSettled(where)} onClick={() => onSelect('delete-settled')}>
            Delete chat…
          </ChatMenuItem>
        </>
      ) : null}
    </ContextMenu>
  )
}

export type RemoteConversationMenuAction =
  | 'open'
  | 'mark-unread'
  | 'copy-link'
  | 'move-to-new-window'
  | 'move-to-main-window'
  | ChatMarkAction
  // ── A paired desktop's chat management ──
  | 'rename'
  | 'toggle-auto-compact'
  | 'stop-watching'
  | 'new-chat'

/**
 * The link to a chat: by its id on the machine it runs on, so the same link
 * opens it there, here, and on any other machine that follows it.
 */
export function chatLinkIdOf(workspace: Pick<Workspace, 'id' | 'remoteOrigin'>): string {
  return workspace.remoteOrigin?.workspaceId || workspace.id
}

// A chat on a paired machine that no window here holds: the same menu a
// local row has, each item asking that machine, which keeps the chat. Its rest
// (`conversation-lifecycle`), its marks and sleep (`chat-row-menu`) and its read
// state (`chat-mark-unread`) are offered where the machine takes them; an
// older machine's chat offers what it can, as a local menu hides what does
// not apply. Reveal folder is shown off, saying why: the folder is on the
// other machine's disk. Rename is offered where the machine keeps the name
// (`chat-rename`), and New chat in project where this pairing may start a
// chat there, opening New chat on that machine and project. Left out because
// they are about a workspace here, which this row does not have until it is
// opened: the workspace type's own actions, and Close workspace.
export function RemoteConversationContextMenu({
  x,
  y,
  title,
  machineName,
  canSettle,
  marks,
  manage,
  autoCompact = null,
  watchedPullRequestNumber = null,
  canNewChat = false,
  canMarkUnread,
  isDetachedWindow,
  workspaceId,
  starred,
  color,
  snoozedUntil,
  autoSettle,
  now,
  working,
  onClose,
  onSelect,
  onPickColor,
}: {
  x: number
  y: number
  title: string
  machineName: string
  /** The machine keeps its chats' rest, so it can be asked to settle this one. */
  canSettle: boolean
  /** The machine takes the row menu's Star, Highlight color, Snooze and Auto-settle (`chat-row-menu`). */
  marks: boolean
  /** What of the chat's management the machine takes from here; none when absent. */
  manage?: MeshConversationManage
  /** The chat's Auto compact switch as its machine reads it; offered where the machine takes it from here. */
  autoCompact?: { on: boolean; claude: boolean } | null
  /** The pull request its machine watches for it, by number, where the machine takes Stop watching from here. */
  watchedPullRequestNumber?: number | null
  /** This pairing may start a chat on the machine: New chat in project opens there, in this chat's project. */
  canNewChat?: boolean
  /** Its agent finished something nobody has been marked as missing, and the machine takes Mark unread. */
  canMarkUnread: boolean
  isDetachedWindow: boolean
  /** The chat's id on its machine, which its link carries. */
  workspaceId: string
  starred: boolean
  color: HighlightColor | null
  /** When it wakes, while it sleeps over there. */
  snoozedUntil: number | null
  autoSettle: boolean
  now: number
  /** Its agent is working, so Settle and Snooze wait, as they do on a local row. */
  working: boolean
  onClose: () => void
  onSelect: (action: RemoteConversationMenuAction) => void
  onPickColor: (color: HighlightColor) => void
}) {
  const canCopyLink = clientSupports('deep-links') && chatLinkFor(workspaceId) !== null
  const snoozed = isSnoozedWorkspace({ snoozedUntil }, now)
  const where: ChatMenuPlace = { kind: 'remote', machineName, marks, ...(manage ? { manage } : {}) }
  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Chat actions: ${title} on ${machineName}`}
      onClose={onClose}
      surfaceClassName="min-w-[240px]"
    >
      <ChatMenuItem tooltip={tips.open(where)} onClick={() => onSelect('open')}>
        Open
      </ChatMenuItem>
      {canMarkUnread ? (
        <ChatMenuItem tooltip={tips.markUnread(where)} onClick={() => onSelect('mark-unread')}>
          Mark unread
        </ChatMenuItem>
      ) : null}
      {manage?.rename ? (
        <ChatMenuItem tooltip={tips.rename(where)} onClick={() => onSelect('rename')}>
          Rename
        </ChatMenuItem>
      ) : null}
      {canNewChat ? (
        <ChatMenuItem tooltip={tips.newChat(false, where)} onClick={() => onSelect('new-chat')}>
          New chat in project
        </ChatMenuItem>
      ) : null}
      {/* Off, and saying why: the folder is on the other machine's disk. */}
      <ChatMenuItem
        disabled
        hint={`On ${machineName}`}
        tooltip={tips.revealUnavailable(where)}
        onClick={() => undefined}
      >
        Reveal folder
      </ChatMenuItem>
      {canCopyLink ? (
        <ChatMenuItem tooltip={tips.copyLink(where)} onClick={() => onSelect('copy-link')}>
          Copy link to chat
        </ChatMenuItem>
      ) : null}
      {/* Opened in that window, as a local row is moved to it. */}
      {isDetachedWindow ? (
        <ChatMenuItem tooltip={tips.moveToMainWindow(where)} onClick={() => onSelect('move-to-main-window')}>
          Move to Main Window
        </ChatMenuItem>
      ) : (
        <ChatMenuItem tooltip={tips.moveToNewWindow(where)} onClick={() => onSelect('move-to-new-window')}>
          Move to New Window
        </ChatMenuItem>
      )}
      {marks || canSettle ? (
        <>
          <MenuDivider />
          {marks ? (
            <ChatRestAndMarkItems
              where={where}
              starred={starred}
              color={color}
              settle={canSettle ? 'settle' : null}
              working={working}
              snooze={snoozed ? 'wake' : { disabled: false }}
              autoSettle={autoSettle}
              // Auto compact is the rule of the machine that runs the chat,
              // switched there where that machine takes it from here.
              autoCompact={manage?.autoCompact ? autoCompact : null}
              between={
                // The watch is the machine's, ended there; the chat stays as it is.
                watchedPullRequestNumber !== null ? (
                  <ChatMenuItem
                    tooltip={tips.stopWatching(watchedPullRequestNumber, where)}
                    onClick={() => onSelect('stop-watching')}
                  >
                    Stop watching #{watchedPullRequestNumber}
                  </ChatMenuItem>
                ) : null
              }
              onSelect={onSelect}
              onPickColor={onPickColor}
            />
          ) : (
            <ChatMenuItem
              disabled={working}
              hint={working ? 'Working' : undefined}
              tooltip={tips.settle(working, where)}
              onClick={() => onSelect('toggle-settle')}
            >
              Settle
            </ChatMenuItem>
          )}
        </>
      ) : null}
    </ContextMenu>
  )
}

export type FolderMenuAction = 'new-chat' | 'reveal' | 'forget'

export function FolderContextMenu({
  x,
  y,
  group,
  remoteNewChat = false,
  projectColorKey: colorKey,
  projectColorSettled,
  projectColor,
  automaticProjectColor,
  onClose,
  onSelect,
  onPickProjectColor,
}: {
  x: number
  y: number
  group: FolderGroup | null
  /**
   * A header of a paired machine's project, on a machine this pairing may
   * start a chat on: New chat in project opens New chat there.
   */
  remoteNewChat?: boolean
  /** The project this header names, or null when it is not a project. */
  projectColorKey: string | null
  /** Whether that key is the project's FINAL one — see `canPickColor` below. */
  projectColorSettled: boolean
  /** The person's override for that project: a hue, `'none'`, or null for none. */
  projectColor: ProjectColorSetting | null
  /** The hue hashed from that project's key — what "Automatic" returns to. */
  automaticProjectColor: ProjectColor
  onClose: () => void
  onSelect: (action: FolderMenuAction) => void
  /** A hue, `'none'`, or null for "Automatic" (deletes the override). */
  onPickProjectColor: (color: ProjectColorSetting | null) => void
}) {
  if (!group) return null
  const canReveal = Boolean(group.fullPath) && !group.missing
  const canForget = Boolean(group.fullPath)
  const canCreateWorkspace = (Boolean(group.fullPath) && !group.missing) || (Boolean(group.remote) && remoteNewChat)
  // "Changed by you" (decision 5) — but only where there is a project to
  // change, and only once we know which project it IS. The "No folder" bucket
  // is not a project, and a remote group's root lives on another machine with
  // no identity to key by.
  //
  // The `settled` half is not cosmetic. Before the repository read lands the key
  // is the folder's PATH; a person who right-clicks a header in that first
  // second and picks a hue would have it written to `folder:/path`, and a beat
  // later the project is keyed `repo:…` and their choice has silently vanished
  // — leaving a stray override on a key nothing reads. Better to not offer the
  // control for that beat than to take a choice and lose it.
  const canPickColor = Boolean(colorKey) && projectColorSettled

  return (
    <ContextMenu
      x={x}
      y={y}
      ariaLabel={`Folder actions: ${group.displayName}`}
      onClose={onClose}
      surfaceClassName="min-w-[220px]"
    >
      {canCreateWorkspace ? (
        <MenuItem onClick={() => onSelect('new-chat')}>
          {/* The "No project" header starts another chat of its kind, in a
              folder of its own, never one inside the root itself. */}
          {isProjectlessChatsRoot(group.fullPath) ? 'New chat without a project' : 'New chat in project'}
        </MenuItem>
      ) : null}
      {canReveal ? <MenuItem onClick={() => onSelect('reveal')}>Reveal folder</MenuItem> : null}
      {/* The same swatch control the row menu spends on "Highlight color", one
          menu up: a highlight is a tint a person puts ON a chat, a project
          colour is what the project IS, and the header is the one line that
          names the project. "Automatic" (the hashed hue), eight named hues,
          and "No colour" — the last for a project whose own logo already
          identifies it. */}
      {canPickColor ? (
        <ProjectColorSwatchRow
          label="Project color"
          value={projectColor}
          automaticColor={automaticProjectColor}
          onPick={onPickProjectColor}
        />
      ) : null}
      {canCreateWorkspace && canForget ? <MenuDivider /> : null}
      {canForget ? (
        <MenuItem variant="danger" onClick={() => onSelect('forget')}>
          Forget folder…
        </MenuItem>
      ) : null}
    </ContextMenu>
  )
}
