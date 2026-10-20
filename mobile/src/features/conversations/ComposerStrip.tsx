import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "../../components/BottomSheet";
import { MoreIcon, iconSize } from "../../components/glyphs";
import { SheetOption } from "../../components/SheetOption";
import { useSheetHandoff } from "../../components/useSheetHandoff";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { radius, space, touchSlop, typography, type Theme } from "../../theme/tokens";
import { layoutComposerStrip, type StripEntrySpec } from "./composerStripLogic";

/** How far the strip runs up under the composer's box. */
export const STRIP_TUCK = space.xl;
/** The strip's small controls, drawn under the touch floor and padded out to it. */
export const STRIP_ITEM_HEIGHT = 32;
const OVERFLOW_WIDTH = 28;
const GAP = space["3xs"];
/** How long a long-pressed item's words stay on the line. */
const READOUT_MS = 3_000;

/** One thing the strip can say. */
export type ComposerStripEntry = {
  id: string;
  /** Lower leaves the line first (STRIP_DROP_ORDER). */
  drop: number;
  /**
   * The item as drawn. A branch entry is handed its label, front-truncated to
   * fit; every other entry is drawn whole or not at all.
   */
  render: (label: string) => ReactNode;
  /** The branch's full name: marks this entry as the one that may shrink. */
  branch?: string;
  /** What the "⋮" sheet calls it once it has left the line. */
  overflowLabel: string;
  overflowIcon?: ReactNode;
  /** What tapping it in the "⋮" sheet does; absent, the row is read-only. */
  onOverflowPress?: () => void;
};

/**
 * The strip tucked under the composer's box, one piece with it: rounded at
 * the bottom only, inset from the box's sides, its top hidden under the box's
 * lower edge (the desktop's New chat strip).
 *
 * Always one line. Every item is measured at its natural width off screen;
 * `layoutComposerStrip` decides what stays, how far the branch shrinks from
 * the front, and what goes to the "⋮". `pinned` (the chat's pull request and
 * its context ring) sits at the right and never leaves; the line gives way
 * around it at the width it is drawn at, `pinnedWidth` until it has been.
 * `readout` replaces the items with one line of words for a moment: what a
 * long-pressed glyph means.
 */
