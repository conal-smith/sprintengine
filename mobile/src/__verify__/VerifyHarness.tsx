import { useEffect, useMemo, useRef } from "react";
import { Linking, StatusBar } from "react-native";
import { NavigationContainer, type LinkingOptions, type NavigatorScreenParams } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ToastProvider } from "../components/Toast";
import { RichRendererHost } from "../components/document/rich/RichRendererHost";
import { buildProjectList, resolveCurrentProject } from "../features/projects/projectContext";
import { PairingLinkProvider, type PairingLinkValue } from "../navigation/PairingLinkContext";
import { createNavigationTheme, stackScreenOptions } from "../navigation/navigationTheme";
import { SessionDataContext, type SessionDataValue } from "../navigation/SessionDataProvider";
import { AppNavigator } from "../navigation/AppNavigator";
import type { HomeStackParamList } from "../navigation/types";
import { ChatsContext, ChatsProvider, useChats } from "../features/conversations/ChatsContext";
import { ChatLinkScreen } from "../features/conversations/ChatLinkScreen";
import type { ConversationTarget } from "../features/conversations/conversationLogic";
import { NoticesProvider } from "../features/notices/NoticesContext";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";
import type { DeviceNotesStore } from "../storage/sessionStore";
import { fakeWorkspacesApi } from "./fakeWorkspaces";
import { ConversationScreen } from "../features/conversations/ConversationScreen";
import { ConversationAgentsScreen } from "../features/conversations/ConversationAgentsScreen";
import { ConversationAgentScreen } from "../features/conversations/ConversationAgentScreen";
import { ConversationPlanScreen } from "../features/conversations/ConversationPlanScreen";
import { ConversationChangesScreen } from "../features/conversations/ConversationChangesScreen";
import { ConversationFileDiffScreen } from "../features/conversations/ConversationFileDiffScreen";
import { useLiveConversation } from "../features/conversations/liveConversation";
import {
  fakeConversationsApi,
  fakeLifecycleApi,
  verifyChatsOpened,
  verifyConversation,
  verifyQueuedMessage,
} from "./fakeConversations";
import { verifySession, verifySessions, verifySnapshot } from "./fixture";

/**
 * The screenshot harness: the real app navigator fed a fixture desktop, so every
 * screen behind the pairing gate can be photographed on an emulator without a
 * paired desktop. Bundled only when `EXPO_PUBLIC_VERIFY_HARNESS=1` at build time (see
 * index.js). Screens are reached by deep link, e.g.
 *
 *   adb shell am start -d "sprintengine://verify/notices"
 *
 * The theme follows the emulator's appearance, so `cmd uimode night yes|no`
 * photographs both themes from one build.
 */
export default function VerifyHarness() {
  const themeStore = useMemo(
    () => ({ getPreference: async () => null, savePreference: async () => undefined }),
    [],
  );

  return (
    <ThemeProvider store={themeStore}>
      <SafeAreaProvider>
        <VerifyShell />
        <RichRendererHost />
      </SafeAreaProvider>
    </ThemeProvider>
  );
}

// iOS asks before it hands a custom-scheme link to an app, and a simulator
// driven from the command line has nobody to tap Open. A build made with
// EXPO_PUBLIC_VERIFY_URL starts on that link instead, so the same screens
// photograph on an iPhone simulator without the prompt:
//
//   EXPO_PUBLIC_VERIFY_HARNESS=1 EXPO_PUBLIC_VERIFY_URL=sprintengine://verify/notices
const verifyInitialUrl = async () => process.env.EXPO_PUBLIC_VERIFY_URL || (await Linking.getInitialURL());

