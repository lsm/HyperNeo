# Repository starvation health persists (Build only)

Use shared isolation in `../SKILL.md`:

```bash
RUN=$(mktemp -d /private/tmp/hn-health-state-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-health-state.ts "$RUN"
```

The helper seeds a synthetic old schema and protected polling facts, then starts
its daemon on an ephemeral port. Startup must apply migration 454 additively.
Explicit simulated outcomes use the ledger's existing DB-gateway write door.
Three eligible misses raise a stable incident; cooldown preserves it; complete
coverage, including an empty repo, recovers. Duplicate/older finalized cycles
cannot change the record. Restart preserves state and a later incident gets a
new identity. Existing fact rows and value_json remain byte-for-byte intact.

Inspect `evidence/health-state.json` and the captured log. This verifies the
local typed state/readback only. Collector eligibility, real coverage, Neo
concern delivery and API-read savings await Wire. No new timer/RPC/permission;
no model, GitHub, keys, credential files, live DB/copy, GUI or port 8399. The
helper stops all owned daemon resources in finally.
