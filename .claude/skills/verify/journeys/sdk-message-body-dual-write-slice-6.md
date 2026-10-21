### SDK message body dual write (slice 6)

Use a fresh synthetic corpus and an isolated daemon on a free non-8399 port:

```bash
RUN=$(mktemp -d /private/tmp/hn-sdk-body-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-live-query-filters.ts seed "$RUN"
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/sdk-body-dual-write.ts 9332 "$RUN"
```

The seed uses production `deriveSdkMessageColumns` and
`replacement_metadata_normalized=1` on 55,014 synthetic historical rows. The
helper starts the real daemon, writes complete 700,000-character tool results,
updates result flags, then calls `session.create`, `message.send` and
`liveQuery.subscribe` over WebSocket. It waits for asynchronous mailbox
materialization before inspecting the body copies. It deletes one synthetic
message through SQL to check follow-delete cleanup and retains another tool
result byte-for-byte. No production deletion or retention policy is added.

End state: `evidence/observed.json` records equal body hashes across a full daemon
restart, unchanged historical body hash, identical transcript rows/metadata,
query timings and 10 ms heartbeat lag. LiveQuery's in-memory version resets on
restart and is excluded from content equality. `rpc-before-restart.json` and
`rpc-after-restart.json` retain the full actual responses. Max lag must be below
1,000 ms and measured SQL below 250 ms. Integrity hashing is outside the measured
hot paths; startup SQL is not individually timed. The helper stops both daemon
instances in `finally` and uses no provider, real keys or GUI. The accepted input
may settle as failed with no provider; this verifies persistence and transcript
delivery, not model execution. Unit contracts cover the remaining writer doors,
failure rollback, nested transactions and status-only updates in CI.
