# LiveQueryEngine two-tier evaluation — measured verdict (do not land)

Task #1154 (Track C2) asked for a cheap sentinel tier before full LiveQuery
re-evaluation, with an explicit escape hatch: _prefer not landing it if the
row-hashing change (#1135 / PR #2611) plus the query fixes already collapse
evaluation cost — close with measurements if so._ This report is that
measurement. The verdict: **the two-tier sentinel is a measured pessimization
for the queries it was designed to guard; do not land it.** Getting to a
trustworthy number also surfaced (and this PR fixes) a ~0.5–0.9 s
full-session-scan pathology in the per-evaluation background-task metadata
query that had silently reintroduced the very cost the earlier fixes removed.

## Harness

`packages/daemon/scripts/benchmark/live-query-evaluation.ts` drives the real
engine through the production `liveQuery.subscribe` handler (real
`MESSAGES_BY_SESSION_SQL`, `rowFingerprint`, `scopeFilter`, debounce, and the
`activeRegistry` `mapResult` that runs `BACKGROUND_TASK_METADATA_SQL` on every
evaluation) against a disposable copy of a production database. It
inserts/deletes its own benchmark rows and cleans up after itself.

```
cp -c /path/to/daemon.db /tmp/bench.db
bun packages/daemon/scripts/benchmark/live-query-evaluation.ts /tmp/bench.db
```

## Environment

- APFS copy-on-write clone of the production `daemon.db` (29 GB, 3,687,748
  `sdk_messages` rows; largest session 167,972 messages; 5,046 `sessions`
  rows).
- All numbers below were produced with the repository-pinned Bun 1.3.14; the
  metadata-query plan and timing were additionally cross-checked under Bun
  1.4.0 and agree (0.23 ms vs 0.20 ms full-metadata warm).
- An earlier draft of this report drove `LiveQueryEngine` from the base
  `NAMED_QUERY_REGISTRY` entry, which omits the `mapResult` metadata path —
  review correctly rejected those numbers. All numbers below are
  production-wired, and the harness now records every emitted
  snapshot/delta per scenario so "no delta" rows are observed rather than
  asserted.

## The metadata pathology found while re-measuring (fixed in this PR)

Driven through the production handler, `messages.bySession` evaluations
measured **540–880 ms** on the large session, ~99% of it in
`BACKGROUND_TASK_METADATA_SQL`: its `recent_metadata` CTE filters
`message_subtype_norm IN ('task_started','task_updated','task_notification')
ORDER BY timestamp DESC LIMIT 300`, and with no table statistics the planner
walked `idx_sdk_messages_session_timestamp_id` for the whole session reading
subtypes newest-first — never reaching the LIMIT because the session contains
only ~39 matching rows among 167,972. Measured in isolation: 838 ms.

The fix (this PR) splits `recent_metadata` into one `UNION ALL` arm per
subtype so each arm is a structural equality probe on
`idx_sdk_messages_session_subtype_parent`, and bounds each arm to its newest
300 rows (`SELECT * FROM (SELECT … ORDER BY timestamp DESC, rowid DESC LIMIT
300)`) before the outer merge re-applies the global 300-row limit — so a
task-heavy session's arm can never read its full metadata history:

|                                            | before     | after   |
| ------------------------------------------ | ---------- | ------- |
| `recent_metadata` arm                      | 838 ms     | 0.06 ms |
| full `BACKGROUND_TASK_METADATA_SQL`        | ~501 ms    | 0.22 ms |
| cold `messages.bySession` subscribe        | ~798 ms    | 44 ms   |

The existing sargability plan-test passes on tiny fixtures either way — the
planner only diverges at production scale, which is why this was invisible to
CI and worth a benchmark harness in-tree.

Dense-subtype check (the arms' `LIMIT 300` cannot be served by the subtype
index's ordering, so SQLite sorts each arm's matching rows): with 2,000 and
20,000 synthetic `task_updated` rows inserted into the large session, the
full metadata query costs 2.6 ms and 2.2 ms — the per-arm sort of small
status rows is linear but cheap. The old IN-list shape is actually fast in
the dense case (0.6 ms — it reaches its LIMIT quickly) and catastrophic only
in the sparse case; the new shape is uniformly sub-3 ms across both
densities, which is the profile we want.

## messages.bySession — evaluation cost after the fix (production wiring)

Window LIMIT 200 over the 167,972-message session, Bun 1.3.14, with the
delivered-event column showing what the harness actually observed emitted.
The first-subscribe row follows the session-discovery queries, so the page
cache is already warm; pass `BENCH_SESSION_ID`/`BENCH_SMALL_SESSION_ID` to
skip discovery and measure a genuinely cold cache:

| Scenario                                                     | Full evaluation        | Delivered              |
| ------------------------------------------------------------ | ---------------------- | ---------------------- |
| First subscribe (after discovery queries)                    | 34 ms                  | snapshot (200 rows)    |
| Warm no-op evaluation, steady state (n=10)                   | p50 3.6 ms, p95 4.7 ms | none                   |
| Same-session insert outside the window (irrelevant subagent) | 3.6 ms                 | none                   |
| Scoped `job_queue` change                                    | 3.6 ms                 | none                   |
| Different-session write                                      | 0 runs                 | none                   |
| Relevant in-window insert                                    | 5.8 ms                 | delta (+1/−1)          |
| `send_status` UPDATE on an old row outside the window        | 3.8 ms                 | none                   |
| Burst: 20 same-session writes inside one debounce window     | 3.7 ms, 1 run          | none                   |

Streaming load: during a sustained stream the triggering writes are relevant,
so the honest per-evaluation figure is the ~3.6–5.8 ms relevant/no-op range
rather than the no-op floor alone — at the 250 ms debounce that is up to 4
evaluations/s ≈ 2% of one core per actively streaming subscribed session.

## Sentinel candidates cost more than the evaluation they guard

| Sentinel candidate (scoped to the session)                          | Cost          |
| ------------------------------------------------------------------ | ------------- |
| `SELECT COUNT(*) FROM sdk_messages WHERE session_id = ?`             | 18–125 ms *   |
| `SELECT COUNT(*), MAX(rowid) FROM sdk_messages WHERE session_id = ?` | 24–80 ms *    |
| Aggregate digest of mutation columns over the whole session          | ~395 ms †     |
| `job_queue` active-row digest (full rows hashed — the sound shape)   | 0.01 ms       |

\* depending on page-cache state across runs; always a multiple of the ~4 ms
full evaluation. † 395 ms warm on the final harness run; 80–945 ms across
earlier runs and cache states — the harness reproduces both digest shapes.

The inversion is structural. The window query reads the ~200 newest rows plus
their subagent children via indexes, while any session-wide aggregate scans
all 167 k index entries — the LIMIT window _is_ what makes the full query
cheap, so a sound sentinel cannot be built from unbounded aggregates. A
window-bounded sentinel does not help either: `timestamp`, `send_status`, and
the other mutation columns sit after `sdk_message` in the row record, so
reading them walks the same overflow-page chains as reading the blobs, and
the sentinel must additionally cover the subagent set, the shutdown-boundary
row, and the active delivery jobs — at which point it is a duplicate of the
full query. Anything materially cheaper is unsound:

- `COUNT`/`MAX(rowid)` misses in-place `UPDATE`s (`send_status` transitions,
  job `retry_count`/`run_at` bumps) — these flip real UI state.
- `sessions` has no maintained `updated_at`; `MAX(last_active_at)` misses
  title/status/processing-state changes.

That is precisely the stale-sentinel bug class the task warned about.

One honest exception: for a `job_queue`-only trigger, the engine knows which
table changed, and a table-aware digest over the session's active delivery
jobs (the 0.01 ms scan above, hashed over full rows to stay sound against
`retry_count`/`run_at`/status updates) would be both cheap and sound, saving
the ~7 ms evaluation per queue transition. Measured against realistic traffic
the win is small — delivery transitions are session-scoped and occur a few
times per user turn, so the saving is well under 0.1% of a core — which does
not justify the per-table sentinel machinery today, but this is the one
two-tier shape that would become worthwhile if queue traffic grows.

### Qualification: the subagent portion is unbounded

The 200-row window bounds only the top-level rows; the `subagent` CTE returns
every child of every windowed tool use. The harness measures this directly,
case-isolated (each case's removals are settled in their own evaluation
before the next case is inserted, each case verifies the delivered delta
actually contains the inserted children, and the delivery stub reproduces
the production router's JSON serialization and 40 MiB outbound limit),
end-to-end including delta delivery: 500 / 5,000 small rows cost 8.5 /
50.2 ms of evaluation; 200 children × 50 KB (≈12 MiB delta) cost 117 ms and
are delivered; 1,000 children × 50 KB cost 464 ms of evaluation — including
a full outbound serialization that the router then refuses at 49 MiB > the
40 MiB limit, disposing the subscription exactly as production does. So the
fan-out tail is real (hundreds of ms of wasted evaluation) but ultimately
bounded by the transport: a pathological tool use manifests as a refused
delta and a lost live subscription rather than unbounded delivered cost.
The sound remedies remain structural — cap children per windowed tool use,
or paginate them — because a sentinel cannot help: a sound fan-out-shaped
sentinel must itself read the same children. Recommended as a follow-up
task; it does not rescue the aggregate sentinels either, which remain
unsound against in-place updates and cost 4–6× a normal evaluation.

## Coalescing

Two different ideas must be kept apart:

1. _Skip while a previous evaluation of the same entry is still running_ is
   impossible by construction: `evaluateQuery` runs the statement and hashing
   synchronously on the calling tick, so evaluations of one entry can never
   overlap.
2. _Trailing-edge debounce_ (reset the timer on every write, evaluate only
   once the stream goes quiet) is not what the engine does — the current
   debounce marks the entry on the first write and evaluates one
   latest-state snapshot per 250 ms window. During a sustained stream that is
   ~4 evaluations/s, which is deliberate: it is what keeps the transcript
   live while an agent streams. True trailing-edge coalescing would freeze
   the UI for the duration of the stream and only pay off when evaluations
   are expensive — at the measured 3.6–5.8 ms per evaluation (≈2% of a core
   at 4/s) there is nothing left to buy.

## Residual hot spot found while measuring (follow-up material, not engine work)

**`sessions.list` evaluations cost ~45 ms and are 100% predicate.**
Predicate-only `SELECT COUNT(*) ... WHERE humanSessionPredicate` measures
44.2 ms vs 44.9 ms for the full SQL (`json_valid` + `json_extract` over
4,936 non-null `session_context` values, 356 KB total); bare `COUNT(*)` is
0.02 ms. Every visible message save bumps `sessions.visible_message_count` →
a `sessions` change with `{ sessionId }` scope that passes the sessions.list
filter, so streaming in a human session drives up to ~6.6 × 45 ms ≈ 27% of a
core of pure no-op re-evaluation. A sentinel cannot fix this soundly (in-place
updates); the fix is query-shape work: narrow the predicate (type filter
first) or a partial / expression index matching the human-session predicate.
Recommend a separate task.

For completeness on the queue side: delivery-job transitions are already
session-scoped in production — `app.ts` installs a no-op change notifier on
the generic processor and forwards the delivery processor's per-job scope
(`scopeFromJob` in `job-queue-processor.ts` extracts `sessionId`/`taskId` from
the payload, and every message-delivery payload carries `sessionId`). The
scoped `job_queue` row in the table above therefore costs one ~5 ms
evaluation for that session's own subscribers only; no follow-up needed.

## Verdict

Do not land the two-tier sentinel. After the metadata-scan fix in this PR,
the production-wired evaluation it would guard costs ~3.6–5.8 ms while every
session-aggregate sentinel candidate costs 4–6× more (and the
mutation-column digest ~100× more); bursts coalesce into one evaluation per
debounce window; overlapping evaluations are impossible in a synchronous
engine; and every cheaper-than-the-query sentinel shape is unsound against
in-place updates, which is the exact missed-change failure the task forbade.
The one viable exception — a table-aware `job_queue` digest — is quantified
above and does not pay for its machinery at current traffic. The remaining
measured engine-adjacent costs (the sessions.list predicate, bounding the
subagent fan-out) are query-shape work and should be tracked as their own
tasks.
