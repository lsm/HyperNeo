# A failed cross-model review goes back to the PR's author

Use shared isolation and cleanup in `../SKILL.md`. This proof runs the real
coding-pack sweep (ledger read, PR events, PR sweep) on an isolated database
with the full daemon schema. The GitHub read and the session delivery are
synthetic; no daemon port, provider, model, `gh` or external HTTP is used.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/coding-cross-review-fail.ts
```

A repository requires bot approval and a cross-model review. One PR has bot
approval and green CI on its head, and an author todo that claims it. Observe
`coding-cross-review-fail.json`:

- before any review the PR is `waiting_cross_review` and the author is not told;
- after a cross-model `fail` is recorded on that head, the PR is
  `changes_requested`, its owner is the author session, and the author is told
  at once with the review findings;
- 20 minutes later with no push, the author is reminded with the findings, and
  Neo is not asked for another reviewer;
- after the author pushes a new head, the PR waits for a cross-model review again.

This does not show the message reaching a live worker session, or the verdict
arriving through `neo.coding.result`; the fail is recorded with the same ledger
write that operation uses.
