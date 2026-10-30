import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { createPullRequestApi, pullRequestReadsUnsupported, type PullRequestDetail } from "../../api/pullRequests";
import { tailnetClientForSession } from "../../api/tailnetControlClient";
import type { MobileSession } from "../../api/types";
import { Card, CardRow } from "../../components/Card";
import { formatTimestamp } from "../../components/formatTimestamp";
import { iconSize, PullRequestStateGlyph, StatusShape } from "../../components/glyphs";
import { PrimaryButton } from "../../components/PrimaryButton";
import { Screen } from "../../components/Screen";
import { WorkingMark } from "../../components/WorkingMark";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { fontWeight, space, typography, type Theme } from "../../theme/tokens";
import { LineCounts, StatusTile } from "../conversations/ConversationChangesScreen";
import { splitPath } from "../diff/unifiedDiff";
import {
  branchWords,
  checksSummaryWords,
  fileChangeStatus,
  filesNotListed,
  pullRequestStateWords,
  remarksSummaryWords,
  reviewSummaryWords,
} from "./pullRequestView";

type ReadView =
  | { status: "loading" }
  | { status: "ready"; detail: PullRequestDetail }
  | { status: "error"; message: string; unsupported: boolean };

/**
 * A chat's pull request, read through the desktop that lists it: its title
 * and state, its checks, its reviews and latest comments, and the files it
 * changes, each opening onto its diff. Read-only: it changes nothing on
 * GitHub, and Open on GitHub is always there for anything more.
 */
export function PullRequestScreen({
  session,
  url,
  onBack,
  onOpenFile,
  onOpenInBrowser,
}: {
  session: MobileSession | null;
  url: string;
  onBack: () => void;
  onOpenFile: (path: string) => void;
  onOpenInBrowser: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const api = useMemo(() => (session ? createPullRequestApi(tailnetClientForSession(session)) : null), [session]);
  const [view, setView] = useState<ReadView>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const load = useCallback(async () => {
    if (!api) {
      setView({ status: "error", message: "This desktop is no longer paired with this phone.", unsupported: false });
      return;
    }
    const result = await api.read(url);
    if (!live.current) return;
    if (result.ok && result.data) setView({ status: "ready", detail: result.data });
    else
      setView({
        status: "error",
        unsupported: pullRequestReadsUnsupported(result),
        message: pullRequestReadsUnsupported(result)
          ? `Update Studio on ${session?.desktopName ?? "the desktop"} to read pull requests here.`
          : (result.message ?? "The desktop did not answer."),
      });
  }, [api, session?.desktopName, url]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => {
      if (live.current) setRefreshing(false);
    });
  }, [load]);

  const detail = view.status === "ready" ? view.detail : null;
  const state = detail ? pullRequestStateWords(detail) : null;
  const branches = detail ? branchWords(detail) : null;
  return (
    <Screen
      title={detail?.number ? `#${detail.number}` : "Pull request"}
      subtitle={
        state ? (
          <View style={styles.subtitle}>
            <PullRequestStateGlyph color={colors[state.tone]} size={iconSize.xs} state={detail!.state} />
            <Text numberOfLines={1} style={[styles.meta, { color: colors[state.tone] }]}>
              {state.text}
            </Text>
            {branches ? (
              <Text numberOfLines={1} style={[styles.meta, styles.branches]}>
                {branches}
              </Text>
            ) : null}
          </View>
        ) : undefined
      }
      onBack={onBack}
      backLabel="Back"
      onRefresh={refresh}
      refreshing={refreshing}
    >
      {view.status === "loading" ? (
        <View accessibilityLiveRegion="polite" style={styles.loading}>
          <WorkingMark label="Loading pull request" seed={url} />
          <Text style={styles.meta}>Loading pull request…</Text>
        </View>
      ) : view.status === "error" ? (
        <View style={styles.block}>
          <Text accessibilityRole="alert" style={styles.body}>
            {view.message}
          </Text>
          {view.unsupported ? null : <PrimaryButton label="Try again" onPress={refresh} variant="secondary" />}
          <PrimaryButton label="Open on GitHub" onPress={onOpenInBrowser} variant="ghost" />
        </View>
      ) : (
        <PullRequestBody detail={view.detail} onOpenFile={onOpenFile} onOpenInBrowser={onOpenInBrowser} />
      )}
    </Screen>
  );
}

