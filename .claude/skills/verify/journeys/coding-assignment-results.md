# Linked coding assignments and public stage results (Build)

Read shared isolation setup in `../SKILL.md` and `coding-stage-facts.md`. This
metadata-only proof starts its own real daemon twice on ephemeral loopback ports,
with a fresh synthetic DB/home. No model, HTTP mock, real GitHub or browser is
needed. HTTP is refused; neither provider credentials nor port 8399 is used.

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-assignment-results-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/coding-assignment-results.ts "$RUN"
```

The helper seeds only its synthetic todo, head and assignments through the new
assignment repository's gateway writer. Real WebSocket RPC `neo.coding.result`
accepts assigned review and inconclusive QA evidence. An author ref, wrong model,
wrong contract or wrong head is rejected without replacing the recorded result.
The actual daemon's MCP adapter also refuses a mismatched result from a synthetic
bound Neo and supplies a readable explanation with the next action.
Restarting the daemon preserves the linked write/review/QA assignments and
results. A failure cannot become a pass at the same head. A new head clears both
stage facts, exposes no assignments for that head and rejects late results.
The todo stays `doing` throughout: this Build slice changes no completion gate.
Both daemon instances and sockets close in finally.

Keep `evidence/assignment-results.json`, which contains the actual RPC inputs,
replies, stored assignments, stage results and unchanged todo state. Run focused
`neo-coding-results` and `neo-coding-stage-facts` tests for additional identity,
independence, contract immutability and bot-impersonation cases.

Not verified here: actor selection/dispatch, model behavior, bot approval ingestion,
QA execution of another PR, browser/native UI or merge/completion gates. The
following #8428 slice wires dispatch; this journey proves the public result door
and persistence, not the whole actor-assignment feature.