// The app's stack, and beside it the one screen the harness draws over a
// list of its own: a chat link that finds its workspace on two desktops.
type VerifyRootParamList = {
  App: NavigatorScreenParams<HomeStackParamList>;
  ChatLinkTwins: { workspaceId: string; agent?: string };
};
const VerifyRoot = createNativeStackNavigator<VerifyRootParamList>();
const linking: LinkingOptions<VerifyRootParamList> = {
  prefixes: ["sprintengine://verify"],
  getInitialURL: verifyInitialUrl,
  config: {
    screens: {
      // Every screen off home has a deep link, so both themes photograph from
      // one build: `adb shell am start -d "sprintengine://verify/notices"`.
      // New on a project, and with its model picker up:
      //   sprintengine://verify/new/dev_verify/ws-studio/multicode/MBP-M3
      //   sprintengine://verify/new/dev_verify/ws-studio/multicode/MBP-M3/model
      // A desktop's chat link, as `sprintengine://chat/…` reaches the app:
      //   sprintengine://verify/chat/ws-docs            (one desktop: the chat opens)
      //   sprintengine://verify/chat/ws-docs?agent=agent-docs
      //   sprintengine://verify/chat/ws-nowhere         (no desktop has it)
      //   sprintengine://verify/chat-twins/ws-docs      (two desktops: pick one)
      //   sprintengine://verify/chat/ws-notices         (Studio's own messages)
      //   sprintengine://verify/chat/ws-files           (files attached by path)
      // Mark unread (the fixture desktop advertises `chat-mark-unread`): open
      // the green chat, then its More menu's Mark unread closes it back to a
      // green row, and opening it again lands on "New" above its second turn.
      // Long-press a read row on `…/home` for the same from the list.
      //   sprintengine://verify/chat/ws-docs
      App: {
        screens: {
          HomeOverview: "home",
          ChooseProject: "new",
          // `…/model` opens it with the model picker up.
          NewChat: "new/:deviceId/:workspaceId/:projectName/:desktopName/:sheet?",
          ChatLink: "chat/:workspaceId",
          Notices: "notices",
          SettingsHome: "settings",
          Desktop: "desktop/:deviceId",
          Appearance: "appearance",
          Pairing: "pairing",
        },
      },
      ChatLinkTwins: "chat-twins/:workspaceId",
    },
  },
};

/**
 * A chat link whose workspace two paired desktops list: the harness desktop's
 * chat, and the same workspace on the Mac mini, laid over the list for this
 * screen only, so the home list stays as photographed.
 */
function ChatLinkTwins({
  workspaceId,
  agent,
  onOpen,
}: {
  workspaceId: string;
  agent?: string;
  onOpen: (target: ConversationTarget) => void;
}) {
  const chats = useChats();
  const value = useMemo(() => {
    const twins = chats.chats
      .filter((row) => row.thread.workspaceId === workspaceId)
      .map((row) => ({ ...row, deviceId: "dev_mini", desktopName: "Mac mini" }));
    return { ...chats, chats: [...chats.chats, ...twins] };
  }, [chats, workspaceId]);
  return (
    <ChatsContext.Provider value={value}>
      <ChatLinkScreen link={{ workspaceId, agentId: agent ?? null }} onBack={noop} onOpen={onOpen} />
    </ChatsContext.Provider>
  );
}

// The conversation fixture's own stack: the chat, and the agent, plan and
// changes screens pushed over it, so each photographs from a link while the chat
// stays mounted beneath as it does in the app:
//
//   sprintengine://verify/conversation/model     (the chat with its model picker up)
//   sprintengine://verify/agents
//   sprintengine://verify/agent/agent-gateway   (agent-mesh, agent-tests, agent-scopes)
//   sprintengine://verify/plan/plan             (EXPO_PUBLIC_VERIFY_CONVERSATION=plan)
//   sprintengine://verify/changes/1             (the settled turn's files)
//   sprintengine://verify/diff/1/src%2Fcomponents%2FToast.tsx
type VerifyConversationParamList = {
  Conversation: { sheet?: "model" } | undefined;
  ConversationAgents: undefined;
  ConversationAgent: { laneId: string };
  ConversationPlan: { requestId: string };
  ConversationChanges: { turnSeq: number };
  ConversationFileDiff: { turnSeq: number; path: string };
};
const ConversationStack = createNativeStackNavigator<VerifyConversationParamList>();
const conversationLinking: LinkingOptions<VerifyConversationParamList> = {
  prefixes: ["sprintengine://verify"],
  getInitialURL: verifyInitialUrl,
  config: {
    // A pushed screen opened by link still has the chat beneath it.
    initialRouteName: "Conversation",
    screens: {
      Conversation: "conversation/:sheet?",
      ConversationAgents: "agents",
      ConversationAgent: "agent/:laneId",
      ConversationPlan: "plan/:requestId",
      ConversationChanges: { path: "changes/:turnSeq", parse: { turnSeq: Number } },
      ConversationFileDiff: { path: "diff/:turnSeq/:path", parse: { turnSeq: Number } },
    },
  },
};
const verifyChat = {
  deviceId: verifySession.deviceId,
  workspaceId: verifyConversation.workspaceId,
  agentId: verifyConversation.agentId,
};

