import { Linking, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { Path, Rect, Circle } from "react-native-svg";

import { BottomSheet } from "../../components/BottomSheet";
import { GlyphFrame } from "../../components/glyphs/Glyph";
import { FileTypeGlyph } from "../../components/glyphs/FileTypeGlyph";
import {
  iconSize,
  MachineGlyph,
  PullRequestStateGlyph,
  RemoteMachineGlyph,
  ScheduleIcon,
} from "../../components/glyphs";
import { SheetOption } from "../../components/SheetOption";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { pullRequestUrl } from "../../api/conversationWire";
import { radius, space, touchSlop, typography, type Theme } from "../../theme/tokens";
import { desktopMachineMark, type MachineMarkView, type PullRequestMarkView } from "./chatMarks";
import { START_AS_LABELS, type AttachSource, type ComposerOption, type StartAs } from "./composerOptions";

/** A machine's glyph in its colour, then its name in the caller's text ink. */
export function MachineMarkLabel({
  mark,
  textStyle,
  size = iconSize.xs,
}: {
  mark: MachineMarkView;
  textStyle: StyleProp<TextStyle>;
  size?: number;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.markLabel}>
      <MachineGlyph colour={mark.colour} kind={mark.kind} size={size} />
      <Text numberOfLines={1} style={textStyle}>
        {mark.label}
      </Text>
    </View>
  );
}

/**
 * A paired desktop's glyph where the phone chooses between desktops: its own
 * mark when its identity sent one, else the Beam in muted ink.
 */
export function DesktopGlyph({
  desktop,
  size = iconSize.xs,
}: {
  desktop: { deviceId: string; name: string; machineMark?: { kind: string; color: string } | null };
  size?: number;
}) {
  const mark = desktopMachineMark(desktop);
  return mark ? (
    <MachineGlyph colour={mark.colour} kind={mark.kind} size={size} />
  ) : (
    <RemoteMachineGlyph size={size} />
  );
}

/**
 * Opens a pull request in the browser: the address the desktop listed, checked
 * again here, so nothing but a web page is ever handed to the system.
 */
export function openPullRequest(mark: Pick<PullRequestMarkView, "url">): void {
  const url = pullRequestUrl(mark.url);
  if (!url) return;
  void Linking.openURL(url).catch(() => {
    /* No browser to hand it to; the row stays as it was. */
  });
}

/**
 * The mark spoken, saying where it opens: here, where the chat's desktop
 * reads pull requests for the phone, else the browser.
 */
export function pullRequestMarkLabel(mark: Pick<PullRequestMarkView, "accessibilityLabel">, here: boolean): string {
  return here ? mark.accessibilityLabel.replace("Opens it in the browser.", "Opens it here.") : mark.accessibilityLabel;
}

/** The mark's drawn height: one line of meta text. */
const PR_MARK_HEIGHT = typography.meta.lineHeight;

/**
 * A chat's pull request: its state's drawing in the state's tone and its
 * number, opening the pull request in the browser. Its own tap target inside
 * a row that is one too, padded out to the touch floor. A screen reader does
 * not reach it inside a list row, which speaks as one element; the row offers
 * the same action (`accessibilityActions`).
 */
export function PullRequestMarkButton({ mark, onOpen }: { mark: PullRequestMarkView; onOpen?: () => void }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={pullRequestMarkLabel(mark, !!onOpen)}
      accessibilityRole={onOpen ? "button" : "link"}
      hitSlop={touchSlop(PR_MARK_HEIGHT)}
      onPress={onOpen ?? (() => openPullRequest(mark))}
      style={({ pressed }) => [styles.pr, pressed ? styles.pressed : null]}
    >
      <PullRequestStateGlyph color={colors[mark.tone]} size={iconSize.xs} state={mark.state} />
      <Text style={styles.prText}>{mark.text}</Text>
    </Pressable>
  );
}

/**
 * The open chat strip's pull request: the state's drawing and the desktop's
 * words for it ("Open PR #42"), opening it in the browser. Drawn at the
 * strip's item height and padded out to the touch floor.
 */
export function PullRequestStripButton({
  pr,
  height,
  onOpen,
}: {
  pr: { mark: PullRequestMarkView; text: string };
  height: number;
  /** Opens it in the phone's own viewer; absent, the browser. */
  onOpen?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={pullRequestMarkLabel(pr.mark, !!onOpen)}
      accessibilityRole={onOpen ? "button" : "link"}
      hitSlop={touchSlop(height)}
      onPress={onOpen ?? (() => openPullRequest(pr.mark))}
      style={({ pressed }) => [styles.pr, styles.prStrip, { minHeight: height }, pressed ? styles.pressed : null]}
    >
      <PullRequestStateGlyph color={colors[pr.mark.tone]} size={iconSize.xs} state={pr.mark.state} />
      <Text numberOfLines={1} style={styles.prText}>
        {pr.text}
      </Text>
    </Pressable>
  );
}

