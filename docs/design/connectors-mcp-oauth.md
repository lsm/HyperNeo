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
  1.32.2. Its client `auth()` does protected-resource and authorization-server
  discovery, dynamic registration (DCR), client ID metadata documents (CIMD),
  PKCE S256, RFC 8707 `resource`, and refresh, all through an
  `OAuthClientProvider` interface.

## Design

1. **Mark a server as OAuth.** An `http` row gets one nullable `auth` JSON
   column: `{kind: 'oauth', preset, clientId?, generation, active}`. No new
   table. The repository refuses `auth` on any other `sourceType`. The preset
   (code, not data) fixes the URL, the scope set, the expected
   authorization-server issuer and its exact HTTPS authorization endpoint. `generation` and `active` are the durable
   admission state (item 5). A client secret
   (Slack needs one) goes to the vault, never into this column. Static
   `headers` stay for the servers that use them and are ignored on OAuth rows.
2. **Store grants in the existing vault.** `ConnectionVault` gains a second
   address method for MCP grants, beside the Google one. That method does not
   parse `connectionStatus`, which requires a Google account ID and email.
   Service: `hyperneo.connection.<daemon id>.mcp.<server row id>`, both parts
   URI-encoded. Account slot: `["<server row id>","main"]`. The registry row ID
   is the account ID: one grant per server per instance. MCP has no standard
   user-identity call, so we key no remote identity, and reconnect replaces that
   server's grant. The bundle holds the tokens, the granted scopes, the
   registered client info, the generation it was saved under, and its binding:
   the resource, the issuer, and that issuer's metadata (token endpoint
   included), all fixed at connect. `connectionStatus` and the Google table stay
   unchanged.
3. **Sign in with the SDK, not our own OAuth code.** A vault-backed
   `OAuthClientProvider` gives the SDK `auth()` the stored tokens and client info,
   and saves what it returns. Redirects use the same loopback listener as the
   Google login (`127.0.0.1`, random port, one-use state, timeout). Registration
   prefers pre-registered `clientId`, then CIMD, then DCR. Connect is a
   human-only operation that returns the authorize URL; a session never starts it.
   **Credentials are bound to one issuer.** Without cached discovery state, the
   SDK follows any `resource_metadata` a 401 names. It withholds stored
   credentials from that server only if they carry the `issuer` stamp it adds on
   save. Without the stamp it sends the refresh token and client secret to that
   server's token endpoint before `redirectToAuthorization` is reached. So connect refuses an issuer other than
   the preset's and stores the binding in the bundle. Outside a connect attempt,
   the provider's `discoveryState()` returns that stored binding, so the SDK
   skips discovery. `saveDiscoveryState` throws on a different issuer, also
   when the authorization-server metadata's own `issuer` differs from the
   preset's, since the SDK stamps credentials with the discovery URL and never
   checks `metadata.issuer`. The provider returns no tokens or client info for a bundle whose binding no
   longer matches. The bounded fetch (item 7) is the last check: it refuses any
   request carrying a code, verifier, refresh token or client secret unless it
   goes to the bound token endpoint. It also refuses any request carrying the
   bearer unless it goes to the preset's URL.
   **Every request goes to a pinned origin.** During discovery the SDK fetches
   the server a metadata document names before `saveDiscoveryState` can refuse
   it, and a 401's `resource_metadata` URL when the binding holds no resource
   metadata. So the preset also fixes the allowed HTTPS origins: its own URL,
   the issuer, and the token and registration endpoints. The bounded fetch
   refuses any other origin before connecting. It never follows a redirect itself, so each hop
   is checked too. No IP filter is needed: the hostnames are the vendor's and are
   fixed in code, so a DNS answer pointing at an internal host fails TLS before
   any HTTP request is sent. Only the test preset pins a loopback origin.
   **Connect and reconnect run on attempt-only state.** If a refresh token is
   stored, the SDK refreshes and returns `AUTHORIZED` without ever opening
   consent. So each human attempt gets its own provider. Its `tokens()` returns
   nothing, and it keeps the client info, verifier and returned tokens in
   memory. The current grant stays in the vault and in use until the attempt
   succeeds and commits as described in item 5. A failed or cancelled attempt
   changes nothing.
   **The preset's scope set is a hard maximum.** By itself the SDK widens it: with
   no explicit scope it requests the server's whole `scopes_supported`, and the
   transport retries a 403 `insufficient_scope` with the scope from the
   challenge. So the daemon always passes the preset scope to `auth()` and as
   `clientMetadata.scope`. The provider's `redirectToAuthorization` acts only
   inside a human connect or reconnect attempt, and only for a URL whose `scope`
   is within the maximum. The browser is not behind the bounded fetch, so before
   it returns the URL it also checks that the attempt's discovered issuer is the
   preset's and that the URL's origin and path are exactly the preset's
   authorization endpoint; otherwise Connect returns no URL. Anywhere else it throws: a tool call, a refresh, or a
   401/403 retry. It never opens consent. A token response that grants scopes
   beyond the maximum is discarded, not stored.
   **Normalize the token response before the SDK parses it.** The SDK parses
   token responses with its own schema before `saveTokens`, and that drops
   unknown fields. Slack's `oauth.v2.user.access` puts the granted scopes in
   `authed_user.scope`, comma-separated, and reports errors as `{ok: false,
   error}`. So the `fetchFn` the daemon passes to `auth()` normalizes each
   preset's token-endpoint reply. The SDK raises an error only on a non-2xx
   status. So the Slack preset turns `ok: false` into a non-2xx OAuth error:
   - `invalid_refresh_token`, `token_revoked`, `token_expired`,
     `account_inactive` and `invalid_code` become 400 `invalid_grant`, which
     ends the grant.
   - `bad_client_secret` and `invalid_client_id` become 401 `invalid_client`.
   - `ratelimited`, `internal_error`, `fatal_error`, `service_unavailable` and
     `request_timeout` become 503 `temporarily_unavailable`, which backs off and
     keeps the grant.
   - Any other code becomes 400 `invalid_request`.

   On success it moves `authed_user.scope` to a space-separated top-level
   `scope` and sets `token_type: Bearer`. Other presets pass through. When a
   reply has no `scope` (RFC 6749), a code exchange means the requested scope
   and a refresh keeps the prior grant's scopes. The over-broad check runs on
   the result.
   **A failed refresh is classified from the token reply, not the SDK's error.**
   On a network error, a `ServerError` or a reply it cannot parse, the SDK drops
   the failure and starts authorization, so only the redirect hook's throw
   surfaces. So the token fetch records each refresh's outcome before it
   normalizes the reply, and the refresh flight reads that record. A network
   failure, 408, 429, 5xx, over-cap or unparsable reply, or a Slack code mapped
   to 503 above, is transient. It keeps the grant, opens no consent, backs off
   one minute like the Google `token-access` flight, and reports `rate_limited`,
   `response_too_large` or `request_failed` (item 7).
