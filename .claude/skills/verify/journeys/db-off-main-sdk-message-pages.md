# SDK transcript pages use the shared reader (step 2)

This is the public `message.sdkMessages` transcript RPC, including top-level rows,
child messages and background task metadata. It is not the live subscription,
export, single-full-message or write migration. No model, provider key, GUI, real
HOME/DB copy, port 8399 or live daemon change is used. Suites are CI-only.

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-page-reader-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/sdk-message-page-reader.ts verify "$RUN"
```

The helper owns a daemon and WebSockets on an ephemeral non-8399 port. Production
writers seed 31 complete synthetic bodies (~391.5 MB): long tool results, a parent
and five children, and task metadata. Only fixture timestamps are set equal to
exercise timestamp+rowid cursors. Derivation, normalized replacements and side
bodies come from production writers. It opens the reader before the writes, so
new snapshots must see later committed rows.

A synchronous reference is built outside measurement with the existing repository
and existing wire cap. Returned objects must match it exactly for latest, before,
since and a repeated latest page: order, cursor boundaries, hasMore, complete
ordinary text, existing tool-output markers, children and background metadata.
The wire cap is unchanged; stored tools/bodies are never trimmed. Complete logical
body SHA/count/bytes must match after all reads and cancellation. Seed/hash/index
flush/test-GC are excluded from hot-read timing and disclosed, not hidden costs.

An independent Bun process holds a synthetic WAL counter write for 20 ms and
probes actual health RPC latency. `evidence/observed.json` records each affected
RPC, max main loop lag, independent health replies/max, measured main SQL, worker
queue/transaction/SQL summaries/fingerprints, argument/reply sizes and time, RSS
peak and WAL bytes. RSS is interval-sampled and may miss brief peaks, especially
when baseline main is blocked; it is not an OS high-water mark. Native iteration
timing excludes JS projection; whole read transaction/request timing includes it,
so report both. Report every miss against
250 ms SQL/RPC and 1 s lag; lower main lag is not a full target pass. Oversized
ordinary messages beyond the unchanged transport limit are not proved here.

The final repeated latest read is essential: an early break from a Bun cached
bound statement iterator caused SQLITE_MISUSE on reuse. The pre-fix fixed-source
run is retained as failure, not a latency/hash pass. Projection now exhausts the
SQL-limited metadata iterator while retaining the same visible limit, then reads
and projects each selected body by primary key inside the same snapshot. This
avoids sorting full hydrated blobs in a SQLite temp B-tree; the intermediate
worker-only projected-sort run still missed 250 ms and is retained. Default unported
full reads remain unchanged. CI contracts repeat projected reads and verify full
stored output still exists. The helper also terminates its owned reader mid-read;
that RPC must reject at the real deadline while health works, then a new reader
must return the same page. No synchronous file-backed failure fallback.

For before/after, run the same committed helper in `baseline` mode on tests-first
`9b448c9c16` in a separate worktree and fresh directory. Never copy a DB. A baseline
setup/RPC failure is inconclusive; it must observe a >100 ms main stall. Preserve
failed/inconclusive runs with the final result. Repeat the unchanged step-1
`db-off-main-sdk-status-reader.md` journey to measure whether the shared reader's
per-row text projection actually reduces its earlier RSS/latency misses.

All sockets, probe, reader and daemon close in finally. CI's Deno smoke sends a
status request then an empty page through the real shared worker; nonempty native
Bun RPC and Node-host IPC tests cover data/cursors. Deno is unavailable locally;
its runtime acceptance remains CI-only. Run `sdk-status-reader-memory.ts` with
`verify` or `bridge` using the same isolated setup to check actual public status
and repeated page RPCs on memory DB or the real native Bun IPC worker bridge.
The helper asserts full ordinary content and stored SHA retention. Unit suites,
including mixed status/page FIFO/error contracts, remain CI-only. Post-deploy measurement belongs to the perf lane, grouped
by deployed commit/PID, read-only; `workerOperation=sdk-page` identifies page SQL
while the existing shared `workerKind=sdk-status` label remains compatible.


For summary attribution, run the same isolated `sdk-status-reader-memory.ts bridge`
command with `VERIFY_SQL_SUMMARY=verify`. It uses real public status/page RPCs and
an actual native worker, enables a one-second SQL interval and records the mixed
fingerprints in `evidence/memory.json`. Summary records must have no
`workerOperation`; individual slow statements retain their own status/page label.
On the pre-fix contract commit, `VERIFY_SQL_SUMMARY=baseline` records the erroneous
last-page label. Full ordinary text, repeated replies and stored SHA must still
match. This is an observability proof, not a new performance benchmark.
