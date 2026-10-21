import { ScrollView, StyleSheet, Text, View } from "react-native";

import { useTheme, useThemedStyles } from "../../../theme/ThemeProvider";
import { space, typography, type Theme } from "../../../theme/tokens";
import { WORKING_MARK_VARIANTS, WorkingMark } from "../../WorkingMark";
import {
  AGENT_CHARACTERS,
  AgentGlyph,
  BacklogIcon,
  BacklogTypeGlyph,
  ChevronIcon,
  CloseIcon,
  CollapseIcon,
  CriticalityBars,
  DifficultyLabel,
  ExpandIcon,
  FilterIcon,
  GearIcon,
  iconSize,
  LifecycleGlyph,
  LIFECYCLE_LABEL,
  SearchIcon,
  SettingsIcon,
  StatusShape,
  type AgentCharacterId,
  type AgentGlyphState,
  type BacklogCriticality,
  type BacklogDifficulty,
  type BacklogType,
  type LifecycleState,
} from "../index";

// Static review surface for the glyph pack, mirroring the desktop's
// components/ui/__preview__/PrimitivePreview.tsx. This is a design surface, not
// production UI: it mounts no client, no store, and no navigation. It renders
// every glyph in the pack so a reviewer can compare shapes against the desktop
// and check that each one re-inks with the theme.
//
// Mount it from a scratch entry point when reviewing the vocabulary. Consuming
// screens import from ../index, never from here.

const LIFECYCLE_STATES: LifecycleState[] = [
  "todo",
  "idea",
  "ready",
  "in_progress",
  "paused",
  "review",
  "needs_input",
  "recorded",
  "done",
  "canceled",
  "approved_auto",
  "done_unmerged",
  "done_merged",
  "archived",
  "failed",
];

const STATUS_TONES = ["good", "warn", "danger", "neutral"] as const;
const AGENT_STATES: AgentGlyphState[] = ["working", "done", "failed", "stopped"];

const BACKLOG_TYPES: BacklogType[] = ["epic", "feature", "bug", "mockup", "spike"];
const DIFFICULTIES: (BacklogDifficulty | undefined)[] = ["xs", "s", "m", "l", "xl", undefined];
const CRITICALITIES: (BacklogCriticality | undefined)[] = ["low", "normal", "high", "critical", undefined];

