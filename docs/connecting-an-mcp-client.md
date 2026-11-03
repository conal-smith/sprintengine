# Connecting an outside agent over MCP

An agent that Studio did not start can use Studio's MCP tools from another
machine on your tailnet: Claude Code or Codex in a terminal on your laptop, or
any agent that connects to remote MCP servers over HTTP and signs in with
OAuth. You give it one URL. The agent works out how to sign in by itself, and
you approve it in the Studio window. Nobody copies a pairing code or a token,
and no secret ends up pasted into a chat.

## Before you start

- Turn on **Remote control over your tailnet** in **Settings → Remote**.
- Tailscale must be running on both machines, with its command-line tool on
  the Studio machine. Studio checks with Tailscale which machine is signing
  in, and it does not complete a sign-in from a machine Tailscale cannot
  name.
- Turn on **HTTPS with Tailscale Serve** in the **MCP clients** section of
  the same page. MCP clients only send sign-in credentials to an `https`
  address or to `localhost`, so most of them can find Studio over plain HTTP
  but cannot finish signing in. HTTPS needs HTTPS certificates turned on for
  your tailnet (Tailscale admin console → DNS → HTTPS Certificates).

## Get the MCP URL

The **MCP URL** row in **Settings → Remote → MCP clients** shows the URL with
a copy button. With HTTPS on it looks like this:

```text
https://mac-mini.example.ts.net/tailnet/v1/mcp
```

`mac-mini.example.ts.net` stands for this machine's name on your tailnet.
With HTTPS off, the row shows the plain-HTTP address on the tailnet port,
`http://mac-mini.example.ts.net:8471/tailnet/v1/mcp`. It only works for
clients that will sign in over plain HTTP.

## Claude Code

```sh
claude mcp add --transport http studio https://mac-mini.example.ts.net/tailnet/v1/mcp
claude mcp login studio
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`. Open the printed URL on any machine
that can reach your tailnet, then paste the final URL back when asked. Inside a
session, `/mcp` shows the server and can start the sign-in too.

## Codex

```sh
codex mcp add studio --url https://mac-mini.example.ts.net/tailnet/v1/mcp
codex mcp login studio
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.

## Other agents

Any agent that supports remote MCP servers over HTTP with OAuth can connect,
OpenClaw included: add the URL as an HTTP (Streamable HTTP) server, choose
OAuth if it asks, and start its login. You do not need a client ID or a
secret. The agent reads where to sign in from the endpoint's `401` answer.
Agents without OAuth support can still pair the older way (see
[Pairing without OAuth](#pairing-without-oauth)).

## Approve the sign-in

The agent opens a sign-in page served by Studio. The page names the agent and
where its access goes, and shows a six-digit code. The page has nothing to
press: only the Studio window can let the agent in.

In Studio, a card appears in the Remote popover and in **Settings → Remote**
(and a notification, if no Studio window is focused):
**"<agent> wants access to this Studio"**. Check two things on it:

- **Sign-in page opened on**: the machine whose browser opened the page.
- **Access goes to**: `localhost` or `127.0.0.1` means an agent on that same
  machine gets the access. Any other host name means a web service gets it,
  and so does whoever runs that service.

A sign-in has to be opened by the agent itself, either in a browser it opens
or from a link it prints. Studio refuses a sign-in started from a link on
another website. Only approve a sign-in you just started. Type the code from the sign-in page,
choose what the agent may do, and choose **Allow**. The card opens on **Read
only**: the agent can read workspaces, the backlog and conversations but cannot
change anything. **Standard** also lets it operate them. An agent is never
given more than it asked for. Three wrong codes decline the request. Declining
sends an agent on your machine an `access_denied` answer. A sign-in that
returns to a web service is told no on the sign-in page instead: until you
allow it, Studio sends the browser nowhere off the machine.

Once you allow it, the sign-in page sends your browser back to the agent and
the agent finishes on its own. `claude mcp list` or `codex mcp list` then shows
the server as connected.

## What a signed-in agent can do

A signed-in agent works like a paired device with the same permissions, on
the MCP endpoint only:

- It sees and calls only the tools its permissions allow.
- The tools that configure who may reach this machine, start terminals, or act
  for an agent running on this machine stay on this machine's own socket, for
  every remote caller.
- Its sign-in only works from the machine that finished it. A copied token
  presented from another machine on the tailnet is refused.

## How long a sign-in lasts

- A sign-in lasts **30 days** from the moment you allowed it. After that the
  agent asks you to approve it again.
- Inside those 30 days the agent renews its access by itself every hour.
- If the agent's renewal credential is ever used twice, which means someone
  else has a copy, Studio ends the sign-in at once and the agent has to sign in
  again. There is no grace period. An agent that loses the answer to a renewal
  and retries with the old credential is signed out the same way.

## Revoke an agent or change what it may do

Signed-in agents are listed under **Settings → Remote → MCP clients**, with the
machine they connect from and when their sign-in ends.

- **Revoke** cuts an agent off at once. Its next request is refused, and so
  is its next renewal.
- The scope link on its row changes what it may do. The change applies to its
  next request.
- **Reset** under **Client registrations** makes every agent register again
  before its next sign-in. A registration lives in the client ID the agent
  holds, so resetting is the only way to take back ones already handed out.
  Agents that are already signed in keep working until you revoke them.

## Plain HTTP and other names

Studio answers on its tailnet address, its MagicDNS name and its short machine
name, and with HTTPS on, on `https://<machine>.<tailnet>.ts.net`. It refuses
any other host name, so a web page cannot point its own domain at this machine
and use your browser to reach it. Requests from a browser page are refused
outright.

