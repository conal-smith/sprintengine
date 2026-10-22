import { resolve } from 'node:path'
import { BROWSER_PARTITION, isLoadableBrowserUrl } from '../../shared/browser'

// The `will-attach-webview` policy, as a pure function so it can be tested:
// every guest a workspace window attaches is the embedded browser and nothing
// else — our partition, http(s) only, sandboxed, no Node in any frame. Whatever
// the renderer wrote on the tag is overruled here, so a compromised renderer
// cannot mint a privileged guest.

export type GuestAttachParams = { partition?: string; src?: string }
export type GuestWebPreferences = Record<string, unknown> & { preload?: string; contextIsolation?: boolean }

/**
 * Mutates `webPreferences` into the only shape a guest may have and returns
 * whether the attach may proceed at all.
 */
export function applyGuestWebPreferences(
  webPreferences: GuestWebPreferences,
  params: GuestAttachParams,
  pickerPreloadPath: string | null,
  // An SSH machine's partition (phase 8), only once main has set its proxy:
  // a guest on any other partition would reach a network nobody chose.
  isMachinePartition: (partition: string) => boolean = () => false,
): boolean {
  if (params.partition !== BROWSER_PARTITION && !(params.partition && isMachinePartition(params.partition)))
    return false
  if (typeof params.src === 'string' && params.src && !isLoadableBrowserUrl(params.src)) return false
  // The only preload a guest may carry is the element picker we ship; any
  // other path is dropped. Context isolation is on for every guest: the picker
  // runs in its own world, out of the page's reach, and reads the React fiber
  // (which lives in the page's world) with a script it runs there for the one
  // element picked (browser-guest.ts).
  const requested = webPreferences.preload
  if (pickerPreloadPath && requested && resolve(requested) === resolve(pickerPreloadPath)) {
    webPreferences.preload = pickerPreloadPath
  } else {
    delete webPreferences.preload
  }
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  // A page that goes fullscreen fills the app window's content, never the
  // screen: left on, Electron would put the whole window into the OS's full
  // screen. The window hosting the guest turns it off too, since the guest's
  // fullscreen is passed on to it.
  webPreferences.disableHtmlFullscreenWindowResize = true
  return true
}

// Which SSH machines' partitions a guest may attach to now (phase 8): set
// once by the app's services, read on every `will-attach-webview`.
let machinePartitionCheck: (partition: string) => boolean = () => false

export function allowMachinePartitions(check: (partition: string) => boolean): void {
  machinePartitionCheck = check
}

export function isAllowedMachinePartition(partition: string): boolean {
  return machinePartitionCheck(partition)
}
