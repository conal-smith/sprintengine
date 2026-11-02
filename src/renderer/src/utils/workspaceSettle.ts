// A chat's rest — when it settles into its folder's Settled shelf, and when it
// comes back — is decided by rules shared with main
// (`shared/workspace-settlement.ts`, which says what they are and why), and
// written through the patches in `shared/workspace-lifecycle.ts`, so every
// writer changes the same fields the same way. This module hands the windows
// what they read of both.
export { isSettledWorkspace, settleWorkspacePatch, wakeWorkspacePatch } from '../../../shared/workspace-lifecycle'
export {
  DEFAULT_AUTO_SETTLE_AFTER_DAYS,
  MAX_AUTO_SETTLE_AFTER_DAYS,
  MIN_AUTO_SETTLE_AFTER_DAYS,
  normalizeAutoSettleAfterDays,
} from '../../../shared/workspace-settlement'
