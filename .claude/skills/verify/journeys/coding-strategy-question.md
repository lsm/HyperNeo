# Coding session strategy migration

Use the shared isolated daemon setup in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-strategy-question.ts
```

The helper seeds a host-prefixed repository's saved `per_pr` coding preference
and its owning project, then restarts the isolated daemon. The public preference
operation must show `per_todo` on the project and retain `per_pr` on the coding
repository. A coding worker-target decision keeps the old strategy and does not
ask another coding strategy question. Evidence is `strategy-question.json`.

No live database, provider, credentials, model or GUI is used. The separate
`session-reuse-card.md` journey verifies the new card in the browser.
