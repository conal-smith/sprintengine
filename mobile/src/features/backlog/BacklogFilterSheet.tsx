import { type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { BottomSheet } from "../../components/BottomSheet";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme, hitTargetMin, fontWeight } from "../../theme/tokens";
import {
  backlogGroupLabel,
  backlogGroupOptions,
  backlogSortLabel,
  backlogSortOptions,
  backlogViewLabel,
  backlogViewOptions,
  type BacklogGroup,
  type BacklogSort,
  type BacklogView,
} from "./backlogLogic";

export interface BacklogFilterState {
  view: BacklogView;
  sort: BacklogSort;
  group: BacklogGroup;
}

interface BacklogFilterSheetProps {
  visible: boolean;
  value: BacklogFilterState;
  onChange: (next: BacklogFilterState) => void;
  onClose: () => void;
}

/**
 * The desktop Backlog panel's three axes as one sheet: View (which lens),
 * Sort by (which order), Group (flat or by epic). Options sit in a two-column
 * checkmark grid so all nineteen fit without a long scroll; the sheet stays
 * open across changes so the user can dial in a lens and a sort in one visit.
 */
export function BacklogFilterSheet({ visible, value, onChange, onClose }: BacklogFilterSheetProps) {
  const styles = useThemedStyles(createStyles);

  return (
    <BottomSheet visible={visible} onClose={onClose} title="View, sort and group">
      <Section title="View">
        {backlogViewOptions.map((view) => (
          <OptionCell
            key={view}
            label={backlogViewLabel[view]}
            selected={value.view === view}
            onPress={() => onChange({ ...value, view })}
          />
        ))}
      </Section>
      <View style={styles.divider} />
      <Section title="Sort by">
        {backlogSortOptions.map((sort) => (
          <OptionCell
            key={sort}
            label={backlogSortLabel[sort]}
            selected={value.sort === sort}
            onPress={() => onChange({ ...value, sort })}
          />
        ))}
      </Section>
      <View style={styles.divider} />
      <Section title="Group">
        {backlogGroupOptions.map((group) => (
          <OptionCell
            key={group}
            label={backlogGroupLabel[group]}
            selected={value.group === group}
            onPress={() => onChange({ ...value, group })}
          />
        ))}
      </Section>
    </BottomSheet>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.grid}>{children}</View>
    </View>
  );
}

/**
 * One grid cell: a leading check that only the selected option earns, then the
 * label. Selection reads by the mark and weight — no band, no fill, so the
 * grid stays calm at nineteen options.
 */
function OptionCell({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed ? styles.pressed : null]}
    >
      <View style={styles.check}>
        {selected ? (
          <Svg fill="none" height={10} viewBox="0 0 12 10" width={12}>
            <Path
              d="M1.5 5.5 4.5 8.5 10.5 1.5"
              stroke={colors.accentPrimary}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.8}
            />
          </Svg>
        ) : null}
      </View>
      <Text numberOfLines={1} style={[styles.optionLabel, selected ? styles.optionLabelSelected : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    sectionTitle: {
      ...typography.meta,
      color: colors.textMuted,
      paddingBottom: space["2xs"],
    },
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.borderSubtle,
      marginVertical: space.sm,
    },
    option: {
      width: "50%",
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      minHeight: hitTargetMin,
      paddingRight: space.lg,
    },
    pressed: {
      backgroundColor: colors.bgHover,
    },
    check: {
      width: 16,
      alignItems: "center",
    },
    optionLabel: {
      ...typography.body,
      flexShrink: 1,
      color: colors.textDefault,
    },
    optionLabelSelected: {
      color: colors.textPrimary,
      fontWeight: fontWeight.emphasis,
    },
  });