/**
 * Queues the fixture's messages once the chat is live and its turn running,
 * the way a person would, so the floating queued bubble is on screen. The
 * fixture desktop holds them, joined a line apiece into one entry.
 */
function QueueFixtureMessage() {
  const live = useLiveConversation(verifyChat);
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current || !verifyQueuedMessage || live?.state !== "live" || !live.turnBusy) return;
    sent.current = true;
    void (async () => {
      for (const message of verifyQueuedMessage) await live.queueSend(message);
    })().catch(() => undefined);
  }, [live]);
  return null;
}

function VerifyConversationStack() {
  return (
    <>
      <QueueFixtureMessage />
      <ConversationStack.Navigator screenOptions={stackScreenOptions(true)}>
        <ConversationStack.Screen name="Conversation">
          {({ navigation, route }) => (
            <ConversationScreen
              initialSheet={route.params?.sheet === "model" ? "model" : undefined}
              deviceId={verifySession.deviceId}
              thread={verifyConversation}
              apiOverride={fakeConversationsApi}
              onBack={noop}
              onOpenAgents={() => navigation.push("ConversationAgents")}
              onOpenAgent={(laneId) => navigation.push("ConversationAgent", { laneId })}
              onOpenPlan={(requestId) => navigation.push("ConversationPlan", { requestId })}
              onOpenChanges={(turnSeq) => navigation.push("ConversationChanges", { turnSeq })}
            />
          )}
        </ConversationStack.Screen>
        <ConversationStack.Screen name="ConversationAgents">
          {({ navigation }) => (
            <ConversationAgentsScreen
              conversation={verifyChat}
              onBack={() => navigation.goBack()}
              onOpenAgent={(laneId) => navigation.push("ConversationAgent", { laneId })}
            />
          )}
        </ConversationStack.Screen>
        <ConversationStack.Screen name="ConversationAgent">
          {({ navigation, route }) => (
            <ConversationAgentScreen conversation={verifyChat} laneId={route.params.laneId} onBack={() => navigation.goBack()} />
          )}
        </ConversationStack.Screen>
        <ConversationStack.Screen name="ConversationPlan">
          {({ navigation, route }) => (
            <ConversationPlanScreen conversation={verifyChat} requestId={route.params.requestId} onBack={() => navigation.goBack()} />
          )}
        </ConversationStack.Screen>
        <ConversationStack.Screen name="ConversationChanges">
          {({ navigation, route }) => (
            <ConversationChangesScreen
              conversation={verifyChat}
              turnSeq={route.params.turnSeq}
              onBack={() => navigation.goBack()}
              onOpenFile={(path) => navigation.push("ConversationFileDiff", { turnSeq: route.params.turnSeq, path })}
            />
          )}
        </ConversationStack.Screen>
        <ConversationStack.Screen name="ConversationFileDiff">
          {({ navigation, route }) => (
            <ConversationFileDiffScreen
              conversation={verifyChat}
              turnSeq={route.params.turnSeq}
              path={route.params.path}
              onBack={() => navigation.goBack()}
              onOpenFile={(path) => navigation.setParams({ path })}
            />
          )}
        </ConversationStack.Screen>
      </ConversationStack.Navigator>
    </>
  );
}

const noop = () => undefined;
const asyncNoop = async () => undefined;

