### Google connections: metadata and vault

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/connector-base \
  .claude/skills/verify/connections-base.ts
```

This uses the shared isolated proof setup: fresh HOME/data/database, test mode,
an ephemeral port, refusing GitHub stub and cleanup in finally. No model, Google
endpoint, real credentials or GUI is needed in this storage/status slice.

The real WebSocket `connections.list` operation starts empty, returns explicit
nonsecret account metadata after a synthetic fixture write, and preserves that
metadata after daemon restart. A synthetic encrypted bundle survives restart;
another instance identity and a fresh second database cannot read it. Agent MCP
management access is refused. `connections-base.json` contains status receipts
and check results, never the synthetic tokens. All three daemons close.

The companion unit contracts exercise a synthetic Keychain, encrypted fallback,
separate accounts/connections, failed atomic replacement and idempotent schema
creation. Actual OS Keychain, consent, refresh, account tools and UI are not
verified by this slice; they belong to their later phase-1 journeys.
