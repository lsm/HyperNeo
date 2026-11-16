# Every agent operation answers through RPC

```sh
.claude/skills/verify/launch.sh 9311 "$RUN"
.claude/skills/verify/agent-operations.sh 9311 "$RUN"
```

The script creates a Space in the isolated daemon and calls each `agent.*`
operation once through `rpc.ts`: create, list, get, update, resolve, reminder
create/list/cancel, template create/update/list/instantiate/delete and
session ensure. Each reply must carry the expected record. Template delete must
be refused with `template_rejected`, because a new Space has autonomy level 1.
The script exits non-zero on the first wrong reply and logs every call to
`$RUN/evidence/agent-operations.log`. Use it after renaming or rewiring agent
operation pipelines.
