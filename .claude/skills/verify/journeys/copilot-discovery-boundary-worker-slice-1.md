## Copilot discovery boundary (worker slice 1)

Use the shared setup and cleanup from SKILL.md and the real daemon/RPC helper
in copilot-owned-history-find.md. It covers external discovery merged with owned
workers through the actual operation.invoke door. Copilot retains its --acp
listing path during the first removal slice. OpenCode must be absent from
ACP_AGENTS, while Copilot still advertises find/start/send/queue/status/stop.
The fixture records only initialize and session/list on the discovery process.

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
