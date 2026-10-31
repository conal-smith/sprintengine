import React from 'react'

import {
  normalizeMonogramText,
  suggestedMonogram,
  PROJECT_MONOGRAM_MAX_CHARS,
  type ProjectIconSetting,
} from '../../../../../shared/project-icon'
import { PROJECT_ICON_FILE_KEY_PREFIX, useProjectIconSetting } from '../../../hooks/useProjectIcon'
import { useProjectLogo } from '../../../hooks/useProjectLogo'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { PROJECT_COLOR_PRESETS, PROJECT_SWATCH_CLASS, projectColorStyle } from '../../../utils/projectColor'
import { forgetProjectLogo } from '../../../utils/projectLogos'
import { basename } from '../../../utils/paths'
import { FolderTypeIcon } from '../../AppIcons'
import { Field, Input, OutlineButton, SegmentedControl } from '../../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../../ui/Modal'
import { ProjectMonogram } from '../ProjectMonogram'

// Choose a project's icon: the one detected in its repo (the default), an image
// file of the person's, or a monogram generated from its name on one of the
// picker's named hues. Opened from the project header's menu.
//
// A chosen file is read through main's logo guards before it is offered, so
// the preview here is exactly what the sidebar will show, and a file the
// guards refuse (too large, not an image, an SVG with scripts or outside
// references) is said here rather than saved and silently ignored.

type Mode = 'detected' | 'file' | 'monogram'

const MODE_ITEMS: Array<{ value: Mode; label: string }> = [
  { value: 'detected', label: 'Detected' },
  { value: 'file', label: 'Image file' },
  { value: 'monogram', label: 'Monogram' },
]

const REFUSED_FILE =
  'That file cannot be a project icon: it is over 1 MB, not an image, or an SVG with scripts or outside references.'

// The named hue nearest a project's own, so a monogram starts in the colour
// the project already wears.
export function nearestPresetHue(hue: number): number {
  let best = PROJECT_COLOR_PRESETS[0].hue
  let bestDistance = Infinity
  for (const preset of PROJECT_COLOR_PRESETS) {
    const raw = Math.abs(preset.hue - hue) % 360
    const distance = Math.min(raw, 360 - raw)
    if (distance < bestDistance) {
      best = preset.hue
      bestDistance = distance
    }
  }
  return best
}

export function ProjectIconDialog({
  folderPath,
  projectHue,
  onClose,
}: {
  /** The project's folder; null keeps the dialog closed. */
  folderPath: string | null
  /** The hue the project wears now, which a new monogram starts from. */
  projectHue: number | null
  onClose: () => void
}) {
  return (
    <Modal open={folderPath !== null} onClose={onClose} labelledBy="project-icon-title" size="standard">
      {folderPath ? (
        <ProjectIconDialogBody key={folderPath} folderPath={folderPath} projectHue={projectHue} onClose={onClose} />
      ) : null}
    </Modal>
  )
}

