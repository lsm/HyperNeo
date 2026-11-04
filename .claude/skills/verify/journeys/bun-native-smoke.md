# Bun native smoke registration

Use ../SKILL.md for resource and synthetic-environment rules. Run the native
entry point with one new absolute evidence directory:

    bash scripts/bun-native-smoke.sh /absolute/fresh/evidence-directory

The runner registers 45 existing contracts: the initial three settings/provider
proofs plus 31 workflow and job proofs for mailbox admission, parking, retries,
polling recovery, reminders, schedules and workflow identity/configuration/pins.
The reader batch adds 11 SDK/session transcript, snapshot, inventory, count,
shutdown-marker, broadcast-failure and export contracts. Transcript and single
message reads retain the legacy --defer-body-copy schedule.
This remains partial coverage of the 117-helper inventory. Keep the Deno
runner and required CI job enabled until every replacement proves parity.

The entry point forces Bun and calls proof-run.sh directly for each helper,
preserving verify modes and deferred-body-copy arguments where required. Each helper gets its own fresh
HOME/data/TMPDIR; retained logs, JSON and run-status.json survive cleanup.
The wrapper checks resource thresholds on Darwin. Linux must not need macOS
memory_pressure or /System/Volumes/Data to run this same entry point.

Run bun-native-smoke.test.ts and proof-resource-guard.test.ts with the isolated
unit setup. Resource-refusal fixtures explicitly report Darwin through their
own uname executable on every host; Linux portability fixtures report Linux.
Together they exercise both platform decisions without depending on the host.
The native smoke fixture exercises the real shell entry point and wrapper with synthetic child executables: Linux
portability, explicit Bun selection despite an inherited Deno choice, quoted
paths, mode and directory arguments, Darwin resource refusal and early exit on
early or late helper failures. Pin the legacy-relative invocation order and modes.
Keep failure status/evidence and prove later helpers do not run.
These fixture executables do not establish native helper parity.

For native proof run the entry point with the real Bun binary, scrubbed parent
environment and a refusing gh stub. No provider credential belongs in the
environment. The helpers use synthetic values only through their isolated RPC
doors. Require the existing settings/admission no-main-SQL fences, concurrency,
job claim/retry/rollback receipts, polling recovery and schedule/workflow RPC
contracts. Reader proofs retain complete payloads, snapshots, cursors, counter
deltas, held-WAL isolation, cold actors, source body hashes and recovery after
native reader failure. Require startupBodyCopyComplete in the deferred cases.
Also run the transcript and single-message helpers in ordinary mode in separate
fresh wrapper directories; preserve those additional receipts without replacing
the legacy deferred-mode run. Neutral workflow characterization helpers intentionally retain their
existing main SQL and hash assertions; they do not claim those writes migrated.
Provider replies remain redacted and encrypted credentials round-trip only in
the synthetic database. Held writer locks intentionally exceed 250 ms; retain
the measured latency limit rather than claiming a faster write.

Require each retained run-status.json to show exit 0, inspect the saved RPC
receipts and wait for wrapper cleanup. Keep the parent log outside disposable
data. GUI, real provider/network/keychain effects, the remaining native helpers
and eventual CI replacement are outside these batches.
