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
`isOlderThanMessageSearchTtl` :80, `computeIsRenderable` :87, `computeIsTerminal`
:125, `extractParentToolUseId` :129, `extractSdkUuid` :134,
`extractReplacementEdges` :144 — are the started extraction. The three save
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

`getRenderableTextMessages` :628–684 (batched scan, 50/batch, max-250 cap,
inline filter gates); `_getSDKMessagesImpl` :686–852 (dynamic-cursor SQL builder
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
post-init) and :1026–1034 (`visibleMessageCountReady`). Added by #2614; pinned
by the `schema introspection caching` describe (test :3764).

### (e) Sessions-change notification

`notifySessionsChanged` :1064 → `reactiveDb.notifyChange('sessions')` (badge
re-eval in `spaceSessions.bySpace`); `'sdk_messages'` notifies flow from the
reactive proxy's `METHOD_TABLE_MAP` (`reactive-database.ts:236–263`) and from
`runPostSaveSideEffects` :1141.

## 2. Consumers and coupling constraints

- Everything goes through the facade (`storage/index.ts:217–378` delegates
  1:1) — internal extraction is invisible to consumers. Save-side callers hold
  the **proxied** DB (`app.ts:478–479` passes `reactiveDb.db` into
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
  `schema/index.ts:186–238`; `message_search_content` is written by three repos
  (`kind='task'` rows in `space-task-repository.ts:63–79`; space-deletion
  cleanup in `space-repository.ts:244–249`); `sessions.task_id` now generated
  columns (#2649).
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
  today), `markDeliveryFailedByUuid` exclusive variant (zero), the
  `type:'unknown'` parse-fallback table across every parsing reader, subagent
  page-composition order + `hasMore`-with-filtering semantics,
  duplicate-uuid-across-buckets reads (pin current arbitrary-pick in
  `hasTerminalResultAfter` and earliest-pick in `getUserMessageByUuid` as
  *current* behavior).
- **PR A2:** extract parse/inflate layer (`parseSdkMessageRow`, row-metadata
  attach used by :764–787, :821–839, :955–970, :1268–1284).
- **PR A3:** extract content/text projections (`extractVisibleText`,
  `extractToolCallNames`, user-content shaping from
  :1512–1537/:1858–1882/:1926–1957) + the renderable-text accept/skip predicate
  and scan-budget accounting (loop shell stays in the repo).
- **PR A4:** extract page composition (`collectToolUseIds` :793–803,
  `composeMessagePage` :842–851, `getUserMessagesByStatus` batch math).
- **PR A5 (cleanup + ADR note):** fold the three user-content shapers into one;
  delete the dead `extractAssistantText` alias (:1922–1924); ADR 0004 pilot
  note.

### Chain B — save-admission core (rank 2: highest impact, medium risk)

Pattern: plain pure core first (the save gates are independent derivations,
**not** a precedence chain — forcing `decisionRun` here would be shape-wrong;
ADR sanctions pure-function admission gates from pilots 1/5).
`updateMessageStatus` planning is the P7 transaction-sandwich shape.

- **PR B1 (test-only):** the cross-variant admission drift table — same message
  × `saveSDKMessage` / `saveUserMessageCore(sendStatus…)` /
  `saveHyperNeoActionMessage`: anchor conditions (incl. the deliberate
  status-gate divergence), badge counting, turn-index anchor/non-anchor
  assignment (:519–530), replacement-edge recording incl. the refusal-subtype
  gate, `consumed_seq` assignment; plus the
  `saveUserMessageCore`/`runPostSaveSideEffects` composition contract (real
  repo + reactiveDb, per the live-query test bootstrap).
- **PR B2:** extract `decideMessageAdmission(message, {variant, sendStatus,
  origin})` → one admission record (`isRenderable`, `isTerminal`,
  `isConversationAnchor`, `countsTowardsBadge`, `parentToolUseId`, `sdkUuid`,
  `replacementEdges`); the three save sites consume it; divergences become
  explicit parameters pinned by B1.
- **PR B3:** badge plan unification — pure `badgeDelta` derivation over
  admission records + the mutation paths (:589, :1136, :1362–1364, :1472–1477);
  interpreter applies.
- **PR B4 (apply):** `updateMessageStatus` as plan/interpret — pure planner
  over the pending-row snapshot producing the ordered update list (turn
  promotion, timestamp, `consumed_seq`), transaction shell applies.
- **PR B5 (cleanup + ADR note).**

### Chain C — FTS admission gates + delivery-status routing (rank 3: low risk, medium impact)

- **PR C1 (test-only):** direct unit pins for `extractSdkUuid`/
  `extractReplacementEdges` (helpers test covers 3 of 5 exports);
  flush-boundary characterization incl. delete-then-decide ordering
  (:304–313 — ineligible rows are deleted even when not re-inserted).
- **PR C2:** extract `message-search-admission.ts` as a real `decisionRun`
  (legitimate first-skip-wins precedence as implemented at :307–313:
  superseded → searchable-type → eligibility → body → user-status; runs ≤500
  rows per 2 s flush — off-hot-path, GO).
- **PR C3:** delivery-status routing table (`routeDeliveryTransition(
  currentStatus, action)` → status-window + target) collapsing the ten
  wrappers' windows into data; SQL stays (precedent: `task-transition-routing.ts`
  from Pilot 5).
