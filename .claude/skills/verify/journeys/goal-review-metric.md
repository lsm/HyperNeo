# Goal review metrics

Run the isolated daemon proof on a build/test host:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/goal-review-metric.ts
```

The helper creates a goal with a synthetic metric, fires two scheduled reviews,
records their measurements through RPC, and reads the journal, facts, goal, and
human-facing Neo publications. It checks the target report, review-only writes,
the refusal for owners without reviews, Neo's owner guidance, the missing-point guidance, and that
reaching the target does not complete the goal. Inspect the evidence
file and wrapper exit status. This does not exercise model interpretation.
