## Todo dispatch acknowledgement retention (delivery slice 1)

```bash
RUN=$(mktemp -d /private/tmp/hn-dispatch-evidence-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/dispatch-evidence.ts 9387 "$RUN"
```

The real isolated daemon's MCP `neo.todo.add` and `neo.todo.continue` operations
use the production Codex and Claude CLI adapters. Synthetic Unix-socket peers
return a Codex queue ID, confirm a steer turn ID, or accept Claude inbox bytes
without confirming consumption. CLI discovery and registrations are synthetic;
`claude` and `gh` are stubbed. No real app/CLI, credentials, provider, live DB,
GUI or port 8399 is used.

The helper closes and restarts the daemon, then opens only its synthetic DB
read-only. Queue/unconfirmed acknowledgements must remain distinct from a turn
start, every input/queue ID must survive, and continue must replace the previous
acknowledgement with the actual steer result. `evidence/observed.json` retains
operation replies, peer calls and recovered repository evidence. Before the fix,
this journey reaches a successful queue insertion and doing todo, then fails
because the acknowledgement was discarded. It is not enough for the todo-add
operation alone to return `ok:true`; its embedded todo must also have started.

Run the focused `neo-todo-runner`, `neo-driver-work` and `neo-input-attribution`
unit suites too: old receipt envelopes remain readable, malformed delivery data
cannot create facts, ref changes invalidate evidence, and unconfirmed acceptance
survives actual DB close/reopen. This slice proves retention of the latest send,
not an append-only obligation history, delivery deadlines, retries, idle queue
activation, first worker output, canonical owner recovery or new UI states.
