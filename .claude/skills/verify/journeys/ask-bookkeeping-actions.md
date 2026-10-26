# Unfinished ask closure is recorded without certifying its todos

Use the shared isolated metadata-only setup and cleanup from SKILL.md:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/ask-bookkeeping-actions.ts
```

A question naming a closed todo must open at ask level with a todo_closed
record, without a stale todo link. Settling an ask done with unfinished todos
must return a todos_unfinished record and close those rows as closed_unverified.
Include a real worker question report: its todo must be blocked by needs-human
before settlement, then remain closed_unverified afterward, rather than becoming
removed. Its question is retired without an answer or answerer.
The production neo.ask.read payload retains that state, doneCount is zero and
neo.ask.doneTodos returns none. Retired questions retain null answers and no
answerer. Both accepted audit records and the unverified rows survive DB reopen.
On the original baseline the first closed-todo question is refused. On the
reviewed head 4e48b4aa, settlement instead fails the unverified-state assertion:
the human-blocked row becomes removed. Retain observed.json
and proof.log; the shared wrapper removes all synthetic data after saving them.

This uses the real MCP handler, operation registry, ask/question operations,
public card reader and migrated SQLite/audit repositories. No listener,
provider, worker or network is used. It proves the data consumed by web/mobile
readers, not native iOS rendering or browser layout. The existing web todo status
component contracts must retain the Closed unverified label and exclude Done.
The mark-done-settle journey separately covers the human menu and stop errors.
