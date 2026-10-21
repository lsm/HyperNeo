## Copilot discovery boundary (worker slice 1)

```bash
RUN=$(mktemp -d /private/tmp/hn-copilot-pin-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun .claude/skills/verify/copilot-discovery.ts 9381 "$RUN"
```

Use a fresh synthetic HOME/data directory and free non-8399 port. The helper
places a synthetic `copilot` executable first on PATH, launches the real isolated
daemon, and calls its WebSocket `operation.invoke` door. `work.adapters` must
advertise `find/start/status/stop`; `work.find` recovers the fixture cwd from
its synthetic `events.jsonl`, page the ACP list and return the requested project.
For an external session, send returns `unsupported`, and receipt-bound status
and stop return `not_found`: discovery does not confer worker ownership. Its
age-based status is not completion evidence. Owned lifecycle is verified below.
The mock records exactly initialize and two list requests, proving no work was
sent or stopped. `evidence/observed.json` saves operation replies and the call log.
The helper closes its socket and daemon in `finally`. No real Copilot executable,
auth/token files, provider, model, GitHub, existing transcript or GUI is used.

Focused synthetic process tests additionally verify that the existing ACP client
loads a session, filters an unrelated session's message, accepts one streamed
response, and observes a cancelled prompt without removing history. They also
reject an incompatible ACP protocol. This characterizes the current ACP client,
not SDK worker delivery/receipt normalization, model discovery, IDE attachment or
termination of arbitrary child tools:

```bash
cd packages/daemon
bunx vitest run tests/unit/1-core/drivers/copilot-discovery.test.ts
```
