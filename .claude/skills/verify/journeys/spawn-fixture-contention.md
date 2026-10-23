# Spawn fixture creation under a concurrent SQLite writer

Read shared setup in `../SKILL.md`. This metadata-only proof starts an isolated
daemon with its own HOME/data/database and an ephemeral loopback port, never 8399.
It makes no model turn or real GitHub request: fake gh refuses every command and
direct HTTP throws. The helper owns and closes its WebSocket, worker and daemon.

Run from the worktree root, once per scenario in a fresh absolute RUN:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-spawn-contention-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/spawn-fixture-contention.ts space before "$RUN"
```

Repeat with `task` in a fresh RUN. The helper pauses unrelated job processing
before setup and supplies a controlled independent SQLite worker instead. It
releases that writer immediately after the creation transaction's first read.
The worker commits one unrelated synthetic row. The primary connection then
attempts its insert through the actual public `/ws` `space.create` or
`operation.invoke` / `task.create` door. This isolates the read-to-write snapshot
upgrade from SDK startup, network timing and test teardown.

Inspect `evidence/contention.json`. Reproduction mode `before` requires the public
RPC to return `database is locked`, with the independent writer committed and no
partially created target row. This deterministically reproduces a setup failure
capable of producing the CI symptom; the original CI artifacts did not identify
the handler, so it does not prove which setup transaction failed historically.

Regression mode `verify` instead requires the RPC to succeed once, with both the
creation and unrelated writer committed. Its matching unit tests assert those
observable rows and currently fail on the reproduction commit. The barrier waits
at most 100 ms: a transaction already holding write intent keeps the other writer
waiting until its own commit. There is no retry loop or swallowed operation error.

This controlled proof does not replace the existing five lifecycle/SDK tests.
Do not merge diagnostics as a fix or claim a passing intermittent run resolves
the lock. Any production storage correction needs the separately requested scope
approval before writing it; the initial slice permits only harness/spawn-probe
changes. All live data/configuration remain untouched.