export function GlyphSheet() {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <ScrollView style={styles.canvas} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Glyph pack — {theme.name}</Text>

      <Section title="Lifecycle" caption="Shape carries the state; tone only reinforces it.">
        <View style={styles.grid}>
          {LIFECYCLE_STATES.map((state) => (
            <View key={state} style={styles.cell}>
              {/* `live` is frozen so the in_progress gauge holds still for capture. */}
              <LifecycleGlyph state={state} live={false} size={iconSize.md} />
              <Text style={styles.cellLabel}>{LIFECYCLE_LABEL[state]}</Text>
            </View>
          ))}
          <View style={styles.cell}>
            <LifecycleGlyph state="in_progress" size={iconSize.md} />
            <Text style={styles.cellLabel}>In progress · live</Text>
          </View>
        </View>
      </Section>

      <Section title="Status" caption="A shape per tone, never a dot. Working is the working mark.">
        <View style={styles.grid}>
          {STATUS_TONES.map((tone) => (
            <View key={tone} style={styles.cell}>
              <StatusShape tone={tone} size={iconSize.md} />
              <Text style={styles.cellLabel}>{tone}</Text>
            </View>
          ))}
          {WORKING_MARK_VARIANTS.map((variant) => (
            <View key={variant} style={styles.cell}>
              <WorkingMark seed={variant} size={iconSize.md} variant={variant} />
              <Text style={styles.cellLabel}>{variant}</Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="Agent characters" caption="Every drawing in every state; the season's pool picks which one an agent wears.">
        <View style={styles.grid}>
          {(Object.keys(AGENT_CHARACTERS) as AgentCharacterId[]).flatMap((character) =>
            AGENT_STATES.map((state) => (
              <View key={`${character}-${state}`} style={styles.cell}>
                <AgentGlyph agentId={character} character={character} size={iconSize.lg} state={state} />
                <Text style={styles.cellLabel}>
                  {AGENT_CHARACTERS[character].name} · {state}
                </Text>
              </View>
            )),
          )}
        </View>
      </Section>

      <Section title="Backlog type" caption="Epic rolls up work; the rest are leaves.">
        <View style={styles.grid}>
          {BACKLOG_TYPES.map((type) => (
            <View key={type} style={styles.cell}>
              <BacklogTypeGlyph type={type} size={iconSize.md} />
              <Text style={styles.cellLabel}>{type}</Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="Triage" caption="Unset reads as a calm dash, never a warning.">
        <View style={styles.grid}>
          {DIFFICULTIES.map((difficulty) => (
            <View key={difficulty ?? "unset"} style={styles.cell}>
              <DifficultyLabel difficulty={difficulty} />
              <Text style={styles.cellLabel}>{difficulty ?? "unset"}</Text>
            </View>
          ))}
          {CRITICALITIES.map((level) => (
            <View key={level ?? "unset"} style={styles.cell}>
              <CriticalityBars level={level} size={iconSize.sm} />
              <Text style={styles.cellLabel}>{level ?? "unset"}</Text>
            </View>
          ))}
        </View>
      </Section>

      <Section title="Chrome — tabs" caption="Muted at rest, one accent when active.">
        <View style={styles.grid}>
          <View style={styles.cell}>
            <BacklogIcon />
            <Text style={styles.cellLabel}>Backlog</Text>
          </View>
          <View style={styles.cell}>
            <SettingsIcon />
            <Text style={styles.cellLabel}>Settings</Text>
          </View>
          <View style={styles.cell}>
            <BacklogIcon tone="accentPrimary" />
            <Text style={styles.cellLabel}>Backlog · active</Text>
          </View>
          <View style={styles.cell}>
            <SettingsIcon tone="accentPrimary" />
            <Text style={styles.cellLabel}>Settings · active</Text>
          </View>
        </View>
      </Section>

      <Section title="Chrome — controls">
        <View style={styles.grid}>
          <View style={styles.cell}>
            <ChevronIcon direction="up" size={iconSize.md} />
            <Text style={styles.cellLabel}>Chevron up</Text>
          </View>
          <View style={styles.cell}>
            <ChevronIcon direction="right" size={iconSize.md} />
            <Text style={styles.cellLabel}>Chevron right</Text>
          </View>
          <View style={styles.cell}>
            <ChevronIcon direction="down" size={iconSize.md} />
            <Text style={styles.cellLabel}>Chevron down</Text>
          </View>
          <View style={styles.cell}>
            <ChevronIcon direction="left" size={iconSize.md} />
            <Text style={styles.cellLabel}>Chevron left</Text>
          </View>
          <View style={styles.cell}>
            <FilterIcon size={iconSize.md} />
            <Text style={styles.cellLabel}>Filter</Text>
          </View>
          <View style={styles.cell}>
            <GearIcon size={iconSize.md} />
            <Text style={styles.cellLabel}>Gear</Text>
          </View>
          <View style={styles.cell}>
            <CloseIcon size={iconSize.md} />
            <Text style={styles.cellLabel}>Close</Text>
          </View>
          <View style={styles.cell}>
            <ExpandIcon size={iconSize.md} />
            <Text style={styles.cellLabel}>Expand</Text>
          </View>
          <View style={styles.cell}>
            <CollapseIcon size={iconSize.md} />
            <Text style={styles.cellLabel}>Collapse</Text>
          </View>
          <View style={styles.cell}>
            <SearchIcon size={iconSize.md} />
            <Text style={styles.cellLabel}>Search</Text>
          </View>
        </View>
      </Section>

      <Section title="Size ramp" caption="xs 14 · sm 16 · md 18 · lg 22">
        <View style={styles.grid}>
          {(Object.entries(iconSize) as [string, number][]).map(([name, size]) => (
            <View key={name} style={styles.cell}>
              <LifecycleGlyph state="review" size={size} />
              <Text style={styles.cellLabel}>
                {name} · {size}
              </Text>
            </View>
          ))}
        </View>
      </Section>
    </ScrollView>
  );
}

function Section({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {caption ? <Text style={styles.sectionCaption}>{caption}</Text> : null}
      {children}
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    canvas: {
      flex: 1,
      backgroundColor: colors.bgApp,
    },
    content: {
      padding: space.xl,
      paddingBottom: space["4xl"],
      gap: space["3xl"],
    },
    title: {
      ...typography.title,
      color: colors.textPrimary,
    },
    section: {
      gap: space.sm,
    },
    sectionTitle: {
      ...typography.heading,
      color: colors.textPrimary,
    },
    sectionCaption: {
      ...typography.meta,
      color: colors.textMuted,
    },
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      backgroundColor: colors.bgSurface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderDefault,
      borderRadius: 7,
      paddingVertical: space.lg,
    },
    cell: {
      width: "25%",
      alignItems: "center",
      gap: space["2xs"],
      paddingVertical: space.sm,
      paddingHorizontal: space["2xs"],
    },
    cellLabel: {
      ...typography.micro,
      color: colors.textMuted,
      textAlign: "center",
    },
  });
