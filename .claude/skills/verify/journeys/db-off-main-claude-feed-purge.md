# Claude feed purge leaves the main event loop responsive

Read shared SKILL.md. This is an isolated app-wired `work.feed.claude` job plus
independent `system.health` WebSocket RPC, with a fresh synthetic HOME/data/DB.
No GUI, provider, credentials, real DB copy, port8399 or live daemon access.

```bash
RUN=$(mktemp -d /private/tmp/hn-claude-purge-XXXXXX)
env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test \
  bun .claude/skills/verify/claude-feed-purge-worker.ts "$RUN"
```

Run unchanged on the test-first commit: the responsiveness assertion must fail.
The fixture seeds1200 full synthetic stored tool results and derived Claude/Codex
search rows with the existing production FTS/vector cleanup triggers. One extra
synthetic BEFORE DELETE trigger adds a deterministic recursive SQL cost to the
first Claude purge statement. This reproduces a slow SQLite command, not the
physical cause of the historical3.2s off-CPU production stall. Seed/hash work is
outside the measurement interval. The existing purge predicate and batching are
used unchanged; stored source messages/tool results must retain their full logical body hash across inline and side storage.

`evidence/purge.json` retains max main lag, independent health latency, whole job
latency, main/worker SQL and command timing, completed job and remaining rows.
Moving a slow command offmain must keep lag below1s and health below250ms;
it does NOT make the affected job or worker SQL meet250ms. Keep any such misses
explicitly in the PR. All120 Codex rows survive and duplicate Claude rows go to0.

Repeat with `VERIFY_WRITER_IPC=1` for the existing real-Bun-worker JSON IPC bridge.
The helper closes the probe, daemon and every worker in finally, including failed
runs. Never run any cleanup or migration against stored human data.

With the default5-job concurrency, another legacy main-thread writer can wait
for the purge's SQLite lock. The strict responsiveness run currently FAILS for
that coexistence case; preserve it and do not label it a responsiveness pass.
Use the helper's third argument `movement` to separately assert worker ownership
of the slow purge SQL, absence of main purge SQL and full data correctness;
`responsivenessPass` remains false when lag/health budgets are missed. Its
`mainTransactions` stacks retain the separate contending caller for the next
unit. The existing1-job configuration may still contend with other processors.
