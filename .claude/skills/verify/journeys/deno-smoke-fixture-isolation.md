# Deno smoke fixtures cannot overlap the booted daemon writer

Use the resource check and synthetic HOME/data isolation from `SKILL.md`.
With Deno 2.9.4 and installed workspace dependencies, run from the repo root:

```bash
bash .claude/skills/verify/resource-check.sh && python3 .claude/skills/verify/deno-smoke-fixture-isolation.py
```

The helper runs the real `scripts/deno-smoke.sh`, wrapping Deno to hold a SQLite
write transaction at the first fixture insert if the isolated daemon still
serves requests. Before the fix this produces `database is locked`; after the
fix expect `daemon stopped before fixture writes` followed by the smoke PASS.
All HTTP, WebSocket, SDK RPC, migration, repository commit/rollback and graceful
shutdown assertions must still pass. No provider or live daemon is involved.
The smoke keeps its intentional short-lived lock-holder check for the gateway.

For a stress run, repeat this command sequentially; never overlap smoke runs.
