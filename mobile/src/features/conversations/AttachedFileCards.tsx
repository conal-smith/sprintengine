import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { FileTypeGlyph } from "../../components/glyphs";
import { useToast } from "../../components/Toast";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, iconSize, radius, space, typography, type Theme } from "../../theme/tokens";
import { attachedFileName, attachedFileType, middleTruncateFileName, type AttachedFile } from "./attachedFiles";

// The files a person attached to a message, under their bubble: one quiet card
// each, the desktop's sent card cut down to what a phone can say about a file
// on another machine. Its kind's glyph, its name cut in the middle so the
// extension stays, and the kind in words. The phone cannot open a desktop's
// path, so a tap does nothing; a long press says the whole path, the way the
// strip's marks say what they are.

export const AttachedFileCards = memo(function AttachedFileCards({ files }: { files: readonly AttachedFile[] }) {
  const styles = useThemedStyles(createStyles);
  if (!files.length) return null;
  return (
    <View accessibilityLabel="Attached files" style={styles.cards}>
      {files.map((file) => (
        <AttachedFileCard key={file.path} path={file.path} />
      ))}
    </View>
  );
});

function AttachedFileCard({ path }: { path: string }) {
  const styles = useThemedStyles(createStyles);
  const toast = useToast();
  const name = attachedFileName(path);
  const type = attachedFileType(name);
  const showPath = () => toast.show(path);
  return (
    <Pressable
      accessibilityActions={[{ name: "longpress", label: "Show its path" }]}
      accessibilityHint="Long press to show where it is on the desktop."
      accessibilityLabel={`Attached file ${name}, ${type.label}`}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "longpress") showPath();
      }}
      onLongPress={showPath}
      style={({ pressed }) => [styles.card, pressed ? styles.cardPressed : null]}
    >
      <FileTypeGlyph kind={type.kind} size={iconSize.md} />
      <View style={styles.words}>
        <Text ellipsizeMode="middle" numberOfLines={1} style={styles.name}>
          {middleTruncateFileName(name)}
        </Text>
        <Text style={styles.type}>{type.label}</Text>
      </View>
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    // The person's side of the transcript, as their bubble is.
    cards: {
      alignSelf: "flex-end",
      maxWidth: "84%",
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "flex-end",
      gap: space.xs,
    },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      maxWidth: "100%",
      paddingVertical: space.sm,
      paddingLeft: space.md,
      paddingRight: space.lg,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
      backgroundColor: colors.agentInset,
    },
    cardPressed: { backgroundColor: colors.bgHover },
    words: { flexShrink: 1, minWidth: 0 },
    name: { ...typography.meta, fontWeight: fontWeight.medium, color: colors.textPrimary },
    type: { ...typography.micro, color: colors.textSubtle },
  });
