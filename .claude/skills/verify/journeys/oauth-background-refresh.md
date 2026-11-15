# The background Claude refresh keeps trying, then asks for sign-in

Test daemons never start the refresh scheduler (it runs only with the human
login), so this proof runs the real `OAuthRefreshScheduler`, `AnthropicProvider`,
`ProviderCredentialManager` and a fresh migrated database in one process. The
Claude token URL is answered by a local HTTP server; nothing leaves the machine.

```sh
.claude/skills/verify/oauth-background-refresh.sh "$(mktemp -d)/run"
```

The launcher starts from `env -i` with `NODE_ENV=test`, a fresh `HOME` and data
dir, and no provider key. The credentials are synthetic.

The token endpoint answers 503 `temporarily_unavailable` five times, then 400
`invalid_grant`. The helper drives `tick()` on a controlled clock and asserts:

- each transient refresh happens only once `refreshDelayMs(attempt)` has passed,
  and the scheduler keeps going past the old three-failure cap;
- `invalid_grant` sets `providers.needs_login_at`, marks the provider unhealthy,
  and no tick after it calls the endpoint again, even hours later;
- every failure logs one line with `outcome=` and `oauthError=`, and no line
  contains the synthetic access or refresh token.

It prints `PASS requests=6 logs=6 needsLoginAt=<ms>` and writes
`evidence/observed.json` with the requests, the refresh clock and the log lines.
