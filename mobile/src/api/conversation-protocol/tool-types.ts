export type ConversationJsonValue =
  null | boolean | number | string | ConversationJsonValue[] | { [key: string]: ConversationJsonValue }
export type ConversationToolKind =
  | 'command'
  | 'file_edit'
  | 'file_read'
  | 'file_write'
  | 'search'
  | 'list'
  | 'web'
  | 'mcp'
  | 'subagent'
  | 'todo'
  | 'other'
export type ConversationToolStatus = 'ok' | 'error' | 'declined' | 'stopped'
