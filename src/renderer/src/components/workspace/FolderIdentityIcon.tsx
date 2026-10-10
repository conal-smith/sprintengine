import { isProjectlessChatsRoot } from '../../../../shared/projectless-chats'
import { FolderTypeIcon, NoProjectGlyph } from '../AppIcons'
import { useProjectLogo } from '../../hooks/useProjectLogo'
import type { ProjectColor } from '../../utils/projectColor'

// A folder header's identity in its icon slot: the project's own logo when the
// repo at that path has one at its top level, and the folder glyph when it does
// not (re-sited by the owner on 2026-09-02).
//
// This exists so the logo lookup lives in ONE place. `FolderTypeIcon` stays a
// leaf that takes a `logoSrc` string and knows nothing about detection, and the
// sidebar — which renders its folder headers inside a `.map()`, where a hook
// would be illegal — gets a component it can use there. It replaces
// `WorkspaceIdentityIcon`: the logo used to hang off every workspace row, which
// repeated one project's mark once per chat; it now hangs off the one header
// that names the project.
//
// The project's colour (one-colour-per-project, 2026-09-09) rides the same
// slot, and the logo still wins: a detected logo already answers "which project
// is this", so a hue behind it would be a second answer to one question. The
// colour is what the glyph falls back to, not a mark of its own — which is why
// both props go straight through to `FolderTypeIcon` rather than being resolved
// here.
export function FolderIdentityIcon({
  folderPath,
  className,
  color,
  unfiled,
}: {
  folderPath: string | null | undefined
  className?: string
  /** The project's hue, or null for a project with no colour. */
  color?: ProjectColor | null
  /** No folder is not a project: the dashed grey outline, never a hue. */
  unfiled?: boolean
}) {
  // The "No project" root is not a project: no logo to look for, no hue, its
  // own mark wherever a project's folder would be.
  const projectless = isProjectlessChatsRoot(folderPath)
  const logoSrc = useProjectLogo(projectless ? null : folderPath)
  if (projectless) return <NoProjectGlyph className={className} />
  return <FolderTypeIcon className={className} logoSrc={logoSrc} color={color} unfiled={unfiled} />
}
