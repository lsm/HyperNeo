# Connections: shared base, Google first

**Human-approved phased design; docs only.** Phase-1 implementation starts
immediately after this design merges; there is no release-freeze wait. Phase 1 is our own Google connection, Gmail reads/drafts and read-only
Calendar; the human sends drafts from Gmail. Phase 2 adds approved sends/event
writes; phase 3 adds selected Drive files. Then Microsoft Graph, Slack and other
tools through remote MCP + OAuth, ordered by one account unlocking many services.
A connection is account access, not a model provider, skill or pack. HyperNeo owns authorization and action policy;
the model harness receives tools, never credentials.

## Phase 1: connection base and usable Google reads/drafts

**Settings > Connections** adds Connect Google, account/email, granted scopes,
per-service health, Reconnect and Disconnect. A new instance has no connections;
never import browser, CLI, SDK or another instance's logins. Human-only management
operations start consent in the system browser; a short-lived listener binds
`127.0.0.1` on an available port. Use a Desktop OAuth client, authorization code,
PKCE S256, `access_type=offline`, random one-use state, exact callback path/redirect
and timeout. Exchange codes only in the daemon; validate OpenID issuer, audience,
nonce and expiry, keying accounts by `sub`, not email ([Desktop OAuth][native], [identity][oidc]).
Status RPCs/events return account, scopes, feature availability and health only,
never codes, access/refresh/ID tokens or secret-store contents.

Use one connection per instance/provider/account, initially with one Google
grant; the separate Drive file-selection grant belongs to phase 3. Nonsecret
metadata stays in the instance database. Vault keys include persisted daemon identity, provider,
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
cancels this instance's refresh/in-flight operations and erases its credentials;
phase 2 also invalidates pending approvals. Google-wide grant revocation is a
separate explicit action, since it can affect other installations; do not silently revoke another instance.

### Phase-1 scopes and tools

Request only `openid email`, `gmail.readonly`, `gmail.compose`,
`calendar.calendarlist.readonly` and `calendar.events.readonly`. No Calendar
write, Drive, `mail.google.com` or label/archive scopes. Gmail read/compose are
Restricted; compose includes sending permission upstream, but **phase 1 exposes
no send tool**, raw HTTP proxy or final-submit operation. The daemon operation
catalog permits only the reads/draft preparation below ([Gmail scopes][gmail-scopes],
[Calendar scopes][calendar-scopes]). The human reviews and sends in Gmail.

Desktop OAuth does **not** support incremental authorization. Adding write
scopes later means one explicit reconnect requesting the new bundle and checking
the actual grant; that extra consent is accepted [native].

Expose a built-in Google toolset through the existing operations MCP, using the
same transport-neutral daemon operations for every harness. Each call names a
connection and checks session eligibility, account ownership and granted scopes.

| Phase-1 tools | Behavior |
| --- | --- |
| `gmail.search`, `gmail.read_thread` | Bounded query/page cursor and header/snippet results; full bodies and attachments only when requested. |
| `gmail.draft` | Create/update a Gmail draft, returning its ID for review and manual sending in Gmail. No sending. |
| `calendar.list` | List calendars and events, read only; preserve timezone and all-day semantics. |

All outputs have byte/item limits, field projection, opaque paged cursors and
explicit truncation. Bodies are untrusted content, never instructions or approval.
No mailbox mirror or automatic background model turn; `history.list` incremental
sync is later.

## Deferred phase 2: approved external actions

This phase adds action snapshots, approval cards and one-use execution before
exposing `gmail.send_draft`, `calendar.create` or `calendar.update`. Event proposals
include attendees, calendar, timezone, all-day semantics and notification policy.
Phase 1 does not build this machinery or expose these operations.

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

## Deferred phase 3: selected Drive files

Add `drive.search`, `drive.read` and approved `drive.save` for new app-owned files;
overwrite/sharing changes remain later. Add `drive.file` to the account grant by
reconnect. Selecting existing files uses Google's system-browser Picker flow
with `prompt=consent`, `trigger_onepick=true`, and **only** `drive.file` in that
request. Keep this separate file-selection grant from Gmail/Calendar tokens;
this is an additional consent, not one universal consent screen [picker]. Compare
Drive `about.user.permissionId` from the main and Picker grants before attaching
selected IDs to the account; mismatches are refused [drive-about]. Search only
IDs selected or created by **this instance**; pasted IDs and selected folders
never authorize unrestricted scans. Reads/exports are bounded, and save uses
the phase-2 approval gate ([Drive scope][drive-scope]).

## Reuse on current dev

