import { buildStamp } from 'virtual:sprintengine-build-stamp'

import { raiseConnectAttemptTimeout } from '../main/network-defaults'
import { installFatalHandlers } from './bootstrap/fatal'
import { startHeadlessServer } from './bootstrap/headless'
import { parentPortChannel, utilityParentPort } from './bootstrap/parent-port'
import { serveOnChannel } from './bootstrap/serve'
import { startDesktopServer } from './desktop/desktop-server'

// The desktop's Studio server: the entry the shell forks as a utility process
// (`out/main/studio-server.js`, built beside main from the same commit). Its
// envelope arrives on the parent port, and the parent port carries every
// control frame after it (bootstrap/parent-port.ts).
//
// A parent port keeps the event loop alive, so the process leaves by exiting
// with the code the serve loop settles on, never by running out of work.

function say(message: string): void {
  process.stderr.write(`[studio-server] ${message}\n`)
}

const port = utilityParentPort()
if (!port) {
  say('This entry runs as the desktop’s utility process. Start a standalone server with `studio-server serve`.')
  process.exit(64)
} else {
  const channel = parentPortChannel(port)
  installFatalHandlers(channel, say)
  raiseConnectAttemptTimeout()
  void serveOnChannel(channel, {
    starters: { 'desktop-local': startDesktopServer, headless: startHeadlessServer },
    unwrapEnvelope: true,
    buildStamp: buildStamp.commit,
    log: say,
  }).then((code) => process.exit(code))
}
