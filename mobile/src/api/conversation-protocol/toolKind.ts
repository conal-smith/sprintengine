import type { ConversationToolKind } from './tool-types.js'

/** Native tool names are classified once, including when replaying old logs. */
export function inferConversationToolKind(name: string): ConversationToolKind {
  if (/^mcp(?:__|[.:/])/i.test(name)) return 'mcp'
  switch (name.toLowerCase().replace(/[-_]/g, '')) {
    case 'bash':
    case 'shell':
    case 'execcommand':
    case 'terminal':
      return 'command'
    case 'edit':
    case 'multiedit':
    case 'applypatch':
      return 'file_edit'
    case 'read':
    case 'readfile':
      return 'file_read'
    case 'write':
    case 'writefile':
      return 'file_write'
    case 'grep':
    case 'search':
    case 'filesearch':
      return 'search'
    case 'glob':
    case 'ls':
    case 'list':
    case 'listfiles':
    case 'listdirectory':
      return 'list'
    case 'webfetch':
    case 'websearch':
    case 'browse':
      return 'web'
    case 'task':
    case 'agent':
    case 'spawnagent':
      return 'subagent'
    case 'todowrite':
    case 'todoread':
    case 'updatetodo':
      return 'todo'
    default:
      return 'other'
  }
}
