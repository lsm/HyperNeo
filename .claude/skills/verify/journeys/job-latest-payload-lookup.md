## Latest delivery job lookup

Run the actual isolated daemon with a blank environment and synthetic HOME/data:

```bash
RUN=$(mktemp -d /private/tmp/hn-job-latest-XXXXXX)
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/job-latest-payload.ts verify "$RUN"
```

Use `reproduce` on the regression commit. The helper seeds 300,000 complete
synthetic job payloads in mailbox and delivery history, with two same-timestamp
failed mailbox entries. It invokes `message.status` through the real WebSocket
operation door for a missing message and a failed message. An independent child
measures `system.health` while the daemon measures its event loop. No GUI,
credentials, model, real DB or production mutation is involved.

`observed.json` retains exact synthetic caller stacks, actual query plans, RPC,
health and loop latency, plus full stored payload SHA before/after. Verify requires
all three latency surfaces below 250ms, the same unknown/failed result and latest
failure reason, and unchanged payloads. The helper closes its child, socket and
daemon in `finally`. Natural synthetic traversal demonstrates query work; it does
not establish the physical cause or exact caller of the historical 2.887s query.
