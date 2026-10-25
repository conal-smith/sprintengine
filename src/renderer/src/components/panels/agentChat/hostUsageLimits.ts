import {
  USAGE_LIMIT_PROVIDERS,
  type UsageLimitProvider,
  type UsageLimitsState,
} from '../../../../../shared/usage-limits'
import type { UsageLimitResumeNotice } from '../../../../../shared/usage-limit-resume'
import type { MeshConversationUsageLimits } from '../../../../../shared/tailnet-mesh'

// A paired machine's usage limits, as the strip and the tray here draw a local
// chat's: what that machine said in its `usageLimits` frames, read into the
// shapes this computer's own store holds (shared/usage-limits.ts,
// shared/usage-limit-resume.ts). A plan of a provider this build does not
// draw is left out, as one it has never heard of would be locally.

/** What the strip and the tray draw for a chat on another machine. */
export type HostUsageLimits = {
  machineName: string
  /** The notice a usage limit left on the chat's turn there; null for none. */
  notice: Omit<UsageLimitResumeNotice, 'workspaceId' | 'agentId'> | null
  /** That machine resumes every chat a limit stops, by itself. */
  autoResume: boolean
  /** Every plan's windows as that machine's agents reported them. */
  state: UsageLimitsState
}

const isProvider = (value: string): value is UsageLimitProvider =>
  (USAGE_LIMIT_PROVIDERS as readonly string[]).includes(value)

export function hostUsageLimitsOf(machineName: string, said: MeshConversationUsageLimits): HostUsageLimits {
  const notice = said.notice && isProvider(said.notice.provider) ? said.notice : null
  return {
    machineName,
    notice: notice ? { ...notice, provider: notice.provider as UsageLimitProvider } : null,
    autoResume: said.autoResume,
    state: {
      // Only a subscription's plan is said: one billed by use has no windows.
      snapshots: said.limits.flatMap((snapshot) =>
        isProvider(snapshot.provider)
          ? [{ ...snapshot, provider: snapshot.provider, billing: 'subscription' as const }]
          : [],
      ),
    },
  }
}
