import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Card, CardRow } from "../../components/Card";
import { FolderGlyph, iconSize, RemoteMachineGlyph } from "../../components/glyphs";
import { ScreenFrame, useListContentStyle } from "../../components/Screen";
import { SkeletonRows } from "../../components/Skeleton";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme, fontWeight } from "../../theme/tokens";
import type { DesktopWorkspace } from "../../api/tailnetWorkspaces";
import { loadProjectPicks, rememberProjectPick } from "../../storage/projectPicks";
import { useChats } from "./ChatsContext";
import { pickableProjects, type ProjectPicks } from "./conversationListLogic";

export interface ProjectChoice {
  deviceId: string;
  desktopName: string;
  workspaceId: string;
  projectName: string;
}

/**
 * Step one of a new chat: the projects each desktop that may start one has
 * open.
 *
 * Grouped under the desktop they are on, with the machine glyph as the heading
 * — and no heading at all when one desktop is paired, because a heading that
 * never varies is a word doing nothing. Project name only: no path, no caption.
 *
 * Choosing the project chooses the desktop. There is deliberately no earlier
 * screen for the machine: a person starting work is thinking about the project,
 * and the machine it happens to be open on follows from it.
 *
 * The projects used most come first, by the desktop's own count of new chats
 * (`pickableProjects`); a desktop that keeps none is ordered by this phone's
 * own picks, which are remembered here for that.
 */
export function ChooseProjectScreen({ onBack, onChoose }: { onBack: () => void; onChoose: (choice: ProjectChoice) => void }) {
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle();
  const { desktops, apiFor } = useChats();
  const [byDesktop, setByDesktop] = useState<Record<string, DesktopWorkspace[]>>({});
  const [state, setState] = useState<"loading" | "ready">("loading");
  const [picks, setPicks] = useState<ProjectPicks>({});

  useEffect(() => {
    let live = true;
    void loadProjectPicks().then((stored) => {
      if (live) setPicks(stored);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all(
      desktops
        .filter((desktop) => desktop.canStart)
        .map(async (desktop) => ({ desktop, result: await apiFor(desktop.deviceId)?.listWorkspaces() })),
    ).then((answers) => {
      if (!live) return;
      const next: Record<string, DesktopWorkspace[]> = {};
      for (const answer of answers) {
        if (answer.result?.ok) next[answer.desktop.deviceId] = answer.result.data ?? [];
      }
      setByDesktop(next);
      setState("ready");
    });
    return () => {
      live = false;
    };
  }, [apiFor, desktops]);

  const groups = desktops
    .filter((desktop) => desktop.canStart)
    .map((desktop) => ({
      desktop,
      projects: pickableProjects(byDesktop[desktop.deviceId] ?? [], picks[desktop.deviceId]),
    }))
    .filter((group) => group.projects.length > 0);
  const oneDesktop = groups.length <= 1;

  return (
    <ScreenFrame backLabel="Cancel" onBack={onBack} title="Choose project">
      <ScrollView contentContainerStyle={contentStyle}>
        {state === "loading" ? (
          <SkeletonRows label="Reading the desktops' projects" />
        ) : groups.length === 0 ? (
          <Card>
            <Text style={styles.notice}>
              No projects are open on a paired desktop. Open one in Studio and it appears here.
            </Text>
          </Card>
        ) : (
          groups.map((group) => (
            <View key={group.desktop.deviceId} style={styles.group}>
              {oneDesktop ? null : (
                <View style={styles.groupHead}>
                  <RemoteMachineGlyph size={iconSize.sm} />
                  <Text accessibilityRole="header" style={styles.groupName}>
                    {group.desktop.name}
                  </Text>
                </View>
              )}
              <Card variant="list">
                {group.projects.map((project, index) => (
                  <CardRow
                    accessibilityLabel={`${project.projectName} on ${group.desktop.name}`}
                    chevron
                    first={index === 0}
                    key={project.key}
                    leading={<FolderGlyph size={iconSize.sm} />}
                    onPress={() => {
                      void rememberProjectPick(group.desktop.deviceId, project.key);
                      onChoose({
                        deviceId: group.desktop.deviceId,
                        desktopName: group.desktop.name,
                        workspaceId: project.workspaceId,
                        projectName: project.projectName,
                      });
                    }}
                    title={project.projectName}
                  />
                ))}
              </Card>
            </View>
          ))
        )}
      </ScrollView>
    </ScreenFrame>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    group: {
      gap: space.sm,
    },
    groupHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.sm,
      paddingHorizontal: space["2xs"],
      paddingTop: space.sm,
    },
    groupName: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textMuted,
    },
    notice: {
      ...typography.meta,
      color: colors.textMuted,
      paddingVertical: space.sm,
      textAlign: "center",
    },
  });
