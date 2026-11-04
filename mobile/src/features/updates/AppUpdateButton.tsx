import { StyleSheet, View } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { CircleButton } from "../../components/CircleButton";
import { DownloadIcon, iconSize, InstallUpdateIcon } from "../../components/glyphs";
import { useTheme } from "../../theme/ThemeProvider";
import type { AppUpdateView } from "./apkUpdateLogic";
import { useAppUpdate } from "./useAppUpdate";

// The app update's glyph in the chat list's top bar, the phone's counterpart of
// the desktop rail's. The phone has no room for a resting "check for updates"
// button, so it is there only while there is something to take, and then it is
// lit: the accent's soft ground and the accent's ink, the one thing in the bar
// asking to be pressed. A download in flight is not dimmed: a press on it
// simply does nothing.

const DISC = 40;
const RING_RADIUS = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ProgressRing({ percent, ink }: { percent: number; ink: string }) {
  return (
    <Svg
      height={DISC}
      viewBox={`0 0 ${DISC} ${DISC}`}
      width={DISC}
      style={[StyleSheet.absoluteFill, { transform: [{ rotate: "-90deg" }] }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Circle cx={DISC / 2} cy={DISC / 2} fill="none" r={RING_RADIUS} stroke={ink} strokeOpacity={0.22} strokeWidth={1.5} />
      <Circle
        cx={DISC / 2}
        cy={DISC / 2}
        fill="none"
        r={RING_RADIUS}
        stroke={ink}
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
        strokeLinecap="round"
        strokeWidth={1.5}
      />
    </Svg>
  );
}

function UpdateGlyph({ view }: { view: AppUpdateView }) {
  const { colors } = useTheme();
  if (view.phase === "downloading" || view.phase === "verifying") {
    return (
      <View style={styles.ringBox}>
        <ProgressRing ink={colors.accentPrimary} percent={view.percent ?? 0} />
        <DownloadIcon size={iconSize.sm} tone="accentPrimary" />
      </View>
    );
  }
  if (view.phase === "ready" || view.phase === "installing") return <InstallUpdateIcon size={iconSize.md} tone="accentPrimary" />;
  return <DownloadIcon size={iconSize.md} tone="accentPrimary" />;
}

export function AppUpdateButton() {
  const { view, press } = useAppUpdate();
  if (!view) return null;
  return <CircleButton icon={<UpdateGlyph view={view} />} label={view.label} lit onPress={view.pressable ? press : () => undefined} />;
}

const styles = StyleSheet.create({
  ringBox: {
    width: DISC,
    height: DISC,
    alignItems: "center",
    justifyContent: "center",
  },
});
