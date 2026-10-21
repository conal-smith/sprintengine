import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";

import { PrimaryButton } from "../../components/PrimaryButton";
import { useThemedStyles } from "../../theme/ThemeProvider";
import { radius, space, type Theme, typography, fontWeight } from "../../theme/tokens";
import { isPairingDeepLink } from "./pairingPayload";

/**
 * The camera half of pairing: point the phone at the square Studio is showing.
 *
 * Why this exists at all. The desktop has drawn a QR of its pairing link since
 * the tailnet listener shipped — `shared/qr-code.ts`, a hand-written encoder,
 * on the Remote settings tab — and the phone has never been able to read one.
 * The only way a link got here was a person copying a 200-character
 * `sprintengine-tailnet://` URL out of a desktop and into a phone by hand, or
 * mailing it to themselves. The square was aimed at a camera this app did not
 * have.
 *
 * What it deliberately does NOT do: pair. It reads a string and hands it back.
 * Every decision that follows — is this link well-formed, has it expired, do
 * you trust this endpoint — stays in PairingScreen, unchanged, and a scanned
 * link still goes through the same confirmation sheet a pasted one does. A
 * camera is a faster keyboard, not a reason to trust a link more.
 */
export function PairingScanner({
  onScanned,
  onCancel,
}: {
  /** The raw string off the square. The caller validates it. */
  onScanned: (value: string) => void;
  onCancel: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const [permission, requestPermission] = useCameraPermissions();
  // A QR in frame fires on every preview frame, so a person holding the phone
  // steady for half a second scans the same code twenty times. Latched rather
  // than debounced: the answer only needs taking once, and the screen is about
  // to be torn down anyway.
  const handled = useRef(false);

  if (!permission) {
    // The permission state is still loading; nothing to say yet and nothing
    // worth a spinner for.
    return <View style={styles.root} />;
  }

  if (!permission.granted) {
    // Two different refusals with two different remedies: not asked yet is a
    // button, permanently denied is a trip to Settings, and telling them apart
    // is the difference between a working button and one that does nothing.
    return (
      <View style={styles.root}>
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Camera access</Text>
          <Text style={styles.noticeBody}>
            Scanning reads the square on Studio&rsquo;s Remote settings. The camera is used for that and nothing else —
            no image leaves this phone.
          </Text>
        </View>
        <View style={styles.actions}>
          {permission.canAskAgain ? (
            <PrimaryButton label="Allow camera" onPress={() => void requestPermission()} />
          ) : (
            <PrimaryButton label="Open Settings" onPress={() => void Linking.openSettings()} />
          )}
          <PrimaryButton label="Enter the link instead" variant="ghost" onPress={onCancel} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        // QR only. The desktop mints nothing else, and every other symbology a
        // general scanner accepts is one more thing that can fire this handler
        // with a string we then have to reject.
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (handled.current) return;
          // A QR on a poster, a Wi-Fi code, a URL on a business card — a camera
          // pointed at the world finds a lot of squares. Only a pairing link
          // ends the scan; anything else is ignored so the viewfinder stays up
          // rather than bouncing the person back with an error about a code
          // they did not mean to scan.
          if (!isPairingDeepLink(data)) return;
          handled.current = true;
          onScanned(data);
        }}
      />
      <View pointerEvents="none" style={styles.reticle} />
      <View style={styles.hint}>
        <Text style={styles.hintText}>Point at the square in Studio → Settings → Remote</Text>
      </View>
      <View style={styles.actions}>
        <PrimaryButton label="Enter the link instead" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}

const createStyles = ({ colors }: Theme) =>
  StyleSheet.create({
    root: {
      flex: 1,
      justifyContent: "flex-end",
      backgroundColor: colors.bgApp,
    },
    notice: {
      margin: space.lg,
      padding: space.lg,
      borderRadius: radius.overlay,
      borderWidth: 1,
      borderColor: colors.borderDefault,
      backgroundColor: colors.bgSurfaceRaised,
      gap: space.xs,
    },
    noticeTitle: {
      ...typography.body,
      fontWeight: fontWeight.medium,
      color: colors.textPrimary,
    },
    noticeBody: {
      ...typography.meta,
      color: colors.textMuted,
    },
    // A frame, not a mask: a dimmed cut-out is a lot of overlay maths for a
    // square the camera reads anywhere in frame anyway.
    reticle: {
      position: "absolute",
      left: "12%",
      right: "12%",
      top: "26%",
      aspectRatio: 1,
      borderRadius: radius.overlay,
      borderWidth: 2,
      borderColor: colors.accentPrimary,
    },
    hint: {
      position: "absolute",
      left: space.lg,
      right: space.lg,
      bottom: 120,
      alignItems: "center",
    },
    hintText: {
      ...typography.meta,
      color: colors.textOnAccent ?? colors.textPrimary,
      textAlign: "center",
      backgroundColor: colors.overlayScrim,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      borderRadius: radius.chip,
      overflow: "hidden",
    },
    actions: {
      padding: space.lg,
      gap: space.sm,
    },
  });
