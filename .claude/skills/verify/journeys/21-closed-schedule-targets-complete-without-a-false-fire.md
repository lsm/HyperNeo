21. **Closed schedule targets complete without a false fire.** Run
    `bun .claude/skills/verify/session-schedule-targets.ts <port> "$RUN"` against an
    isolated daemon. No model turn is needed. It creates one target and two
    one-minute reminders, archives that target through RPC, and points the other
    reminder at a missing session. End state: both schedules are `done` with
    `last_outcome = target_gone`, no pending job and no message delivery; the fire
    jobs complete without retries. Evidence: `evidence/session-schedule-targets.json`.
    The helper deletes its schedules after capturing evidence. The focused delivery
    suite also checks a target archived during source lookup and an interrupted
    external send: that occurrence is durably reserved before `work.send`; retry
    skips it as `skipped_delivery_unconfirmed`, retaining its due count and digest.
    This gives external adapters at-most-once submission per occurrence: a crash
    before submission may miss that occurrence, and a later cadence can try again.
    Real external-adapter delivery is not verified by this journey.
