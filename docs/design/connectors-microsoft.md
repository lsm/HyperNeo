# Microsoft connection: read-only Outlook mail and calendar

**Design only; the human signs before merge.** This adds one Microsoft Graph
connection on the [connections base](connectors.md). Phase 1 gives agents
Outlook mail search, read and drafts, and read-only calendar. The human sends
drafts from Outlook. Teams chat read is the one named later step. Sends, event
writes, OneDrive and Teams channels wait for the base's phase-2 approval gate
and their own designs.

## What is reused

Nothing new is built where the Google connection already has it:

- **Vault.** `ConnectionVault` already keys bundles by daemon identity,
  provider, connection and account, on the shared `CredentialStore` (Keychain,
  then the encrypted file fallback). Microsoft bundles use the same `connectionTokens` shape with `provider: 'microsoft'`.
- **Connection rows.** The existing connections table and its `connections.read`
  and `connections.write` repository ops already store one status JSON per
  connection, unique by account ID. Microsoft account IDs (`tid.oid`, below)
  cannot collide with Google `sub` values. The table keeps its name.
- **Token access and refresh loop.** `createGoogleTokenAccess` already gives one
  single-flight refresh per connection, 2-minute early refresh, 60-second
  backoff, and `reconnect_needed` on a 4xx refresh. Only the refresh request
  differs per provider.
- **Bounded HTTP.** The Google HTTP client's scope check, 401/429 mapping,
  64 KiB response cap, token redaction and per-connection abort are provider-neutral.
- **Operations and MCP.** New operations register in the same catalog entry and
  reach every harness through the operations MCP. Management operations stay
  `human_only` for the local user.
- **Settings > Connections.** The same panel gets a Connect Microsoft button and
  lists both providers' rows with the same health, Reconnect and Disconnect.

The first slice makes these seams take a provider instead of assuming Google.
`status.ts` hard-codes `provider: z.literal('google')`, and the accounts
listing and refresh loop read every row as Google. Token access checks only a
connection's health, not its provider, so a Google operation given a Microsoft
connection ID would try a Google refresh and mark that connection Reconnect
needed. Management has the same gap: reconnect reads the vault for any
connection ID, and disconnect cancels refresh and erases the bundle of
whatever row it is given. Each provider's token access, connect (reconnect)
and disconnect must refuse another provider's connection
(`unknown_connection`) before any cancel, vault read or write, or status change.

## Sign-in

Same flow as Google: system browser, a one-use loopback listener with an
ephemeral port, authorization code with PKCE S256, random state and nonce,
five-minute timeout, code exchange only in the daemon.

- Authority: `https://login.microsoftonline.com/common/oauth2/v2.0/` so both
  work/school and personal accounts can sign in.
- Public client: the human's own app registration's client ID, no client secret.
- Redirect: `http://localhost:<port>/oauth/microsoft/callback`, registered once
  as `http://localhost/oauth/microsoft/callback`. Entra ignores the port only
  for `localhost` redirects; other loopback URIs must match the port exactly
  ([redirect rules][reply-url]). The listener binds `127.0.0.1`, as Google's
  does, and checks the callback's `Host` is `localhost:<port>`.
- `prompt=select_account`, so Reconnect lets the human pick the same account.
- ID token: verify RS256 against the tenant-independent key set
  (`/common/discovery/v2.0/keys`); audience is the client ID and nonce matches.
  `tid` must be a GUID and `iss` must equal
  `https://login.microsoftonline.com/{tid}/v2.0` for that exact `tid`. The
  selected key's own `issuer` field, with `{tenantid}` replaced by `tid`, must
  equal `iss` too; a key restricted to another tenant is refused
  ([signing key issuer][key-issuer]).
- Account key: `tid` + `oid`, never email. The same person in two tenants is two
  accounts ([claims][claims]). Reconnect must return the same key, as with Google.
- Display: `email` claim, else `preferred_username`. If neither is an email
  address the attempt fails with `account_unsupported`.

Management operations mirror Google's: `connections.microsoft.connect`,
`connections.microsoft.login` and `connections.microsoft.disconnect`.
Disconnect erases only this instance's bundle; it does not revoke the grant in
the account.

## Scopes

Request `openid profile email offline_access Mail.ReadWrite Calendars.Read`.

