# Quiet notices stay queued; first worker turn reports reach Neo

Use the in-process RPC setup in SKILL.md with
`PROOF=.claude/skills/verify/neo-quiet-wake.ts`. Preflight port 8000 only.
The helper owns its isolated daemon, synthetic HOME/data, loopback model and
refusing GitHub stub. External registry MCP servers and the SDK sandbox are
disabled only for this synthetic transport proof; no OS enforcement is claimed.

First put only the isolated main DB connection in read-only mode. Ten concurrent
retries of each quiet notice kind must persist one history row through the DB
writer and start no model request. Restore the main connection, then submit
human input to drain the two queued notices as a separate worker batch before
the unchanged human input. This establishes two model requests/results.

The actual Codex adapter then reads a synthetic task_complete heartbeat and
exposes notify:false. The actual todo runner must nevertheless deliver this first
turn report immediately: the third model request contains its unchanged text.
A focused discussion report produces the fourth request, retaining the explicit
instruction not to act, forward, reply or treat it as approval.

An exact report repeat with a different transport turn ID/time produces no new
request, including after recreating NeoService against the same SQLite DB.
Changed text under a reused transport ID, changed worker status, and another
todo's identical report must each produce one new request, reaching seven.
The unit contracts also distinguish whitespace and empty text from the literal
fallback sentence. Preserve observed.json and the model request JSON files.

Finally pause only this daemon's job processor. Deliver two urgent notes and
retry each with a quiet kind while pending or queued. Each must retain one
mailbox job and no premature history row. Resume the owned processor; the two
reports add exactly two requests and history rows, reaching nine results.
Retain overlaps.json and readonly-quiet.json. Ordinary quiet notices remain
queued; only structured worker turn reports use the immediate report path.

Run the helper unchanged against pre-fix code for a failing reproduction: after
the two baseline requests, firstNotifyFalseReport observes two instead of three.
This proves the real daemon/SDK path with synthetic worker status and model
responses, not real worker automation, real-model reasoning or browser behavior.
Also follow neo-worker-turn-reports.md and run the adapter, todo-runner,
notification-mode, intake and structured-event contracts.

## Hoisted dependency layout

Run `bash .claude/skills/verify/neo-quiet-wake-hoisted.sh "$RUN"` with a fresh,
absolute run directory. This wrapper temporarily exposes zod at the worktree's
root node_modules and moves its nested daemon entry aside, restores both on
EXIT, and executes the same isolated-daemon proof. It owns only these worktree
dependency entries. Shared environment and isolation rules remain in SKILL.md.
Retain layout.txt, proof.log and observed.json. The prior helper fails at module
load in this layout. The helper must also pass under the normal isolated linker,
where zod is present only beside the daemon sources, by using the daemon's
registered work.status schema instead of importing a package installation path.
