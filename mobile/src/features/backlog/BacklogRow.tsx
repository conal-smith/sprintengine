import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { cardSurface } from "../../components/Card";
import { formatTimestamp } from "../../components/formatTimestamp";
import {
  BacklogTypeGlyph,
  CriticalityBars,
  DifficultyLabel,
  LifecycleGlyph,
  type LifecycleState,
} from "../../components/glyphs";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { space, typography, withAlpha, type Theme, fontWeight } from "../../theme/tokens";
import {
  backlogStatusLabel,
  backlogHighlightHexByTheme,
  epicBandHexByTheme,
  epicColor,
  triageSummary,
  type BacklogEpicMeta,
  type BacklogRowItem,
} from "./backlogLogic";
import type { MobileControlBacklogItemStatus } from "../../shared/mobile-control";

// Backlog readiness maps onto the shared lifecycle vocabulary: `completed`
// becomes the `done` check, the rest are named identically.
const STATUS_TO_LIFECYCLE: Record<MobileControlBacklogItemStatus, LifecycleState> = {
  idea: "idea",
  ready: "ready",
  in_progress: "in_progress",
  needs_input: "needs_input",
  completed: "done",
  archived: "archived",
};

interface BacklogRowProps {
  item: BacklogRowItem;
  onPress: () => void;
  /** When the row renders under a By-epic group, the shared band hue fills it. */
  banded?: boolean;
  /** The first row in a group draws no top hairline (the header already caps it). */
  leading?: boolean;
  /**
   * The snapshot's metadata for the epic this row points at, when the
   * workspace published any. Supplies the chip's real colour and display id; the
   * slug hash stands in when it is absent.
   */
  epicMeta?: BacklogEpicMeta;
}

/**
 * The desktop `BacklogRow`, phone-sized: a leading lifecycle (or epic-type) glyph,
 * the title, and a single meta line — mono id · difficulty · criticality · epic
 * dot + slug · right-aligned relative time. 44 pt minimum, one accent, one status mark.
 */
function BacklogRowImpl({ item, onPress, banded, leading, epicMeta }: BacklogRowProps) {
  const styles = useThemedStyles(createStyles);
  const { name } = useTheme();
  const isEpic = item.type === "epic";
  const triage = triageSummary(item);
  const bandHex = banded ? epicBandHexByTheme[name] : null;

  return (
    <Pressable
      accessibilityHint="Opens the item"
      accessibilityLabel={`${item.title}, ${backlogStatusLabel[item.status]}${triage ? `, ${triage}` : ""}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        leading ? null : styles.rowSeparated,
        bandHex ? { backgroundColor: withAlpha(bandHex, 0.06) } : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <View style={styles.glyph}>
        {isEpic ? (
          <BacklogTypeGlyph type="epic" />
        ) : (
          <LifecycleGlyph state={STATUS_TO_LIFECYCLE[item.status]} live={item.status === "in_progress"} />
        )}
      </View>

      <View style={styles.body}>
        <Text numberOfLines={1} style={styles.title}>
          {item.title}
        </Text>
        <View style={styles.meta}>
          <Text style={styles.id}>{item.itemId}</Text>
          {!isEpic ? <DifficultyLabel difficulty={item.difficulty} /> : null}
          {!isEpic && item.criticality ? <CriticalityBars level={item.criticality} /> : null}
          {item.epic && !banded ? <EpicChip slug={item.epic} meta={epicMeta} /> : null}
          {item.updatedAt ? (
            <Text style={styles.age}>{formatTimestamp(item.updatedAt)}</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

export const BacklogRow = memo(BacklogRowImpl);

/**
 * The epic reference: a bare identity dot + mono label. A status/identity mark
 * never becomes a colored-background pill (glyph-system); the dot carries the
 * epic's wheel hue, the label stays quiet ink.
 *
 * Both the hue and the label come from the snapshot's epic block when it covers
 * this epic — the desktop's hand-picked `color:` and its display id, so
 * the same epic reads the same in both apps. The slug hash and the raw slug are
 * the fallback for an epic the block does not cover, not the default.
 */
function EpicChip({ slug, meta }: { slug: string; meta?: BacklogEpicMeta }) {
  const styles = useThemedStyles(createStyles);
  const { name } = useTheme();
  const hex = backlogHighlightHexByTheme[name][epicColor(slug, meta)];

  return (
    <View style={styles.chip}>
      <View style={[styles.chipDot, { backgroundColor: hex }]} />
      <Text numberOfLines={1} style={styles.chipLabel}>
        {meta?.displayId ?? slug}
      </Text>
    </View>
  );
}

const createStyles = ({ colors, ...theme }: Theme) =>
  StyleSheet.create({
    row: {
      ...cardSurface({ colors, ...theme }),
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.lg,
      minHeight: 56,
      paddingVertical: space.lg,
      paddingHorizontal: space.xl,
    },
    rowSeparated: {
      // Rows are cards now; the hairline that separated bare rows is gone.
    },
    pressed: {
      backgroundColor: colors.bgHover,
    },
    glyph: {
      marginTop: space["3xs"],
    },
    body: {
      flex: 1,
      minWidth: 0,
      gap: space["2xs"],
    },
    title: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    meta: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
    },
    id: {
      ...typography.micro,
      fontWeight: fontWeight.regular,
      color: colors.textSubtle,
      fontFamily: monoFontFamily,
      fontVariant: ["tabular-nums"],
    },
    age: {
      ...typography.micro,
      fontWeight: fontWeight.regular,
      marginLeft: "auto",
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      maxWidth: 160,
      flexShrink: 1,
    },
    chipDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
    },
    chipLabel: {
      ...typography.micro,
      fontWeight: fontWeight.regular,
      color: colors.textSubtle,
      fontFamily: monoFontFamily,
    },
  });
