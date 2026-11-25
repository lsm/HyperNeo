# Switch the Anthropic subscription while a refresh is pending

The proof uses the Settings authentication RPCs on an isolated daemon. It holds
the original account's refresh response open while logging out and submitting
the replacement account's authorization code. The token endpoint returns
synthetic responses without any outbound requests.

```sh
bash .claude/skills/verify/resource-check.sh && \
  bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/anthropic-account-switch.ts verify
```

The proof prints `PASS requests=2 replacementAccountRetained=true
persistedAccountMatches=true` when the replacement identity remains visible to
Settings and is persisted after the old response completes.
The proof also checks that logout leaves the provider signed out when an
inherited token is present and the SDK launch configuration uses the new login.

Build the web bundle and append `--web` after `verify` to open Settings →
Providers in a paired browser. Supply the browser dependency and executable
through `NODE_PATH` and `VERIFY_BROWSER` when required. The proof checks for
one visible replacement account, its HyperNeo credential source, and saves
`settings.png`.
