import type { DesktopSessionStatus } from "../api/types";

/**
 * The one switch above the app's stack. Everything below it — chats, notices,
 * settings — assumes a live desktop session, so the gate decides once, here,
 * rather than every screen re-deriving it.
 *
 * `tabs` is the historical spelling of "a live desktop", kept because it is compared
 * against by name in more than one place; the tab bar itself went with the
 * phone's sprint surface (2026-09-16).
 */
export type RootRoute = "gate" | "tabs";

/** Where the gate stack starts when the root route is `gate`. */
export type GateRoute = "Welcome" | "SessionStatus";

interface SessionFlowState {
  status?: DesktopSessionStatus;
}

export function shouldShowSignedInNavigation(session: SessionFlowState | null) {
  return Boolean(session && (session.status === "online" || !session.status));
}

export function resolveRootRoute(session: SessionFlowState | null): RootRoute {
  return shouldShowSignedInNavigation(session) ? "tabs" : "gate";
}

/**
 * No paired desktop at all is a welcome — the user has nothing to open yet,
 * and pairing is the way in. A paired desktop that is offline, stale, or revoked is a *session*
 * problem, and that screen names which.
 */
export function resolveGateRoute(session: SessionFlowState | null): GateRoute {
  return session ? "SessionStatus" : "Welcome";
}
