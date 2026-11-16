# An explicit OpenAI login survives a daemon restart

This journey boots an isolated daemon whose disposable HOME holds a synthetic `~/.codex/auth.json` for account B. It enables `anthropic-codex` through `providers.create` with explicit synthetic OAuth tokens for account A, then stops the daemon. A second process boots a new daemon on the same data directory and reads which login the OpenAI provider uses.

An in-process `fetch` stub refuses every non-loopback host and records it, so nothing leaves the machine.

Run from the worktree root with a fresh absolute evidence path:

```bash
bash .claude/skills/verify/resource-check.sh && \
  bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/codex-login-restart.ts
```

Inspect `codex-login-restart.json` and `proof.log`. A pass prints `passed: true`, with `usesAccountA: true` both after `providers.create` and after the restart, and empty `outbound` lists. The evidence holds only booleans and host names, never token values. Live OpenAI responses are outside this journey.
