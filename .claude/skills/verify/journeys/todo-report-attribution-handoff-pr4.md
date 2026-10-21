## Todo report attribution (handoff PR4)

```bash
RUN=$(mktemp -d "$PWD/.verify-todo-report.XXXXXX")
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/worker-todo-report.ts "$RUN" 9364
```

Use a fresh synthetic directory and free non-8399 port. The actual SDK calls
`neo.todo.add` with `start:true` through MCP. The real todo runner dispatches
through `work.send`, stores its receipt and reads `work.status`; the fixture
models consumption, a mid-turn human input, a full assistant report with an empty
terminal result, and a separate later turn. The SDK then reads receipt-bound
status over MCP. The stored todo report and Neo's emitted note must contain all
8,701 report bytes with identical SHA-256 and exclude the later turn. Repeated
refreshes must not duplicate or truncate the report; SDK/body rows stay unchanged.
`evidence.json` records maximum observed event-loop lag against the 1 s goal.
Unit contracts additionally cover reports larger than the excerpt limits, many
assistant rows across pages, shared terminal watermarks, pending/missing inputs
and incomplete terminal history. This proves todo dispatch, settlement and its
SDK/MCP interface using synthetic runtime evidence, not PR5 answered linking or
GUI rendering. Stop the isolated SDK/model server and preserve evidence before
removing only this synthetic run directory.
