import { useState, type ReactNode } from "react";
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  ChevronIcon,
  CliLogo,
  CloseIcon,
  CollapseIcon,
  ExpandIcon,
  FileTypeGlyph,
  PlusIcon,
  iconSize,
} from "../../components/glyphs";
import { IconButton } from "../../components/IconButton";
import { useReducedMotion } from "../../components/motion";
import { SendButton } from "../../components/SendButton";
import { useSheetHandoff } from "../../components/useSheetHandoff";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, radius, space, touchSlop, typography, type Theme } from "../../theme/tokens";
import { ComposerOptionsSheet } from "./ChatMarkViews";
import { attachedFileType, middleTruncateFileName } from "./attachedFiles";
import { composerOptionsLabel, type AttachSource, type ComposerOption } from "./composerOptions";
import { QueueGlyph, SendGlyph, SteerGlyph, StopGlyph } from "./toolGlyphs";
import { DictationButton } from "../dictation/DictationButton";
import type { DictationState } from "../dictation/useDictation";

// The composer's small controls, drawn under the touch floor and padded out
// to it with `touchSlop`: the "+" and the model, and a picture's remove cross.
const CONTROL_SIZE = 36;
const TAG_REMOVE_SIZE = 22;
// A picture waiting to be sent, drawn as itself: the sent bubble's 64-point
// square, a little smaller in the box so the words keep the room.
const THUMB_SIZE = 56;
// A chat's box grows with its words to this height, then scrolls inside.
const INPUT_MAX_HEIGHT = 140;

type ComposerAction = {
  kind: "send" | "stop";
  label: string;
  disabled: boolean;
  onPress: () => void;
  followUp?: "queue" | "steer";
  hint?: string;
  onLongPress?: () => void;
};
type ComposerInput = {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  editable: boolean;
  accessibilityLabel: string;
  autoFocus?: boolean;
};

/**
 * The one composer, New's and the chat's alike (the
 * desktop's New chat composer): one box, rounder than a card, holding the
 * words, the pictures they carry, and on the same ground with no rule between
 * them the controls. Left to right: the "+" (pictures, where the chat takes
 * them), a tag for each choice that is not the default, the model picker (the
 * access lives in its sheet, as the desktop's engine picker keeps it), the
 * microphone, and a small round send in the accent, or stop while a reply
 * runs. Every control but the send is ghost. While a reply runs and words
 * are in the box, the send queues or steers them (drawn as which) and a ghost
 * stop sits beside it, so the reply can still be stopped without emptying the
 * box first.
 *
 * The box wears `composerSurface`, one step above the conversation's ground,
 * washing 55% toward it at the bottom. `strip` is drawn tucked under the box.
 *
 * A chat's box stops growing at five or six lines and scrolls inside. Once
 * the words pass that, an expand control sits in the box's top corner and
 * opens the draft full screen (`ComposerEditor`), with the same send and a
 * collapse back; New's box already takes the screen, so it has none.
 */
