import { File, Paths } from "expo-file-system";

import {
  normalizeProjectPicks,
  recordProjectPick,
  type ProjectPicks,
} from "../features/conversations/conversationListLogic";

// This phone's own choices on New, kept so a desktop that sends no usage of
// its own still lists the projects picked lately first. One small file, not
// secret: folder keys and times, nothing that opens a desktop. A read that
// fails is no picks, and a write that fails costs only the order.

const file = () => new File(Paths.document, "project-picks.json");

export async function loadProjectPicks(): Promise<ProjectPicks> {
  try {
    const stored = file();
    if (!stored.exists) return {};
    return normalizeProjectPicks(JSON.parse(await stored.text()));
  } catch {
    return {};
  }
}

/** Remember that `projectKey` was chosen on `deviceId` now; answers the picks as they now stand. */
export async function rememberProjectPick(deviceId: string, projectKey: string): Promise<ProjectPicks> {
  const next = recordProjectPick(await loadProjectPicks(), deviceId, projectKey, Date.now());
  try {
    file().write(JSON.stringify(next));
  } catch {
    // The order is a convenience; a full disk must not stop the chat.
  }
  return next;
}
