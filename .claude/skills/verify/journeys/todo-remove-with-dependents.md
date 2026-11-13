**Removing a prerequisite ends in continued dependents, removed dependents, or one card.**

Use the shared isolated metadata-only setup in SKILL.md. No model, provider,
worker, browser, real GitHub or credential file is used; external HTTP is
disabled. The helper owns its daemon and closes it in finally.

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-remove-with-dependents.ts verify
```

Through the real agent MCP door, as a Neo session, each case builds A, then B
and C after A, then D after B:

- `neo.todo.add` without `after` is refused; with `after: []` the todo waits for nothing.
- `neo.todo.remove` on A with `dependents: 'continue'`: B and C lose the edge, no card.
- With `dependents: 'remove'`: B, C and D are removed, no card.
- With neither: one choice card (`Continue`, `Remove these`) on the root ask lists
  B and C and the removed A it decides; both keep their edge to A.
- The human answers that card through `neo.question.answer` on the human door.
  `Continue` drops the edge of B and C; `Remove these` removes B, C and D.

Evidence is `observed.json` and `proof.log`. This proves the operations and the
stored rows, not how Neo words its next turn or how the card renders.
