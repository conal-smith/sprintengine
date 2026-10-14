/**
 * Whether a key belongs to an input method rather than to the field it was typed in: a key
 * pressed while a composition is open, or the one that commits or cancels it.
 * WebKit sends the committing Enter (and the Escape that drops a candidate
 * list) with `isComposing` already false, but still as keyCode 229, so the
 * flag alone lets that Enter submit half-typed words.
 *
 * Every Enter (and Escape, and arrow) handler on a text field asks this first:
 * the key is the input method's while it is composing.
 */
export function isImeKey(
  event:
    Pick<KeyboardEvent, 'isComposing' | 'keyCode'> | { nativeEvent: Pick<KeyboardEvent, 'isComposing' | 'keyCode'> },
): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  return native.isComposing || native.keyCode === 229
}
