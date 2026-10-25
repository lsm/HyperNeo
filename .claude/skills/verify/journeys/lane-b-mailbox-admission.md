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
move receipt-based submission, delivery/consumption, session lookup, or mailbox
expiry SQL, and does not establish contention, clone, RSS, or loop-lag targets.