- **PR C4 (cleanup + ADR note).**

## 5. Hot-path rule assessment

ADR benchmark: `decisionRun` 1,999–2,557 ns/op vs 75–194 ns/op if-cascade; GO
below ~10 µs/decision against dominated neighbor costs.

- **Save path — GO for gates.** One admission per persisted message; each save
  is one transaction with a turn-index SELECT, INSERT, and up to five auxiliary
  statements plus a WAL commit — ≥~100 µs typical, ms-scale at p99. A 2.6 µs
  admission core is ≤~3%. Gates sit at admission (per message), before the
  transaction opens.
- **FTS flush path — GO.** ≤500 rows per 2 s tick, each already paying SQL
  reads + `JSON.parse`; per-row `decisionRun` skip-reasons are noise.
- **Read-projection row loops — NO GATES.** `getRenderableTextMessages` scans
  ≤250 rows/call and `_getSDKMessagesImpl` inflates ≤limit rows; `JSON.parse`
  of a full `sdk_message` blob (~5–50 µs/row) dominates, and the ADR names
  tight loops as inline territory — per-row pipeline overhead (~2 µs/row ≈
  0.5 ms on a max scan) is the case it excludes. Per-row work stays plain
  function calls; pipeline composition, if ever, is per call, not per row.

## 6. Do-not-extract zones

1. **Raw SQL builders with pinned query plans:** `_getSDKMessagesImpl`
   :703–761, `getUserMessagesByStatus` :1162–1171, `searchMessages`
   :2080–2143, `getBackgroundTaskMessages` CTE :857–947, consumed-seq probes
   :1605–1647 — pinned by EXPLAIN QUERY PLAN tests (test :3036–3117) and the
   perf history (#2608–#2649).
2. **Schema introspection caches** :171–216, :1026–1034 — instance memoized
   state (resource-owning); pinned by the :3764 describe.
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
   `sdk-message-handler` :703–706 then skips the live UI delta (row appears
   only on reload).
2. **`hasTerminalResultAfter` :1616–1619** — the watermark subquery has no
   ORDER BY; with duplicate `sdk_uuid` rows across status buckets it can pick a
   NULL-`consumed_seq` row → NULL comparison → false negative at the delivery
   re-claim boundary — exactly the #2598 double-delivery class. Contrast
   `getUserMessageByUuid` :1554–1557 (deliberate earliest-wins).
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
`message-delivery-outbox.test.ts:181`). The reactiveDb path is exercised only
by `sdk-message-repository-live-query.test.ts` (132 lines) — B1 extends that
bootstrap.

## 9. Recommendation

Start with Chain A (A1 can start immediately; zero collision), then B, then C.
Chains are independent by construction (facade untouched); the only sequencing
note is against #2659 workerization for anything near `searchMessages`.
