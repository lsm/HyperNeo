# Claude subscription usage through the real operation

This journey starts an isolated daemon, stores a synthetic Claude subscription
(`providers.create` with `authType: oauth`), seeds two synthetic
`rate_limit_event` rows, and invokes `settings.provider.usage` over the
authenticated local WebSocket RPC door. No model turn, browser, external
provider request or real credential is involved.

The control request needs a live subscription session. When usage is
unavailable, the operation must ignore both stored events. The records have
no account identity and can outlive the login that produced them.

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
`run-status.json`. A passing run prints `passed: true`, `windows: 0`, and
`ignoredEvents: 2`. The evidence must not contain the synthetic access token.
The unit contract covers live window fields, API-key usage, and the fresh SDK
profile used to isolate usage from the system profile.
