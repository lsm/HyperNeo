# Connections: shared base, Google first

**Proposed; docs only.** Human approval is required before implementation, which
starts after 0.49.0 ships. Order by one account unlocking several services:
Google (Gmail, Calendar, selected Drive files), Microsoft Graph, Slack, then
other tools through remote MCP + OAuth. A connection is account access, not a
model provider, skill or pack. HyperNeo owns authorization and action policy;
the model harness receives tools, never credentials.

## Step 1: account and authorization boundary

**Settings > Connections** adds Connect Google, account/email, granted scopes,
per-service health, Reconnect and Disconnect. A new instance has no connections;
never import browser, CLI, SDK or another instance's logins. Human-only management
operations start consent in the system browser; a short-lived listener binds
`127.0.0.1` on an available port. Use a Desktop OAuth client, authorization code,
PKCE S256, `access_type=offline`, random one-use state, exact callback path/redirect
and timeout. Exchange
codes only in the daemon; validate OpenID issuer, audience, nonce and expiry,
keying accounts by `sub`, not email ([Desktop OAuth][native], [identity][oidc]).
Status RPCs/events return account, scopes, feature availability and health only,
never codes, access/refresh/ID tokens or secret-store contents.

Use one connection per instance/provider/account, with grant slots for the
Workspace bundle and Drive file selection. Nonsecret metadata stays in the
instance database. Vault keys include persisted daemon identity, provider,
connection and grant; use the existing `artifact_file_identity`, never hostname
or the provider manager's shared `default` account. Reuse `CredentialStore`:
macOS Keychain first, encrypted SQLite-file fallback (also Linux/Windows),
AES-256-GCM with restrictive file/key permissions and visible degraded-storage
status. Replace the whole token bundle in one store write; publish status only
after it succeeds. Never store tokens in app-MCP headers, session environment,
settings responses, prompts or logs. This is instance isolation, not protection
against an attacker controlling the same OS user.

Refresh before expiry and on demand through one single-flight operation per
grant, rechecking its version after acquiring the lock. Preserve the prior
refresh token if Google omits a replacement; atomically store rotated access,
refresh, expiry and actual scopes together. A lost/failed rotation cannot be
reported healthy. `invalid_grant` stops retries and marks **Reconnect needed**;
transient failures have bounded backoff. Missing scopes disable affected tools.
Reconnect validates the same account before replacing credentials. Disconnect
cancels this instance's refresh/actions, invalidates pending approvals and erases
its credentials. Google-wide grant revocation is a separate explicit action,
since it can affect other installations; do not silently revoke another instance.

### Google scopes and selected files

The selected feature bundle requests `openid email`, `gmail.readonly` plus
`gmail.compose` for real Gmail drafts/sending, and
`calendar.calendarlist.readonly` plus `calendar.events` for accessible-calendar
read/write. Read-only feature selection can use `calendar.events.readonly`
instead. No `mail.google.com`, label/archive scope or whole-Drive scope. Both
Gmail scopes are Restricted; compose already permits sending, so scope consent
cannot replace the daemon gate ([Gmail scopes][gmail-scopes], [Calendar scopes][calendar-scopes]).

Desktop OAuth does **not** support incremental authorization: changing the
feature bundle starts a fresh explicit consent flow for the needed scopes,
checking the actual grant rather than assuming an additive upgrade [native].
Drive-enabled connections include `drive.file`. Selecting existing files uses
Google's system-browser Picker flow with `prompt=consent`,
`trigger_onepick=true`, and **only** `drive.file` in that request. This is an
additional file-selection consent step, not a promise of one universal consent
screen. Keep that grant separate so it cannot overwrite Gmail/Calendar tokens.
Compare Drive `about.user.permissionId` from the main grant and Picker grant
before attaching selected IDs to the account; mismatches are refused
([Picker][picker], [account read][drive-about]). `drive.search` sees only IDs
selected or created by **this instance**, not every file a shared OAuth client
may previously have accessed. A pasted ID or selected folder never grants an
unrestricted scan ([Drive scope][drive-scope]).

