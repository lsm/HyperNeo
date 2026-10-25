# Project cleanup admission on the DB writer

Run from the repository root:

```sh
RUN=$(mktemp -d /private/tmp/neo-cleanup-writer-XXXXXX)
mkdir -p "$RUN/home"
env -i PATH="$PATH" HOME="$RUN/home" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn \
  bun .claude/skills/verify/neo-project-cleanup-writer.ts verify "$RUN"
```

The helper owns a fresh synthetic daemon on an ephemeral non-8399 port, stops
its scheduler, and invokes the real `neo.projects.reorganize` WebSocket RPC.
Two competing apply requests delete forty empty projects and merge one copy
into its home exactly once, preserving both contexts and advancing the target
revision once. Main-connection admission/deletion/merge SQL must be absent;
each successful cleanup step must be one whole writer command. The baseline
`before` mode runs against the original cleanup-apply helper and requires those
SQL statements on main.

A separate process then holds a synthetic WAL writer lock for 1.2 seconds.
Another cleanup RPC waits on the worker while `system.health` must reply in
under 250 ms and main-loop lag remains below one second. This affected-write
latency misses 250 ms; the JSON report records the failure rather than claiming
a full latency pass. No model, provider, GitHub, browser, credential or existing
daemon is used. The helper closes its socket, lock process and daemon.

Repeat on Deno 2.9.4 from `packages/daemon`, replacing the Bun invocation with
`deno run -A ../../.claude/skills/verify/neo-project-cleanup-writer.ts verify "$RUN"`
and using a fresh run directory and the same isolated environment.

Retain `evidence/project-cleanup-writer.json` from each run. The associated
contracts additionally refuse deletion after late content, roll back aliases
when a synthetic delete trigger fails, suppress failure notifications and
admit only one competing merge. Project fact planning, identity backfill and
explicit forget are separate pending slices; this journey covers cleanup-step
admission and mutation.
