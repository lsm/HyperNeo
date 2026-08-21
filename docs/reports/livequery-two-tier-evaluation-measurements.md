# LiveQueryEngine two-tier evaluation — measured verdict (do not land)

Task #1154 (Track C2) asked for a cheap sentinel tier before full LiveQuery
re-evaluation, with an explicit escape hatch: _prefer not landing it if the
row-hashing change (#1135 / PR #2611) plus the query fixes already collapse
evaluation cost — close with measurements if so._ This report is that
measurement. The verdict: **the two-tier sentinel is a measured pessimization
for the queries it was designed to guard; do not land it.**

## Environment

- APFS copy-on-write clone of the production `daemon.db` (29 GB, taken
  2026-08-20 for the earlier benchmark report; same corpus as the 0.77–1.96 s
  pre-fix baseline).
- 3,687,748 `sdk_messages` rows; largest session 167,972 messages; 5,046
  `sessions` rows.
- The real engine and the real queries: `LiveQueryEngine` driven directly with
  `MESSAGES_BY_SESSION_SQL` / `SESSIONS_LIST_SQL` from `NAMED_QUERY_REGISTRY`,
  including their production `rowFingerprint`, `scopeFilter`, and debounce
  options. Timings probe `runQuery` (SQL only) and `evaluateQuery` (SQL + hash
  + diff). Bench scripts: `/tmp/hyperneo-bench/two-tier-bench.ts`,
  `stability-bench.ts`, `sessions-list-bench2.ts`.

## messages.bySession — evaluation cost after #2611 + query fixes

Window LIMIT 200 over the 167,972-message session (200 top-level rows plus
subagent children of the windowed tool uses):

| Scenario                                                     | Full query | Notes                    |
| ------------------------------------------------------------ | ---------- | ------------------------ |
| Cold subscribe (first run, page cache cold)                  | 730 ms     | once per subscription    |
| Warm no-op evaluation, steady state (n=10)                   | p50 3.8 ms, p95 4.9 ms | 0 deltas delivered |
| Same-session insert outside the window (irrelevant subagent) | 13 ms      | correctly no delta       |
| `job_queue`-only touch (unscoped change event)               | 7.3 ms     | correctly no delta       |
| Different-session write                                      | 0 runs     | scope filter skips       |
| Relevant in-window insert                                    | 7.2 ms     | delta delivered          |
| Burst: 20 same-session writes inside one debounce window     | 7.1 ms, 1 run | debounce coalesces all 20 |

Pre-fix baseline for the same query was 770–1,960 ms per evaluation. The
combination of the CTE restructuring (PR #2638 et al.) and mutation-column
hashing (#2611) collapsed it by roughly 200–500×. At the 250 ms debounce the
worst-case steady load from one actively streaming subscribed session is
~4 × 4 ms ≈ 1.6% of a core.

## Sentinel candidates cost more than the evaluation they guard

| Sentinel candidate (scoped to the session)                                    | Cost    |
| ------------------------------------------------------------------------------ | ------- |
| `SELECT COUNT(*) FROM sdk_messages WHERE session_id = ?`                       | 125 ms  |
| `SELECT COUNT(*), MAX(rowid) FROM sdk_messages WHERE session_id = ?`           | 80 ms   |
| Aggregate digest of mutation columns over the whole session                    | 945 ms  |
| `job_queue` active-delivery scan                                               | 0.08 ms |

The inversion has a structural cause: the full query reads only the ~200-row
window via the session/timestamp index, while any session-wide aggregate scans
all 167 k index entries. The window limit _is_ what makes the full query cheap,
so a sound sentinel cannot be built from unbounded aggregates.

Bounding the sentinel to the window does not help either: `timestamp`,
`send_status`, and every other mutation column are stored _after_ `sdk_message`
in the row record, so reading them walks the same overflow-page chains as
reading the blobs — the dominant cost the window query already pays. Add the
subagent set (children of windowed tool uses), the shutdown-boundary row, and
the active delivery jobs, and a _sound_ sentinel converges to a duplicate of
the full query. Anything cheaper than that is unsound:

- `COUNT`/`MAX(rowid)` misses in-place `UPDATE`s (`send_status` transitions,
  `retry_count`/`run_at` on jobs, message replacements) — these flip real UI
  state (delivery badges).
- `sessions` has no maintained `updated_at`; `MAX(last_active_at)` misses
  title/status/processing-state changes.

That is precisely the stale-sentinel bug class the task warned about, purchased
at a negative win.

## Trailing-edge coalescing alternative: already covered

`evaluateQuery` is synchronous (prepared statement + hashing on the calling
tick), so two evaluations of one entry can never overlap — "skip while a
previous evaluation is still running" can never fire. Burst coalescing is
already provided by the debounce (#1132): measured above, 20 writes inside one
window collapse to a single evaluation.

## Residual hot spots found while measuring (follow-up material, not engine work)

1. **`sessions.list` evaluations cost ~45 ms and are 100% predicate.**
   Predicate-only `SELECT COUNT(*) ... WHERE humanSessionPredicate` measures
   44.2 ms vs 44.9 ms for the full SQL (`json_valid` + `json_extract` over
   4,936 non-null `session_context` values, 356 KB total); bare `COUNT(*)` is
   0.02 ms. Every visible message save bumps
   `sessions.visible_message_count` → a `sessions` change with `{ sessionId }`
   scope that passes the sessions.list filter, so streaming in a human session
   drives up to ~6.6 × 45 ms ≈ 27% of a core of pure no-op re-evaluation.
   A sentinel cannot fix this soundly (in-place updates); the fix is
   query-shape work: narrow the predicate (type filter first) or a partial /
   expression index matching the human-session predicate. Recommend a separate
   task.
2. **`job_queue` changes are unscoped.** Any job transition re-evaluates every
   subscribed `messages.bySession` (and task-feed) entry at ~7.3 ms each,
   because the queue's writes fire without a scope. Extracting `sessionId`
   from the job payload at `notifyChange` time would reuse the existing
   scoped-invalidation path. Modest win (~7 ms × subscribers per transition);
   belongs to the scoped-invalidation track, not the engine.

## Verdict

Do not land the two-tier sentinel. For its named target the cheap tier costs
20–30× more than the full evaluation it would guard; bursts are already
coalesced by the debounce; overlapping evaluations are impossible in a
synchronous engine; and every cheaper-than-the-query sentinel shape we could
construct is unsound against in-place updates, which is the exact
missed-change failure the task forbade. The remaining measured engine-adjacent
costs above are query- and scope-extraction work and should be tracked as
their own tasks.
