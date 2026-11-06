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

The current measurement counts the whole watch callback and admission gate,
the complete polling writer module, the complete shared snapshot helper and
its import/registration lines. Require ownedRootLines below 200. It fingerprints
the extension outside the callback and verifies the shared module's export-only
change against its prior full-file hash. A CLI fixture with the callback but no
admission declaration must reject. Control roots are reported by the script without requiring historical Git objects.
Measure each PR diff separately against its fresh dev base. Reused SQL/mapping helpers retain interface tests.

## Polling intent and saved configuration

    bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence .claude/skills/verify/github-watch-polling-writer.ts

The committed red helper fails at Watch polling SQL reached main. The watched
mutation commits first, as in the existing public path. The new writer command
then owns the configured-row decision, intent update and snapshot reads. Its
snapshot data goes to the existing injected config store. The standard store
persists through its existing writer command. Memory/custom stores receive the
same awaited setter call.

Seed a configured disabled sibling. Disabling the active target must preserve
intent until that sibling is also disabled. Preserve the stored filter and
compare saved snapshots with committed rows. An intent failure leaves the known
watched commit. A later snapshot-read failure rolls back the intent command.
A rejected config store preserves both earlier commits.
Require intentFailureKeepsWatchedCommit, configStoreFailureKeepsKnownCommit,
configuredDisabledKeepsIntent, lastConfiguredRowClearsIntent,
unknownPollingCommitLeavesStoreUnapplied, unknownCommitIncludesConfigWithoutReplay
and admissionFailureKeepsWatchedCommit. Require mainPollingSql zero,
nativeWriterLaneObserved, pass and resourcesStopped in
github-watch-polling-writer.json.

Hold a real WAL writer immediately before the polling command, require a pending
mutation and responsive health, then release and read the committed receipt.
Record the deliberately held RPC latency, health, loop lag, operation round trips,
payload sizes, WAL growth and RSS. A lost polling-command receipt leaves the
config store unapplied. Separately lose the standard store receipt after commit
and require no replay. Unit tests cover both boundaries and injected stores.
Other RPCs, remote webhook effects, startup and the global guard have separate
scope decisions. Retain evidence outside the worktree.
