// The package's entry: the Studio protocol, and the conversation contract it
// carries.
//
// Everything `@sprintengine/conversation-protocol` exports is re-exported
// here, so a client depends on this one package. The conversation package
// stays what it is — the conversation lane on its own, which the phone app
// carries byte for byte — and this one adds the connection around it.
export * from './conversation.js'
export * from './scopes.js'
export * from './handshake.js'
export * from './envelope.js'
export * from './methods.js'
export * from './chat.js'
export * from './discovery.js'
export * from './tools.js'
export * from './files.js'
export * from './pull-requests.js'
export * from './local-servers.js'
export * from './permissions.js'
