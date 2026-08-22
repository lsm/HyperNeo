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
`INSERT … ON CONFLICT(space_id, source, dedupe_key) DO NOTHING`; duplicates re-publish
the canonical row. Delivery rows track per-target state; TTL sweep
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
   subscriptions** (store → later `ignored`/`ttl_expired`). By-design pub/sub, but it
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
  `publishEvent` — per event type × source, which actor field feeds `actor` (e.g.
  webhook `check_run` actor = sender; polling check_run actor = app;
  `issue_comment` = `comment.user ?? sender`), and that today **everything normalized
  for an enabled space is published**. No production change.
- **PR A2 (gate → flip):** new pure module
  `external-events/github/github-ingestion-gates.ts`:
  `decideIngestion({ event, selfLogin, config }) → admit | drop{reason:'self_event'}`.
  Per the pilot precedent, a single gate is a **pure function** — adopt `decisionRun`
  composition only when chain B adds more gates and order becomes contract. Shell:
  `publishEvent` (`:1731`) resolves the cached identity (lazy, keyed by credential
  fingerprint; reuse the `/user` validation result when fresh, never the
  error-carrying `lastTokenStatus`) and calls the gate **before**
  `publisher.publish` — before persistence, dedupe, and both bus subscribers
  (SpaceRuntime *and* goal-automation both save). Default **ON**, override via
  `suppressSelfEvents: false` in global then per-space `settings_json`.
  Case-insensitive login compare; document that polling-sourced self-activity is
  suppressed too, and that Bot actors (e.g. `github-actions[bot]`) never match a user
  token identity.
- **PR A2 also carries the settings-preservation fix (review finding on PR #2723):**
  `persistSpaceConfig` (`:1739-1772`) rebuilds the per-space `settings` object from
  only `pollingIntent` + `watchedRepos`, and `setSpaceConfig`
  (`extension-config-store.ts:114-122`) upserts `settings_json` wholesale — so any
  foreign key (the per-space `suppressSelfEvents` override included) would be
  silently wiped by any of the 8 RPC call sites that persist space config
  (`:354`, `:368`, `:443`, `:455`, `:486`, `:506`, `:535`, `:653`). Fix:
  read-merge-write — fetch the current space config and spread its `settings` under
  the two owned keys, so unknown keys survive. (Global config is already safe: all
  four global writers spread — `app.ts:153`, `rpc-handlers/index.ts:252`,
  `github-event-extension.ts:1636`/`:1649`.)
- **PR A3 (surface):** expose the toggle through the `space.github.*` config RPCs and
  `SpaceExternalEventsSettings` UI, plus a suppressed-count in the existing health
  snapshot (`GitHubHealthSnapshot.eventTypes` machinery at `:163-270`).

### Chain B — config-driven filter/mapping pipeline (admission + P1 transform)

- **PR B1 (pin):** pin `toExternalEvent` payload key sets per event type (incl.
  `rawPayload` presence) — the transform's parity baseline.
- **PR B2 (admission):** extend the ingestion gates with
  `eventTypeAllowed(config, event)` — per-space allow/deny lists over `eventType`
  (and optionally `action`), config resolved from the `settings_json` the webhook
  path already loads (`:728`); polling resolves once per space via
  `listEnabledSpaces`. Default config = allow-all (current behavior). Sequenced
  after chain A PR A2's settings-preservation fix, and its filter writes use the
  same merge-preserved `settings` mechanism — never a from-scratch settings object.
- **PR B3 (transform/mapping):** pure projection
  `projectExternalEventPayload(config, event)` applied between gate and publish in
  `publishEvent` — field allow/deny projection of the payload, with
  `includeRawPayload: boolean` (default true for parity; the owner's "I only need
  this one and this field" is the opt-in). This is the **P1 transform pipeline**
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
2. **Stale-secret silent divergence**: two spaces watching the same repo with
   different `webhookSecret` values — only rows whose secret matches the delivery
   signature enter `signatureMatchedRepos` (`:677-685`, `:717-723`); the other space
   silently misses events (no `lastWebhookAt` update, no error surfaced).
3. **`rawPayload` unbounded** in `payload_json` and `get_external_event` responses —
   no truncation (storage + token cost; B3's projection is the fix, but the
   unbounded default deserves its own flag).
4. **Config TOCTOU in the webhook loop**: `getSpaceConfig` is awaited per repo inside
   the publish loop (`:728`); a space disabled mid-loop still gets the event
   published (benign — delivery-side gates catch it).
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
   A and B — the read-merge-write fix is scoped into PR A2. Global config writers
   all spread and are not affected.
