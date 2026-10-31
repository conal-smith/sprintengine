import type { MobileSession } from "../api/types";
import { mobileControlProtocolVersion, type MobileControlSnapshot } from "../shared/mobile-control";

// A realistic desktop snapshot for screenshot verification: a backlog with
// two epics. The Sprint Engine runs, their workspaces and the role catalog
// went with the phone's sprint surface (2026-09-16), and the automation with the
// phone's automations (2026-09-29) — nothing here renders them any more. Never
// shipped: the harness that reads it is only bundled when
// EXPO_PUBLIC_VERIFY_HARNESS is set at build time.

const now = new Date("2026-09-01T21:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const PROJECT_KEY = "mobile";
const WORKSPACE_PATH = "/Users/dev/mobile";

export const verifySession: MobileSession = {
  deviceId: "dev_verify",
  desktopName: "MBP-M3",
  baseUrl: "http://dev-macbook-air.tail1234.ts.net:8471",
  deviceToken: "mctn_verify",
  pairedAt: minutesAgo(60 * 24 * 3),
  tailnetScopes: ["workspace:read", "workspace:operate", "conversation:read", "conversation:operate"],
  tailnetTransportVersion: 2,
  status: "online",
  lastSeenAt: minutesAgo(0),
  // What a current Studio declares on identity. `conversations` is what lists
  // the desktop's chats at all, `conversation-models` is what draws a
  // chat's model control, `conversation-images` what shows its pictures, and
  // `conversation-lifecycle` what lists each chat's clocks and offers Settle,
  // `chat-mark-unread` what offers Mark unread, and `chat-row-menu` what
  // offers Snooze and Wake now.
  // New's Worktree switch, its effort ramp and the picker's own rows need
  // `new-chat-worktree`, `new-chat-effort` and `cli-runtime-catalog`, and a
  // message queued behind a turn is held by the desktop with
  // `conversation-queued-sends`, and one steered into it with
  // `conversation-steer-sends`. The "+" offers a file beside photos with
  // `conversation-message-files`, and a running agent its own Stop with
  // `conversation-stop-subagent`.
  tailnetCapabilities: [
    "conversations",
    "conversation-models",
    "conversation-images",
    "conversation-permission-modes",
    "conversation-plans",
    "conversation-lifecycle",
    "chat-mark-unread",
    "chat-row-menu",
    "new-chat-worktree",
    "new-chat-effort",
    "cli-runtime-catalog",
    "conversation-queued-sends",
    "conversation-steer-sends",
    "conversation-message-files",
    "conversation-stop-subagent",
  ],
  // How the desktop draws itself, from its identity: New's strip and "Run on" wear it.
  machineMark: { kind: "laptop", color: "blue" },
};

export const verifySessions: MobileSession[] = [
  verifySession,
  {
    ...verifySession,
    deviceId: "dev_mini",
    desktopName: "Mac mini",
    status: "offline",
    lastSeenAt: minutesAgo(60 * 24 * 3),
    baseUrl: "http://mac-mini.tail1234.ts.net:8471",
    // An older Studio: its projects read, but it streams no chats, so the
    // list holds one desktop's chats and New names one machine. It sends no
    // machine mark either, so it wears the generic remote mark.
    tailnetCapabilities: [],
    machineMark: undefined,
  },
];

export const verifySnapshot: MobileControlSnapshot = {
  protocolVersion: mobileControlProtocolVersion,
  generatedAt: minutesAgo(0),
  desktopSessionId: "desk_verify",
  snapshotVersion: "verify-1",
  commands: ["snapshot.request", "backlog.update", "backlog.create"],
  backlog: [
    {
      workspaceId: "backlog_mobile",
      workspacePath: WORKSPACE_PATH,
      projectKey: PROJECT_KEY,
      workspaceName: "mobile",
      updatedAt: minutesAgo(5),
      epics: [
        { slug: "mobile-restrained-visual-reset", displayId: "MM-70", title: "The phone becomes sprintengine.ai", color: "green", doneCount: 1, totalCount: 4 },
        { slug: "signed-in-fleet-without-pairing", displayId: "MC-2228", title: "Sign-in is enough", color: "blue", doneCount: 0, totalCount: 5 },
      ],
      items: [
        {
          itemId: "MM-72",
          relativePath: "backlog/2026-09-01-retire-herbarium-tokens-for-system-neutrals.md",
          title: "Tokens: the system's neutrals replace Herbarium",
          excerpt:
            "src/theme/tokens.ts keeps its names and drops its values: light takes the site's white page, dark its neutral-950 page. The Herbarium fork and every paper-only deviation go with it.\n\n## Acceptance\n\nContrast suites green with the new values; no hex in the file that is not on the token sheet.",
          status: "ready",
          type: "feature",
          difficulty: "m",
          criticality: "high",
          epic: "mobile-restrained-visual-reset",
          updatedAt: minutesAgo(30),
        },
        {
          itemId: "MM-73",
          relativePath: "backlog/2026-09-01-remove-botanical-backdrops-and-native-brand-surfaces.md",
          title: "Remove the botanical backdrops",
          status: "ready",
          type: "feature",
          difficulty: "s",
          criticality: "normal",
          epic: "mobile-restrained-visual-reset",
          updatedAt: minutesAgo(35),
        },
        {
          itemId: "MM-74",
          relativePath: "backlog/2026-09-01-copy-diet-every-surface.md",
          title: "Copy diet: every surface says what it must",
          status: "ready",
          type: "feature",
          difficulty: "m",
          criticality: "normal",
          epic: "mobile-restrained-visual-reset",
          updatedAt: minutesAgo(40),
        },
        {
          itemId: "MM-71",
          relativePath: "backlog/2026-09-01-mockup-restrained-phone-three-screens.md",
          title: "Mockup: sign-in, desktops list and board in the site's language",
          status: "completed",
          type: "mockup",
          difficulty: "m",
          criticality: "high",
          epic: "mobile-restrained-visual-reset",
          updatedAt: minutesAgo(90),
        },
        {
          itemId: "MM-68",
          relativePath: "backlog/2026-08-04-native-identity-rename.md",
          title: "The app becomes Sprint Engine, down to the native identity",
          status: "completed",
          type: "feature",
          difficulty: "l",
          criticality: "high",
          updatedAt: minutesAgo(60 * 24 * 20),
        },
        {
          itemId: "MM-75",
          relativePath: "backlog/2026-09-01-phone-fleet-after-sign-in.md",
          title: "Phone: the desktops list is the first screen after sign-in",
          status: "idea",
          type: "feature",
          difficulty: "m",
          criticality: "high",
          epic: "signed-in-fleet-without-pairing",
          updatedAt: minutesAgo(50),
        },
        {
          itemId: "MM-76",
          relativePath: "backlog/2026-09-01-relay-untrusted-origin-copy.md",
          title: "Untrusted relay sheet names the host, not the scheme",
          status: "idea",
          type: "bug",
          difficulty: "xs",
          criticality: "low",
          updatedAt: minutesAgo(60 * 5),
        },
        {
          itemId: "MM-77",
          relativePath: "backlog/2026-09-01-inbox-scope-persist.md",
          title: "Inbox scope survives a relaunch",
          status: "in_progress",
          type: "feature",
          difficulty: "s",
          criticality: "normal",
          updatedAt: minutesAgo(15),
        },
      ],
    },
  ],
};
