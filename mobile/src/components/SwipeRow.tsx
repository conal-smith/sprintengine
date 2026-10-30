import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";

import { motionDurations, useReducedMotion } from "./motion";
import { useThemedStyles } from "../theme/ThemeProvider";
import { fontWeight, radius, space, typography, type Theme } from "../theme/tokens";
import {
  SWIPE_ACTION_WIDTH,
  swipeArmed,
  swipeCaptures,
  swipeOffset,
  swipeRelease,
  type SwipeGeometry,
} from "./swipeRowLogic";

export interface SwipeAction {
  key: string;
  label: string;
  icon: ReactNode;
  /** `primary` wears the button's own fill: the action a full swipe does. */
  tone: "primary" | "quiet";
  onPress: () => void;
}

/**
 * A row that slides left to show what can be done to it. The actions sit
 * behind the row, the last one outermost; with `fullSwipe`, dragging the row
 * most of the way across does that one (a tick of the haptics says when a
 * lift would), and the outermost action's colour fills the gap as it goes.
 *
 * Built on React Native's own responder system (`PanResponder`) and
 * `Animated`, with no native gesture library: a sideways drag past
 * `SWIPE_CAPTURE_DX` is taken from the list and from the row's own press, and
 * anything more down than across is left to the list.
 *
 * The actions are hidden from the screen reader: the row offers the same
 * things as its own actions, which a swipe-to-reveal cannot be reached by.
 * One row is open at a time: `onOpen` is handed a way to shut this one, which
 * the list calls when another opens or the list scrolls.
 */
