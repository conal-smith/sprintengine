import { useEffect, useMemo, useRef } from 'react'

import { getEffectiveKeybindings, type KeybindingSettingsLike } from '../../../commands/effectiveKeybindings'
import type { KeybindingPlatform } from '../../../commands/keybindings'
import type { Workspace } from '../../../types/workspace'
import { onWindowVisibilityChange } from '../../../utils/windowActivity'
import { numberedChatRows } from '../manager/numberedChats'
import {
  CHAT_JUMP_COMMAND_IDS,
  chatJumpHintStore,
  chatJumpHintsByRow,
  chatJumpTriggerModifiers,
  createChatJumpHintController,
} from './chatJumpHints'

/**
 * Drives the number keys' hints for the whole sidebar: ONE keydown and keyup
 * listener on the window, in the capture phase so a terminal or an editor
 * holding focus cannot keep the keys from it. The rows read their own hint
 * from `useChatJumpHint`; nothing here renders.
 *
 * Which rows get which chord is worked out once, at the moment the hints
 * appear, from the tree as it is drawn then (`numberedChatRows`) — the same
 * reading `workspace.switch.N` makes when the chord is pressed. Off while
 * `enabled` is false: a collapsed sidebar, or one a door's rail has replaced,
 * has no rows on screen to label.
 */
export function useChatJumpHints({
  enabled,
  workspaces,
  keybindings,
  platform,
}: {
  enabled: boolean
  /** The rail's chats, as the switch commands count them. */
  workspaces: readonly Workspace[]
  keybindings: KeybindingSettingsLike | null | undefined
  platform: KeybindingPlatform
}): void {
  const chords = useMemo(
    () => CHAT_JUMP_COMMAND_IDS.map((commandId) => getEffectiveKeybindings(commandId, keybindings)[0] ?? null),
    [keybindings],
  )
  const triggers = useMemo(() => chatJumpTriggerModifiers(chords, platform), [chords, platform])
  // Read at the moment they are needed, so the listener is installed once and
  // not again each time a chat moves or a binding changes.
  const latest = useRef({ workspaces, chords, triggers })
  useEffect(() => {
    latest.current = { workspaces, chords, triggers }
  }, [workspaces, chords, triggers])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const controller = createChatJumpHintController({
      triggers: () => latest.current.triggers,
      onVisibleChange: (visible) => {
        if (!visible) {
          chatJumpHintStore.publish(null)
          return
        }
        const rows = numberedChatRows(document, latest.current.workspaces, Date.now())
        chatJumpHintStore.publish(chatJumpHintsByRow(rows, latest.current.chords))
      },
    })
    const onKeyDown = (event: KeyboardEvent): void => controller.keyDown(event)
    const onKeyUp = (event: KeyboardEvent): void => controller.keyUp(event)
    // Blur and a hidden window both mean the keyup may never arrive here.
    const onBlur = (): void => controller.cancel()
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    const unwatchVisibility = onWindowVisibilityChange((visible) => {
      if (!visible) controller.cancel()
    })
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      unwatchVisibility()
      controller.dispose()
      chatJumpHintStore.publish(null)
    }
  }, [enabled])
}
