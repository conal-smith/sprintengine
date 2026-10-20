import { useEffect, useMemo, useRef, useState } from "react";
import { Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  conversationImageProblemText,
  type ConversationImageProblem,
  type ConversationImageSource,
} from "../../api/conversationImages";
import type { ConversationApi } from "../../api/tailnetConversations";
import { declaresConversationImages, declaresMessageImages } from "../../api/tailnetTransport";
import type { MobileSession } from "../../api/types";
import { IconButton } from "../../components/IconButton";
import { SkeletonBlock } from "../../components/Skeleton";
import { CloseIcon, iconSize } from "../../components/glyphs";
import { useReducedMotion } from "../../components/motion";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { radius, space, typography, type Theme } from "../../theme/tokens";
import { fitPicture, type ToolPicture } from "./conversationImageLogic";

// A chat's pictures as the transcript draws them: fetched from the paired
// desktop, sized to their own proportions, and opened full screen on a tap.

/** One chat's pictures, by the tool call that made or read each. */
export type ChatImages = {
  source(toolUseId: string): ConversationImageSource;
  problem(toolUseId: string): Promise<ConversationImageProblem>;
};

/**
 * The chat's pictures, or null when there are none to fetch: the desktop does
 * not declare `conversation-images` (an older Studio has no route for them),
 * or there is no desktop to ask. Null draws no picture and no placeholder —
 * the steps read as they did before.
 */
export function useChatImages(
  session: MobileSession | undefined,
  api: ConversationApi | null | undefined,
  key: { workspaceId: string; agentId: string },
): ChatImages | null {
  const declared = !!session && declaresConversationImages(session);
  const { workspaceId, agentId } = key;
  return useMemo(
    () =>
      declared && api
        ? {
            source: (toolUseId) => api.imageSource({ workspaceId, agentId, toolUseId }),
            problem: (toolUseId) => api.imageProblem({ workspaceId, agentId, toolUseId }),
          }
        : null,
    [declared, api, workspaceId, agentId],
  );
}

/** One chat's sent pictures on the desktop, by the `ref` each message recorded. */
export type SentImages = { source(ref: string): ConversationImageSource };

/**
 * The pictures the person sent in this chat, as the desktop serves them, or
 * null when it does not (`conversation-message-images`): the phone then draws
 * its own copies of what it sent, and names the rest.
 */
export function useSentImages(
  session: MobileSession | undefined,
  api: ConversationApi | null | undefined,
  key: { workspaceId: string; agentId: string },
): SentImages | null {
  const declared = !!session && declaresMessageImages(session);
  const { workspaceId, agentId } = key;
  return useMemo(
    () =>
      declared && api ? { source: (attachment) => api.imageSource({ workspaceId, agentId, attachment }) } : null,
    [declared, api, workspaceId, agentId],
  );
}

// A transcript's rows mount and unmount as it scrolls. What a picture's size
// turned out to be, and a refusal that will not change, outlive the row: the
// picture comes back at its size without a jump, and a picture the desktop no
// longer has is not asked for again. A failure that might pass (no answer) is
// held by the row alone, so it is tried again the next time the row is drawn.
const knownSizes = new Map<string, { width: number; height: number }>();
const knownProblems = new Map<string, ConversationImageProblem>();

const MAX_HEIGHT = 320;
const PLACEHOLDER_HEIGHT = 180;

/**
 * One picture in the transcript: a pulse while it loads, then the picture at
 * its own proportions (as wide as the column, no taller than a third of a
 * phone), its caption under it, and a tap to see it whole. A picture that
 * cannot load leaves one quiet line saying why.
 */
