import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { AppState, Linking, StatusBar, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { MobileSession } from "./src/api/types";
import { isPairingDeepLink } from "./src/features/pairing/pairingPayload";
import { PairingLinkProvider, type PairingLinkValue } from "./src/navigation/PairingLinkContext";
import { readEach } from "./src/navigation/readEach";
import { RootNavigator } from "./src/navigation/RootNavigator";
import { SessionDataProvider } from "./src/navigation/SessionDataProvider";
import { ChatsProvider } from "./src/features/conversations/ChatsContext";
import { NoticesProvider } from "./src/features/notices/NoticesContext";
import { readTailnetIdentity, withTailnetScopes } from "./src/api/tailnetControlClient";
import { withMachineMark, withTransportDeclaration } from "./src/api/tailnetTransport";
import { ToastProvider } from "./src/components/Toast";
import { startSentPhotoCopies } from "./src/storage/sentPhotoCopies";
import { RichRendererHost } from "./src/components/document/rich/RichRendererHost";
import {
  createSecureDeviceNotesStore,
  createSecureProjectContextStore,
  createSecureSessionListStore,
  createSecureThemePreferenceStore,
} from "./src/storage/secureTokenStore";
import { ThemeProvider, useTheme } from "./src/theme/ThemeProvider";

// The screenshot harness (src/__verify__) stands in for the app only in a build
// made with EXPO_PUBLIC_VERIFY_HARNESS=1. Babel inlines the variable, so a
// normal build folds this to `null` and never bundles the harness or its fixture.
const VerifyHarness: ComponentType | null = process.env.EXPO_PUBLIC_VERIFY_HARNESS
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("./src/__verify__/VerifyHarness").default as ComponentType)
  : null;

export default function App() {
  return VerifyHarness ? <VerifyHarness /> : <SprintEngineApp />;
}

