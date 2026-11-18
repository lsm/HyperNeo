# Goal review metrics

Run the isolated daemon proof on a build/test host:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/goal-review-metric.ts
```

The helper creates a goal with a synthetic metric, fires two scheduled reviews,
records their measurements through RPC, and reads the journal, facts, and goal.
It checks the target result, review-only writes, concurrent attempts to replace a
review's metric point,
the refusal for owners without reviews, Neo's owner guidance, the missing-point guidance, and that
reaching the target does not complete the goal. Inspect the evidence
file and wrapper exit status. Automatic human reporting is tracked separately;
this does not exercise model interpretation.
