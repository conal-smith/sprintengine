// The gate carries Settings' whole stack too: a phone whose only desktop went
// offline still needs the desktop screen's diagnostics and its Forget button,
// which is the one place that gets it un-stuck.
export type GateStackParamList = {
  Welcome: undefined;
  SessionStatus: undefined;
  Settings: undefined;
  Desktop: { deviceId: string };
  Appearance: undefined;
  Pairing: undefined;
};

// The app's one stack. `HomeOverview` rather than `Home` is a leftover of the
// tab era's rule that a route may not repeat its tab's name, kept because the
// route name is what a stored back stack is keyed by.
//
// Home is the chat list. Settings and Notices live in THIS stack, behind
// circular buttons in its top bar.
export type HomeStackParamList = {
  HomeOverview: undefined;
  /** Step one of a new chat: the projects each desktop has open. */
  ChooseProject: undefined;
  /** Step two: the first message of a chat on the chosen project. */
  NewChat: {
    deviceId: string;
    workspaceId: string;
    projectName: string;
    desktopName: string;
    /** Opens with the model sheet up: a deep link's, so the picker can be reached in one step. */
    sheet?: "model";
  };
  Conversation: {
    deviceId: string;
    thread: import("../api/conversationWire").ConversationThread;
    /** New's first message, when it carries pictures: its words, and the pictures New uploaded to the chat. */
    opening?: import("../features/conversations/photoLaunch").ChatOpening;
  };
  ConversationLink: import("../features/conversations/conversationLogic").ConversationLink;
  /**
   * A desktop's chat link (`sprintengine://chat/<workspaceId>?agent=<agentId>`):
   * the workspace, found on whichever paired desktops list it. `agent` keeps
   * the link's own name for it.
   */
  ChatLink: { workspaceId: string; agent?: string };
  /** The agents a chat sent off to work. Reads the open chat's live state; it holds no socket of its own. */
  ConversationAgents: { deviceId: string; workspaceId: string; agentId: string };
  /** One agent's own thread, by the id of the call that spawned it. */
  ConversationAgent: { deviceId: string; workspaceId: string; agentId: string; laneId: string };
  /** A plan the chat's agent proposed, as a page, by its request id. */
  ConversationPlan: { deviceId: string; workspaceId: string; agentId: string; requestId: string };
  /** The files one checkpointed turn changed, by the turn's sequence number. */
  ConversationChanges: { deviceId: string; workspaceId: string; agentId: string; turnSeq: number };
  /** One of those files as a diff; Previous and Next swap `path` in place. */
  ConversationFileDiff: { deviceId: string; workspaceId: string; agentId: string; turnSeq: number; path: string };
  Notices: undefined;
  SettingsHome: undefined;
  /** One paired desktop: its endpoint, this phone's id, and the revoke controls. */
  Desktop: { deviceId: string };
  /** Dev servers the paired desktops publish on the tailnet. */
  Web: undefined;
  /** The scheduled agents on every paired desktop, with Run now, Pause, Resume and Close. */
  Scheduled: undefined;
  /** Step one of a new scheduled agent: the project it runs in, as New chat's step one. */
  ScheduleChooseProject: undefined;
  /** Step two: its prompt and when it runs. */
  NewSchedule: { deviceId: string; workspaceId: string; projectName: string; desktopName: string };
  Appearance: undefined;
  Pairing: undefined;
};

// The hidden Backlog stack (see the note atop AppNavigator.tsx).
export type BacklogStackParamList = {
  BacklogList: undefined;
  BacklogDetail: { workspacePath: string; relativePath: string };
};
