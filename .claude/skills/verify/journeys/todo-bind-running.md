# Bind a todo to already running work without dispatch

Read shared isolated setup in `../SKILL.md`. No model, provider, browser, real
worker, external HTTP or GitHub is required. The helper starts and stops its own
real daemon on an ephemeral loopback port, with a fresh HOME and synthetic DB.

```bash
RUN=$(mktemp -d /private/tmp/hn-todo-bind-XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/todo-bind-running.ts "$RUN"
```

The production MCP adapter opens an ask whose todo has target `{verb: "bind",
ref: {adapter: "hyperneo", id: "synthetic-running-worker"}}` and no instruction.
The returned todo must have that worker and state doing. `neo.todo.add` with a
bind target plus an instruction must be refused with "A bind target attaches
work that is already running; leave instruction out." and add no todo. A second
todo is added through `neo.todo.add` with the same bind target and is doing on
that worker.

Dispatch sentries in the isolated registry count and reject work.send/work.start;
both counters and the delivery-input table must stay empty. This observes the
actual operations and persistence, not a simulated todo implementation. After a
real daemon restart both todos stay doing and retain their worker references.
Synthetic fixtures never open a model turn, and no real database is copied.
The helper closes both daemon instances in finally and retains
`evidence/todo-bind.json` (all MCP replies, persisted todos/refs and zero sends).

Run focused `neo-todo-bind`, `neo-todos`, `neo-ask-record`, `neo-todo-runner`
and `neo.test` contracts too; the latter pins the public operation list. No GUI claim or completed-worker output claim is made; binding
records already running work without assuming delivery of a new instruction.

The helper seeds an accepted historical ask for its unrelated work fixture.
Use new-work-source.md for the real proposal and human-approval path.
