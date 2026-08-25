# `sdk_messages` query and index audit

Date: 2026-08-23. Tree: `9416f212a`. Scope: production SQL in `packages/daemon`,
including repository reads and writes, LiveQuery statements, message-search admission and
rebuilds, delivery-watermark subqueries, dynamic cursor/status variants, reactive scope probes,
and migrations that run after the current schema exists.

This audit is schema-only. It did not read, sample, prune, or delete production rows. All plans and
timings below use deterministic synthetic rows in an in-memory database. The production sizes in
the task description are context only: 16.0 GiB for `sdk_messages`, about 5.6 GiB across its 11
measured B-trees, and 579 MB for `idx_sdk_messages_task_session`.

## Reproduce

```sh
bun packages/daemon/scripts/benchmark/sdk-message-index-audit.ts --classify
bun packages/daemon/scripts/benchmark/sdk-message-index-audit.ts
```

The tracked harness imports the canonical schema and the real LiveQuery registry, seeds 30,000
synthetic rows over 32 sessions with a 50% hot-session skew, runs `ANALYZE`, and compares the
current index set with `idx_sdk_messages_task_session` removed. It emits every distinct audited
`EXPLAIN QUERY PLAN`, the plans changed by the candidate, checksums, five fresh-process timing
samples, and medians.

Measurement host: Bun 1.4.0, SQLite 3.51.0, macOS x64, Intel Core i9-10910. The repository pins
Bun 1.3.14; CI remains authoritative for the pinned runtime. The local benchmark is directional,
not a claim that a 30,000-row memory database reproduces a 16 GiB disk-backed table. Larger
production B-trees increase cache pressure and make the avoided 579 MB index maintenance more,
not less, relevant.

## Complete production query inventory

The table below groups SQL variants only where their access path is the same. Dynamic placeholder
cardinality does not create a new index shape; timestamp-only and `(timestamp, rowid)` or
`(timestamp, id)` cursors do.

