import type { DesktopSessionStatus, MobileSession } from "../../api/types";

export interface FleetSnapshotSummary {
  /** Backlog groups the desktop reports — one per repo it has open. */
  projectCount: number;
  backlogItemCount: number;
}

export type FleetRowState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; summary: FleetSnapshotSummary }
  | { kind: "error"; message: string };

const statusOrder: Record<DesktopSessionStatus, number> = {
  online: 0,
  stale: 1,
  offline: 2,
  revoked: 3,
};

export function sessionDisplayStatus(session: Pick<MobileSession, "status">): DesktopSessionStatus {
  return session.status ?? "online";
}

// Online desktops first, attention-needing ones next, revoked last; ties break
// on most recent activity so the list reads like a recency feed.
export function orderSessionsForFleet(sessions: MobileSession[]): MobileSession[] {
  return [...sessions].sort((left, right) => {
    const statusDelta = statusOrder[sessionDisplayStatus(left)] - statusOrder[sessionDisplayStatus(right)];
    if (statusDelta !== 0) {
      return statusDelta;
    }
    const leftSeen = Date.parse(left.lastSeenAt ?? left.pairedAt);
    const rightSeen = Date.parse(right.lastSeenAt ?? right.pairedAt);
    if (Number.isFinite(leftSeen) && Number.isFinite(rightSeen) && leftSeen !== rightSeen) {
      return rightSeen - leftSeen;
    }
    return left.desktopName.localeCompare(right.desktopName);
  });
}

export const sessionStatusLabel: Record<DesktopSessionStatus, string> = {
  online: "Online",
  offline: "Offline",
  stale: "Session expired",
  revoked: "Revoked",
};

export function sessionStatusTone(status: DesktopSessionStatus): "neutral" | "success" | "warning" | "danger" {
  switch (status) {
    case "online":
      return "success";
    case "revoked":
      return "danger";
    case "stale":
      return "warning";
    case "offline":
      return "neutral";
  }
}

// Headline counts from a desktop snapshot, defensively read: the fleet row only
// needs orientation numbers.
//
// The count is of `backlog` groups, which is what the project switcher builds its
// list from too. It used to be the length of `workspaces`, which the desktop
// always sent empty — so every row read "0 workspaces" — and which left the wire
// with protocol v4. `sprintEngines` used to contribute a needs-input count; that
// went with the phone's sprint surface (2026-09-16).
export function summarizeSnapshotForFleet(snapshot: unknown): FleetSnapshotSummary {
  const record = isRecord(snapshot) ? snapshot : {};
  const backlog = Array.isArray(record.backlog) ? record.backlog.filter(isRecord) : [];

  const backlogItemCount = backlog.reduce((total, workspace) => {
    return total + (Array.isArray(workspace.items) ? workspace.items.length : 0);
  }, 0);

  return {
    projectCount: backlog.length,
    backlogItemCount,
  };
}

export function fleetHeadline(summary: FleetSnapshotSummary): string {
  const parts = [`${summary.projectCount} ${summary.projectCount === 1 ? "project" : "projects"}`];
  if (summary.backlogItemCount > 0) {
    parts.push(`${summary.backlogItemCount} backlog item${summary.backlogItemCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
