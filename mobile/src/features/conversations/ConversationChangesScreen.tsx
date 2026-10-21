import { StyleSheet, Text, View } from "react-native";

import { Card, CardRow } from "../../components/Card";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { WorkingMark } from "../../components/WorkingMark";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { fontWeight, radius, space, typography, type Theme } from "../../theme/tokens";
import { diffTotals, splitPath, type ChangedFile } from "../diff/unifiedDiff";
import { useTurnFiles } from "../diff/useTurnDiff";
import { useLiveConversation, type LiveConversationKey } from "./liveConversation";

const STATUS_LETTER: Record<ChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D" };
const STATUS_WORD: Record<ChangedFile["status"], string> = { added: "added", modified: "modified", deleted: "deleted" };

/**
 * The files one turn changed, each opening onto its diff. The chat's row only
 * says there are changes; this is where they are read, so a turn that changed
 * nothing, or a desktop that could not say, says so here instead of leaving the
 * row to do nothing.
 */
export function ConversationChangesScreen({
  conversation,
  turnSeq,
  onBack,
  onOpenFile,
}: {
  conversation: LiveConversationKey;
  turnSeq: number;
  onBack: () => void;
  onOpenFile: (path: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  const live = useLiveConversation(conversation);
  const { view, retry } = useTurnFiles(live, { ...conversation, turnSeq });
  const files = view.status === "ready" ? view.value : null;
  const totals = files ? diffTotals(files) : null;
  return (
    <Screen
      title="Changed files"
      subtitle={
        totals?.files ? (
          <Text numberOfLines={1} style={styles.summary}>
            {totals.files} {totals.files === 1 ? "file" : "files"} · <LineCounts added={totals.added} removed={totals.removed} />
          </Text>
        ) : undefined
      }
      onBack={onBack}
    >
      {view.status === "loading" ? (
        <View style={styles.loading} accessibilityLiveRegion="polite">
          <WorkingMark seed={`${conversation.agentId}:${turnSeq}`} label="Loading changes" />
          <Text style={styles.meta}>Loading changes…</Text>
        </View>
      ) : view.status === "offline" ? (
        <Text style={styles.meta}>
          {view.closed
            ? "Open the chat to see what this turn changed."
            : "This chat isn't connected to the desktop right now. Its changes load when it reconnects."}
        </Text>
      ) : view.status === "error" ? (
        <View style={styles.block}>
          <Text accessibilityRole="alert" style={styles.body}>
            {view.message}
          </Text>
          <PrimaryButton label="Try again" variant="secondary" onPress={retry} />
        </View>
      ) : !files?.length ? (
        <View style={styles.block}>
          <Text style={styles.emptyTitle}>{"This turn didn't change any files."}</Text>
          <Text style={styles.meta}>
            {"Changes made by agents working in their own branch or worktree aren't included here."}
          </Text>
        </View>
      ) : (
        <Card variant="list">
          {files.map((file, index) => (
            <ChangedFileRow key={file.path} file={file} first={index === 0} onOpen={() => onOpenFile(file.path)} />
          ))}
        </Card>
      )}
    </Screen>
  );
}

function ChangedFileRow({ file, first, onOpen }: { file: ChangedFile; first: boolean; onOpen: () => void }) {
  const styles = useThemedStyles(createStyles);
  const { dir, name } = splitPath(file.path);
  const counts = file.binary ? "binary" : `${file.addedLines} added, ${file.removedLines} removed`;
  return (
    <CardRow
      first={first}
      onPress={onOpen}
      accessibilityLabel={`${file.path}, ${STATUS_WORD[file.status]}, ${counts}`}
      leading={<StatusTile status={file.status} />}
      title={
        <Text numberOfLines={1} style={styles.name}>
          {name}
        </Text>
      }
      // The folder is what tells two `index.ts` apart, and its tail is the part
      // that does: a long path gives up its head.
      meta={
        dir ? (
          <Text numberOfLines={1} ellipsizeMode="head" style={styles.dir}>
            {dir}
          </Text>
        ) : undefined
      }
      trailing={
        file.binary ? (
          <Text style={styles.counts}>binary</Text>
        ) : (
          <Text style={styles.counts}>
            <LineCounts added={file.addedLines} removed={file.removedLines} />
          </Text>
        )
      }
      chevron
    />
  );
}

/** A file's status as a lettered tile: added in good ink, modified in accent, deleted in error ink. */
export function StatusTile({ status }: { status: ChangedFile["status"] }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.tile, status === "added" ? styles.tileAdded : status === "deleted" ? styles.tileDeleted : styles.tileModified]}
    >
      <Text
        style={[
          styles.tileLetter,
          status === "added" ? styles.goodInk : status === "deleted" ? styles.errorInk : styles.accentInk,
        ]}
      >
        {STATUS_LETTER[status]}
      </Text>
    </View>
  );
}

/** `+A −R`, each in its tone's ink. Nested in the caller's `Text`, which sets the size. */
export function LineCounts({ added, removed }: { added: number; removed: number }) {
  const styles = useThemedStyles(createStyles);
  return (
    <>
      <Text style={styles.goodInk}>+{added}</Text> <Text style={styles.errorInk}>−{removed}</Text>
    </>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    meta: { ...typography.meta, color: colors.textMuted },
    body: { ...typography.body, color: colors.textPrimary },
    summary: { ...typography.meta, color: colors.textMuted, fontVariant: ["tabular-nums"] },
    block: { gap: space.sm, paddingTop: space.xl },
    loading: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.xl },
    emptyTitle: { ...typography.body, fontWeight: fontWeight.emphasis, color: colors.textPrimary },
    name: { ...typography.body, fontWeight: fontWeight.emphasis, color: colors.textPrimary },
    dir: { ...typography.meta, color: colors.textMuted },
    counts: { ...typography.meta, color: colors.textSubtle, fontVariant: ["tabular-nums"] },
    goodInk: { color: colors.toneGood },
    errorInk: { color: colors.toneError },
    accentInk: { color: colors.accentPrimary },
    tile: {
      width: 26,
      height: 26,
      borderRadius: radius.control,
      alignItems: "center",
      justifyContent: "center",
    },
    tileAdded: { backgroundColor: colors.toneGoodSoft },
    tileModified: { backgroundColor: colors.accentPrimarySoft },
    tileDeleted: { backgroundColor: colors.toneErrorSoft },
    tileLetter: { fontFamily: monoFontFamily, fontSize: 13, fontWeight: fontWeight.emphasis },
  });
