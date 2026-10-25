# Cleanup successor admission runs on the writer

Use a fresh synthetic daemon, no provider or HTTP mock, and a scrubbed environment:

```sh
RUN=$(mktemp -d /private/tmp/hn-cleanup-enqueue-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/lane-b-cleanup-enqueue.ts "$RUN" > "$RUN/daemon.log" 2>&1
```

The helper owns an ephemeral daemon listener and closes all resources. It stops
only its own processor, seeds a due cleanup job, then resumes the real registered
handler. The main connection rejects SQL attempted from the cleanup handler.
Expect the due job to complete and exactly one pending successor about an hour
later. Real `system.health` RPC replies before and after the job are retained in
`evidence/cleanup-enqueue.json`, along with the final job and successor rows.
The pre-fix daemon records one prohibited main SQL attempt and fails the assertion.

Focused tests cover concurrent successor admission, retention, existing pending
jobs, and enqueue-worker failure without fallback. This journey proves only
recurring cleanup admission: startup enqueue, other queues, contention latency,
full performance metrics, and worker death after commit are not verified here.
