# Build a data-only todo-state writer result

This is the build rung of #8712. Existing RPC/job recompute callers stay on
their legacy path until the admission and wiring slices. This journey proves
the new command and its state as observed through a real daemon snapshot; it
does not claim those existing routes have moved off main.
The command publishes no Neo events and starts no work. Later wiring must
notify and attempt advancement after the awaited commit reply; `startNext` is
a candidate ID, not a reservation to start it.

Use the shared metadata-only setup, disk guard and cleanup wrapper in SKILL.md.
Do not run this helper while a memory or daemon-proof hold is active.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/todo-state-command.ts verify
```

`EVIDENCE` is a fresh absolute directory outside the disposable daemon run.
The helper owns an ephemeral daemon, a synthetic manual Neo session, its
GitHub refusal stub and a fresh database. No provider, model, GUI, live data or
port 8399 is involved.

An ordered ask has a doing predecessor, a pending successor and a stale start
question. A trigger refuses the ask timestamp after pruning and the todo
write. The new command must roll back all three changes; the real WebSocket
snapshot must still show no completed todo and retain the question. Removing
the trigger must commit completion and pruning, return `{todo, startNext}` and
leave the successor pending. The command cannot invoke external work or carry
an advance callback. The complete report bytes and SHA-256 must survive its
reply; evidence records reply bytes, round trips, RSS delta and WAL growth.

Run `before` on the test-first pre-fix commit in the same checkout and save to
another evidence directory. It uses the legacy recompute boundary and records
the false completed state and retired question after the same refused ask
stamp. Baseline SQL runs on main; only the new build command must record zero
target main SQL. Other unported runtime callers remain outstanding.

The helper then holds a synthetic WAL writer lock for 1.2 seconds and checks
the real health RPC. The new command must keep health below 250 ms and loop
lag below 1 s. Its affected write still exceeds 250 ms: report the failure
explicitly. This phase drives the command directly; snapshot reads observe
the committed result. Queue, SQL and clone stages are not separately timed.

Run the focused state-writer parity cases, existing recompute tests and Deno
command smoke after resource holds lift. Parity covers done/failed/blocked,
human authority, closed asks, removed work, next candidates, pruning and full
reports. Live admission and automatic dispatch proof belongs to later wiring.
