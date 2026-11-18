# Review snapshots retain concurrent work

Run the isolated daemon proof:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/goal-review-snapshot.ts
```

The helper appends 25 synthetic journal entries through RPC and fires the
registered review handler. The wake contains the newest 20, names five older
entries and exposes a cursor for `goal.journal.list`. It appends work after the
wake but before the review result, fires the next review, and checks that the
concurrent entry appears there. Inspect `goal-review-snapshot.json` and the
wrapper exit status.
