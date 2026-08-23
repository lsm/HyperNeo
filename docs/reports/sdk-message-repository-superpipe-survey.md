# Survey: `sdk-message-repository.ts` — pilot-chain proposal (task #1249)

Analysis-only survey for the superpipe program (ADR 0004). Base: `origin/dev` @
`b6c5b36c2`. Target: `packages/daemon/src/storage/repositories/sdk-message-repository.ts`
(2,199 lines) — the message persistence & projection core; every message in the
product flows through it in both directions.

## 1. Sub-flow inventory (verified against current dev)

### (a) Save path — decide-then-write admission

| Unit | Lines | Notes |
| --- | --- | --- |
| `saveSDKMessage` | :533–599 | Derived flags (:536–549) → one transaction: turn-index resolve (:560), INSERT (:578), `consumed_seq` for terminal (:579–586), replacement edges (:587), FTS schedule (:588), badge bump (:589); post-commit: sessions notify (:591), superseded FTS delete (:592). Swallows all errors → `false` (:594–598). |
| `saveUserMessage` / `saveUserMessageCore` / `runPostSaveSideEffects` | :1068–1143 | Core is transaction-free so `message-delivery-outbox.ts:52–72` (#2598) can compose insert + job-queue enqueue in **one** transaction; side effects (`notifyChange('sdk_messages')` + sessions notify) run post-commit. |
| `saveHyperNeoActionMessage` | :1968–2004 | Third save variant; badge + turn-index + FTS schedule, no send_status. |
| `updateMessageStatus` | :1286–1368 | Status-transition engine: pending-user selection (:1294–1309), `sharedTurn` conversation-turn promotion (:1324–1359), `consumed_seq` assignment, badge recompute (:1362–1364), post-commit notifies + per-id FTS reschedule (:1366–1367). |
| Turn/task resolution | :479–531 | `resolveTaskIdForSession` (memoized via `reactiveDb`, #2615), `resolveConversationTurnIndex` (MAX+1 anchor / MAX non-anchor). |
| Badge maintenance | :1026–1062, :1064–1066 | `bumpVisibleMessageCount` (atomic +=), `recomputeVisibleMessageCount` (COUNT + conditional UPDATE), `notifySessionsChanged`. |
| Delivery-status family | :1686–1856 | Ten `markDelivery*`/`reopenDelivery*` wrappers: SELECT id by (session, uuid, status-window) → `updateMessageStatus`. Largest repetition mass in the file. |
| Mutators | :1370–1375, :1377–1428, :1430–1452, :1462–1502, :2020–2049 | Timestamp update, pending-message delete/defer, rewind deletes, hyperneo-action updates. |

Admission-seam fact: the module-top pure helpers — `isVisibleBadgeRow` :65,
`computeIsRenderable` :87, `computeIsTerminal`
:125, `extractParentToolUseId` :129, `extractSdkUuid` :134,
`extractReplacementEdges` :144 — are the started extraction. One near-miss:
`isOlderThanMessageSearchTtl` :80–85 reads `Date.now()` internally (:84), so it
is time-dependent, not referentially pure — any core consuming it (C2) must
take `now` as an injected input so the retention cutoff is deterministically
testable — and **every admission shell must supply one**, including the
synchronous fallback: when `message_search_pending` is absent,
`scheduleMessageSearchIndex` calls `upsertMessageSearchRow` directly
(:415–417), bypassing the flush pass, so gathering `now` only per flush would
leave that path either retaining an internal `Date.now()` or skipping
retention entirely. The three save
variants each re-derive subsets inline with one deliberate divergence:
`saveUserMessageCore` gates the conversation anchor on `sendStatus ∈
{consumed, failed}` (:1094–1097) while `saveSDKMessage` does not (:542). Pin,
don't silently unify.

### (b) Message-search FTS machinery

`upsertMessageSearchRow` :236–333 (introspection-gated joined SELECT → parse →
extract → DELETE-then-re-INSERT with gates at :307–313),
`isMessageSearchIndexEligible` :335–375 (pure row gate), `isMessageSuperseded`
:452, `isSearchableUserMessageStatus` :470, `scheduleMessageSearchIndex` :413
(pending-table insert; #2616 deferral, flushed every 2 s from the facade
`storage/index.ts:126,173–186` and at startup), `flushMessageSearchIndex`
:427–450 (per-row transaction, retry-on-fail), supersession deletes :377–411,
`searchMessages` :2051–2190 (broad-query rank policy, two-phase
candidate+snippet, dedup, order restore). Query path already workerized:
`message-search-worker.ts:26–33` constructs `new SDKMessageRepository(db)`
standalone on a readonly connection.

### (c) Read projections

`getRenderableTextMessages` :628–684 (batched scan, 50/batch, scan budget
`max(limit, 250)` — 250 is the floor, not the ceiling; the sole production
caller passes 24 (`space-agent-handlers.ts:20`), so 250 is today's effective
bound); `_getSDKMessagesImpl` :686–852 (dynamic-cursor SQL builder
:703–761, row-inflate loop :764–787, tool-use-id collection :793–803, subagent
second query + merge :805–851); `getBackgroundTaskMessages` :854–971 (3-arm
MATERIALIZED CTE, ROW_NUMBER progress dedup); `getSDKMessagesByType` :973,
`getLastSDKMessage` :996 (own exclusion list :57–61), `getSDKMessageCount`
:1014, `getUserMessagesByStatus` :1145 (projection + 900-row batched
hydration), status/uuid point lookups :1206–1266, `inflatePersistedMessage`
:1268, user-content readers :1504–1603, consumed-seq boundary probes
:1605–1647, `getAssistantMessagesSince` :1884 + text/tool-name extractors
:1922–1957, `countMessagesAfter` :1959.

### (d) Schema introspection caching

:171–216 (`tableExists`/`tableColumns`, never-invalidated — schema is fixed
post-init) and :1026–1034 (`visibleMessageCountReady`). Added by #2614.
Pin caveat: the `schema introspection caching` describe's counter (test :3773)
matches `sqlite_master` or `PRAGMA table_info`, while `tableColumns()` issues
`PRAGMA table_xinfo` (:205) — so `tableExistsCache` is pinned but
`tableColumnsCache` is not; the test stays green even if the column cache
regresses to per-save introspection. Fixing the counter to match
`table_xinfo` is PR 1 material for any chain touching the caches.

### (e) Sessions-change notification

`notifySessionsChanged` :1064 → `reactiveDb.notifyChange('sessions')` (badge
re-eval in `spaceSessions.bySpace`); `'sdk_messages'` notifies flow from the
reactive proxy's `METHOD_TABLE_MAP` (`reactive-database.ts:236–263`) and from
`runPostSaveSideEffects` :1141.

## 2. Consumers and coupling constraints

- The facade (`storage/index.ts:217–378` delegates 1:1) is the main path but
  **not the only one** — direct `SDKMessageRepository` consumers bypass it:
  `message-handlers.ts:66,137,176` and `state-projection-service.ts:424`
  construct `new SDKMessageRepository(db.getDatabase())` inline per call (no
  reactiveDb — these instances never notify), `space-runtime.ts:781` lazily
  constructs and caches an instance with reactiveDb, `message-search-worker.ts:29`
  constructs one standalone in the worker, and an operational path does too:
  `scripts/recover-messages.ts:276` builds a 1-arg instance and calls the
  public `recomputeVisibleMessageCount` (:280) — a notification-free
  authoritative recount the B3 surface must keep.
  Constructor and module-state changes are therefore *not* hidden behind the
  facade — the real contract is the 2-arg constructor plus a pure module top
  (zone 6). Save-side callers that do go through the facade hold the
  **proxied** DB (`app.ts:478–479` passes `reactiveDb.db` into
  `SessionManager` → `AgentSession`/`sdk-message-handler`/
  `message-persistence`); the proxy keys invalidation on **facade method
  names** — that surface is load-bearing and must not change.
- Save-side: `sdk-message-handler.ts:239,703` (wrapped in `withDbChangeBatch`
  reactive-transaction batching), `message-persistence.ts:198,224`,
  `message-delivery-outbox.ts:53,75` (composes `saveUserMessageCore` in its own
  transaction), `rpc-handlers/index.ts:775,840`, ACP `acp-query-runner.ts:1186`
  — ACP otherwise flows through the shared `messageHandler.handleSDKMessage`.
- Read-side: `message-handlers.ts:138–199` (RPC),
  `state-projection-service.ts:425–436` + `agent-session.ts:1110–1130`
  (rehydration), `rewind-handler.ts:436,513`,
  `sdk-session-file-manager.ts:428`, `space-agent-handlers.ts:88` (renderable
  text), `space-runtime.ts:5798,6997,7218` (`getLastSDKMessage` stall probes),
  `task-agent-manager.ts:2465`.
- LiveQuery does **not** use these projections — `messages.bySession` is
  separate raw SQL (`live-query-handlers.ts:3062`), with its own copy of the
  hidden-subtype exclusion list (:2867–2868 vs the repo's :50–53).
- Shared schema: `sdk_messages`/`sdk_message_replacements` DDL at
  `schema/index.ts:186–238`; `message_search_content` is written by four repos
  (`kind='task'` rows in `space-task-repository.ts:63–79`; space-deletion
  cleanup in `space-repository.ts:244–249`; and — a second production FTS
  *admission* implementation — `session-repository.ts:202–207` rebuilds a
  session's rows on status/type/context updates via
  `rebuildMessageSearchRows` :231, bulk delete+reinsert carrying its own
  copies of the supersession, message-type, user-status, session-retention,
  task-retention, and body rules (:231–295); the C-chain must include this
  owner in its parity scope or the extracted gates keep drifting against it);
  `sessions.task_id` now generated columns (#2649).
- Worker constraint: the repo must stay constructible as
  `new SDKMessageRepository(db)` with pure module-top state (no shared mutable
  module state in any extracted module).

## 3. Collision checks

- **#2660 / task ab83acb7 (live-query MATERIALIZED CTE rework): landed** via
  #2690 (`f80ab15fb`, merged to dev). The repo's read projections are distinct
  SQL from `MESSAGES_BY_SESSION_SQL`, so chains A/C have no file or query-plan
  collision. Remaining sequencing is against **#2659 workerization** (task
  `5ad71525`, in progress): keep the 2-arg constructor contract and pure module
  top; characterization PRs must not duplicate live-query parity suites.
- **ACP split (10 PRs; 3/10 and 8/10 in flight):** only touchpoint is
  `acp-query-runner.ts:1186` through the facade; chains keep the facade
  untouched → independent, can land anytime.
- **UI Pilot 6 (web message projections, open):** complementary (web Phase 5
  cores vs daemon read cores); no overlap.

## 4. Proposed pilot chains (ranked by impact-per-risk)

### Chain A — read-projection pure cores (rank 1: lowest risk, strong existing pins)

Pattern: P1 as **plain exported pure functions**. No per-row pipelines (see
§5); no `transformRun` — the candidate idiom is unmet rule-of-three (only
`decisionRun` exists in production; `stagedRun`/`transformRun` not yet
promoted). New module `sdk-message-projections.ts` beside the repo.

- **PR A1 (test-only):** fill characterization gaps —
  `getAssistantMessagesSince` (zero coverage), `getUserMessageContentByUuid`
  (zero), `updateHyperNeoActionMessageByUuid` behavior (only EXPLAIN-pinned
  today), `markDeliveryFailedByUuid` exclusive variant (zero), a per-reader
  malformed-row policy table — the policies differ observably:
  `_getSDKMessagesImpl` :770, `getBackgroundTaskMessages` :961, and
  `inflatePersistedMessage` :1277 synthesize `type:'unknown'`;
  `getRenderableTextMessages` :666–668 skips the row; `getSDKMessagesByType`
  :993 and `getUserMessages` :1513 throw; `getUserMessageContentByUuid` :1575
  and `getDeliveryContent` :1600 return null — pin each outcome explicitly so
  the A2 parse layer preserves rather than normalizes them, subagent
  page-composition order + `hasMore`-with-filtering semantics,
  duplicate-uuid-across-buckets reads — characterize the *ambiguity*, not a
  specific pick: the unordered `LIMIT 1` watermark subqueries
  (`hasTerminalResultAfter` :1616–1619, `getErrorTerminalResultSubtypeAfter`
  :1638–1641) have no stable result to pin — with duplicate uuid rows SQLite
  may return either the NULL or non-NULL `consumed_seq` row as indexes or
  plans change, so a test asserting one outcome would encode the race and
  flake; assert only that both duplicate layouts expose the either/or outcome
  (the bug-#2 ambiguity) — and note `getUserMessageByUuid` :1554–1557 is
  earliest-wins *only under distinct timestamps*: its SELECT has no ORDER BY,
  so duplicate rows tied at the same millisecond keep whichever row SQLite
  returned first; treat the tie as another characterized ambiguity, or define
  the `(timestamp, rowid)` tie-break in the fix before pinning an outcome.
- **PR A2:** extract parse/inflate layer (`parseSdkMessageRow`, row-metadata
  attach used by :764–787, :821–839, :955–970, :1268–1284).
- **PR A3:** extract content/text projections (`extractVisibleText`,
  `extractToolCallNames`, user-content shaping from
  :1512–1537/:1858–1882/:1926–1957) + the renderable-text accept/skip predicate
  and scan-budget accounting (loop shell stays in the repo).
- **PR A4:** extract page composition (`collectToolUseIds` :793–803,
  `composeMessagePage` :842–851, `getUserMessagesByStatus` batch math).
- **PR A5 (cleanup + ADR note):** share the user-content shapers' *identical*
  block-extraction primitive with an explicit policy parameter — do not fold
  them into one unparameterized shaper: `getUserMessages` :1512–1537 and
  `parseUserMessageRow` :1858–1882 return only the first text block with its
  whitespace preserved, while `extractVisibleText` :1926–1942 joins every text
  block with blank lines and trims — a direct fold changes output for
  multi-block or whitespace-padded messages; A1 characterizes the distinction
  first; delete the dead `extractAssistantText` alias (:1922–1924); ADR 0004
  pilot note.

### Chain B — save-admission core (rank 2: highest impact, medium risk)

Pattern: plain pure core first (the save gates are independent derivations,
**not** a precedence chain — forcing `decisionRun` here would be shape-wrong;
ADR sanctions pure-function admission gates from pilots 1/5).
`updateMessageStatus` planning is the P7 transaction-sandwich shape.

- **PR B1 (test-only):** admission drift pins, split by accepted message type —
  `saveSDKMessage` and `saveUserMessageCore` share the `SDKMessage` input, but
  only `saveUserMessageCore` has a status axis: `saveSDKMessage(sessionId,
  message, origin?)` takes no send status (badge evaluates `sendStatus: null`
  :548; the INSERT omits the column, so the schema default `'consumed'`
  applies) and contributes **one fixed-status row** — the five send statuses
  cross only `saveUserMessageCore` (anchor conditions incl. the deliberate
  status-gate divergence, badge counting, turn-index anchor/non-anchor
  assignment :519–530, replacement-edge recording incl. the refusal-subtype
  gate, `consumed_seq` assignment — including the divergence:
  `saveSDKMessage` allocates `consumed_seq` for terminal results (:579–586),
  while `saveUserMessageCore` leaves it NULL at insert (:1106–1137 perform
  insert + side effects only; the user path allocates only at the consumed
  flip, :1356–1358) — B2 must encode this as a variant parameter so the
  shared `isTerminal` admission field cannot allocate a sequence on the user
  path and shift the consumed-seq boundary probes).
  `saveHyperNeoActionMessage` takes the disjoint `HyperNeoActionMessage` type,
  so no single valid message crosses all three APIs — its fixed-shape
  admission (badge, turn index, no send_status) is pinned in a separate table,
  with no unreachable cross-type combinations; plus the
  `saveUserMessageCore`/`runPostSaveSideEffects` composition contract (real
  repo + reactiveDb, per the live-query test bootstrap).
- **PR B2:** extract `decideMessageAdmission(normalizedInput, {variant,
  sendStatus, origin})` → one admission record (`isRenderable`, `isTerminal`,
  `isConversationAnchor`, `countsTowardsBadge`, `parentToolUseId`, `sdkUuid`,
  `replacementEdges`); the shared normalized input that lets the three save
  sites — the two `SDKMessage` variants and the disjoint
  `HyperNeoActionMessage` shape — consume one core is introduced here, not in
  B1; divergences become explicit parameters pinned by B1. Placement is
  per-variant as today: the SDK variant computes the record before its
  transaction (:536–549 ahead of :559), while the user variant computes it
  *inside* the composed transaction (wrapper :1074–1076; outbox :52–53) — B2
  does not relocate the computation; doing so later would be an explicit
  plan-input change at both callers.
- **PR B3:** badge plan unification — an instruction set, not one derivation:
  saves emit `delta(+1)` over the admission record (:589, :1136,
  `saveHyperNeoActionMessage`'s bump+notify :1997–2001 — B2 routes this third
  save variant through the shared record, so its badge effect belongs in the
  unified interpreter too); the status-flip recompute (:1362–1364), *both*
  rewind operators — `deleteMessagesAfter` :1472–1477 and
  `deleteMessagesAtAndAfter` :1492–1499 — and `deletePendingUserMessage`'s
  recount (:1415) emit a **recompute instruction** (authoritative `COUNT(*)` +
  conditional update, which also repairs pre-existing counter drift), never
  delta subtraction: subtracting only the removed rows would leave prior
  drift — from bypass writes or an older buggy counter — intact, a behavior
  change. The `deletePendingUserMessage` site carries a notification nuance
  to pin: it recomputes but, unlike the rewind paths, emits **no** sessions
  notification today — the unified interpreter must not accidentally add one.
  `recomputeVisibleMessageCount` also stays public and notification-free for
  the recovery script (`scripts/recover-messages.ts:276–280`). Interpreter
  applies.
- **PR B4 (apply):** `updateMessageStatus` as plan/interpret — the pure
  planner over the pending-row snapshot produces the ordered instruction list
  (timestamp updates, and *allocation instructions* for both sequence axes —
  concrete values never appear in the plan: without `options.consumedSeq` the
  interpreter invokes the atomic `nextConsumedSeq()` inside the open
  transaction, as today at :1357, and turn promotion likewise reads the
  current `MAX(conversation_turn_index)` per task — including the shared-turn
  base map — inside the transaction (:1326–1352); pre-transaction allocation
  of either axis would make planning effectful or let a concurrent writer
  advancing the same task invalidate the plan); the transaction shell applies,
  revalidating every planned row first: each applied transition carries an
  expected-status guard (`… AND send_status IN (<planned-from statuses>)`) so
  a concurrent delivery change between snapshot and apply fails that row
  instead of executing stale timestamp/turn/sequence instructions — the
  read → plan → CAS-within-transaction → apply contract of ADR Phase 4
  (`docs/adr/0004-superpipe-decision-pipelines.md:701–703`). Today's
  unconditional `WHERE id IN` update keeps this window theoretical only
  because the connection is synchronous and single-threaded; the
  plan/interpret boundary must not widen it.
- **PR B5 (cleanup + ADR note).**

### Chain C — FTS admission gates + delivery-status routing (rank 3: low risk, medium impact)

- **PR C1 (test-only):** direct unit pins for `extractSdkUuid`/
  `extractReplacementEdges` (helpers test covers 3 of 5 exports);
  flush-boundary characterization incl. delete-then-decide ordering
  (:304–313 — ineligible rows are deleted even when not re-inserted); and the
  delivery-transition window matrix C3 depends on — the status-by-action
  accepted windows for all ten wrappers (direct repo coverage is missing for
  `reopenDeliveryByUuid` and `markDeliveryDeferredByUuid`, and the
  `markDeliveryFailedByUuidInclusive` pin checks only that `deferred` is
  excluded, not its full window) plus the batch-semantics split — the
  turn-end variants' first-uuid all-or-nothing rule (:1763) vs the per-uuid
  skip of the bulk variants (:1788, :1808) — plus the turn-end *result
  prerequisite*: without a matching top-level success terminal result whose
  `consumed_seq` is non-NULL, `markDeliveriesConsumedAtTurnEnd` returns empty
  before inspecting any delivery status (:1742–1751), and when it exists,
  every consumed delivery reuses that exact sequence (:1769–1772) — so C3
  cannot drop the prerequisite or allocate unrelated sequences without a
  failing pin; and the dbId-keyed `deferEnqueuedUserMessage` (:1430–1452,
  called directly at `agent-session.ts:696`) — the same
  `enqueued → deferred` transition as its uuid-keyed sibling, so C3 routes it
  through the shared rule while preserving its distinct lookup and return
  shape; and the FTS malformed-shape pins, which cover two *distinct*
  outcomes — body extraction runs first (`extractVisibleSearchText` at
  :297–303, before the DELETE at :304–306 and all gates at :307–313), so a
  JSON-valid but invalid SDK payload (e.g. `null`) throws inside the flush
  transaction, which rolls back and retains the pending row for retry, while
  syntactically invalid JSON hits the parse catch (:297–301), returns
  normally *before* the old-row delete, and the flush then removes the
  pending entry — a previously indexed row keeps stale FTS content with no
  retry. Pin both; a gate-first reorder or a moved parse would silently turn
  one policy into the other.
- **PR C2:** extract `message-search-admission.ts` as a real `decisionRun`
  (legitimate first-skip-wins precedence among the gates at :307–313:
  superseded → searchable-type → eligibility → body-nonempty → user-status —
  but body *gathering* stays ahead of the delete/decision boundary, where it
  runs today (:297–303), because its throw-on-malformed behavior is what
  retains the pending row for retry; runs ≤500 rows per 2 s flush +
  synchronous fallback — off-hot-path, GO).
- **PR C3:** delivery-status routing table (`routeDeliveryTransition(
  currentStatus, action)` → status-window + target) collapsing the ten
  wrappers' windows into data; SQL stays (precedent: `task-transition-routing.ts`
  from Pilot 5).
- **PR C4:** session-rebuild parity — `SessionRepository.rebuildMessageSearchRows`
  (:231–295) is the second production FTS admission implementation; parity-test
  its bulk SQL's admission outcomes against the extracted gates on identical
  inputs, then either route its WHERE policy through the shared predicates or
  record the residual duplication as deliberate. One clock for TTL parity:
  the rebuild evaluates retention with SQLite's `strftime('now')` /
  `unixepoch('now')` (:242, :285) while the extracted core receives an
  injected `now` — parameterize the rebuild cutoff from that same injected
  time before asserting parity, or clock advance/precision differences
  between JS and SQLite produce false parity failures (or miss real boundary
  mismatches). Without this step the extracted gates keep drifting against
  the second implementation.
- **PR C5 (cleanup + ADR note).**

**C4 outcome (2026-08-23):** the rebuild's WHERE policy now interpolates the
vocabulary exported from `message-search-admission.ts` (searchable types,
room prefixes/types, terminal task statuses, retention TTL) and takes one
injected clock — `updateSession`'s optional third parameter — from which
both retention cutoffs are bound as millisecond parameters (ms-exact and
NULL-keeping, matching `isOlderThanMessageSearchTtl`), replacing SQLite's
`'now'`. Parity is pinned by
`tests/unit/4-space-storage/storage/session-search-rebuild-parity.test.ts`,
which drives the real rebuild and asserts the indexed set equals
`decideMessageSearchAdmission` over identical rows, including TTL-boundary,
sub-second-in-second, and terminal-task-null-timestamp rows (the last two
were real divergences: second-truncated SQL kept rows the core rejected, and
the old `COALESCE(..., 0)` task cutoff rejected null-timestamp terminal
tasks the core keeps; the rebuild also indexed empty-body rows the core's
body gate skips, admitted room-prefixed ids typed as Space sessions, and
dropped self-supersession edges — all now aligned). The residual duplication
is deliberate: the rebuild stays a set-based `INSERT ... SELECT` (one DELETE
plus one INSERT per session flip) rather than a per-row JS loop over the
shared predicates; its supersession match keeps the codebase-wide
`COALESCE(sdk_uuid, id)` fallback; and its body assembly stays SQL
`GROUP_CONCAT`, where non-string text/thinking scalars (and non-ASCII
whitespace-only bodies) can still diverge from `extractVisibleSearchText`
for malformed-content rows.

## 5. Hot-path rule assessment

ADR benchmark: `decisionRun` 1,999–2,557 ns/op vs 75–194 ns/op if-cascade; GO
below ~10 µs/decision against dominated neighbor costs.

- **Save path — GO for gates.** One admission per persisted message; each save
  is one transaction with a turn-index SELECT, INSERT, and up to five auxiliary
  statements plus a WAL commit — ≥~100 µs typical, ms-scale at p99. A 2.6 µs
  admission core is ≤~3%. Gates sit at admission (per message); on the SDK
  variant that is before the transaction opens (:536–549 ahead of :559),
  while the user variant computes admission inside its composed transaction
  today (:1074–1076; outbox :52–53) — pure either way, and B2 keeps each
  variant's placement rather than relocating it.
- **FTS flush path — GO.** ≤500 rows per 2 s tick, each already paying SQL
  reads + `JSON.parse`; per-row `decisionRun` skip-reasons are noise.
- **Read-projection row loops — NO GATES.** `getRenderableTextMessages`' scan
  budget is `max(limit, 250)` (:649) — 250 is the floor, and a caller-supplied
  limit above it raises the budget 1:1 (the sole production caller passes 24,
  so 250 is today's effective ceiling). `_getSDKMessagesImpl`'s top-level
  query inflates ≤limit rows, but its subagent second query (:810–839) has no
  LIMIT and parses every row matching the page's tool-use ids — one top-level
  assistant message can fan out to thousands of subagent rows even at
  `limit = 1`, so the inflation bound is `limit + unbounded subagent
  fan-out`, not `limit`. `JSON.parse` of a full `sdk_message` blob (~5–50
  µs/row) dominates, and the ADR names tight loops as inline territory —
  per-row pipeline overhead (~2 µs/row ≈ 0.5 ms at the 250-row floor, scaling
  linearly with rows actually scanned) is the case it excludes. Per-row work
  stays plain function calls; pipeline composition, if ever, is per call, not
  per row.

## 6. Do-not-extract zones

1. **Raw SQL builders (hand-tuned, sargable):** `_getSDKMessagesImpl`
   :703–761, `getUserMessagesByStatus` :1162–1171, `searchMessages`
   :2080–2143, `getBackgroundTaskMessages` CTE :857–947, consumed-seq probes
   :1605–1647 — protected by the perf history (#2608–#2649), **not** by
   query-plan tests: the EXPLAIN describe (test :3036–3117) pins only the
   three uuid lookups (`getMessageByStatusAndUuid`, `getUserMessageByUuid`,
   `updateHyperNeoActionMessageByUuid`). Adding EXPLAIN coverage for the
   builders listed here is PR 1 material for chains A/C so refactors cannot
   silently change their access plans.
2. **Schema introspection caches** :171–216, :1026–1034 — instance memoized
   state (resource-owning); only partially pinned — see the §1(d) counter
   caveat (`tableColumnsCache` has no effective pin until the counter matches
   `table_xinfo`).
3. **Transaction shells + notify ordering** (:559–592, :1074–1077, :1321–1365,
   :1741–1774) — atomicity stays in the class (ADR atomicity-delegation rule);
   the outbox depends on `saveUserMessageCore` remaining transaction-free.
4. **`nextConsumedSeq` :1649** — atomic `UPDATE…RETURNING` primitive; exactly
   what effect stages call, never inline into pipelines.
5. **Reactive-proxy method-name surface** (`reactive-database.ts:229–278`) —
   the invalidation contract.
6. **Worker construction contract** — 2-arg constructor, pure module top.

## 7. Bugs / races noticed — report only (do not fold into pilots)

1. **`saveSDKMessage` :591–597** — an exception in the *post-commit*
   notify/superseded-FTS-delete returns `false` after the row is committed;
   `sdk-message-handler` :703–706 then skips the explicit
   `state.sdkMessages.delta` publish. The row still reaches the web without a
   reload: the save went through the reactive proxy, whose wrapper emits the
   `'sdk_messages'` notification after the call returns regardless of the
   `false` result (`reactive-database.ts:370–377`), and `withDbChangeBatch`
   commits that notification — `messages.bySession` re-evaluates and picks up
   the committed row. What is lost is the delta push plus the downstream
   `sdk.message`/tool-result events behind the early return.
2. **`hasTerminalResultAfter` :1616–1619 and
   `getErrorTerminalResultSubtypeAfter` :1638–1641** — both watermark
   subqueries have no ORDER BY; with duplicate `sdk_uuid` rows across status
   buckets either can pick a NULL-`consumed_seq` row → NULL comparison → false
   negative at the delivery re-claim boundary — exactly the #2598
   double-delivery class (and, for the error probe, a missed terminal-error
   subtype). Contrast `getUserMessageByUuid` :1554–1557 (deliberate
   earliest-wins). Any fix and its regression coverage must scope to both
   probes.
3. **`getSupersededMessageUuids` :384–395** lacks the `model_refusal_fallback`
   subtype gate that `extractReplacementEdges` :162 applies — FTS supersession
   deletes and recorded replacement edges can diverge for non-refusal carriers
   of `retracted_message_uuids`.
4. **Proxied `saveUserMessage` double-notifies `'sdk_messages'`** (proxy map
   :240–243 + `runPostSaveSideEffects` :1141) — absorbed by debounce/
   `withDbChangeBatch`, wasted LiveQuery re-runs otherwise.
5. **`deleteMessagesAfter`/`deleteMessagesAtAndAfter` :1462–1502** —
   operator-only near-duplicates (drift-prone; a shared private, not an
   extraction).
6. **`flushMessageSearchIndex` :447** counts failed rows as processed (return
   value currently unused — cosmetic).

## 8. Test-coverage base for PR 1 pins

`sdk-message-repository.test.ts` (3,829 lines; in-memory bootstrap :54–101,
per-test FTS/policy-table helpers, badge COUNT-oracle :1274–1298, EXPLAIN pins
:3036–3117) already characterizes most of the save/FTS/pagination surface —
PR 1s are gap-fills per chain, not from-scratch harnesses. Gaps confirmed: the
members named in A1/C1, plus the
`saveUserMessageCore`/`runPostSaveSideEffects` contract (only stubbed in
`message-delivery-outbox.test.ts:181`). The reactiveDb path is exercised by
`sdk-message-repository-live-query.test.ts` (132 lines) and by
`task-id-resolution-cache.test.ts:107–228` (saves through `reactiveDb.db`,
asserts scoped `'sdk_messages'` notifications, and covers taskId-cache
invalidation across session update, deletion, and transaction abort) — B1
extends the appropriate harness rather than duplicating setup.

## 9. Recommendation

Start with Chain A (A1 can start immediately; zero collision), then B, then C.
Chains are independent by construction (facade untouched); the only sequencing
note is against #2659 workerization for anything near `searchMessages`.
