# Daemon operation pipeline names

Run on base and changed tree with Bun 1.4.4:

```bash
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/daemon-operation-pipeline-names.ts verify
python3 .claude/skills/verify/compare-daemon-operation-pipelines.py "$BASE_EVIDENCE/daemon-operation-pipeline-names.json" "$CHANGED_EVIDENCE/daemon-operation-pipeline-names.json"
```

The isolated daemon invokes all six operations over authenticated RPC, including missing records, attaching and detaching a synthetic daemon, and a refused loopback probe. Both runs must exit zero and their normalized replies must match. Generated IDs and capture/create/update timestamps are normalized; other reply data is compared.
