// What each item of a chat's right-click menu does, said on hover and on
// keyboard focus (owner request 2026-10-21: every item explains itself). One
// table for both menus, a chat here and a paired machine's, so the two say
// the same thing about the same item, and a new item is one more entry here.
//
// `where` says whose the chat is. A chat here is `local`. A paired machine's
// chat is `remote`, and `marks` says whether that machine keeps the row
// menu's star, colour, sleep and Auto-settle (`chat-row-menu`): where it does
// they are written there, and where it does not a chat opened here keeps them
// on this computer only. Each item that works differently on a remote chat
// says how.

import type { HighlightColor } from '../../../types/workspace'
import { getHighlightSwatch } from '../../../utils/highlight'
import { hostPlatform } from '../../../clientCapabilities'

export type ChatMenuPlace = { kind: 'local' } | { kind: 'remote'; machineName: string; marks: boolean }

const LOCAL: ChatMenuPlace = { kind: 'local' }

/** Where a star or colour set from this menu is kept, for a paired machine's chat. */
function markKept(where: ChatMenuPlace): string {
  if (where.kind === 'local') return ''
  return where.marks
    ? ` Saved on ${where.machineName}, so it shows there too.`
    : ` Saved on this computer only: ${where.machineName} does not take it yet.`
}

function fileManager(): string {
  const platform = hostPlatform()
  if (platform === 'darwin') return 'Finder'
  if (platform === 'win32') return 'Explorer'
  return 'your file manager'
}

export const chatMenuTooltips = {
  open: (where: ChatMenuPlace = LOCAL) =>
    where.kind === 'local'
      ? 'Show this chat in this window.'
      : `Follow this chat here. It keeps running on ${where.machineName}.`,
  markUnread: (where: ChatMenuPlace = LOCAL) =>
    where.kind === 'local'
      ? 'Mark the latest reply as unread, on every device.'
      : `Mark the latest reply as unread on ${where.machineName}, and on every device that follows it.`,
  rename: (where: ChatMenuPlace = LOCAL) =>
    where.kind === 'local'
      ? 'Rename this chat.'
      : `Rename this chat on this computer. ${where.machineName} keeps its own name for it.`,
  newChat: (projectless: boolean) =>
    projectless
      ? 'Start a new chat that has no project, in a folder of its own.'
      : "Start a new chat in this chat's project.",
  reveal: () => `Show this chat's folder in ${fileManager()}.`,
  /** Why Reveal folder is off: the folder is on another machine, or gone. */
  revealUnavailable: (where: ChatMenuPlace) =>
    where.kind === 'remote'
      ? `The folder is on ${where.machineName}, so it can't be shown on this computer.`
      : "This chat's folder is no longer on disk.",
  copyLink: (where: ChatMenuPlace = LOCAL) =>
    where.kind === 'local'
      ? 'Copy a link that opens this chat.'
      : `Copy a link that opens this chat, on ${where.machineName} or on any computer that follows it.`,
  moveToNewWindow: (where: ChatMenuPlace = LOCAL) =>
    where.kind === 'local' ? 'Open this chat in a window of its own.' : 'Follow this chat in a window of its own.',
  moveToMainWindow: (where: ChatMenuPlace = LOCAL) =>
    where.kind === 'local' ? 'Move this chat back to the main window.' : 'Follow this chat in the main window.',
  star: (starred: boolean, where: ChatMenuPlace = LOCAL) =>
    (starred
      ? 'Take this chat out of Starred.'
      : 'Keep this chat in Starred, at the top of the list. A starred chat never settles by itself.') + markKept(where),
  stopWatching: (pullRequest: number) =>
    `Stop watching pull request #${pullRequest} for this chat. The chat stays as it is.`,
  schedule: (paused: boolean) =>
    paused
      ? 'Let the schedule that started this chat run again.'
      : 'Stop the schedule that started this chat from running again. This chat carries on.',
  settle: (working: boolean, where: ChatMenuPlace = LOCAL) =>
    working
      ? 'Waits until the agents in this chat finish.'
      : 'Put this chat away: it leaves the list and its agents stop. A message to it brings it back.' +
        (where.kind === 'remote' ? ` ${where.machineName} settles it, so it leaves the list on every device.` : ''),
  unsettle: () => 'Bring this chat back to the list. Auto-settle leaves it alone until it sees new activity.',
  snooze: (working: boolean, where: ChatMenuPlace = LOCAL) =>
    working
      ? 'Waits until the agents in this chat finish.'
      : 'Hide this chat until a time you pick. Its agents pause, and pick up again when you next write to it.' +
        (where.kind === 'remote' ? ` ${where.machineName} snoozes it, so it sleeps on every device.` : ''),
  snoozeUntil: (label: string, whenLabel: string) => `Snooze until ${label.toLowerCase()}, ${whenLabel}.`,
  wake: (where: ChatMenuPlace = LOCAL) =>
    'Bring this chat back to the list now.' + (where.kind === 'remote' ? ` It wakes on ${where.machineName} too.` : ''),
  // The rest sweep (`shouldAutoSettleWorkspace`): three quiet days, counted
  // from a wake, held while a pull request is open; or its pull requests
  // merging; never a starred, snoozed, open, working or waiting chat. The
  // pull request halves are settings, both on by default.
  autoSettle: (where: ChatMenuPlace = LOCAL) =>
    'Settle this chat by itself after 3 days with no activity, or once its pull requests merge. ' +
    'It waits while the chat is starred, snoozed, open, working or waiting on you. ' +
    (where.kind === 'remote'
      ? `${where.machineName} settles it, by its own Settled chats settings.`
      : 'The pull request rules are in Settings ▸ Settled chats.'),
  highlight: (color: HighlightColor | null, where: ChatMenuPlace = LOCAL) =>
    (color === null
      ? "Remove this chat's highlight color."
      : `Tint this chat's row ${getHighlightSwatch(color).label.toLowerCase()}.`) + markKept(where),
  typeAction: (label: string) => `${label}: an action this chat's workspace type adds.`,
  close: (where: ChatMenuPlace = LOCAL) =>
    where.kind === 'local'
      ? 'Remove this chat from Studio. Its agents stop. Files on disk are kept.'
      : `Stop following this chat here. It keeps running on ${where.machineName}.`,
} as const
