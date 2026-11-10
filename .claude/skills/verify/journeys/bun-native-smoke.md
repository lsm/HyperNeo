# Bun native smoke registration

Use ../SKILL.md for resource and synthetic-environment rules. Run the native
entry point with one new absolute evidence directory:

    bash scripts/bun-native-smoke.sh /absolute/fresh/evidence-directory

The existing Bun daemon boot probe runs first in its own fresh wrapper. Require
HTTP 200, authenticated health/status/page/live reads with snapshot-before-ack
ordering, >80 migrated tables and
graceful SIGTERM with its child reaped. See
[bun-daemon-boot-probe.md](bun-daemon-boot-probe.md). A boot failure must retain
its evidence and status and prevent every later case from running.

The runner retains 117 legacy helper identities in 141 legacy mode cases: the initial
three settings/provider proofs plus 31 workflow and job proofs for mailbox admission,
parking, retries, polling recovery, reminders, schedules and workflow
identity/configuration/pins. The reader batch adds 11 SDK/session transcript,
snapshot, inventory, count, shutdown-marker, broadcast-failure and export contracts.
Transcript and single message reads retain the legacy --defer-body-copy schedule. The
orchestration batch adds 18 todo/ask/coding helpers. Its coding sweep retains all 25
variants from the legacy runner in their original order, each with its own evidence
directory and synthetic GitHub CLI. No real PR is merged by a proof. The persistence
batch adds 21 paired-device, human-reset, workspace and artifact helpers; retired
local registration retains its verify mode. Keep the existing HTTP/WebSocket/CLI,
committed-receipt, rollback, no-replay and Git byte/provenance assertions. Filesystem
and policy callbacks remain unchanged on main. Helper identity coverage and mode-case
coverage are distinct; count both. The final batch adds 33 extension-configuration
and GitHub settings/reader helpers. Preserve their source filters, snapshots,
cursors, caller clocks, rollback, receipt ordering, timer ownership and no-replay
assertions. GitHub is synthetic throughout; no remote subscription or webhook is
changed. After those cases, the standalone Bun shared-reader and gateway probes add
two inline-contract replacement cases. Event/job, outbox and todo receipts follow,
then claim lock and todo incidents. With boot first and todo incidents last, there
are 149 total. Require event/job's duplicate event identity, retained feed body,
distinct cleanup cutoffs/failed-job payload, full single-claim payload and resource
closure; see [bun-event-job-probe.md](bun-event-job-probe.md). For the shared reader,
require complete turn text/count, Codex snapshot and queued-error isolation flags
plus reader/database closure. See
[bun-shared-reader-probe.md](bun-shared-reader-probe.md) for that contract. The
gateway probe requires two concurrent writes to retain count two, the exact
unknown-read registration error and gateway/database closure; see
[bun-gateway-probe.md](bun-gateway-probe.md). The outbox probe requires its matching
mailbox report, exact command/prompt, acknowledgement and committed journal sequence,
plus resource closure; see [bun-outbox-probe.md](bun-outbox-probe.md). The todo
receipt probe requires recovery/window/live-status results, complete dispatch
receipts, trigger-refusal rollback and Map snapshot transport; see
[bun-todo-receipt-probe.md](bun-todo-receipt-probe.md). Preserve its normal
turn-report cutoff bootstrap prerequisite; this does not prove cold reader
initialization or startup write ownership. The claim lock probe requires real SQLite
lock ownership, a claim pending through barrier release, the holder's commit, a
complete single claim and resource closure. See
[bun-claim-lock-probe.md](bun-claim-lock-probe.md). The todo incident probe requires
complete progress commit/rollback, one winning concurrent needs-you claim, refusal
rollback, closed-todo refusal and resource closure. See
[bun-todo-incident-probe.md](bun-todo-incident-probe.md). This covers the 117-helper
inventory and its legacy sweep modes, but not all inline boot/database probes.

The entry point forces Bun and calls proof-run.sh directly for each helper,
preserving verify modes and deferred-body-copy arguments where required. Each case gets its own fresh
HOME/data/TMPDIR; retained logs, JSON and run-status.json survive cleanup.
The wrapper checks resource thresholds on Darwin. Linux must not need macOS
memory_pressure or /System/Volumes/Data to run this same entry point.

Run bun-native-smoke.test.ts and proof-resource-guard.test.ts with the isolated
unit setup. Resource-refusal fixtures explicitly report Darwin through their
own uname executable on every host; Linux portability fixtures report Linux.
Together they exercise both platform decisions without depending on the host.
The native smoke fixture exercises the real shell entry point and wrapper with synthetic child executables: Linux
portability, explicit Bun selection despite an inherited Node choice, quoted
paths, mode and directory arguments, Darwin resource refusal and early exit on
early, matrix-interior or late failures, including the first boot case, artifact publication, unwatch timer, shared-reader, gateway, event/job, outbox, todo receipt and claim lock probes, and final todo incident probe. Pin the legacy-relative invocation order and modes.
Keep failure status/evidence and prove later cases do not run, including the
remaining variants after a failed sweep case. A final todo incident failure must also
retain its evidence/status and suppress the runner success marker.
These fixture executables do not establish native helper parity.

For native proof run the entry point with the real Bun binary, scrubbed parent
environment and a refusing gh stub. No provider credential belongs in the
environment. The helpers use synthetic values only through their isolated RPC
doors. Require the existing settings/admission no-main-SQL fences, concurrency,
job claim/retry/rollback receipts, polling recovery and schedule/workflow RPC
contracts. Reader proofs retain complete payloads, snapshots, cursors, counter
deltas, held-WAL isolation, cold actors, source body hashes and recovery after
native reader failure. Require startupBodyCopyComplete in the deferred cases.
Core proofs preserve full Work cards, rollback, claim/recovery/settlement rules
and no replay after unknown outcomes. Only synthetic work-driver and GitHub
boundaries are used; real provider turns, worker stops and PR merges are excluded.
Also run the transcript and single-message helpers in ordinary mode in separate
fresh wrapper directories; preserve those additional receipts without replacing
the legacy deferred-mode run. Neutral workflow characterization helpers intentionally retain their
existing main SQL and hash assertions; they do not claim those writes migrated.
Provider replies remain redacted and encrypted credentials round-trip only in
the synthetic database. Held writer locks intentionally exceed 250 ms; retain
the measured latency limit rather than claiming a faster write.

Require each retained run-status.json to show exit 0, inspect the saved RPC receipts
and wait for wrapper cleanup. Keep the parent log outside disposable data.
