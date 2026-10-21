## Neo coordinator models in web Settings

Build the web UI with `bun run --cwd packages/web build`, then run:

```bash
NODE_PATH=<directory-containing-playwright> \
  bash .claude/skills/verify/neo-model-settings.sh "$RUN" 9381 9382
```

Use a fresh absolute synthetic run directory. Both ports must be free and neither
may be 8399; the helper uses a separate local model fixture without port 8000.
It starts from `env -i`, synthetic HOME/data/DB, NODE_ENV=test and a GitHub stub.
The only synthetic provider credential is created through RPC in that test DB.
Set `VERIFY_BROWSER` to an installed Chromium executable when Playwright's own
headless browser is unavailable. The browser always runs headlessly.

The actual built Settings > Models page must select a Neo primary, add two
fallbacks through the shared model picker, set each thinking level, reorder and
save. The helper checks persisted preferences through real `neo.snapshot` RPC,
then reloads desktop/mobile pages and checks values, order, usable provider text
and control bounds. Disabling fallbacks must persist an explicit empty chain
after reload. Evidence: `evidence/neo-model-settings.json` and desktop/mobile PNGs.
Browser and helper-owned daemon/mock close on success or failure.

Focused Settings contracts also cover cross-provider catalog entries, server
thinking options, unavailable providers, human-operation refusal retaining edits
and primary-only edits preserving inherited fallback behavior. This web journey
uses synthetic Anthropic models; actual Anthropic-to-GLM inference is proved by
the [backend model-fallback journey](neo-coordinator-model-fallback-backend.md). No real account quota or GUI session
is used. The Settings PR contains no new fallback execution policy.