4. **Inject outside registry headers.** For an OAuth row the daemon itself is the
   MCP client: SDK `Client` plus `StreamableHTTPClientTransport` with the
   provider above. Sessions get an in-process SDK server (`createSdkMcpServer`,
   like the [operations MCP][ops]) that lists the remote tools and forwards
   calls. It enters the session at the existing conversion:
   `appMcpServerToSdkConfig` in [query options][qob] returns this SDK config for
   an OAuth row instead of `{type: 'http', headers}`. All three registry paths
   (canonical inputs, MCP skills and plain registry rows) use that function.
   So the proxy flows through `mergeSessionMcpServers` as a registry server,
   with the usual enablement, layering and reserved-name handling. Connect,
   disconnect, remove and replace emit the existing `mcp.registry.changed` event, the
   same one the registry RPCs emit. The session manager already turns that event
   into `reconcileEffectiveMcpServers`, which recomputes the effective set and
   pushes it to every running query with `setMcpServers`. So running sessions
   gain or lose the proxy without a restart, and a call already in flight on an
   old proxy is fenced as described below. The Agent SDK keeps the instance it
   already has when a name stays registered, so a reconnect cannot swap the
   proxy. The proxy therefore holds no grant and no generation: on each call it
   asks the daemon-held client for the row's current admitted generation and uses
   it. That client is one per row, shared by every session and kept across
   reconciles, not one per session. After a reconnect the same proxy calls under the new generation, and a
   result that arrives for a call begun under a retired generation is dropped
   with `reconnect_needed`. The
   token never reaches session config, the harness, prompts or logs, and a
   refresh in the middle of a long session just works.
