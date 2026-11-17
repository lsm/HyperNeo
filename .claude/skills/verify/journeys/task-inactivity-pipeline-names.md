# Task and inactivity operation pipeline names

Run on base and changed tree with Bun 1.4.2:

```bash
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/task-inactivity-pipeline-names.ts verify
python3 .claude/skills/verify/compare-schedule-pipelines.py "$BASE_EVIDENCE/task-inactivity-pipeline-names.json" "$CHANGED_EVIDENCE/task-inactivity-pipeline-names.json"
```

The isolated daemon invokes all eight operations over authenticated RPC, including missing task and agent replies, a task roster, inactivity configuration, and a scan. Both runs must exit zero and their normalized replies must match. Generated IDs and creation/update timestamps are normalized; other reply data is compared.
