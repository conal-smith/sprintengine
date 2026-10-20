import React, { useState } from 'react'
import { ContextMenu, MenuItem } from '../../ui'
import { copyToClipboardWithToast } from '../../../utils/copyToClipboardWithToast'

/** What a message's right-click menu copies. Built only when an item is picked. */
export type MessageCopySource = {
  /** The menu's accessible name: what was right-clicked, "Reply" or "Message". */
  name: string
  /** The item that copies both flavours, named as the row's glyph is: "Copy reply". */
  label: string
  /** The markdown, which is the plain flavour and all that Copy as Markdown writes. */
  markdown: () => string
  /** The rendered flavour beside it. */
  html: () => string
}

/**
 * The right-click menu on a message or a reply: Copy, which writes the markdown
 * and its rendered HTML so a paste into an email or a document keeps the
 * formatting, and Copy as Markdown beside it, which writes the markdown alone
 * for the editor that should show the source. The row's copy glyph does the
 * first on a click and the second on a Shift-click; this is where the second
 * can be found without knowing that.
 *
 * A right-click something inside already answered (a file link's own menu) and
 * one in a field are left alone.
 */
export function useMessageCopyMenu(source: MessageCopySource | null): {
  onContextMenu: (event: React.MouseEvent) => void
  menu: React.ReactNode
} {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null)
  const onContextMenu = (event: React.MouseEvent) => {
    if (!source || event.defaultPrevented) return
    const target = event.target as Element | null
    if (target?.closest?.('input, textarea, [contenteditable="true"]')) return
    event.preventDefault()
    setPoint({ x: event.clientX, y: event.clientY })
  }
  const close = () => setPoint(null)
  const menu =
    point && source ? (
      <ContextMenu x={point.x} y={point.y} ariaLabel={source.name} onClose={close}>
        <MenuItem
          onClick={() => {
            close()
            void copyToClipboardWithToast(source.markdown, { html: source.html })
          }}
        >
          {source.label}
        </MenuItem>
        <MenuItem
          onClick={() => {
            close()
            void copyToClipboardWithToast(source.markdown)
          }}
        >
          Copy as Markdown
        </MenuItem>
      </ContextMenu>
    ) : null
  return { onContextMenu, menu }
}
