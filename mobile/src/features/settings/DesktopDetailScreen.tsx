import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { describeTransport, transportStanding, transportStandingSentence } from "../../api/tailnetTransport";
import type { MobileSession } from "../../api/types";
import { Card, StatusDot } from "../../components/Card";
import { formatTimestamp } from "../../components/formatTimestamp";
import { iconSize, RemoteMachineGlyph } from "../../components/glyphs";
import { PrimaryButton } from "../../components/PrimaryButton";
import { ScreenFrame, useListContentStyle } from "../../components/Screen";
import { mobileControlProtocolVersion } from "../../shared/mobile-control";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { space, typography, type Theme, fontWeight } from "../../theme/tokens";
import { sessionDisplayStatus, sessionStatusLabel } from "../fleet/fleetLogic";

type RevokeState = { status: "idle" } | { status: "pending" } | { status: "error"; message: string };

/**
 * One paired desktop: the diagnostics, and the controls that end the pairing
 *.
 *
 * This is where the old Settings root's first screen went. It is the same
 * information — endpoint, this phone's device id, last seen, protocol, scopes
 * — and the same three destructive actions; what changed is that they now sit
 * under the desktop they describe instead of greeting everyone who opens
 * Settings.
 */
export function DesktopDetailScreen({
  session,
  isActive,
  onBack,
  onStartPairing,
  onForget,
  onRevokeOnDesktop,
  onSelect,
  onRename,
}: {
  session: MobileSession | null;
  isActive: boolean;
  onBack: () => void;
  onStartPairing: () => void;
  /** Removes it from this phone; also revokes on the desktop where that is possible. */
  onForget: () => void;
  onRevokeOnDesktop: (() => Promise<void>) | null;
  onSelect: () => void;
  /** Renames it on this phone only; nothing is sent to the desktop. */
  onRename: (name: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  const contentStyle = useListContentStyle();
  const [revokeState, setRevokeState] = useState<RevokeState>({ status: "idle" });
  // Seeded from the session and owned by the field while it is being edited, so
  // a poll landing mid-type cannot yank the caret.
  const [draftName, setDraftName] = useState<string | null>(null);

  if (!session) {
    return (
      <ScreenFrame backLabel="Back to desktops" onBack={onBack} title="Desktop">
        <ScrollView contentContainerStyle={contentStyle}>
          <Card>
            <Text style={styles.notice}>This desktop is no longer paired with the phone.</Text>
          </Card>
        </ScrollView>
      </ScreenFrame>
    );
  }

  const status = sessionDisplayStatus(session);
  const isRevoked = status === "revoked";
  const standingSentence = transportStandingSentence(transportStanding(session));
  const scopes = session.tailnetScopes;

  const forget = async () => {
    // Forgetting revokes on the desktop too where the transport allows it, and
    // removes the pairing here either way — an unreachable desktop must not be
    // able to keep a pairing on this phone that the person has ended.
    if (onRevokeOnDesktop && status === "online") {
      setRevokeState({ status: "pending" });
      try {
        await onRevokeOnDesktop();
      } catch (error) {
        setRevokeState({
          status: "error",
          message: error instanceof Error ? error.message : "The desktop refused the revoke, so it was forgotten here only.",
        });
      }
    }
    setRevokeState({ status: "idle" });
    onForget();
  };

  return (
    <ScreenFrame
      backLabel="Back to desktops"
      onBack={onBack}
      subtitle={
        <View style={styles.statusLine}>
          <StatusDot tone={status === "online" ? "good" : status === "revoked" ? "danger" : "neutral"} />
          <Text style={styles.statusText}>
            {sessionStatusLabel[status]} · tailnet
          </Text>
        </View>
      }
      title={session.desktopName}
      trailing={<RemoteMachineGlyph size={iconSize.md} tone="textPrimary" />}
    >
      <ScrollView contentContainerStyle={contentStyle}>
        <Card variant="list">
          <View style={styles.nameField}>
            <Text style={styles.fieldLabel}>Name on this phone</Text>
            <TextInput
              accessibilityHint="Only this phone sees this name."
              accessibilityLabel="Desktop name"
              autoCapitalize="words"
              autoCorrect={false}
              onBlur={() => {
                const next = (draftName ?? "").trim();
                // An empty field is not a rename to nothing: it falls back to
                // the name the pairing minted, so a desktop can never end up
                // nameless.
                if (next && next !== session.desktopName) onRename(next);
                setDraftName(null);
              }}
              onChangeText={setDraftName}
              placeholder={session.desktopName}
              placeholderTextColor={colors.textSubtle}
              returnKeyType="done"
              style={styles.nameInput}
              value={draftName ?? session.desktopName}
            />
          </View>
          <Field label="Endpoint" mono value={session.baseUrl} />
          <Field label="This phone" mono value={session.deviceId} />
          <Field label="Last seen" value={formatTimestamp(session.lastSeenAt ?? session.pairedAt)} />
          <Field label="Protocol" value={`${mobileControlProtocolVersion} · ${describeScopes(scopes)}`} />
          <Field label="Transport" value={describeTransport(session)} />
          <Field label="Storage" value="Encrypted on this device" />
        </Card>

        {standingSentence ? (
          // Out of step is a sentence, not an error: the list still draws, and
          // the person reading this is the one who can update whichever side.
          <Card>
            <Text style={styles.notice}>{standingSentence}</Text>
          </Card>
        ) : null}

        {revokeState.status === "error" ? (
          <Card>
            <Text accessibilityRole="alert" style={styles.error}>
              {revokeState.message}
            </Text>
          </Card>
        ) : null}

        <View style={styles.actions}>
          {!isActive && !isRevoked ? (
            <PrimaryButton label="Use this desktop" onPress={onSelect} variant="secondary" />
          ) : null}
          <PrimaryButton label="Pair another desktop" onPress={onStartPairing} variant="secondary" />
          <PrimaryButton
            disabled={revokeState.status === "pending"}
            label={revokeState.status === "pending" ? "Forgetting…" : "Forget this desktop"}
            onPress={() => void forget()}
            variant="danger"
          />
        </View>
        <Text style={styles.foot}>Forgetting revokes this phone on the desktop too.</Text>
      </ScrollView>
    </ScreenFrame>
  );
}

function Field({ label, value, mono = false, first = false }: { label: string; value: string; mono?: boolean; first?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={[styles.field, first ? styles.fieldFirst : null]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text numberOfLines={2} style={[styles.fieldValue, mono ? styles.fieldMono : null]}>
        {value}
      </Text>
    </View>
  );
}

/**
 * The scopes as the words that matter, not the raw grant list: a person
 * reading this wants to know what the phone may do, not the gateway's
 * vocabulary for it.
 */
function describeScopes(scopes: readonly string[]): string {
  const words: string[] = [];
  // Operate implies read within a family, as the gateway rules it.
  if (scopes.includes("conversation:operate")) words.push("chats");
  else if (scopes.includes("conversation:read")) words.push("chats (reading)");
  if (scopes.includes("workspace:read") || scopes.includes("workspace:operate")) words.push("desktop state");
  if (scopes.includes("workspace:operate")) words.push("backlog");
  return words.length > 0 ? words.join(", ") : "no scopes";
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    statusLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.xs,
    },
    statusText: {
      ...typography.meta,
      color: colors.textMuted,
    },
    field: {
      gap: space["3xs"],
      paddingHorizontal: space.xl,
      paddingVertical: space.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderSubtle,
    },
    fieldFirst: {
      borderTopWidth: 0,
    },
    nameField: {
      gap: space["3xs"],
      paddingHorizontal: space.xl,
      paddingVertical: space.lg,
    },
    nameInput: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
      // Android's own vertical padding would make this row taller than the
      // read-only fields under it.
      paddingVertical: 0,
    },
    fieldLabel: {
      ...typography.meta,
      color: colors.textMuted,
    },
    fieldValue: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    fieldMono: {
      ...typography.meta,
      fontFamily: monoFontFamily,
      fontWeight: fontWeight.medium,
    },
    actions: {
      gap: space.md,
      paddingTop: space.lg,
    },
    foot: {
      ...typography.meta,
      color: colors.textSubtle,
      textAlign: "center",
      paddingTop: space.sm,
    },
    notice: {
      ...typography.meta,
      color: colors.textMuted,
      paddingVertical: space.sm,
      textAlign: "center",
    },
    error: {
      ...typography.meta,
      color: colors.toneError,
    },
  });
