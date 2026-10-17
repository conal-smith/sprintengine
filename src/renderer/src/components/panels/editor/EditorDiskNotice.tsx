import React from 'react'
import { GhostButton, InlineNotice, OutlineButton } from '../../ui'

/**
 * What the file on disk did under an editor tab that the person has to know
 * about: it changed while the tab had unsaved edits (holding what it changed
 * to), or it is gone. Shared by the docked editor and the pop-out editor
 * window, which say it the same way.
 */
export type EditorDiskNoticeState = { kind: 'changed'; content: string } | { kind: 'deleted' }

export function EditorDiskNotice({
  notice,
  onReload,
  onKeepMine,
}: {
  notice: EditorDiskNoticeState
  onReload: () => void
  onKeepMine: () => void
}) {
  return (
    <div className="shrink-0 px-3 pt-2 pb-1">
      {notice.kind === 'changed' ? (
        <InlineNotice
          tone="warn"
          title="Changed on disk"
          hint="This file changed on disk while it had unsaved edits here. Reload takes the version on disk; Keep mine keeps yours, and the next save writes it over the other."
          action={
            <>
              <OutlineButton size="xs" onClick={onReload}>
                Reload
              </OutlineButton>
              <GhostButton size="xs" onClick={onKeepMine}>
                Keep mine
              </GhostButton>
            </>
          }
        />
      ) : (
        <InlineNotice
          tone="warn"
          title="Deleted on disk"
          hint="The file is gone from disk. It stays open here, and saving writes it back."
        />
      )}
    </div>
  )
}

/** The question a save asks before it writes over a version on disk the tab never showed. */
export function overwriteOnDiskConfirmation(fileName: string) {
  return {
    title: `Overwrite ${fileName}?`,
    body: 'It changed on disk after it was opened here, perhaps by an agent. Saving replaces that version with yours.',
    confirmLabel: 'Overwrite',
    tone: 'danger' as const,
  }
}
