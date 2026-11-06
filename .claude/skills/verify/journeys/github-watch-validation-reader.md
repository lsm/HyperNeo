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

The config-writer rung also moves the serialized config-plan lookup and mutation
off main. This helper now requires zero remaining main key lookups. It continues
to prove validation admission, native reader ownership and receipt failure.
The polling-intent decision and snapshot reads use the next writer command.
Its data is returned to the existing config-store effect.
This journey continues to exercise the validation reader.

Run github-watch-validation-measure.cjs. It includes the entire current callback,
admission gate and complete reader/lookup/mapper modules, with zero exclusions.
It compares extension bytes outside the separately reviewed config callback with
a full-source hash from the config slice's fresh base, without invoking Git.
The regression uses an explicitly refusing Git stub, so shallow CI checkouts
need no historical objects. The command prints the current line count.
Keep native JSON and wrapper status outside the worktree before cleanup.
