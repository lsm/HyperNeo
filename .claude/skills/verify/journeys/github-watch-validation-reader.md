# Watch validation uses the DB reader

Use the shared isolation and resource setup in ../SKILL.md with Bun 1.4.2.

    bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/github-watch-validation-reader.ts

Commit the failing public RPC reproduction before wiring. It must fail with
Validation lookup reached main, one trapped query and no reader requests.
The fixed helper owns a file-backed synthetic daemon on an ephemeral port,
fresh HOME/data, an authenticated socket and refusing GitHub/HTTP stubs. It
stops owned processors and waits for real startup SDK body copying before
measuring. No model turn, real credentials, live data or port 8399 is used.

Hold an actual competing WAL writer. The real watchRepo validation must use
the read-only native gateway lane and reject enabling polling at interval zero.
Observe actual worker posts with lane read. Require one native post per reader
call, the row unchanged, zero validation lookup queries on main and healthy
system.health RPC. Record affected RPC/health latency, max loop lag, payload
bytes, round trip and RSS. The report names whether the 250 ms RPC/health and
1 s lag targets passed. Queue time, SQL and cloning are not separately timed.

A successful mixed-case lookup must retain the original ID/case and sanitized
configured-secret marker. Inject a lost read receipt after the native query has
completed. The RPC must reject, with exactly one request and no fallback lookup,
mutation or delayed retry. This is a gateway-receipt failure, not OS worker death.
The unit tests also hold the reader receipt, check admission before reads, and
preserve complete mapped/null/malformed-cursor results. Require pass,
caseAndSanitizedReceipt, lostReadReceiptHasNoFallbackOrMutation,
nativeReadLaneObserved, mainValidationReads zero and resourcesStopped in github-watch-validation-reader.json.
Require wrapper exit zero and inspect its log for closed-database errors.

The successful watch still executes its later config-plan lookup and mutation
on main. The helper counts that remaining lookup explicitly for the next rung.
This slice proves only pre-mutation validation ownership. Timer and webhook
policies retain their existing tests. The full daemon startup and transitive
framework/OS closure are outside this local ownership claim.

Run github-watch-validation-measure.cjs. Its 182-line owned graph includes the
entire 92-line watch callback, admission gate, full command/lookup/mapper modules
and three import/registration lines. Excluded lines are zero. It restores the
single bridge edit and verifies all other extension bytes against the fresh base.
Prior timer/capability pins deliberately refresh only this bridge's hash. Keep
native JSON and wrapper status outside the worktree before removing owned data.