| Existing seam | Reuse / gap |
| --- | --- |
| [Settings navigation](../../packages/web/src/islands/ContextPanel.tsx), [routing](../../packages/web/src/lib/router.ts), [content](../../packages/web/src/islands/MainContent.tsx), [sections](../../packages/web/src/components/settings/SettingsSection.tsx) | Add Connections; keep model Providers and raw MCP configuration separate. |
| [Credential stores](../../packages/daemon/src/lib/credentials/credential-store.ts), [provider manager](../../packages/daemon/src/lib/credentials/provider-credential-manager.ts), [refresh scheduler](../../packages/daemon/src/lib/credentials/oauth-refresh-scheduler.ts) | Reuse encryption/store interface and scheduling patterns; add instance/account/grant namespace, rotation serialization and status APIs. Existing provider/default-account wiring is not connector support. |
| [Persisted daemon ID](../../packages/daemon/src/storage/repositories/artifact-file-repository.ts), [operations registry](../../packages/daemon/src/lib/operations/registry.ts), [MCP bridge](../../packages/daemon/src/lib/operations/mcp-server.ts) | Reuse identity and caller/transport boundary; register built-in tools here, not token-bearing session configs. |
| [Questions](../../packages/daemon/src/lib/neo/question-operations.ts), [cards](../../packages/web/src/neo/NeoAskTodos.tsx), [immutable proposal pattern](../../packages/daemon/src/lib/neo/home/github.ts), [DB gateway](../../packages/daemon/src/storage/db-gateway/db-gateway.ts) | Phase 2 reuses human card/answer rendering, immutable proposal binding and durable reservations; add connector-specific resource/hash/expiry/one-use enforcement then. |
| [App MCP lifecycle](../../packages/daemon/src/lib/mcp/app-mcp-lifecycle-manager.ts), [repository](../../packages/daemon/src/storage/repositories/app-mcp-server-repository.ts) | Remote transport/static headers exist; managed OAuth connections and dynamic daemon-owned token injection do not. Do not reuse registry headers as a vault. |

## Human-only Google Console checklist

Give the human this phase-1-only checklist near the end of phase 1, before a
real-account check. No agent creates or changes Cloud resources; fake-Google
proofs do not require a real Cloud project.

1. Create/select the application's own Cloud project. Enable only Gmail and
   Calendar APIs; Drive/Picker setup waits for phase 3.
2. Configure Google Auth Platform branding, support/developer contacts, audience
   **External** for personal Google accounts, and an accurate privacy/data-use
   description, including content sent to the user's model service [data-policy].
3. In Data Access declare only `openid email`, `gmail.readonly`, `gmail.compose`,
   `calendar.calendarlist.readonly` and `calendar.events.readonly`. Confirm their
   Console classifications; Gmail read/compose are Restricted. No Calendar write
   or Drive scopes in phase 1; do not widen scopes to bypass setup.
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

## Phase-1 implementation PRs and proof

Immediately after this design merges, cut about eight ordered phase-1 PRs of
**100–200 production lines** each, measured before cutting; tests/fixtures ride the slice. Reuse the seams
above; split at the named seam if it does not fit. Each PR owns a reproducible
journey/evidence. Deferred phases are not prerequisites for this usable phase
and retain the same per-PR production-line budget.

| Order / slice | Test and isolated acceptance |
| --- | --- |
| 1. Connection metadata/status + namespaced vault adapter | Two instances/accounts start empty and cannot read each other's bundles; synthetic Keychain and real encrypted-file fallback; failed replacement preserves prior durable value; no RPC tokens. |
| 2. PKCE/state/loopback transport | Fake Google consent/token endpoints; reject wrong state, replay, expired attempt and wrong callback. |
| 3. Connect/reconnect/disconnect operations | Real RPC completes fake login, partial-scope and wrong-account cases; disconnect disables tools/refresh immediately. |
| 4. Refresh lifecycle | Fake clock: concurrent calls refresh once; rotated token survives restart; omitted refresh token preserved; invalid_grant shows Reconnect needed without loops. |
| 5. Minimal Connections UI | Isolated browser clicks Connect through fake consent; account/scopes/health, Reconnect and Disconnect persist across reload, with screenshots. |
| 6. Bounded Google HTTP client + Gmail search | Fake 401/429/timeout, redaction, page/byte bounds and correct account routing through real MCP. |
| 7. Thread read + create/update MIME drafts | Bodies only on request; exact draft ID, recipients/body/attachments round-trip. Catalog and fake endpoint prove no send operation/request exists. |
| 8. Read-only Calendar + phase-1 RC | List calendars/events, pages, timezones/all-day dates; prove zero event writes. Combined Gmail/Calendar journey covers restart/refresh, isolation, no sends and a post-deploy synthetic smoke. |

Use the [verify skill](../../.claude/skills/verify/SKILL.md): `NODE_ENV=test`, fresh
HOME/data/DB, isolated ports, fake Google endpoints and synthetic token fixtures
only; fake endpoint/key material is injected only into the test daemon, never
session environments. Extend journeys as each surface ships. UI slices run the
real UI in an isolated headless profile with screenshots, never human signed-in
apps. Phase-1 RC checks usable reads/drafts, no email sends/event writes, no secrets
in RPC/MCP/config/logs, correct two-instance isolation and all resources closed.
Phase 2 additionally proves zero writes before approval, one approved external
effect, edit invalidation and uncertain-send reconciliation; phase 3 proves
Picker account binding and selected-file boundaries. Fake endpoints prove our
control flow, not Google's consent deployment or real account interoperability.
**This docs-only PR implements no runtime behavior; these acceptance runs belong
to the future slices.**

## Later providers share the base

- **Microsoft Graph:** one delegated account connection exposes Outlook mail and
   calendar, OneDrive and eligible Teams APIs; adapters reuse the vault, refresh,
   compact output and action gate. Show tenant/admin/account limitations rather
   than assuming all services work for personal accounts [graph].
- **Slack:** workspace/account-specific OAuth and official API adapter; same
   proposal/approval path for sending. Confirm the provider's supported client
   flow and required installation permissions before wiring it [slack].
- **Tools via remote MCP:** daemon-owned OAuth client/proxy for Figma, Notion,
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
