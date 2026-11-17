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

The real `work.start` backend records the replacement worker delivery in the
isolated database. No model or native worker is required. This proves core move
admission and delivery, not coding line selection.
The production coding `chooseLine` wiring and held-line exclusion belong to step 5.

The request case also uses the real coding handoff brief with a synthetic Git
checkout and a stub PR lookup. The admitted start must name the inherited folder,
branch, uncommitted file, unpushed commit and PR URL. The coding target selection
is replaced by the stored target for this proof; model-line selection is separate.
A start after the move has already reopened is an ordinary start without handoff
facts and is covered by the focused regression.
