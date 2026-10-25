// The package's entry: the whole conversation contract.
//
// `index.ts` and the four files it re-exports are the portable source the
// phone app carries byte-for-byte under a shared SHA-256 pin
// (src/main/automation/tailnet/conversation-protocol.test.ts), so they change
// only in a change made on both sides at once. Everything added since lives
// in files of its own and is published from here, which keeps the pinned
// files as they are while the package grows.
export * from './index.js'
export * from './serverFrames.js'
export * from './events.js'
export * from './commands.js'
export * from './handshake.js'
export * from './clientFrames.js'
// What a client's composer reads from the desktop beside the socket.
export * from './composerReads.js'
// How a tool step is worded and toned, which every view of a conversation shares.
export * from './presentation.js'
