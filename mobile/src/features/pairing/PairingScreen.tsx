import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text, TextInput, View } from "react-native";

import { completeTailnetPairing } from "../../api/tailnetControlClient";
import { MobileSession } from "../../api/types";
import { BottomSheet } from "../../components/BottomSheet";
import { PairingScanner } from "./PairingScanner";
import { Card } from "../../components/Card";
import { PrimaryButton } from "../../components/PrimaryButton";
import { useTheme, useThemedStyles } from "../../theme/ThemeProvider";
import { monoFontFamily } from "../../theme/fonts";
import { radius, space, type Theme, typography } from "../../theme/tokens";
import { createMobileSessionFromTailnetPairing } from "./pairingSession";
import { isPairingDeepLink, parsePairingPayload, type TailnetPairingPayload } from "./pairingPayload";

interface PairingScreenProps {
  onCancel: () => void;
  onConnected: (session: MobileSession) => void | Promise<void>;
  /**
   * A pairing link the desktop minted, delivered by the OS rather than typed.
   * Seeds the field and nothing else: the link still has to be confirmed, and
   * if it is malformed this field's own error copy says so.
   *
   * Keyed by `sequence`, not by the URL — the same link tapped twice is two
   * deliveries and must seed the field both times.
   */
  initialPairingLink?: { url: string; sequence: number } | null;
}

/**
 * Pairs this phone with a desktop over the tailnet — the only way it pairs.
 *
 * Possession is the credential: the one-time code in Studio's link proves you
 * stood at the desktop, so there is no account and no server in between. The
 * phone then talks to that desktop's gateway directly, over WireGuard.
 */