## Tools and approval

Expose a built-in Google toolset through the existing operations MCP, using the
same transport-neutral daemon operations for every harness. Each call names a
connection and checks session eligibility, account ownership and granted scopes.

| Tools | First delivery |
| --- | --- |
| `gmail.search`, `gmail.read_thread` | Bounded query/page cursor and header/snippet results; full bodies and attachments only when requested. |
| `gmail.draft`, `gmail.send_draft` | Create/update a Gmail draft; sending is a separate approved action on that draft/version. |
| `calendar.list`, `calendar.create`, `calendar.update` | List calendars/events; create/update first proposes the exact event, including attendees, calendar, timezone, all-day semantics and notification policy. |
| `drive.search`, `drive.read`, `drive.save` | Search selected IDs, bounded read/export/download, and approved creation of a new app-owned file; overwrite/sharing changes are later. |

All outputs have byte/item limits, field projection, opaque paged cursors and
explicit truncation. Bodies are untrusted content, never instructions or approval.
No mailbox mirror or automatic background model turn; `history.list` incremental
sync is later.

**Mandatory daemon gate:** send, event create/update and final submit (including
Drive save) require one human approval, regardless of permission mode, prompt or
MCP hints. Preparation/read/draft calls do not. Persist an immutable action
snapshot with connection/account, operation, draft/event/target ID, canonical
SHA-256 content hash, version/ETag, expiry and question ID. Reserve an event ID
before approving creation. The daemon builds an existing yes/no question card,
showing the full recipients/To/Cc/Bcc, body, attachments, reply thread or event
changes and consequences; long payloads use its artifact preview. Only an
authenticated human answer on that bound card authorizes execution, never an
agent-supplied `approved` flag or an unrelated answered question. Existing home
path/hash confirmation is a pattern, not a connector approval object.

Serialize local edits/execution; any edit retires the approval. Re-read the remote
draft/event and compare the approved hash/version before a durable, atomic
`approved → executing` reservation. The gate, not the model, loads the exact
approved payload. Send with existing `draftId` **and approved raw MIME**: Google
supports updates inside `drafts.send`, so a racing external draft edit cannot
change the transmitted bytes ([draft semantics][drafts]). Calendar updates use
`If-Match`; 412 requires a new preview/approval. Creates use the reserved client
ID to reconcile duplicates ([versions][calendar-versions]).

Persist the attempt before network I/O. Repeated calls return its status;
`executing` after a restart reconciles, never blindly replays. A send timeout is
**Uncertain**: check Sent using a preassigned RFC Message-ID and compare the
returned message to the approved snapshot before any retry. Missing search
results or a missing draft are not proof of failure; unresolved sends require
human reconciliation, not automatic resending ([Sent lookup][messages-list]).
One approval is consumed once. Audit question/human attribution, resource IDs,
hash, attempt/result IDs, timestamps and outcome; diagnostic logs contain neither
message bodies nor credentials.

## Reuse on current dev

| Existing seam | Reuse / gap |
| --- | --- |
| [Settings navigation](../../packages/web/src/islands/ContextPanel.tsx), [routing](../../packages/web/src/lib/router.ts), [content](../../packages/web/src/islands/MainContent.tsx), [sections](../../packages/web/src/components/settings/SettingsSection.tsx) | Add Connections; keep model Providers and raw MCP configuration separate. |
| [Credential stores](../../packages/daemon/src/lib/credentials/credential-store.ts), [provider manager](../../packages/daemon/src/lib/credentials/provider-credential-manager.ts), [refresh scheduler](../../packages/daemon/src/lib/credentials/oauth-refresh-scheduler.ts) | Reuse encryption/store interface and scheduling patterns; add instance/account/grant namespace, rotation serialization and status APIs. Existing provider/default-account wiring is not connector support. |
| [Persisted daemon ID](../../packages/daemon/src/storage/repositories/artifact-file-repository.ts), [operations registry](../../packages/daemon/src/lib/operations/registry.ts), [MCP bridge](../../packages/daemon/src/lib/operations/mcp-server.ts) | Reuse identity and caller/transport boundary; register built-in tools here, not token-bearing session configs. |
| [Questions](../../packages/daemon/src/lib/neo/question-operations.ts), [cards](../../packages/web/src/neo/NeoAskTodos.tsx), [immutable proposal pattern](../../packages/daemon/src/lib/neo/home/github.ts), [DB gateway](../../packages/daemon/src/storage/db-gateway/db-gateway.ts) | Reuse human card/answer rendering, immutable proposal binding and durable reservations; add connector-specific resource/hash/expiry/one-use enforcement. |
| [App MCP lifecycle](../../packages/daemon/src/lib/mcp/app-mcp-lifecycle-manager.ts), [repository](../../packages/daemon/src/storage/repositories/app-mcp-server-repository.ts) | Remote transport/static headers exist; managed OAuth connections and dynamic daemon-owned token injection do not. Do not reuse registry headers as a vault. |

