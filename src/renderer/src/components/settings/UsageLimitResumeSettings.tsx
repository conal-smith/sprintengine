import { useEffect } from 'react'

import {
  retainUsageLimitResumes,
  updateUsageLimitResume,
  useUsageLimitResumeStore,
} from '../../store/usageLimitResumeStore'
import { SettingCard, SettingToggle } from './SettingsAtoms'

// Settings → Agents' switch for resuming a chat a usage limit stopped. Main
// keeps it, beside the resumes it schedules (src/main/usage-limits/resume.ts);
// the chat's own notice can turn it on too.
export function UsageLimitResumeSettings() {
  useEffect(() => retainUsageLimitResumes(), [])
  const autoResume = useUsageLimitResumeStore((store) => store.state?.autoResume ?? false)
  return (
    <SettingCard>
      <SettingToggle
        label="Resume after usage limits"
        description="When a Claude or Codex chat runs out of its plan's session or weekly limit, Studio tells it to carry on a minute after the limit resets. Off: the chat offers Resume at reset, and you choose."
        enabled={autoResume}
        onChange={(enabled) => void updateUsageLimitResume({ kind: 'auto', enabled })}
      />
    </SettingCard>
  )
}
