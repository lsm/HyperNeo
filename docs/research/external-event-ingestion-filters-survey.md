# External-event ingestion: user-configurable filters/mappings + self-event suppression — survey & chain proposal

> **ADR 0004 revision 2026-08-25:** direct superpipe composition is now the default — one cohesive, business-named pipeline per business path mixing decision/transform/effect stages; no flow is pre-classified as decisionRun/stagedRun, and combinators are extracted only after direct use reveals a recurring shape. Where this document prescribes combinator categories or staged contracts, read them through that revision (ADR 0004, "One pipeline per business path").

Task #1259 survey. Analysis only — maps the external-event ingestion path on current
`dev` (e87cadcd7) and proposes chains that close the two owner-reported product gaps:
(1) ingestion-level filtering + field mapping ("for GitHub events, I only need this one
and this field"), and (2) self-originated-event suppression ("I post a comment, and a
couple seconds later I get an event saying I posted a comment"). Both gaps are
superpipe-shaped: they extend the admission/projection seams ADR 0004 already
established (pilot 1's delivery admission gates; `github-normalizer` as the transform
point), with config flowing as DATA into pure cores.

## 1. Ingestion path map

```
GitHub ──webhook POST /webhook/github/space──▶ handleWebhook (github-event-extension.ts:663)
GitHub ──poll (timer → pollOnce :988 → pollWatchedRepo :2219)──▶ pollWatchedRepoCore :2242
        │
        ├─ normalize*  (github-normalizer.ts, pure)  → NormalizedGitHubEvent
        ├─ publishEvent (github-event-extension.ts:1731)   ← the single ingestion choke point (6 call sites)
        │    └─ toExternalEvent (github-normalizer.ts:1084) → ExternalEvent
        │         └─ ExternalEventService.publish (external-event-service.ts:39)
        │              ├─ ExternalEventStore.store (external-event-store.ts:93)  ← persistence + dedupe
        │              └─ bus.publish('externalEvent.published') (:73)
        │                   ├─ SpaceRuntime.handleExternalEvent (space-runtime.ts:1590)
        │                   │    topic-trie lookup :1608 → registerExpectedDelivery :1641/:1652
        │                   │    → pilot-1 delivery core (external-event-delivery-pipeline.ts:116)
        │                   │    → interpreter (space-runtime.ts:1685) → session inject via
        │                   │      formatExternalEventEssence (event-essence.ts:3) at :1973/:2343  ← agent tokens
        │                   └─ goalAutomationService.onExternalEventPublished (rpc-handlers/index.ts:473)
```

### Entry points

- HTTP route registration `github-event-extension.ts:274-280`; per-repo HMAC
  verification `:677-685` (`verifySignature` from `lib/github/webhook-handler.ts` — the
  only module the new path shares with the legacy one); event-type dispatch at
  `:700-715` (status / deployment / generic).
- Polling: three list endpoints plus check-run and reaction polling (`:2270-2274`),
  publishing at `:2485`, `:2710`, `:2843`.
- RPC: `space.github.*` (14 methods, `:341+`). Web settings surface already exists:
  `SpaceExternalEventsSettings.tsx`, `GitHubHealthPanel.tsx`.

### Normalization (the transform point)

`external-events/github/github-normalizer.ts` (1,124 lines; pure up to event
construction — review finding, PR #2723): `normalizeGitHubWebhook :142`,
`normalizeGitHubPollingRow :363`, per-type normalizers
(`:479-1030`), topic mapping `mapEventType :1038`, and `toExternalEvent :1084` which
builds the persisted `ExternalEvent`. The normalizer functions proper are pure,
but `toExternalEvent` calls `crypto.randomUUID()` and `Date.now()`
(`:1094-1098`) and `parseGitHubTimestamp :67-71` falls back to `Date.now()` —
so C2's pipeline must inject clock/id generators or keep external-event
construction in the impure shell for deterministic parity tests. Every normalized event carries
`actor`/`actorType` (`:32-33`) — populated from `sender`/`comment.user`/`review.user`/
`obj.user` depending on type and source. Hardcoded admission filtering already exists
*inside* the normalizers (e.g. `check_run` only `completed`+failed conclusions
`:490-497`; `merge_group` only two actions `:931`; issue comments only on PRs `:213`)
— but it is neither centralized nor user-configurable.

### Persistence / dedupe

`ExternalEventStore.store` (`external-event-store.ts:93-146`):
`INSERT … ON CONFLICT(space_id, source, dedupe_key) DO NOTHING`; the store itself
never republishes — `ExternalEventService.publish` distinguishes the outcomes
(review finding, PR #2723): **terminal duplicates** (`delivered`/`failed`/`ignored`)
return immediately with no bus publish, while **retryable duplicates** (still
`published`) re-publish the canonical row to the bus (`external-event-service.ts:41-71`).
Pins/parity tests must not expect terminal duplicates to re-enter bus subscribers.
Delivery rows track per-target state; TTL sweep
`markPublishedEventsFailedBefore :235`.

### Replay / recovery (downstream, unaffected by ingestion gates)

`redispatchRetainedExternalEvents` (`space-runtime.ts:1596-1601`),
`redispatchPublishedEventsWithoutDeliveries :4611-4617`, TTL expiry `:4619`. Note that
#2671 is the SDK query-mode replay loop (`agent/query-mode-handler.ts`), not this
path — the external-events analog replays from the store through
`handleExternalEvent`, **bypassing any ingestion gate**. That is the correct property:
config changes must not retroactively alter already-queued events — with the
retained-row qualification of chain B (§3): rows persisted under an older
projection config persist their projected schema, and newly accepted
filters apply only to rows whose recorded schema includes their keys rather
than re-projecting history.

### Where pilot 1's gates sit

The extracted gates (`external-event-admission-gates.ts`, 136 lines;
`external-event-delivery-pipeline.ts`, 142 lines) are **delivery-time** — they run
after persistence, inside SpaceRuntime, deciding deliver/hold/fail/queue per
subscriber. **No admission seam exists at ingestion.** Everything between `normalize*`
and `publisher.publish` is hardcoded control flow inside the 3,129-line extension
class.

### Config seam (already built)

`ExternalEventExtensionConfigStore` (`extension-config-store.ts:25-124`) persists
per-source global config (`external_event_extension_configs`, `settings_json`) and
per-space config (`space_external_event_source_configs`, `settings_json`). Webhook
ingestion **already reads** `getGlobalConfig` (`:666`) and `getSpaceConfig` (`:728`,
`:778`, `:903`) per publish decision. Per-source user config therefore needs **no new
table** — filters/mappings are new keys in the existing `settings` JSON, flowing as
data into pure cores (the ADR-0004 boundary: config is DATA flowing into pure cores,
never logic). Caveat (review finding on PR #2723): the per-space writer is
destructive — `persistSpaceConfig` rebuilds `settings` from scratch and would wipe
foreign keys; see bug 7 in §5 and the preservation fix required in chain A PR A2.

### Legacy parallel path (context)

`lib/github/github-service.ts` (wired `app.ts:524-563`) is the legacy room-attached
inbox path, and it **already has user-configurable ingestion filters**:
`event-filter.ts:54-93` (repo allowlist, per-event-type action allowlists, author
allow/block lists, label filters) plus `filter-config-manager.ts`
(`github_filter_configs` table, per-repo override over global default, TTL cache).
The external-events path has none of this. The legacy path is the design precedent to
mine, not the place to build.

### Tests

`github-event-extension.test.ts` (9,438 lines), `github-normalizer.test.ts` (1,315),
`external-event-store.test.ts`, `external-event-extension-config-store.test.ts` (201),
`external-event-service.test.ts`, the pilot-1 parity harness and delivery-pipeline
suites, and `external-event-essence-contract.test.ts`. Churn: the directory was
created ~2026-08-16 (#2552); since then only #2637 (TTL sweep SQL) and #2651 (CI) — a
stable, low-churn seam.

## 2. Token-cost anatomy (what the owner is actually paying)

1. **`rawPayload` rides on every event**: `toExternalEvent` embeds the full raw
   GitHub payload (`github-normalizer.ts:1119`) into `ExternalEvent.payload` →
   persisted unbounded in `payload_json` → returned verbatim by the
   `get_external_event` deep-dive tool (`space-agent-tools.ts:4433`,
   `node-agent-tools.ts:1111`) → agent tokens on every deep-dive, plus bus payload
   size and DB writes.
2. **Session-injected messages are already lean**: delivery injects
   `formatExternalEventEssence` — a curated per-type whitelist
   (`event-essence.ts:24-128`) that excludes `rawPayload`. So the biggest per-delivery
   token lever is event *selection* (gaps 1+2), not the essence shape.
3. **Every event for a watched repo is persisted even with zero matching
   subscriptions**, and such events are never transitioned to `ignored` (review
   finding, PR #2723): `handleExternalEventImpl` returns with the row still
   `published` (`space-runtime.ts:1613-1627`, failing only already-expired events
   as `ttl_expired`), `markEventIgnored` has no callers anywhere in the repository
   (`external-event-store.ts:251` — dead method), and the normal cleanup path is
   the TTL sweep marking them `failed` (`markPublishedEventsFailedBefore :235`).
   Retention/parity pins must expect unmatched events to remain `published` until
   TTL failure. By-design pub/sub, but it
   means ingestion is the only place where unwanted events cost nothing.
4. **Self-echo**: events whose actor is the authenticated account flow the entire
   path (persist → topic match → inject) and consume agent context — the owner's
   exact complaint.

## 3. Proposed chains (ranked)

### Chain A — self-event suppression admission gate (first: small, immediate savings)

The identity machinery already exists: `getTokenStatus()` resolves `GET /user` →
`login` (`github-event-extension.ts:1231-1270`), cached with
credential-generation/fingerprint guards (`:295-297`, `credentialFingerprint`).
`NormalizedGitHubEvent.actor` is populated on every event from both webhook and
polling sources.

- **PR A1 (pin):** decision-table pin of current admission behavior at
  `publishEvent` — per event type × source, which user field feeds `actor` (e.g.
  webhook `check_run` actor = sender; polling check_run actor = app;
  `issue_comment` = `comment.user ?? sender`), and that today **everything normalized
  for an enabled space is published**. The pin must also record, per type, whether
  `actor` is the *artifact owner* or the *event initiator* — they diverge (review
  finding, PR #2723): webhook `pull_request` events take `pr.user ?? sender`
  (`github-normalizer.ts:317-320`), so the actor is the PR author even when a
  collaborator performed the close/merge/edit; polling `pulls` rows expose only the
  PR author (`normalizeGitHubPollingRow :385`). No production change.
- **PR A2 (gate → flip):** new pure module
  `external-events/github/github-ingestion-gates.ts`:
  `decideIngestion({ event, selfLogin, config }) → admit | drop{reason:'self_event'}`.
  Suppression keys on a **new causal `initiator` field** on `NormalizedGitHubEvent`
  — the webhook `sender` for **every** webhook event (review finding, PR #2723:
  GitHub sets `sender` to the user who triggered the delivery, so it is uniformly
  causal; artifact-author inference is wrong for `pull_request_review.dismissed`,
  where the review author and the dismisser differ — the normalizer accepts every
  review action and reads `review.user` (`github-normalizer.ts:230-250`), so an
  author-keyed rule would false-drop another user's dismissal of a self-authored
  review and miss a self-dismissal of another's), never on `actor` alone, and only
  for event kinds where the causal identity is reliable. Artifact-author inference
  is reserved for sources that lack a causal sender: polling `pulls` rows are
  excluded (initiator indeterminable), and polling comment rows are reliable **only
  for unedited rows** (`created_at === updated_at` — review finding, PR #2723): the
  poller requests the comment endpoints with `since` (`:2270-2274`, `:2317-2325`),
  so edits are emitted too, versioned by `updated_at` while `obj.user` remains the
  original author (`github-normalizer.ts:385`, `:397-403`) — another user's edit of
  a token-owner-authored comment would otherwise be dropped as self-originated.
  Edited rows carry initiator unknown. **Fail-open:** an event with no resolvable
  initiator is always admitted. SUPERSEDED 2026-08-25 (ADR 0004 revision): compose
  the admission as a direct superpipe pipeline from the start — the
  "single gate stays a plain function" instruction below predates the
  one-pipeline-per-business-path revision and no longer applies. Shell: `publishEvent` (`:1731`) reads the cached identity
  and gates **first observations only** (review finding, PR #2723): a `getByDedupe`
  lookup precedes the gate, and an existing canonical row — retryable (`published`)
  or terminal — bypasses the gate entirely and flows through the normal duplicate
  path. The dedupe check, gate decision, and insertion execute **inside one
  per-dedupe-key critical section** — a *separate, finer lock* than the
  disablement serialization (review finding, PR #2723): two overlapping
  same-key observations must not both classify as first, or the first can persist
  and fail during bus delivery while the second — seeing a warmed identity or
  changed filter — is dropped without invoking the publisher, stranding the
  retryable canonical row. This per-key section does **not** carry the
  disable-vs-insert race: a config mutation cannot know all current or future
  dedupe keys, so cross-key serialization with disablement comes from the epoch
  mechanism of bug 4 (disablement bumps the admission epoch inside the config
  queue; every publisher re-verifies it immediately before insert) — no shared
  admission lock is needed for that purpose, and the per-key section nests
  entirely inside a single publisher's epoch-verified window. Without this, an event admitted and persisted while identity was unknown
  (fail-open) could be re-observed after the cache warms, classified as a
  self-event, returned as an intentional drop, and the polling cursor would advance
  without the retryable-duplicate republish (`_handleRetryableDuplicate`) —
  stranding the queued row; a filter change between attempts has the same effect,
  contradicting the invariant that config must not retroactively alter queued
  events. Genuinely new events are gated before persistence, dedupe-insert, and
  both bus subscribers (SpaceRuntime *and* goal-automation both save). The
  ingestion step returns `admitted | dropped{reason} | duplicate_terminal` so
  callers report honestly (review findings, PR #2723): the three webhook paths
  increment `published` after every resolved call (`:732`, `:843`, `:933`) and
  would otherwise count suppressed deliveries as published (`spaces: 1` with
  nothing persisted) — and a GitHub redelivery whose canonical row is already
  terminal bypasses the gate and returns `duplicate_terminal` from the publisher
  without a bus publish, which a two-valued result cannot express; caller-visible
  counts exclude both intentional drops and terminal redeliveries. Polling
  advances its
  watermarks for intentional drops so suppressed rows cannot wedge the cursor
  (bug 1). Default **ON**, override via `suppressSelfEvents: false` in global then
  per-space `settings_json` — and the minimal write RPC for that flag ships **in
  A2**, not A3 (review finding, PR #2723): `space.github.*` has no generic settings
  writer today (`listConfig` is read-only), so a default-on flip without a supported
  opt-out is not shippable. Case-insensitive login compare; Bot initiators never
  match the **automatic token-derived identity** (a `/user` login is a user
  account, so e.g. `github-actions[bot]` echoes are not auto-suppressed), but
  explicitly configured `suppressSelfEventsLogins` entries — bot logins
  included — participate fully in the comparison (review finding, PR #2723).
- **Identity-resolution policy (review findings, PR #2723):** the self identity is
  a **configurable login set**, not a single derived value. The extension's
  ingestion credential (`neokai.external-events.github` or `GITHUB_TOKEN`,
  `:103-104`, `:1171-1217`) is not necessarily the account behind HyperNeo's
  *outbound* GitHub writes: built-in workflows post through the `gh` CLI connector,
  whose auth honors `GH_TOKEN`/`GITHUB_TOKEN`/`GH_CONFIG_DIR`
  (`runtime/connectors/github-connector.ts:1-15`) and can be a different account —
  in that configuration a token-login-only gate would admit the agent's own echo
  while suppressing unrelated activity by the ingestion-token owner. The set is
  **explicitly configurable** via the A2 config RPC (`suppressSelfEventsLogins:
  string[]` — e.g. the gh account, a bot login), and an explicit set always wins —
  no auto-seed applies beside it. Auto-seeding from the ingestion token's `/user`
  login is **conditional** (review finding, PR #2723): seed only when the ingestion
  credential is known to be shared with the outbound path (sourced from the
  `GITHUB_TOKEN` env the gh connector also honors, or a matching credential
  fingerprint); when the ingestion credential is a distinct service credential and
  a different outbound auth path exists (`GH_TOKEN`/`GH_CONFIG_DIR`), the
  unconditional seed would false-drop every event initiated by the
  ingestion-token owner — unrelated activity — so the daemon seeds nothing,
  suppression waits for explicit configuration, and the health snapshot surfaces an
  "identity ambiguous — set `suppressSelfEventsLogins`" hint.
  Do NOT reuse
  `resolveTokenStatus` semantics on the publish path — it caches only
  success/auth-rejected/403 and clears on timeouts and network/5xx failures
  (`github-event-extension.ts:1331-1359`), with `/user` allowed to wait 5 s; inline
  reuse would serialize webhook fan-out and polling during a transient GitHub
  outage. Instead the gate consults only an already-cached last-known-good `login`,
  failures are negatively cached with a short TTL, and while identity is unknown
  the gate admits (fail-open) — never a fresh `/user` await per event. The cache
  must also be warmed **independently of the UI** (review finding, PR #2723):
  `resolveTokenStatus` is reachable only from `buildHealthSnapshot`, which only the
  demand-driven `space.github.health` RPC invokes (`:594-605`, `:1363-1369`), and
  the `space.github.getTokenStatus` RPC calls `getTokenStatus` directly without
  writing the `lastTokenStatus` cache — so in a headless space that never opens the
  health panel the login stays unknown and default-on suppression would silently
  never activate. PR A2 therefore adds a fire-and-forget identity refresh whose
  triggers do **not** depend on polling (review finding, PR #2723): (a) at
  `start()`, (b) directly from the credential-change paths — `setToken`/`clearToken`
  currently only bump `credentialGeneration` via `resetRateLimitObservation`
  (`:576-617`, `:1676-1681`) without scheduling any re-resolution, and (c) a
  bounded independent timer — because `start()` returns early without scheduling
  polls when polling is disabled (`:329`), poll-cycle piggybacking alone never runs
  in webhook-only installs and a live token rotation would leave every subsequent
  webhook fail-open until a health request or restart. The refresh never blocks the
  publish path and keeps the negative-cache/fail-open behavior during outages, and
  the timer carries an explicit `stop()` lifecycle requirement (review finding,
  PR #2723): `stop()` today clears only `pollTimer` and awaits polling/reconciliation
  (`:333-339`), so A2's timer must itself be cleared there — and any in-flight
  refresh settled or generation-invalidated — or shutdown leaves live `/user`
  requests and a timer that survives test teardown/restart.
- **PR A2 also carries the settings-preservation fix (review finding on PR #2723):**
  `persistSpaceConfig` (`:1739-1772`) rebuilds the per-space `settings` object from
  only `pollingIntent` + `watchedRepos`, and `setSpaceConfig`
  (`extension-config-store.ts:114-122`) upserts `settings_json` wholesale — so any
  foreign key (the per-space `suppressSelfEvents` override included) would be
  silently wiped by any of the 8 RPC call sites that persist space config
  (`:354`, `:368`, `:443`, `:455`, `:486`, `:506`, `:535`, `:653`). Fix:
  read-merge-write — fetch the current space config and spread its `settings` under
  the two owned keys, so unknown keys survive — **and serialize per-space writes**
  (review finding, PR #2723): MessageHub handlers are async, so two concurrent RPCs
  (e.g. a toggle overlapping a watch) can read the same `settings_json`, merge
  independently, and the later full-document replace in `setSpaceConfig` still
  erases the other's key. Route per-space config writes through a per-space promise
  queue — the extension's existing `webhookConfigQueues` idiom (`:289`); a
  store-level `json_patch`-style partial settings update is the alternative if the
  queue proves insufficient. **Global config needs the same serialization** (review
  finding, PR #2723): spreading only protects single-writer sequences —
  `setGlobalConfig` also replaces `settings_json` wholesale
  (`extension-config-store.ts:75-100`), and the global-enabled RPC and
  polling-capability writers each await a read before writing, so once A2 adds a
  global suppression writer, a concurrent enable/disable or polling update can read
  the old settings and erase the new flag. All `github` global config mutations
  route through one source-scoped queue in the same PR (writers today:
  `app.ts:153`, `rpc-handlers/index.ts:252`,
  `github-event-extension.ts:1636`/`:1649`). The queue must cover the
  **complete enable/disable operation, not just the store mutation** (review
  finding, PR #2723): `setGlobalEnabled(false)` awaits `stopExtension` before its
  config write while enablement writes first and then awaits `startExtension`
  (`rpc-handlers/index.ts:250-284`), so queueing only the writes lets a concurrent
  enable write `true`, wait out an in-flight stop, resume starting, and lose to
  the disable's later `false` — leaving the extension running (possibly with
  polling active) under disabled persisted config. Lifecycle effects and
  rollback ride inside the queued operation — **but never inside any
  publisher critical section** (review finding, PR #2723): `stop()` awaits
  `activePollCycle`
  (`:337`), and a poll cycle can be blocked in `publishEvent` between its epoch
  re-verify and insert, so holding that per-key section across `stopExtension`
  would deadlock. There is no cross-key "admission section" lock at all (review
  finding, PR #2723) — publishers synchronize with disablement through the epoch
  bump, never through a shared lock. The **source-config queue is a different
  lock and stays held
  through the entire operation including the `stop()` await** (review finding,
  PR #2723) — exiting it before the await would let an overlapping enable's
  `startExtension` observe the extension as still running
  (`extension-manager.ts:49` returns early) and then let the stop finish,
  leaving enabled persisted config with a stopped extension. No lock is held
  across the lifecycle await except the source-config queue itself; publishers
  coordinate via the
  epoch bump, not the config queue, so no deadlock — and **every
  admission/projection config mutation bumps and rechecks the epoch, not just
  disablement** (review finding, PR #2723): the A2 per-space/source-scoped
  config queues — which B3's projection and filter writers join — serialize
  config writes with each other but not with publisher ingestion, so a stale
  publisher could project away key K, then a projection update restore K for a
  just-validated subscription on K, and the stale publisher then insert and
  broadcast a payload without K — the newly valid automation silently fails to
  match and the stored event stays incompatible on replay. Each such mutation
  bumps the epoch inside its queue operation; every publisher re-verifies it
  immediately before the synchronous insert, and on change **re-runs the full
  admission decision — gates plus projection — from fresh global, space, and
  repository policy**, not merely the projection (review finding, PR #2723): an
  event admitted under the old allowlist must not insert after a new deny policy
  commits. The documented dropped-event cursor behavior applies to these
  post-change drops exactly as to first-gate drops. Additionally,
  compatibility-changing projection mutations **drain publications from earlier
  epochs before completing** (review finding, PR #2723) — same mechanism as
  disablement's publisher await: a publisher can synchronously insert an
  old-projection payload and only then yield in `_publishBusEvent`, so without
  the drain it broadcasts after the update returns and a newly valid
  subscription silently misses. Disablement and projection/filter/suppression
  mutations share this drain obligation; no publisher lock is held while
  draining. Retained rows need explicit treatment too (review finding, PR
  #2723): a row persisted while key K was excluded stays `published` until TTL,
  and its later retryable-duplicate republish would broadcast the stored
  K-less payload without re-projection — silently missing a newly valid
  subscription on K. Since stripped keys are unrecoverable from the projected
  payload, **every retained row persists its projected schema** — the key set
  the projection actually kept — **and a newly accepted filter applies only to
  rows whose recorded schema includes its referenced keys**, uniformly across
  recovery routes (review findings, PR #2723): a bare version number cannot be
  evaluated without retaining version-to-config history, and treating every
  unequal version as incompatible would skip queued rows after harmless
  projection changes, retroactively altering them; the self-describing schema
  distinguishes an older row that includes filter key K from one produced while
  K was stripped. The rule also governs both recovery routes uniformly
  (`redispatchRetainedExternalEvents` and GitHub redeliveries) and no route
  rewrites the canonical row. Defined behavior replaces silent mismatch.
- **PR A3 (surface):** UI and counters only — the `SpaceExternalEventsSettings`
  toggle UI reusing the write RPC A2 already delivered (review finding, PR #2723;
  A3 adds no RPC surface), plus a suppression counter with its own gate-side
  storage (review finding, PR #2723): the existing health `eventTypes` machinery
  derives from `ExternalEventStore.listEventCountsByTopic`
  (`github-event-extension.ts:1533-1558`), which never sees gate-dropped events, and
  its `TOPIC_SUFFIX_TO_HEALTH_TYPE` enum (`:172-194`) omits exactly the self-echo
  kinds (comments, reviews, reactions, PRs). Use an in-memory counter incremented at
  the gate — windowed retention, resets on restart (health display, not accounting) —
  surfaced on `GitHubHealthSnapshot` alongside `eventTypes`.

### Chain B — config-driven filter/mapping pipeline (admission + P1 transform)

- **PR B1 (pin):** pin `toExternalEvent` payload key sets per **event type ×
  source** (incl. `rawPayload` presence) — the transform's parity baseline.
  Event type alone is insufficient (review finding, PR #2723): webhook
  `check_run` emits only `checkName`/`conclusion`/`runUrl`
  (`github-normalizer.ts:541`) while polling `check_run` additionally emits
  `checkRunId`/`name`/`status`/`headSha` (`:565-573`), so a per-type table would
  let projection drop source-only fields while parity passes. Within a
  type × source cell, keys split into **required vs optional variants**
  (review finding, PR #2723): `JSON.stringify` drops the normalizer's many
  `undefined` values, so conditional keys — review-comment location fields like
  `line`/`startLine`, polling `mergedAt`/`draft` when unavailable — appear and
  disappear with the payload; a single key-set pin would either reject valid
  variation or miss optional-field loss, so each cell pins a required set plus
  an optional set (or per-action variants).
- **PR B2 (admission):** extend the ingestion gates with
  `eventTypeAllowed(config, event)` — per-space allow/deny lists over `eventType`
  (and optionally `action`), config resolved from the `settings_json` the webhook
  path already loads (`:728`); polling resolves once per space via
  `listEnabledSpaces`. Default config = allow-all (current behavior). The
  synthetic-action restriction is **polling-only** and limited to the generic
  list-endpoint kinds (review findings, PR #2723): `normalizeGitHubPollingRow`
  assigns every row action `polled` (`:411`), so an `issue_comment.created`
  allowlist on a polling-only space would drop every comment and `polled` cannot
  distinguish creation from edit — action filters do not apply to those polling
  kinds (`issue_comment`, `pull_request_review_comment`, `pull_request`). But
  other polling kinds carry real actions that align across sources — reactions
  `added` on both paths (`normalizeGitHubReaction :1004`) — so action filters
  apply there (a `reaction.added` denial must take effect on polling too).
  Check runs do **not** align: webhook emits `action: 'completed'`
  (`github-normalizer.ts:525`) while polling emits `'failed'`
  (`:549`), so a webhook-derived `check_run.completed` filter would silently
  drop all polling check runs; `check_run` action filtering is deferred to the
  canonical cross-source action vocabulary future item along with the generic
  list-endpoint kinds, not B2. Also a coarse
  header-level pre-gate for enrichment-heavy types (review finding, PR #2723):
  `status`/`deployment`/`deployment_status` webhook handlers resolve associated PRs
  via REST — up to five pages for the status path's
  `resolvePullRequestNumbersForCommit :951-985`; a single call for the
  deployment paths' `resolveDeploymentPrNumbers :857-859` — *before*
  normalization, so when
  every matched space denies the header event type, short-circuit before those
  calls — **but only when no retryable duplicate could exist** (review finding,
  PR #2723): these events' dedupe keys embed the *resolved* PR number
  (`github-normalizer.ts:602`, `:717`, `:783`), so the coarse gate cannot run a
  `getByDedupe` check before PR resolution; short-circuiting unconditionally
  would drop a GitHub redelivery whose canonical row is retryable `published`,
  stranding its republish — the same behavior A2's dedupe bypass forbids, one
  return point earlier. The pre-gate correlates on **this delivery**, not the
  topic family (review finding, PR #2723): a family-wide "any retryable
  `published` row in this repo/topic family" lookup degenerates — unmatched
  events stay `published` until TTL even after successful handling (§2 item 3),
  so one stale row would disable the short-circuit for every later denied
  delivery. GitHub redeliveries carry the same `X-GitHub-Delivery` ID, so the
  check is an exact `source_event_id`/delivery-ID lookup (`sourceEventId` is
  persisted per event), with B2 adding a supporting `(space_id, source,
  source_event_id)`-style index — the current schema's indexes (`(space_id,
  source, dedupe_key)`, `(state, updated_at)`, `(space_id, source,
  ingested_at)` — `migrations.ts:6597-6604`, `:9101-9102`) cover none of these
  predicates; only a matching retryable row falls through to the normal
  resolution+dedupe path.
  Short-circuits also **`markWebhookReceived` on all matched targets first** (review
  finding, PR #2723): the enrichment handlers otherwise mark only after PR
  resolution and publication (`:845`, `:935`), so without the mark, installations
  denying these types would show stale `lastWebhookAt` despite valid signed
  deliveries arriving; the inactive-deployment branch (`:786-793`) is the existing
  mark-before-return precedent. The per-space post-normalization gate is retained
  for finer filters.
  Sequenced after chain A PR A2's settings-preservation fix, and its filter writes
  use the same merge-preserved `settings` mechanism — never a from-scratch settings
  object.
- **PR B3 (transform/mapping):** pure projection
  `projectExternalEventPayload(config, event)` applied between gate and publish in
  `publishEvent` — field allow/deny projection of the payload, with
  `includeRawPayload: boolean` (default true for parity; the owner's "I only need
  this one and this field" is the opt-in). Projection is constrained to optional
  source-native data (review finding, PR #2723): a **mandatory reserved field set**
  — everything `formatExternalEventEssence` reads (`event-essence.ts:3-24`:
  `eventType`, `action`, `actor`, `repoOwner`, `repoName`, `prNumber`, `prUrl`,
  `body`, plus the per-type extras it copies) and the `replyHandle`/`resolveHandle`
  fields — can never be removed, so delivered messages keep basic context and agents
  keep the handles they need to respond — and compatibility with goal-automation
  subscriptions is enforced **against all stored GitHub-matchable subscriptions
  through the bidirectional write-time validation below, never by dynamically
  reserving active-filter keys** (review finding, PR #2723): a dynamic active-key
  reserved set would make persisted fields depend on goal status — pausing a goal
  could change what is stored, and resuming it could reactivate a filter whose key
  was omitted — contradicting the all-stored validation rule and §4's
  subscriber-driven prohibition.
  `findMatchingSubscription` calls `filterMatches(subscription.filter,
  event.payload)` directly against the persisted payload
  (`goal-automation-service.ts:308-316`), so removing a referenced key (e.g.
  `actorType`) silently stops the automation from enqueueing while topic routing
  still succeeds. Write-time validation of the projection config alone is
  **insufficient** (review finding, PR #2723): subscriptions are also written by
  independent paths — `evolution.scope.update` merges subscription-bearing policy
  patches with no knowledge of projection config (`mergeEvolutionPolicy`,
  `evolution-scope-service.ts:44`, `:263`) — so a later filter on an
  already-projected key would silently stop matching. Downstream pre-projection
  evaluation is **not implementable** at B3's placement (review finding, PR #2723):
  projection runs before `ExternalEventService.publish`, the bus payload is built
  from the canonical event's already-projected `payload`, and retryable duplicates
  republish only the stored row — no full payload exists downstream, and a
  transient side channel would not survive retries. B3 therefore uses
  **bidirectional write-time validation** (persistence stays deterministic —
  never subscriber-driven, per §4): projection writes validate against the keys
  referenced by **all stored subscription filters regardless of goal status, but
  only those that can match a projected GitHub event** (review findings, PR
  #2723): `onExternalEventPublished` reads only active goals'
  scopes, so a projection stripping key K while a goal is paused would activate
  that goal's unchanged filter on resume without ever passing a write validation
  (goal activation is itself a validation point inside the same per-space queue);
  and `findMatchingSubscription` excludes non-matching sources and topics
  *before* evaluating `event.payload` (`goal-automation-service.ts:312-315`), so
  subscriptions like `source: 'slack'` with Slack-only keys are unaffected by
  GitHub projection and must not veto it.
  Every subscription/policy write — including
  `evolution.scope.update`'s `mergeEvolutionPolicy` — validates against the active
  projection config, **rejecting** any filter **that can match a projected GitHub
  event and** references a key the projection
  would strip — the same matchability condition as the projection-write side
  (review finding, PR #2723): a `source: 'slack'` or non-matching-topic
  subscription whose keys collide with a GitHub deny-list key is never refused,
  since `findMatchingSubscription` could not evaluate it against a GitHub event
  (`:312-315`). Silent match-stop is unacceptable; an invalid filter is refused at
  creation instead. Both validation sides run **inside the same per-space mutation
  queue** (review finding, PR #2723): a projection write removing key K and a
  subscription write starting to filter on K can otherwise each validate against
  the old compatible state and then commit, leaving exactly the incompatible
  configuration the scheme promises to reject — the validation reads and the write
  must commit as one queued (or transactional) operation per space, riding the A2
  serialization rather than adding unsynchronized checks. Scope note (review finding, PR #2723): `rawPayload` is a single
  opaque key holding the entire native object (`:1119`), so top-level projection
  over it is all-or-nothing — B3 ships the binary `rawPayload` toggle plus
  top-level projection of non-reserved extras, and nested-path extraction mappings
  (dotted paths into `rawPayload`, e.g. labels or sender fields — the literal
  "this one field" ask) are an explicit follow-up PR with a safe path-expression
  vocabulary, not a B3 claim. B3 also updates the `get_external_event` tool
  descriptions (`space-agent-tools.ts`, `node-agent-tools.ts`), which promise a
  complete raw record including `rawPayload` — with `includeRawPayload: false`
  agents would deep-dive expecting source-native data projection intentionally
  discarded (review finding, PR #2723); the descriptions must state the payload is
  the stored, potentially projected one. This is the **P1 transform pipeline**
  pattern; it is also the moment the ADR's on-the-shelf `transformRun` idiom can earn
  extraction — but only if it is the ≈3rd real transform (github-normalizer
  composition, this projection, store delta application); otherwise a plain function,
  noted.
- **PR B4 (surface):** `space.github.setIngestionFilters`-style RPC + settings UI +
  "dropped by filter" health counters.
- **Explicitly out of scope / separate decision:** narrowing the GitHub-side hook
  subscription (`WEBHOOK_EVENTS :105-123`, `reconcileManagedWebhooks :2009`) from
  config — bigger savings (no HTTP delivery at all) but hook churn; not in PR 1.

### Chain C — structural refactors the map justifies (fold in opportunistically)

- **C1:** move the admission+projection decision out of the 3,129-line class into a
  thin `ingest(spaceId, event)` step — class stays shell (config + identity gather),
  core stays pure. Small; land with B2/B3 rather than standalone.
- **C2:** the on-the-shelf github-normalizer `transformRun` extraction (normalize →
  `mapEventType` → `toExternalEvent` as a P1 pipeline with `?dep` early exits) — only
  once B3 makes the second/third transform real.
- **C3 (decision item, not a PR):** two parallel GitHub paths with two filter systems
  (legacy `github_filter_configs` vs nothing on the new path). Recommendation: the
  new path is the keeper; mine the legacy filter UX/shape; retiring the legacy
  room-inbox path is its own chain.

## 4. Do-not-extract zones

- **`pollWatchedRepoCore` (`:2242-~2935`)** — cursor/watermark/ETAG/reaction-seen
  state machine; heavy owned mutable state with replay hazards. Gates sit after it
  emits `NormalizedGitHubEvent`, before publish. Leave opaque.
- **Signature verification loop (`:677-685`)** — security boundary; no config reaches
  it.
- **`ExternalEventStore.store` dedupe contract (`:93-146`)** — subtle
  ON CONFLICT/canonical-row semantics; filtered events simply never reach it. No
  changes needed.
- **Pilot-1 delivery cores + SpaceRuntime interpreter** — delivery-time by design;
  migrating ingestion filtering there re-pays persistence and DB writes.
- **Topic trie / subscription registration (`registerRunInterests :809`)** — keep
  ingestion filters strictly **config-driven**, never subscriber-driven: coupling
  ingestion to live subscription state would break the pure pub/sub design and the
  replay path (`:4611` replays from store, bypassing ingestion — must stay that way).

## 5. Bugs / races noticed (report only)

1. **Polling wedge on one poisoned event**: the poll cursor commits only at the end
   (`:2931/:2933`); any `publishEvent` throw mid-page aborts the whole cycle
   (`:2226` → `recordPollFailure`) with no cursor advance, so a persistently-throwing
   event re-fails that repo's poll forever.
2. **Stale-secret silent divergence — only for shared remote hooks**: two spaces
   watching the same repo with different `webhookSecret` values miss events only
   when their rows represent the **same remote hook** (`webhookRemoteId` — the
   auto-registration path shares one remote hook and propagates one secret to all
   references): of that hook's single delivery, only rows whose secret matches
   enter `signatureMatchedRepos` (`:677-685`, `:717-723`), and the other space
   silently misses events (no `lastWebhookAt` update, no error surfaced). Spaces
   with distinct manually-configured hooks each receive their own signed delivery
   and correctly match only their own (review finding, PR #2723) — so diagnose the
   divergence on shared `webhookRemoteId` only, never suggest unifying secrets
   across independent hooks.
3. **`rawPayload` unbounded** in `payload_json` and `get_external_event` responses —
   no truncation (storage + token cost; B3's projection is the fix, but the
   unbounded default deserves its own flag).
4. **Config TOCTOU in the webhook loop** (review finding, PR #2723): `getSpaceConfig`
   is awaited per repo inside the publish loop (`:728`); a space disabled after that
   read but before `publishEvent` still gets the event persisted — and the
   delivery-side gates do **not** catch it: `handleExternalEventImpl`
   (`space-runtime.ts:1605-1611`) filters subscription matches by space ownership
   only and never reads `SpaceExternalEventSourceConfig`, and the pilot-1 gates check
   subscription/task/session/pause state, not source enablement. The event can
   therefore be injected into a subscribed session of a just-disabled space.
   Mitigation: recheck **both the global and the space enablement state** at the
   ingestion choke point (review finding, PR #2723): `handleWebhook` reads
   `globallyEnabled` once at `:666-667` — before signature verification and
   potentially multi-page enrichment — and `stop()` does not cancel in-flight
   webhook handlers, so a handler that passed the initial read can still reach
   `publishEvent` after `externalEvents.extensions.setGlobalEnabled(false)` has
   completed; the seam chains A/B open in `publishEvent` rechecks **global
   enablement, space enablement, and watched-repository eligibility** — repo row
   still exists and the applicable `enabled`/`webhookEnabled`/`pollingEnabled`
   flags (review finding, PR #2723): `unwatchRepo` and per-repo mode toggles do
   not cancel in-flight handlers, which hold the pre-read `validForRepo` row and
   can otherwise insert and inject after the RPC returns, because global/space
   checks alone still pass. Repository mutations bump the admission epoch too,
   riding the same recheck — and the check must be **serialized with
   disablement** (review finding, PR #2723): a bare final read narrows but does
   not close the window (the webhook can observe both configs enabled, then the
   disable commits and returns before the insert executes; the settings queues
   serialize writers, not ingestion). The mechanism is **invalidate-and-await**,
   not a shared section with lifecycle (review finding, PR #2723): there is no
   cross-key "admission section" lock at all (review finding, PR #2723) —
   disablement writes the disabled config inside the queue, bumps the admission
   epoch/generation, and holds the source-config queue through the `stop()`
   await; each publisher's final epoch re-verify plus synchronous insert is one
   atomic event-loop step (synchronous JS between awaits), so no lock is needed
   around it and none may be held across a lifecycle await — a literal shared
   critical section held across `stopExtension` self-deadlocks (disable would
   hold it while awaiting `stop()`, which awaits `activePollCycle`
   (`:337`), and the poll cycle can be blocked in `publishEvent` waiting to
   enter it), while the per-dedupe-key section cannot synchronize disablement
   because a config mutation knows no dedupe keys. "Await" covers **in-flight
   webhook publishers too**, not only polling (review finding, PR #2723):
   `stop()` waits only for polling and reconciliation (`:333-339`), so a
   publisher that passed its final epoch check and inserted just before the bump
   can yield in `ExternalEventService._publishBusEvent`, letting the disable RPC
   return before that already-inserted event is broadcast and injected.
   Disablement tracks in-flight publications — an in-flight publisher set or a
   publish-completion hook on the ingestion seam — invalidates them via the
   epoch, then awaits their completion after the epoch write while holding only
   the source-config queue, never a publisher lock; publishers already past the
   re-verify complete their current publication, later ones observe the new
   config.
5. `normalizeGitHubWebhook` falls back to `Date.now()` for `occurredAt` (`:205`) —
   nondeterministic timestamps for malformed payloads (pre-existing).
6. ADR-0004 Pilot 5's gather-layer asymmetry applies here too: don't repeat the
   `approve_task` pattern of gathering identity/config before cheaper errors — keep
   identity resolution lazy so its async window only opens when suppression is
   enabled.
7. **`persistSpaceConfig` clobbers foreign per-space settings keys** (review finding
   on PR #2723): it rebuilds `settings` with only `pollingIntent` + `watchedRepos`
   (`github-event-extension.ts:1739-1772`) and `setSpaceConfig` replaces
   `settings_json` wholesale (`extension-config-store.ts:114-122`), so any other key
   is silently destroyed by the next watch/unwatch/toggle RPC (8 call sites: `:354`,
   `:368`, `:443`, `:455`, `:486`, `:506`, `:535`, `:653`). Load-bearing for chains
   A and B — the read-merge-write fix is scoped into PR A2. Global config has the
   same concurrency hazard (spread protects keys, not atomicity — `setGlobalConfig`
   also replaces `settings_json` wholesale, `:75-100`) and is **not** exempt: all
   `github` global config mutations route through the same PR's source-scoped
   queue (see chain A PR A2).
