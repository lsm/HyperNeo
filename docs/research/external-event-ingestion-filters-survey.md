# External-event ingestion: user-configurable filters/mappings + self-event suppression — survey & chain proposal

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

`external-events/github/github-normalizer.ts` (1,124 lines, pure, zero owned state):
`normalizeGitHubWebhook :142`, `normalizeGitHubPollingRow :363`, per-type normalizers
(`:479-1030`), topic mapping `mapEventType :1038`, and `toExternalEvent :1084` which
builds the persisted `ExternalEvent`. Every normalized event carries
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
config changes must not retroactively alter already-queued events.

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
  (webhook `sender`, or the artifact author only where the artifact *is* the action —
  comments, reviews, review comments, reactions), never on `actor` alone, and only
  for event kinds where the causal identity is reliable; polling `pulls` rows are
  excluded (initiator indeterminable), and polling comment rows are reliable **only
  for unedited rows** (`created_at === updated_at` — review finding, PR #2723): the
  poller requests the comment endpoints with `since` (`:2270-2274`, `:2317-2325`),
  so edits are emitted too, versioned by `updated_at` while `obj.user` remains the
  original author (`github-normalizer.ts:385`, `:397-403`) — another user's edit of
  a token-owner-authored comment would otherwise be dropped as self-originated.
  Edited rows carry initiator unknown. **Fail-open:** an event with no resolvable
  initiator is always admitted. Per the pilot precedent, a single gate is a **pure
  function** — adopt `decisionRun` composition only when chain B adds more gates and
  order becomes contract. Shell: `publishEvent` (`:1731`) reads the cached identity
  and gates **first observations only** (review finding, PR #2723): a `getByDedupe`
  lookup precedes the gate, and an existing canonical row — retryable (`published`)
  or terminal — bypasses the gate entirely and flows through the normal duplicate
  path. Without this, an event admitted and persisted while identity was unknown
  (fail-open) could be re-observed after the cache warms, classified as a
  self-event, returned as an intentional drop, and the polling cursor would advance
  without the retryable-duplicate republish (`_handleRetryableDuplicate`) —
  stranding the queued row; a filter change between attempts has the same effect,
  contradicting the invariant that config must not retroactively alter queued
  events. Genuinely new events are gated before persistence, dedupe-insert, and
  both bus subscribers (SpaceRuntime *and* goal-automation both save). The
  ingestion step returns `admitted | dropped{reason}` so callers report honestly
  (review finding, PR #2723): the three webhook paths increment `published` after
  every resolved call (`:732`, `:843`, `:933`) and would otherwise count suppressed
  deliveries as published (`spaces: 1` with nothing persisted); polling advances its
  watermarks for intentional drops so suppressed rows cannot wedge the cursor
  (bug 1). Default **ON**, override via `suppressSelfEvents: false` in global then
  per-space `settings_json` — and the minimal write RPC for that flag ships **in
  A2**, not A3 (review finding, PR #2723): `space.github.*` has no generic settings
  writer today (`listConfig` is read-only), so a default-on flip without a supported
  opt-out is not shippable. Case-insensitive login compare; Bot actors (e.g.
  `github-actions[bot]`) never match a user token identity.
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
  `github-event-extension.ts:1636`/`:1649`).
- **PR A3 (surface):** expose the toggle through the `space.github.*` config RPCs and
  `SpaceExternalEventsSettings` UI, plus a suppression counter with its own gate-side
  storage (review finding, PR #2723): the existing health `eventTypes` machinery
  derives from `ExternalEventStore.listEventCountsByTopic`
  (`github-event-extension.ts:1533-1558`), which never sees gate-dropped events, and
  its `TOPIC_SUFFIX_TO_HEALTH_TYPE` enum (`:172-194`) omits exactly the self-echo
  kinds (comments, reviews, reactions, PRs). Use an in-memory counter incremented at
  the gate — windowed retention, resets on restart (health display, not accounting) —
  surfaced on `GitHubHealthSnapshot` alongside `eventTypes`.

### Chain B — config-driven filter/mapping pipeline (admission + P1 transform)

- **PR B1 (pin):** pin `toExternalEvent` payload key sets per event type (incl.
  `rawPayload` presence) — the transform's parity baseline.
- **PR B2 (admission):** extend the ingestion gates with
  `eventTypeAllowed(config, event)` — per-space allow/deny lists over `eventType`
  (and optionally `action`), config resolved from the `settings_json` the webhook
  path already loads (`:728`); polling resolves once per space via
  `listEnabledSpaces`. Default config = allow-all (current behavior). Action
  filters are **webhook-only** (review finding, PR #2723): polling rows all carry
  the synthetic action `polled` (`normalizeGitHubPollingRow :411`), so an
  `issue_comment.created` allowlist on a polling-only space would drop every
  comment while allowing `polled` cannot distinguish creation from edit — a
  canonical cross-source action vocabulary is a future item, not B2. Also a coarse
  header-level pre-gate for enrichment-heavy types (review finding, PR #2723):
  `status`/`deployment`/`deployment_status` webhook handlers resolve associated PRs
  via REST (up to five pages — `resolveDeploymentPrNumbers :851-862`,
  `resolvePullRequestNumbersForCommit :951-985`) *before* normalization, so when
  every matched space denies the header event type, short-circuit before those
  calls — **and `markWebhookReceived` on all matched targets first** (review
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
  keep the handles they need to respond — **as must every key referenced by an
  active goal-automation subscription filter** (review finding, PR #2723):
  `findMatchingSubscription` calls `filterMatches(subscription.filter,
  event.payload)` directly against the persisted payload
  (`goal-automation-service.ts:308-316`), so removing a referenced key (e.g.
  `actorType`) silently stops the automation from enqueueing while topic routing
  still succeeds. Write-time validation of the projection config alone is
  **insufficient** (review finding, PR #2723): subscriptions are also written by
  independent paths — `evolution.scope.update` merges subscription-bearing policy
  patches with no knowledge of projection config (`mergeEvolutionPolicy`,
  `evolution-scope-service.ts:44`, `:263`) — so a later filter on an
  already-projected key would silently stop matching. B3 therefore mandates
  **pre-projection evaluation**: goal-automation filters run against the full
  pre-projection payload (review finding, PR #2723) — persisted payloads must not
  depend on transient subscriber state, since gathering live filter keys as a
  projection-time input would make persistence nondeterministic under identical
  config (adding/removing a subscription changes what is stored) and unrecoverable
  for subscriptions created later, contradicting §4's config-driven-only rule; a
  stable configuration-defined reserved field set is the fallback if pre-projection
  evaluation proves impractical. Silent match-stop is unacceptable. Scope note (review finding, PR #2723): `rawPayload` is a single
  opaque key holding the entire native object (`:1119`), so top-level projection
  over it is all-or-nothing — B3 ships the binary `rawPayload` toggle plus
  top-level projection of non-reserved extras, and nested-path extraction mappings
  (dotted paths into `rawPayload`, e.g. labels or sender fields — the literal
  "this one field" ask) are an explicit follow-up PR with a safe path-expression
  vocabulary, not a B3 claim. This is the **P1 transform pipeline**
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
   completed; the seam chains A/B open in `publishEvent` rechecks both
   immediately before persistence.
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
