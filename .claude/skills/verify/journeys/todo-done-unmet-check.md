# A done request with an unmet outcome check

Use the shared metadata-only isolated daemon setup in SKILL.md. This helper
owns an ephemeral daemon, uses only synthetic data, disables external HTTP,
and needs no model or provider.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-done-unmet-check.ts verify
```

Through the agent MCP door, Neo closes a started coding PR todo whose PR check has
not passed, then ticks it done with `neo.todo.edit`; both leave it `blocked` by
`check` with a `check_unmet:` reason and no finish time, never
`closed_unverified`. A core evidence todo pointing at a wrong path is closed the
same way. A real todo-runner sweep keeps both blocked, and the public ask read
shows `Waiting for its result` rather than Closed unverified or `check_unmet`, before and after
restarting the isolated daemon. After restart Neo fixes the wrong check with
`neo.todo.edit` to an existing file; the next sweep finishes it as done while
the PR todo stays blocked.

A separate ask's `neo.ask.settle` done request is refused with `todos_unfinished`,
leaving its blocked todo and open ask unchanged. Explicit dropped settlement
removes active work without certifying it. A seeded legacy removed row without
a reason also refuses done; neo.todo.remove cannot amend that terminal row.
The refusal's explicit dropped option succeeds. Both asks remain dropped across
restart, their rows stay removed and neither counts as done. No reason is invented
for the legacy row.
Evidence is `observed.json` and `proof.log`. The wrapper removes synthetic
daemon data after preserving evidence.
