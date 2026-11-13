# Neo question cards wait for another write instead of failing as locked

Use shared isolation in `../SKILL.md`. No model, browser or provider key is
needed. From the worktree root:

```sh
.claude/skills/verify/neo-question-beside-writer.sh
```

The helper makes a fresh run directory, starts an in-process daemon app on its
own synthetic DB, and opens a synthetic Neo session and ask. A second process
stands in for the DB writer lane: it opens the same DB file and holds a write
transaction for 800 ms. While that lock is held, the helper calls
`neo.question.ask` through Neo's MCP operation door with a two-option choice.
It then holds the lock again and calls `neo.rule.ask`, which opens a rule card
the same way.

Each call must succeed after the other write commits, and each stored card must
be open. Before the fix it returned `execution_failed` with `database is locked`
at once, because the card write read first in a deferred transaction and SQLite
refuses that read-to-write upgrade without waiting. Evidence:
`evidence/neo-question-beside-writer.json` with `waitedMs`, `isError` and the
reply for each operation.