## Human-only Google Console checklist

These are instructions for the human; no agent creates or changes Cloud resources.

1. Create/select the application's own Cloud project. Enable Gmail, Calendar,
   Drive and Google Picker APIs [picker].
2. Configure Google Auth Platform branding, support/developer contacts, audience
   **External** for personal Google accounts, and an accurate privacy/data-use
   description, including content sent to the user's model service [data-policy].
3. In Data Access declare the exact scopes above; confirm Calendar sensitivity
   in Console. `drive.file` is non-sensitive; Gmail read/compose are Restricted.
   Do not replace them with wider scopes just to bypass setup.
4. Create a **Desktop app** OAuth client for the agent application; give the
   implementation its client ID/configuration. A distributed desktop client
   secret is not confidential. Use the app's loopback/PKCE flow, not a web-client
   redirect configuration [native].
5. Use Testing only for initial operator checks, then set the app to
   **Published / In production** and reconnect to obtain a fresh grant. Testing
   refresh tokens for these scopes expire after seven days; publication does not
   guarantee indefinite refresh validity ([token lifecycle][tokens]).
6. For only a few personally known users, assess Google's personal-use verification
   exception and explain the unverified-app screen and 100-user cap. Published
   does **not** mean verified or an allowlist; do not offer this unverified OAuth
   app to arbitrary public users. Workspace administrators may still block it
   ([exception][verification], [states][app-state]).
7. Before broader distribution, complete applicable verification and assess the
   actual restricted-data/cloud-model flow, including any required security
   assessment. A local daemon is not an automatic exemption [verification].

## Ordered implementation PRs and proof

After design approval **and** 0.49.0 shipment, cut each row as one PR of about
100–200 production lines, measured before cutting; tests/fixtures ride the slice.
Split at the named seam if it does not fit; never combine an unverified write
path with a working read path. Each PR owns a reproducible journey/evidence.

