// A press inside the page reaches no one outside it.
//
// The `<webview>` guest is its own WebContents, so a click on the page is
// delivered there and never to this document. Every menu, popover and pointer
// card in the app closes on a press outside itself, heard as a `pointerdown`
// or `mousedown` on the window — so clicking into the page beside an open menu
// left the menu standing over it. What this document does hear is focus
// leaving it for the guest, as it leaves for an iframe: the window blurs with
// the `<webview>` as its active element (the element itself gets no `focus`
// event). That moment is replayed here as the press the page swallowed,
// bubbling from the element, so every outside-press check sees a press outside
// its surface.
export function replayGuestFocusAsPress(element: HTMLElement): () => void {
  const view = element.ownerDocument.defaultView
  if (!view) return () => undefined
  const onBlur = () => {
    if (element.ownerDocument.activeElement !== element) return
    const Pointer = typeof view.PointerEvent === 'function' ? view.PointerEvent : view.MouseEvent
    element.dispatchEvent(new Pointer('pointerdown', { bubbles: true, composed: true, button: 0 }))
    element.dispatchEvent(new view.MouseEvent('mousedown', { bubbles: true, composed: true, button: 0 }))
  }
  view.addEventListener('blur', onBlur)
  return () => view.removeEventListener('blur', onBlur)
}
