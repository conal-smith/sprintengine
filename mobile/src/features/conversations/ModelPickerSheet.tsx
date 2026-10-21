import { useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { BottomSheet } from "../../components/BottomSheet";
import { CheckIcon, ChevronIcon, CliLogo, iconSize } from "../../components/glyphs";
import { SearchField } from "../../components/SearchField";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { fontWeight, radius, space, touchSlop, typography, type Theme } from "../../theme/tokens";
import {
  choosePickerRow,
  costliestEffort,
  effortLabel,
  effortStops,
  initialPickerFilter,
  pickerRowDetail,
  pickerRowSelected,
  pickerSearchOffered,
  visiblePickerRows,
  windowChoices,
  type EffortLevel,
  type PickerProvider,
  type PickerRow,
  type PickerSelection,
} from "./modelPickerLogic";

// The rail's chips and the window's segments, drawn under the touch floor and
// padded out to it with `touchSlop`.
const CHIP_HEIGHT = 32;
const SEGMENT_HEIGHT = 32;
const STOP_HEIGHT = 32;
/** The tile a row's CLI mark sits on; the window choice lines up past it. */
const TILE_SIZE = 28;

/**
 * The model picker, New's and an open chat's alike: the desktop's
 * `CliModelPicker` as a phone's bottom sheet (rules in modelPickerLogic.ts).
 *
 * Top to bottom: the provider rail as a row of chips, each a CLI's mark and
 * name (drawn only when there is more than one to choose); the provider line
 * under it ("Z.AI · via Claude Code"), or the host's note about that one CLI;
 * the search, which reaches across every provider; then one row per model,
 * its CLI's mark, its name, "New" where the desktop marks it, and a tick on
 * the current pick. A family the catalog ships at more than one context window
 * offers the window under its row once it is picked ("Standard | 1M"), as the
 * desktop offers it beside the model. Below the list, the effort ramp, where
 * the CLI declares levels and the host can send one, and the Access row.
 *
 * The host owns what is picked and what a pick does: New holds it until
 * Start, a chat sends it to the desktop.
 */
export function ModelPickerSheet({
  visible,
  onClose,
  title,
  providers,
  selection,
  onSelect,
  note,
  locked = false,
  leading,
  effort,
  access,
  footer,
  onDismiss,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  providers: readonly PickerProvider[];
  selection: PickerSelection;
  onSelect: (next: PickerSelection) => void;
  /** A quiet line about the one provider shown, after its name: why its list cannot be picked from. */
  note?: string | null;
  /** The list is the record of what the chat runs, not a choice. */
  locked?: boolean;
  /** Above the rail: New's "Desktop default". */
  leading?: ReactNode;
  /** The effort ramp, for the picked CLI's levels; absent or empty, none is drawn. */
  effort?: {
    levels: readonly EffortLevel[];
    value: string | null;
    defaultLevel: string | null;
    onChange: (next: string | null) => void;
  } | null;
  /** The Access row: the preset, in its sheet a tap away. */
  access?: { label: string; onPress: () => void } | null;
  footer?: ReactNode;
  /** Once the sheet has gone: where another sheet opens from this one (`useSheetHandoff`). */
  onDismiss?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string | null>(() => initialPickerFilter(providers, selection));
  // Each opening starts on the picked CLI with nothing typed, as the desktop's
  // popover does.
  useEffect(() => {
    if (!visible) return;
    setQuery("");
    setFilter(initialPickerFilter(providers, selection));
    // Only on opening: a pick made in the sheet moves neither.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const { rows, searching } = visiblePickerRows(providers, { filter, query });
  const railed = providers.find((provider) => provider.cli === filter) ?? providers[0] ?? null;
  const levels = effort?.levels ?? [];

  return (
    <BottomSheet closeLabel="Done" onClose={onClose} onDismiss={onDismiss} title={title} visible={visible}>
      {leading}
      {providers.length > 1 ? (
        <ScrollView
          accessibilityLabel="Provider"
          accessibilityRole="radiogroup"
          contentContainerStyle={styles.rail}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
        >
          {providers.map((provider) => {
            const on = !searching && railed?.cli === provider.cli;
            return (
              <Pressable
                accessibilityLabel={provider.label}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                hitSlop={touchSlop(CHIP_HEIGHT, CHIP_HEIGHT)}
                key={provider.cli}
                onPress={() => {
                  setFilter(provider.cli);
                  setQuery("");
                }}
                style={({ pressed }) => [styles.chip, on ? styles.chipOn : null, pressed && !on ? styles.pressed : null]}
              >
                <CliLogo cli={provider.cli} size={iconSize.xs} />
                <Text numberOfLines={1} style={[styles.chipText, on ? styles.chipTextOn : null]}>
                  {provider.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {/* The line over the list: who runs the provider on screen, or what the
          host has to say about it. Under a search each row names its own. */}
      {!searching && railed ? (
        <Text style={styles.providerLine}>
          {note ? (
            <>
              {railed.label}
              <Text style={styles.providerNote}> · {note}</Text>
            </>
          ) : (
            railed.providerLabel
          )}
        </Text>
      ) : null}
      {pickerSearchOffered(providers, locked) ? (
        <SearchField accessibilityLabel={`Search ${title}`} onChangeText={setQuery} placeholder="Search models…" value={query} />
      ) : null}

      <View style={styles.list}>
        {rows.length === 0 ? (
          <Text style={styles.empty}>{searching ? "No models match." : "No models here yet."}</Text>
        ) : (
          rows.map((row) => {
            const selected = pickerRowSelected(row, selection);
            const windows = selected ? windowChoices(row) : [];
            return (
              <View key={row.key}>
                <ModelRow
                  locked={locked}
                  onPress={() => onSelect(choosePickerRow(row, selection))}
                  row={row}
                  searching={searching}
                  selected={selected}
                />
                {windows.length ? (
                  <View accessibilityLabel="Context window" accessibilityRole="radiogroup" style={styles.windows}>
                    <Text style={styles.windowsLabel}>Context window</Text>
                    <View style={styles.segments}>
                      {windows.map((variant) => {
                        const on = variant.id === selection.model;
                        return (
                          <Pressable
                            accessibilityLabel={`${variant.label} context window`}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: on, disabled: locked }}
                            disabled={locked}
                            hitSlop={touchSlop(SEGMENT_HEIGHT, SEGMENT_HEIGHT)}
                            key={variant.id}
                            onPress={() => onSelect({ cli: row.cli, model: variant.id })}
                            style={({ pressed }) => [styles.segment, on ? styles.segmentOn : null, pressed && !on ? styles.pressed : null]}
                          >
                            {on ? <CheckIcon size={iconSize.xs} tone="textPrimary" /> : null}
                            <Text style={[styles.segmentText, on ? styles.segmentTextOn : null]}>{variant.label}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </View>

      {effort && levels.length ? (
        <EffortRamp defaultLevel={effort.defaultLevel} levels={levels} onChange={effort.onChange} value={effort.value} />
      ) : null}

      {access ? (
        <Pressable accessibilityLabel={`Access, ${access.label}`} accessibilityRole="button" onPress={access.onPress} style={styles.kv}>
          <Text style={styles.kvKey}>Access</Text>
          <Text style={styles.kvValue}>{access.label}</Text>
          <ChevronIcon direction="right" size={iconSize.sm} tone="textSubtle" />
        </Pressable>
      ) : null}
      {footer}
    </BottomSheet>
  );
}

/**
 * One model. The chosen one is the sheet's inverse slab with a tick, as every
 * choice in a sheet is (`SheetOption`). The second line qualifies the name and
 * never restates it: the provider only while a search spans more than one,
 * and the raw id only where the name does not already spell it.
 */
function ModelRow({
  row,
  selected,
  searching,
  locked,
  onPress,
}: {
  row: PickerRow;
  selected: boolean;
  searching: boolean;
  locked: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const detail = pickerRowDetail(row, { spansProviders: searching });
  return (
    <Pressable
      accessibilityLabel={[row.name, row.isNew ? "new" : null, detail || null, row.note ?? null].filter(Boolean).join(", ")}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: locked }}
      disabled={locked}
      onPress={onPress}
      style={({ pressed }) => [styles.row, selected ? styles.rowOn : null, pressed && !selected && !locked ? styles.pressed : null]}
    >
      {/* On a tile of its own: a CLI's mark in its own colour clears its
          contrast floor on a surface, never on the chosen row's slab. */}
      <View style={styles.tile}>
        <CliLogo cli={row.cli} size={iconSize.sm} />
      </View>
      <View style={styles.rowText}>
        <View style={styles.nameLine}>
          <Text
            numberOfLines={1}
            style={[styles.name, row.mono ? styles.mono : null, selected ? styles.onSlab : null, locked && !selected ? styles.off : null]}
          >
            {row.name}
          </Text>
          {/* A chip, not a hoist: the row stays where the catalog put it. */}
          {row.isNew ? (
            <View style={styles.newChip}>
              <Text style={styles.newChipText}>New</Text>
            </View>
          ) : null}
        </View>
        {detail ? (
          <Text numberOfLines={1} style={[styles.detail, styles.mono, selected ? styles.onSlabQuiet : null]}>
            {detail}
          </Text>
        ) : null}
      </View>
      {row.note ? <Text style={[styles.note, selected ? styles.onSlabQuiet : null]}>{row.note}</Text> : null}
      {selected ? <CheckIcon size={iconSize.sm} tone="buttonInk" /> : null}
    </Pressable>
  );
}

/**
 * How hard the model thinks, as the desktop draws it: a ramp, not a menu,
 * because each level costs more than the last and the position is the cost.
 * Auto leads it and fills nothing: no level is passed, and the CLI's own
 * default effort wins. The value is named over the track; the costliest level
 * wears the warn tone, and the CLI's own default a quiet "Default".
 */
function EffortRamp({
  levels,
  value,
  defaultLevel,
  onChange,
}: {
  levels: readonly EffortLevel[];
  value: string | null;
  defaultLevel: string | null;
  onChange: (next: string | null) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const stops = effortStops(levels);
  const index = Math.max(
    0,
    stops.findIndex((stop) => stop.id === value),
  );
  const label = effortLabel(levels, value);
  const costly = value !== null && value === costliestEffort(levels);
  const step = (by: number) => {
    const next = stops[Math.min(stops.length - 1, Math.max(0, index + by))];
    if (next) onChange(next.id);
  };
  return (
    <View style={styles.effort}>
      <View style={styles.effortHead}>
        <Text style={styles.effortKey}>Reasoning</Text>
        {value !== null && value === defaultLevel ? (
          <View style={styles.defaultChip}>
            <Text style={styles.defaultChipText}>Default</Text>
          </View>
        ) : null}
        <Text style={[styles.effortValue, costly ? styles.warnInk : null]}>{label}</Text>
      </View>
      {/* One element to a screen reader, stepped with its adjust gestures;
          each stop is its own target to a finger. */}
      <View
        accessible
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        accessibilityLabel="Reasoning effort"
        accessibilityRole="adjustable"
        accessibilityValue={{ text: label }}
        onAccessibilityAction={(event) => step(event.nativeEvent.actionName === "increment" ? 1 : -1)}
        style={styles.track}
      >
        {stops.map((stop, at) => (
          <Pressable
            key={stop.id ?? "auto"}
            onPress={() => onChange(stop.id)}
            style={styles.stop}
          >
            <View
              style={[
                styles.bar,
                at > 0 && at <= index ? (costly ? styles.barWarn : styles.barOn) : null,
                at === index ? styles.barAt : null,
              ]}
            />
          </Pressable>
        ))}
      </View>
      <View style={styles.trackEnds}>
        <Text style={styles.trackEnd}>{stops[0]?.label}</Text>
        <Text style={styles.trackEnd}>{stops[stops.length - 1]?.label}</Text>
      </View>
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    rail: {
      gap: space.xs,
      paddingBottom: space["2xs"],
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      height: CHIP_HEIGHT,
      paddingHorizontal: space.md,
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.cardRing,
    },
    chipOn: {
      backgroundColor: colors.bgSelected,
      borderColor: colors.borderStrong,
    },
    chipText: {
      ...typography.meta,
      color: colors.textMuted,
    },
    chipTextOn: {
      color: colors.textPrimary,
      fontWeight: fontWeight.medium,
    },
    pressed: {
      backgroundColor: colors.bgHover,
    },
    providerLine: {
      ...typography.micro,
      color: colors.textMuted,
      paddingHorizontal: space.xs,
    },
    providerNote: {
      color: colors.textSubtle,
    },
    list: {
      gap: space["3xs"],
    },
    empty: {
      ...typography.meta,
      color: colors.textSubtle,
      paddingHorizontal: space.xs,
      paddingVertical: space.lg,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      minHeight: 48,
      borderRadius: radius.overlay,
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
    },
    rowOn: {
      backgroundColor: colors.buttonBg,
    },
    tile: {
      width: TILE_SIZE,
      height: TILE_SIZE,
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.cardRing,
      backgroundColor: colors.bgSurfaceRaised,
      alignItems: "center",
      justifyContent: "center",
    },
    rowText: {
      flex: 1,
      minWidth: 0,
      gap: space["3xs"],
    },
    nameLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      minWidth: 0,
    },
    name: {
      ...typography.body,
      fontSize: 16,
      color: colors.textPrimary,
      flexShrink: 1,
    },
    mono: {
      fontFamily: monoFontFamily,
    },
    onSlab: {
      color: colors.buttonInk,
    },
    onSlabQuiet: {
      color: colors.buttonInk,
      opacity: 0.7,
    },
    off: {
      color: colors.textMuted,
    },
    detail: {
      ...typography.micro,
      color: colors.textSubtle,
    },
    note: {
      ...typography.micro,
      color: colors.textMuted,
    },
    // The system pointing at something: accent ink on its soft ground, and
    // no hairline, which would make it read as a state.
    newChip: {
      paddingHorizontal: space.xs,
      paddingVertical: space["3xs"],
      borderRadius: radius.chip,
      backgroundColor: colors.accentPrimarySoft,
    },
    newChipText: {
      ...typography.micro,
      color: colors.accentPrimary,
    },
    windows: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      paddingLeft: space.lg + TILE_SIZE + space.md,
      paddingRight: space.lg,
      paddingTop: space.xs,
      paddingBottom: space.sm,
    },
    windowsLabel: {
      ...typography.meta,
      color: colors.textSubtle,
    },
    segments: {
      flexDirection: "row",
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.cardRing,
      overflow: "hidden",
    },
    segment: {
      flexDirection: "row",
      alignItems: "center",
      gap: space["2xs"],
      height: SEGMENT_HEIGHT,
      paddingHorizontal: space.lg,
    },
    segmentOn: {
      backgroundColor: colors.bgSelected,
    },
    segmentText: {
      ...typography.meta,
      color: colors.textMuted,
    },
    segmentTextOn: {
      color: colors.textPrimary,
      fontWeight: fontWeight.medium,
    },
    effort: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
      paddingHorizontal: space.xs,
      paddingTop: space.lg,
      gap: space["2xs"],
    },
    effortHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
    },
    effortKey: {
      ...typography.body,
      fontSize: 16,
      color: colors.textPrimary,
      flex: 1,
    },
    effortValue: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    warnInk: {
      color: colors.toneWarn,
    },
    // A fact about the level, not a status: a hairline and subtle ink.
    defaultChip: {
      paddingHorizontal: space.xs,
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.borderDefault,
    },
    defaultChipText: {
      ...typography.micro,
      color: colors.textSubtle,
    },
    track: {
      flexDirection: "row",
      gap: space["2xs"],
    },
    stop: {
      flex: 1,
      height: STOP_HEIGHT,
      justifyContent: "center",
    },
    bar: {
      height: 6,
      borderRadius: radius.chip,
      backgroundColor: colors.bgActive,
    },
    barOn: {
      backgroundColor: colors.buttonBg,
    },
    barWarn: {
      backgroundColor: colors.toneWarn,
    },
    // The stop the ramp is set to stands a little taller than the rest.
    barAt: {
      height: 10,
    },
    trackEnds: {
      flexDirection: "row",
      justifyContent: "space-between",
    },
    trackEnd: {
      ...typography.micro,
      color: colors.textSubtle,
    },
    kv: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      minHeight: 48,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
      paddingHorizontal: space.xs,
      paddingVertical: space.lg,
    },
    kvKey: {
      ...typography.body,
      fontSize: 16,
      color: colors.textPrimary,
      flex: 1,
    },
    kvValue: {
      ...typography.body,
      color: colors.textMuted,
    },
  });
