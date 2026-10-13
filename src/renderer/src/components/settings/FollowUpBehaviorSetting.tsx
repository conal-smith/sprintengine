import { useWorkspaceStore } from '../../store/workspaceStore'
import type { FollowUpBehavior } from '../../types/workspace'
import { renderKeybinding } from '../../commands/keybindings'
import { SegmentedControl, SettingCard, SettingRow } from '../ui'

// Settings → Agents: what a message sent while a chat's agent is working does.
// Queue holds it in the composer's tray and sends it when the turn ends, as
// every such message did before the choice; Steer hands it to the running
// turn, where the chat's provider takes one. The other is a chord away for one
// message, so the row names it.
export function FollowUpBehaviorSetting() {
  const behavior = useWorkspaceStore((s) => s.appSettings.followUpBehavior)
  const setBehavior = useWorkspaceStore((s) => s.setFollowUpBehavior)
  const platform = window.api?.platform
  const chord = renderKeybinding(
    'Primary+Enter',
    platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : 'linux',
  )
  return (
    <SettingCard>
      <SettingRow
        label="When I send while an agent is working"
        help={`Queue sends the message when the agent's turn ends. Steer hands it to the agent while it works, where its CLI can take one; any other chat queues it. ${chord} does the other for one message.`}
      >
        <SegmentedControl<FollowUpBehavior>
          ariaLabel="When I send while an agent is working"
          items={[
            { value: 'queue', label: 'Queue' },
            { value: 'steer', label: 'Steer' },
          ]}
          value={behavior}
          onChange={setBehavior}
        />
      </SettingRow>
    </SettingCard>
  )
}
