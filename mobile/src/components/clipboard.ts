// The clipboard, in one place. The app reaches it only through
// `writeClipboard`, so anything that wants to stand it in has one function to
// replace, and the rest of the app never names the package.
//
// `expo-clipboard` is a native module. A build from before it was added has
// no `ExpoClipboard` in its binary, and importing the package there throws as
// the screen that imports it loads. So it is required on first use, inside a
// try: on such a build Copy says the app needs updating, and the chat it sits
// in still opens.

declare const require: ((moduleName: string) => unknown) | undefined;

type ClipboardModule = { setStringAsync: (text: string) => Promise<boolean> };

let native: ClipboardModule | null | undefined;

function clipboardModule(): ClipboardModule | null {
  if (native !== undefined) return native;
  try {
    const loaded = typeof require === "function" ? (require("expo-clipboard") as Partial<ClipboardModule> | null) : null;
    native = typeof loaded?.setStringAsync === "function" ? (loaded as ClipboardModule) : null;
  } catch {
    native = null;
  }
  return native;
}

/** How a copy went: done, refused by the system, or impossible on this build. */
export type CopyOutcome = "copied" | "failed" | "unavailable";

/** Puts `text` on the clipboard as plain text. Never throws. */
export async function writeClipboard(text: string): Promise<CopyOutcome> {
  const clipboard = clipboardModule();
  if (!clipboard) return "unavailable";
  try {
    return (await clipboard.setStringAsync(text)) === false ? "failed" : "copied";
  } catch {
    return "failed";
  }
}