5. **Health and refresh.** Refresh goes through the SDK provider, serialized per
   server like the Google `token-access` flight. On `invalid_grant` the provider,
   under the same per-server lock as every token save, first persists a new
   `auth.generation` with the row still active, and only then erases the tokens.
   No bundle carries the new generation, so the server shows **Reconnect
   needed** even if the erase fails or leaves a fallback copy, and a restart
   cannot admit the rejected bundle; its tools drop out of new sessions. **Admission is durable.** The provider serves tokens
   only when the row's `auth.active` is true and the bundle's generation equals
   `auth.generation`. Health comes from the row and the bundle together:
   inactive means disconnected, a matching bundle means healthy, anything else
   means Reconnect needed. A connect commits, under the per-server lock, by
   writing the new bundle under the next generation, then setting the row active
   at that generation. A stop between the two writes leaves a bundle that is
   never admitted. The vault holds one bundle per server, so on a reconnect
   that stop also loses the old grant: the server shows Reconnect needed.
   **Disconnect is fenced, as for Google** ([lifecycle][google-lifecycle]). It
   aborts the pending login, refresh and in-flight calls first. Then, on the
   same per-server lock as every token save, it persists the tombstone: row
   inactive, generation bumped. Only then does it erase the bundle. If the erase
   fails or the daemon stops, the old bundle stays unadmitted after restart, and
   the next connect overwrites it. A save carrying an older generation is
   dropped, so a
   late refresh or login callback cannot bring tokens back. Existing proxies
   find no admitted generation on the next call and refuse it without contacting
   the server; the daemon closes the row's client.
   **Removing or replacing an OAuth row goes through Disconnect first.** The
   vault bundle is keyed by row ID, so a row deleted without teardown would
   orphan it. One human-only remove operation does the Disconnect steps above,
   erases the bundle, and only then deletes the row. If the daemon stops between
   the two steps, the row is left inactive without tokens and shows disconnected. The
   `mcp.registry.delete` RPC routes an OAuth row to that operation. A change to
   an OAuth row's `url`, `sourceType` or `auth`, through `mcp.registry.update`,
   also disconnects first, and a change away from `http` also clears `auth`.
   Connect and the provider refuse a row whose URL is not the preset's. The
   registry repository's plain `delete`, and any plain `update` of `url`,
   `sourceType` or `auth`, refuses a row with `auth` set. Only the remove
   and replace operations use the separate repository method that may touch
   such a row. That covers the other writers. The MCP import service creates,
   updates and deletes the rows it imports. Built-in seeding in the skills
   manager creates rows. Startup default seeding (`seedDefaultMcpEntries`)
   creates rows, and its only update sets `source`, which is outside the refused
   set. Sessions record attach outcomes (`recordAttachOutcomes`), which only sets
   `last_attach_error`. None of them ever sets `auth`. The one migration that deletes registry
   rows removes only legacy IDs that predate the column.
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
   Before a result is truncated or reaches a session, the proxy replaces the
   credentials the row actually sent with `[redacted]`, as
   [Google HTTP][google-http] does, and in object keys too. A refresh can replace
   the grant while a response is in flight, and the transport's standalone SSE
   GET, opened under an older bearer, delivers results for later calls, so the
   current grant is not enough. The bounded fetch adds every bearer, refresh
   token and client secret it sends, on any request of the row, to a set held by
   the row's client until it closes. Redaction covers that set and the current
   grant, for the catalog, the result and any error. It refuses a catalog
   that contains any of them in a tool name, description or schema, because a
   redacted name or schema could not be called. Errors from the SDK, OAuth bodies and the
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
| Issuer (pinned by preset) | `https://auth.atlassian.com/VCeDsk8ZHncYF1g234fKtc4lNipbBhu3` | `https://mcp.slack.com` | `https://app.basecamp.com` |
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

