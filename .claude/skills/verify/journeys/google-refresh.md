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
preserved grant. Synthetic vault-lock and vault-write failures stay healthy and
recover after backoff. A metadata-write fault after rotation remains eligible;
restart repairs scopes from the durable bundle without another token request.
Permanent OAuth denials (including a non-JSON 403) require reconnect and stop
requests; 408/429 remain retryable. Evidence contains status only, never tokens or client secrets.
All daemons, clock registrations, workers and HTTP listeners close in finally.

An empty instance must not open its Google vault or initialize an artifact
identity merely because the refresh loop starts. The Google refresh-loop unit
contract pins lazy creation and shutdown of a service created by a human action.
Repeat the native-worker identity regression with:

```bash
VERIFY_PROOF_RUNTIME=deno bash .claude/skills/verify/proof-run.sh \
  /absolute/evidence/google-empty-identity \
  .claude/skills/verify/lane-c-artifact-identity-command.ts
```

Unit contracts additionally cover expired-token refusal during backoff, malformed
or oversized responses, missing offline credentials and per-grant single-flight
access. No real Google interoperability or OS keychain account is verified here.

Protocol reference: [Google desktop OAuth refresh](https://developers.google.com/identity/protocols/oauth2/native-app#offline).
