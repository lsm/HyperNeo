# A done request with an unmet outcome check

Use the shared metadata-only isolated daemon setup in SKILL.md. This helper
owns an ephemeral daemon, uses only synthetic data, disables external HTTP,
and needs no model or provider.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-done-unmet-check.ts verify
```

Through the agent MCP door, Neo closes a coding PR todo whose PR check has not
passed, then ticks it done with `neo.todo.edit`; both leave it `blocked` by
`check` with a `check_unmet:` reason and no finish time, never
`closed_unverified`. A core evidence todo pointing at a wrong path is closed the
same way. A real todo-runner sweep keeps both blocked, and the public ask read
shows `Blocked: check_unmet:` rather than Closed unverified, before and after
restarting the isolated daemon. After restart Neo fixes the wrong check with
`neo.todo.edit` to an existing file; the next sweep finishes it as done while
the PR todo stays blocked.

A separate ask settled done by `neo.ask.settle` still records its unfinished
todo as `closed_unverified`; settlement is the only path to that state.
Evidence is `observed.json` and `proof.log`. The wrapper removes synthetic
daemon data after preserving evidence.