function PullRequestBody({
  detail,
  onOpenFile,
  onOpenInBrowser,
}: {
  detail: PullRequestDetail;
  onOpenFile: (path: string) => void;
  onOpenInBrowser: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const checks = checksSummaryWords(detail.checks);
  const opened = detail.openedAt ? formatTimestamp(new Date(detail.openedAt).toISOString()) : null;
  return (
    <View style={styles.sections}>
      <View style={styles.block}>
        <Text accessibilityRole="header" style={styles.title}>
          {detail.title ?? "Untitled pull request"}
        </Text>
        <Text style={styles.meta}>
          {[detail.author ? `by ${detail.author}` : null, opened ? `opened ${opened}` : null]
            .filter(Boolean)
            .join(", ")}
          {detail.state === "open" && detail.mergeable === "conflicting" ? " · Has conflicts with its base" : ""}
        </Text>
      </View>

      <Section title="Checks">
        <Card variant="list">
          <CardRow
            accessibilityLabel={`Checks: ${checks.text}`}
            first
            leading={<StatusShape size={iconSize.sm} tone={checks.tone} />}
            title={<Text style={styles.rowTitle}>{checks.text}</Text>}
          />
          {detail.checks.items
            .filter((check) => check.status !== "passed")
            .map((check) => (
              <CardRow
                accessibilityLabel={`${check.name}, ${check.status === "failed" ? "failing" : "running"}${check.required ? ", required" : ""}`}
                key={`${check.workflow}\u0000${check.name}`}
                leading={<StatusShape size={iconSize.sm} tone={check.status === "failed" ? "danger" : "warn"} />}
                meta={
                  check.workflow || check.required ? (
                    <Text numberOfLines={1} style={styles.meta}>
                      {[check.workflow, check.required ? "required" : null].filter(Boolean).join(" · ")}
                    </Text>
                  ) : undefined
                }
                title={
                  <Text numberOfLines={1} style={styles.rowTitle}>
                    {check.name}
                  </Text>
                }
              />
            ))}
        </Card>
      </Section>

      <Section title="Reviews and comments">
        <Card variant="list">
          <CardRow first title={<Text style={styles.rowTitle}>{reviewSummaryWords(detail)}</Text>} />
          <CardRow title={<Text style={styles.rowTitle}>{remarksSummaryWords(detail.remarks)}</Text>} />
          {detail.remarks.latest.map((remark, index) => (
            <CardRow
              key={`${remark.at}:${index}`}
              meta={
                remark.excerpt ? (
                  <Text numberOfLines={3} style={styles.excerpt}>
                    {remark.excerpt}
                  </Text>
                ) : undefined
              }
              title={
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {remark.author}
                  <Text style={styles.meta}>
                    {`  ${remark.kind === "review" ? VERDICT_WORDS[remark.verdict ?? "commented"] : "commented"}`}
                    {remark.at ? ` · ${formatTimestamp(new Date(remark.at).toISOString())}` : ""}
                  </Text>
                </Text>
              }
              titleNumberOfLines={1}
            />
          ))}
        </Card>
      </Section>

      <Section
        title="Files changed"
        trailing={
          detail.files ? (
            <Text style={styles.counts}>
              {detail.files.total} {detail.files.total === 1 ? "file" : "files"} ·{" "}
              <LineCounts added={detail.files.additions} removed={detail.files.deletions} />
            </Text>
          ) : null
        }
      >
        {detail.files === null ? (
          <Text style={styles.meta}>The desktop could not read which files this pull request changes.</Text>
        ) : detail.files.items.length === 0 ? (
          <Text style={styles.meta}>This pull request changes no files.</Text>
        ) : (
          <Card variant="list">
            {detail.files.items.map((file, index) => {
              const { dir, name } = splitPath(file.path);
              const status = fileChangeStatus(file.change);
              return (
                <CardRow
                  accessibilityLabel={`${file.path}, ${status}, ${file.additions} added, ${file.deletions} removed`}
                  chevron
                  first={index === 0}
                  key={file.path}
                  leading={<StatusTile status={status} />}
                  meta={
                    dir ? (
                      <Text ellipsizeMode="head" numberOfLines={1} style={styles.meta}>
                        {dir}
                      </Text>
                    ) : undefined
                  }
                  onPress={() => onOpenFile(file.path)}
                  title={
                    <Text numberOfLines={1} style={styles.rowTitle}>
                      {name}
                    </Text>
                  }
                  trailing={
                    <Text style={styles.counts}>
                      <LineCounts added={file.additions} removed={file.deletions} />
                    </Text>
                  }
                />
              );
            })}
          </Card>
        )}
        {detail.files && filesNotListed(detail.files) > 0 ? (
          <Text style={styles.meta}>
            {filesNotListed(detail.files)} more not listed here. Open it on GitHub to see every file.
          </Text>
        ) : null}
      </Section>

      <PrimaryButton label="Open on GitHub" onPress={onOpenInBrowser} variant="secondary" />
    </View>
  );
}

const VERDICT_WORDS: Record<"approved" | "changes-requested" | "commented", string> = {
  approved: "approved",
  "changes-requested": "asked for changes",
  commented: "reviewed",
};

function Section({ title, trailing, children }: { title: string; trailing?: ReactNode; children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text accessibilityRole="header" style={styles.sectionTitle}>
          {title}
        </Text>
        {trailing}
      </View>
      {children}
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    subtitle: { flexDirection: "row", alignItems: "center", gap: space.xs, minWidth: 0 },
    branches: { flexShrink: 1 },
    loading: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingTop: space.xl },
    sections: { gap: space["2xl"], paddingTop: space.lg },
    section: { gap: space.sm },
    sectionHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.sm },
    sectionTitle: { ...typography.meta, fontWeight: fontWeight.medium, color: colors.textSubtle },
    block: { gap: space.sm, paddingTop: space.xl },
    title: { ...typography.heading, color: colors.textPrimary },
    body: { ...typography.body, color: colors.textPrimary },
    rowTitle: { ...typography.body, color: colors.textPrimary },
    meta: { ...typography.meta, color: colors.textMuted },
    excerpt: { ...typography.meta, color: colors.textDefault },
    counts: { ...typography.meta, color: colors.textSubtle, fontVariant: ["tabular-nums"] },
  });
