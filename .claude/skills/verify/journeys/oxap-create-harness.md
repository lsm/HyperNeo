# Choose a harness at session creation

Use the isolated setup and pinned Bun in `../SKILL.md`. Supply a verified
release binary as described in `oxap-hub-settings.md` and run the admission
journey through the public WebSocket RPC:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oxap-create-harness.ts /absolute/oxap RELEASE-NAME SHA256
```

The server returns the provider default when the request omits the harness and
stores an SDK or OXAP override when explicitly requested. The fixture also clones
an SDK chat with an OXAP default and an OXAP chat with an SDK default. Each child
keeps its parent's harness.

Refusals cover unknown and unsupported harnesses, a nested `config.harness`,
unsupported OXAP restrictions, a missing setting or key, and removal of the
saved adapter executable or installed hub. Each refusal leaves the session count
unchanged. `result.json` records the accepted creations, refusals and clones.
The journey exercises creation and cloning. It does not send a model turn.