Each slice targets 100–200 production lines, with tests in the same PR. That is
not measured yet: each is measured before it starts, and a larger one is split.
All of them test against one **fake MCP OAuth server**: a test-only Bun server that
publishes protected-resource and authorization-server metadata, has a DCR
endpoint and a CIMD flag, auto-approves `/authorize`, checks PKCE, rotates
refresh tokens, can return `invalid_grant`, and serves an `/mcp` endpoint that
rejects a missing or expired bearer. It has one read tool and one write tool. The
write tool needs a write scope and counts every mutation it applies. It records
every authorize request's scope, can advertise every scope in its metadata, can
answer with a 403 `insufficient_scope` challenge naming a write scope, and can
delay any token response. It can run a second authorization server and answer a 401 whose `resource_metadata` points there. It can name an unpinned origin in its metadata or a redirect, and count requests that reach it. It can omit `scope` from a refresh reply. It can also return oversized bodies, SSE events,
catalogs and results, and echo the caller's bearer in a result, an error or a catalog entry. Its token endpoint can drop the connection, answer 429 or 5xx, or return a malformed body.
Switches cover the vendor shapes above: no DCR plus a required client secret
and Slack's token reply (`ok`, comma-separated `authed_user.scope`,
`ok: false` errors), and root versus path metadata.

| Order | Slice | Proof against the fake server |
| --- | --- | --- |
| 1 | Fake server fixture; vault MCP address; bounded, origin-pinned fetch; vault-backed `OAuthClientProvider` with the scope maximum, its binding and generation passed in | `auth()` completes discovery, DCR and PKCE; the bundle is in the vault under the MCP address, survives a restart, and is absent from DB rows and registry reads. Two servers, and two instances, cannot read each other's bundles. With all scopes advertised, the authorize request carries only the maximum. A grant wider than the maximum is not stored, including a Slack-shaped reply whose over-broad scopes are only in `authed_user.scope`. A Slack `ok: false` reply fails as a login error. A 401 that points at the second authorization server sends nothing to it: no refresh token, no client secret, no code. Metadata, a challenge or a redirect naming an unpinned origin sends no request there. Metadata with the expected issuer and an authorization endpoint on an unapproved origin gives no authorize URL. Metadata at the expected discovery URL, with the expected consent endpoint but another `issuer`, is refused and gives no URL. A refresh reply without `scope` keeps the prior scopes. Oversized metadata or token bodies fail with `response_too_large`. |
| 2 | `auth` column, preset table (test preset only), human-only connect, reconnect and disconnect | RPC connect reaches a healthy state. Wrong state and replay are refused. A Slack `invalid_refresh_token` gives Reconnect needed with no retry. After `invalid_grant` with a failing erase, a restart still shows Reconnect needed and serves no token. A dropped connection, a plain 429, a 5xx, a malformed reply and a Slack `ratelimited` each keep the grant, back off, report the item 7 reason and record no authorize request, run through the real SDK. The Slack shape works with a pre-registered client and secret. A login callback or refresh response delayed until after disconnect leaves the vault empty and health disconnected. If the vault erase fails, or the daemon restarts between the tombstone and the erase, the old bundle is never served. Reconnect on a healthy grant opens consent instead of refreshing. The old grant keeps working until the new one commits, and a cancelled reconnect leaves it unchanged. A restart between the bundle write and the row write shows Reconnect needed and admits neither grant. Changing `sourceType` away from `http` disconnects first and clears `auth`. Setting `auth` on a non-`http` row is refused. Connect on a row whose URL is not the preset's is refused, and no request reaches that URL. A stop between the erase and the row delete shows disconnected. Deleting the row through `mcp.registry.delete`, or changing its URL, while a token save is delayed leaves no bundle under that row ID. The import service cannot delete or retarget an OAuth row. |
| 3 | Daemon-held client and in-process tool proxy, wired in query options for OAuth rows | A real session lists and calls the fake read tool. A running session gains the tools on connect and loses them on disconnect without a restart. Session config has no `Authorization`. An expired token refreshes once under concurrent calls. `invalid_grant` gives Reconnect needed and removes the tools. A write tool call ends with zero mutations on the fake. A write-scope challenge during a call records no new authorize request (the SDK's one refresh before it stops is allowed). A call on an existing proxy after disconnect, row deletion or a URL change is refused with no request reaching the fake. An oversized catalog is refused, and so is one echoing the bearer in a tool name, description or schema key. An oversized result arrives truncated with the marker, with no fragment of a bearer that straddles the cut, and an oversized response or SSE event fails with `response_too_large`. A bearer echoed in a result or an error reaches the session and logs only as `[redacted]` or a reason code; so does bearer A echoed by a response delayed until a refresh has saved bearer B, and bearer A echoed on the standalone SSE stream opened under A after B is current. Reconnect while a session is running, then call the same tool in that session: it works under the new grant, and a result from a call begun under the old generation is dropped. |
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
