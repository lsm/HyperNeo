# Projected session inventory and health count use the readers

Run `lane-b-projected-session-reader.ts` through `proof-run.sh` in a fresh
synthetic daemon. Native Deno smoke uses the same helper and a disposable
HOME/data/TMPDIR. No provider key, model turn or external HTTP is required.

Seed human, archived and excluded sessions. A statement proxy installed before
startup denies all main session-table and session_counters execution during
measurement, including cached statements. The tests-first real
state.global.snapshot request must fail at that guard.

Fixed system-only snapshots must omit inventory and preserve system/health,
settings and meta contracts. Legacy full snapshots must retain complete
Session[] rows and hasArchivedSessions. Toggle showArchived through the real
settings RPC and compare full inventory against the existing repository
projection. A later committed human session must appear with the current count.

Cold and concurrent reads run under a synthetic WAL writer whose outside=0 and
inside=1 values are asserted before and after reads. Inject a native health
reader error; the projected RPC must reject without a main fallback, a separate
transcript RPC must remain usable and a later full snapshot must recover. The
actor cache must stay empty. Record zero target SQL attempts, latency and lag.

Authentication, settings, runtime objects and delivery stay outside database
transactions. These source proofs do not establish UI/served-build smoke or
production scale. Save evidence, close every owned resource and immediately
remove disposable data.
