# Audit failure preserves a committed todo result

Use the shared metadata-only isolation and proof-run.sh setup from SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/todo-audit-failure.ts verify
```

This in-process MCP proof needs no listener, model, provider, worker or external
service. It uses the production MCP handler, operation registry, todo add/edit
operations, coding pack and migrated SQLite repositories. Its audit callback
deliberately rejects after each committed mutation.

The agent must receive successful add/edit replies with the original bookkeeping
records, not invocation_failed or isError. Exactly one new todo and its edit must
survive reopening the database. The wrapper preserves observed.json and proof.log
and removes synthetic data. This proves the MCP reply boundary and durable metadata;
full daemon startup, HTTP/WebSocket transport and web rendering are not covered.
