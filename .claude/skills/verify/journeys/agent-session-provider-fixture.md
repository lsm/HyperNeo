# Missing-provider admission is independent of Copilot login

This is a unit-fixture-only change. The user surface is the release test runner;
production provider resolution and delivery are unchanged. Run the actual
Vitest suite with a synthetic, available cold-catalog Copilot provider:

```bash
RUN=$(mktemp -d /private/tmp/hyperneo-provider-fixture-XXXXXX)
bun .claude/skills/verify/agent-session-provider-fixture.ts "$RUN" full
```

The helper starts Vitest in a fresh HOME with a scrubbed environment. A fake gh
refuses every command. An existing provider-factory test seam supplies Copilot
availability without credentials, credential files, API requests or a daemon.
Vitest retains the repository SDK stub and network guard. No GUI, live DB,
provider key, running-owner change or port 8399 is involved.

Pass: all 250 existing agent-session cases pass. The exact missing-provider case
still requires four terminal errors and four visible notices with the original
text. The fixture explicitly makes optional Copilot unavailable and restores its
method afterward. No assertions are changed, skipped, weakened or quarantined.

`baseline` selects the same original case and expects its pre-fix
`Interrupted by user` failure with the synthetic available provider. `verify`
selects the case and requires success. Keep `evidence/tests.log` and
`evidence/provider-fixture.json`; remove the synthetic run afterward. This proves
test isolation, not a production behavior change. Confirm the complete file also
passes in the merged PR's daemon-unit CI shard.
