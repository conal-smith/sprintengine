import { useWorkspaceStore } from '../../store/workspaceStore'
import { APP_THEMES, systemThemeChoices, type ResolvedAppTheme } from '../../types/appTheme'
import { Select } from '../ui'
import { SettingCard, SettingsRow } from './SettingsAtoms'

const labelOf = (id: ResolvedAppTheme): string => APP_THEMES.find((theme) => theme.id === id)?.label ?? id

/**
 * Which theme "System" paints on each side of the OS's light/dark switch.
 * Shown only while System is the theme: under any other, the switch changes
 * nothing.
 */
export function SystemThemeRows() {
  const theme = useWorkspaceStore((s) => s.appSettings.appearance.theme)
  const light = useWorkspaceStore((s) => s.appSettings.appearance.systemLightTheme)
  const dark = useWorkspaceStore((s) => s.appSettings.appearance.systemDarkTheme)
  const setSystemTheme = useWorkspaceStore((s) => s.setAppearanceSystemTheme)
  if (theme !== 'system') return null
  return (
    <SettingCard>
      <SettingsRow label="In light mode" help="The theme System uses while the OS is set to light.">
        <Select<ResolvedAppTheme>
          ariaLabel="Theme in light mode"
          items={systemThemeChoices('light').map((id) => ({ value: id, label: labelOf(id) }))}
          value={light}
          onChange={(next) => setSystemTheme('light', next)}
        />
      </SettingsRow>
      <SettingsRow label="In dark mode" help="The theme System uses while the OS is set to dark.">
        <Select<ResolvedAppTheme>
          ariaLabel="Theme in dark mode"
          items={systemThemeChoices('dark').map((id) => ({ value: id, label: labelOf(id) }))}
          value={dark}
          onChange={(next) => setSystemTheme('dark', next)}
        />
      </SettingsRow>
    </SettingCard>
  )
}
