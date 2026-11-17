# Publication operation pipeline names

Run on the base and changed tree with Bun 1.4.2:

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/publication-pipeline-names.ts
```

The isolated daemon publishes through MCP and reads through the human RPC door.
It records empty and populated pages, a missing conversation and a missing session.
Both runs must exit zero. Compare their replies after normalizing generated timestamps:

```bash
python3 .claude/skills/verify/compare-publication-pipelines.py /absolute/base/observed.json /absolute/changed/observed.json
```

No provider or live credentials are used.