function ProjectIconDialogBody({
  folderPath,
  projectHue,
  onClose,
}: {
  folderPath: string
  projectHue: number | null
  onClose: () => void
}) {
  const current = useProjectIconSetting(folderPath)
  const setProjectIcon = useWorkspaceStore((s) => s.setProjectIcon)
  const detectedSrc = useProjectLogo(folderPath)
  const name = basename(folderPath) || folderPath
  const fieldId = React.useId()

  const [mode, setMode] = React.useState<Mode>(current?.kind ?? 'detected')
  const [file, setFile] = React.useState<{ path: string; src: string | null } | null>(
    current?.kind === 'file' ? { path: current.path, src: null } : null,
  )
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [text, setText] = React.useState(current?.kind === 'monogram' ? current.text : suggestedMonogram(name))
  const [hue, setHue] = React.useState(
    current?.kind === 'monogram' ? current.hue : nearestPresetHue(projectHue ?? PROJECT_COLOR_PRESETS[0].hue),
  )

  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const readFile = React.useCallback(async (path: string) => {
    const logo = await window.api.readProjectIconFile(path).catch(() => null)
    if (!mounted.current) return
    setFile({ path, src: logo?.dataUrl ?? null })
    setFileError(logo ? null : REFUSED_FILE)
  }, [])

  // The saved file is read again on open, so its preview is the file as it is now.
  const savedFilePath = current?.kind === 'file' ? current.path : null
  React.useEffect(() => {
    if (savedFilePath) void readFile(savedFilePath)
  }, [readFile, savedFilePath])

  const chooseFile = async () => {
    const picked = await window.api.openProjectIconFile({ defaultPath: file?.path ?? folderPath }).catch(() => null)
    if (picked) await readFile(picked)
  }

  const monogram = normalizeMonogramText(text)
  const next: ProjectIconSetting | null | undefined =
    mode === 'detected'
      ? null
      : mode === 'file'
        ? file?.src
          ? { kind: 'file', path: file.path }
          : undefined
        : monogram
          ? { kind: 'monogram', text: monogram, hue }
          : undefined

  const save = () => {
    if (next === undefined) return
    if (next?.kind === 'file') forgetProjectLogo(`${PROJECT_ICON_FILE_KEY_PREFIX}${next.path}`)
    setProjectIcon(folderPath, next)
    onClose()
  }

  const preview =
    mode === 'monogram' ? (
      monogram ? (
        <ProjectMonogram className="icon-lg" text={monogram} hue={hue} />
      ) : (
        <FolderTypeIcon className="icon-lg" />
      )
    ) : (
      <FolderTypeIcon className="icon-lg" logoSrc={mode === 'file' ? (file?.src ?? null) : detectedSrc} />
    )

  return (
    <>
      <ModalHeader
        titleId="project-icon-title"
        title={`Icon for ${name}`}
        subtitle="Shown beside the project in the sidebar and the project picker, on this machine."
        onClose={onClose}
      />
      <ModalBody className="flex flex-col gap-4">
        <SegmentedControl ariaLabel="Icon source" items={MODE_ITEMS} value={mode} onChange={setMode} />

        <div className="flex items-start gap-4">
          <div
            className="flex shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[color:var(--bg-well)] p-3"
            data-testid="project-icon-preview"
          >
            {preview}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {mode === 'detected' ? (
              <p className="text-meta text-[color:var(--text-muted)]">
                {detectedSrc
                  ? 'The logo found in the project’s folder.'
                  : 'No logo was found in the project’s folder, so it shows the folder glyph.'}
              </p>
            ) : null}

            {mode === 'file' ? (
              <>
                <div className="flex min-w-0 items-center gap-2">
                  <OutlineButton size="sm" onClick={() => void chooseFile()}>
                    {file ? 'Choose another…' : 'Choose file…'}
                  </OutlineButton>
                  {file ? (
                    <span
                      className="min-w-0 truncate font-mono text-micro text-[color:var(--text-subtle)]"
                      title={file.path}
                    >
                      {basename(file.path) || file.path}
                    </span>
                  ) : null}
                </div>
                {fileError ? (
                  <p role="alert" className="text-micro leading-4 text-[color:var(--tone-error)]">
                    {fileError}
                  </p>
                ) : (
                  <p className="text-micro text-[color:var(--text-subtle)]">
                    SVG, PNG, JPEG, GIF, WebP, ICO or ICNS, up to 1 MB.
                  </p>
                )}
              </>
            ) : null}

            {mode === 'monogram' ? (
              <>
                <Field label="Letters" htmlFor={`${fieldId}-letters`}>
                  <Input
                    id={`${fieldId}-letters`}
                    size="sm"
                    value={text}
                    onChange={(event) => setText(normalizeMonogramText(event.target.value))}
                    maxLength={PROJECT_MONOGRAM_MAX_CHARS * 2}
                    spellCheck={false}
                    autoComplete="off"
                    className="w-20 font-mono"
                  />
                </Field>
                <SegmentedControl
                  ariaLabel="Monogram color"
                  iconOnly
                  items={PROJECT_COLOR_PRESETS.map((preset) => ({
                    value: String(preset.hue),
                    label: preset.label,
                    icon: (
                      <span
                        aria-hidden="true"
                        className={`block icon-xs rounded-full ${PROJECT_SWATCH_CLASS}`}
                        style={projectColorStyle(preset.hue)}
                      />
                    ),
                  }))}
                  value={String(hue)}
                  onChange={(value) => setHue(Number(value))}
                />
              </>
            ) : null}
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <ModalButton onClick={onClose}>Cancel</ModalButton>
        <ModalButton variant="primary" disabled={next === undefined} onClick={save}>
          Save
        </ModalButton>
      </ModalFooter>
    </>
  )
}
