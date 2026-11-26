# Loopback operations MCP

Use the shared isolation and pinned Bun in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/oxap-operation-transport.ts
```

The proof starts an isolated daemon and attaches an MCP client to each of two
chat grants. It compares the HTTP and Claude SDK tool catalogs, discovery
results and audited operation refusal. It checks that swapping bearers is
refused, and exercises the Origin, Host, media type and body size checks.

An MCP detach leaves its chat grant usable. Archiving and deleting the chat
each make the old bearer return 401 for an operation read. Unarchiving needs
a new grant. Daemon shutdown closes the listener. Check the wrapper exit code
and the counts in `operations-transport.json`.

This journey exercises the transport directly. The OXAP attachment and
capability-file journey belongs to the wiring slice.
