# Health session counter uses the reader

Run `lane-b-health-session-count-reader.ts` through `proof-run.sh` in a fresh
synthetic daemon; native Deno smoke uses the same helper with a disposable
HOME/data/TMPDIR. There is no model turn, provider key or external HTTP.

Seed active, paused, archived and excluded room/Space/lobby sessions. Warm the
existing main counter statement before measuring. A statement proxy installed
before daemon startup must then deny all session_counters SQL execution on main,
including cached statements. The tests-first baseline must fail through the real
system.health WebSocket RPC at that guard.

The fixed RPC must retain status, version, uptime, migration metadata, cached
active count and maintained human total semantics. Cold and 20 concurrent warm
requests run under an explicitly held synthetic WAL writer; outside=0/inside=1
counter assertions before and after prove the transaction remains open. A later
committed human session must increase the next health response. Inject a native
reader failure: health must reject, a separate transcript RPC must remain usable,
and a later health request must recover with the current total. The actor cache
must stay empty and target SQL attempts on main must stay zero.

Save JSON and failure logs, including cold/warm latency and loop lag. The helper
closes socket, writer, processors, workers and daemon; the wrapper saves evidence
outside the disposable directory and removes all owned data. These are source
RPC proofs; served-build/UI smoke and production scale remain unverified.
