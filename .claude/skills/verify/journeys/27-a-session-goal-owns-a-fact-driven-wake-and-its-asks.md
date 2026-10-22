27. **A session goal owns a fact-driven wake and its asks.** Launch a fresh run with
    `VERIFY_MOCK=neo-script-api.ts`, register the synthetic provider from Launch,
    then run `bun .claude/skills/verify/goal-schedule.ts <port> "$RUN"`. It creates
    an hourly-capable goal with a one-minute cadence for verification. The mock
    model calls `neo.ask.open` through the real MCP door with that `goalId`.
    End state: `evidence/goal-schedule.json` contains the linked ask, a delivered
    `<daemon-note kind="scheduled_wake">` in root Neo's transcript with mandate
    and journal run identity, the full goal-cycle instructions prefixed inside that wake, the exact same digest from `goal.facts`, and an
    empty summary after delivery. Reading facts twice before delivery preserves
    the delta. Updating progress to 40 produces only `- Progress: 0` and
    `+ Progress: 40`. Pausing removes the job, resuming restores it, and completing
    the goal removes its schedule and returns null facts. Run
    `NODE_PATH=<directory containing playwright> node .claude/skills/verify/goal-schedule-view.mjs <port> "$RUN"`
    to open the root session transcript headlessly and capture
    `evidence/goal-schedule-transcript.png`. Keep the `neo:` colon unescaped in
    the session route; the router does not decode a percent-encoded session id.
    CI covers foreign-goal rejection, failed/unconfirmed delivery, unchanged
    nudges, linked question/PR changes, repository splits and migration reruns.
    Missing and closed Neo targets finish `target_gone`; open interrupted Neo
    targets remain active with `skipped_busy` and can fire when idle. Delivery
    rechecks closure after facts load, so a closing target receives no wake.
    No real model, external PR or desktop GUI is exercised. Mandate reconciliation
    and what-works compaction belong to G8.
    To check close/reopen settings without a model turn, run
    `bun .claude/skills/verify/goal-reopen.ts <port> "$RUN"`. It creates a daily
    09:00 UTC cron with nudge interval 7, closes and reopens it as both completed
    and archived, and asserts that the configured schedule returns each time.
    Evidence: `evidence/goal-reopen.json`. Restart the isolated daemon and repeat
    with the saved goal id as the third argument to prove persistence across
    process restart. Wake preferences are stored on the goal; closing still
    deletes its schedule row.
    Run `bun .claude/skills/verify/goal-target-return.ts <port> "$RUN"` against a
    fresh isolated daemon to check owner recovery. It archives its new session,
    waits for the real cadence to finish `target_gone`, restores the session
    through RPC, and pauses/reactivates its goal. The restored schedule must keep
    its configured cadence/nudge interval and deliver its next wake to that
    session's transcript. Evidence: `evidence/goal-target-return.json`.
    Run `bun .claude/skills/verify/goal-unreadable-state.ts <port> "$RUN"` in
    another fresh isolated run to check a malformed processing-state fixture.
    The helper validates its test DB, seeds unreadable state only on its new Neo,
    and waits for the real goal cadence. The schedule must record `fired`, deliver
    its wake and enqueue the next cadence without a job error. The fixture is
    restored in `finally`. Evidence: `evidence/goal-unreadable-state.json`.
    To check completion during fact collection, create a fresh `$RUN` and run
    `env -i PATH="$PATH" HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test bun .claude/skills/verify/goal-close-race.ts <free-port> "$RUN"`.
    This helper owns its daemon and needs no mock model. A test-only source wrapper
    completes its goal through real RPC between the fact snapshot and rendering.
    The renderer must return source-gone, with no exception or wake delivered.
    Evidence: `evidence/goal-close-race.json`. Its daemon stops in `finally`.
