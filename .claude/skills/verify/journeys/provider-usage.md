# Kimi provider usage through the real operation

This journey starts an isolated daemon and a loopback Kimi Coding usage fixture. It stores a synthetic Kimi key through `providers.create`, invokes `settings.provider.usage` over the authenticated local WebSocket RPC door, and checks the normalized windows. It also checks the exact `/coding/v1/usages` path, Bearer use without recording the header value, epoch-second conversion, dropping an incomplete row, and `not_supported` for an unknown provider. No model turn, browser, external provider request or real credential is involved.

Run from the worktree root with a fresh absolute evidence path:

```bash
bash .claude/skills/verify/resource-check.sh && \
  bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/provider-usage.ts verify
```

The wrapper supplies `NODE_ENV=test`, a disposable HOME, data directory and database, and removes them after preserving evidence. The helper owns an ephemeral daemon and fixture, and stops both in `finally`.

Inspect `provider-usage.json`, `cleanup.json`, `proof.log` and `run-status.json`. A passing run prints `passed: true`, `windows: 2` and `requests: 1`. The evidence contains normalized usage only; it must not contain the synthetic key or an Authorization header value. UI rendering, caching, live Kimi responses and providers other than Kimi are outside this journey.