export function ChatComposer({
  fill = false,
  input,
  attachments = [],
  attachmentsLocked = false,
  options,
  tags,
  picker,
  dictation,
  action,
  strip,
  stop,
}: {
  /** New: the box takes the screen's height. A chat's grows with its words to a ceiling. */
  fill?: boolean;
  input: ComposerInput;
  /**
   * The pictures and files the next message carries, inside the box above its
   * controls: a picture as a thumbnail of its file on this phone (`uri`), or
   * by its name where there is none; a `file` by its kind's glyph and its name.
   */
  attachments?: { key: string; name: string; uri?: string; file?: boolean; onRemove: () => void }[];
  attachmentsLocked?: boolean;
  /** What the "+" holds; no rows, no "+". `onSchedule` answers a Schedule row. */
  options?: {
    rows: readonly ComposerOption[];
    disabled: boolean;
    busy: boolean;
    onAttach: (source: AttachSource) => void;
    onSchedule?: () => void;
  } | null;
  tags?: ReactNode;
  /** The CLI's mark and the model. `onPress` absent: read-only, no chevron. */
  picker?: {
    cli: string | null;
    label: string;
    accessibilityLabel: string;
    onPress?: () => void;
    disabled?: boolean;
  } | null;
  dictation: { state: DictationState; onToggle: () => void; disabled: boolean };
  /** `followUp`: what a send mid-turn does, drawn on the send; a long press does the other. */
  action: ComposerAction;
  strip?: ReactNode;
  /** A stop beside the send, while a reply runs and the box holds words. */
  stop?: { label: string; disabled: boolean; onPress: () => void } | null;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [optionsOpen, setOptionsOpen] = useState(false);
  // The picker opens once the sheet it was chosen from has gone.
  const handoff = useSheetHandoff();
  const rows = options?.rows ?? [];
  // Whether the words have outgrown the box, and whether they are open full screen.
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const expandable = !fill && overflowing && input.value.length > 0;
  return (
    <View style={fill ? styles.fillWrap : null}>
      <View style={[styles.box, fill ? styles.boxFill : null]}>
        <TextInput
          accessibilityLabel={input.accessibilityLabel}
          autoFocus={input.autoFocus}
          editable={input.editable}
          multiline
          onChangeText={input.onChangeText}
          onContentSizeChange={
            fill ? undefined : (event) => setOverflowing(event.nativeEvent.contentSize.height > INPUT_MAX_HEIGHT)
          }
          placeholder={input.placeholder}
          placeholderTextColor={colors.textSubtle}
          scrollEnabled
          style={[styles.input, fill ? styles.inputFill : styles.inputGrow, expandable ? styles.inputBesideExpand : null]}
          value={input.value}
        />
        {expandable ? (
          <Pressable
            accessibilityHint="Opens the message full screen to read and edit it."
            accessibilityLabel="Expand the message"
            accessibilityRole="button"
            hitSlop={touchSlop(CONTROL_SIZE, CONTROL_SIZE)}
            onPress={() => setExpanded(true)}
            style={({ pressed }) => [styles.round, styles.expand, pressed ? styles.pressed : null]}
          >
            <ExpandIcon size={iconSize.sm} tone="textMuted" />
          </Pressable>
        ) : null}

        {attachments.length ? (
          <View style={styles.tags}>
            {attachments.map((attachment) =>
              attachment.uri ? (
                <View key={attachment.key} accessibilityLabel={attachment.name} style={styles.thumb}>
                  <Image source={{ uri: attachment.uri }} style={styles.thumbImage} resizeMode="cover" />
                  <Pressable
                    accessibilityLabel={`Remove ${attachment.name}`}
                    accessibilityRole="button"
                    disabled={attachmentsLocked}
                    hitSlop={touchSlop(TAG_REMOVE_SIZE, TAG_REMOVE_SIZE)}
                    onPress={attachment.onRemove}
                    style={({ pressed }) => [styles.thumbRemove, pressed ? styles.pressed : null]}
                  >
                    <CloseIcon size={iconSize.xs - 2} tone="textDefault" />
                  </Pressable>
                </View>
              ) : (
                <View
                  key={attachment.key}
                  accessibilityLabel={attachment.file ? `File ${attachment.name}` : undefined}
                  style={styles.tag}
                >
                  {attachment.file ? <FileTypeGlyph kind={attachedFileType(attachment.name).kind} size={iconSize.xs} /> : null}
                  <Text numberOfLines={1} style={styles.tagText}>
                    {attachment.file ? middleTruncateFileName(attachment.name) : attachment.name}
                  </Text>
                  <Pressable
                    accessibilityLabel={`Remove ${attachment.name}`}
                    accessibilityRole="button"
                    disabled={attachmentsLocked}
                    hitSlop={touchSlop(TAG_REMOVE_SIZE, TAG_REMOVE_SIZE)}
                    onPress={attachment.onRemove}
                    style={({ pressed }) => [styles.tagRemove, pressed ? styles.pressed : null]}
                  >
                    <CloseIcon size={iconSize.xs - 2} tone="textMuted" />
                  </Pressable>
                </View>
              ),
            )}
          </View>
        ) : null}

        <View style={styles.controls}>
          {rows.length && options ? (
            <Pressable
              accessibilityLabel={options.busy ? "Adding a picture" : composerOptionsLabel(rows)}
              accessibilityRole="button"
              accessibilityState={{ disabled: options.disabled }}
              disabled={options.disabled}
              hitSlop={touchSlop(CONTROL_SIZE, CONTROL_SIZE)}
              onPress={() => setOptionsOpen(true)}
              style={({ pressed }) => [styles.round, pressed ? styles.pressed : null]}
            >
              <PlusIcon size={iconSize.sm} tone="textMuted" />
            </Pressable>
          ) : null}
          {tags}
          <View style={styles.grow} />
          {picker ? (
            <Pressable
              accessibilityLabel={picker.accessibilityLabel}
              accessibilityRole="button"
              accessibilityState={{ disabled: !picker.onPress || !!picker.disabled }}
              disabled={!picker.onPress || picker.disabled}
              hitSlop={touchSlop(CONTROL_SIZE)}
              onPress={picker.onPress}
              style={({ pressed }) => [styles.picker, pressed ? styles.pressed : null]}
            >
              <CliLogo cli={picker.cli} size={iconSize.xs} />
              <Text numberOfLines={1} style={[styles.pickerText, picker.disabled ? styles.pickerOff : null]}>
                {picker.label}
              </Text>
              {picker.onPress ? <ChevronIcon direction="down" size={iconSize.xs - 2} tone="textSubtle" /> : null}
            </Pressable>
          ) : null}
          <DictationButton disabled={dictation.disabled} onPress={dictation.onToggle} state={dictation.state} />
          {stop ? (
            <Pressable
              accessibilityLabel={stop.label}
              accessibilityRole="button"
              accessibilityState={{ disabled: stop.disabled }}
              disabled={stop.disabled}
              hitSlop={touchSlop(CONTROL_SIZE, CONTROL_SIZE)}
              onPress={stop.onPress}
              style={({ pressed }) => [styles.round, pressed ? styles.pressed : null]}
            >
              <StopGlyph color={colors.textMuted} size={iconSize.sm} />
            </Pressable>
          ) : null}
          <SendButton
            disabled={action.disabled}
            hint={action.hint}
            label={action.label}
            onLongPress={action.onLongPress}
            onPress={action.onPress}
            renderIcon={(ink) => actionGlyph(action, colors[ink])}
            variant={action.kind}
          />
        </View>
      </View>
      {strip}
      {fill ? null : (
        <ComposerEditor action={action} input={input} onCollapse={() => setExpanded(false)} visible={expanded} />
      )}
      {options ? (
        <ComposerOptionsSheet
          onAttach={(source) => {
            setOptionsOpen(false);
            handoff.after(() => options.onAttach(source));
          }}
          onSchedule={() => {
            setOptionsOpen(false);
            handoff.after(() => options.onSchedule?.());
          }}
          onClose={() => setOptionsOpen(false)}
          onDismiss={handoff.onDismiss}
          rows={rows}
          visible={optionsOpen}
        />
      ) : null}
    </View>
  );
}

function actionGlyph(action: ComposerAction, color: string) {
  if (action.kind === "stop") return <StopGlyph color={color} size={iconSize.sm} />;
  if (action.followUp === "steer") return <SteerGlyph color={color} size={iconSize.sm} />;
  if (action.followUp === "queue") return <QueueGlyph color={color} size={iconSize.sm} />;
  return <SendGlyph color={color} size={iconSize.sm} />;
}

/**
 * The draft full screen: the same words, bound to the same draft, with
 * collapse at the top left and the composer's own send (queue or steer,
 * long press and all) at the top right, clear of the keyboard. Sending
 * collapses it, as does the system back.
 */
function ComposerEditor({
  visible,
  input,
  action,
  onCollapse,
}: {
  visible: boolean;
  input: ComposerInput;
  action: ComposerAction;
  onCollapse: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  return (
    <Modal animationType={reducedMotion ? "none" : "slide"} onRequestClose={onCollapse} visible={visible}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.editorWrap}>
        <View
          accessibilityViewIsModal
          style={[
            styles.editor,
            {
              paddingTop: insets.top,
              paddingBottom: insets.bottom + space.sm,
              paddingLeft: insets.left,
              paddingRight: insets.right,
            },
          ]}
        >
          <View style={styles.editorBar}>
            <IconButton
              icon={<CollapseIcon size={iconSize.md} tone="textPrimary" />}
              label="Collapse the message"
              onPress={onCollapse}
            />
            <View style={styles.grow} />
            <SendButton
              disabled={action.disabled}
              hint={action.hint}
              label={action.label}
              onLongPress={
                action.onLongPress
                  ? () => {
                      action.onLongPress?.();
                      onCollapse();
                    }
                  : undefined
              }
              onPress={() => {
                action.onPress();
                if (action.kind === "send") onCollapse();
              }}
              renderIcon={(ink) => actionGlyph(action, colors[ink])}
              variant={action.kind}
            />
          </View>
          <TextInput
            accessibilityLabel={input.accessibilityLabel}
            autoFocus
            editable={input.editable}
            multiline
            onChangeText={input.onChangeText}
            placeholder={input.placeholder}
            placeholderTextColor={colors.textSubtle}
            scrollEnabled
            style={[styles.input, styles.editorInput]}
            value={input.value}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    fillWrap: { flex: 1, minHeight: 0 },
    // Above the strip, which runs up under its lower edge. The wash is drawn
    // where the platform draws gradients; the flat ground under it is the
    // wash's top stop, so a platform without them shows the composer's step.
    box: {
      zIndex: 1,
      borderRadius: radius.composer,
      borderWidth: 1,
      borderColor: colors.borderDefault,
      backgroundColor: colors.composerSurface,
      experimental_backgroundImage: `linear-gradient(${colors.composerSurface}, ${colors.composerSurfaceEnd})`,
      paddingTop: space.lg,
      paddingBottom: space.sm,
      gap: space.sm,
    },
    // No floor on a filling box's height: a floor taller than what the
    // keyboard leaves pushed the box past its wrap, and the controls were
    // drawn over the last lines.
    boxFill: { flex: 1, minHeight: 0 },
    input: {
      ...typography.body,
      fontSize: 16,
      color: colors.textPrimary,
      paddingHorizontal: space.xl,
      paddingVertical: 0,
      textAlignVertical: "top",
    },
    inputFill: { flex: 1, minHeight: 0, paddingTop: space["2xs"] },
    // An explicit line height and top alignment keep the box as tall as the
    // lines it draws: measured against the body style's line height with the
    // size raised to 16, a long message spilled past the box and the row
    // under it was drawn over its last lines.
    inputGrow: { lineHeight: 22, minHeight: 24, maxHeight: INPUT_MAX_HEIGHT },
    // Room for the expand control in the box's top corner, so it covers no words.
    inputBesideExpand: { paddingRight: space.xs + CONTROL_SIZE },
    expand: { position: "absolute", top: space["2xs"], right: space["2xs"] },
    editorWrap: { flex: 1, backgroundColor: colors.bgApp },
    editor: { flex: 1 },
    editorBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: space.sm,
      paddingVertical: space["2xs"],
    },
    editorInput: { flex: 1, lineHeight: 24, paddingTop: space.md },
    tags: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: space.xs,
      paddingHorizontal: space.lg,
    },
    tag: {
      flexDirection: "row",
      alignItems: "center",
      gap: space["2xs"],
      height: 28,
      maxWidth: 200,
      paddingLeft: space.sm,
      paddingRight: space["3xs"],
      borderRadius: radius.control,
      backgroundColor: colors.agentInset,
    },
    tagText: { ...typography.meta, color: colors.textDefault, flexShrink: 1 },
    thumb: {
      width: THUMB_SIZE,
      height: THUMB_SIZE,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
      backgroundColor: colors.bgSurfaceRaised,
      overflow: "hidden",
    },
    thumbImage: { width: "100%", height: "100%" },
    // The cross sits on the picture's corner, on a disc of the box's own
    // ground so it reads over a light photo and a dark one alike.
    thumbRemove: {
      position: "absolute",
      top: space["3xs"],
      right: space["3xs"],
      width: TAG_REMOVE_SIZE,
      height: TAG_REMOVE_SIZE,
      borderRadius: TAG_REMOVE_SIZE / 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.composerSurface,
    },
    tagRemove: {
      width: TAG_REMOVE_SIZE,
      height: TAG_REMOVE_SIZE,
      borderRadius: radius.control,
      alignItems: "center",
      justifyContent: "center",
    },
    controls: {
      flexDirection: "row",
      alignItems: "center",
      gap: space["2xs"],
      paddingHorizontal: space.sm,
      minWidth: 0,
    },
    grow: { flex: 1 },
    // Ghost: no edge and no ground until pressed. The send is the one fill.
    round: {
      width: CONTROL_SIZE,
      height: CONTROL_SIZE,
      borderRadius: radius.chip,
      alignItems: "center",
      justifyContent: "center",
    },
    pressed: { backgroundColor: colors.bgHover },
    // Gives way before the send does: a long model name ellipsizes.
    picker: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      height: CONTROL_SIZE,
      paddingHorizontal: space.sm,
      borderRadius: radius.chip,
      flexShrink: 1,
      minWidth: 0,
    },
    pickerText: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textDefault,
      flexShrink: 1,
    },
    pickerOff: { color: colors.textSubtle },
  });
