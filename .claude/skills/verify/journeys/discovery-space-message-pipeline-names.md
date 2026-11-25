# Discovery, space and message pipeline names

Run on base and changed tree with Bun 1.4.4:

```bash
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/discovery-space-message-pipeline-names.ts verify
python3 .claude/skills/verify/compare-schedule-pipelines.py "$BASE_EVIDENCE/discovery-space-message-pipeline-names.json" "$CHANGED_EVIDENCE/discovery-space-message-pipeline-names.json"
```

The isolated daemon invokes discovery, space and message operations through authenticated RPC, including missing records and a refused node message. Both runs must exit zero and their normalized replies must match. Generated IDs and creation/update timestamps are normalized; other reply data is compared.
