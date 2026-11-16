## Copilot bridge image limit

```bash
NODE_ENV=test bun .claude/skills/verify/copilot-bridge-image-limit.ts
```

Starts the real Copilot bridge HTTP server with a synthetic model catalog (no
Copilot account, credentials or provider key) and posts a compaction-shaped
request whose history holds three screenshots to a model that accepts one image
per request. Expect status 200, exactly one attachment (the newest image) and two
`[earlier image omitted: ...]` placeholders in the prompt. The same request to a
model without vision must still return 400 `does not support vision`. The script
prints both observations and `PASS`, and exits non-zero on any mismatch.
