# An idle worker with an open pull request reaches Neo as a digest

Use shared isolation and cleanup in `../SKILL.md`. This proof boots one fresh
synthetic daemon on an ephemeral loopback port with the job processor stopped,
so no model, provider, browser or external HTTP is used.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/neo-coding-idle-open-pr.ts
```

The helper seeds three started todos on a synthetic Neo session, each with a
recorded todo pull request and a PR ledger row, and runs the real pack sweep
(`NeoService.sweepPacks`) twice at each time with a controlled clock. Observe
`neo-coding-idle-open-pr.json` and the `neo_notes` and `mailbox` queues:

- the todo whose worker is idle while its pull request waits for review is one
  `coding.idle_with_open_pr` digest line, not repeated within the hour, and
  told once more at the 4 h rung;
- when its ledger state changes to failing, it is told again with the new state;
- once its worker runs again it is no longer told;
- the todo with a running worker is never told;
- the todo whose pull request merged is not a digest; it wakes Neo as an idle
  worker with nothing pending (`todo.neo_step`).

This does not show the digest flush being consumed by a model turn, or ledger
rows read from GitHub; the ledger rows are written directly.
