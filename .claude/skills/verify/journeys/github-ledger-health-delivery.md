# Persisted health notices reach the existing wake mailbox

Use shared isolation in `../SKILL.md`:

```bash
RUN=$(mktemp -d /private/tmp/hn-health-delivery-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/github-ledger-health-delivery.ts "$RUN"
```

The helper owns an isolated daemon and synthetic recipient. It exercises the
real coding-pack sweep, existing Neo wake and durable mailbox handoff, with no
provider turn. A synthetic trigger rejects mailbox insertion: the third miss
must retain a pending incident notice. Recovery queues a stable recovery notice
behind it. Restart must preserve both; removing the rejection lets the next
existing sweep accept exactly two keyed mailbox jobs and persist acceptance.
Further sweeps and another restart must not duplicate them. Protected source
history remains unchanged. Unit contracts also cover a thrown wake, a newer
incident while delivery is pending, and acceptance before failed bookkeeping.

Inspect `evidence/health-delivery.json` and the captured log. This proves durable
acceptance, not recipient consumption. No real GitHub, keys, credential files,
live DB/copy, GUI or port 8399; all owned resources stop in finally. No new
timer/RPC/schema/permissions/reader or source-history rewrite.