// The phone's notes about which chats it has opened, held in memory and
// seeded so the list's green row has a stamp to be newer than.
const openedNotes: Record<string, number> = { ...verifyChatsOpened };
const verifyNotesStore: DeviceNotesStore = {
  getChatsOpened: async () => ({ ...openedNotes }),
  markChatOpened: async (key, at) => {
    openedNotes[key] = Math.max(openedNotes[key] ?? 0, at);
    return { ...openedNotes };
  },
  rewindChatOpened: async (key, at) => {
    if (openedNotes[key] !== undefined && openedNotes[key] > at) openedNotes[key] = at;
    return { ...openedNotes };
  },
  getReadNoticeIds: async () => [],
  saveReadNoticeIds: asyncNoop,
  forgetRetiredNotes: asyncNoop,
  getGroupChatsByProject: async () => false,
  saveGroupChatsByProject: asyncNoop,
  // EXPO_PUBLIC_VERIFY_FOLLOW_UP=steer photographs the chat with Steer chosen.
  getFollowUpBehavior: async () => (process.env.EXPO_PUBLIC_VERIFY_FOLLOW_UP === "steer" ? "steer" : "queue"),
  saveFollowUpBehavior: asyncNoop,
};

function VerifyShell() {
  const theme = useTheme();
  const navigationTheme = useMemo(() => createNavigationTheme(theme), [theme]);

  const pairingLink = useMemo<PairingLinkValue>(
    () => ({ pendingPairingLink: null, clearPendingPairingLink: noop }),
    [],
  );

  const sessionData = useMemo<SessionDataValue>(() => {
    const projects = buildProjectList(verifySnapshot);
    return {
      session: verifySession,
      sessions: process.env.EXPO_PUBLIC_VERIFY_CONVERSATION
        ? [
            {
              ...verifySession,
              desktopName: "mac-mini",
              tailnetCapabilities: verifySession.tailnetCapabilities,
              tailnetScopes: ["conversation:operate"],
            },
          ]
        : verifySessions,
      activeDeviceId: verifySession.deviceId,
      projects,
      currentProject: resolveCurrentProject(projects, null),
      selectProject: noop,
      starredProjectKeys: [],
      toggleProjectStar: noop,
      snapshot: verifySnapshot,
      snapshotState: "ready",
      snapshotError: null,
      isRefreshing: false,
      refreshSnapshot: noop,
      lastUpdatedAt: Date.now() - 12_000,
      watchSnapshot: () => noop,
      fleetRowStates: {
        dev_verify: { kind: "ready", summary: { projectCount: 5, backlogItemCount: 8 } },
        dev_mini: { kind: "idle" },
      },
      isFleetRefreshing: false,
      refreshFleet: noop,
      backlogCapabilities: { canUpdate: true },
      sendBacklogUpdate: asyncNoop,
      sendBacklogCreate: async () => ({ ok: true } as never),
      revokeOnDesktop: asyncNoop,
      selectSession: noop,
      removeSession: noop,
      renameSession: noop,
      connectSession: noop,
      markCurrentDeviceRevoked: noop,
      markDeviceRevoked: noop,
      disconnect: noop,
    };
  }, []);

  return (
    <PairingLinkProvider value={pairingLink}>
      <StatusBar barStyle={theme.isDark ? "light-content" : "dark-content"} />
      <ToastProvider>
        <SessionDataContext.Provider value={sessionData}>
          <ChatsProvider
            activeDeviceId={verifySession.deviceId}
            conversationsApiOverride={fakeConversationsApi}
            lifecycleApiOverride={fakeLifecycleApi}
            notesStore={verifyNotesStore}
            sessions={verifySessions}
            workspacesApiOverride={fakeWorkspacesApi}
          >
            <NoticesProvider store={null}>
              {process.env.EXPO_PUBLIC_VERIFY_CONVERSATION ? (
                <NavigationContainer linking={conversationLinking} theme={navigationTheme}>
                  <VerifyConversationStack />
                </NavigationContainer>
              ) : (
                <NavigationContainer linking={linking} theme={navigationTheme}>
                  <VerifyRoot.Navigator screenOptions={{ headerShown: false }}>
                    <VerifyRoot.Screen component={AppNavigator} name="App" />
                    <VerifyRoot.Screen name="ChatLinkTwins">
                      {({ navigation, route }) => (
                        <ChatLinkTwins
                          agent={route.params.agent}
                          onOpen={(target) => navigation.navigate("App", { screen: "Conversation", params: target })}
                          workspaceId={route.params.workspaceId}
                        />
                      )}
                    </VerifyRoot.Screen>
                  </VerifyRoot.Navigator>
                </NavigationContainer>
              )}
            </NoticesProvider>
          </ChatsProvider>
        </SessionDataContext.Provider>
      </ToastProvider>
    </PairingLinkProvider>
  );
}
