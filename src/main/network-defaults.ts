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

// Node's own types do not declare setTypeOfService yet.
type TypeOfServiceSocket = {
  setTypeOfService?: (this: net.Socket, typeOfService: number) => net.Socket
}

// Node's fetch sets a socket's type-of-service on every HTTP/1 request, from
// a socket callback with nothing around it to catch. On macOS that call
// throws EINVAL once the peer has reset the connection, and the throw
// escapes as an uncaught exception: the Studio server exits and restarts
// under its supervisor, cutting off the chats it was running, and the app
// shows an error. The type of service is an optional QoS hint, so on macOS
// an EINVAL from it is ignored; every other error still throws.
export function ignoreMacosTypeOfServiceEinval(
  platform: NodeJS.Platform = process.platform,
  socketPrototype: TypeOfServiceSocket = net.Socket.prototype as TypeOfServiceSocket,
): void {
  if (platform !== 'darwin') return
  const setTypeOfService = socketPrototype.setTypeOfService
  if (typeof setTypeOfService !== 'function') return
  socketPrototype.setTypeOfService = function (this: net.Socket, typeOfService: number) {
    try {
      return setTypeOfService.call(this, typeOfService)
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'EINVAL') return this
      throw error
    }
  }
}
