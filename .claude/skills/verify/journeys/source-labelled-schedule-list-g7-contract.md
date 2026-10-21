## Source-labelled schedule list (G7 contract)

On a fresh isolated daemon from Launch, run
`bun .claude/skills/verify/session-schedule-labels.ts <port> "$RUN"`.
It opens a synthetic Neo, creates its goal schedule and another target's reminder,
then reads the real `schedule.session.list` RPC using the shared result type.
The goal title must follow a rename; the reminder uses its note. Each target sees
only its schedules, including cadence, next run, last outcome/skip reason and
`nudgeEvery - dueCount`. Pause and resume must survive a fresh list read.
Repeated label reads must leave `facts_lines` unchanged.

Evidence: `evidence/schedule-labels.json`. This proves the shared read contract
and local-user RPC controls, not the web schedules strip (the next G7 slice),
actual wake delivery, or an iOS screen. No provider/model, GUI, real DB or GitHub
requests are used. Stop the isolated daemon and mock with `stop.sh`.
