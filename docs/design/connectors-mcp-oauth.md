# Connections: daemon-owned OAuth for remote MCP servers

**Design only; no runtime change. Read-only until the [connections](connectors.md) approval gate exists.** This adds the "Tools via remote MCP" item from
[connections](connectors.md). The daemon signs in to a remote MCP server once and
holds that server's tokens. Then it gives sessions the server's tools, never the
tokens. After that, adding Jira, Slack or Basecamp is mostly configuration:
a URL, a scope set and, where the vendor requires it, a client ID.

## Where we are

- Remote MCP servers are rows in `app_mcp_servers` with a URL and static
  `headers` ([repository][repo]). Sessions get them as `{type: 'http', url, headers}`
  from [query options][qob] (`appMcpServerToSdkConfig`). The same conversion in the
  [lifecycle manager][lifecycle] has no production caller today.
- So OAuth servers only work with a pasted bearer token. That token is stored in
  the registry, appears in settings reads and session config, and stops working
  when it expires, because nothing refreshes it.
- The Google connection already has what we need: a namespaced [vault][vault] over
  `CredentialStore`, single-flight [refresh][access], and a loopback PKCE
  [login][login]. The daemon already depends on `@modelcontextprotocol/sdk`
  1.30.0. Its client `auth()` does protected-resource and authorization-server
  discovery, dynamic registration (DCR), client ID metadata documents (CIMD),
  PKCE S256, RFC 8707 `resource`, and refresh, all through an
  `OAuthClientProvider` interface.

## Design

1. **Mark a server as OAuth.** An `http` row gets one nullable `auth` JSON
   column: `{kind: 'oauth', preset, clientId?}`. No new table. The preset (code,
   not data) fixes the URL and the scope set. A client secret
   (Slack needs one) goes to the vault, never into this column. Static
   `headers` stay for the servers that use them and are ignored on OAuth rows.
2. **Store grants in the existing vault.** `ConnectionVault` gains an MCP address
   of `daemon id / mcp / server id`. The bundle holds the tokens, the registered
   client info, and the resource it is bound to. Widen `connectionStatus.provider`
   from `'google'` to `'google' | 'mcp'`; an MCP grant has no email.
3. **Sign in with the SDK, not our own OAuth code.** A vault-backed
   `OAuthClientProvider` gives the SDK `auth()` the stored tokens and client info,
   and saves what it returns. Redirects use the same loopback listener as the
   Google login (`127.0.0.1`, random port, one-use state, timeout). Registration
   prefers pre-registered `clientId`, then CIMD, then DCR. Connect is a
   human-only operation that returns the authorize URL; a session never starts it.
   **The preset's scope set is a hard maximum.** By itself the SDK widens it: with
   no explicit scope it requests the server's whole `scopes_supported`, and the
   transport retries a 403 `insufficient_scope` with the scope from the
   challenge. So the daemon always passes the preset scope to `auth()` and as
   `clientMetadata.scope`. The provider's `redirectToAuthorization` acts only
   inside a human connect or reconnect attempt, and only for a URL whose `scope`
   is within the maximum. Anywhere else it throws: a tool call, a refresh, or a
   401/403 retry. It never opens consent. A token response that grants scopes
   beyond the maximum is discarded, not stored.
   **Normalize the token response before the SDK parses it.** The SDK parses
   token responses with its own schema before `saveTokens`, and that drops
   unknown fields. Slack's `oauth.v2.user.access` puts the granted scopes in
   `authed_user.scope`, comma-separated, and reports errors as `{ok: false,
   error}`. So the `fetchFn` the daemon passes to `auth()` normalizes each
   preset's token-endpoint reply. The Slack preset turns `ok: false` into an
   OAuth error body, moves `authed_user.scope` to a space-separated top-level
   `scope`, and sets `token_type: Bearer`. Other presets pass through. A
   response with no `scope` means the requested scope (RFC 6749). The
   over-broad check runs on the normalized scope.
4. **Inject outside registry headers.** For an OAuth row the daemon itself is the
   MCP client: SDK `Client` plus `StreamableHTTPClientTransport` with the
   provider above. Sessions get an in-process SDK server (`createSdkMcpServer`,
   the way the [operations MCP][ops] is attached, merged with
   `mergeRuntimeMcpServers`) that lists the remote tools and forwards calls. The
   token never reaches session config, the harness, prompts or logs, and a
   refresh in the middle of a long session just works.
