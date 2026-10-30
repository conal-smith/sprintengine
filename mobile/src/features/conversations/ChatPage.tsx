import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CircleButton } from "../../components/CircleButton";
import {
  AgentsGlyph,
  BrowserGlyph,
  CanvasGlyph,
  ChevronIcon,
  CliLogo,
  DiffGlyph,
  FolderGlyph,
  LibraryGlyph,
} from "../../components/glyphs";
import { useReducedMotion } from "../../components/motion";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { iconSize, radius, space, typography, type Theme } from "../../theme/tokens";
import { urlHost, type ChatActivity, type ChatActivityKind } from "./chatActivity";
import { ConversationPicture, type ChatImages, type SentImages } from "./ConversationImage";
import { SentPhotoSquares } from "./SentPhotoSquares";

// The chat's own page: what the title pill at the top of a chat opens, in
// place of the header bar the chat screen no longer has. Who and where the
// chat is (its runtime's mark, title, project, machine and model), then what
// its agent touched — the desktop card's rows, in the same order — then the
// actions the header's More menu used to hold.
//
// Changes and Agents open the screens the phone already has. The Library, and
// what the agent did in the browser and on a canvas, are views of this page.

type View_ = "page" | "library" | "browser" | "canvas";

export type ChatPageAction = { label: string; sub?: string; onPress: () => void };
export type ChatPageFact = { label: string; value: string };