| Family | Production source | Distinct shapes | Synthetic plan |
| --- | --- | --- | --- |
| ID point access and writes | `sdk-message-repository.ts:203-212,309-313,361-367,438-477,987-1104,1110-1188,1344-1355,1658-1716`; `reactive-database.ts:166-206`; `sdk-message-status-plan.ts:77-136` | INSERT; `id = ?`; `id IN (...)`; ID-guarded UPDATE/DELETE; rowid hydration | PK autoindex or integer rowid; no table scan |
| Turn assignment | `sdk-message-repository.ts:404-421`; `sdk-message-status-plan.ts:71-76` | `MAX(turn) WHERE task_id = ?`; same plus `session_id = ?` | `task_turn`; `task_session_turn` |
| Renderable transcript | `sdk-message-repository.ts:521-557` | session/top-level/renderable/replacement anti-join, timestamp-rowid page with offset | `parent_tool_use_id` plus replacement target; bounded temp order |
| Session pages | `sdk-message-repository.ts:576-648` | latest; before timestamp; before timestamp-rowid; since timestamp; since timestamp-rowid; child tool-use `IN (...)` | `parent_tool_use_id`; child seek; bounded temp order for rowid |
| Background metadata | `sdk-message-repository.ts:652-753`; `live-query-handlers.ts:2912-3062` | subtype arms, terminal anti-join, task starts, latest progress window | `session_subtype_parent`; bounded/window temp order |
| Session type and latest/count | `sdk-message-repository.ts:756-844,1235-1315,1586-1629` | type; type+subtype; latest visible; visible count; assistant after ID timestamp; timestamp count | session timestamp, parent, UUID indexes; no table scan |
| User status | `sdk-message-repository.ts:931-1046,1191-1197`; `explain-sweep.ts:33-66` | count; user count; ordered rowid projection with optional limit; rowid hydration; ordered status list | `send_status_timestamp`; no temp order for timestamp-rowid FIFO |
| UUID and delivery | `sdk-message-repository.ts:987-1046,1255-1315,1442-1561,1696-1717`; `job-queue-repository.ts:424-433` | session+UUID; session+status+UUID; type+UUID; UUID `IN` + statuses; transition lookup | `session_uuid`; status/order predicates partially covered |
| Delivery watermarks | `sdk-message-repository.ts:1317-1402,1481-1519` | terminal success/intercepted/error outer scans plus inner session+UUID consumed-sequence lookup | parent index outer; session UUID inner; temp order for consumed sequence |
| Timestamp ranges and rewind | `sdk-message-repository.ts:1199-1233,1586-1630` | session timestamp `>`/`>=` read, delete, count; assistant after point watermark | `session_timestamp_id` plus PK subquery |
| HyperNeo actions | `sdk-message-repository.ts:1633-1717` | INSERT; unresolved session/type/subtype; ID update; session/type/UUID update | session UUID or session-leading residual filter |
| Search admission | `sdk-message-repository.ts:203-313` | ID hydration, status eligibility, pending enqueue guarded by ID existence | PK; no corpus scan |
| Search rebuild | `session-repository.ts:270-362` | one-session SELECT with JSON extraction, user-status policy, replacement anti-join, optional task join | session status/leading index plus replacement target |
| Search cleanup | `space-repository.ts:243-262`; `space-task-repository.ts:77-87` | IDs by task or task-in-space | task-leading index |
| Search reads | `sdk-message-repository.ts:1719-1857` | FTS rank or broad timestamp order with optional filters | projection/FTS tables, not `sdk_messages` |
| Task trace | `evolution-conversation-analysis-service.ts:149-193`; `evolution-trace-evidence-service.ts:221-257` | task/top-level/replacement/status, newest 1000 or 500, then chronological | task or parent-leading seek, bounded temp order |
| Space session cursor | `space-agent-tools.ts:725-774` | no cursor; timestamp cursor; timestamp+ID cursor | exact `session_timestamp_id` seek/order |
| Reactive task scope | `live-query-handlers.ts:3268-3335` | distinct sessions by task; task+session existence; sessions for workflow tasks | task-session composite covering seek |
| Replacement repair | `migrations.ts:8998-9050` | unnormalized rows by partial predicate, point updates, mark normalized | partial `unnormalized_replacements` index |
| Visible-count backfill | `migrations.ts:9161-9183` | correlated session/top-level/visibility count | parent session index |
| LiveQuery shutdown boundary | `live-query-handlers.ts:458-483` | task rows, partition by session, timestamp-ID descending | task-session access plus bounded sort |
| `actorMessages.byTask` | `live-query-handlers.ts:506-794` | materialized task SDK rows, replacement aggregation, settled-user and shutdown filters, timeline union | task/turn and parent indexes; bounded materializations/sorts |
| `taskMilestones.byTask` | `live-query-handlers.ts:887-1300` | slim task candidates, PK payload rehydration, instruction/answer/retry analysis | task/turn, replacement, PK |
| `sessionGroupMessages.byGroup` | `live-query-handlers.ts:1399-1519` | member-session rows, narrow user-turn windows, payload rejoin, event union | parent/session index and PK; window sort |
| `spaceTaskActivity.byTask` | `live-query-handlers.ts:1521-1785` | contributing task sessions; correlated per-session count/max | task-session covering seek; parent/status session probes |
| `spaceTaskMessages.byTask` | `live-query-handlers.ts:1849-2105` | task rows, shutdown and retry joins, user-turn window, GitHub union | task-session, parent, session UUID; bounded sorts |
| Compact task feed | `live-query-handlers.ts:2111-2426` | recent 100 turns, active-row exception, per-turn JSON ranking/summaries | `task_turn` then task-session access |
| Active turn | `live-query-handlers.ts:2428-2785` | compact base, latest per session, PK payload joins for user/assistant/hook/retry | `task_turn`, task-session access, PK |
| `messages.bySession` | `live-query-handlers.ts:3064-3193` | latest shutdown boundary, capped top-level rowid window, tool-use child hydration | parent/session-leading seeks; bounded rowid sorts |

Operational recovery SQL in `scripts/recover-messages.ts` and benchmark-only SQL are not daemon
runtime paths. They were reviewed separately and do not require a retained secondary index.

## Representative `EXPLAIN QUERY PLAN` results

The harness records 50 distinct plan shapes. These are the normalized results that determine index
classification; `USE TEMP B-TREE` is retained where rowid semantics or a bounded window requires it.

| Shape group | Selected `sdk_messages` indexes | Full table scan? | Temp order? |
| --- | --- | --- | --- |
| ID point/list/update | PK autoindex / integer rowid | no | no |
| task max / task-session max | `task_turn` / `task_session_turn` | no | no |
| session renderable/latest/before/since/count | `parent_tool_use_id` | no | bounded rowid pages only |
| child hydration | `parent_tool_use_id` | no | timestamp-rowid order |
| type/subtype and timestamp ranges | `session_timestamp_id` | no | no |
| status count/page | `send_status_timestamp` | no | no |
| UUID/status/type/transition/batch | `session_uuid` | no | ordered single-row variants only |
| terminal watermarks | parent outer + session UUID inner | no | consumed-sequence order |
| distinct task sessions / existence | `task_session` before; `task_session_turn` after | no | no |
| workflow task sessions | same covering replacement | no | DISTINCT only |
| replacement repair | partial unnormalized index | bounded partial-index scan | no |
| background metadata | `session_subtype_parent` | no | bounded/window order |
| session cursor tool | `session_timestamp_id` | no | no |
| task feeds/activity/active turn | task session/turn indexes plus PK/parent/status | no unbounded corpus scan | bounded windows/unions |
| messages by session | parent/session-leading index | no | bounded rowid window |

