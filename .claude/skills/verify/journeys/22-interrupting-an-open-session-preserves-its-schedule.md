22. **Interrupting an open session preserves its schedule.** Run
    `bun .claude/skills/verify/seed-schedule-interrupt.ts <port> "$RUN"` against an
    isolated daemon. The helper checks the test-mode log and database path before
    seeding a user-interrupted processing state on its newly created session.
    `work.status` reads `stopped`, but the due reminder must read `active` with
    `skipped_busy`, quiet-wake count 0 and a future cadence through `schedule.session.list`.
    No message is delivered. Evidence: `evidence/session-schedule-interrupt.json`.
    The helper deletes its schedule after capturing evidence. The focused delivery
    test also returns the target to idle and observes a fired reminder on its next
    cadence. Stopped adapters with unknown lifecycle skip busy; local ended/archived
    targets are recognized from their session row and still complete as target_gone.
