# A held todo moves through the normal start path and survives restart

Use the shared isolation and cleanup in `../SKILL.md`:

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/neo-todo-retarget.ts
```

The helper boots a real isolated daemon, invokes `neo.todo.retarget` through its
MCP door, and observes the normal runner's admitted start. It stops a real held
HyperNeo session through `work.stop`, checks its persisted prompt is cleared,
and checks the target is unchanged. An ordinary processing session's stop must
preserve two queued delivery jobs. The real reactive database must announce the
reopened todo before the next start. A WebSocket client listens to `neo.changed`
and refreshes with `neo.snapshot`, exactly as the board does. With a prerequisite
refusing the replacement start without another write, that event must still
refresh the todo as `todo` with no worker. A second daemon boot finds a two-hour-old
move fact; two real `NeoService.sweepPacks` calls must admit exactly one recovery
start. `neo.todo.read` exposes the recovered todo. Retargeting a `send` todo must
refuse without stopping its peer or changing the peer's persisted held prompt.
The MCP `neo.todo.remove`
operation must also remove adopted work and work whose real adapter cannot stop,
preserving ordinary stop semantics. Evidence is `retarget.json`.

Only the final `work.start` backend is a recording fixture: no model or native
worker launches. This proves core move admission, not coding line selection.
The production coding `chooseLine` wiring and held-line exclusion belong to step 5.