Dropping `idx_sdk_messages_task_session` changed only the index name in seven families:
`task.sessions-distinct`, `task.session-exists`, workflow task-session scope,
`spaceTaskActivity.byTask`, full/compact task feed, and active-turn feed. Every changed seek remains a
covering search on `idx_sdk_messages_task_session_turn`; no scan or new temporary B-tree appears.
All other audited plans are byte-for-byte unchanged.

## Index classification

`Partially covered` means a useful index still leaves a residual predicate or bounded sort. It does
not mean the index is redundant. In the table, `Required, partially covered` maps to the requested
`partially covered` classification while making the retention decision explicit.

| Index | Classification | Evidence |
| --- | --- | --- |
| `sqlite_autoindex_sdk_messages_1 (id)` | Required | ID point access, write guards, updates/deletes, and late payload rehydration |
| `session_timestamp_id` | Required | Type/timestamp reads and exact `(timestamp,id)` cursor order |
| `parent_tool_use_id` | Required, partially covered | Top-level/child separation and terminal/session scans; rowid ordering remains bounded |
| `renderable_terminal` | Required, statistics-sensitive | Historical post-`ANALYZE` plan selects it for renderable text; current synthetic skew selects parent index |
| `session_subtype_parent` | Required, partially covered | Background metadata arms seek exact subtype; timestamp-rowid windows sort after seek |
| `send_status_timestamp` | Required | Status counts and FIFO timestamp pages without a temp sort |
| `task_id` | Required, statistics-sensitive | Timestamp-ordered task feeds/traces; synthetic skew can prefer task-turn or parent paths |
| `task_session` | **Unused/redundant** | Strict left prefix of `task_session_turn`; every current plan switches to the wider covering index without scan/sort regression |
| `task_turn` | Required | Task-wide max turn and recent-turn windows |
| `task_session_turn` | Required | Per-session max turn hot write path; replacement for all task-session prefix queries |
| `session_uuid` | Required, partially covered | UUID/delivery lookups and watermark inner probes; status/consumed-sequence order remains residual |
| `unnormalized_replacements` | Required partial index | Startup/rollback reconciliation bounds work to unnormalized rows; normal steady state is intentionally empty |

No new delivery composite is added: session+UUID+status is only partially covered, but adding another
large B-tree would conflict with this task's write-amplification goal without production selectivity
evidence.

## Synthetic cost comparison

Five fresh processes per schema, medians in nanoseconds per operation. Samples included checksums
that matched across all runs.

| Operation | Baseline median | Without `task_session` | Delta |
| --- | ---: | ---: | ---: |
| raw prepared INSERT, transaction | 37,517.7 | 34,827.7 | -7.2% |
| latest 200-message hot-session page | 27,887,752.5 | 25,795,952.3 | -7.5% |
| ordered 200-row status page | 288,216.0 | 270,663.5 | -6.1% |
| session UUID point lookup | 2,461.8 | 2,220.0 | -9.8% |
| distinct task sessions | 25,743.0 | 24,331.8 | -5.5% |
| task/session existence | 1,127.3 | 1,168.8 | +3.7% |
| task/session max turn | 1,262.3 | 1,149.0 | -9.0% |

Unrelated SELECT differences are benchmark noise; their query plans do not change. The only
possible read tradeoff is scanning a three-column covering key instead of its two-column prefix for
distinct task sessions, and the synthetic samples did not measure a regression there. The raw
prepared INSERT excludes fixture generation and saves about 2.7 microseconds per row. Against the
reported 16 GiB table and 579 MB redundant index, the durable benefit is eliminating one B-tree
write and its cache/storage footprint; the synthetic percentage should not be extrapolated
linearly.

## Decision

Drop only `idx_sdk_messages_task_session`. It is completely redundant through left-prefix coverage
by `idx_sdk_messages_task_session_turn`. Retain all other indexes, including statistics-sensitive
and recovery-only partial indexes. Migration 210 performs only `DROP INDEX IF EXISTS`; it does not
update, delete, prune, or sample any `sdk_messages` row.
