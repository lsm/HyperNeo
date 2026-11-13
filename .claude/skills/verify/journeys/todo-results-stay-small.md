# Todo changes and agent ask reads stay small

Use the shared metadata-only isolated daemon setup in SKILL.md. The helper owns
an ephemeral daemon, seeds only synthetic data, disables external HTTP and needs
no model or provider:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/todo-results-stay-small.ts
```

Through the real MCP handler as a bound Neo session, it opens one ask with
eleven todos and gives each a long instruction and report. A neo.todo.hold and a
neo.todo.edit each return only the changed todo, with no `todos` list and no
other todo's instruction. neo.ask.read lists each todo as id, title and state
only. neo.todo.read returns one todo in full: its instruction and report, and no
other todo's. The human RPC neo.ask.read still returns every todo in full for
the web card.

Evidence: `sizes.json` (bytes of each reply, and of the full todo list a change
used to carry) and `agent-ask-read.json`.
