# Unfinished ask closure is recorded without certifying its todos

Use the shared isolated metadata-only setup and cleanup from SKILL.md:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/ask-bookkeeping-actions.ts
```

The agent-visible operations.describe response for neo.question.ask must explain
that supplied unknown, foreign and terminal todo references produce a record and
an ask-level question. Check this before and after reopening the database. A
retry adding unfiled work under a completed parent ask with child cards must
return an ask_settled record with the remedy to open a new ask with a different
title, without adding work.
Supply an explicit completion check on that retry, as required for new todos;
the settled-ask bookkeeping record must still return without adding the todo.

A question naming a closed todo must open at ask level with a todo_closed
record, without a stale todo link. Settling an ask done with unfinished todos
must return a todos_unfinished record and close those rows as closed_unverified.
Include a real worker question report: its todo must be blocked by needs-human
before settlement, then remain closed_unverified afterward, rather than becoming
removed. Its question is retired without an answer or answerer.
The production neo.ask.read payload retains that state, doneCount is zero and
neo.ask.doneTodos returns none. Retired questions retain null answers and no
answerer. All three accepted audit records and the unverified rows survive DB reopen.
Include a failed todo with a diagnostic reason before settlement. Its public
unverified row must retain that reason before and after database reopen.
On the original baseline the first closed-todo question is refused. On the
reviewed head 4e48b4aa, settlement instead fails the unverified-state assertion:
the human-blocked row becomes removed. Retain observed.json
and proof.log; the shared wrapper removes all synthetic data after saving them.
On reviewed head 734269ad, the two guidance assertions fail: the catalog omits
stale todo behavior and the settled-ask record omits the different-title remedy.

This uses the real MCP handler, operation registry, ask/question operations,
public card reader and migrated SQLite/audit repositories. No listener,
provider, worker or network is used. It proves the data consumed by web/mobile
readers, not native iOS rendering or browser layout. The existing web todo status
component contracts must retain the Closed unverified label and exclude Done.
The mark-done-settle journey separately covers the human menu and stop errors.
