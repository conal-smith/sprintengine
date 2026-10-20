import { AppState } from "react-native";
import { File, Paths } from "expo-file-system";

import {
  normalizeDrafts,
  withDraft,
  type ComposerDrafts,
} from "../features/conversations/composerDrafts";

// Every chat's unsent draft (`composerDrafts.ts`), in one small file. Read
// once per run, then answered from memory, so a chat opened again finds its
// draft in the box on its first draw. Typing writes 300ms after the last
// keystroke, and going to the background writes at once, so the app being
// closed from the switcher keeps what was typed. A read that fails is no
// drafts and a write that fails costs only the draft: neither stops the chat.

const file = () => new File(Paths.document, "composer-drafts.json");
const WRITE_AFTER_MS = 300;

let drafts: ComposerDrafts | null = null;
let loading: Promise<ComposerDrafts> | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let backgroundWatch: { remove(): void } | null = null;

function write() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  if (!drafts) return;
  try {
    file().write(JSON.stringify(drafts));
  } catch {
    // A full disk costs the draft, never the chat.
  }
}

/** Reads the drafts from disk, once per run. */
export function loadComposerDrafts(): Promise<ComposerDrafts> {
  if (drafts) return Promise.resolve(drafts);
  loading ??= (async () => {
    let read: ComposerDrafts = {};
    try {
      const stored = file();
      if (stored.exists) read = normalizeDrafts(JSON.parse(await stored.text()), Date.now());
    } catch {
      read = {};
    }
    // A draft typed while the file was being read is newer than the file's.
    drafts = { ...read, ...(drafts ?? {}) };
    return drafts;
  })();
  return loading;
}

/** The chat's draft if the drafts have been read; undefined while they have not. */
export function peekComposerDraft(key: string): string | undefined {
  return drafts ? (drafts[key]?.text ?? "") : undefined;
}

/** Keeps `text` as the chat's draft; an empty box forgets it. */
export function saveComposerDraft(key: string, text: string) {
  const current = drafts ?? {};
  const next = withDraft(current, key, text, Date.now());
  if (next === current && drafts) return;
  drafts = next;
  backgroundWatch ??= AppState.addEventListener("change", (state) => {
    if (state !== "active" && writeTimer) write();
  });
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(write, WRITE_AFTER_MS);
}

/** Writes a draft still waiting for its keystrokes to settle, as a chat closes. */
export function flushComposerDrafts() {
  if (writeTimer) write();
}
