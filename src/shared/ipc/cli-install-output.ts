import { isWslHostId } from '../execution-host'

/**
 * The channel an install or update streams its output on, one per CLI per
 * machine: the same CLI updating here and in a WSL distribution at once would
 * otherwise write both logs into each row. This machine keeps the channel's
 * original spelling.
 */
export function cliInstallOutputChannel(cli: string, hostId?: string | null): string {
  const base = `cli-runtime:install-output:${cli}`
  return isWslHostId(hostId) ? `${base}@${hostId}` : base
}
