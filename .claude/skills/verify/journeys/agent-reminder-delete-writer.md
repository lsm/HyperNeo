# An agent reminder deletion awaits its writer admission

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/reminder-delete-evidence \
  .claude/skills/verify/agent-reminder-delete-writer.ts verify
```

The helper starts a fresh synthetic daemon and paused fixture agents, then creates
future reminders through real WebSocket RPC. It deletes through
spaceAgentReminder.delete and checks the common agent.reminder.list operation
and spaceAgentReminder.listCounts. Reading immediately after the delete reply no longer lists the reminder;
unrelated reminders retain their complete Unicode bodies.
Missing and required-ID errors remain unchanged. Two concurrent deletes have
exactly one success and one missing-reminder error.

An injected DELETE failure must preserve the reminder and counts. Both the
existence read and DELETE must be absent from the daemon main connection during
deletion. Run and commit the failing baseline before wiring; its behavior checks
pass and the final SQL assertion fails. Repeat under supported Deno with
VERIFY_PROOF_RUNTIME=deno. Shared setup and cleanup remain in SKILL.md and
proof-run.sh, which preserves RPC replies and captured SQL.

Run reminder RPC, repository, operation and fire-handler suites. This covers
hard deletion through the RPC only; reminder creation, cancellation, scheduling,
delivery and other long-horizon agent writes remain separate migrations. No
model turn, real reminder firing or held-writer latency is claimed.
