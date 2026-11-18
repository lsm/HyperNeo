# A finished todo archives the worker it started

Use the shared metadata-only setup from SKILL.md with the owned-daemon helper:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/todo-finish-archives-worker.ts verify
```

The helper boots an isolated daemon with its job processor running. It seeds four
done todos on HyperNeo worker sessions: one the todo started with a generated
name, one Neo named (`dev-6`), one the human named (the todo's `named.session`),
and one whose folder is a Git
checkout with an uncommitted file. A fifth todo is `removed` without a finish
time, as `neo.todo.remove` leaves it. A sixth start request landed on an existing session without a worker-start marker and with a dirty folder. It moves the pending driver refresh
job to now and waits for that job to run.

End state in `todo-release.json`: the generated-name worker, the Neo-named
worker and the removed todo's worker are `archived`; the human-named worker and the worker with unsaved work
stay `active`. The existing session also stays active, has no release fence row, and its terminal fact records `not_started_by_us`. One `core/released` fact exists for each archived worker. All
archived workers carry `released_at` in `work_started_sessions`, and with every
`unusable_at` mark cleared (as after an hour) none of them is in the free-worker list
the reuse path reads. `proof.log` shows the
"uncommitted changes" pending warning that a later refresh rechecks. No model,
provider or real data is used.

Run the pending notification proof with the same isolated setup:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/todo-release-pending.ts verify
```

The helper advances a synthetic clock through repeated daemon refreshes and
checks that a dirty worker produces one Neo mailbox event after 24 hours,
with the todo, worker and reason. It also checks that a daemon-started worker
stays active while a follow-up is live and is archived after the follow-up
finishes. Retain `todo-release-pending.json` and `proof.log`.
