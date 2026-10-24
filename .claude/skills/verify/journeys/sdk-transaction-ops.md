# SDK transaction ops preserve bodies and atomicity on the writer

Read the shared SKILL.md setup. This build-only proof invokes the registered ops
directly; it does not claim that live callers have switched. No model, provider,
HTTP mock, GUI or occupied-port preflight is needed. Run from the worktree root:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-ops-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/sdk-transaction-ops.ts "$RUN"
```

The helper owns a fresh synthetic file database and gateway worker. After seeding,
it sets the main connection to `query_only=ON` and invokes outbox ensure/activate/
retry, joint Neo intake, mailbox failure, session teardown, bounded column
backfill/completion and a claim-fenced status transition. New side-only messages
must retain their body in the side table and leave the legacy body column empty.
A synthetic insert fault must roll the entire teardown back, retaining its mailbox
job. Missing sessions must not acquire delivery-turn-end rows. The main connection
must remain read-only throughout these ops. The helper closes its workers in
finally and writes `evidence/sdk-transaction-ops.json`; only `pass: true` is success.

The result is readable user input and recoverable pending work, with unchanged
body bytes. The routing switch must separately run public RPC/UI journeys and
prove every live entry point uses these ops.
