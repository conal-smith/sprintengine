import { useEffect, useMemo, useState } from "react";
import { Linking } from "react-native";
import { NavigationContainer, useNavigationContainerRef, type NavigatorScreenParams } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { useReducedMotion } from "../components/motion";
import { useTheme } from "../theme/ThemeProvider";
import { usePairingLink } from "./PairingLinkContext";
import { GateNavigator } from "./GateNavigator";
import { createNavigationTheme, stackScreenOptions } from "./navigationTheme";
import { resolveRootRoute } from "./sessionFlow";
import { useSessionData } from "./SessionDataProvider";
import { AppNavigator } from "./AppNavigator";
import type { GateStackParamList, HomeStackParamList } from "./types";
import { parseAppLink, type AppLink } from "../features/conversations/conversationLogic";

type RootStackParamList = {
  Gate: NavigatorScreenParams<GateStackParamList>;
  App: NavigatorScreenParams<HomeStackParamList>;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * The whole app's shape in one conditional: a live desktop session gets the
 * app's stack, anything else gets the gate. React Navigation owns the back stack
 * from here down, which is why `getBackTarget` and the Android `BackHandler` are
 * gone.
 */
export function RootNavigator() {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const { session } = useSessionData();
  const { pendingPairingLink } = usePairingLink();
  const navigationRef = useNavigationContainerRef<RootStackParamList>();
  const [isNavigationReady, setIsNavigationReady] = useState(false);
  const [appLink, setAppLink] = useState<AppLink | null>(null);

  const navigationTheme = useMemo(() => createNavigationTheme(theme), [theme]);
  const rootRoute = resolveRootRoute(session);
  useEffect(() => {
    let mounted = true;
    // A conversation on a named desktop, or a desktop's own chat link, which
    // names only the workspace. Nothing else a `sprintengine://` link says is acted on.
    const receive = (url: string) => { const target = parseAppLink(url); if (mounted && target) setAppLink(target); };
    void Linking.getInitialURL().then((url) => { if (url) receive(url); }).catch(() => {});
    const subscription = Linking.addEventListener("url", ({ url }) => receive(url));
    return () => { mounted = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    if (!appLink || !isNavigationReady || rootRoute !== "tabs") return;
    if (appLink.kind === "conversation") navigationRef.navigate("App", { screen: "ConversationLink", params: appLink.link });
    else
      navigationRef.navigate("App", {
        screen: "ChatLink",
        params: { workspaceId: appLink.link.workspaceId, ...(appLink.link.agentId ? { agent: appLink.link.agentId } : {}) },
      });
    setAppLink(null);
  }, [appLink, isNavigationReady, rootRoute, navigationRef]);

  /**
   * A pairing link the OS handed us has to reach the pairing screen, and which
   * stack owns that screen depends on whether a live desktop is already paired
   * — the gate's own `Pairing`, or the app stack's. Hence the container ref:
   * the link arrives from outside the navigator, so there is no screen in scope
   * to navigate from.
   *
   * The link is NOT cleared here. `PairingRoute` clears it when it takes it,
   * so a link that lands a frame before the container is ready still gets
   * delivered rather than dropped between the two.
   */
  useEffect(() => {
    if (!pendingPairingLink || !isNavigationReady) {
      return;
    }
    if (rootRoute === "tabs") {
      navigationRef.navigate("App", { screen: "Pairing" });
      return;
    }
    navigationRef.navigate("Gate", { screen: "Pairing" });
  }, [isNavigationReady, navigationRef, pendingPairingLink, rootRoute]);

  return (
    <NavigationContainer onReady={() => setIsNavigationReady(true)} ref={navigationRef} theme={navigationTheme}>
      <Stack.Navigator screenOptions={stackScreenOptions(reducedMotion)}>
        {rootRoute === "tabs" ? (
          <Stack.Screen component={AppNavigator} name="App" />
        ) : (
          <Stack.Screen component={GateNavigator} name="Gate" />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
