# Common schedule deletion commits with its pending job

```sh
bash .claude/skills/verify/proof-run.sh /absolute/fresh/schedule-operation-delete-evidence \
  .claude/skills/verify/schedule-operation-delete-writer.ts verify
```

Use real operation.invoke schedule.delete requests through a fresh synthetic daemon.
Future at/cron schedules and their pending jobs must disappear together. Missing,
repeated and foreign-Space requests return schedule_not_found and preserve other
records. A trigger rejecting schedule DELETE must return rejected while retaining
both the active schedule and its pending fire job. Commit that failing reproduction
before wiring the existing writer. Capture zero schedule/job DELETE statements on
the main connection after wiring, and repeat under supported Deno. Audit callbacks
stay on main after the awaited result. Run schedule operation/service/repository
and fire suites. Shared setup and cleanup stay in SKILL.md/proof-run.sh. No real
schedule firing or model turn occurs; goal orchestration remains separate.
