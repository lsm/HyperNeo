# Todo turn-completion reads do not run SQL on daemon main

Use the metadata-only shared setup and proof-run.sh in SKILL.md. No provider,
model, mock server, live database or port 8399 is used.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/hyperneo-turn-ends-reader.ts verify
```

The helper owns an isolated file-backed daemon on a free ephemeral port, creates
a manual session through session.create, and seeds 160 synthetic turns. It calls
work.status through operation.invoke over the real WebSocket. Every turn must
retain its timestamp, preceding input timestamp and complete report, including
empty SDK results whose final assistant text supplies the report. Body hashes
must match before and after. The main connection refuses this exact SQL;
forwarded query logs must identify the SDK reader and hyperneo-turn-ends operation.
Concurrent system.health calls must succeed. Resources close in finally; the
shared wrapper saves observed.json/proof.log and removes the disposable data.

On the tests-first commit, run the same helper with baseline. The actual RPC
returns reports but fails the no-main-SQL assertion. Baseline timings and fixed
worker timings describe only this synthetic fixture: they do not reproduce or
claim to accelerate the six-second production query. The change isolates native
SQL from the main event loop; the shared reader can still queue behind slow reads.
Reader failure must reject status without a synchronous main fallback. Adapter
unit contracts cover that failure and preserve recovery/compaction filtering.

Run all adapter fixtures, not only the verb suites, when changing the reader
dependency. Existing Space status/discovery and attribution fixtures must supply
the same in-memory turn reader and retain their result-isolation assertions:

```bash
cd packages/daemon
TMPDIR=/private/tmp bunx --no-install vitest run --maxWorkers=1 --no-file-parallelism tests/unit/1-core/drivers tests/unit/1-core/operations/neo-attribution-acceptance.test.ts tests/unit/4-space-storage/storage/sdk-status-reader.test.ts
```

The same reader is injected into HyperNeo and Space status adapters. In-memory
test databases use their existing connection in the storage facade. After Neo
updates the live daemon, use hyperneo build and read-only structured query logs
to confirm the merge is served and this fingerprint has workerKind=sdk-status
and workerOperation=hyperneo-turn-ends. Do not trigger a live refresh or restart.
Missing live observations remain unverified.
