# Cached coding PR state gates reminders through the DB reader

Use the shared metadata-only setup and disk/cleanup wrapper in SKILL.md:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" \
  .claude/skills/verify/todo-waiting-reader.ts verify
```

`EVIDENCE` is a fresh absolute directory outside the disposable daemon run.
The helper owns an ephemeral daemon, two synthetic manual sessions and a GitHub
stub that refuses external requests. No provider, model, GUI, live data or port
8399 is involved.

The real scheduled refresh sees an idle stopped worker and a cached OPEN PR.
No worker reminder or escalation may occur. Changing the synthetic cached PR
to CLOSED must permit one failed-send escalation; another refresh stays quiet.
The real WebSocket snapshot must keep the card doing. Instrumentation counts
main SQL with the waiting-hook call frame; it must become zero. Other coding
PR reads are reported separately and remain outside this follow-up.

The helper then holds a synthetic WAL writer lock for 1.2 seconds. The waiting
predicate must resolve false in under 250 ms on the reader, and health must
stay below 250 ms while the existing admission writer waits. That affected
write still exceeds 250 ms: report the failure explicitly. This phase drives
reader/writer boundaries directly; preceding phases use the scheduled job and
snapshot. Queue, SQL and clone stages are not separately attributed.

Run `before` on the test-first pre-fix commit in the same checkout with a
different evidence directory. Behavior remains the same, but its waiting-hook
SQL still runs on main. Its admission writer already runs off main, so baseline
health is expected to remain responsive under the held writer lock too.
The wrapper saves JSON and logs before deleting each run's temporary data.

Run runner, coding-todo-PR and todo-gateway tests. Async false must permit the
20/40/60-minute ladder; a pending result must be awaited, and true must skip
later pack hooks. Cached missing, OPEN and MERGED PR cases keep their verdicts.
Deno smoke exercises the registered reader predicate against cached PR states.