Over plain HTTP, traffic between tailnet machines is still encrypted by
WireGuard. The limit is the OAuth clients: most will not send credentials to a
non-`localhost` address over plain HTTP. Studio still offers sign-in there for
clients that do.

HTTPS uses Tailscale Serve on port 443 of this machine. If port 443 already
serves something else, or has Tailscale Funnel on (which would put Studio on
the internet), Studio leaves it alone and says so beside the switch. Behind
Serve, Studio answers only machines on your tailnet. It refuses a request that
came in through Funnel, even if Funnel is turned on later, and one with no
tailnet machine behind it. Turning HTTPS off removes the mapping, but only
while it is still the one Studio made. A mapping left behind by a Studio that
quit without removing it is removed the next time Studio starts with HTTPS
off.

## Pairing without OAuth

Phones, other Studios and the stdio bridge
(`resources/automation/mcp-stdio-bridge.mjs pair`) keep pairing as before:
with a pairing link from **Settings → Remote**, or by asking to pair and having
the code typed here. A pairing code is used once, for
`POST /tailnet/v1/pair`, which returns a device token. It is not itself a
token: an agent that sends one as `Authorization: Bearer` is told so and how
to redeem it. Never paste a pairing code into a chat, because anyone who reads
it can pair once.

## For client authors

- Discovery: the `401` from `POST /tailnet/v1/mcp` carries
  `WWW-Authenticate: Bearer realm="sprintengine-studio-tailnet", resource_metadata="<origin>/.well-known/oauth-protected-resource/tailnet/v1/mcp"`.
  The protected resource metadata (RFC 9728) is served there and at
  `/.well-known/oauth-protected-resource`. The authorization server metadata
  (RFC 8414) is at `/.well-known/oauth-authorization-server`. Every URL in
  them uses the origin you connected to.
- Registration: dynamic client registration (RFC 7591) at
  `/tailnet/v1/oauth/register`. Clients are public (`token_endpoint_auth_method`
  `none`). Redirect URIs must be `http` on `localhost`, `127.0.0.1` or `[::1]`,
  where any port matches (RFC 8252), or `https` with an exact match. At most
  five are allowed. The client ID carries the registration itself, signed by
  Studio, so registering stores nothing.
- Authorization: authorization code with PKCE, `S256` only and required.
  `state` is passed back, and `iss` is included (RFC 9207). Errors are sent
  back by redirect to a loopback redirect URI. For an https redirect URI they
  are shown on the page until the sign-in has been approved. `resource`
  (RFC 8707) must name this Studio's MCP endpoint or its origin.
- Tokens: access tokens last an hour. Refresh tokens rotate on every use, and
  a reused one revokes the grant. A refresh must name its `client_id`. Revocation (RFC 7009) is at
  `/tailnet/v1/oauth/revoke`. The scopes are Studio's own: `workspace:read`,
  `workspace:operate`, `backlog:read`, `backlog:operate`, `conversation:read`,
  `conversation:operate`. An access token is accepted on the MCP endpoint
  only.
- Transport: Streamable HTTP. Each JSON-RPC message is one POST, answered with
  `application/json`. A notification gets `202` with no body. `GET` and
  `DELETE` get `405`. An `Mcp-Session-Id` is issued on `initialize` for
  clients of protocol revisions that keep sessions, and an unknown one gets
  `404`. An unsupported `MCP-Protocol-Version` header gets `400`, and so does an
  `Mcp-Method` or `Mcp-Name` header that does not match the body (`-32020`).
