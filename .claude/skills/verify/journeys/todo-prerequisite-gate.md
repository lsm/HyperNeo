# Continue, retry and bind wait for unfinished prerequisites

No model, provider, browser or GitHub is involved. Run from the worktree root with
a fresh absolute evidence directory:

```bash
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/todo-prerequisite-gate.ts
```

The helper starts its own daemon (NODE_ENV=test, fresh HOME, data dir and DB,
ephemeral port) and calls the operations through the MCP door as Neo. `work.send`
and `work.status` are counted stubs, so the proof shows what reaches the worker
door, not delivery to a live worker.

With a prerequisite running or reopened, `neo.todo.bind`, `neo.todo.continue` and
`neo.todo.retry` each return `not_ready`, send nothing and leave the step as it
was. Once the prerequisite is done, the same three calls succeed.
`evidence/todo-prerequisite-gate.json` holds one row per call.