export function PairingScreen({ onCancel, onConnected, initialPairingLink }: PairingScreenProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const payloadInputRef = useRef<TextInput>(null);
  const [pairingInput, setPairingInput] = useState(initialPairingLink?.url ?? "");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPairing, setIsPairing] = useState(false);
  const [scanning, setScanning] = useState(false);
  // The endpoint only — never the pairing token, which is a spendable secret
  // that has no business on a confirmation sheet.
  const [pendingConfirmation, setPendingConfirmation] = useState<{ endpoint: string } | null>(null);
  // A link can arrive while this screen is already mounted (the route is
  // navigated to, not remounted), so the seed cannot live in `useState` alone.
  // Depends on the delivery, not the URL: re-tapping the same link re-seeds a
  // field the user has since cleared.
  const deliveredSequence = initialPairingLink?.sequence ?? null;
  const deliveredUrl = initialPairingLink?.url ?? null;
  useEffect(() => {
    if (deliveredSequence === null || !deliveredUrl) {
      return;
    }
    setPairingInput(deliveredUrl);
    setErrorMessage(null);
    // `deliveredUrl` is read, not depended on: the sequence is the identity, and
    // adding the URL here would be a second trigger for the same event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliveredSequence]);

  const parsed = parsePairingPayload(pairingInput);
  /**
   * Why a link in the field cannot be paired, said without waiting for a tap.
   *
   * `canConnect` is false for a link that does not parse, which disables the
   * button — and the button is what would otherwise set this message. Without
   * this a malformed link lands as a long unreadable string above a dead button
   * and no reason. Scoped to input that is *recognisably* a pairing link so it
   * does not nag while a link is still being pasted in.
   */
  const deliveredLinkError = !parsed.ok && isPairingDeepLink(pairingInput) ? parsed.message : null;
  const visibleErrorMessage = errorMessage ?? deliveredLinkError;
  const canConnect = !isPairing && !pendingConfirmation && parsed.ok;

  // No account token here: tailnet pairing is possession-based (the code
  // proves you stood at the desktop).
  const submitTailnetPairing = async (tailnet: TailnetPairingPayload) => {
    setIsPairing(true);
    setErrorMessage(null);

    const pairedAt = new Date().toISOString();
    const pairResult = await completeTailnetPairing({
      baseUrl: tailnet.baseUrl,
      pairingToken: tailnet.pairingToken,
      deviceName: defaultDeviceName,
    });
    setIsPairing(false);

    if (!pairResult.ok || !pairResult.data) {
      setErrorMessage(pairResult.message ?? "The desktop refused the tailnet pairing.");
      return;
    }

    await onConnected(
      createMobileSessionFromTailnetPairing({
        tailnet,
        completion: pairResult.data,
        pairedAt,
      }),
    );
  };

  const handleConnect = () => {
    if (!parsed.ok) {
      setErrorMessage(parsed.message);
      return;
    }

    // Every pair goes through the confirmation — deliberately: naming the host
    // you are about to hand control of your desktop traffic to is the right
    // first-run moment, and any app or web page can fire a link at the phone.
    setErrorMessage(null);
    setPendingConfirmation({ endpoint: parsed.tailnet.endpoint });
  };

  if (scanning) {
    return (
      <PairingScanner
        onCancel={() => setScanning(false)}
        onScanned={(value) => {
          // Seeds the field and closes the camera — it does NOT pair. The
          // scanned string goes through the same parse and the same
          // confirmation sheet a pasted one does; a camera is a faster
          // keyboard, not a shortcut past the confirmation.
          setScanning(false);
          setErrorMessage(null);
          setPairingInput(value);
        }}
      />
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.content}>
        {/* A task screen, not a brand moment: one title, one line of where the
            link comes from, the link field in a card. */}
        <View style={styles.header}>
          <Text accessibilityRole="header" style={styles.title}>Pair this phone</Text>
          <Text style={styles.subtitle}>
            Scan the square in Studio → Settings → Remote, or tap or paste its pairing link. Both devices need Tailscale.
          </Text>
        </View>

        <Card>
        <TextInput
          ref={payloadInputRef}
          accessibilityLabel="Pairing link"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          maxLength={4096}
          onChangeText={(value) => {
            setPairingInput(value);
            if (errorMessage) setErrorMessage(null);
          }}
          placeholder="sprintengine-tailnet://pair?…"
          placeholderTextColor={colors.textSubtle}
          style={styles.pairingInput}
          value={pairingInput}
        />

        {visibleErrorMessage ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {visibleErrorMessage}
          </Text>
        ) : null}

        <View style={styles.actions}>
          {/* The camera leads: the desktop is usually in front of you, and a
              scanned link lands in the field above like a pasted one. */}
          <PrimaryButton
            label="Scan Studio’s code"
            onPress={() => {
              setErrorMessage(null);
              setScanning(true);
            }}
            disabled={isPairing}
          />
          <PrimaryButton
            label={isPairing ? "Pairing…" : "Pair phone"}
            onPress={handleConnect}
            variant="secondary"
            disabled={!canConnect}
          />
          <PrimaryButton label="Cancel" onPress={onCancel} variant="ghost" disabled={isPairing} />
        </View>
        </Card>
      </View>

      {/* A trust decision is a modal decision: the shared sheet contains focus
          and takes over the screen until the user answers. */}
      <BottomSheet
        onClose={() => setPendingConfirmation(null)}
        title="Pair over your tailnet?"
        visible={pendingConfirmation !== null}
      >
        <Text style={styles.confirmBody}>
          Pairs directly with a desktop on your tailnet. Confirm only if this is your desktop.
        </Text>
        <Text accessibilityLabel="Tailnet endpoint" style={styles.confirmOrigin} numberOfLines={1}>
          {pendingConfirmation?.endpoint}
        </Text>
        <PrimaryButton
          label={isPairing ? "Pairing…" : "Confirm desktop"}
          onPress={async () => {
            setPendingConfirmation(null);
            if (!parsed.ok) {
              return;
            }
            await submitTailnetPairing(parsed.tailnet);
          }}
          disabled={isPairing}
        />
        <PrimaryButton
          label="Cancel"
          variant="secondary"
          onPress={() => setPendingConfirmation(null)}
          disabled={isPairing}
        />
      </BottomSheet>
    </View>
  );
}

const defaultDeviceName = `Sprint Engine ${Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android" : "Mobile"}`;

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.bgApp,
    },
    content: {
      flex: 1,
      justifyContent: "center",
      gap: space.xl,
      paddingHorizontal: space["2xl"],
      paddingBottom: space["4xl"] * 2,
    },
    header: {
      gap: space["2xs"],
      paddingHorizontal: space["2xs"],
    },
    title: {
      ...typography.title,
      fontSize: 28,
      lineHeight: 34,
      letterSpacing: -0.6,
      color: colors.textPrimary,
    },
    subtitle: {
      ...typography.body,
      color: colors.textMuted,
    },
    actions: {
      gap: space.md,
      marginTop: space.xl,
    },
    // Mono so a pasted link reads as the machine string it is; body size,
    // because it is a long URL rather than a code read at arm's length.
    pairingInput: {
      ...typography.body,
      minHeight: 48,
      borderWidth: 1,
      borderColor: colors.buttonOutline,
      borderRadius: radius.control,
      backgroundColor: colors.bgSurface,
      color: colors.textPrimary,
      fontFamily: monoFontFamily,
      paddingHorizontal: space.lg,
      paddingVertical: space.sm,
    },
    confirmBody: {
      ...typography.meta,
      color: colors.textMuted,
    },
    confirmOrigin: {
      ...typography.meta,
      color: colors.textPrimary,
      fontFamily: monoFontFamily,
      paddingVertical: space["2xs"],
    },
    errorText: {
      ...typography.meta,
      color: colors.toneError,
      marginTop: space.lg,
    },
  });