- `offline_access` returns the refresh token; `profile` is needed for `oid`.
- `Mail.ReadWrite` is the narrowest scope that creates drafts
  ([create message][post-messages]). It also allows move and delete; the
  operation catalog exposes neither.
- No `Mail.Send`. Unlike Google's `gmail.compose`, the token itself cannot send.
- `Calendars.Read` only; no event writes.
- No `User.Read`: the ID token already names the account.

All six are user-consentable for personal and work accounts. A tenant whose
admin blocks user consent shows Microsoft's admin-approval page; HyperNeo
reports `login_failed` and does nothing else.

## Tokens and refresh

The bundle is the existing `connectionTokens`: access token, refresh token,
expiry, granted scopes and client ID. Refresh posts `grant_type=refresh_token`
to the token endpoint of the account's own tenant (`/{tid}/oauth2/v2.0/token`).

Microsoft returns a new refresh token on every refresh and the old one keeps
working until it expires ([refresh tokens][refresh]). The existing rule
already fits: store the new access token, refresh token, expiry and scopes in
one vault write before reporting healthy. Refresh tokens last 90 days for
this client type; an expired or revoked one returns `invalid_grant` (400),
which the existing 4xx rule turns into **Reconnect needed**.

## Phase-1 operations

| Operation | Graph call | Behavior |
| --- | --- | --- |
| `microsoft.accounts` | none | This instance's Microsoft connections, scopes and health; no credentials. |
| `outlook.search` | `GET /me/messages?$search=` | At most 10 results per page: ID, conversation ID, from, to, subject, received time, preview. Opaque cursor (see below). |
| `outlook.read_thread` | `GET /me/messages?$filter=conversationId eq` | Headers and previews by default; text bodies only when asked (see below). |
| `outlook.draft` | `POST /me/messages`, `PATCH /me/messages/{id}` | Create or update a draft in Drafts; returns its ID. Updating anything but a draft is refused. |
| `outlook.calendar_list` | `GET /me/calendars`, `GET /me/calendarView` | Calendars, or events in a bounded window. Keep each event's own time zone and `isAllDay`. |

Each call names a connection, checks the caller is an eligible agent session,
checks the connection is Microsoft and healthy, and checks the granted scope,
the same order the Google operations use plus the provider check from slice 1.
Bodies are untrusted content. Graph 429
returns `rate_limited`; the agent retries later, the daemon does not loop.
There is no send, move, delete or raw Graph proxy operation.

Bodies: the reused JSON reader refuses any response over 64 KiB, so one large
message would fail the whole read. Every list call (search, thread listing,
calendar view) uses `$select` for the fields in the table above and never
selects `body`, which Graph otherwise returns by default. When bodies are asked for, each message's
text body (`Prefer: outlook.body-content-type="text"`) is fetched on its own
with the same 64 KiB cap; a message over the cap returns its preview with
`truncated: true` instead of failing the thread.

Cursors never carry a URL the daemon fetches. Graph returns `@odata.nextLink`
as a full URL, and the bounded HTTP client sends the bearer token to whatever
URL it is given, so:

- The daemon accepts a `nextLink` only if its origin is
  `https://graph.microsoft.com`, its path is the exact `/v1.0/...` collection
  the operation just called, and keeps only its query string.
- The cursor holds that query string plus the connection ID, operation name
  and a hash of the original query. A call whose connection, operation or
  query differs from the cursor's is refused before any request.
- The next request is rebuilt from the fixed origin and the operation's own
  collection path; a cursor cannot choose the host, path or authority.
  Redirects stay refused (`redirect: 'error'`, as today).
  A cursor that passes can only page the caller's own collection.

## Later step: Teams chat read

Add `Chat.Read` by an explicit Reconnect, then `teams.list_chats` and
`teams.read_chat` (`GET /me/chats`, `GET /chats/{id}/messages`). Graph supports
these for work/school accounts only, not personal accounts
([chat messages][chat-messages]); the operations report `unsupported_account`
for a personal connection. Channel messages need admin-consented scopes and are
out of scope.

## Human-only Entra app registration

Give the human this list before the first real-account check. No agent creates
or changes cloud resources; fake-Graph proofs do not need a real registration.

1. In the Microsoft Entra admin center, create an app registration with
   supported account types **Accounts in any organizational directory and
   personal Microsoft accounts**.
