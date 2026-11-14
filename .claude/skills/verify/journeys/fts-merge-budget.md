# Background search merge write budget

On the build host, run from the shipping checkout with the pinned Bun on PATH.
Use the shared isolated proof wrapper from SKILL.md.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/fts-merge-budget.ts verify
```

The helper creates 510,000 synthetic 256-word search documents in fifteen
segments. It copies only that generated database for identical rank 64, 128 and
1024 comparisons. Each timed BEGIN IMMEDIATE through COMMIT span owns the write
lock. It then invokes the actual background merge worker on another synthetic
copy and checks search match counts survive every merge. The worker must finish
in less than 60% of the rank-1024 lock span. `reproduce` saves the same measurements
without that assertion for baseline investigation. Evidence is `merge.json`.
This measures a deliberately large eligible segment backlog. It does not impose
a wall-clock upper bound on arbitrary indexes or attribute historical stalls.
