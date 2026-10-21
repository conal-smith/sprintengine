import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { cardSurface } from "../../components/Card";
import { DocumentView } from "../../components/document/DocumentView";
import { formatTimestamp } from "../../components/formatTimestamp";
import {
  BacklogTypeGlyph,
  CriticalityBars,
  DifficultyLabel,
  LifecycleGlyph,
  type LifecycleState,
} from "../../components/glyphs";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { space, typography, type Theme, fontWeight } from "../../theme/tokens";
import type { MobileControlBacklogItemStatus } from "../../shared/mobile-control";
import type { BacklogUpdateInput, BacklogCommandCapabilities } from "./BacklogScreen";
import {
  backlogCriticalityOptions,
  backlogDifficultyOptions,
  backlogHighlightHexByTheme,
  backlogStatusLabel,
  backlogTypeOptions,
  epicColor,
  type BacklogEpicMeta,
  type BacklogRowItem,
} from "./backlogLogic";
import { capitalizeToken, OptionRow } from "./createFormShared";

/** The three axes `backlog.update` can set beyond `status`. */
type TriageOverride = Pick<BacklogUpdateInput, "type" | "difficulty" | "criticality">;

type TriageAxis = keyof TriageOverride;

/**
 * One optimistic triage edit: the value the user picked, and the value the wire
 * held when they picked it.
 *
 * `base` is what makes the edit retirable. An edit that only retires when the
 * snapshot *agrees* with it can outlive its welcome forever — the desktop may
 * accept the command and store a normalized value, or may not bump
 * `snapshotVersion` for a backlog-file edit at all (the provider skips
 * `setSnapshot` when the version is unchanged). Either way the axis would never
 * agree, the edit would never clear, and it would go on masking every later
 * change made on the desktop. Retiring on "the wire moved off `base`" covers
 * agreement and disagreement alike.
 */
interface TriageEdit<V> {
  value: V;
  base: V | undefined;
}

interface TriageEdits {
  type?: TriageEdit<NonNullable<TriageOverride["type"]>>;
  difficulty?: TriageEdit<NonNullable<TriageOverride["difficulty"]>>;
  criticality?: TriageEdit<NonNullable<TriageOverride["criticality"]>>;
}

const STATUS_TO_LIFECYCLE: Record<MobileControlBacklogItemStatus, LifecycleState> = {
  idea: "idea",
  ready: "ready",
  in_progress: "in_progress",
  needs_input: "needs_input",
  completed: "done",
  archived: "archived",
};

// Command failures surface through the shared toast; only the in-flight
// action needs local state (it labels and disables the pressed control).
type CommandState = { status: "idle" } | { status: "pending"; action: "update" };

interface BacklogItemDetailScreenProps {
  item: BacklogRowItem | null;
  capabilities: BacklogCommandCapabilities;
  onBack: () => void;
  onUpdateItem: ((input: BacklogUpdateInput) => Promise<void>) | null;
  /**
   * The snapshot's metadata for this item's epic. Must be the same
   * lookup the list row makes, or the two surfaces show one epic in two colours.
   */
  epicMeta?: BacklogEpicMeta;
}

/**
 * Full-screen backlog item detail on the desktop triage vocabulary. The body is
 * the snapshot excerpt, clearly labeled as an excerpt — no full item body is
 * fetchable today (the fetch is structured so a future item-read capability drops
 * in; gap tracked on the mobile-control-parity epic). Actions are capability-gated.
 */
