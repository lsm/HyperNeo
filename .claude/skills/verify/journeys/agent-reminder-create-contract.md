# Agent reminder creation retains its input-planning contract

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/reminder-create-evidence \
  .claude/skills/verify/agent-reminder-create-contract.ts verify
```

The helper creates future one-shot and cron reminders through a fresh synthetic
daemon's real spaceAgentReminder.create RPC, then reads the common reminder list
and counts. Complete Unicode bodies, empty-body/UTC defaults, explicit timezone,
next-run calculation and stored metadata must survive. Concurrent creations keep
distinct IDs. Required-field, trigger, cron, timezone, missing-agent and foreign-
Space errors retain HANDLER_ERROR; an injected INSERT failure leaves no reminder.

Commit the characterization before extracting main-thread validation/input
planning; repeat it unchanged afterward and under supported Deno. Compare the
captured agent-lookup and reminder INSERT/read SQL hashes. This neutral rung
leaves creation SQL on main and establishes the serializable input before the
writer build/wiring. Clock and cron planning remain on main. No agent turn or
real reminder firing occurs. Shared setup/evidence cleanup stay in SKILL.md and
proof-run.sh; run reminder handler/repository/operation/fire suites too.
