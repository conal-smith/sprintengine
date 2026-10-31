// The Studio MCP gateway over loopback HTTP: what a window reads of it and the
// channels it is managed on. The endpoint itself is main's
// (src/main/automation/mcp-http-server.ts).
//
// An MCP client that cannot spawn the stdio bridge (one that only takes a URL)
// reaches the same tools at `http://127.0.0.1:<port>/mcp`, with a bearer
// token the person made for it in Settings. Each token is named for the client
// it was made for, kept only as its hash, and revoked on its own.

/** One client the person made a token for. The token itself is shown once, when it is made. */
export type McpHttpClientView = {
  id: string
  name: string
  createdAt: number
  /** When the token last opened a request; null for one never used. */
  lastUsedAt: number | null
}

export type McpHttpStatus = {
  /** Listening: it is while at least one token exists. */
  running: boolean
  /** The endpoint's address while it is listening. */
  url: string | null
  clients: McpHttpClientView[]
  lastError: string | null
}

export type McpHttpCreateResult =
  | {
      ok: true
      status: McpHttpStatus
      client: McpHttpClientView
      /** The bearer token, in the clear this once. */
      token: string
      url: string
    }
  | { ok: false; message: string; status: McpHttpStatus }

/** The longest name a client's token may be given. */
export const MCP_HTTP_CLIENT_NAME_MAX = 60
/** How many tokens may exist at once. */
export const MCP_HTTP_MAX_CLIENTS = 32

export const MCP_HTTP_STATUS_CHANNEL = 'automation:mcp-http-status'
export const MCP_HTTP_CREATE_CHANNEL = 'automation:mcp-http-create'
export const MCP_HTTP_REVOKE_CHANNEL = 'automation:mcp-http-revoke'

/**
 * What "Copy MCP URL" puts on the clipboard: the server as an MCP client's
 * configuration names one by URL, with its token as the bearer header. The
 * shape most clients that take a URL read, and plain enough to copy the two
 * values out of for one that does not.
 */
export function mcpHttpClientConfig(serverName: string, url: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { [serverName]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  )
}
