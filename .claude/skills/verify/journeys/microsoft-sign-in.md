# Connect and disconnect a Microsoft account

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/microsoft-sign-in.ts
```

Shared setup in SKILL.md supplies fresh test HOME/data and scrubbed credentials.
The helper boots one real isolated daemon with a fake keychain and an in-process
fake Microsoft identity endpoint; any other origin is refused. It never calls
Microsoft and needs no app registration.

Through management RPC it starts `connections.microsoft.connect`, checks the
consent URL (PKCE S256, the six scopes, `prompt=select_account`, a
`localhost` callback), then follows the real `localhost` redirect to the
daemon's loopback listener. The completed row is `microsoft`, keyed by tenant
and object id. A token signed by a key restricted to another tenant fails
`login_failed`; reconnect returning another object id fails `account_mismatch`.
Google disconnect of the Microsoft id returns `unknown_connection` and keeps the
bundle; Microsoft disconnect erases it. Replies never contain tokens.

Inspect `microsoft-sign-in.json` for every RPC reply and identity request. This
proves daemon control flow against synthetic endpoints, not real Microsoft
consent or account interoperability.
