# Workflow connector PR basics read ledger facts

Use the shared isolation in `../SKILL.md`. No model, native harness or GUI.

```bash
RUN=$(mktemp -d /private/tmp/hn-connector-wire-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-connector-wire.ts "$RUN"
```

The helper owns an actual ephemeral-port daemon and fresh DB. It drives the
production `pr_merged` built-in through `HookExecutor`, the external-state
validator and GitHub connector, with the daemon's bound ledger reader. Five
concurrent allowed hook decisions must cause one fake gh acquisition. A separate
fresh run with `baseline` as the third argument records the legacy five reads.
No live quota or GraphQL-cost saving is inferred from these logical calls.

Restart preserves the fact row. A later decision still refreshes, OPEN retries,
and a failed latest refresh blocks while retaining the previous JSON and success
time. It never falls back to a connector read. Recovery allows the hook again.
Unit contracts also prove per-daemon isolation and preserve readiness's separate
thread lookup. This slice moves only PR basics; review-thread acquisition and
other connector operations remain separate follow-ups. Standalone callers with
no injected reader keep their existing compatibility path until deletion.

Pass: `evidence/workflow-connector.json` is verified, coldReads is 1, and counts
are cold/repeat/open/failed/recovered = 1 each. The synthetic baseline is 5 cold
reads. Fake gh refuses unknown commands; direct HTTP throws. No real keys, auth
files, DB copies, provider scheduling, browser, or port 8399 is used. The helper
stops both daemon instances in finally. Keep the JSON and requests.jsonl outside
the worktree, then remove the fresh run. Workflow scheduling and UI interaction
are not exercised by this hook-entry proof.
