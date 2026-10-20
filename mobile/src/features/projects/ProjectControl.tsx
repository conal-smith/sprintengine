import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { iconSize, MenuIcon, StarIcon } from "../../components/glyphs";
import { IconButton } from "../../components/IconButton";
import { SidePanel } from "../../components/SidePanel";
import { StatusPill } from "../../components/StatusPill";
import { useSessionData } from "../../navigation/SessionDataProvider";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { radius, space, typography, type Theme, hitTargetMin, fontWeight } from "../../theme/tokens";
import { orderSessionsForFleet, sessionDisplayStatus, sessionStatusLabel, sessionStatusTone } from "../fleet/fleetLogic";
import {
  buildProjectSwitcherRows,
  projectMetaLine,
  type ProjectSwitcherRow,
} from "./projectContext";

/**
 * The one context control, in every tab's header.
 *
 * It replaces the two near-identical caret chips that shipped instead of it —
 * `DesktopPicker` and `ProjectChip` — which occupied the same header slot,
 * looked alike, and meant different things. This is the
 * fused project · desktop control the 2026-07-10 mockup specified and the code
 * never built.
 *
 * Tapping it opens the switcher panel. That panel is a *context* switcher, not a
 * navigation destination: nothing in it pushes a route, so the stack remains the
 * app's only navigation model and the retired drawer stays retired.
 */
export function ProjectControl({ compact = false }: { compact?: boolean }) {
  const styles = useThemedStyles(createStyles);
  const { currentProject, session } = useSessionData();
  const [isOpen, setIsOpen] = useState(false);

  const projectName = currentProject?.name ?? "No project";
  const desktopName = session?.desktopName ?? null;

  // Home names the project in its first card, so its header carries only the
  // switcher's icon — the site's bar holds icons, not chips.
  if (compact) {
    return (
      <>
        <IconButton
          icon={<MenuIcon size={iconSize.md} tone="textMuted" />}
          label={`Switch project. Current: ${projectName}${desktopName ? ` on ${desktopName}` : ""}`}
          onPress={() => setIsOpen(true)}
        />
        <ProjectSwitcherPanel onClose={() => setIsOpen(false)} visible={isOpen} />
      </>
    );
  }

  return (
    <>
      <Pressable
        accessibilityHint="Opens the project switcher"
        accessibilityLabel={`Project: ${projectName}${desktopName ? `, desktop: ${desktopName}` : ""}`}
        accessibilityRole="button"
        onPress={() => setIsOpen(true)}
        style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
      >
        <MenuIcon size={iconSize.xs} tone="textSubtle" />
        <Text numberOfLines={1} style={styles.chipLabel}>
          {projectName}
        </Text>
        {/* The desktop folds into the same control, but it is the quieter half:
            "which repo" is the question the user is actually asking. */}
        {desktopName ? (
          <Text numberOfLines={1} style={styles.chipDesktop}>
            {` · ${desktopName}`}
          </Text>
        ) : null}
      </Pressable>

      <ProjectSwitcherPanel onClose={() => setIsOpen(false)} visible={isOpen} />
    </>
  );
}

function ProjectSwitcherPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const styles = useThemedStyles(createStyles);
  const {
    projects,
    currentProject,
    selectProject,
    starredProjectKeys,
    toggleProjectStar,
    sessions,
    activeDeviceId,
    selectSession,
  } = useSessionData();

  const { starred, others } = buildProjectSwitcherRows(projects, starredProjectKeys);
  const orderedSessions = orderSessionsForFleet(sessions);

  const handleSelect = (key: string) => {
    onClose();
    if (key !== currentProject?.key) {
      selectProject(key);
    }
  };

  return (
    <SidePanel onClose={onClose} title="Projects" visible={visible}>
      {projects.length === 0 && starred.length === 0 ? (
        <Text style={styles.emptyText}>
          No projects yet. Pull to refresh.
        </Text>
      ) : null}

      {starred.length > 0 ? <Text style={styles.sectionLabel}>Starred</Text> : null}
      {starred.map((row) => (
        <ProjectRow
          key={row.key}
          currentKey={currentProject?.key ?? null}
          onSelect={handleSelect}
          onToggleStar={toggleProjectStar}
          row={row}
        />
      ))}

      {starred.length > 0 && others.length > 0 ? <Text style={styles.sectionLabel}>All projects</Text> : null}
      {others.map((row) => (
        <ProjectRow
          key={row.key}
          currentKey={currentProject?.key ?? null}
          onSelect={handleSelect}
          onToggleStar={toggleProjectStar}
          row={row}
        />
      ))}

      {orderedSessions.length > 0 ? (
        <>
          <Text style={styles.sectionLabel}>Desktop</Text>
          {orderedSessions.map((candidate) => {
            const status = sessionDisplayStatus(candidate);
            const isActive = candidate.deviceId === activeDeviceId;
            const isRevoked = status === "revoked";
            // One paired desktop is not a choice, so its row is a label rather
            // than a button that switches to what is already showing.
            const selectable = orderedSessions.length > 1 && !isRevoked && !isActive;

            const body = (
              <>
                <Text numberOfLines={1} style={styles.rowName}>
                  {candidate.desktopName}
                </Text>
                {/* Status is earned: a healthy desktop carries no mark. */}
                {status === "online" ? null : (
                  <StatusPill label={sessionStatusLabel[status]} tone={sessionStatusTone(status)} />
                )}
              </>
            );

            if (!selectable) {
              return (
                <View
                  key={candidate.deviceId}
                  style={[
                    styles.row,
                    styles.desktopRow,
                    isActive ? styles.rowActive : null,
                    isRevoked ? styles.rowUnavailable : null,
                  ]}
                >
                  {body}
                </View>
              );
            }

            return (
              <Pressable
                accessibilityLabel={`${candidate.desktopName}, ${sessionStatusLabel[status]}`}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive }}
                key={candidate.deviceId}
                onPress={() => {
                  onClose();
                  selectSession(candidate.deviceId);
                }}
                style={({ pressed }) => [styles.row, styles.desktopRow, pressed ? styles.pressed : null]}
              >
                {body}
              </Pressable>
            );
          })}
          <Text style={styles.hint}>Manage desktops in Settings.</Text>
        </>
      ) : null}
    </SidePanel>
  );
}

