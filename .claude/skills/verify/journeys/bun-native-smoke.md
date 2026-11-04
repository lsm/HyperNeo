# Bun native smoke registration

Use ../SKILL.md for resource and synthetic-environment rules. Run the native
entry point with one new absolute evidence directory:

    bash scripts/bun-native-smoke.sh /absolute/fresh/evidence-directory

This first batch owns three existing legacy contracts: Neo settings writer
races/contention, provider-record RPC writes and encrypted credential writes.
It is partial coverage of the 117-helper migration inventory. Keep the Deno
runner and required CI job enabled until every replacement proves parity.

The entry point forces Bun and calls proof-run.sh directly for each helper,
preserving verify mode where required. Each helper gets its own fresh
HOME/data/TMPDIR; retained logs, JSON and run-status.json survive cleanup.
The wrapper checks resource thresholds on Darwin. Linux must not need macOS
memory_pressure or /System/Volumes/Data to run this same entry point.

Run bun-native-smoke.test.ts with the isolated unit setup. It exercises the real
shell entry point and wrapper with synthetic child executables: Linux
portability, explicit Bun selection despite an inherited Deno choice, quoted
paths, mode and directory arguments, Darwin resource refusal and early exit on
a failed helper. Keep failure status/evidence and prove later helpers do not run.
These fixture executables do not establish native helper parity.

For native proof run the entry point with the real Bun binary, scrubbed parent
environment and a refusing gh stub. No provider credential belongs in the
environment. The helpers use synthetic values only through their isolated RPC
doors. Require zero forbidden main writes, preserved competing settings edits,
responsive health during the held writer lock, provider rollback and redacted
encrypted credential replacement/removal. The held write intentionally exceeds
250 ms; report that latency limit rather than claiming a faster write.

Require each retained run-status.json to show exit 0, inspect the saved RPC
receipts and wait for wrapper cleanup. Keep the parent log outside disposable
data. GUI, real provider/network/keychain effects, the remaining native helpers
and eventual CI replacement are outside this first batch.