export function ConversationPicture({
  images,
  toolUseId,
  picture,
}: {
  images: ChatImages;
  toolUseId: string;
  picture: ToolPicture;
}) {
  const styles = useThemedStyles(createStyles);
  const source = useMemo(() => images.source(toolUseId), [images, toolUseId]);
  const key = source.uri;
  const [natural, setNatural] = useState(() => knownSizes.get(key) ?? null);
  const [problem, setProblem] = useState<ConversationImageProblem | null>(() => knownProblems.get(key) ?? null);
  const [width, setWidth] = useState(0);
  const [viewing, setViewing] = useState(false);
  // One question to the desktop per failure, however often the image says so.
  const asked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (problem)
    return (
      <Text accessibilityRole="text" style={styles.problem}>
        {conversationImageProblemText(problem)}
      </Text>
    );
  const size = natural && width ? fitPicture(natural, { maxWidth: width, maxHeight: MAX_HEIGHT }) : null;
  return (
    <View style={styles.figure} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <Pressable
        accessibilityHint="Opens the picture full screen."
        accessibilityLabel={picture.label}
        accessibilityRole="imagebutton"
        accessibilityState={{ disabled: !natural, busy: !natural }}
        disabled={!natural}
        onPress={() => setViewing(true)}
        style={({ pressed }) => [styles.frame, size ?? styles.placeholder, pressed ? styles.pressed : null]}
      >
        <Image
          accessibilityIgnoresInvertColors
          accessibilityLabel={picture.label}
          onError={() => {
            if (asked.current) return;
            asked.current = true;
            void images.problem(toolUseId).then((found) => {
              if (found !== "unavailable") knownProblems.set(key, found);
              if (mounted.current) setProblem(found);
            });
          }}
          onLoad={(event) => {
            const { width: naturalWidth, height: naturalHeight } = event.nativeEvent.source;
            const next = { width: naturalWidth, height: naturalHeight };
            knownSizes.set(key, next);
            if (!natural || natural.width !== next.width || natural.height !== next.height) setNatural(next);
          }}
          resizeMode="contain"
          source={source}
          style={[StyleSheet.absoluteFill, natural ? null : styles.hidden]}
        />
        {natural ? null : <SkeletonBlock label="Loading image" style={StyleSheet.absoluteFill} />}
      </Pressable>
      {picture.caption ? (
        <Text numberOfLines={3} style={styles.caption}>
          {picture.caption}
        </Text>
      ) : null}
      <PictureViewer
        caption={picture.caption}
        label={picture.label}
        onClose={() => setViewing(false)}
        source={source}
        visible={viewing}
      />
    </View>
  );
}

/** The picture on its own, over everything: the whole of it, its caption, and a way back. */
export function PictureViewer({
  visible,
  source,
  label,
  caption,
  onClose,
}: {
  visible: boolean;
  source: ConversationImageSource;
  label: string;
  caption?: string;
  onClose: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  return (
    <Modal animationType={reducedMotion ? "none" : "fade"} onRequestClose={onClose} transparent visible={visible}>
      <View
        accessibilityViewIsModal
        style={[
          styles.viewer,
          {
            paddingTop: insets.top,
            paddingBottom: insets.bottom + space.lg,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          },
        ]}
      >
        <View style={styles.viewerBar}>
          <IconButton icon={<CloseIcon size={iconSize.md} tone="textPrimary" />} label="Close picture" onPress={onClose} />
        </View>
        <Image
          accessibilityIgnoresInvertColors
          accessibilityLabel={label}
          accessible
          resizeMode="contain"
          source={source}
          style={styles.viewerImage}
        />
        {caption ? (
          <ScrollView style={styles.viewerCaption}>
            <Text selectable style={styles.viewerCaptionText}>
              {caption}
            </Text>
          </ScrollView>
        ) : null}
      </View>
    </Modal>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    figure: { alignSelf: "stretch", alignItems: "flex-start", gap: space.xs, paddingVertical: space.xs },
    frame: {
      borderRadius: radius.overlay,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
      overflow: "hidden",
    },
    placeholder: { width: "100%", height: PLACEHOLDER_HEIGHT },
    pressed: { opacity: 0.8 },
    hidden: { opacity: 0 },
    caption: { ...typography.meta, color: colors.textSubtle },
    problem: { ...typography.meta, color: colors.textSubtle, paddingVertical: space.xs },
    viewer: { flex: 1, backgroundColor: colors.bgApp },
    viewerBar: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: space.sm },
    viewerImage: { flex: 1, width: "100%" },
    viewerCaption: { flexGrow: 0, maxHeight: 120, paddingHorizontal: space["2xl"], paddingTop: space.md },
    viewerCaptionText: { ...typography.body, color: colors.textDefault },
  });