2. Add the **Mobile and desktop applications** platform with the one redirect
   `http://localhost/oauth/microsoft/callback`, with no port.
3. Create no client secret or certificate.
4. Under API permissions, add delegated Microsoft Graph `openid`, `profile`,
   `email`, `offline_access`, `Mail.ReadWrite` and `Calendars.Read`. Add nothing else.
5. Set publisher domain and, for sign-in by other organizations, complete
   publisher verification; unverified multi-tenant apps are often blocked from
   user consent in work tenants.
6. Paste the Application (client) ID into Settings > Connections > Connect
   Microsoft, sign in with one real account, and run search, read, draft and
   calendar list once.

## Tests with a fake Graph

Copy the fake-Google pattern: a local server for `/authorize`, `/token`, the
key set and Graph paths, a synthetic RSA key, synthetic codes and tokens, and a
`fetchImpl` that refuses any origin except the fake's. Inject it only into the
test daemon (`NODE_ENV=test`, fresh home, data dir and DB, no provider keys).

The fake must prove:

- the authorize request has PKCE S256, the six scopes and a
  `http://localhost:<port>/oauth/microsoft/callback` redirect, and a callback
  with any other host is refused;
- a wrong state, replayed code, wrong nonce, wrong issuer `tid`, non-GUID `tid`
  or wrong audience is refused;
- a token whose `iss` matches its `tid` but is signed by a key whose `issuer`
  names another tenant is refused;
- forged, foreign-origin, wrong-collection and other-connection cursors are
  refused, and the fake records no request for them;
- reconnect with a different `tid`/`oid` fails `account_mismatch`;
- every refresh rotates the refresh token and the newest one survives a restart;
  `invalid_grant` shows Reconnect needed with no retry loop;
- search, thread read and calendar pages are bounded and redacted, and all-day
  and time-zoned events round-trip;
- a thread holding one 80 KiB message returns the other bodies and that
  message's preview marked truncated;
- drafts create and update, and the fake records zero send, move or delete
  requests;
- Google and Microsoft connections on one daemon never use each other's tokens:
  a Google operation given a Microsoft connection ID (and the reverse) returns
  `unknown_connection`, sends no token or refresh request, and leaves that
  connection healthy; `connections.google.connect` or `.disconnect` with a
  Microsoft ID (and the reverse) returns `unknown_connection` and leaves its
  row, bundle and refresh untouched.

Each slice adds unit tests next to the Google ones and extends the verify
skill with a Microsoft script beside the Google ones.

## Slices

| Slice | Change | Proof |
| --- | --- | --- |
| 1. Provider-neutral base | Widen `provider` to `google` or `microsoft`; Google accounts listing and refresh loop skip Microsoft rows; Google token access, connect and disconnect refuse a non-Google connection. No Microsoft code yet. | Existing Google tests unchanged; a Microsoft row is ignored by Google reads and refresh; `gmail.search`, `connections.google.connect` and `connections.google.disconnect` with its ID return `unknown_connection` and the row, bundle and health are unchanged. |
| 2. Microsoft sign-in | Login, code exchange, ID-token checks, connect/login/disconnect operations. | Fake Graph sign-in, refusal cases, account mismatch, disconnect erases the bundle. |
| 3. Microsoft refresh | Microsoft refresh request behind the existing token access. | Rotation, restart, `invalid_grant`, single flight on a fake clock. |
| 4. Settings button | Connect Microsoft in the Connections panel. | Isolated browser connects through the fake, with screenshots. |
| 5. Mail search and read | `microsoft.accounts`, `outlook.search`, `outlook.read_thread`. | Bounds, cursors, redaction through the real operations MCP. |
| 6. Drafts | `outlook.draft`. | Create, update, non-draft refused, zero sends. |
| 7. Calendar | `outlook.calendar_list`. | Windows, time zones, all-day, zero writes; full Microsoft verify journey. |

Teams chat read is a later issue after slice 7 and one real-account check.

[reply-url]: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url
[claims]: https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
[key-issuer]: https://learn.microsoft.com/en-us/entra/identity-platform/access-tokens#validate-the-signing-key-issuer
[refresh]: https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
[post-messages]: https://learn.microsoft.com/en-us/graph/api/user-post-messages
[chat-messages]: https://learn.microsoft.com/en-us/graph/api/chat-list-messages