5. **Health and refresh.** Refresh goes through the SDK provider, serialized per
   server like the Google `token-access` flight. On `invalid_grant` the provider
   clears the tokens and the server shows **Reconnect needed**; its tools drop
   out of new sessions. Server health is derived from the vault bundle, so we
   record no second copy.
   **Disconnect is fenced, as for Google** ([lifecycle][google-lifecycle]). It
   aborts the pending login, refresh and in-flight calls first. Then it runs on
   the same per-server lock as every token save, bumps the server's generation,
   and erases the bundle. A save carrying an older generation is dropped, so a
   late refresh or login callback cannot bring tokens back. Existing proxies
   check the generation on each call, refuse after disconnect without contacting
   the server, and close their client.
6. **Read-only until the approval gate exists.** [Connections](connectors.md)
   requires one human approval per external mutation, and remote MCP must use the
   same gate. That gate (phase 2) is not built. So this design is read-only: only
   presets with a read and search scope set can connect, and no setting widens
   them. Custom OAuth servers wait for the gate, because we cannot tell their
   scopes apart. Write tools may still be listed, but the vendor's server refuses
   them for lack of scope; tool hints are never trusted. Adding write scopes is
   part of the phase-2 work, not this design.
7. **Bound and redact at the daemon boundary.** The SDK reads OAuth and MCP
   bodies whole (`response.json()`, `text()`, SSE parsing). So the daemon passes
   one bounded fetch, as `fetchFn` to `auth()` and as `fetch` to the transport.
   It caps each response body and each SSE event in bytes and fails with
   `response_too_large`; nothing is buffered past the cap. The proxy caps the
   tool catalog (tool count and description and schema bytes, refusing a list
   over the cap) and each tool result (items and bytes, truncated with an
   explicit marker), as [connections](connectors.md) requires for every tool.
   Before a result reaches a session, the proxy replaces the grant's access
   token, refresh token and client secret with `[redacted]`, as
   [Google HTTP][google-http] does. Errors from the SDK, OAuth bodies and the
   upstream server are never forwarded or logged as text. Sessions, status RPCs
   and logs get only a reason code (`unauthorized`, `reconnect_needed`,
   `rate_limited`, `response_too_large`, `request_failed`). Status RPCs return
   health and granted scopes only. Tool names, descriptions and results are
   untrusted content, never instructions or approval.

Not in this design: DPoP, token exchange, device flow, a hosted relay, and
importing tokens from other clients' caches.

## Vendors (checked 2026-11-16)

Each server was probed without credentials: an unauthenticated `POST` for the
`WWW-Authenticate` challenge, then its protected-resource and
authorization-server metadata. No vendor account was used, so no sign-in or tool
call was attempted.

| | Jira (Atlassian) | Slack | Basecamp |
| --- | --- | --- | --- |
| Server | `https://mcp.atlassian.com/v2/mcp`, official ([docs][atl]) | `https://mcp.slack.com/mcp`, official ([docs][slack]) | `https://mcp.basecamp.com/mcp`, served from the vendor's own domain |
| Resource metadata | `/.well-known/oauth-protected-resource/v2/mcp` | root `/.well-known/oauth-protected-resource` (the path form returns 404) | `/.well-known/oauth-protected-resource/mcp` |
| Registration | DCR endpoint and `client_id_metadata_document_supported: true` | No DCR (per docs). Needs our own Slack app's ID and secret, `client_secret_post`. Only directory-published or internal apps may use MCP | DCR endpoint and `client_id_metadata_document_supported: true` |
| PKCE | S256 | S256 | S256 |
| Read-only scopes | `read:jira:agent-interface`, `search:jira:agent-interface` (+ `offline_access`) | `search:read.*`, `channels:history`, `users:read` and other `*:read` | `read` (also `mcp`, `full`) |
| Notes | v1 and v2 endpoints coexist | User token; workspace admins may need to approve the app | Advertises DPoP (ES256); the 401 asks for `scope="mcp full"` |

**Basecamp.** It has an official remote MCP; no adapter is needed if it works
with our client. The evidence is that the host is on basecamp.com, answers the
MCP challenge and publishes the vendor's own OAuth server. I found no 37signals
documentation page for it. Community servers exist, but they run locally with a
pasted Launchpad app, so we do not need them.

**Not verified:**

