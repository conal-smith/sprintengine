// What a watched pull request is waiting on, in the words every surface uses:
// the sidebar's chat line, the conversation strip's pull request item and its
// tooltip. One module, so the line and the strip never disagree about what a
// watch is doing.
//
// A watch is an agent babysitting its pull request (`pull_request.watch`): the
// Studio reads it every couple of minutes and wakes the chat when something
// needs it. The words say what it waits on, most pressing first, and never
// with a dot: "Checks failed", "Behind main", "Waiting for review".

import type {
  StudioPullRequestWatch,
  StudioPullRequestWatchWaitingOn,
} from '../../../packages/studio-protocol/src/public'

export type PullRequestWatchView = StudioPullRequestWatch
export type PullRequestWatchWaitingOn = StudioPullRequestWatchWaitingOn

/** Whether the words are about something going wrong, which a surface may ink in the danger tone. */
export function pullRequestWatchIsTrouble(view: PullRequestWatchView): boolean {
  return view.waitingOn === 'checks-failed' || view.waitingOn === 'conflicts'
}

/**
 * The short words: "Watching · checks running", "Checks failed", "Behind
 * main", "Approved · merging when green". What a line or a button says.
 */
export function pullRequestWatchWords(view: PullRequestWatchView): string {
  const base = view.base?.trim() || 'its base'
  switch (view.waitingOn) {
    case 'checks':
      if (view.approved) return view.autoMerge ? 'Approved · merging when green' : 'Approved · checks running'
      return 'Watching · checks running'
    case 'checks-failed':
      return view.failedChecks && view.failedChecks > 1 ? `${view.failedChecks} checks failed` : 'Check failed'
    case 'behind':
      return `Behind ${base}`
    case 'conflicts':
      return `Conflicts with ${base}`
    case 'changes-requested':
      return 'Changes requested'
    case 'review':
      return 'Waiting for review'
    case 'merge':
      if (view.autoMerge) return view.approved ? 'Approved · merging' : 'Merging'
      return view.approved ? 'Approved · ready to merge' : 'Ready to merge'
    default:
      // `first-read`, and a word a newer Studio sends that this build does not know.
      return 'Watching'
  }
}

/**
 * The sentence a tooltip and a spoken label carry: what the watch is and what
 * happens next, so the short words are never the only explanation.
 */
export function pullRequestWatchSentence(view: PullRequestWatchView): string {
  const wakes = 'The agent is woken when it needs a look.'
  switch (view.waitingOn) {
    case 'checks':
      return `Studio is watching it while its checks run. ${wakes}`
    case 'checks-failed':
      return 'Studio is watching it: a check failed, and the agent was woken to fix it.'
    case 'behind':
    case 'conflicts':
      return `Studio is watching it: its branch needs ${view.base?.trim() || 'its base'} merged in, and the agent was woken to do it.`
    case 'changes-requested':
      return 'Studio is watching it: a reviewer asked for changes, and the agent was woken to make them.'
    case 'review':
      return `Studio is watching it until someone reviews it. ${wakes}`
    case 'merge':
      return view.autoMerge
        ? 'Studio is watching it: GitHub merges it on its own once it may.'
        : 'Studio is watching it: it is ready to merge, and the agent was woken to merge it.'
    default:
      return `Studio is watching it. ${wakes}`
  }
}