const GLYPH: Record<ChatActivityKind, typeof DiffGlyph> = {
  changes: DiffGlyph,
  agents: AgentsGlyph,
  browser: BrowserGlyph,
  canvas: CanvasGlyph,
  library: LibraryGlyph,
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function ChatPage({
  visible,
  onClose,
  title,
  cli,
  chips,
  facts,
  activity,
  diff,
  onOpenChanges,
  onOpenAgents,
  actions,
  sent,
  images,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  cli: string | null;
  /** The project, the machine and the model, in that order, where known. */
  chips: string[];
  /** The details the header's popover said: machine, address, agent, access. */
  facts: ChatPageFact[];
  activity: ChatActivity;
  /** The chat's changed lines, as the composer strip counts them. */
  diff: { added: number | null; removed: number | null; files: number } | null;
  onOpenChanges?: () => void;
  onOpenAgents?: () => void;
  actions: ChatPageAction[];
  sent: SentImages | null;
  images: ChatImages | null;
}) {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [view, setView] = useState<View_>("page");
  const close = () => {
    setView("page");
    onClose();
  };
  const back = view === "page" ? close : () => setView("page");
  // Changes and Agents are screens of their own: the page closes first, so
  // back from them lands in the chat.
  const leaveFor = (open: (() => void) | undefined) => () => {
    close();
    open?.();
  };

  const row = (kind: ChatActivityKind): { label: string; meta: string | null; live: boolean; onPress?: () => void } => {
    switch (kind) {
      case "changes":
        return {
          label: "Changes",
          meta: diff
            ? diff.added !== null && diff.removed !== null
              ? `+${diff.added} −${diff.removed}`
              : plural(diff.files, "file")
            : null,
          live: activity.editing,
          ...(onOpenChanges ? { onPress: leaveFor(onOpenChanges) } : {}),
        };
      case "agents": {
        const agents = activity.agents ?? { total: 0, working: 0 };
        return {
          label: "Agents",
          meta: agents.working ? `${agents.working} working` : "All done",
          live: agents.working > 0,
          ...(onOpenAgents ? { onPress: leaveFor(onOpenAgents) } : {}),
        };
      }
      case "browser":
        return {
          label: "Browser",
          meta: activity.browser?.live ? "Agent here" : urlHost(activity.browser?.url ?? null),
          live: activity.browser?.live ?? false,
          onPress: () => setView("browser"),
        };
      case "canvas":
        return {
          label: "Canvas",
          meta: activity.canvas?.live ? "Drawing" : (activity.canvas?.board ?? null),
          live: activity.canvas?.live ?? false,
          onPress: () => setView("canvas"),
        };
      case "library":
        return {
          label: "Library",
          meta: plural(activity.sent.length + activity.steps.length, "picture"),
          live: false,
          onPress: () => setView("library"),
        };
    }
  };

  return (
    <Modal animationType={reducedMotion ? "none" : "slide"} onRequestClose={back} visible={visible}>
      <View accessibilityViewIsModal style={[styles.root, { paddingTop: insets.top }]}>
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space["4xl"] }]}>
          {view === "page" ? (
            <>
              <View style={styles.hero}>
                <View style={styles.mark}>
                  <CliLogo cli={cli} size={34} />
                </View>
                <Text accessibilityRole="header" style={styles.title}>
                  {title}
                </Text>
                {chips.length ? (
                  <View style={styles.chips}>
                    {chips.map((chip, index) => (
                      <View key={chip} style={styles.chip}>
                        {index === 0 ? <FolderGlyph size={iconSize.xs} /> : null}
                        <Text numberOfLines={1} style={styles.chipText}>
                          {chip}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>

              <Group>
                {activity.order.length ? (
                  activity.order.map((kind, index) => {
                    const { label, meta, live, onPress } = row(kind);
                    const Glyph = GLYPH[kind];
                    return (
                      <GroupRow
                        key={kind}
                        first={index === 0}
                        inset
                        glyph={<Glyph size={iconSize.md} tone={live ? "markViolet" : "textMuted"} />}
                        label={label}
                        meta={meta}
                        metaTone={live ? "live" : kind === "changes" && diff ? "diff" : "muted"}
                        onPress={onPress}
                      />
                    );
                  })
                ) : (
                  <Text style={styles.quiet}>What the agent touches shows up here.</Text>
                )}
              </Group>

              {facts.length ? (
                <Group>
                  {facts.map((fact, index) => (
                    <View key={fact.label} style={[styles.fact, index === 0 ? null : styles.divided]}>
                      <Text style={styles.factLabel}>{fact.label}</Text>
                      <Text selectable numberOfLines={2} style={styles.factValue}>
                        {fact.value}
                      </Text>
                    </View>
                  ))}
                </Group>
              ) : null}

              {actions.length ? (
                <Group>
                  {actions.map((action, index) => (
                    <GroupRow
                      key={action.label}
                      first={index === 0}
                      label={action.label}
                      sub={action.sub}
                      onPress={leaveFor(action.onPress)}
                    />
                  ))}
                </Group>
              ) : null}
            </>
          ) : view === "library" ? (
            <>
              <Text accessibilityRole="header" style={styles.viewTitle}>
                Library
              </Text>
              {activity.sent.length ? (
                <>
                  <Text style={styles.section}>From you</Text>
                  <SentPhotoSquares images={activity.sent} sent={sent} />
                </>
              ) : null}
              {activity.steps.length ? (
                <>
                  <Text style={styles.section}>From the agent</Text>
                  {images ? (
                    activity.steps.map(({ tool, picture }) => (
                      <View key={tool.id} style={styles.picture}>
                        <ConversationPicture images={images} picture={picture} toolUseId={tool.id} />
                        <Text numberOfLines={1} style={styles.caption}>
                          {picture.caption ?? picture.label}
                        </Text>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.quiet}>This desktop does not send pictures to the phone yet.</Text>
                  )}
                </>
              ) : null}
            </>
          ) : view === "browser" ? (
            <>
              <Text accessibilityRole="header" style={styles.viewTitle}>
                Browser
              </Text>
              <Group>
                <GroupRow
                  first
                  glyph={<BrowserGlyph size={iconSize.md} tone={activity.browser?.live ? "markViolet" : "textMuted"} />}
                  label={activity.browser?.url ?? "A page in the desktop's browser"}
                  meta={activity.browser?.live ? "Agent here" : null}
                  metaTone="live"
                />
              </Group>
              <Text style={styles.note}>
                The agent drove this page in the desktop&apos;s browser. A localhost page is the desktop&apos;s own, so it opens
                on the desktop, or on this phone from Web pages once the desktop publishes that server.
              </Text>
            </>
          ) : (
            <>
              <Text accessibilityRole="header" style={styles.viewTitle}>
                Canvas
              </Text>
              <Group>
                <GroupRow
                  first
                  glyph={<CanvasGlyph size={iconSize.md} tone={activity.canvas?.live ? "markViolet" : "textMuted"} />}
                  label={activity.canvas?.board ?? "A board on the desktop"}
                  meta={activity.canvas?.live ? "Drawing" : null}
                  metaTone="live"
                />
              </Group>
              <Text style={styles.note}>The agent drew on this board on the desktop. Open its Canvas there to see it.</Text>
            </>
          )}
        </ScrollView>
        <View style={[styles.float, { top: insets.top + space.xs }]}>
          <CircleButton
            icon={<ChevronIcon direction="left" size={iconSize.md} tone="textPrimary" />}
            label={view === "page" ? "Back to the chat" : "Back"}
            onPress={back}
          />
        </View>
      </View>
    </Modal>
  );
}

function Group({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  return <View style={styles.group}>{children}</View>;
}

function GroupRow({
  first,
  inset = false,
  glyph,
  label,
  sub,
  meta,
  metaTone = "muted",
  onPress,
}: {
  first: boolean;
  /** The divider starts at the label, past the glyph. */
  inset?: boolean;
  glyph?: ReactNode;
  label: string;
  sub?: string;
  meta?: string | null;
  metaTone?: "muted" | "live" | "diff";
  onPress?: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : "text"}
      accessibilityLabel={[label, meta, sub].filter(Boolean).join(", ")}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      {first ? null : <View style={[styles.rule, inset ? styles.ruleInset : null]} />}
      {glyph ? <View style={styles.glyph}>{glyph}</View> : null}
      <View style={styles.rowCopy}>
        <Text numberOfLines={1} style={styles.rowLabel}>
          {label}
        </Text>
        {sub ? (
          <Text numberOfLines={2} style={styles.rowSub}>
            {sub}
          </Text>
        ) : null}
      </View>
      {meta ? (
        <Text
          numberOfLines={1}
          style={[styles.rowMeta, metaTone === "live" ? styles.live : metaTone === "diff" ? styles.diff : null]}
        >
          {meta}
        </Text>
      ) : null}
      {onPress ? <ChevronIcon direction="right" size={iconSize.sm} tone="textSubtle" /> : null}
    </Pressable>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bgApp },
    content: { paddingHorizontal: space.xl },
    float: { position: "absolute", left: space.lg },
    hero: { alignItems: "center", gap: space.sm, paddingTop: space["4xl"] * 2, paddingBottom: space["2xl"] },
    mark: {
      width: 72,
      height: 72,
      borderRadius: radius.shell,
      backgroundColor: colors.bgSurfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: space["2xs"],
    },
    title: { ...typography.title, color: colors.textPrimary, textAlign: "center" },
    chips: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: space.lg },
    chip: { flexDirection: "row", alignItems: "center", gap: space["2xs"], maxWidth: 200 },
    chipText: { ...typography.meta, color: colors.textMuted },
    group: {
      borderRadius: radius.shell,
      backgroundColor: colors.bgSurfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.borderSubtle,
      overflow: "hidden",
      marginBottom: space.lg,
    },
    row: { flexDirection: "row", alignItems: "center", gap: space.lg, minHeight: 52, paddingHorizontal: space.lg },
    pressed: { backgroundColor: colors.bgHover },
    rule: { position: "absolute", top: 0, left: space.lg, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: colors.borderSubtle },
    ruleInset: { left: space.lg + iconSize.md + space.lg },
    glyph: { width: iconSize.md, alignItems: "center" },
    rowCopy: { flex: 1, minWidth: 0, paddingVertical: space.sm },
    rowLabel: { ...typography.body, color: colors.textPrimary },
    rowSub: { ...typography.meta, color: colors.textMuted },
    rowMeta: { ...typography.meta, color: colors.textMuted, maxWidth: 160 },
    live: { color: colors.markViolet },
    diff: { color: colors.textDefault },
    quiet: { ...typography.meta, color: colors.textSubtle, padding: space.lg },
    fact: { paddingHorizontal: space.lg, paddingVertical: space.sm, gap: space["3xs"] },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.borderSubtle },
    factLabel: { ...typography.micro, color: colors.textSubtle },
    factValue: { ...typography.meta, color: colors.textDefault },
    viewTitle: { ...typography.title, color: colors.textPrimary, paddingTop: space["4xl"] * 2, paddingBottom: space.lg },
    section: { ...typography.heading, color: colors.textMuted, marginTop: space.lg, marginBottom: space.sm },
    picture: { marginBottom: space.lg },
    caption: { ...typography.meta, color: colors.textMuted, marginTop: space["2xs"] },
    note: { ...typography.meta, color: colors.textMuted },
  });
