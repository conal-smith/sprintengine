import net from 'node:net'

// Node's fetch tries each of a host's addresses in turn, IPv6 and IPv4
// interleaved, and by default gives each attempt 250 ms before moving to the
// next. On a network that hands out IPv6 addresses with no IPv6 route, and
// reaches IPv4 hosts slowly (satellite, a distant VPN), every attempt is cut
// short and the request fails: the npm version check, the marketplace,
// skill sources. Each attempt gets at least a second; a longer timeout set
// before this runs is kept.
export const MIN_CONNECT_ATTEMPT_TIMEOUT_MS = 1_000

export function raiseConnectAttemptTimeout(
  netApi: Pick<
    typeof net,
    'getDefaultAutoSelectFamilyAttemptTimeout' | 'setDefaultAutoSelectFamilyAttemptTimeout'
  > = net,
): void {
  const current = netApi.getDefaultAutoSelectFamilyAttemptTimeout()
  if (current < MIN_CONNECT_ATTEMPT_TIMEOUT_MS)
    netApi.setDefaultAutoSelectFamilyAttemptTimeout(MIN_CONNECT_ATTEMPT_TIMEOUT_MS)
}
