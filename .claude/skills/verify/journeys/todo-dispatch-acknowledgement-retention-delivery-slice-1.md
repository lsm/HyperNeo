## Todo dispatch acknowledgement retention (delivery slice 1)

```bash
RUN=$(mktemp -d /private/tmp/hn-dispatch-evidence-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/dispatch-evidence.ts 9387 "$RUN"
```

The real isolated daemon's MCP `neo.todo.add` and `neo.todo.continue` operations
use the production Codex and Claude CLI adapters. Synthetic Desktop IPC and inbox peers
return a Codex opening turn ID, confirm a steer turn ID, or accept Claude inbox bytes
without confirming consumption. CLI discovery and registrations are synthetic;
`claude` and `gh` are stubbed. No real app/CLI, credentials, provider, live DB,
GUI or port 8399 is used.

Current Codex auto mode starts an idle turn; queue metadata retention is covered
by the focused driver and storage tests.

The helper closes and restarts the daemon, then opens only its synthetic DB
read-only. Unconfirmed acceptance must remain distinct from a turn
start, every input/turn ID must survive, and continue must replace the previous
acknowledgement with the actual steer result. `evidence/observed.json` retains
operation replies, peer calls and recovered repository evidence. The original pre-fix
journey reached a successful queue insertion and doing todo, then failed
because the acknowledgement was discarded. It is not enough for the todo-add
operation alone to return `ok:true`; its embedded todo must also have started.

Run the focused `neo-todo-runner`, `neo-driver-work` and `neo-input-attribution`
unit suites too: old receipt envelopes remain readable, malformed delivery data
cannot create facts, ref changes invalidate evidence, and unconfirmed acceptance
survives actual DB close/reopen. This slice proves retention of the latest send,
not an append-only obligation history, delivery deadlines, retries, idle queue
activation, first worker output, canonical owner recovery or new UI states.

The accepted Claude inbox has no pending submission ID. Its persisted todo anchor
must retain the pre-send baseline (zero in this empty synthetic transcript), both
before and after restart. This is an attribution boundary, not a consumption or
turn-start claim: `delivered` remains false, `unconfirmed` true and the exact
receipt survives. `unconfirmedAnchor` in the evidence records that boundary.
The #8198 reproduction writes the actual synthetic inbox bytes, retains the
receipt and then fails with `null !== 0` before the parser fix. Explicit pending
submission IDs and ambiguous non-delivery still wait without a baseline anchor;
the driver/runner contracts cover these cases and database reopen separately.
