# Neo snapshot stays responsive with mostly inbound history

Build and launch with the shared SKILL.md setup on an isolated non-8399 port.
Keep launch, drive and cleanup in one shell so its children stay alive:

```bash
RUN=$(mktemp -d /private/tmp/hn-neo-history-XXXXXX)
.claude/skills/verify/launch.sh 9386 "$RUN"
trap '.claude/skills/verify/stop.sh "$RUN"' EXIT
.claude/skills/verify/doctor.sh 9386 "$RUN" > "$RUN/evidence/doctor.txt"
bun .claude/skills/verify/neo-history-latency.ts 9386 "$RUN"
```

The helper refuses port 8399 and requires a live owned daemon PID and a log
naming its run-local database. It opens Neo over WebSocket RPC, seeds 200,000
synthetic session messages into only that test database (30 old outbound rows,
then inbound rows with 4 KiB bodies), and reads three real `neo.snapshot` RPCs.
About 1 GiB of free space is needed for the disposable fixture. No real DB is
opened or copied. The seeder waits for concurrent isolated-daemon writes.

End state: every snapshot returns exactly the same 30 outbound rows in order,
with no inbound rows, and completes below 250 ms including the RPC client
process startup. `evidence/history-latency.json` records every duration and fails
if any is over budget. The original code returned correct rows in
336/617/325 ms. This reproduces a slow snapshot on synthetic stored history;
it does not establish the native cause of all historical off-CPU stalls.
