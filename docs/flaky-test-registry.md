# Flaky test registry policy

`flaky-tests.json` + `scripts/flaky-test-runner.ts` wrap the CI suites that
run through them (daemon-online, daemon-unit, and web jobs in
`.github/workflows/main.yml`; the `cli` and `e2e` suite keys currently have
no workflow wrapping them). A registered failure is retried (up to
`policy.maxRetries`) and, after `quarantineAfterFailures` attempts,
quarantined so the shard passes — the runner writes a quarantine report and
prints the instruction to create a fix task with the `flaky-test` label; it
does not create the task itself. Any failure that is **not** registered
blocks CI with "Non-registered test failure found".

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
  `HYPERNEO_SDK_STARTUP_TIMEOUT_MS + 10s`. The online vitest config sets
  that env before any module loads, so CI mock runs use the 30s startup
  bound → 40s floor; runs without the env set mirror query-runner's 60s
  production default → 70s floor (spawned-mode children inherit the same
  bound — the propagated env's 30s or the 60s default — so the floor
  tracks their startup gate either way). A session cannot go
  idle before its SDK subprocess cold-starts and the turn settles; CI
  cold starts take 20-30s while warm turns settle in 1-2s, so per-file
  mock budgets below the floor only hold on warm runners. Don't try to
  opt out of the floor.
- Per-test timeouts must leave room for one floored idle wait plus the
  warm turns the test performs (e.g. mock `TEST_TIMEOUT` ≥ 60s, 90s for
  multi-turn suites).
- Hook budgets (`SETUP_TIMEOUT`) must clear daemon teardown. In the
  standard `kill(); waitForExit()` pattern the whole cleanup — including
  the per-session `session.delete` races (5s each, rejections swallowed) —
  runs inside `waitForExit`'s internal 10s race, so the awaited teardown
  caps at ~10s plus a small tail regardless of how many sessions are
  tracked. Tests that call `cleanup()` directly (outside `waitForExit`)
  see the additive worst case instead: 10s + 5s per tracked session. A
  10s hook budget leaves no room for even the capped path and turns every
  failed idle wait into a second hook-timeout failure — use 20s or more.

When an online shard flakes: pull the shard's junit + `daemon.jsonl`
artifacts, read the actual claim→`first_sdk_response`→`settled` timeline,
and fix the budget or the wait condition that raced — don't register it.

## Known rerun-verified CI flakes

Two flakes observed on PR #2722's CI, both passing on identical-code reruns:

- **Daemon Unit Tests (4-space-storage)** — `space-goal-service.test.ts`
  "records cadence changes in the audit diff even for paused goals" asserted
  `eventType` `'updated'` but observed `'created'` (run 32585478879,
  passed on rerun). Registered in `flaky-tests.json` as
  `daemon-goal-service-cadence-audit` — daemon-unit registration is allowed
  while the intermittent defect is diagnosed.
- **Daemon Online (lifecycle)** — the `setup-devproxy` composite action
  failed its startup wait with "Dev Proxy stub did not become ready within
  15 seconds" (run 32587099409, passed on rerun). Documented here instead of
  `flaky-tests.json` for both policy and mechanical reasons: daemon-online
  keeps zero registered entries, and the failure happens in the setup step
  before `flaky-test-runner` (and any junit results it matches against)
  exists, so no registry entry could ever match it. The stub
  (`scripts/dev-proxy-stub.ts`) is dependency-free and starts before
  `bun install`; the miss was runner startup latency, not a stub defect.
