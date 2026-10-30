### Human-only Google connection management (phase 1.3)

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/google-connections \
  .claude/skills/verify/google-connections.ts
```

Repeat with `VERIFY_PROOF_RUNTIME=deno` and pinned Deno 2.9.4 on PATH for the
second supported runtime. The shared setup supplies fresh HOME/data/database,
test mode and no credentials; all network targets except the fake Google server
are refused. No model or GUI runs.

The helper calls the production management operations through the real WebSocket
door, injecting only the fake Google transport and synthetic encrypted-store key.
Actual consent redirects, loopback callbacks, token exchange and signed JWKS
verification complete two accounts. Reconnect with the wrong account must fail
without changing either healthy grant. A pending attempt closes with the daemon;
after restart both accounts remain and the old attempt is missing. Reconnect by
connection ID reuses the encrypted client details without returning them. Disconnect
disables and erases only its named bundle, preserving both metadata rows and the
other healthy grant. Agent MCP management is refused, and no token/client secret
may appear in RPC evidence. Both daemons and every HTTP listener close in finally.

Unit contracts also cover vault-write failure leaving reconnect-needed status,
failed erasure staying disabled with an explicit error, stable account IDs and
visible degraded storage without secret fields. This slice supplies operations;
the Settings UI and real-account interoperability are not verified here.
