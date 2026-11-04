import { useId, useState } from 'react'

import { OutlineButton } from '../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { ConversationImportPicker, useConversationImportSelection } from '../onboarding/ConversationImportPicker'
import { useConversationImportScan, type ConversationImportScan } from '../onboarding/useConversationImportScan'
import { SettingsRow } from './SettingsAtoms'

// Settings → Agents' way into the import the first-run card offers once: the
// sessions run in Claude Code or Codex, brought in as chats at any time. Each
// opening scans again, so a session run since the last import is listed.
export function ConversationImportSettings() {
  const [open, setOpen] = useState(false)
  // A row (and its dialog); Settings ▸ Agents sets it in the card of chat
  // behaviour.
  return (
    <>
      <SettingsRow
        label="Import conversations"
        help="Bring in sessions you ran in Claude Code or Codex. Each becomes a chat that carries on the same session."
      >
        {/* The row's action as the outline button every Settings row action
            is, so it does not read as a stray label beside the next card's. */}
        <OutlineButton size="sm" onClick={() => setOpen(true)}>
          Choose sessions…
        </OutlineButton>
      </SettingsRow>
      {open ? <ConversationImportDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function ConversationImportDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const scan = useConversationImportScan()
  return (
    <Modal open onClose={onClose} labelledBy={titleId} size="standard">
      <ModalHeader
        titleId={titleId}
        title="Import conversations"
        subtitle="Sessions from the last 30 days are picked. A session that is already a chat here stays as it is."
        onClose={onClose}
      />
      {scan.status === 'ready' ? (
        <ConversationImportReady scan={scan} onClose={onClose} />
      ) : (
        <>
          <ModalBody>
            <ConversationImportPicker scan={scan} selected={new Set()} onSelectedChange={() => undefined} />
          </ModalBody>
          <ModalFooter>
            <ModalButton onClick={onClose}>Close</ModalButton>
          </ModalFooter>
        </>
      )}
    </Modal>
  )
}

function ConversationImportReady({
  scan,
  onClose,
}: {
  scan: Extract<ConversationImportScan, { status: 'ready' }>
  onClose: () => void
}) {
  const { selected, setSelected, importing, runImport } = useConversationImportSelection(scan.folders)
  return (
    <>
      <ModalBody>
        <ConversationImportPicker scan={scan} selected={selected} onSelectedChange={setSelected} disabled={importing} />
      </ModalBody>
      <ModalFooter>
        <ModalButton disabled={importing} onClick={onClose}>
          Cancel
        </ModalButton>
        <ModalButton
          variant="primary"
          disabled={importing || selected.size === 0}
          onClick={() => {
            void runImport().then((imported) => {
              if (imported) onClose()
            })
          }}
        >
          {importing ? 'Importing…' : selected.size === 1 ? 'Import 1 session' : `Import ${selected.size} sessions`}
        </ModalButton>
      </ModalFooter>
    </>
  )
}
