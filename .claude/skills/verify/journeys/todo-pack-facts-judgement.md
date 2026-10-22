# Coding todo facts and pure judgement

This step-2 slice adds `pack.readFacts(todo)` and `pack.judge(todo, facts)`.
`readFacts` owns the existing pack I/O and captures its observation time. `judge`
replays only the provided data: done, failed, blocked(reason) or no opinion. The
coding implementation uses done/failed/no opinion. Existing packs without a todo
judgement remain supported. Current completion consumers still call the existing
`todos.check` facade; recompute cut-over and the final import guard are later work.
No new ledger acquisition or ledger API is introduced.

Use shared SKILL.md isolation setup, with a fresh directory and free non-8399
port (9453 below). No HTTP mock, provider, model or GUI is needed:

```bash
RUN=$(mktemp -d /private/tmp/hn-todo-facts-XXXXXX)
mkdir -p "$RUN/home" "$RUN/bin"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/todo-pack-facts.ts 9453 "$RUN"
```

The helper owns the real daemon, synthetic DB/home and GitHub refusal/PR stub.
An actual `neo.todo.close` RPC first refuses an open PR. The coding pack's fact
read leaves the stored todo unchanged. Change the synthetic upstream after that
read: repeated pure judgement must still return the captured merge with zero
additional reader calls. The real RPC later accepts a stubbed merged PR; the
current manual-close evidence remains the supplied reason (`Observed merge`).
Its complete report bytes and SHA stay identical. The helper saves RPC receipts,
judgement, reader counts, stored state/hash, main SQL summary/slow-log timings,
event-loop lag, RPC latency and interval-sampled RSS to `evidence/observed.json`.
RSS is not an OS high-water mark, SQL has retention limits, and small synthetic
measurements do not prove live/large-workload performance acceptance.

The contract-first baseline must reach the RPC refusal then fail because
`pack.readFacts` is absent. Keep that evidence and any inconclusive runs. New CI
unit contracts cover incomplete observations, unsupported/foreign rules,
closed-PR replacement grace at explicit observation times, no state write during
reading, and replay after closing the DB. Existing assertions stay unchanged;
unit suites run in CI only. Finally closes the WebSocket and daemon; no live DB,
real home, credentials or port 8399. Keep evidence outside the worktree, remove
the worktree after merge/close, and verify deployed commit with `hyperneo build`.
