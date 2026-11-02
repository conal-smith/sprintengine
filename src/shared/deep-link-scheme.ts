// The URL scheme the app answers to, registered with the OS in
// `main/app-lifecycle`. Shared so the renderer can write the links main reads
// (`deep-link.ts`).
export const CURRENT_DEEP_LINK_SCHEME = 'sprintengine' as const

export const DEEP_LINK_SCHEMES = [CURRENT_DEEP_LINK_SCHEME] as const

/**
 * Arguments to relaunch with, less any link the app was opened with: on
 * Windows and Linux a link that launches the app arrives as an argument, and
 * startup has already acted on it, so a relaunch for a setting would sign in
 * or open the chat again.
 */
export function withoutDeepLinks(args: readonly string[]): string[] {
  return args.filter((arg) => !DEEP_LINK_SCHEMES.some((scheme) => arg.toLowerCase().startsWith(`${scheme}:`)))
}
