import { memo, useMemo, useState, useSyncExternalStore } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";

import type { ConversationImageSource } from "../../api/conversationImages";
import { SkeletonBlock } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { FileTypeGlyph } from "../../components/glyphs";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { iconSize, radius, space, typography, type Theme } from "../../theme/tokens";
import { attachedFileType } from "./attachedFiles";
import { PictureViewer, type SentImages } from "./ConversationImage";
import {
  forgetSentPhoto,
  sentImageLabel,
  sentImageShows,
  sentPhotosVersion,
  sentPhotoUri,
  subscribeSentPhotos,
  type SentImage,
} from "./sentPhotos";

// The pictures a person sent with a message, in their bubble above the words:
// a small rounded square of each, the size the desktop's sent bubble draws
// them, and a tap to see one whole. Each comes from the phone's own copy when
// this phone sent it, else from the desktop where it serves them; a picture
// neither has is named instead (`sentPhotos.ts`).

/** The desktop's sent thumbnail: 64 points square. */
const SQUARE = 64;

export const SentPhotoSquares = memo(function SentPhotoSquares({
  images,
  sent,
}: {
  images: readonly SentImage[];
  sent: SentImages | null;
}) {
  const styles = useThemedStyles(createStyles);
  if (!images.length) return null;
  return (
    <View accessibilityLabel={images.length > 1 ? "Sent pictures" : "Sent picture"} style={styles.squares}>
      {images.map((image, index) => (
        <SentPhotoSquare key={image.id} image={image} label={sentImageLabel(image, index, images.length)} sent={sent} />
      ))}
    </View>
  );
});

function SentPhotoSquare({ image, label, sent }: { image: SentImage; label: string; sent: SentImages | null }) {
  const styles = useThemedStyles(createStyles);
  const [failed, setFailed] = useState<ReadonlySet<"local" | "desktop">>(() => new Set());
  const [loaded, setLoaded] = useState(false);
  const [viewing, setViewing] = useState(false);
  // The phone's copies are restored after start; a square drawn before that
  // takes its photo up when they land.
  useSyncExternalStore(subscribeSentPhotos, sentPhotosVersion);
  const show = sentImageShows(image, { localUri: sentPhotoUri(image.id), served: !!sent, failed });
  const showKey = show.kind === "local" ? `local:${show.uri}` : show.kind === "desktop" ? `desktop:${show.ref}` : "named";
  const source = useMemo<ConversationImageSource | null>(
    () => (show.kind === "local" ? { uri: show.uri } : show.kind === "desktop" && sent ? sent.source(show.ref) : null),
    // The source follows what the square shows, not the object that said so.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showKey, sent],
  );
  if (!source) return <NamedPhoto label={label} />;
  return (
    <Pressable
      accessibilityHint="Opens the picture full screen."
      accessibilityLabel={label}
      accessibilityRole="imagebutton"
      accessibilityState={{ disabled: !loaded, busy: !loaded }}
      disabled={!loaded}
      onPress={() => setViewing(true)}
      style={({ pressed }) => [styles.square, pressed ? styles.pressed : null]}
    >
      <Image
        key={showKey}
        accessibilityIgnoresInvertColors
        accessibilityLabel={label}
        onError={() => {
          // The phone's copy is gone (its picker cache was cleared): the
          // desktop's is asked for instead. The desktop's would not load: the
          // picture is named.
          if (show.kind === "local") forgetSentPhoto(image.id);
          setLoaded(false);
          setFailed((previous) => new Set([...previous, show.kind === "local" ? "local" : "desktop"]));
        }}
        onLoad={() => setLoaded(true)}
        resizeMode="cover"
        source={source}
        style={[StyleSheet.absoluteFill, loaded ? null : styles.hidden]}
      />
      {loaded ? null : <SkeletonBlock label="Loading image" style={StyleSheet.absoluteFill} />}
      <PictureViewer label={label} onClose={() => setViewing(false)} source={source} visible={viewing} />
    </Pressable>
  );
}

/**
 * A picture the phone cannot show, in the square it would have filled: its
 * kind's page and its name, as the desktop draws a picture it no longer has.
 * A long press says the whole name.
 */
function NamedPhoto({ label }: { label: string }) {
  const styles = useThemedStyles(createStyles);
  const toast = useToast();
  const type = attachedFileType(label);
  const showName = () => toast.show(`${label} is on the desktop.`);
  return (
    <Pressable
      accessibilityActions={[{ name: "longpress", label: "Show its name" }]}
      accessibilityLabel={`${label}, on the desktop`}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "longpress") showName();
      }}
      onLongPress={showName}
      style={({ pressed }) => [styles.square, styles.named, pressed ? styles.namedPressed : null]}
    >
      <FileTypeGlyph kind={type.kind} size={iconSize.md} />
      <Text ellipsizeMode="middle" numberOfLines={1} style={styles.name}>
        {label}
      </Text>
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    // On the person's side, as their words are.
    squares: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.xs },
    square: {
      width: SQUARE,
      height: SQUARE,
      borderRadius: radius.control,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
      backgroundColor: colors.bgSurfaceRaised,
      overflow: "hidden",
    },
    pressed: { opacity: 0.8 },
    hidden: { opacity: 0 },
    named: { alignItems: "center", justifyContent: "center", gap: space["2xs"], paddingHorizontal: space["2xs"] },
    namedPressed: { backgroundColor: colors.bgHover },
    name: { ...typography.micro, color: colors.textSubtle, maxWidth: "100%" },
  });
