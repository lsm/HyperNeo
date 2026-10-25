# Session event receipt and mailbox submission run on the writer

Use a fresh synthetic daemon with no provider, HTTP mock or UI:

```sh
RUN=$(mktemp -d /private/tmp/hn-event-submission-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/lane-b-event-submission.ts "$RUN" > "$RUN/daemon.log" 2>&1
```

The helper owns an ephemeral daemon, creates a manual session over RPC and pauses
only its job processor. It seeds a synthetic subscription and ingests feedback
through the existing session-event writer, retaining production-derived rendering.
The daemon's actual registered external-event subscriber routes two concurrent
notifications. Main SQLite rejects every receipt/enqueue access from that producer.
Expect one mailbox job and one matching durable receipt, with the complete canonical
message hash intact. The public `message.status` RPC must report `queued`.

Changing the content under the same identity must reject with an idempotency
conflict. Aborting receipt insertion must roll back the mailbox job; removing the
synthetic trigger must permit a clean retry. Evidence includes route results,
submission latency, body bytes/hash, health and the forbidden main-SQL count in
`evidence/event-submission.json`. The pre-fix helper fails after two blocked main
SQL attempts. All resources close in finally.

The self-contained Deno smoke block runs the same proof in CI. Unit tests retain
replay after job consumption, destination identity, delivery-mode replay, both
insert rollback paths and worker failure without fallback. This proof observes
submission and queued status; it does not execute the delivery consumer or model,
port subscription/routing reads, or establish contention, clone/RSS/loop-lag targets.
