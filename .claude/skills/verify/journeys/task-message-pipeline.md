# Task message target decisions

Run with the isolated proof wrapper from SKILL.md on both dev and the change:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/task-message-pipeline.ts
```

The helper starts a daemon with a synthetic Space, task and workflow run. It invokes
`task.message.send` through the daemon operation registry as a workflow worker and
checks missing recipient, missing node and missing task refusals. Compare replies
on dev and the change. This journey does not exercise successful delivery or a
live model; the task message delivery regression covers synthetic delivery.
