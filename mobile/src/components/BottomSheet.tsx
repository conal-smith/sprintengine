import { useEffect, type ReactNode } from "react";
import { Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useReducedMotion } from "./motion";
import { useThemedStyles } from "../theme/ThemeProvider";
import { space, typography, type Theme } from "../theme/tokens";

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Sheet heading, read to the screen reader as the dialog's name. */
  title: string;
  /** A close affordance the scrim already provides; this labels the dialog. */
  closeLabel?: string;
  /** iOS: the sheet has finished sliding away (see `useSheetHandoff`). */
  onDismiss?: () => void;
  children: ReactNode;
}

/**
 * One bottom sheet for the whole app: a scrim over the canvas and a rounded panel
 * on the bottom edge that takes the home-indicator inset. Extracted from the
 * near-identical Modal the desktop picker shipped, so the filter sheet, project
 * picker, and create forms all read and animate the same.
 *
 * The body scrolls inside the sheet so a tall control set (nine view options) can
 * never push its actions off-screen. The sheet rides up over the keyboard, so a
 * field in it (the model picker's search) is never typed into blind. Opening
 * one puts away the keyboard of whatever it opened over (the composer's), which
 * otherwise stayed up and covered half the sheet; a field inside the sheet
 * brings it back when tapped.
 */
export function BottomSheet({ visible, onClose, title, closeLabel, onDismiss, children }: BottomSheetProps) {
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (visible) Keyboard.dismiss();
  }, [visible]);

  return (
    <Modal
      animationType={reducedMotion ? "none" : "slide"}
      onDismiss={onDismiss}
      onRequestClose={onClose}
      transparent
      visible={visible}
    >
      <Pressable
        accessibilityLabel={closeLabel ?? `Close ${title}`}
        accessibilityRole="button"
        onPress={onClose}
        style={styles.scrim}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        pointerEvents="box-none"
        style={styles.keyboard}
      >
        <View style={[styles.sheet, { paddingBottom: insets.bottom + space.xl }]}>
          <View accessibilityRole="header" style={styles.handleRow}>
            <View style={styles.handle} />
          </View>
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          <ScrollView
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
            style={styles.bodyScroll}
          >
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    scrim: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: colors.overlayScrim,
    },
    // The sheet's column: the whole screen, passing touches through to the
    // scrim, with the sheet at its foot.
    keyboard: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: "flex-end",
    },
    sheet: {
      maxHeight: "82%",
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      backgroundColor: colors.bgApp,
      paddingHorizontal: space["2xl"],
      paddingTop: space.sm,
    },
    handleRow: {
      alignItems: "center",
      paddingBottom: space.sm,
    },
    handle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.bgSelected,
    },
    title: {
      ...typography.title,
      letterSpacing: -0.3,
      color: colors.textPrimary,
      paddingBottom: space.lg,
    },
    bodyScroll: {
      flexGrow: 0,
    },
    body: {
      gap: space.sm,
      paddingBottom: space.sm,
    },
  });