export function ComposerStrip({
  entries,
  pinned,
  pinnedWidth = 0,
  readout,
  onReadoutDone,
}: {
  entries: readonly ComposerStripEntry[];
  pinned?: ReactNode;
  pinnedWidth?: number;
  readout?: string | null;
  onReadoutDone?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [width, setWidth] = useState(0);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const [moreOpen, setMoreOpen] = useState(false);
  // What a row opens (a sheet, a popover) waits for this sheet to go.
  const handoff = useSheetHandoff();
  // The pinned end as drawn: it never leaves, so its own layout is its width.
  const [pinnedDrawn, setPinnedDrawn] = useState<number | null>(null);
  const measure = (key: string, value: number) =>
    setMeasured((current) => (Math.abs((current[key] ?? -1) - value) < 0.5 ? current : { ...current, [key]: value }));

  const done = useRef(onReadoutDone);
  done.current = onReadoutDone;
  useEffect(() => {
    if (!readout) return;
    const timer = setTimeout(() => done.current?.(), READOUT_MS);
    return () => clearTimeout(timer);
  }, [readout]);

  const specs = useMemo(() => {
    const out: StripEntrySpec[] = [];
    for (const entry of entries) {
      if (entry.branch !== undefined) {
        const whole = measured[`${entry.id}:whole`];
        const chrome = measured[`${entry.id}:chrome`];
        if (whole === undefined || chrome === undefined) return null;
        const chars = Math.max(1, entry.branch.length);
        out.push({
          kind: "branch",
          id: entry.id,
          text: entry.branch,
          charWidth: Math.max(0, whole - chrome) / chars,
          chromeWidth: chrome,
          drop: entry.drop,
        });
      } else {
        const itemWidth = measured[entry.id];
        if (itemWidth === undefined) return null;
        out.push({ kind: "item", id: entry.id, width: itemWidth, drop: entry.drop });
      }
    }
    return out;
  }, [entries, measured]);

  const layout =
    specs && width > 0
      ? layoutComposerStrip({
          width,
          gap: GAP,
          entries: specs,
          pinnedWidth: pinned ? (pinnedDrawn ?? pinnedWidth) : 0,
          overflowWidth: OVERFLOW_WIDTH,
        })
      : null;
  const hidden = entries.filter((entry) => layout?.hidden.includes(entry.id));

  return (
    <View style={styles.strip}>
      {/* The measuring line: every item at its natural width, off the layout
          and out of sight, so the real line can be decided before it is drawn. */}
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={styles.measure}
      >
        {entries.map((entry) =>
          entry.branch !== undefined ? (
            <View key={entry.id} style={styles.measureRow}>
              <View onLayout={(event) => measure(`${entry.id}:whole`, event.nativeEvent.layout.width)} style={styles.fixed}>
                {entry.render(entry.branch)}
              </View>
              <View onLayout={(event) => measure(`${entry.id}:chrome`, event.nativeEvent.layout.width)} style={styles.fixed}>
                {entry.render("")}
              </View>
            </View>
          ) : (
            <View key={entry.id} onLayout={(event) => measure(entry.id, event.nativeEvent.layout.width)} style={styles.fixed}>
              {entry.render(entry.overflowLabel)}
            </View>
          ),
        )}
      </View>

      <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={styles.line}>
        {readout ? (
          <Text accessibilityLiveRegion="polite" numberOfLines={1} style={styles.readout}>
            {readout}
          </Text>
        ) : layout ? (
          <>
            {entries
              .filter((entry) => layout.visible.includes(entry.id))
              .map((entry) => (
                <View key={entry.id} style={entry.branch !== undefined ? styles.shrink : styles.fixed}>
                  {entry.render(entry.branch !== undefined ? (layout.branchLabel ?? entry.branch) : entry.overflowLabel)}
                </View>
              ))}
            {layout.overflow ? (
              <Pressable
                accessibilityLabel={`More: ${hidden.map((entry) => entry.overflowLabel).join(", ")}`}
                accessibilityRole="button"
                hitSlop={touchSlop(STRIP_ITEM_HEIGHT, OVERFLOW_WIDTH)}
                onPress={() => setMoreOpen(true)}
                style={({ pressed }) => [styles.more, pressed ? styles.pressed : null]}
              >
                {/* The house "more" mark stood on end: ⋮. */}
                <View style={styles.upright}>
                  <MoreIcon size={iconSize.xs} tone="textMuted" />
                </View>
              </Pressable>
            ) : null}
          </>
        ) : null}
        {/* Pinned right by its margin, not a spacer: a spacer would take a gap
            of its own that the layout does not count. */}
        {pinned ? (
          <View
            onLayout={(event) => {
              const drawn = event.nativeEvent.layout.width;
              setPinnedDrawn((current) => (current !== null && Math.abs(current - drawn) < 0.5 ? current : drawn));
            }}
            style={styles.pinned}
          >
            {pinned}
          </View>
        ) : null}
      </View>

      <BottomSheet onClose={() => setMoreOpen(false)} onDismiss={handoff.onDismiss} title="More" visible={moreOpen}>
        {hidden.map((entry) => (
          <SheetOption
            icon={entry.overflowIcon}
            key={entry.id}
            label={entry.overflowLabel}
            onPress={() => {
              setMoreOpen(false);
              const open = entry.onOverflowPress;
              if (open) handoff.after(open);
            }}
          />
        ))}
      </BottomSheet>
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    strip: {
      marginTop: -STRIP_TUCK,
      marginHorizontal: space.xl,
      paddingTop: STRIP_TUCK + space["3xs"],
      paddingBottom: space["3xs"],
      paddingHorizontal: space.xs,
      borderWidth: 1,
      borderTopWidth: 0,
      borderColor: colors.borderSubtle,
      borderBottomLeftRadius: radius.composerStrip,
      borderBottomRightRadius: radius.composerStrip,
      backgroundColor: colors.bgSurface,
      overflow: "hidden",
    },
    // Wide enough that nothing in it wraps or truncates: it reports natural widths.
    measure: {
      position: "absolute",
      top: 0,
      left: 0,
      width: 10_000,
      flexDirection: "row",
      alignItems: "center",
      opacity: 0,
    },
    measureRow: { flexDirection: "row" },
    line: {
      flexDirection: "row",
      flexWrap: "nowrap",
      alignItems: "center",
      gap: GAP,
      minHeight: STRIP_ITEM_HEIGHT,
    },
    fixed: { flexShrink: 0 },
    // The branch alone may shrink; its label is already cut to fit.
    shrink: { flexShrink: 1, minWidth: 0 },
    pinned: { flexDirection: "row", alignItems: "center", gap: GAP, flexShrink: 0, marginLeft: "auto" },
    more: {
      width: OVERFLOW_WIDTH,
      height: STRIP_ITEM_HEIGHT,
      borderRadius: radius.control,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    upright: { transform: [{ rotate: "90deg" }] },
    pressed: { backgroundColor: colors.bgHover },
    readout: {
      ...typography.meta,
      color: colors.textMuted,
      fontVariant: ["tabular-nums"],
      paddingHorizontal: space.sm,
      flexShrink: 1,
    },
  });
