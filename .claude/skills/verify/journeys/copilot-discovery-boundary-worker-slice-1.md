## Copilot discovery boundary

Use the guarded setup and cleanup in SKILL.md and the real daemon/RPC helper
in copilot-owned-history-find.md. External SDK metadata is merged with owned
workers through operation.invoke. OpenCode is absent. Copilot retains
find/start/send/queue/status/stop. Discovery calls session.list and closes its
own SDK process without creating, resuming or sending to a session.

Run focused process tests under an isolated HOME and TMPDIR using with-run.sh:

```bash
cd packages/daemon
node_modules/.bin/vitest run tests/unit/1-core/drivers/copilot-discovery.test.ts \
  tests/unit/1-core/drivers/copilot-discovery-groups.test.ts
```

Observe matching titles and recovered project folders, explicit listing errors,
incompatible protocol rejection, and a stalled listing ending at its deadline
with no surviving fixture process. Pure window tests retain the first complete
50-row page crossing the 90-day horizon and at most 500 recent rows. These are
synthetic SDK protocol and public daemon proofs. Real account authentication,
installed CLI persistence and GUI handover require separate verification.
