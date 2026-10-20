import { File, Paths } from "expo-file-system";

import { restoreSentPhotos, sentPhotoEntries, subscribeSentPhotos } from "../features/conversations/sentPhotos";

// Where on this phone each photo it sent is, by upload id, kept across
// restarts so its message still shows the photo from here. One small file,
// not secret: ids and the picker's cache paths. A read that fails is no
// copies, and a write that fails costs only a thumbnail after a restart.

const file = () => new File(Paths.document, "sent-photos.json");
let started = false;

/** Restore the kept copies, then keep the file in step with them. Once per run. */
export function startSentPhotoCopies(): void {
  if (started) return;
  started = true;
  void (async () => {
    try {
      const stored = file();
      if (stored.exists) restoreSentPhotos(JSON.parse(await stored.text()));
    } catch {
      // Unreadable is empty.
    }
    subscribeSentPhotos(() => {
      try {
        file().write(JSON.stringify(sentPhotoEntries()));
      } catch {
        // A full disk must not stop the chat.
      }
    });
  })();
}
