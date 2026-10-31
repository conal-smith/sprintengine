import { useEffect, useSyncExternalStore } from 'react'

import { normalizeFolderKey } from '../../../shared/project-hue'
import type { ProjectIconSetting } from '../../../shared/project-icon'
import { useWorkspaceStore } from '../store/workspaceStore'
import { ensureProjectLogo, getProjectLogoDataUrl, subscribeProjectLogos } from '../utils/projectLogos'
import { useProjectLogo } from './useProjectLogo'

/** What a project's icon slot shows; null keeps the folder glyph. */
export type ProjectIconView = { kind: 'image'; src: string } | { kind: 'monogram'; text: string; hue: number } | null

// A chosen file shares the session store detection uses, under a key no
// folder path can be, so every surface that shows the project reads it once.
export const PROJECT_ICON_FILE_KEY_PREFIX = 'icon-file:'

/** The person's chosen icon for a project folder, or undefined when there is none. */
export function useProjectIconSetting(folderPath: string | null | undefined): ProjectIconSetting | undefined {
  return useWorkspaceStore((s) =>
    folderPath?.trim() ? s.appSettings.projectIcons?.[normalizeFolderKey(folderPath)] : undefined,
  )
}

/**
 * Resolve an icon slot in precedence order: a chosen monogram, then a chosen
 * file (when it can still be read and passes the logo guards), then the
 * detected logo, then nothing. A chosen file that has gone missing falls back
 * to detection rather than to a blank box.
 */
export function resolveProjectIconView(
  setting: ProjectIconSetting | undefined,
  fileSrc: string | null,
  detectedSrc: string | null,
): ProjectIconView {
  if (setting?.kind === 'monogram') return { kind: 'monogram', text: setting.text, hue: setting.hue }
  if (setting?.kind === 'file' && fileSrc) return { kind: 'image', src: fileSrc }
  return detectedSrc ? { kind: 'image', src: detectedSrc } : null
}

export function useProjectIcon(folderPath: string | null | undefined): ProjectIconView {
  const setting = useProjectIconSetting(folderPath)
  const filePath = setting?.kind === 'file' ? setting.path : null
  const fileKey = filePath ? `${PROJECT_ICON_FILE_KEY_PREFIX}${filePath}` : null
  useEffect(() => {
    if (!filePath || !fileKey) return
    ensureProjectLogo(fileKey, () => window.api.readProjectIconFile(filePath))
  }, [fileKey, filePath])
  const fileSrc = useSyncExternalStore(
    subscribeProjectLogos,
    () => getProjectLogoDataUrl(fileKey),
    () => null,
  )
  // A monogram needs no detection; a chosen file still has it as its fallback.
  const detectedSrc = useProjectLogo(setting?.kind === 'monogram' ? null : folderPath)
  return resolveProjectIconView(setting, fileSrc, detectedSrc)
}
