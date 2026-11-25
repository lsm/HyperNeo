# Switch the Anthropic subscription while a refresh is pending

The proof uses the Settings authentication RPCs on an isolated daemon. It holds
the original account's refresh response open while logging out and submitting
the replacement account's authorization code. The token endpoint and the SDK
transport return synthetic responses without any outbound requests.

```sh
bash .claude/skills/verify/resource-check.sh && \
  bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/anthropic-account-switch.ts verify
```

The proof prints `PASS requests=3` with the replacement account retained and
the SDK process reused after rotation.
The proof checks the Claude Code account and subscription usage before sign-in
and the replacement account and usage after sign-in. A second turn resumes the
same SDK conversation under the replacement login. Logout leaves the provider
signed out with a Claude Code login still present.
Fresh daemon processes check that a failed refresh preserves the Settings
login after restart and that logout stays in effect with a stale legacy
credential still in storage. The signed-out restart also checks usage through
the Settings operation and confirms that SDK launches require login.

Build the web bundle and append `--web` after `verify` to open Settings →
Providers in a paired browser. Supply the browser dependency and executable
through `NODE_PATH` and `VERIFY_BROWSER` when required. The proof checks for
one visible replacement account, its HyperNeo credential source, and saves
`settings.png`.
