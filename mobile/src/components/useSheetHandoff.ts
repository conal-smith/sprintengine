import { useCallback, useRef } from "react";
import { Platform } from "react-native";

/**
 * What a sheet that is closing hands on to: the next sheet, a popover, the
 * photo picker. iOS presents nothing over a screen while a sheet is still
 * sliding away, so whatever opens in the same moment never appears (and a
 * picker that never appears never answers, leaving its composer busy for
 * good). On iOS `after` holds the action until the closing sheet reports it
 * has gone, through `onDismiss`, which goes on that sheet; Android's sheets
 * are dialogs that step aside at once, so it runs there and then.
 *
 * Use `after` only from inside a sheet that is open and closing in the same
 * moment: one that is already shut never reports, and the action would wait
 * for nothing.
 */
export function useSheetHandoff() {
  const next = useRef<(() => void) | null>(null);
  const after = useCallback((action: () => void) => {
    if (Platform.OS === "ios") next.current = action;
    else action();
  }, []);
  const onDismiss = useCallback(() => {
    const action = next.current;
    next.current = null;
    action?.();
  }, []);
  return { after, onDismiss };
}