export function SwipeRow({
  actions,
  fullSwipe = false,
  onOpen,
  onSwiping,
  children,
}: {
  actions: SwipeAction[];
  fullSwipe?: boolean;
  /** This row came open, or began to; `shut` puts it back. */
  onOpen?: (shut: () => void) => void;
  /** A drag began (true) or ended (false), so the list can hold its scroll meanwhile. */
  onSwiping?: (swiping: boolean) => void;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const translateX = useRef(new Animated.Value(0)).current;
  const [open, setOpen] = useState(false);
  const rest = useRef(0);
  const armed = useRef(false);
  const live = useRef(true);
  const [rowWidth, setRowWidth] = useState(0);
  const actionsWidth = actions.length * SWIPE_ACTION_WIDTH;
  const geometry = useRef<SwipeGeometry>({ actionsWidth, rowWidth, fullSwipe });
  geometry.current = { actionsWidth, rowWidth, fullSwipe: fullSwipe && actions.length > 0 };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const callbacks = useRef({ onOpen, onSwiping });
  callbacks.current = { onOpen, onSwiping };

  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const moveTo = useCallback(
    (to: number, done?: () => void) => {
      rest.current = to;
      if (reducedMotion) {
        translateX.setValue(to);
        done?.();
        return;
      }
      Animated.timing(translateX, {
        toValue: to,
        duration: motionDurations.base,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => done?.());
    },
    [reducedMotion, translateX],
  );
  const shut = useCallback(() => {
    if (!live.current) return;
    setOpen(false);
    moveTo(0);
  }, [moveTo]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Asked in the capture phase, so a sideways drag is the row's even
        // though its press already holds the touch.
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          actionsRef.current.length > 0 && swipeCaptures(gesture.dx, gesture.dy, rest.current !== 0),
        onPanResponderGrant: () => {
          translateX.stopAnimation();
          armed.current = false;
          callbacks.current.onSwiping?.(true);
          callbacks.current.onOpen?.(shut);
        },
        onPanResponderMove: (_event, gesture) => {
          const offset = swipeOffset(rest.current, gesture.dx, geometry.current);
          translateX.setValue(offset);
          const nowArmed = swipeArmed(offset, geometry.current);
          if (nowArmed !== armed.current) {
            armed.current = nowArmed;
            void Haptics.impactAsync(
              nowArmed ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light,
            ).catch(() => undefined);
          }
        },
        onPanResponderRelease: (_event, gesture) => {
          callbacks.current.onSwiping?.(false);
          const offset = swipeOffset(rest.current, gesture.dx, geometry.current);
          const release = swipeRelease(offset, gesture.vx, geometry.current);
          if (release === "commit") {
            const outermost = actionsRef.current[actionsRef.current.length - 1];
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
            setOpen(false);
            moveTo(-geometry.current.rowWidth, () => {
              outermost?.onPress();
              // A row the action does not take off the list comes back shut.
              if (live.current) moveTo(0);
            });
            return;
          }
          setOpen(release === "open");
          moveTo(release === "open" ? -geometry.current.actionsWidth : 0);
        },
        onPanResponderTerminate: () => {
          callbacks.current.onSwiping?.(false);
          setOpen(false);
          moveTo(0);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [moveTo, shut, translateX],
  );

  // Past the actions' own width the actions ride along with the row's edge,
  // and the outermost one's colour, which lies under the whole row, fills
  // the gap behind them. Transforms alone, so the native driver runs it.
  const ride = translateX.interpolate({
    inputRange: [-Math.max(rowWidth, actionsWidth + 1), -actionsWidth, 0],
    outputRange: [-Math.max(rowWidth - actionsWidth, 1), 0, 0],
    extrapolate: "clamp",
  });
  const outermost = actions[actions.length - 1];

  return (
    <View onLayout={(event: LayoutChangeEvent) => setRowWidth(event.nativeEvent.layout.width)} style={styles.frame}>
      {outermost ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.under, outermost.tone === "primary" ? styles.primary : styles.quiet]}
        >
          <Animated.View style={[styles.strip, { width: actionsWidth, transform: [{ translateX: ride }] }]}>
            {actions.map((action) => (
              <Pressable
                key={action.key}
                onPress={() => {
                  shut();
                  action.onPress();
                }}
                style={({ pressed }) => [
                  styles.action,
                  action.tone === "primary" ? styles.primary : styles.quiet,
                  pressed ? styles.pressed : null,
                ]}
              >
                {action.icon}
                <Text
                  numberOfLines={1}
                  style={[styles.label, action.tone === "primary" ? styles.primaryLabel : styles.quietLabel]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </Animated.View>
        </View>
      ) : null}
      <Animated.View {...responder.panHandlers} style={[styles.front, { transform: [{ translateX }] }]}>
        {children}
        {/* While open, a tap on the row shuts it rather than opening the chat. */}
        {open ? <Pressable accessible={false} onPress={shut} style={StyleSheet.absoluteFill} /> : null}
      </Animated.View>
    </View>
  );
}

const createStyles = (theme: Theme) => {
  const { colors } = theme;
  return StyleSheet.create({
    frame: {
      borderRadius: radius.overlay,
      overflow: "hidden",
    },
    under: {
      ...StyleSheet.absoluteFillObject,
    },
    strip: {
      position: "absolute",
      top: 0,
      bottom: 0,
      right: 0,
      flexDirection: "row",
    },
    action: {
      width: SWIPE_ACTION_WIDTH,
      alignItems: "center",
      justifyContent: "center",
      gap: space["2xs"],
      paddingHorizontal: space.xs,
    },
    quiet: {
      backgroundColor: colors.bgActive,
    },
    primary: {
      backgroundColor: colors.buttonBg,
    },
    pressed: {
      opacity: 0.8,
    },
    label: {
      ...typography.meta,
      fontWeight: fontWeight.emphasis,
      textAlign: "center",
    },
    quietLabel: {
      color: colors.textPrimary,
    },
    primaryLabel: {
      color: colors.buttonInk,
    },
    // Opaque under the row's own tints, so the actions do not show through it.
    front: {
      backgroundColor: colors.bgApp,
      borderRadius: radius.overlay,
    },
  });
};
