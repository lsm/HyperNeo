### Google grant refresh (phase 1.4)

```bash
bash .claude/skills/verify/proof-run.sh /absolute/evidence/google-refresh \
  .claude/skills/verify/google-refresh.ts
```

Repeat with `VERIFY_PROOF_RUNTIME=deno` and pinned Deno 2.9.4 on PATH.
Shared setup supplies test mode, fresh HOME/data/database and no credentials.
The helper owns ephemeral listeners and refuses every endpoint except fake
Google; no model, GUI, real account or Cloud action runs.

The regular daemon startup registers its refresh loop with a fake clock. A grant
is renewed while still valid. Concurrent clock ticks make one request. The
rotated bundle survives restart, and a later omitted refresh token/scope preserves
the last grant across another restart. `connections.list` over the real WebSocket
door shows reconnect-needed after `invalid_grant`, which stops further attempts
even across restart. A transient failure backs off and recovers after the clock
advances. Disconnect and daemon cleanup abort an in-flight HTTP refresh; a late
response cannot restore erased credentials. Restart after shutdown can renew the
preserved grant. Evidence contains status only, never tokens or client secrets.
All daemons, clock registrations, workers and HTTP listeners close in finally.

Unit contracts additionally cover expired-token refusal during backoff, malformed
or oversized responses, missing offline credentials and per-grant single-flight
access. No real Google interoperability or OS keychain account is verified here.

Protocol reference: [Google desktop OAuth refresh](https://developers.google.com/identity/protocols/oauth2/native-app#offline).