export function BacklogItemDetailScreen({
  item,
  capabilities,
  onBack,
  onUpdateItem,
  epicMeta,
}: BacklogItemDetailScreenProps) {
  const styles = useThemedStyles(createStyles);
  const [commandState, setCommandState] = useState<CommandState>({ status: "idle" });
  // The triage the user just set, shown until the desktop's snapshot catches up.
  // A command round-trip plus a snapshot re-read is a second or more; without
  // this the chip would spring back to its old value under the user's thumb.
  const [triageEdits, setTriageEdits] = useState<TriageEdits>({});

  const itemType = item?.type;
  const itemDifficulty = item?.difficulty;
  const itemCriticality = item?.criticality;

  // Retire an edit as soon as the wire moves off the value it was made against.
  // From that moment the desktop is the truth again — whether it landed on what
  // the user picked or on something else entirely. Returning `current` unchanged
  // keeps this from looping.
  useEffect(() => {
    setTriageEdits((current) => {
      const next: TriageEdits = { ...current };
      let changed = false;
      if (next.type && next.type.base !== itemType) {
        delete next.type;
        changed = true;
      }
      if (next.difficulty && next.difficulty.base !== itemDifficulty) {
        delete next.difficulty;
        changed = true;
      }
      if (next.criticality && next.criticality.base !== itemCriticality) {
        delete next.criticality;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [itemType, itemDifficulty, itemCriticality]);

  if (!item) {
    return (
      <Screen backLabel="Backlog" onBack={onBack} title="Item">
        <View style={styles.missing}>
          <Text style={styles.missingText}>Not in the latest sync. Pull to refresh.</Text>
        </View>
      </Screen>
    );
  }

  // What the screen shows: the optimistic value where one is live, the snapshot's
  // otherwise. Read axis by axis, never `{...item, ...edits}` — a key holding
  // `undefined` would blank a real value from the wire.
  const shownType = triageEdits.type?.value ?? item.type;
  const shownDifficulty = triageEdits.difficulty?.value ?? item.difficulty;
  const shownCriticality = triageEdits.criticality?.value ?? item.criticality;

  const isEpic = shownType === "epic";
  const pending = commandState.status === "pending";
  const updateEligible = capabilities.canUpdate && onUpdateItem !== null && (item.status === "idea" || item.status === "ready");
  // Triage is not gated on status the way the idea/ready toggle is: re-sizing or
  // re-prioritising an item that is already running is a normal thing to do. The
  // desktop revalidates and is the authority.
  const triageEligible = capabilities.canUpdate && onUpdateItem !== null;

  const handleStatusToggle = async () => {
    if (!onUpdateItem) return;
    const nextStatus = item.status === "idea" ? "ready" : "idea";
    setCommandState({ status: "pending", action: "update" });
    try {
      await onUpdateItem({ workspacePath: item.workspacePath, relativePath: item.relativePath, status: nextStatus });
      setCommandState({ status: "idle" });
    } catch {
      // Already toasted by the command layer.
      setCommandState({ status: "idle" });
    }
  };

  /**
   * One triage axis, sent on its own. `backlog.update` reads an omitted field as
   * "leave it alone", so sending only the touched axis is what keeps this from
   * silently re-asserting stale values for the other two.
   */
  const commitTriage = async (axis: TriageAxis, edits: TriageEdits, patch: TriageOverride) => {
    if (!onUpdateItem) return;

    setTriageEdits((current) => ({ ...current, ...edits }));
    setCommandState({ status: "pending", action: "update" });
    try {
      await onUpdateItem({ workspacePath: item.workspacePath, relativePath: item.relativePath, ...patch });
      setCommandState({ status: "idle" });
    } catch {
      // Already toasted by the command layer. Drop *this* axis's edit — leaving
      // it would show a triage the desktop never accepted.
      //
      // Only this axis, and read from the live state rather than from a map
      // captured at tap time: another axis may have been edited while this
      // command was in flight, and restoring a stale snapshot of the whole map
      // would resurrect an edit the clearing effect had already retired. A
      // resurrected edit is never re-examined, and would mask that axis forever.
      setTriageEdits((current) => {
        const next: TriageEdits = { ...current };
        delete next[axis];
        return next;
      });
      setCommandState({ status: "idle" });
    }
  };

  return (
    <Screen backLabel="Backlog" onBack={onBack} title={isEpic ? "Epic" : "Item"}>
      <View style={styles.header}>
        <View style={styles.headerGlyph}>
          {isEpic ? (
            <BacklogTypeGlyph type="epic" size={24} />
          ) : (
            <LifecycleGlyph state={STATUS_TO_LIFECYCLE[item.status]} live={item.status === "in_progress"} size={24} />
          )}
        </View>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>{item.title}</Text>
          <Text style={styles.statusWord}>{backlogStatusLabel[item.status]}</Text>
        </View>
      </View>

      <View style={styles.triageRow}>
        <Text style={styles.id}>{item.itemId}</Text>
        {!isEpic ? <DifficultyLabel difficulty={shownDifficulty} /> : null}
        {!isEpic && shownCriticality ? <CriticalityBars level={shownCriticality} /> : null}
        {item.epic ? <EpicChip slug={item.epic} meta={epicMeta} /> : null}
        {item.updatedAt ? <Text style={styles.age}>Updated {formatTimestamp(item.updatedAt)}</Text> : null}
      </View>

      <Text numberOfLines={1} style={styles.path}>
        {item.relativePath}
      </Text>

      <View style={styles.bodyBlock}>
        <Text style={styles.bodyLabel}>Excerpt</Text>
        {item.excerpt ? (
          // The excerpt is the only body the snapshot carries (280-char cap, no
          // item-read command yet — gap on the mobile-control-parity epic). It is
          // rendered through the shared T5 renderer so any markdown reads
          // correctly, and always labeled as an excerpt, never the full document.
          <DocumentView body={item.excerpt} kind="markdown" title={item.title} />
        ) : (
          <Text style={styles.excerptEmpty}>No excerpt. Open it on the desktop.</Text>
        )}
        <Text style={styles.excerptNote}>Excerpt only. The full document is on the desktop.</Text>
      </View>

      {/* The triage header above renders these three axes read-only; this is
          where they become editable. The wire has always accepted them
          (`backlog.update` carries type/difficulty/criticality) — only the phone's
          UI was missing, so an item could be shown but not fully triaged. */}
      {triageEligible ? (
        <View style={styles.bodyBlock}>
          <Text style={styles.bodyLabel}>Triage</Text>
          {/* Each edit carries the wire value it was made against (`base`), which
              is what lets it retire once the desktop moves — see TriageEdit. */}
          <OptionRow
            disabled={pending}
            format={capitalizeToken}
            label="Type"
            onSelect={(next) => void commitTriage("type", { type: { value: next, base: item.type } }, { type: next })}
            options={backlogTypeOptions}
            selected={shownType}
          />
          <OptionRow
            disabled={pending}
            format={(value) => value.toUpperCase()}
            label="Difficulty"
            onSelect={(next) =>
              void commitTriage("difficulty", { difficulty: { value: next, base: item.difficulty } }, { difficulty: next })
            }
            options={backlogDifficultyOptions}
            selected={shownDifficulty}
          />
          <OptionRow
            disabled={pending}
            format={capitalizeToken}
            label="Criticality"
            onSelect={(next) =>
              void commitTriage("criticality", { criticality: { value: next, base: item.criticality } }, { criticality: next })
            }
            options={backlogCriticalityOptions}
            selected={shownCriticality}
          />
          {/* Said once, not implied by a chip that quietly does nothing: the wire
              has no way to express "clear this axis". */}
          <Text style={styles.excerptNote}>Each change is sent on tap.</Text>
        </View>
      ) : null}

      <View style={styles.actions}>
        {updateEligible ? (
          <PrimaryButton
            disabled={pending}
            label={
              pending && commandState.action === "update"
                ? "Updating…"
                : item.status === "idea"
                  ? "Mark ready"
                  : "Move back to idea"
            }
            onPress={handleStatusToggle}
            variant="secondary"
          />
        ) : null}
        {!updateEligible ? (
          <Text style={styles.unavailableText}>
            Backlog actions are not available from mobile in this session.
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * Deliberately the same rules as `BacklogRow`'s chip: the epic's own colour and
 * display id when the snapshot's `epics` block covers it, the slug hash and the
 * raw slug when it does not. The two surfaces show the same epic, so they must
 * agree — a list row and its detail disagreeing about an epic's colour is the
 * kind of drift a person reads as a bug in the data.
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
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.lg,
    },
    headerGlyph: {
      marginTop: space["3xs"],
    },
    headerCopy: {
      flex: 1,
      gap: space["2xs"],
    },
    title: {
      ...typography.title,
      fontWeight: fontWeight.emphasis,
      letterSpacing: -0.3,
      color: colors.textPrimary,
    },
    statusWord: {
      ...typography.meta,
      color: colors.textMuted,
    },
    triageRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
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
      color: colors.textSubtle,
      fontVariant: ["tabular-nums"],
    },
    path: {
      ...typography.micro,
      fontWeight: fontWeight.regular,
      color: colors.textSubtle,
      fontFamily: monoFontFamily,
    },
    bodyBlock: {
      ...cardSurface({ colors, ...theme }),
      gap: space.sm,
      paddingHorizontal: space.xl,
      paddingVertical: space.xl,
    },
    // Sentence case, no tracking — uppercase-tracked labels are a brand reject.
    bodyLabel: {
      ...typography.meta,
      fontWeight: fontWeight.medium,
      color: colors.textMuted,
    },
    excerptEmpty: {
      ...typography.body,
      color: colors.textMuted,
      fontStyle: "italic",
    },
    excerptNote: {
      ...typography.micro,
      fontWeight: fontWeight.regular,
      color: colors.textSubtle,
    },
    actions: {
      gap: space.md,
    },
    unavailableText: {
      ...typography.meta,
      color: colors.textMuted,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
      maxWidth: 200,
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
    missing: {
      ...cardSurface({ colors, ...theme }),
      paddingHorizontal: space.xl,
      paddingVertical: space["2xl"],
    },
    missingText: {
      ...typography.body,
      color: colors.textMuted,
    },
  });
