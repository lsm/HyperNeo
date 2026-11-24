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
