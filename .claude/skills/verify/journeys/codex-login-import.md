# Codex login import leaves the refresh token with Codex

This journey starts an isolated daemon whose disposable HOME holds a synthetic `~/.codex/auth.json` (fake JWT access token plus a fake refresh token). It enables the `anthropic-codex` provider through `providers.create`, which imports the Codex login. Then it rewrites the Codex file as if Codex had refreshed, and calls `auth.refresh`.

An in-process `fetch` stub answers `auth.openai.com/oauth/token` and refuses every other non-loopback host, so nothing leaves the machine. The proof checks:

- enabling the provider makes no token-endpoint call, keeps the Codex file byte-identical, and stores Codex's access token with no refresh token;
- `auth.refresh` succeeds by re-reading the Codex file, again with no token-endpoint call.

Run from the worktree root with a fresh absolute evidence path:

```bash
bash .claude/skills/verify/resource-check.sh && \
  bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/codex-login-import.ts
```

Inspect `codex-login-import.json`, `cleanup.json`, `proof.log` and `run-status.json`. A pass prints `passed: true`, with `tokenEndpointCalls: 0` in both phases and an empty `outbound` list. The evidence holds only booleans and counts, never token values. Live OpenAI responses and Codex Desktop's own refresh are outside this journey.
