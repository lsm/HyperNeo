# Message subscriptions evaluate off main (DB-off-main step 3)

Read shared SKILL.md setup. This journey uses real WebSocket subscriptions, an
independent health-RPC probe process, production writers and only synthetic
HOME/data/DB. No model, keys, real DB copy, GUI or port 8399. Suites stay CI-only.

```bash
RUN=$(mktemp -d /private/tmp/hn-live-reader-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/sdk-message-live-reader.ts verify "$RUN"
```

For the before measurement, use the same committed helper in `baseline` mode
on the contract-first source, in a separate worktree and fresh run directory.
The 31 production-written bodies total about 391.5 MB, including complete tool
results, parent/children and background metadata. Existing full/compact wire
shaping is the reference; neither stored body nor tool result is trimmed.
Initial snapshots must arrive before subscribe acknowledgments and equal the
reference exactly. Body SHA/count/bytes must remain identical after all reads.

`evidence/observed.json` retains affected RPC latency, independent health latency,
max main event-loop lag, main SQL, worker queue/transaction/SQL events, argument
post timing/reply bytes, sampled RSS, WAL bytes and complete-body hash. RSS is
interval-sampled, not an OS high-water mark; baseline blocking can hide peaks.
Reference construction, seed, hashing, search flush and test GC are outside the
hot-read measurement. A worker terminated during a read must reject at the real
reader deadline while health still works; a new subscription must recover.
Retain failed/inconclusive runs and disclose every miss against 1 s lag and
250 ms SQL/RPC goals. Moving the work does not establish the query is faster.

The helper closes its probe, sockets, reader and daemon in finally. CI contracts
also pin initial readiness, invalidation during a read, stale/disposed replies,
same-ID replacement, pending capacity reservation and explicit error cleanup.
Post-deploy checks are read-only, grouped by RPC build/PID; no restart or live
write is permitted for measurement.
