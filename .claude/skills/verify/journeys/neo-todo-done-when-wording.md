# Todo done-when wording is editable

Build web and use Launch in the verify skill with a fresh synthetic run
directory and a free non-8399 port (not 8000 or 9383 while orphaned
verify processes hold them). In the same shell, stop with
`.claude/skills/verify/stop.sh "$RUN"` on an EXIT trap, then run:

```bash
node .claude/skills/verify/neo-todo-done-when-wording.mjs 9386 "$RUN"
```

The helper seeds one synthetic ask in the run's DB, adds a todo with a
done-when over the RPC door, and rewords that done-when with
neo.todo.edit; the edit succeeds instead of refusing. Evidence:
evidence/neo-todo-done-when-wording.json.

No model/provider calls, credentials, live DB, desktop GUI or port 8399
are used. The check-derived branch (pack doneWhen matching the todo's
wording) is covered by the gauge-pack suite in neo-todos.test.ts.