/** A picture: a frame with a hill and the sun. */
function PhotoGlyph({ color, size = iconSize.sm }: { color: string; size?: number }) {
  return (
    <GlyphFrame color={color} size={size} viewBox="0 0 16 16">
      <Rect fill="none" height="10.4" rx="1.4" stroke="currentColor" strokeWidth={1.4} width="12" x="2" y="2.8" />
      <Path
        d="m2.6 11.4 3.2-3.2 2.4 2.4 1.6-1.6 3.6 3.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.4}
      />
      <Circle cx="10.6" cy="6" fill="none" r="1.1" stroke="currentColor" strokeWidth={1.2} />
    </GlyphFrame>
  );
}

/** A camera: a body, its hump and the lens. */
function CameraGlyph({ color, size = iconSize.sm }: { color: string; size?: number }) {
  return (
    <GlyphFrame color={color} size={size} viewBox="0 0 16 16">
      <Path
        d="M2 5.6c0-.8.6-1.4 1.4-1.4h1.8l1.1-1.6h3.4l1.1 1.6h1.8c.8 0 1.4.6 1.4 1.4v6.6c0 .8-.6 1.4-1.4 1.4H3.4c-.8 0-1.4-.6-1.4-1.4Z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth={1.4}
      />
      <Circle cx="8" cy="8.8" fill="none" r="2.4" stroke="currentColor" strokeWidth={1.4} />
    </GlyphFrame>
  );
}

/**
 * What the composer's "+" opens: the rows `composerOptions` lists, as a sheet.
 * Titled by what it holds: "Attach" while pictures and files are all it offers.
 */
export function ComposerOptionsSheet({
  visible,
  rows,
  onClose,
  onDismiss,
  onAttach,
  onSchedule,
  onStartAs,
}: {
  visible: boolean;
  rows: readonly ComposerOption[];
  onClose: () => void;
  onDismiss?: () => void;
  onAttach: (source: AttachSource) => void;
  onSchedule?: () => void;
  onStartAs?: (kind: StartAs) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const title = rows.some((row) => row.kind !== "attach") ? "Options" : "Attach";
  return (
    <BottomSheet onClose={onClose} onDismiss={onDismiss} title={title} visible={visible}>
      {rows.map((row) =>
        row.kind === "start-as" ? (
          <View accessibilityLabel={row.label} accessibilityRole="radiogroup" key="start-as" style={styles.group}>
            <Text accessibilityRole="header" style={styles.groupLabel}>
              {row.label}
            </Text>
            {row.choices.map((choice) => (
              <SheetOption
                key={choice}
                label={START_AS_LABELS[choice]}
                onPress={() => onStartAs?.(choice)}
                selected={choice === row.selected}
              />
            ))}
          </View>
        ) : row.kind === "schedule" ? (
          <SheetOption
            disabled={row.disabledReason !== null}
            icon={<ScheduleIcon size={iconSize.sm} tone="textMuted" />}
            key="schedule"
            label={row.label}
            onPress={() => onSchedule?.()}
            selected={row.on}
            sub={
              row.disabledReason ??
              (row.on
                ? row.repeats
                  ? "On: tap to start it now instead"
                  : "On: tap to send it now instead"
                : row.repeats
                  ? "Run it later, or on a repeat"
                  : "Send it at a time you pick")
            }
          />
        ) : (
          <SheetOption
            disabled={row.disabledReason !== null}
            icon={
              row.source === "camera" ? (
                <CameraGlyph color={colors.textMuted} />
              ) : row.source === "file" ? (
                <FileTypeGlyph kind="generic" />
              ) : (
                <PhotoGlyph color={colors.textMuted} />
              )
            }
            key={row.source}
            label={row.label}
            onPress={() => onAttach(row.source)}
            sub={row.disabledReason ?? undefined}
          />
        ),
      )}
    </BottomSheet>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    markLabel: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      flexShrink: 1,
      minWidth: 0,
    },
    pr: {
      flexDirection: "row",
      alignItems: "center",
      minHeight: PR_MARK_HEIGHT,
      gap: space["2xs"],
      flexShrink: 0,
      paddingHorizontal: space["2xs"],
      borderRadius: radius.control,
    },
    pressed: {
      backgroundColor: colors.bgHover,
    },
    prStrip: {
      paddingHorizontal: space.sm,
    },
    prText: {
      ...typography.meta,
      color: colors.textMuted,
      fontVariant: ["tabular-nums"],
    },
    group: {
      paddingBottom: space.sm,
    },
    groupLabel: {
      ...typography.micro,
      color: colors.textMuted,
      paddingHorizontal: space.xs,
      paddingBottom: space["2xs"],
    },
  });
