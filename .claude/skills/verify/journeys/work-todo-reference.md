# Work needs an accepted request

Run the production MCP, HyperNeo adapter and mailbox proof with isolated setup:

```sh
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory .claude/skills/verify/work-todo-records.ts
```

Eight work.send/work.queue calls with missing, unknown, closed or foreign todo
references return todo_required without sending. A valid owned todo is delivered;
the receipt and mailbox entry survive a database reopen. Retain observed.json
and proof.log. This does not prove provider execution or browser layout.

For the full daemon, use the shared in-process setup with
PROOF=.claude/skills/verify/work-todo-reference.ts. It checks refused untracked
starts and sends, an accepted tracked send, todo runner delivery and a trusted
internal send. The proposal and human decision are covered by new-work-source.md.
