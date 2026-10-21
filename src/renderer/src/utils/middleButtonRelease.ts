/**
 * Cancels the release of the middle-button press now under way, wherever it
 * lands.
 *
 * On Linux, Chromium pastes the primary selection (whatever text was last
 * highlighted) into the focused field when a middle button is released and
 * nothing cancelled the mouseup. Cancelling the mousedown is not enough: it is
 * what keeps focus in the composer when a chat row is closed by a middle
 * press, so the release pasted straight into it.
 *
 * The listener sits on the window, not on the element pressed: a press that
 * closes on mousedown has taken its element out of the document before the
 * button comes back up, so the release lands on whatever slid in under the
 * pointer. A strip that closes on the auxclick instead still has its element,
 * and cancels the release there.
 *
 * It disarms on the next press of any button, so a release lost outside the
 * window cannot cancel a later, wanted paste.
 */
export function cancelNextMiddleButtonRelease(view: Window | null | undefined): void {
  if (!view) return
  const disarm = (): void => {
    view.removeEventListener('mouseup', onMouseUp, true)
    view.removeEventListener('mousedown', disarm, true)
  }
  function onMouseUp(event: MouseEvent): void {
    if (event.button !== 1) return
    event.preventDefault()
    disarm()
  }
  view.addEventListener('mouseup', onMouseUp, true)
  view.addEventListener('mousedown', disarm, true)
}
