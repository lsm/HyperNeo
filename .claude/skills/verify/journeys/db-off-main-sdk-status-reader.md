# SDK status RPC disk work runs on a reader worker (step 1)

Use a fresh synthetic run, with no model/mock, provider, real HOME, real DB copy,
GUI or port 8399. Unit and online suites run only in CI. From the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-status-worker-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/sdk-status-reader.ts verify "$RUN"
FAULT=$(mktemp -d /private/tmp/hn-sdk-status-fault-XXXXXX)
mkdir -p "$FAULT/home"
env -i HOME="$FAULT/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$FAULT/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/sdk-status-reader-fault.ts "$FAULT"
```

For supported in-memory configuration and Node-hosted online-test parity:

```bash
MEM=$(mktemp -d /private/tmp/hn-sdk-status-memory-XXXXXX)
mkdir -p "$MEM/home"
env -i HOME="$MEM/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$MEM/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/sdk-status-reader-memory.ts verify "$MEM"
```

This RPC journey must preserve complete mixed-block text and body SHA in `:memory:`.
On the pre-fix source use `baseline` to record the file-backed error immediately
at the same RPC. `bridge` instead uses a fresh file DB and the online harness's
Bun-process IPC bridge to a real native Bun worker, then verifies the same result.
The bridge is test-only: Vitest runs its daemon in Node without Web Worker; only
the SDK reader factory is injected, with no synchronous read/reply mock. Its host
gets an empty test HOME/data directory and no provider keys. CI still exercises
the production factory through Deno smoke; native Bun is exercised by this journey.
The in-memory path explicitly uses its own existing connection and shared text
projection; it does not read disk or handle a failed file-backed worker.

The first helper owns an actual daemon and calls public `session.create`,
`session.messages.byStatus` and `system.health` over WebSocket. Both sessions are
manual; no model turn starts. Production writers/derivation seed 24 complete large
user messages, a complete replay tool result, and a separate 12 MB text message.
It compares full returned text/order/count, validates the complete oversized text
hash, and hashes every logical stored body before/after, including cancellation.
No text or tool result is trimmed. The existing 40 MiB outbound transport limit
is unchanged; results above it are not verified by this journey.

Before measuring, flush only derived search-index work and force test-runtime GC
so seeding/indexing garbage does not masquerade as status-RPC work. A separate
process probes health while repeatedly holding a synthetic WAL write transaction
for 20 ms on a fixture-only counter. Its timing continues when daemon main stalls.
Three page reads cover cold body pages/warm repeats. `coldEmptyReadMs` separately
records initial reader/module startup. The page and total use one read snapshot;
previous completed main-writer inserts are visible to the already-open reader.

`evidence/observed.json` retains each status-RPC time, max main heartbeat lag,
independent health latency/count, competing writes, measured RSS peak, WAL size,
body hashes/count/bytes, main SQL times, worker request/queue/error timings and
forwarded SQL fingerprints/summaries. The test-only Worker wrapper measures
argument postMessage time and serialized reply bytes; reply delivery time includes
cloning AND queue delay, not pure cloning. Byte instrumentation adds some main CPU.
Body hashing and seeding are outside hot-read timing. RSS after audit hashing is
separate from the measured peak. Record failures against 250 ms SQL/RPC and 1 s
lag honestly: moving disk work does not make large body reads or parsing faster.

The helper intentionally terminates its owned reader during an accepted read.
Web Worker termination does not emit an error; the real 30-second deadline must
reject that RPC while an independent health RPC remains available. A new request
may open a replacement and return complete data. This is not an affected-RPC
latency pass during failure. The separate fault helper injects an actually
throwing worker entry that acknowledges handler readiness before accepting the crash
request, proving native onerror rejection, health responsiveness
and later recovery through the real RPC, without main-thread fallback.

On tests-first `dcb7d4159d`, use the same helper with `baseline` in another fresh
run (copy the updated helper source, never a DB). It must observe a >100 ms main
stall or call the reproduction inconclusive. Original measurements with a probe
that did not finish, and the earlier fixed run polluted by background indexing,
remain failed/inconclusive evidence, never passes. Stable comparisons must use
matching helper/seed versions; do not compare hashes with older 25-row fixtures.

Both helpers close their sockets, probe and daemon in finally; shutdown drains
accepted reads and closes the worker DB before the existing main close/checkpoint.
CI fake-worker contracts cover stale epochs, queue capacity, timeouts, crashes and
close. CI's Deno smoke additionally invokes this RPC in a manual session, using a
fresh test HOME/data directory and empty environment, then checks graceful exit.
Deno is not installed in the local proof environment; that runtime is CI-only.

Only this SDK status data lookup is converted. Authorization/session lookup,
health counters, boot, other repositories and main SQLite shutdown remain on
their existing paths. Follow-up units own those migrations. No schema migration,
new deletion path or downtime deployment is introduced here. After deployment,
use `hyperneo build` and read-only structured logs grouped by build/PID; worker
query logs have `workerKind=sdk-status`. Correlate their fingerprints with main
lag separately; worker SQL duration is not main blocked time. Never restart or
write the live daemon to manufacture evidence; missing coverage is inconclusive.
