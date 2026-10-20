import { Pressable, StyleSheet, Text, View } from "react-native";

import { useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { radius, space, typography, type Theme, hitTargetMin, fontWeight } from "../../theme/tokens";
import type { BacklogCreateWorkspaceOption } from "./backlogLogic";

/**
 * One triage axis as a row of chips. Shared by the create form and the item
 * detail's triage block, so the two surfaces that set `type` / `difficulty` /
 * `criticality` cannot drift apart.
 *
 * Whether a second tap on the selected chip *clears* the axis is the caller's
 * decision, not this control's: create can clear (an absent field means "the
 * desktop picks"), but `backlog.update` reads an omitted field as "leave it
 * alone" and so has no way to express a clear.
 */
export function OptionRow<T extends string>({
  label,
  options,
  selected,
  format,
  onSelect,
  disabled = false,
}: {
  label: string;
  options: readonly T[];
  selected: T | undefined;
  format: (value: T) => string;
  onSelect: (value: T) => void;
  disabled?: boolean;
}) {
  const createFormStyles = useCreateFormStyles();

  return (
    <View style={createFormStyles.field}>
      <Text style={createFormStyles.fieldLabel}>{label}</Text>
      <View style={createFormStyles.optionWrap}>
        {options.map((option) => {
          const isSelected = option === selected;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled }}
              disabled={disabled}
              key={option}
              onPress={() => onSelect(option)}
              style={({ pressed }) => [
                createFormStyles.optionChip,
                isSelected ? createFormStyles.optionChipSelected : null,
                pressed && !disabled ? createFormStyles.pressedRow : null,
                disabled ? createFormStyles.optionChipDisabled : null,
              ]}
            >
              <Text
                style={[
                  createFormStyles.optionChipText,
                  isSelected ? createFormStyles.optionChipTextSelected : null,
                ]}
              >
                {format(option)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function capitalizeToken(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Shared scaffold for the backlog feature's create panel: it collects a
// workspace then runs an edit → confirm → pending → success/error lifecycle, so
// the picker, the state machine, and the panel chrome live here rather than
// inside the form. It was shared with the Sprint Engine create panel until that
// went (2026-09-16); the split is kept because the lifecycle is the interesting
// part and the form should not have to re-own it.

export type CreateFormState =
  | { status: "editing"; error: string | null }
  | { status: "confirming" }
  | { status: "pending" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

interface WorkspacePickerProps {
  workspaces: BacklogCreateWorkspaceOption[];
  selectedPath: string | null;
  isLoading: boolean;
  onSelect: (workspacePath: string | null) => void;
}

// The picker writes into a workspace the desktop already knows about; there is
// no silent default, so re-tapping the selected row clears it.
export function WorkspacePicker({ workspaces, selectedPath, isLoading, onSelect }: WorkspacePickerProps) {
  const createFormStyles = useCreateFormStyles();

  return (
    <View style={createFormStyles.field}>
      <Text style={createFormStyles.fieldLabel}>Workspace</Text>
      {workspaces.length === 0 ? (
        <Text style={createFormStyles.fieldHint}>
          {isLoading
            ? "Loading workspaces…"
            : "No workspaces yet. Refresh once one appears on your desktop."}
        </Text>
      ) : (
        <View style={createFormStyles.optionColumn}>
          {workspaces.map((workspace) => {
            const selected = workspace.workspacePath === selectedPath;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={workspace.workspaceId}
                onPress={() => onSelect(selected ? null : workspace.workspacePath)}
                style={({ pressed }) => [
                  createFormStyles.workspaceRow,
                  selected ? createFormStyles.workspaceRowSelected : null,
                  pressed ? createFormStyles.pressedRow : null,
                ]}
              >
                <Text
                  style={[createFormStyles.workspaceName, selected ? createFormStyles.workspaceNameSelected : null]}
                >
                  {workspace.workspaceName}
                </Text>
                <Text numberOfLines={1} style={createFormStyles.workspacePath}>
                  {workspace.workspacePath}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

export function useCreateFormStyles() {
  return useThemedStyles(createCreateFormStyles);
}

const createCreateFormStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    // The page sheet is the only container: fields group by label + space,
    // never by a nested panel (brand: hairlines do structure, no card-in-card).
    panel: {
      gap: space.xl,
    },
    panelTitle: {
      ...typography.title,
      fontWeight: fontWeight.emphasis,
      letterSpacing: -0.3,
      color: colors.textPrimary,
    },
    field: {
      gap: space["2xs"],
    },
    fieldLabel: {
      ...typography.meta,
      color: colors.textMuted,
    },
    fieldHint: {
      ...typography.meta,
      color: colors.textSubtle,
    },
    optionColumn: {},
    optionWrap: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: space.sm,
    },
    optionChip: {
      minHeight: 36,
      justifyContent: "center",
      borderRadius: radius.chip,
      borderWidth: 1,
      borderColor: colors.borderDefault,
      backgroundColor: "transparent",
      paddingHorizontal: space.lg,
    },
    optionChipSelected: {
      borderColor: "transparent",
      backgroundColor: colors.bgSelected,
    },
    optionChipDisabled: {
      opacity: 0.5,
    },
    optionChipText: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textMuted,
    },
    optionChipTextSelected: {
      color: colors.textPrimary,
    },
    // Tier-1 selection: 3 px accent left border over the pre-composited
    // selected surface; rows separate by hairline, not card edges.
    workspaceRow: {
      gap: space["3xs"],
      minHeight: hitTargetMin,
      justifyContent: "center",
      borderRadius: radius.control,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderSubtle,
      paddingVertical: space.sm,
      paddingHorizontal: space.lg,
    },
    workspaceRowSelected: {
      backgroundColor: colors.bgSurfaceSelected,
    },
    workspaceName: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    workspaceNameSelected: {
      fontWeight: fontWeight.emphasis,
    },
    workspacePath: {
      ...typography.micro,
      fontWeight: fontWeight.regular,
      color: colors.textSubtle,
      fontFamily: monoFontFamily,
    },
    input: {
      ...typography.body,
      minHeight: hitTargetMin,
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.buttonOutline,
      backgroundColor: colors.bgSurface,
      paddingHorizontal: space.lg,
      paddingVertical: space.lg,
      color: colors.textPrimary,
    },
    multilineInput: {
      minHeight: 96,
    },
    pressedRow: {
      backgroundColor: colors.bgHover,
    },
    // The confirm step swaps the form body in place — a hairline, not a box.
    confirmPanel: {
      gap: space.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
      paddingTop: space.lg,
    },
    confirmTitle: {
      ...typography.heading,
      color: colors.textPrimary,
    },
    confirmBody: {
      ...typography.meta,
      color: colors.textMuted,
    },
    summaryTitle: {
      ...typography.heading,
      color: colors.textPrimary,
    },
    summaryBody: {
      ...typography.meta,
      color: colors.textDefault,
    },
    message: {
      borderRadius: radius.control,
      padding: space.lg,
    },
    successMessage: {
      backgroundColor: colors.toneGoodSoft,
    },
    errorMessage: {
      backgroundColor: colors.toneErrorSoft,
    },
    messageText: {
      ...typography.meta,
      color: colors.textPrimary,
    },
  });
