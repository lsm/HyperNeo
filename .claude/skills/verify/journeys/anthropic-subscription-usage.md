# Claude subscription usage through the real operation

This journey starts an isolated daemon, stores a synthetic Claude subscription
(`providers.create` with `authType: oauth`), seeds two synthetic
`rate_limit_event` rows, and invokes `settings.provider.usage` over the
authenticated local WebSocket RPC door. No model turn, browser, external
provider request or real credential is involved.

The control request needs a live subscription session, so the daemon cannot
reach one here. The adapter falls back to the latest stored event per window,
which is the path this journey proves: the five-hour window carries a
utilization of 0.87 and reads `used: 87`, and a `rejected` seven-day window
reads `used: 100`.

Run from the worktree root with a fresh absolute evidence path:

```bash
bash .claude/skills/verify/resource-check.sh && \
  bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/anthropic-usage.ts verify
```

The wrapper supplies `NODE_ENV=test`, a disposable HOME, data directory and
database, and removes them after preserving evidence. The helper owns the
ephemeral daemon and stops it in `finally`.

Inspect `anthropic-usage.json`, `cleanup.json`, `proof.log` and
`run-status.json`. A passing run prints `passed: true` and `windows: 2`. The
evidence must not contain the synthetic access token. The live control response
(its exact window labels, `model_scoped` display names and API-key
`not_supported`) is covered by the unit contract, not this journey.
