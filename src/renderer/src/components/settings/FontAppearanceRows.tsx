import type { JSX } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { MONO_FONT_STACK, UI_FONT_STACK } from '../../utils/fonts'
import { SettingRow } from '../ui'
import { FontFamilyPicker } from './FontFamilyPicker'

/**
 * Appearance → Fonts: the interface's face and code's. Each sets the value of
 * one of the design system's two family tokens — never a third family — with
 * the bundled stack kept behind the choice as its fallback. Both apply as they
 * change, through the store fields `useAppTheme` follows, and code's reaches
 * the terminals and editors that are already open.
 */
export function FontAppearanceRows(): JSX.Element {
  const interfaceFont = useWorkspaceStore((s) => s.appSettings.appearance.interfaceFont)
  const setInterfaceFont = useWorkspaceStore((s) => s.setAppearanceInterfaceFont)
  const codeFont = useWorkspaceStore((s) => s.appSettings.appearance.codeFont)
  const setCodeFont = useWorkspaceStore((s) => s.setAppearanceCodeFont)
  return (
    <>
      <SettingRow label="Interface font" help="Menus, the sidebar, conversations and everything else that isn’t code.">
        <FontFamilyPicker
          label="Interface font"
          value={interfaceFont}
          onChange={setInterfaceFont}
          defaultFamily="Inter"
          defaultStack={UI_FONT_STACK}
        />
      </SettingRow>
      <SettingRow label="Code font" help="Terminals, editors, diffs and code in conversations. Monospace fonts only.">
        <FontFamilyPicker
          label="Code font"
          value={codeFont}
          onChange={setCodeFont}
          defaultFamily="JetBrains Mono"
          defaultStack={MONO_FONT_STACK}
          monospace
        />
      </SettingRow>
    </>
  )
}
