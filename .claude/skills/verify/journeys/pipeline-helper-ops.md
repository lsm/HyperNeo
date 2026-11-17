# Shared pipeline helpers answer the same

Use after changing a shared helper that builds operation pipelines (schedule,
session, scheduler, inactivity, external event subscriptions, goal trigger, Neo
peers, Neo speech). Build the web bundle in each checkout, then run the script
once on the base and once on the change:

```bash
VERIFY_MOCK_PORT=8047 .claude/skills/verify/with-run.sh \
  .claude/skills/verify/pipeline-helper-ops.sh 9347 > replies.txt
```

It launches an isolated daemon, creates a Space, and invokes 15 operations with
inputs that reach the pipeline (a typed rejection counts). Ids and times are
masked. Pass is exit 0 on both checkouts and no `diff` between the two outputs.
The web-side helpers in `packages/web/src/neo/` are not exercised here.
