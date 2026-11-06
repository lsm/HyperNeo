# Atomic watched repository configuration

Use the shared isolation and resource setup in ../SKILL.md with Bun 1.4.2.

    bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/github-watch-config-writer.ts
    bun .claude/skills/verify/github-watch-config-measure.cjs /absolute/persistent/scope.json

Commit the failing public RPC reproduction before wiring. On the old implementation,
the helper fails at Watch config SQL reached main before sending a writer command.
The unit trigger reproduction separately observes the partial upsert left behind
when clearing registration fails.

The helper owns a fresh synthetic file-backed daemon, authenticated ephemeral
socket, refusing external HTTP/GitHub stubs and native gateway workers. Stop owned
processors and await startup body copying before measurement. No credentials,
model turn, live data or port 8399 is used.

Trap watched-row INSERT/UPDATE and key/ID SELECT execution on the main connection.
Require zero attempts through public watchRepo. Observe actual write-lane worker
posts. A failing clear trigger must roll back the full preceding upsert. Hold a
competing WAL writer, observe a pending mutation with a responsive health RPC,
then release the lock and read the sanitized committed receipt. Retain identity,
case, configured-secret marker and existing webhook policy.

Inject a lost receipt after the native transaction commits. Require the committed
row, one request and no delayed retry. Reject admission separately and require no
native post or row change. These are synthetic receipt/admission failures, not an
OS worker crash. Require failedClearRollsBackUpsert, committedSanitizedReceipt,
unknownCommitNeverReplayed, admissionFailurePreservesRow, nativeWriterLaneObserved,
mainConfigSql zero, pass and resourcesStopped in github-watch-config-writer.json.
Inspect the wrapper status and log for teardown errors.

Report the held mutation's full latency honestly, including the deliberate lock
wait. Record health latency, event-loop lag, command round trip, payload sizes and
RSS. Queue time, SQL time and cloning are not measured separately.

The measurement counts the whole watch callback/admission gate, both complete
new modules, the reader bridge, legacy clear wrappers and import/registration
lines. Require ownedRootLines below 200. The CLI must reject a fixture whose
complete watch callback exists but whose admission declaration is missing.
It also reports the production diff. No prior audited-module exclusion grant is used.
Existing upsert/default/cursor helpers are reused and covered by regression tests.
This slice leaves polling intent and snapshot SQL to the next rung and makes no
whole-runtime or final-guard claim. Retain evidence outside the worktree.