/**
 * One project. The star is a sibling of the select target, not a child of it, so
 * both keep their own 44 pt box and the screen reader announces two controls
 * rather than collapsing them into one.
 */
function ProjectRow({
  row,
  currentKey,
  onSelect,
  onToggleStar,
}: {
  row: ProjectSwitcherRow;
  currentKey: string | null;
  onSelect: (key: string) => void;
  onToggleStar: (key: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const isActive = row.key === currentKey;

  // An unavailable row is a starred project this desktop's snapshot does not
  // carry (repo moved, or a different desktop is paired). The star survives and
  // can still be removed — the row is only unselectable, never silently dropped.
  const meta = row.available && row.project ? projectMetaLine(row.project) : "Not on the paired desktop";

  const copy = (
    <>
      <Text numberOfLines={1} style={styles.rowName}>
        {row.name}
      </Text>
      {meta ? (
        <Text numberOfLines={1} style={styles.rowMeta}>
          {meta}
        </Text>
      ) : null}
    </>
  );

  return (
    <View
      style={[styles.row, isActive ? styles.rowActive : null, row.available ? null : styles.rowUnavailable]}
    >
      {row.available ? (
        <Pressable
          accessibilityHint={isActive ? undefined : "Switches the whole app to this project"}
          accessibilityLabel={`${row.name}, ${meta}`}
          accessibilityRole="button"
          accessibilityState={{ selected: isActive }}
          onPress={() => onSelect(row.key)}
          style={({ pressed }) => [styles.rowMain, pressed ? styles.pressed : null]}
        >
          {copy}
        </Pressable>
      ) : (
        <View style={styles.rowMain}>{copy}</View>
      )}
      <IconButton
        icon={<StarIcon filled={row.starred} size={iconSize.sm} tone={row.starred ? "textPrimary" : "textSubtle"} />}
        label={row.starred ? `Unstar ${row.name}` : `Star ${row.name}`}
        onPress={() => onToggleStar(row.key)}
      />
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    chip: {
      maxWidth: 190,
      minHeight: hitTargetMin,
      flexDirection: "row",
      alignItems: "center",
      gap: space["2xs"],
      borderRadius: radius.control,
      borderWidth: 1,
      borderColor: colors.buttonOutline,
      paddingHorizontal: space.sm,
    },
    chipLabel: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      flexShrink: 1,
      color: colors.textDefault,
    },
    chipDesktop: {
      ...typography.micro,
      fontWeight: fontWeight.regular,
      flexShrink: 1,
      color: colors.textSubtle,
    },
    pressed: {
      backgroundColor: colors.bgHover,
    },
    // Sentence case, no tracking — uppercase-tracked labels are a brand reject.
    sectionLabel: {
      ...typography.meta,
      color: colors.textMuted,
      paddingTop: space.lg,
      paddingBottom: space["2xs"],
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      minHeight: 48,
      borderRadius: radius.control,
    },
    // Selection is neutral: a fill, no accent bar.
    rowActive: {
      backgroundColor: colors.bgSurfaceSelected,
    },
    rowUnavailable: {
      opacity: 0.55,
    },
    rowMain: {
      flex: 1,
      gap: space["3xs"],
      justifyContent: "center",
      minHeight: 48,
      minWidth: 0,
      borderRadius: radius.control,
      paddingHorizontal: space.sm,
    },
    desktopRow: {
      justifyContent: "space-between",
      paddingHorizontal: space.sm,
    },
    rowName: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
      flexShrink: 1,
    },
    rowMeta: {
      ...typography.micro,
      fontWeight: fontWeight.regular,
      color: colors.textSubtle,
    },
    hint: {
      ...typography.meta,
      color: colors.textMuted,
      paddingTop: space.sm,
      paddingHorizontal: space.sm,
    },
    emptyText: {
      ...typography.meta,
      color: colors.textMuted,
      paddingHorizontal: space.sm,
    },
  });
