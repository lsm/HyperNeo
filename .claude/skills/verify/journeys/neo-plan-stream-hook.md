# Per-message context under native streaming input

Use the pinned runtime and shared resource/isolation setup from SKILL.md.
Run the risk test before implementing the per-turn context hook.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/neo-plan-stream-hook.ts verify
```

The helper owns a fresh NODE_ENV=test daemon, HOME/data/DB and loopback model
on ephemeral ports excluding 8399/8499. It registers a synthetic provider through
RPC and configures the SDK child to use only that loopback origin. No provider
key is set in the parent environment. Its transport-only fixture disables the
sandbox and installed external tool servers. It never uses the live daemon.

Open root Neo and send three distinct messages through neo.message.send, waiting
for each native SDK result before the next input. Instrument the live agent's
existing options builder to register a UserPromptSubmit recorder. The real SDK
must call it once for every message, on the same session and one ongoing query.
Each additionalContext marker must reach an actual model request. A mocked SDK
or a direct callback invocation cannot establish this contract.

stream-hook.json records the hooks, model requests, build count, successful
results and final pass flag. The helper closes its socket, daemon, SDK process
and model in finally. The wrapper saves evidence and removes temporary data.
If the hook does not fire for every input, stop and report before implementing
another delivery path. This risk proof does not establish compaction/restart
rehydration or plan-change delivery, which require the feature proof.