| Order / slice | Test and isolated acceptance |
| --- | --- |
| 1. Connection metadata/status operations | Two instance databases start empty; account IDs/status visible, no tokens in schemas/results. |
| 2. Namespaced vault adapter | Synthetic Keychain adapter and real encrypted-file fallback; two instances/accounts cannot read each other's bundle; failed replacement preserves prior durable value. |
| 3. PKCE/state/loopback transport | Fake Google consent/token endpoints; reject wrong state, replay, expired attempt and wrong callback. |
| 4. Connect/reconnect/disconnect operations | Real RPC completes fake login, partial scope and wrong-account cases; disconnect disables tools/refresh immediately. |
| 5. Refresh lifecycle | Fake clock: concurrent calls refresh once; rotated token survives restart; omitted refresh token preserved; invalid_grant shows Reconnect needed without loops. |
| 6. Connections settings UI | Isolated browser clicks Connect through fake consent; account/scopes/health, reconnect and disconnect persist across reload, with screenshots. |
| 7. Bounded Google HTTP client + Gmail search | Fake 401/429/timeout, redaction, page/byte bounds and correct account routing through real MCP. |
| 8. Thread read + MIME draft preparation | Full bodies only on request; draft ID, recipients/body/attachments and stable Message-ID preserved. |
| 9. Action snapshot + question card | Real card displays exact consequences; wrong human/question/account/hash, expired/edited snapshot and agent approval all refuse. |
| 10. One-use execution reservation/audit | Concurrent requests consume once; crash/restart preserves Uncertain; no generic job retry repeats a write. |
| 11. Gmail approved send/reconciliation | Mutate draft after preview; race edit at send; lost response after acceptance finds matching Sent, issuing exactly one send. Unresolved timeout never retries. |
| 12. Calendar reads | Shared-calendar selection, pagination, timezones and all-day dates through fake API/MCP. |
| 13. Calendar approved writes | Reserved ID, ETag conflict, changed attendees/notifications and lost response; only approved bytes are applied once. |
| 14. Native Drive Picker grant/selection | Fake separate drive.file-only consent, account mismatch and two-instance selection isolation; callback returns IDs, never RPC tokens. |
| 15. Selected Drive search/read | Unselected/pasted IDs and implicit folder traversal refused; bounded metadata/export/body results. |
| 16. Approved new-file save + combined RC | Hash/edit/replay checks and save receipt; run Gmail/Calendar/Drive together through restart/refresh and a post-deploy synthetic smoke. |

Use the [verify skill](../../.claude/skills/verify/SKILL.md): `NODE_ENV=test`, fresh
HOME/data/DB, isolated ports, fake Google endpoints and synthetic token fixtures
only; fake endpoint/key material is injected only into the test daemon, never
session environments. Extend journeys as each surface ships. UI slices run the
real UI in an isolated headless profile with screenshots, never human signed-in
apps. RC asserts zero pre-approval writes, exactly one approved external effect,
no secrets in RPC/MCP/config/logs, correct two-instance isolation, and all resources
closed. Fake endpoints prove our control flow, not Google's consent deployment or
real account interoperability. **This docs-only PR has no runtime proof or
implementation; those acceptance runs remain to be delivered by the slices.**

## Steps 2–4 use the same base

2. **Microsoft Graph:** one delegated account connection exposes Outlook mail and
   calendar, OneDrive and eligible Teams APIs; adapters reuse the vault, refresh,
   compact output and action gate. Show tenant/admin/account limitations rather
   than assuming all services work for personal accounts [graph].
3. **Slack:** workspace/account-specific OAuth and official API adapter; same
   proposal/approval path for sending. Confirm the provider's supported client
   flow and required installation permissions before wiring it [slack].
4. **Tools via remote MCP:** daemon-owned OAuth client/proxy for Figma, Notion,
   Atlassian, GitHub and others. Discover resource/authorization metadata, use
   PKCE and supported pre-registration/CIMD (DCR compatibility where supported),
   bind tokens to their resource/audience, and keep them out of app registry
   headers. Re-expose bounded tools through the same policy gate; unknown/final
   mutations require approval. SDK-native OAuth caches do not own this base [mcp].

[native]: https://developers.google.com/identity/protocols/oauth2/native-app
[oidc]: https://developers.google.com/identity/openid-connect/openid-connect
[tokens]: https://developers.google.com/identity/protocols/oauth2
[verification]: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
[app-state]: https://developers.google.com/identity/protocols/oauth2/production-readiness/overview
[gmail-scopes]: https://developers.google.com/workspace/gmail/api/auth/scopes
[calendar-scopes]: https://developers.google.com/workspace/calendar/api/auth
[drafts]: https://developers.google.com/workspace/gmail/api/guides/drafts
[messages-list]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
[calendar-versions]: https://developers.google.com/workspace/calendar/api/guides/version-resources
[drive-scope]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[drive-about]: https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get
[picker]: https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker
[data-policy]: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
[graph]: https://learn.microsoft.com/en-us/graph/auth/auth-concepts
[slack]: https://docs.slack.dev/authentication/installing-with-oauth/
[mcp]: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
