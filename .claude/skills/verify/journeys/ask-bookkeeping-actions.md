# Unfinished ask closure is refused without changing its todos

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

A question naming a closed todo must supply an explicit retireWhen check with an
absolute evidence path. It explicitly replaces the fixture's existing worker question to follow the one-open-card rule. It opens at ask
level with a todo_closed record, without a stale todo link. Settling done with
unfinished todos must return a todos_unfinished refusal and leave the ask,
todos and questions unchanged. Explicit reasoned todo removals then permit done. Removed failed work keeps
its recorded diagnostic, and a historical closed_unverified row retains its
label. The daemon settlement journey separately covers dropped cleanup. Retired questions have no
invented answer or answerer. Done counts exclude all those rows before and
after reopening the database. The refusal and accepted bookkeeping records
remain in the operation audit. Retain observed.json and proof.log.

The same MCP proof pins coding placement before the core/pack split. A start
without a place is refused without adding a todo. Its own local place keeps a
null repo instead of inheriting the ask's repo. A historical child card remains
readable by ask id and todo id, preserving parent, repo and work after DB reopen.
Opening one request with two repositories must retain one open ask and both
steps on it. Read that same card after database reopen. Creating repository
children or automatically settling the parent makes this proof fail.
On reviewed head 734269ad, the two guidance assertions fail: the catalog omits
stale todo behavior and the settled-ask record omits the different-title remedy.

This uses the real MCP handler, operation registry, ask/question operations,
public card reader and migrated SQLite/audit repositories. No listener,
provider, worker or network is used. It proves the data consumed by web/mobile
readers, not native iOS rendering or browser layout. The existing web todo status
component contracts must retain the Closed unverified label and exclude Done.
The mark-done-settle journey separately covers the human menu and stop errors.
