import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { useReducedMotion } from "../components/motion";
import { SessionStatusScreen } from "../features/session/SessionStatusScreen";
import { AppearanceScreen } from "../features/settings/AppearanceScreen";
import { DesktopDetailScreen } from "../features/settings/DesktopDetailScreen";
import { DesktopsScreen } from "../features/settings/DesktopsScreen";
import { stackScreenOptions } from "./navigationTheme";
import { PairingRoute, SettingsRoute, WelcomeRoute } from "./routes";
import { resolveGateRoute } from "./sessionFlow";
import { useSessionData } from "./SessionDataProvider";
import type { GateStackParamList } from "./types";

const Stack = createNativeStackNavigator<GateStackParamList>();

/**
 * Everything above the tabs: no desktop paired, or one paired that is offline,
 * stale, or revoked. Which of the two roots mounts is a function of the session,
 * so disconnecting the last desktop from here drops straight back to the welcome
 * screen.
 *
 * Settings' own screens are mounted here too, and deliberately: a phone whose
 * only desktop went offline is exactly the phone that needs the desktop
 * screen's endpoint, its last-seen and its Forget button.
 */
export function GateNavigator() {
  const reducedMotion = useReducedMotion();
  const {
    session,
    sessions,
    activeDeviceId,
    isFleetRefreshing,
    refreshFleet,
    removeSession,
    renameSession,
    selectSession,
    revokeOnDesktop,
  } = useSessionData();

  return (
    <Stack.Navigator screenOptions={stackScreenOptions(reducedMotion)}>
      {/* `sessionFlow` owns which root mounts; the trailing `&& session` is the
          type narrow it cannot express, not a second copy of the decision. */}
      {resolveGateRoute(session) === "SessionStatus" && session ? (
        <Stack.Screen name="SessionStatus">
          {({ navigation }) => (
            <SessionStatusScreen
              desktopCount={sessions.length}
              onDisconnect={() => removeSession(session.deviceId)}
              onOpenSettings={() => navigation.navigate("Settings")}
              onStartPairing={() => navigation.navigate("Pairing")}
              session={session}
            />
          )}
        </Stack.Screen>
      ) : (
        <Stack.Screen name="Welcome">
          {({ navigation }) => <WelcomeRoute onStartPairing={() => navigation.navigate("Pairing")} />}
        </Stack.Screen>
      )}
      <Stack.Screen name="Settings">
        {({ navigation }) => (
          <SettingsRoute
            onBack={() => navigation.goBack()}
            onOpenAppearance={() => navigation.navigate("Appearance")}
            onOpenDesktops={() => navigation.navigate("Desktop", { deviceId: "" })}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Desktop">
        {({ navigation, route }) =>
          route.params.deviceId ? (
            <DesktopDetailScreen
              isActive={route.params.deviceId === activeDeviceId}
              onBack={() => navigation.goBack()}
              onForget={() => {
                removeSession(route.params.deviceId);
                navigation.goBack();
              }}
              onRename={(name) => renameSession(route.params.deviceId, name)}
              onRevokeOnDesktop={route.params.deviceId === activeDeviceId ? revokeOnDesktop : null}
              onSelect={() => selectSession(route.params.deviceId)}
              onStartPairing={() => navigation.navigate("Pairing")}
              session={sessions.find((candidate) => candidate.deviceId === route.params.deviceId) ?? null}
            />
          ) : (
            <DesktopsScreen
              activeDeviceId={activeDeviceId}
              isFleetRefreshing={isFleetRefreshing}
              onBack={() => navigation.goBack()}
              onOpenDesktop={(deviceId) => navigation.push("Desktop", { deviceId })}
              onRefreshFleet={refreshFleet}
              onStartPairing={() => navigation.navigate("Pairing")}
              sessions={sessions}
            />
          )
        }
      </Stack.Screen>
      <Stack.Screen name="Appearance">
        {({ navigation }) => <AppearanceScreen onBack={() => navigation.goBack()} />}
      </Stack.Screen>
      <Stack.Screen name="Pairing" component={PairingRoute} />
    </Stack.Navigator>
  );
}
