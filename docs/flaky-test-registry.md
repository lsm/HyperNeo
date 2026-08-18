# Flaky test registry policy

`flaky-tests.json` + `scripts/flaky-test-runner.ts` wrap every CI suite. A
registered failure is retried (up to `policy.maxRetries`) and, after
`quarantineAfterFailures` attempts, quarantined so the shard passes while a
fix task (`flaky-test` label) is created. Any failure that is **not**
registered blocks CI with "Non-registered test failure found".

Registration criteria per suite:

- **daemon-unit / web**: registration acceptable for diagnosed
  intermittent defects while a fix is pending. Keep entries dated
  (`addedAt`/`expiresAt`) and pointed at an issue.
- **daemon-online**: **keep zero registered entries.** Online shards run
  mocked through Dev Proxy; their flakes are almost always load/timing
  sensitivity (SDK subprocess cold-start, runner scheduling), and the
  registry's retry-then-quarantine would hide exactly that signal while
  implying a product defect. Fix the waits instead (see below). Only
  register a daemon-online test after a fix has genuinely been attempted,
  the failure mode is understood, and it still flakes — and revisit the
  entry when the cause is fixed.

## Online wait-budget guidance

The online suites' waits are condition-based (`tests/helpers/daemon-actions.ts`)
— `waitForIdle` resolves on the `state.session` event with a polling
fallback; it never sleeps for a fixed duration. Flakes come from the
*budgets*, not the mechanism:

- `waitForIdle` enforces a floor of
  `HYPERNEO_SDK_STARTUP_TIMEOUT_MS + 10s` (40s for test daemons, which pin
  the startup timeout to 30s). A session cannot go idle before its SDK
  subprocess cold-starts and the turn settles; CI cold starts take 20-30s
  while warm turns settle in 1-2s, so per-file mock budgets below the floor
  only hold on warm runners. Don't try to opt out of the floor.
- Per-test timeouts must leave room for one floored idle wait plus the
  warm turns the test performs (e.g. mock `TEST_TIMEOUT` ≥ 60s, 90s for
  multi-turn suites).
- Hook budgets (`SETUP_TIMEOUT`) must exceed daemon teardown's worst case
  (~15s: 5s `session.delete` race + 10s `waitForExit` race). A 10s hook
  budget turns every failed idle wait into a second hook-timeout failure
  and doubles the reported failure count.

When an online shard flakes: pull the shard's junit + `daemon.jsonl`
artifacts, read the actual claim→`first_sdk_response`→`settled` timeline,
and fix the budget or the wait condition that raced — don't register it.
