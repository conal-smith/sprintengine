// The composer tray's row for a chat a usage limit stopped: which limit, when
// it resets, and Resume at reset, which has Studio send the chat a short "carry
// on" once it has. With the resume scheduled the row says when it goes out,
// and Cancel takes it back. A resume the chat refused says why, with Retry.
// Main keeps the resumes and sends them (src/main/usage-limits/resume.ts);
// this only draws one chat's. A chat on a paired machine draws the same row
// from what that machine says of the chat (`usageLimits` frames), and each
// button asks that machine, which sends the resume.

import { memo, useEffect, type JSX } from 'react'

import { useRelativeNow } from '../../../hooks/useRelativeNow'
import {
  retainUsageLimitResumes,
  selectUsageLimitResumeNotice,
  updateUsageLimitResume,
  useUsageLimitResumeStore,
} from '../../../store/usageLimitResumeStore'
import type { UsageLimitResumeNotice } from '../../../../../shared/usage-limit-resume'
import { formatUsageResetIn, usageProviderLabel } from '../../../../../shared/usage-limits'
import { GhostButton, LinkButton } from '../../ui'
import { ComposerTrayRow } from './composerTray'
import { formatTimeOfDay } from '../../../utils/clockFormat'

const DAY_MS = 24 * 60 * 60 * 1000

/** "23:40" today, "Fri 23:40" within the week, "12 Oct, 23:40" beyond it. */
export function formatResumeClock(at: number, now: number): string {
  const date = new Date(at)
  const time = formatTimeOfDay(date)
  if (date.toDateString() === new Date(now).toDateString()) return time
  if (at - now < 6 * DAY_MS) return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`
}

/** The notice in words: "Claude's session limit is used up. It resets at 23:40 (in 2h 13m)." */
export function usageLimitResumeWords(
  notice: Pick<UsageLimitResumeNotice, 'provider' | 'limit' | 'resumeAt' | 'resetsAt'>,
  now: number,
): string {
  const limit =
    notice.limit === 'session' ? 'session limit' : notice.limit === 'weekly' ? 'weekly limit' : 'usage limit'
  const head = `${usageProviderLabel(notice.provider)}'s ${limit} is used up.`
  if (notice.resumeAt !== null)
    return `${head} Resumes at ${formatResumeClock(notice.resumeAt, now)} (in ${formatUsageResetIn(notice.resumeAt, now)}).`
  if (notice.resetsAt !== null)
    return `${head} It resets at ${formatResumeClock(notice.resetsAt, now)} (in ${formatUsageResetIn(notice.resetsAt, now)}).`
  return `${head} It did not say when it resets.`
}

/** A refused resume in words: "Couldn't resume: the chat has no folder on this machine." */
export function usageLimitResumeFailureWords(failure: string): string {
  const reason = failure.trim().replace(/\.$/u, '')
  return `Couldn't resume: ${reason ? reason.charAt(0).toLowerCase() + reason.slice(1) : 'the chat refused it'}.`
}

function UsageLimitResumeRowBody({
  workspaceId,
  agentId,
}: {
  workspaceId: string
  agentId: string
}): JSX.Element | null {
  useEffect(() => retainUsageLimitResumes(), [])
  const notice = useUsageLimitResumeStore((store) =>
    selectUsageLimitResumeNotice(store.state, { workspaceId, agentId }),
  )
  const autoResume = useUsageLimitResumeStore((store) => store.state?.autoResume ?? false)
  const chat = { workspaceId, agentId }
  return (
    <UsageLimitNoticeRow
      notice={notice}
      autoResume={autoResume}
      onAct={(action, always) => {
        void (async () => {
          if (always) await updateUsageLimitResume({ kind: 'auto', enabled: true })
          await updateUsageLimitResume({ kind: action, ...chat })
        })()
      }}
    />
  )
}

/**
 * The row itself, for a notice kept anywhere: this computer's, or a paired
 * machine's for a chat that runs there, which sends the resume. `onAct`
 * absent draws the words without the buttons (a pairing that may only
 * follow).
 */
export function UsageLimitNoticeRow({
  notice,
  autoResume,
  onAct,
}: {
  notice: Omit<UsageLimitResumeNotice, 'workspaceId' | 'agentId'> | null
  autoResume: boolean
  /** Schedule the resume (`always`: for every chat a limit stops), cancel, dismiss or retry it. */
  onAct?: (action: 'schedule' | 'cancel' | 'dismiss' | 'retry', always?: boolean) => void
}): JSX.Element | null {
  // A minute's resolution: the words count down in minutes.
  const now = useRelativeNow(30_000, notice !== null)
  if (!notice) return null
  const act = onAct
  // The resume went out and the chat refused it: said here, where the person
  // looks, until they send it again or put it away.
  if (notice.failure !== undefined) {
    return (
      <ComposerTrayRow
        tone="warn"
        actions={
          act ? (
            <>
              <GhostButton size="xs" onClick={() => act('retry')}>
                Retry
              </GhostButton>
              <GhostButton size="xs" onClick={() => act('dismiss')}>
                Dismiss
              </GhostButton>
            </>
          ) : null
        }
      >
        {usageLimitResumeFailureWords(notice.failure)}
      </ComposerTrayRow>
    )
  }
  // Nothing scheduled and the limit has reset: the notice is no longer true.
  if (notice.resumeAt === null && notice.resetsAt !== null && notice.resetsAt <= now) return null
  const words = usageLimitResumeWords(notice, now)

  if (notice.resumeAt !== null) {
    return (
      <ComposerTrayRow
        tone="neutral"
        actions={
          act ? (
            <GhostButton size="xs" onClick={() => act('cancel')}>
              Cancel
            </GhostButton>
          ) : null
        }
      >
        {words}
      </ComposerTrayRow>
    )
  }

  const canSchedule = notice.resetsAt !== null
  return (
    <ComposerTrayRow
      tone="warn"
      actions={
        act ? (
          <>
            {canSchedule ? (
              <GhostButton size="xs" onClick={() => act('schedule')}>
                Resume at reset
              </GhostButton>
            ) : null}
            <GhostButton size="xs" onClick={() => act('dismiss')}>
              Dismiss
            </GhostButton>
          </>
        ) : null
      }
    >
      {words}
      {act && canSchedule && !autoResume ? (
        <>
          {' '}
          <LinkButton onClick={() => act('schedule', true)}>Always resume at reset</LinkButton>
        </>
      ) : null}
    </ComposerTrayRow>
  )
}

// Memoised: the chat body commits on every streamed token, and this row
// changes only when main says so, through its store.
export const UsageLimitResumeRow = memo(UsageLimitResumeRowBody)

// Memoised for the same reason: a paired machine's row changes only when it
// says so, in a `usageLimits` frame.
export const HostUsageLimitNoticeRow = memo(UsageLimitNoticeRow)
