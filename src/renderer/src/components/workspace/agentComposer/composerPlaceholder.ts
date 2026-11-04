// The one line a chat's empty composer says, in New chat and in an open
// conversation alike, so the two boxes a person types into read as one
// (2026-11-04). It names the `/` menu because nothing else on the box does:
// that menu is where a chat's commands and skills are, in both composers.
// Composers with something in the way (a pending request, a runtime starting)
// and the ones that are not chats (a terminal agent, a schedule, an extension)
// say their own line instead.
export const CHAT_COMPOSER_PLACEHOLDER = 'Ask anything. / for commands and skills'
