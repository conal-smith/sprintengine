import type {
  SettledChatDeletionOutcome,
  SettledChatDeletionPlan,
  SettledChatWorktreePlan,
} from '../../../shared/ipc/settled-chats'

// What the confirmation and the toast after a delete say, from main's plan
// and outcome (src/main/settled-chat-deletion.ts). Pure, so the words are
// tested without a dialog.
//
// There is no Undo. A deleted chat's transcripts and folder are gone from
// the disk, and the confirmation is the only guard: it names what goes and
// what stays, a worktree's uncommitted changes and unpushed commits included,
// so nothing is lost that the person was not told about first.

export type DeletionConfirmation = {
  title: string
  paragraphs: string[]
  confirmLabel: string
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

const LISTED = 4

function listed(items: string[]): string {
  if (items.length <= LISTED) return items.join(', ')
  return `${items.slice(0, LISTED).join(', ')} and ${items.length - LISTED} more`
}

function keptReason(worktree: SettledChatWorktreePlan): string {
  switch (worktree.keptBecause) {
    case 'changes':
      return `it has ${plural(worktree.changedPaths ?? 0, 'uncommitted change')}`
    case 'shared':
      return 'another chat works in it'
    case 'not-made-here':
      return 'Studio did not make it'
    case 'other-machine':
      return 'it is on another machine'
    default:
      return 'its status could not be read'
  }
}

/** One worktree, as the confirmation for one chat says it. */
function worktreeSentence(worktree: SettledChatWorktreePlan): string {
  if (worktree.fate === 'keep') {
    const advice =
      worktree.keptBecause === 'changes'
        ? worktree.pooled
          ? ' The pool holds it for you in Settings ▸ Worktrees, to commit or discard them.'
          : ' Commit or discard them, then remove it in Settings ▸ Worktrees.'
        : ''
    return `Its worktree ${worktree.name} is kept: ${keptReason(worktree)}.${advice}`
  }
  const where = worktree.pooled ? 'goes back to the worktree pool' : 'is removed'
  const branch = worktree.branch ? ` The branch ${worktree.branch} is kept.` : ''
  const unpushed =
    worktree.unpushedCommits && worktree.branch
      ? ` Its ${plural(worktree.unpushedCommits, 'commit')} that ${worktree.unpushedCommits === 1 ? "isn't" : "aren't"} pushed stay${worktree.unpushedCommits === 1 ? 's' : ''} on that branch.`
      : ''
  return `Its worktree ${worktree.name} ${where}.${branch}${unpushed}`
}

/**
 * The confirmation for deleting these chats. `plans` holds the ones main
 * would delete (refused ones left out, and counted in `refusedCount`).
 */
export function deletionConfirmation(
  plans: readonly SettledChatDeletionPlan[],
  titleOf: (workspaceId: string) => string,
  refusedCount = 0,
): DeletionConfirmation {
  const left =
    refusedCount > 0
      ? [
          `${plural(refusedCount, 'other chat')} can't be deleted now and ${refusedCount === 1 ? 'is' : 'are'} left as ${refusedCount === 1 ? 'it is' : 'they are'}.`,
        ]
      : []
  if (plans.length === 1) {
    const [plan] = plans
    const title = titleOf(plan.workspaceId)
    if (plan.remoteMachine) {
      return {
        title: `Remove “${title}” from this computer?`,
        paragraphs: [
          `It runs on ${plan.remoteMachine}. This removes it from this computer only: the chat, its history and its worktree stay on ${plan.remoteMachine}, where it can be deleted.`,
          ...left,
        ],
        confirmLabel: 'Remove',
      }
    }
    return {
      title: `Delete “${title}”?`,
      paragraphs: [
        "Its history is deleted for good. A deleted chat can't be brought back.",
        ...plan.worktrees.map(worktreeSentence),
        ...left,
      ],
      confirmLabel: 'Delete',
    }
  }

  const worktrees = plans.flatMap((plan) => plan.worktrees)
  const going = worktrees.filter((worktree) => worktree.fate === 'remove')
  const kept = worktrees.filter((worktree) => worktree.fate === 'keep')
  const unpushed = going.reduce((sum, worktree) => sum + (worktree.branch ? (worktree.unpushedCommits ?? 0) : 0), 0)
  const remote = plans.filter((plan) => plan.remoteMachine).length
  const paragraphs = ["Their history is deleted for good. Deleted chats can't be brought back."]
  if (going.length > 0) {
    paragraphs.push(
      `${plural(going.length, 'worktree')} ${going.length === 1 ? 'is' : 'are'} removed or ${going.length === 1 ? 'goes' : 'go'} back to the pool, and ${going.length === 1 ? 'its branch is' : 'their branches are'} kept.` +
        (unpushed > 0
          ? ` ${plural(unpushed, 'commit')} that ${unpushed === 1 ? "isn't" : "aren't"} pushed stay${unpushed === 1 ? 's' : ''} on ${going.length === 1 ? 'that branch' : 'those branches'}.`
          : ''),
    )
  }
  if (kept.length > 0) {
    paragraphs.push(`Kept: ${listed(kept.map((worktree) => `${worktree.name} (${keptReason(worktree)})`))}.`)
  }
  if (remote > 0) {
    paragraphs.push(
      `${plural(remote, 'of them runs', 'of them run')} on a paired machine: ${remote === 1 ? 'it is' : 'those are'} removed from this computer only, and stay${remote === 1 ? 's' : ''} on that machine.`,
    )
  }
  paragraphs.push(...left)
  return { title: `Delete ${plans.length} settled chats?`, paragraphs, confirmLabel: `Delete ${plans.length} chats` }
}

export type DeletionToast = { tone: 'good' | 'warn' | 'error'; title: string; description?: string }

/** What the toast after a delete says: what went, and any worktree that stayed and why. */
export function deletionToast(
  outcomes: readonly SettledChatDeletionOutcome[],
  titleOf: (workspaceId: string) => string,
): DeletionToast {
  const failed = outcomes.filter((outcome) => !outcome.ok)
  const done = outcomes.filter((outcome) => outcome.ok)
  const keptNotes = done.flatMap((outcome) =>
    outcome.worktrees
      .filter((worktree) => worktree.result === 'kept')
      .map(
        (worktree) => `${worktree.name} was kept${worktree.detail ? `: ${worktree.detail.replace(/\.$/, '')}` : ''}.`,
      ),
  )
  if (failed.length > 0) {
    const first = failed[0]
    const why = first.ok ? '' : first.message
    return {
      tone: 'error',
      title:
        failed.length === 1
          ? `“${titleOf(first.workspaceId)}” was not deleted`
          : `${failed.length} chats were not deleted`,
      description: [
        why,
        done.length > 0 ? `${plural(done.length, 'other chat')} ${done.length === 1 ? 'was' : 'were'} deleted.` : '',
        ...keptNotes,
      ]
        .filter(Boolean)
        .join(' '),
    }
  }
  return {
    tone: keptNotes.length > 0 ? 'warn' : 'good',
    title: done.length === 1 ? `Deleted “${titleOf(done[0].workspaceId)}”` : `Deleted ${done.length} chats`,
    ...(keptNotes.length > 0 ? { description: keptNotes.join(' ') } : {}),
  }
}