- Atlassian may restrict DCR or CIMD to known clients. Community reports disagree.
- Whether Slack accepts a loopback redirect URI for our app, and whether a desktop
  app can ship its client secret under Slack's rules. If not, Slack waits for a
  hosted redirect, which is out of scope here.
- Whether Basecamp requires DPoP. The SDK client does not support it. If it is
  required, Basecamp needs DPoP support in the provider, not a separate adapter.
- Basecamp's scope meanings, its tool list, and whether `read` alone is accepted.
- Every vendor's real consent screen, token lifetimes and tool behavior.

The first real sign-in per vendor is a human step and closes these questions.

## Slices

Each slice is about 100–200 production lines, with tests in the same PR. All of
them test against one **fake MCP OAuth server**: a test-only Bun server that
publishes protected-resource and authorization-server metadata, has a DCR
endpoint and a CIMD flag, auto-approves `/authorize`, checks PKCE, rotates
refresh tokens, can return `invalid_grant`, and serves an `/mcp` endpoint that
rejects a missing or expired bearer. It has one read tool and one write tool. The
write tool needs a write scope and counts every mutation it applies. It records
every authorize request's scope, can advertise every scope in its metadata, can
answer with a 403 `insufficient_scope` challenge naming a write scope, and can
delay any token response. It can also return oversized bodies, SSE events,
catalogs and results, and echo the caller's bearer in a result or an error.
Switches cover the vendor shapes above: no DCR plus a required client secret
and Slack's token reply (`ok`, comma-separated `authed_user.scope`,
`ok: false` errors), and root versus path metadata.

| Order | Slice | Proof against the fake server |
| --- | --- | --- |
| 1 | Fake server fixture; vault MCP address; vault-backed `OAuthClientProvider` with the scope maximum | `auth()` completes discovery, DCR and PKCE; the bundle is in the vault, survives a restart, and is absent from DB rows and registry reads. Wrong state and replay are refused. With all scopes advertised, the authorize request carries only the maximum. A grant wider than the maximum is not stored, including a Slack-shaped reply whose over-broad scopes are only in `authed_user.scope`. A Slack `ok: false` reply fails as a login error. Oversized metadata or token bodies fail with `response_too_large`. |
| 2 | `auth` column, preset table (test preset only), human-only connect, reconnect and disconnect | RPC connect reaches a healthy state. The Slack shape works with a pre-registered client and secret. A login callback or refresh response delayed until after disconnect leaves the vault empty and health disconnected. |
| 3 | Daemon-held client and in-process tool proxy, wired in query options for OAuth rows | A real session lists and calls the fake read tool. Session config has no `Authorization`. An expired token refreshes once under concurrent calls. `invalid_grant` gives Reconnect needed and removes the tools. A write tool call ends with zero mutations on the fake. A write-scope challenge during a call records no new authorize request. A call after disconnect is refused with no request reaching the fake. An oversized catalog is refused, an oversized result arrives truncated with the marker, and an oversized response or SSE event fails with `response_too_large`. A bearer echoed in a result or an error reaches the session and logs only as `[redacted]` or a reason code. |
| 4 | Connect, reconnect and health on the MCP server row in Settings | An isolated browser clicks Connect through the fake consent, and the state stays after reload, with screenshots. |
| 5 | Jira, Slack and Basecamp presets (URL, read scopes, client needs) | Each preset produces the expected authorize URL and read-only scopes against the fake server. The real sign-in per vendor is the human step above. |

Proof follows the [verify skill](../../.claude/skills/verify/SKILL.md):
`NODE_ENV=test`, a fresh data dir and DB, the fake server on loopback, and no real
vendor credentials.

[repo]: ../../packages/daemon/src/storage/repositories/app-mcp-server-repository.ts
[qob]: ../../packages/daemon/src/lib/agent/query-options-builder.ts
[lifecycle]: ../../packages/daemon/src/lib/mcp/app-mcp-lifecycle-manager.ts
[vault]: ../../packages/daemon/src/lib/connections/vault.ts
[access]: ../../packages/daemon/src/lib/connections/token-access.ts
[google-http]: ../../packages/daemon/src/lib/connections/google-http.ts
[google-lifecycle]: ../../packages/daemon/src/lib/connections/lifecycle.ts
[login]: ../../packages/daemon/src/lib/connections/google-login.ts
[ops]: ../../packages/daemon/src/lib/operations/mcp-server.ts
[atl]: https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/
[slack]: https://docs.slack.dev/ai/slack-mcp-server/
