# The human's Neo history stays fast behind hidden session rows

Build and launch with the shared SKILL.md setup on an isolated non-8399 port.
Keep launch, drive and cleanup in one shell so its children stay alive:

```bash
RUN=$(mktemp -d /private/tmp/hn-neo-history-XXXXXX)
.claude/skills/verify/launch.sh 9386 "$RUN"
trap '.claude/skills/verify/stop.sh "$RUN"' EXIT
HYPERNEO_DATA_DIR="$RUN/data" bun .claude/skills/verify/neo-human-history-latency.ts 9386 "$RUN"
```

The helper refuses port 8399 and requires a live owned daemon PID and a log
naming its run-local database. It seeds 200,000 synthetic rows into only that
test database: 30 old worker-batch rows, then newer session-to-session rows with
4 KiB bodies that the human view hides. No real DB is opened or copied. About
1 GiB of free space is needed.

End state: three real `neo.conversation.read` RPCs each return exactly the 30
worker-batch rows in order, and each completes below 250 ms including the RPC
client startup. `evidence/human-history-latency.json` records every duration.
`VERIFY_HISTORY_EXISTING=1` rereads an existing fixture, for an upgrade check.
