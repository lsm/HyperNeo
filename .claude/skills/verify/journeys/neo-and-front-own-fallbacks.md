# Neo and the front fall back to their own saved models

Use the [fallback-query-wait](fallback-query-wait.md) helper and wrapper with
`--neo`, then again with `--front`, before the run directory:

```sh
bash .claude/skills/verify/proof-run.sh <absolute-fresh-evidence-dir> .claude/skills/verify/fallback-query-wait.ts --neo
```

The helper saves a global chain (Sonnet) and, for Neo and the front, their own
fallback list (Opus at think8k). With `--neo` it binds a synthetic `neo:` root
session; with `--front` it creates the front session whose id derives from the
Neo conversation. Each session hits the scripted usage limit on Haiku.

The recovered query must start on Opus with think8k, not the global Sonnet, and
consume the same prompt. Without a flag the ordinary session must still take
the global Sonnet entry. Retain `fallback-query-wait-neo.json` and
`fallback-query-wait-front.json`. The SDK is scripted; real provider limits,
the browser and returning to the preferred model are not covered here.
