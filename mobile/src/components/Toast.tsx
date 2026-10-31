import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CloseIcon, iconSize, StatusShape, type StatusShapeTone } from "./glyphs";
import { motionDurations, useReducedMotion } from "./motion";
import { useThemedStyles } from "../theme/ThemeProvider";
import { cardShadow, radius, space, typography, type Theme, fontWeight } from "../theme/tokens";

export type ToastTone = "neutral" | "success" | "warn" | "error";

export interface ToastInput {
  title: string;
  /** The one muted line under the title. Optional — many toasts are a title. */
  message?: string;
  tone?: ToastTone;
  /** Tapping the toast goes somewhere: the thread that finished. */
  onPress?: () => void;
  /**
   * One thing to do about what the toast says, as a button beside its text:
   * Undo, after a settle or a snooze. Pressing it dismisses the toast.
   */
  action?: { label: string; onPress: () => void };
  /**
   * How long it stays, in ms, when the tone's default is wrong for it. `false`
   * keeps it until it is dismissed — for the rare toast that asks a question
   * and cannot be answered anywhere else.
   */
  autoDismissMs?: number | false;
}

interface ToastMessage extends ToastInput {
  id: number;
}

export interface ToastApi {
  /** `show("Committed.", "success")` for a bare line, or an object for the card. */
  show: (input: string | ToastInput, tone?: ToastTone) => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * How long each tone stays before it clears itself, in ms (desktop, 2026-09-28).
 *
 * Every tone leaves now; warn and error used to stay until dismissed. They
 * stay twice as long as an acknowledgement, because they are the ones worth
 * reading, and a press holds any toast for as long as it is being read.
 */
export const TOAST_AUTO_DISMISS_MS: Record<ToastTone, number> = {
  neutral: 5_000,
  success: 5_000,
  warn: 10_000,
  error: 10_000,
};

/**
 * One transient-feedback surface for the whole app: the studio's `Toast` — a
 * glass card with a tone shape, a bold title, a muted line and a dismiss —
 * pinned above the tab bar and announced as a live region. Pressing and
 * holding the card holds its clock; letting go starts the full time again, so
 * a toast being read is never pulled out from under a thumb.
 *
 * It is the near half of notices. The far half is the bell, which
 * holds the same events after the toast has gone. Neither is a store: both are
 * derived from the thread state the phone already holds.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const idRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((input: string | ToastInput, tone: ToastTone = "neutral") => {
    idRef.current += 1;
    const next: ToastMessage =
      typeof input === "string"
        ? { id: idRef.current, title: input, tone }
        : { ...input, tone: input.tone ?? tone, id: idRef.current };
    setMessage(next);
  }, []);

  const clearClock = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearClock();
    setMessage(null);
    opacity.setValue(0);
  }, [clearClock, opacity]);

  // The whole time again, from now: on show, and each time a held toast is let go.
  const startClock = useCallback(
    (current: ToastMessage) => {
      clearClock();
      const duration = current.autoDismissMs ?? TOAST_AUTO_DISMISS_MS[current.tone ?? "neutral"];
      if (duration === false) return;

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (reducedMotion) {
          setMessage(null);
          opacity.setValue(0);
          return;
        }
        // Only clear when the fade-out actually completed: a show() or a press
        // landing in this fade-out window interrupts the animation, and its
        // callback still fires (finished: false) — unguarded, it would null the
        // NEW message, or the one being held.
        Animated.timing(opacity, { toValue: 0, duration: motionDurations.base, useNativeDriver: true }).start(
          ({ finished }) => {
            if (finished) {
              setMessage(null);
            }
          },
        );
      }, duration);
    },
    [clearClock, opacity, reducedMotion],
  );

  // A thumb on the card stops the clock, and stops a fade already under way.
  const hold = useCallback(() => {
    clearClock();
    opacity.stopAnimation();
    opacity.setValue(1);
  }, [clearClock, opacity]);

  useEffect(() => {
    if (!message) {
      return;
    }

    if (reducedMotion) {
      opacity.setValue(1);
    } else {
      Animated.timing(opacity, { toValue: 1, duration: motionDurations.fast, useNativeDriver: true }).start();
    }
    startClock(message);

    return clearClock;
  }, [message, opacity, reducedMotion, startClock, clearClock]);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [dismiss, show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {message ? (
        <Animated.View pointerEvents="box-none" style={[styles.host, { bottom: insets.bottom + space["4xl"], opacity }]}>
          <Pressable
            accessibilityLabel={[message.title, message.message].filter(Boolean).join(". ")}
            accessibilityLiveRegion="polite"
            accessibilityRole={message.onPress ? "button" : "alert"}
            // Never disabled, even with nowhere to go: a toast that only says
            // something still has to hold its clock while it is pressed.
            onPress={
              message.onPress
                ? () => {
                    message.onPress?.();
                    dismiss();
                  }
                : undefined
            }
            onPressIn={hold}
            onPressOut={() => startClock(message)}
            style={styles.toast}
          >
            <View pointerEvents="none" style={styles.edge} />
            <View style={styles.shape}>
              <StatusShape size={iconSize.sm} tone={SHAPE_TONE[message.tone ?? "neutral"]} />
            </View>
            <View style={styles.text}>
              <Text style={styles.title}>{message.title}</Text>
              {message.message ? <Text style={styles.line}>{message.message}</Text> : null}
            </View>
            {message.action ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={space.sm}
                onPress={() => {
                  message.action?.onPress();
                  dismiss();
                }}
                style={({ pressed }) => [styles.action, pressed ? styles.actionPressed : null]}
              >
                <Text style={styles.actionText}>{message.action.label}</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityLabel="Dismiss" accessibilityRole="button" onPress={dismiss} style={styles.close}>
              <CloseIcon size={iconSize.sm} tone="textSubtle" />
            </Pressable>
          </Pressable>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const SHAPE_TONE: Record<ToastTone, StatusShapeTone> = {
  neutral: "neutral",
  success: "good",
  warn: "warn",
  error: "danger",
};

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) {
    // A no-op keeps a caller outside the provider (e.g. a test renderer) safe.
    return { show: () => undefined, dismiss: () => undefined };
  }
  return api;
}

const createStyles = (theme: Theme) => {
  const { colors } = theme;
  return StyleSheet.create({
    host: {
      position: "absolute",
      left: space.xl,
      right: space.xl,
    },
    // The studio's glass card. It floats over content, so like the popover it
    // keeps a shadow in both themes — the ring alone cannot lift it off a list.
    // The top edge is lit, the desktop's inset highlight: a card held up to
    // the light rather than a box drawn on the page. It sits inside the ring
    // (see `edge`), so the card keeps its outline along the top on a light list.
    toast: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.md,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
      paddingHorizontal: space.lg,
      paddingVertical: space.lg,
      shadowColor: colors.cardShadowColor,
      shadowOpacity: theme.isDark ? 0.5 : 0.2,
      shadowOffset: cardShadow.offset,
      shadowRadius: cardShadow.radius,
      elevation: 8,
    },
    edge: {
      position: "absolute",
      top: 0,
      left: radius.overlay,
      right: radius.overlay,
      height: StyleSheet.hairlineWidth * 2,
      backgroundColor: colors.toastEdge,
    },
    // Centres the 16pt shape on the title's 21pt first line.
    shape: {
      paddingTop: space["3xs"],
    },
    text: {
      flex: 1,
      minWidth: 0,
      gap: space["3xs"],
    },
    title: {
      ...typography.body,
      fontWeight: fontWeight.emphasis,
      color: colors.textPrimary,
    },
    line: {
      ...typography.meta,
      color: colors.textMuted,
    },
    action: {
      minHeight: 32,
      paddingHorizontal: space.sm,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radius.control,
    },
    actionPressed: {
      opacity: 0.6,
    },
    // The one thing to do about it, in the title's ink: green is the brand's,
    // not an action's.
    actionText: {
      ...typography.body,
      fontWeight: fontWeight.emphasis,
      color: colors.textPrimary,
      textDecorationLine: "underline",
    },
    close: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
  });
};
