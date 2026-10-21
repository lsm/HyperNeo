20. **A due session reminder wakes its recipient as a daemon note.** Register the
    mock provider from Launch, then run `bun .claude/skills/verify/session-schedule-fire.ts <port> "$RUN"`.
    It creates a session and a one-minute reminder through RPC and waits up to 80 s.
    End state: the session transcript contains one `<daemon-note kind="scheduled_wake">`
    with the reminder text and system input, without a
    session-message envelope. `neo_input_origins.trigger_id` stores `scheduled_wake:`
    followed by JSON with `scheduleId`, `sourceKind`, and `sourceId`; the mailbox
    keeps that origin while SDK storage normalizes synthetic input to `system`.
    The schedule reports `fired`, a message id, zero due
    count, a facts digest and its next cadence; the helper pauses it after capturing
    `evidence/session-schedule-fire.json`. Open that session's transcript and capture
    a screenshot. Busy/needs-you/unchanged skips, nudge counting, source removal and
    pause races are covered by the focused session-schedule-fire unit suite.
