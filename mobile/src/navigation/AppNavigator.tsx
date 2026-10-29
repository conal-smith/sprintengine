/*
 * The app's one stack.
 *
 * The bottom tab bar is gone with the phone's sprint surface (matching the
 * desktop's own cut): Threads and Sprints were the two tabs, and a tab bar
 * with one destination is chrome that says nothing.
 * The chat list is the app (terminals left it 2026-09-29), and Settings,
 * Notices, New and the desktop screens are pushes from it.
 *
 * `BacklogNavigator` below is HIDDEN, not deleted: its screens, logic and
 * regression suite are all still here and still green, so restoring the surface
 * is mounting that navigator and nothing else. It leaves symbols unreferenced
 * on purpose, which is the only reason this file suppresses unused-symbol
 * warnings; a genuinely dead symbol here would hide in the same silence, so
 * delete rather than add to this. (The Home command center was hidden the same
 * way until automations, the last thing it rendered, left the phone on
 * 2026-09-29; it is deleted.)
 */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { CommonActions, type NavigationState } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { useReducedMotion } from "../components/motion";
import { BacklogItemDetailScreen } from "../features/backlog/BacklogItemDetailScreen";
import { BacklogScreen } from "../features/backlog/BacklogScreen";
import { normalizeBacklogWorkspaces } from "../features/backlog/backlogLogic";
import { buildNotices, splitNotices, bellCount } from "../features/notices/noticesLogic";
import { useNotices } from "../features/notices/NoticesContext";
import { NoticesScreen } from "../features/notices/NoticesScreen";
import { AppearanceScreen } from "../features/settings/AppearanceScreen";
import { DesktopDetailScreen } from "../features/settings/DesktopDetailScreen";
import { DesktopsScreen } from "../features/settings/DesktopsScreen";
import { useChats } from "../features/conversations/ChatsContext";
import { ChooseProjectScreen } from "../features/conversations/ChooseProjectScreen";
import { ConversationsScreen } from "../features/conversations/ConversationsScreen";
import { ConversationScreen } from "../features/conversations/ConversationScreen";
import { ConversationLinkScreen } from "../features/conversations/ConversationLinkScreen";
import { ChatLinkScreen } from "../features/conversations/ChatLinkScreen";
import { routesInPlaceOfTop } from "../features/conversations/conversationListLogic";
import { ConversationAgentsScreen } from "../features/conversations/ConversationAgentsScreen";
import { ConversationAgentScreen } from "../features/conversations/ConversationAgentScreen";
import { ConversationPlanScreen } from "../features/conversations/ConversationPlanScreen";
import { ConversationChangesScreen } from "../features/conversations/ConversationChangesScreen";
import { ConversationFileDiffScreen } from "../features/conversations/ConversationFileDiffScreen";
import { NewChatScreen } from "../features/conversations/NewChatScreen";
import { routesAfterNewChat } from "../features/conversations/launchLogic";
import { openWebTarget, WebTargetsScreen } from "../features/web/WebTargetsScreen";
import { NewScheduleScreen } from "../features/scheduled/NewScheduleScreen";
import { ScheduledAgentsScreen } from "../features/scheduled/ScheduledAgentsScreen";
import { readWebTargets } from "../features/web/webTargetsLogic";
import { stackScreenOptions } from "./navigationTheme";
import { PairingRoute, SettingsRoute } from "./routes";
import { SnapshotWatch, useSessionData, useSnapshot } from "./SessionDataProvider";
import type { BacklogStackParamList, HomeStackParamList } from "./types";

const HomeStack = createNativeStackNavigator<HomeStackParamList>();

/**
 * A chat in the top screen's place: a chat link's. Back from it is Back from
 * the screen it replaced.
 */
const inPlaceOfTop = (target: HomeStackParamList["Conversation"]) => (state: NavigationState) => {
  const routes = routesInPlaceOfTop(state.routes, { name: "Conversation", params: target }, { name: "HomeOverview" });
  return CommonActions.reset({ ...state, routes, index: routes.length - 1 });
};
const BacklogStack = createNativeStackNavigator<BacklogStackParamList>();

