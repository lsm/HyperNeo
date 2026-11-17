# Schedule operation pipeline names

Run on base and changed tree with Bun 1.4.2:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/schedule-pipeline-names.ts verify
python3 .claude/skills/verify/compare-schedule-pipelines.py /absolute/base/schedule-pipeline-names.json /absolute/changed/schedule-pipeline-names.json
```

The isolated daemon invokes create, list, get, update and delete through authenticated RPC, then checks missing-record replies and the empty list. Both runs must exit zero and the normalized replies must match. Generated IDs and creation/update timestamps are normalized; all other reply data is compared. No provider or live credentials are used.