function SprintEngineApp() {

  const themeStore = useMemo(() => createSecureThemePreferenceStore(), []);

  return (
    <ThemeProvider store={themeStore}>
      <SafeAreaProvider>
        <AppShell />
        {/* The hidden page replies' diagrams and formulas are drawn in,
            mounted the first time one is wanted. */}
        <RichRendererHost />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

/**
 * Owns the durable state — the paired desktop list and the project context
 * (which project the app is in, and which are starred) — and nothing about
 * which screen is showing. Navigation is React Navigation's job
 * from `RootNavigator` down.
 */
function AppShell() {
  const theme = useTheme();
  const sessionListStore = useMemo(() => createSecureSessionListStore(), []);
  const projectStore = useMemo(() => createSecureProjectContextStore(), []);
  // What this phone has seen: which chats it opened, which notices it read,
  // and whether the needs-you push is on.
  const notesStore = useMemo(() => createSecureDeviceNotesStore(), []);
  const [sessions, setSessions] = useState<MobileSession[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [starredProjectKeys, setStarredProjectKeys] = useState<string[]>([]);
  const [pendingPairingLink, setPendingPairingLink] = useState<{ url: string; sequence: number } | null>(null);
  // Whether the stored pairings have been read. Until then nothing knows
  // whether this phone is paired, and the navigators wait: drawn before it,
  // a paired phone opened on the welcome screen, mounting its stack (and
  // loading its modules) only to swap it for the chat list a moment later.
  const [pairingsRead, setPairingsRead] = useState(false);
  // Monotonic so that the same link, tapped twice, is two deliveries.
  const pairingLinkSequence = useRef(0);
  const session = activeDeviceId
    ? sessions.find((candidate) => candidate.deviceId === activeDeviceId) ?? null
    : null;

  useEffect(() => {
    let isMounted = true;
    // Where the photos this phone sent are, so their messages show them.
    startSentPhotoCopies();

    void sessionListStore
      .getSessionList()
      .then((storedList) => {
        if (!isMounted) {
          return;
        }

        setSessions(storedList.sessions);
        setActiveDeviceId(storedList.activeDeviceId);
      })
      // Unreadable storage is a phone with no pairings, as it always was.
      .catch(() => undefined)
      .finally(() => {
        if (isMounted) setPairingsRead(true);
      });
    // Project context is read once here, so the first render after a cold start
    // already knows which project the user was in. Until it lands, the provider's
    // cold-start heuristic applies — never a flash of the wrong project, because
    // no snapshot has arrived yet either.
    void projectStore.getCurrentProjectKey().then((storedKey) => {
      if (isMounted && storedKey) {
        setSelectedProjectKey(storedKey);
      }
    });
    void projectStore.getStarredProjectKeys().then((storedKeys) => {
      if (isMounted && storedKeys.length > 0) {
        setStarredProjectKeys(storedKeys);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [sessionListStore, projectStore]);

  // The one thing a registered scheme hands this shell: a pairing link the
  // desktop minted, held for the pairing screen, which parses it and asks for
  // confirmation before anything is spent. Conversation links are the root
  // navigator's own.
  const handleIncomingUrl = (url: string) => {
    if (isPairingDeepLink(url)) {
      pairingLinkSequence.current += 1;
      setPendingPairingLink({ url, sequence: pairingLinkSequence.current });
    }
  };

  useEffect(() => {
    const subscription = Linking.addEventListener("url", ({ url }) => {
      handleIncomingUrl(url);
    });

    void Linking.getInitialURL().then((initialUrl) => {
      if (initialUrl) {
        handleIncomingUrl(initialUrl);
      }
    });

    return () => subscription.remove();
  }, []);

  const applySessionList = (list: { sessions: MobileSession[]; activeDeviceId: string | null }) => {
    setSessions(list.sessions);
    setActiveDeviceId(list.activeDeviceId);
  };

  // What each tailnet desktop says it speaks, re-read on foreground. A Studio updates under a standing pairing, so the pair-time answer
  // goes stale; one GET per desktop per foreground keeps the desktop's row
  // honest about which side is behind, and is how the chat list learns that a
  // desktop now streams chats (`conversations`). Nothing is written when
  // nothing moved.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useEffect(() => {
    let live = true;
    const refreshDeclarations = async () => {
      const paired = sessionsRef.current.filter((candidate) => candidate.status !== "revoked");
      // Every desktop is asked at once; the answers are written one at a time.
      await readEach(
        paired,
        (candidate) => readTailnetIdentity({ baseUrl: candidate.baseUrl, deviceToken: candidate.deviceToken }),
        async (candidate, identity) => {
          if (!live || !identity.ok || !identity.data) return;
          const current = sessionsRef.current.find((entry) => entry.deviceId === candidate.deviceId);
          if (!current) return;
          // The grant, the declaration, then how the desktop draws itself as a
          // machine. Any may be unchanged; nothing is written when all are.
          const granted = withTailnetScopes(current, identity.data.scopes) ?? current;
          const declared = withTransportDeclaration(granted, identity.data.transport) ?? granted;
          const marked = withMachineMark(declared, identity.data.machine) ?? declared;
          if (marked !== current) applySessionList(await sessionListStore.updateSession(marked));
        },
      );
    };
    void refreshDeclarations();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshDeclarations();
    });
    return () => {
      live = false;
      subscription.remove();
    };
    // Reads the ref, so a new pairing is picked up on the next foreground
    // rather than re-running for every list change.
  }, [sessionListStore]);

  const pairingLink: PairingLinkValue = {
    pendingPairingLink,
    clearPendingPairingLink: () => setPendingPairingLink(null),
  };

  return (
    <PairingLinkProvider value={pairingLink}>
      <StatusBar barStyle={theme.isDark ? "light-content" : "dark-content"} />
      <ToastProvider>
      <SessionDataProvider
        activeDeviceId={activeDeviceId}
        // State first, storage second: the app must follow the tap even on a
        // device where secure storage is unavailable — there the choice simply
        // does not survive the relaunch, which is strictly better than not
        // switching at all.
        onSelectProject={async (key) => {
          setSelectedProjectKey(key);
          await projectStore.saveCurrentProjectKey(key);
        }}
        onStarredProjectKeysChange={async (keys) => {
          setStarredProjectKeys(keys);
          await projectStore.saveStarredProjectKeys(keys);
        }}
        selectedProjectKey={selectedProjectKey}
        starredProjectKeys={starredProjectKeys}
        onDisconnect={async () => {
          if (activeDeviceId) {
            // The store promotes the next paired desktop, so a phone with two
            // desktops stays inside the tabs instead of falling back to the welcome screen.
            applySessionList(await sessionListStore.removeSession(activeDeviceId));
          }
        }}
        onRemoveSession={async (deviceId) => applySessionList(await sessionListStore.removeSession(deviceId))}
        // A phone-local label. `Desktop on 100.64.0.9` is the kind of placeholder a
        // tailnet pairing mints from its endpoint, and the desktop's real name
        // is not on that wire — so the person naming it is the only source
        // there is.
        onRenameSession={async (deviceId, name) => {
          const existing = sessions.find((candidate) => candidate.deviceId === deviceId);
          if (!existing) return;
          applySessionList(await sessionListStore.updateSession({ ...existing, desktopName: name }));
        }}
        onSelectSession={async (deviceId) => applySessionList(await sessionListStore.setActiveSession(deviceId))}
        onSessionConnected={async (nextSession) => applySessionList(await sessionListStore.upsertSession(nextSession))}
        onSessionRevoked={async (revokedSession) => applySessionList(await sessionListStore.updateSession(revokedSession))}
        session={session}
        sessions={sessions}
      >
        {/* Every paired tailnet desktop, not just the active one: the chat
            list is one flat list across machines. */}
        <ChatsProvider activeDeviceId={activeDeviceId} notesStore={notesStore} sessions={sessions}>
          <NoticesProvider store={notesStore}>
            {/* The app's own background, which the splash screen matches. */}
            {pairingsRead ? <RootNavigator /> : <View style={{ flex: 1, backgroundColor: theme.colors.bgApp }} />}
          </NoticesProvider>
        </ChatsProvider>
      </SessionDataProvider>
      </ToastProvider>
    </PairingLinkProvider>
  );
}
