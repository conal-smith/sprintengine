import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { createPullRequestApi, joinDiffPages, type PullRequestDiffPage } from "../../api/pullRequests";
import { tailnetClientForSession } from "../../api/tailnetControlClient";
import type { MobileSession } from "../../api/types";
import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenFrame, useScreenBottomInset } from "../../components/Screen";
import { WorkingMark } from "../../components/WorkingMark";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { space, typography, type Theme } from "../../theme/tokens";
import { UnifiedDiff } from "../conversations/ConversationFileDiffScreen";
import { splitPath } from "../diff/unifiedDiff";
import { diffProgress } from "./pullRequestView";

/**
 * One file of a pull request as a unified diff, read a page at a time: the
 * desktop sends a few hundred lines, cut between hunks, and Show more reads
 * the next page onto the end, so a large change costs only what is read of it.
 */
export function PullRequestFileScreen({
  session,
  url,
  path,
  onBack,
}: {
  session: MobileSession | null;
  url: string;
  path: string;
  onBack: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const inset = useScreenBottomInset();
  const api = useMemo(() => (session ? createPullRequestApi(tailnetClientForSession(session)) : null), [session]);
  const [pages, setPages] = useState<PullRequestDiffPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const readFrom = useCallback(
    async (offset: number) => {
      if (!api) {
        setError("This desktop is no longer paired with this phone.");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      const result = await api.diff(url, path, offset);
      if (!live.current) return;
      setLoading(false);
      if (result.ok && result.data) {
        const page = result.data;
        setPages((current) => (offset === 0 ? [page] : [...current, page]));
      } else setError(result.message ?? "The desktop did not answer.");
    },
    [api, path, url],
  );

  useEffect(() => {
    void readFrom(0);
  }, [readFrom]);

  const progress = diffProgress(pages);
  const patch = useMemo(() => joinDiffPages(pages), [pages]);
  const { dir, name } = splitPath(path);
  const next = pages[pages.length - 1]?.nextOffset ?? null;
  return (
    <ScreenFrame
      backLabel="Files changed"
      onBack={onBack}
      subtitle={
        dir ? (
          <Text numberOfLines={1} style={styles.meta}>
            {dir}
          </Text>
        ) : undefined
      }
      title={name}
    >
      <View style={styles.body}>
        {pages.length ? (
          <UnifiedDiff bottomInset={progress.more || error ? space.xl : inset + space.xl} patch={patch} />
        ) : loading ? (
          <View accessibilityLiveRegion="polite" style={styles.state}>
            <View style={styles.loading}>
              <WorkingMark label="Loading diff" seed={path} />
              <Text style={styles.meta}>Loading diff…</Text>
            </View>
          </View>
        ) : null}
        {!pages.length && error ? (
          <View style={styles.state}>
            <Text accessibilityRole="alert" style={styles.message}>
              {error}
            </Text>
            <PrimaryButton label="Try again" onPress={() => void readFrom(0)} variant="secondary" />
          </View>
        ) : null}
      </View>
      {pages.length && (progress.more || error) ? (
        <View style={[styles.footer, { paddingBottom: Math.max(inset, space.md) }]}>
          {error ? (
            <Text accessibilityRole="alert" numberOfLines={2} style={styles.footerText}>
              {error}
            </Text>
          ) : (
            <Text style={styles.footerText}>
              {progress.read} of {progress.total} lines
            </Text>
          )}
          <PrimaryButton
            disabled={loading || next === null}
            label={loading ? "Loading…" : error ? "Try again" : "Show more"}
            onPress={() => next !== null && void readFrom(next)}
            variant="ghost"
          />
        </View>
      ) : null}
    </ScreenFrame>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    body: { flex: 1 },
    state: { gap: space.sm, paddingHorizontal: space["2xl"], paddingTop: space.xl },
    loading: { flexDirection: "row", alignItems: "center", gap: space.sm },
    meta: { ...typography.meta, color: colors.textMuted },
    message: { ...typography.body, color: colors.textPrimary },
    footer: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.sm,
      paddingTop: space.sm,
      paddingHorizontal: space.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
    },
    footerText: { ...typography.meta, color: colors.textMuted, flexShrink: 1, fontVariant: ["tabular-nums"] },
  });
