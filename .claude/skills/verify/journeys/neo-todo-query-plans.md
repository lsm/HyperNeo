# Neo todo query plans and PR windows

Use synthetic rows only. This slice changes indexes and PR attribution windows;
gateway routing and responsiveness under lock contention remain in #8711.

From the worktree root, run `bun .claude/skills/verify/todo-query-plans.ts`.
The fixture has 376 asks, 1,213 todos and 989 session rows, matching read-only
observed counts without copying live data. It deliberately includes equal starts,
null starts, null refs, shared refs and todos without sessions. Timings are warm
in-memory SQL microbenchmarks, not end-to-end latency or evidence about live stalls.
Save baseline output before changing production code and fixed output afterward.
Recovery must use indexed searches, per-ask ordering must need no temporary sort,
and the current window plan must use the ref index without a correlated subquery.

Run the targeted `neo-todo-query-plans.test.ts` and `neo-coding-todo-prs.test.ts`
tests from `packages/daemon`. Every synthetic window must match the original
strictly-later-start query, including missing/null bounds.

Follow journey 9 to boot baseline, upgrade and restart the isolated daemon.
Before launching baseline, seed a fresh run with its
`.claude/skills/verify/neo-todo-collapse-seed.ts` under the shared scrubbed
environment (fresh HOME, data directory, NODE_ENV=test and selected TMPDIR).
Use the baseline checkout's seed so the starting database has the old schema.
After upgrade and restart inspect its synthetic DB read-only:

```sh
sqlite3 -readonly "$RUN/data/daemon.db" "SELECT name FROM sqlite_master
  WHERE type='index' AND name IN ('idx_neo_todos_ask_order',
    'idx_neo_todos_state_ask', 'idx_neo_todo_sessions_ref') ORDER BY name"
```

All three indexes must survive restart. Launch the upgraded daemon again and
run `doctor.sh` plus `rpc.ts neo.snapshot '{}'` against its isolated port; save
the replies. Expect the two seeded cards with three and one blocked todos,
respectively, in their original order. End state: the daemon serves the populated
Neo snapshot after schema upgrade.
No provider turn or GUI is needed for this query-only slice.
