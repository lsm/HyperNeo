# Closing a todo that never started

Use the shared metadata-only isolated daemon setup in SKILL.md. This helper
owns an ephemeral daemon, uses only synthetic data, disables external HTTP,
and needs no model or provider.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-close-never-started.ts
```

Through the agent MCP door, Neo closes a never-started `core.evidence` todo whose
result file does not exist. The close is refused, names `neo.todo.remove`, and
the todo row is unchanged, so it never becomes `blocked` by `check`.
`neo.todo.remove` then cancels it directly. A never-started todo whose check
already passes still closes as done. Evidence is `observed.json` and `proof.log`.