export function AppNavigator() {
  const reducedMotion = useReducedMotion();
  const {
    session,
    sessions,
    activeDeviceId,
    snapshot,
    isRefreshing,
    refreshSnapshot,
    isFleetRefreshing,
    refreshFleet,
    selectSession,
    removeSession,
    renameSession,
    revokeOnDesktop,
  } = useSessionData();
  const { chats, openedAt } = useChats();
  const notices = useNotices();

  // The bell's dot counts what the notices screen would show, from the same
  // builder — a badge that could disagree with its own screen would be worse
  // than no badge.
  const lanes = splitNotices(buildNotices({ chats, openedAt, now: Date.now() }), notices.readIds);

  return (
    <HomeStack.Navigator screenOptions={stackScreenOptions(reducedMotion)}>
      <HomeStack.Screen name="HomeOverview" options={{ headerShown: false }}>
        {({ navigation }) => (
          <ConversationsScreen
            noticeCount={bellCount(lanes)}
            onNew={() => navigation.navigate("ChooseProject")}
            onOpen={(target) => navigation.navigate("Conversation", target)}
            onOpenNotices={() => navigation.navigate("Notices")}
            onOpenSettings={() => navigation.navigate("SettingsHome")}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="Conversation" options={{ headerShown: false }}>
        {({ navigation, route }) => {
          const chat = { deviceId: route.params.deviceId, workspaceId: route.params.thread.workspaceId, agentId: route.params.thread.agentId };
          return (
            <ConversationScreen
              key={JSON.stringify([chat.deviceId, chat.workspaceId, chat.agentId])}
              deviceId={route.params.deviceId}
              thread={route.params.thread}
              opening={route.params.opening}
              onOpeningTaken={() => navigation.setParams({ opening: undefined })}
              onBack={() => navigation.goBack()}
              onPairAgain={() => navigation.navigate("Pairing")}
              // Pushed over the chat, which stays mounted beneath them and keeps
              // the one socket they read from.
              onOpenAgents={() => navigation.push("ConversationAgents", chat)}
              onOpenAgent={(laneId) => navigation.push("ConversationAgent", { ...chat, laneId })}
              onOpenPlan={(requestId) => navigation.push("ConversationPlan", { ...chat, requestId })}
              onOpenChanges={(turnSeq) => navigation.push("ConversationChanges", { ...chat, turnSeq })}
            />
          );
        }}
      </HomeStack.Screen>
      <HomeStack.Screen name="ConversationAgents" options={{ headerShown: false }}>
        {({ navigation, route }) => (
          <ConversationAgentsScreen
            conversation={route.params}
            onBack={() => navigation.goBack()}
            onOpenAgent={(laneId) => navigation.push("ConversationAgent", { ...route.params, laneId })}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="ConversationAgent" options={{ headerShown: false }}>
        {({ navigation, route }) => (
          <ConversationAgentScreen conversation={route.params} laneId={route.params.laneId} onBack={() => navigation.goBack()} />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="ConversationPlan" options={{ headerShown: false }}>
        {({ navigation, route }) => (
          <ConversationPlanScreen conversation={route.params} requestId={route.params.requestId} onBack={() => navigation.goBack()} />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="ConversationChanges" options={{ headerShown: false }}>
        {({ navigation, route }) => (
          <ConversationChangesScreen
            conversation={route.params}
            turnSeq={route.params.turnSeq}
            onBack={() => navigation.goBack()}
            onOpenFile={(path) => navigation.push("ConversationFileDiff", { ...route.params, path })}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="ConversationFileDiff" options={{ headerShown: false }}>
        {({ navigation, route }) => (
          <ConversationFileDiffScreen
            conversation={route.params}
            turnSeq={route.params.turnSeq}
            path={route.params.path}
            onBack={() => navigation.goBack()}
            // In place, not pushed: stepping through ten files should not
            // leave ten screens for Back to walk through on the way to the list.
            onOpenFile={(path) => navigation.setParams({ path })}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="ConversationLink" options={{ headerShown: false }}>
        {({ navigation, route }) => (
          <ConversationLinkScreen
            key={JSON.stringify([route.params.deviceId, route.params.workspaceId, route.params.agentId])}
            target={route.params}
            onBack={() => navigation.goBack()}
            onPairAgain={() => navigation.navigate("Pairing")}
            onOpenAgents={() => navigation.push("ConversationAgents", route.params)}
            onOpenAgent={(laneId) => navigation.push("ConversationAgent", { ...route.params, laneId })}
            onOpenPlan={(requestId) => navigation.push("ConversationPlan", { ...route.params, requestId })}
            onOpenChanges={(turnSeq) => navigation.push("ConversationChanges", { ...route.params, turnSeq })}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="ChatLink" options={{ headerShown: false }}>
        {({ navigation, route }) => (
          <ChatLinkScreen
            key={JSON.stringify([route.params.workspaceId, route.params.agent ?? null])}
            link={{ workspaceId: route.params.workspaceId, agentId: route.params.agent ?? null }}
            onBack={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate("HomeOverview"))}
            // The chat takes the link's place, so Back from it is Back from the link.
            onOpen={(target) => navigation.dispatch(inPlaceOfTop(target))}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="ChooseProject">
        {({ navigation }) => (
          <ChooseProjectScreen
            onBack={() => navigation.goBack()}
            onChoose={(choice) => navigation.navigate("NewChat", choice)}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="NewChat">
        {({ navigation, route }) => (
          <NewChatScreen
            deviceId={route.params.deviceId}
            desktopName={route.params.desktopName}
            initialSheet={route.params.sheet === "model" ? "model" : undefined}
            onCancel={() => navigation.goBack()}
            onStarted={(deviceId, thread, opening) =>
              // One reset, not a replace: the picker under the composer leaves
              // too, so Back from the new chat lands on the list.
              navigation.dispatch((state: NavigationState) => {
                const routes = routesAfterNewChat(state.routes, {
                  name: "Conversation",
                  params: { deviceId, thread, ...(opening ? { opening } : {}) },
                });
                return CommonActions.reset({ ...state, routes, index: routes.length - 1 });
              })
            }
            projectName={route.params.projectName}
            workspaceId={route.params.workspaceId}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="Notices">
        {({ navigation }) => (
          <NoticesScreen
            desktopName={session?.desktopName ?? null}
            onBack={() => navigation.goBack()}
            onMarkAllRead={notices.markAllRead}
            onOpenChat={(target) => navigation.navigate("Conversation", target)}
            onPruneRead={notices.prune}
            openedAt={openedAt}
            readIds={notices.readIds}
            chats={chats}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="SettingsHome">
        {({ navigation }) => (
          <SettingsRoute
            onBack={() => navigation.goBack()}
            onOpenAppearance={() => navigation.navigate("Appearance")}
            onOpenDesktops={() => navigation.navigate("Desktop", { deviceId: "" })}
            onOpenWeb={() => navigation.navigate("Web")}
            onOpenScheduled={() => navigation.navigate("Scheduled")}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="Scheduled" options={{ headerShown: false }}>
        {({ navigation }) => (
          <ScheduledAgentsScreen
            onBack={() => navigation.goBack()}
            onNew={() => navigation.navigate("ScheduleChooseProject")}
            sessions={sessions}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="ScheduleChooseProject">
        {({ navigation }) => (
          <ChooseProjectScreen onBack={() => navigation.goBack()} onChoose={(choice) => navigation.navigate("NewSchedule", choice)} />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="NewSchedule">
        {({ navigation, route }) => (
          <NewScheduleScreen
            desktopName={route.params.desktopName}
            onCancel={() => navigation.goBack()}
            // Back past the project chooser to the list, which reads again.
            onScheduled={() => navigation.navigate("Scheduled")}
            projectName={route.params.projectName}
            session={sessions.find((candidate) => candidate.deviceId === route.params.deviceId) ?? null}
            workspaceId={route.params.workspaceId}
          />
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="Desktop">
        {({ navigation, route }) =>
          route.params.deviceId ? (
            <>
              {/* Its revoke button is offered when the snapshot's commands say so. */}
              <SnapshotWatch />
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
            </>
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
      </HomeStack.Screen>
      <HomeStack.Screen name="Web">
        {({ navigation }) => (
          <>
            <SnapshotWatch />
            <WebTargetsScreen
              isRefreshing={isRefreshing}
              onBack={() => navigation.goBack()}
              onOpen={(target) => void openWebTarget(target)}
              onRefresh={refreshSnapshot}
              targets={readWebTargets(snapshot)}
            />
          </>
        )}
      </HomeStack.Screen>
      <HomeStack.Screen name="Appearance">
        {({ navigation }) => <AppearanceScreen onBack={() => navigation.goBack()} />}
      </HomeStack.Screen>
      <HomeStack.Screen name="Pairing" component={PairingRoute} />
    </HomeStack.Navigator>
  );
}

function BacklogNavigator() {
  const reducedMotion = useReducedMotion();
  const {
    snapshot,
    snapshotState,
    snapshotError,
    isRefreshing,
    refreshSnapshot,
    backlogCapabilities,
    sendBacklogUpdate,
    sendBacklogCreate,
    currentProject,
  } = useSnapshot();

  const backlogWorkspaces = normalizeBacklogWorkspaces(snapshot?.backlog);

  return (
    <BacklogStack.Navigator screenOptions={stackScreenOptions(reducedMotion)}>
      <BacklogStack.Screen name="BacklogList">
        {({ navigation }) => (
          <BacklogScreen
            backlog={snapshot?.backlog}
            currentProjectName={currentProject?.name ?? null}
            currentWorkspacePath={currentProject?.workspacePath ?? null}
            errorMessage={snapshotError}
            isLoading={snapshotState === "loading"}
            isRefreshing={isRefreshing}
            onCreateItem={sendBacklogCreate}
            onOpenItem={(item) =>
              navigation.navigate("BacklogDetail", {
                workspacePath: item.workspacePath,
                relativePath: item.relativePath,
              })
            }
            onRefresh={refreshSnapshot}
          />
        )}
      </BacklogStack.Screen>
      <BacklogStack.Screen name="BacklogDetail">
        {({ navigation, route }) => {
          const workspace = backlogWorkspaces.find(
            (candidate) => candidate.workspacePath === route.params.workspacePath,
          );
          const item =
            workspace?.items.find((candidate) => candidate.relativePath === route.params.relativePath) ?? null;
          return (
            <BacklogItemDetailScreen
              capabilities={backlogCapabilities}
              // Same lookup the list row makes, from the same workspace record —
              // the two surfaces render one epic and must not disagree about its
              // colour or its id.
              epicMeta={item?.epic ? workspace?.epics.get(item.epic) : undefined}
              item={item}
              onBack={() => navigation.goBack()}
              onUpdateItem={sendBacklogUpdate}
            />
          );
        }}
      </BacklogStack.Screen>
    </BacklogStack.Navigator>
  );
}
