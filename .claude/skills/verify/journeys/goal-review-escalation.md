# Repeated ineffective reviews ask the human

Use the shared isolated proof wrapper:

```sh
TMPDIR=/tmp bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/goal-review-escalation.ts
```

The helper opens Neo and a goal over RPC, fires three real review schedules,
appends synthetic no-effect review results through RPC, and reads the goal and
human queue. It checks that both schedules stop, an unanswered question blocks
resumption, and the human's answer can be recorded in nextSteps and delivered
in the next work wake. Inspect `goal-review-escalation.json` and the wrapper
exit status. The helper also checks the actual Neo session prompt for the
answer guidance. A second goal's review question is retired through RPC; a
resume request opens another question and the human's answer permits resuming.
This checks RPC and mailbox delivery, not browser rendering or a model's
interpretation of the answer.
