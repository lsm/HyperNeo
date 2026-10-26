# Activate todo mutation operations (#8712 core 1c)

Use SKILL.md's guarded metadata-only wrapper with existing dependencies and a
fresh absolute evidence directory:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-mutation-activation.ts verify
```

This drives the actual public `operation.invoke` doors for `neo.todo.edit`,
`neo.todo.close` and `neo.todo.remove`, then reads the actual full Work card
through `neo.ask.read`. The before run rejects main-thread todo SQL in the old
edit path. The fixed run must perform that admission and edit in reader/writer
workers, with zero matching SQL on main. External completion checks and worker
stop observations remain outside the write transaction; this journey does not
claim to move those existing observations off main.

The synthetic WAL lock must delay the public edit receipt and table events
without freezing health/read RPCs. After release, both receipt and public card
contain the whole report, and the normal `neo.changed` publication arrives.
An unanswered card refuses close; a late SQL failure rolls back remove and card
pruning; a settled ask remains an unchanged successful no-op. None of those
attempts may emit a new successful-work notice. No provider or external GitHub
request is allowed. Required Deno smoke repeats the same public-door journey.

Unit operation contracts cover stop failures, a changed check/new card during
stop, after-commit successor dispatch and refreshed successor receipts. Run
them with the planner/writer, existing todo-completion and pack-boundary suites
and the full check. Runtime cleanup in finally saves
`todo-mutation-activation.json`; the wrapper removes all temporary proof data.
Real provider execution, GUI layout and the contention latency target are not
verified by this metadata-only correctness journey.
