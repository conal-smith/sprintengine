// Pure decisions behind the workspace bar's open-in-editor split button (item
// 1990): which targets the menu offers, which one the primary half runs, and
// what each is called. Kept out of WorkspaceIdentity.tsx so the probe-hide rule
// and the stale-remembered-target fallback are testable without a render.

import {
  FOLDER_OPEN_TARGET_IDS,
  type FolderOpenTargetAvailability,
  type FolderOpenTargetId,
} from '../../../../shared/folder-open-targets'

/**
 * The targets to offer, in the shared id order (which is also the preference
 * order: the editors, then the file manager).
 *
 * Probe-hide, not probe-disable: a target the probe reports unavailable is
 * absent, the same rule the agent pickers follow for uninstalled CLIs. A
 * disabled row for a missing editor is a fake affordance. A target missing from
 * the probe result entirely is treated as unavailable rather than assumed
 * present — the probe is the only thing that knows.
 */
export function availableFolderOpenTargets(
  availability: readonly FolderOpenTargetAvailability[] | null,
): FolderOpenTargetId[] {
  if (!availability) return []
  return FOLDER_OPEN_TARGET_IDS.filter((id) => availability.some((entry) => entry.id === id && entry.available))
}

/**
 * The target the primary half runs: the remembered one while it still resolves,
 * else the first that does — `FOLDER_OPEN_TARGET_IDS` is in preference order.
 *
 * A remembered target that has since been uninstalled falls back rather than
 * arming a click that can only fail. Null when nothing resolves, which is the
 * signal not to render the control at all.
 */
export function resolveFolderOpenPrimary(
  available: readonly FolderOpenTargetId[],
  remembered: FolderOpenTargetId | null,
): FolderOpenTargetId | null {
  if (remembered && available.includes(remembered)) return remembered
  return available[0] ?? null
}

/**
 * Whether the control has a genuine choice to offer, i.e. whether it renders as
 * a split button at all. With only the file manager resolving there is nothing
 * to choose between, and a chevron whose menu holds one row — already the
 * primary — is a control that opens to say nothing.
 */
export function offersFolderOpenMenu(available: readonly FolderOpenTargetId[]): boolean {
  return available.length > 1
}

const EDITOR_LABELS: Record<Exclude<FolderOpenTargetId, 'finder'>, string> = {
  vscode: 'VS Code',
  'vscode-insiders': 'VS Code Insiders',
  vscodium: 'VSCodium',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  trae: 'Trae',
  kiro: 'Kiro',
  antigravity: 'Antigravity',
  zed: 'Zed',
  sublime: 'Sublime Text',
  intellij: 'IntelliJ IDEA',
  webstorm: 'WebStorm',
  pycharm: 'PyCharm',
  goland: 'GoLand',
  clion: 'CLion',
  phpstorm: 'PhpStorm',
  rider: 'Rider',
  rubymine: 'RubyMine',
  rustrover: 'RustRover',
  datagrip: 'DataGrip',
}

/**
 * What a target is called in the UI. The file manager's name belongs to the OS,
 * not to us: "Finder" is only true on macOS.
 */
export function folderOpenTargetLabel(target: FolderOpenTargetId, isMac: boolean): string {
  if (target === 'finder') return isMac ? 'Finder' : 'File manager'
  return EDITOR_LABELS[target]
}
