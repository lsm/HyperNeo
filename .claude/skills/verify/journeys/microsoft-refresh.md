# Refresh a Microsoft connection

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/microsoft-refresh.ts
```

Shared setup in SKILL.md supplies fresh test HOME/data and scrubbed credentials.
The helper boots a real isolated daemon with a fake clock and an in-process fake
identity endpoint that answers only the account tenant's token URL; any other
URL fails the run. It never calls Microsoft.

It seeds one Microsoft connection whose access token is about to expire. Ten
concurrent token reads through the daemon's own Microsoft connection service send
one refresh. Each later refresh sends the newest rotated refresh token, with the
sign-in scopes and no client secret, and that token survives a daemon restart.
An `invalid_grant` reply turns the row Reconnect needed in `connections.list`,
and a day later and after a restart no second request is sent.

No Microsoft data operation exists yet, so token access is called in process;
health is read through real management RPC. Inspect `microsoft-refresh.json`
for every RPC reply and refresh request (refresh tokens omitted).
