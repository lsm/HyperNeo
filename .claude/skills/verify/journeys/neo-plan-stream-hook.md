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

## Plan delivery through the native SDK

Run the same helper with `context` after the risk test passes.

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/neo-plan-stream-hook.ts context
```

This mode records the production callbacks without replacing their output. Seed
12 open local plans with unfinished steps, then send three messages through RPC.
The first model request must contain all owners. Change one recorded step before
the second input and require only that changed line. The third input must add no
context. Instrument the main connection while callbacks run and require zero
plan-table reads, proving use of the DB gateway.

Manually enqueue the same durable internal /compact command used by context
budget enforcement. Require a native compact_boundary and a real SessionStart
source=compact callback returning all owners. Send another RPC input and observe
the full digest in the post-compaction model request. Restart the SDK query with
session.resetQuery and require another full digest in the model request.

The pinned CLI emits SessionStart for compaction but omits it on initial startup
and this query restart. The first prompt's empty in-memory history supplies the
full digest in those cases. Verify the delivered context rather than requiring
an absent startup callback. This proves native query restart, not a process-level
daemon restart or a real-provider model's adherence to its context.

Keep the failing baseline evidence from the same helper with the builder wiring
absent. Its three model turns complete before the missing startup digest fails.
A callback returning the right context alone is insufficient. Inspect actual
model requests, stream-hook.json and the wrapper's successful exit status.
