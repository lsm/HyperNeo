# Plain session mailbox admission runs on the writer

Run a fresh synthetic daemon with no provider or HTTP mock:

```sh
RUN=$(mktemp -d /private/tmp/hn-mailbox-admission-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/lane-b-mailbox-admission.ts "$RUN" > "$RUN/daemon.log" 2>&1
```

The helper owns an ephemeral listener, creates a manual session over real RPC,
pauses only its own job processor, and calls `message.send` through
`operation.invoke`. Main SQLite rejects admission from the handoff/enqueue stack.
Expect acceptance, one matching mailbox job with the correct destination and
message identity, the complete 270,000-byte content hash, and healthy before/after
RPC replies. Evidence and affected RPC latency are in
`evidence/mailbox-admission.json`. The pre-fix daemon fails with one forbidden
main SQL attempt. The helper closes its own resources in finally.

The self-contained Deno smoke block runs the same proof in CI. Focused handoff
and mailbox tests retain validation, serialization rejection, unique pending
admission, and worker-failure behavior without fallback. This slice does not
move receipt-based submission, delivery/consumption, ordinary-send session lookup, or mailbox
expiry SQL, and does not establish contention, clone, RSS, or loop-lag targets.

The helper also invokes the real schedule-delivery coordinator twice concurrently
against that daemon's database. Both attempts share a scheduled message identity;
the writer must commit exactly one mailbox row. Session liveness, existing SDK
message and active mailbox checks, wake metadata and enqueue execute in that one
writer command, with all corresponding main-connection SQL forbidden. Unit tests
also abort the queue insert and require wake metadata to roll back before retry.
Queue-mock consumer tests explicitly bind a mock admission gateway; production
never falls back to calling those main-connection queue methods.
