# Spark honors the session thinking setting

From the repository root, run the isolated request proof using the pinned Bun
and an unused evidence directory.

```bash
bash .claude/skills/verify/proof-run.sh /tmp/spark-thinking-evidence .claude/skills/verify/spark-thinking-off.ts
```

The helper uses the real custom endpoint provider and its Anthropic-compatible
HTTP bridge. A local fixture supplies the upstream response. Require three
successful requests. Off must set `enable_thinking: false` while preserving
other template values. High must forward the 24,000-token budget. Auto must
leave the model template's thinking default in effect.

This checks the request sent to the upstream. It does not run inference or
measure compaction performance.
