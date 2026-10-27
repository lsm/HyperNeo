# Todo done-when wording is editable

Use the shared metadata-only daemon setup in SKILL.md with a fresh synthetic
run directory and a free non-8399 port. Build web if needed and start the source
CLI under the scrubbed environment, with its database inside the run. This
journey needs no model mock or port 8000. Keep the daemon and helper in the same
owning shell, with an EXIT trap that stops and waits for that exact daemon,
saves evidence, and deletes synthetic data. Run the helper against its selected
port:

```bash
node .claude/skills/verify/neo-todo-done-when-wording.mjs 9386 "$RUN"
```

The helper seeds one synthetic ask in the run's DB, adds a metadata-only todo
with a completion check over the RPC door, and rewords its done-when with
neo.todo.edit; the edit succeeds instead of refusing. Evidence:
evidence/neo-todo-done-when-wording.json.
No instruction or worker target is needed for a wording check; do not invent a
placeholder worker reference, because todo targets must resolve before add.

No model/provider calls, credentials, live DB, desktop GUI or port 8399
are used. The check-derived branch (pack doneWhen matching the todo's
wording) is covered by the gauge-pack suite in neo-todos.test.ts.
